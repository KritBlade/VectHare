/**
 * ============================================================================
 * AGENTIC RETRIEVAL
 * ============================================================================
 * Optional pre-retrieval LLM planning step that consumes the existing pre-search
 * candidates plus recent chat context, then emits 1-4 targeted follow-up queries
 * which run in parallel against Qdrant. Results merge with the pre-search output
 * and re-flow through the existing 4-weight re-ranker untouched.
 *
 * Purely additive — never replaces the existing flow. Every failure path falls
 * back cleanly to the pre-search output. Qdrant (A3) only.
 *
 * Phase 1.5: planner-emitted *_any / importance_gte filters are validated and
 * threaded into each queryCollection call when agentic_filters_enabled is true
 * (the default). Disable via settings to run unfiltered for A/B comparison.
 *   - OpenRouter only. vLLM support is Phase 2.
 *
 * @see plans/agentic-retrieval-plan.md
 * ============================================================================
 */

import { getContext } from '../../../../extensions.js';
import { retrieveEvents } from './eventbase-retrieval.js';
import { queryCollection } from './core-vector-api.js';
import { AGENTIC_PLANNER_SYSTEM_PROMPT, buildPlannerUserMessage } from './agentic-prompt.js';

// ============================================================================
// Public API
// ============================================================================

/**
 * Agentic wrapper around retrieveEvents. When `agentic_retrieval_enabled` is
 * true AND backend is Qdrant, calls the planner LLM, fans out its queries in
 * parallel, merges results with the pre-search output, and re-runs the
 * canonical re-ranker via retrieveEvents(skipLiveQuery: true).
 *
 * When agentic is disabled or unavailable, returns the unmodified pre-search
 * result so callers can use this as a drop-in replacement for retrieveEvents.
 *
 * @param {object} params - Same shape as retrieveEvents params; this function
 *        runs the pre-search itself before the planner sees the candidates.
 * @returns {Promise<{events: object[], debug: object}>}
 */
export async function retrieveEventsWithAgent(params) {
    const { settings } = params;
    const agenticDebug = !!settings?.agentic_retrieval_debug_logging;
    const tAgentStart = (typeof performance !== 'undefined' ? performance.now() : Date.now());

    // STAGE 1 — existing pre-search runs unconditionally.
    const preSearch = await retrieveEvents(params);

    // STAGE 2 — early exit if agentic is off or backend isn't Qdrant.
    if (!settings?.agentic_retrieval_enabled) {
        return preSearch;
    }
    if (settings.vector_backend !== 'qdrant') {
        if (agenticDebug) {
            console.log('[VectFox-Agentic] mode=SKIPPED reason=requires_qdrant_backend');
        }
        return preSearch;
    }

    // STAGE 3 — gather context for planner and call LLM.
    const { liveCollectionIds, keywordQuery, searchText, additionalCandidates } = params;
    const llmCfg = _resolveAgenticLLMConfig(settings);
    if (!llmCfg.ok) {
        if (agenticDebug) {
            console.warn(`[VectFox-Agentic] mode=SKIPPED reason=${llmCfg.reason}`);
        }
        return preSearch;
    }

    if (agenticDebug) {
        const topScore = preSearch.events?.[0]?._finalScore ?? preSearch.events?.[0]?.score ?? 0;
        console.log(`[VectFox-Agentic] mode=ON  trigger=user_message_len=${(keywordQuery || '').length}`);
        console.log(`[VectFox-Agentic] Pre-search returned ${preSearch.events?.length || 0} candidates (top score=${typeof topScore === 'number' ? topScore.toFixed(3) : '—'})`);
    }

    const recentTurns = _getRecentChatForPlanner(settings);
    if (agenticDebug) {
        console.log(`[VectFox-Agentic] Past chat turns sent to planner: ${recentTurns.length}`);
        console.log('[VectFox-Agentic] Narrative context preview (one ~50-word snippet per turn):');
        recentTurns.forEach((turn, idx) => {
            const label = `[-${recentTurns.length - idx}]`;
            const snippet = _firstNWords(turn.text || '', 50);
            console.log(`  ${label} ${turn.speaker}: ${snippet}`);
        });
    }

    const candidatesToShow = Math.max(1, Math.min(20, settings.agentic_retrieval_candidates_to_show || 12));
    const candidates = (preSearch.events || []).slice(0, candidatesToShow);

    const userMessage = buildPlannerUserMessage({
        recentTurns,
        userMessage: keywordQuery || '',
        candidates,
    });

    if (agenticDebug) {
        // Prompt size only — the full prompt is intentionally NOT dumped to keep
        // the log readable. The narrative-context preview above already shows
        // what the planner sees per turn; the static system prompt lives in
        // core/agentic-prompt.js for inspection.
        const approxTokens = Math.round((AGENTIC_PLANNER_SYSTEM_PROMPT.length + userMessage.length) / 4);
        console.log(`[VectFox-Agentic] LLM prompt size: system+user approx ${approxTokens} tokens (${AGENTIC_PLANNER_SYSTEM_PROMPT.length}+${userMessage.length} chars)`);
    }

    const timeoutMs = settings.agentic_retrieval_timeout_ms || 30000;
    let plan;
    const tLlmStart = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    try {
        plan = await _callPlanner({
            systemPrompt: AGENTIC_PLANNER_SYSTEM_PROMPT,
            userMessage,
            llmCfg,
            timeoutMs,
        });
    } catch (err) {
        const tLlmMs = Math.round(((typeof performance !== 'undefined' ? performance.now() : Date.now()) - tLlmStart));
        // AbortSignal.timeout() throws either a TimeoutError or a generic
        // "user aborted a request" message depending on the runtime. Detect both
        // and surface a clearer log line so timeout vs. real error is obvious.
        const isTimeout =
            err?.name === 'TimeoutError' ||
            err?.name === 'AbortError' ||
            /aborted|timeout|timed out/i.test(err?.message || '');
        if (isTimeout) {
            console.warn(`[VectFox-Agentic] Planner LLM call TIMED OUT after ${tLlmMs}ms (configured limit: ${timeoutMs}ms). Falling back to pre-search only. Bump "Planner LLM Timeout" in the AgentMode tab if your model needs longer.`);
        } else {
            console.warn(`[VectFox-Agentic] Planner LLM call failed after ${tLlmMs}ms, using pre-search only: ${err?.message || err}`);
        }
        return preSearch;
    }
    const tLlmMs = Math.round(((typeof performance !== 'undefined' ? performance.now() : Date.now()) - tLlmStart));

    if (agenticDebug) {
        // Surface real token usage from the API response (when the provider
        // returns it — OpenRouter/OpenAI-compatible APIs do). The chars/4
        // estimate above is a rough guess; this is the truth from the provider.
        const usage = plan && plan.__usage;
        if (usage && usage.prompt_tokens != null) {
            const tokPerSec = usage.completion_tokens != null && tLlmMs > 0
                ? (usage.completion_tokens / (tLlmMs / 1000)).toFixed(1)
                : '—';
            console.log(`[VectFox-Agentic] LLM call complete: ${tLlmMs}ms — prompt=${usage.prompt_tokens} tok, completion=${usage.completion_tokens ?? '?'} tok, total=${usage.total_tokens ?? '?'} tok (${tokPerSec} tok/s output)`);
        } else {
            console.log(`[VectFox-Agentic] LLM call complete: ${tLlmMs}ms (provider did not return usage data)`);
        }
        console.log('[VectFox-Agentic] Planner output:');
        console.log(JSON.stringify(plan, null, 2));
    }

    // Validate planner output.
    const maxQueries = Math.max(1, Math.min(4, settings.agentic_retrieval_max_queries || 4));
    const validatedQueries = _validateAndTrimQueries(plan?.queries, maxQueries);
    if (validatedQueries.length === 0) {
        if (agenticDebug) {
            console.log('[VectFox-Agentic] Planner returned 0 valid queries — falling back to pre-search only');
        }
        return preSearch;
    }

    // STAGE 4 — run planner queries in parallel against all live collections.
    if (!liveCollectionIds?.length) {
        if (agenticDebug) {
            console.log('[VectFox-Agentic] No live collections to query — falling back to pre-search only');
        }
        return preSearch;
    }

    const ebSettings = {
        ...settings,
        keyword_scoring_method: settings.eventbase_keyword_scoring_method || 'bm25',
    };
    const topK = (settings.eventbase_retrieval_top_k || 8) * 2;

    const plannerFilters = _validatePlannerFilters(plan?.filters, settings);
    if (agenticDebug) {
        if (Object.keys(plannerFilters).length === 0) {
            console.log('[VectFox-Agentic] Planner filters: (none — running unfiltered)');
        } else {
            console.log(`[VectFox-Agentic] Planner filters applied: ${JSON.stringify(plannerFilters)}`);
        }
    }

    const tFanoutStart = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const fanoutPromises = [];
    for (const colId of liveCollectionIds) {
        for (const queryText of validatedQueries) {
            fanoutPromises.push(
                queryCollection(colId, queryText, topK, ebSettings, plannerFilters)
                    .then(({ hashes, metadata }) => {
                        if (!hashes?.length) return { queryText, hits: [] };
                        const hits = metadata.map((meta, i) => ({ ...meta, _hash: hashes[i] }));
                        return { queryText, hits };
                    })
                    .catch(err => {
                        console.warn(`[VectFox-Agentic] Query failed (${colId}, "${queryText}"): ${err?.message || err}`);
                        return { queryText, hits: [] };
                    })
            );
        }
    }
    const fanoutResults = await Promise.all(fanoutPromises);
    const tFanoutMs = Math.round(((typeof performance !== 'undefined' ? performance.now() : Date.now()) - tFanoutStart));

    const agenticHits = fanoutResults.flatMap(r => r.hits);

    if (agenticDebug) {
        console.log(`[VectFox-Agentic] Qdrant fanout: ${validatedQueries.length} queries × ${liveCollectionIds.length} collection(s) = ${fanoutPromises.length} parallel calls`);
        console.log(`[VectFox-Agentic] Qdrant fanout complete: ${tFanoutMs}ms`);
        console.log('[VectFox-Agentic] Per-query hits:');
        fanoutResults.forEach((r, i) => {
            const topScore = r.hits[0]?.score ?? r.hits[0]?.vectorScore ?? 0;
            console.log(`  Q${i + 1} "${r.queryText.slice(0, 60)}" → ${r.hits.length} hits (top score=${typeof topScore === 'number' ? topScore.toFixed(3) : '—'})`);
        });
        const preSearchIds = new Set((preSearch.events || []).map(e => e.event_id ?? e._hash));
        const newHits = agenticHits.filter(h => !preSearchIds.has(h.event_id ?? h._hash));
        console.log(`[VectFox-Agentic] Agentic-only hits (not already in pre-search): ${newHits.length}`);
    }

    // STAGE 5 — re-feed merged candidates through retrieveEvents for canonical rerank.
    // Pre-search events are passed as their original meta shape; retrieveEvents will
    // re-score using its 4-weight formula. We also pass through the original
    // additionalCandidates so archive events still factor in.
    const mergedAdditional = [
        ...(additionalCandidates || []),
        ...(preSearch.events || []),
        ...agenticHits,
    ];

    const final = await retrieveEvents({
        ...params,
        liveCollectionIds: [],          // already searched; skip live query in stage 5
        additionalCandidates: mergedAdditional,
        skipLiveQuery: true,
    });

    const tTotalMs = Math.round(((typeof performance !== 'undefined' ? performance.now() : Date.now()) - tAgentStart));
    if (agenticDebug) {
        console.log(`[VectFox-Agentic] Final merged candidates: ${(preSearch.events || []).length} pre-search + ${agenticHits.length} agentic = ${mergedAdditional.length} total → ${final.events?.length || 0} after rerank/dedup/trim`);
        console.log(`[VectFox-Agentic] Total wall-clock for agent overhead: ${tTotalMs}ms (LLM=${tLlmMs}ms, fanout=${tFanoutMs}ms)`);
    }

    // Annotate debug so callers can detect agentic mode in diagnostics.
    return {
        events: final.events,
        debug: {
            ...(final.debug || {}),
            agenticMode: true,
            agenticQueries: validatedQueries,
            agenticRationale: typeof plan?.rationale === 'string' ? plan.rationale : null,
            agenticLLMMs: tLlmMs,
            agenticFanoutMs: tFanoutMs,
            agenticTotalMs: tTotalMs,
            agenticHitCount: agenticHits.length,
        },
    };
}

// ============================================================================
// LLM planner call
// ============================================================================

/**
 * Resolve the effective LLM config for the planner. Reads agentic_retrieval_*
 * settings; falls back to summarize_* values when the agentic field is empty.
 *
 * Returns { ok: true, provider, model, apiKey, vllmUrl } on success, or
 * { ok: false, reason } when a required value is missing.
 */
export function _resolveAgenticLLMConfig(settings = {}) {
    const provider = (settings.agentic_retrieval_provider || settings.summarize_provider || 'openrouter').toLowerCase();
    const model = (settings.agentic_retrieval_model || settings.summarize_model || '').trim();

    if (!model) {
        return { ok: false, reason: 'missing_model' };
    }

    if (provider === 'openrouter') {
        const apiKey = (settings.agentic_retrieval_openrouter_api_key || settings.summarize_openrouter_api_key || '').trim();
        if (!apiKey) {
            return { ok: false, reason: 'missing_openrouter_api_key' };
        }
        return { ok: true, provider, model, apiKey };
    }

    if (provider === 'vllm') {
        const vllmUrl = (settings.agentic_retrieval_vllm_url || settings.summarize_vllm_url || '').trim();
        if (!vllmUrl) {
            return { ok: false, reason: 'missing_vllm_url' };
        }
        const apiKey = (settings.agentic_retrieval_vllm_api_key || settings.summarize_vllm_api_key || '').trim();
        return { ok: true, provider, model, vllmUrl, apiKey };
    }

    return { ok: false, reason: `unknown_provider_${provider}` };
}

/**
 * Call the planner LLM and return parsed JSON output.
 * Throws on network/auth failure, empty response, or unparseable JSON.
 */
async function _callPlanner({ systemPrompt, userMessage, llmCfg, timeoutMs }) {
    const body = {
        model: llmCfg.model,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage },
        ],
        max_tokens: 400,
        temperature: 0.2,
        response_format: { type: 'json_object' },
    };

    let endpoint, headers;
    if (llmCfg.provider === 'openrouter') {
        endpoint = 'https://openrouter.ai/api/v1/chat/completions';
        headers = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${llmCfg.apiKey}`,
        };
    } else if (llmCfg.provider === 'vllm') {
        endpoint = `${llmCfg.vllmUrl.replace(/\/$/, '')}/v1/chat/completions`;
        headers = { 'Content-Type': 'application/json' };
        if (llmCfg.apiKey) headers['Authorization'] = `Bearer ${llmCfg.apiKey}`;
    } else {
        throw new Error(`Unknown provider: ${llmCfg.provider}`);
    }

    const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
        const errText = await response.text().catch(() => response.statusText);
        throw new Error(`HTTP ${response.status}: ${String(errText).slice(0, 200)}`);
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) {
        throw new Error('LLM returned empty content');
    }

    // Capture real token usage from the API response (OpenAI/OpenRouter-compatible
    // schema). Lets the debug log distinguish "long prompt, fast model" from
    // "short prompt, slow model" — important when diagnosing latency.
    const usage = data?.usage ? {
        prompt_tokens: data.usage.prompt_tokens ?? null,
        completion_tokens: data.usage.completion_tokens ?? null,
        total_tokens: data.usage.total_tokens ?? null,
    } : null;

    // Some providers wrap in markdown fences despite response_format=json_object.
    const cleaned = String(content).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    let parsed;
    try {
        parsed = JSON.parse(cleaned);
    } catch (err) {
        throw new Error(`Planner output is not valid JSON: ${err.message}. Got: ${cleaned.slice(0, 200)}`);
    }

    // Attach usage as a non-enumerable property so callers can read it without
    // polluting the planner JSON contract (queries / filters / rationale).
    Object.defineProperty(parsed, '__usage', { value: usage, enumerable: false });
    return parsed;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Read recent non-system chat turns from getContext().chat. Source of "what
 * has been happening" context for the planner, independent from the embedding-
 * search's searchText parameter.
 */
function _getRecentChatForPlanner(settings) {
    const chat = getContext().chat || [];
    const depth = Math.max(1, Math.min(50, settings.agentic_retrieval_chat_depth || 3));
    return chat
        .filter(m => !m.is_system)
        .slice(-depth)
        .map(m => ({
            speaker: m.is_user ? '{{user}}' : (m.name || '{{character}}'),
            text: (m.mes || '').toString(),
        }));
}

/**
 * Take the first N whitespace-delimited words. Used for the debug-log
 * narrative-context preview (~50 words per turn).
 */
function _firstNWords(text, n) {
    if (!text) return '';
    const trimmed = String(text).replace(/\s+/g, ' ').trim();
    if (!trimmed) return '';
    const parts = trimmed.split(' ');
    if (parts.length <= n) return trimmed;
    return parts.slice(0, n).join(' ') + '...';
}

/**
 * Sanitize planner-emitted filters. Drops unknown keys, trims arrays to a
 * reasonable max, clamps importance_gte to 1-10. Returns {} on empty / invalid
 * input so callers can check `Object.keys(out).length === 0`.
 */
export function _validatePlannerFilters(raw, settings) {
    if (!raw || typeof raw !== 'object') return {};
    if (settings?.agentic_filters_enabled === false) return {};

    const MAX_VALUES_PER_FIELD = 8;
    const out = {};
    const arrayFields = ['characters_any', 'locations_any', 'factions_any',
        'items_any', 'concepts_any', 'event_type_any'];
    for (const key of arrayFields) {
        const v = raw[key];
        if (Array.isArray(v) && v.length > 0) {
            const cleaned = [...new Set(
                v.filter(x => typeof x === 'string')
                 .map(x => x.trim())
                 .filter(x => x.length > 0)
            )].slice(0, MAX_VALUES_PER_FIELD);
            if (cleaned.length > 0) out[key] = cleaned;
        }
    }
    if (typeof raw.importance_gte === 'number' && Number.isFinite(raw.importance_gte)) {
        out.importance_gte = Math.max(1, Math.min(10, Math.round(raw.importance_gte)));
    }
    return out;
}

/**
 * Validate, dedupe, and trim planner-emitted queries. Drops empties, strings
 * outside 3..300 chars, exact duplicates, and clamps array length to maxQueries.
 */
function _validateAndTrimQueries(queries, maxQueries) {
    if (!Array.isArray(queries)) return [];
    const seen = new Set();
    const out = [];
    for (const q of queries) {
        if (typeof q !== 'string') continue;
        const trimmed = q.trim();
        if (trimmed.length < 3 || trimmed.length > 300) continue;
        const key = trimmed.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(trimmed);
        if (out.length >= maxQueries) break;
    }
    return out;
}
