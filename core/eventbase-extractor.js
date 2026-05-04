/**
 * ============================================================================
 * EVENTBASE EXTRACTOR
 * ============================================================================
 * Calls an LLM (OpenRouter or vLLM) to extract structured EventRecord objects
 * from a window of chat messages.
 *
 * Returns an array of validated EventRecord objects (may be empty).
 * Throws EventBaseFatalError for config/auth failures.
 * Throws EventBaseExtractionError for parse/validation failures (non-fatal per-window).
 * ============================================================================
 */

import { SECRET_KEYS, secret_state } from '../../../../secrets.js';
import {
    EVENT_TYPES,
    EventBaseExtractionError,
    EventBaseFatalError,
    validateEvent,
    buildEmbedText,
    buildExtractionPrompt,
    EVENTBASE_SCHEMA_VERSION,
} from './eventbase-schema.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_TOKENS = 2048;
const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_TIMEOUT_MS = 60000;

// ---------------------------------------------------------------------------
// Key resolution (mirrors summarizer.js pattern)
// ---------------------------------------------------------------------------

/**
 * Get the OpenRouter API key from EventBase settings or ST secrets.
 * @param {object} settings
 * @returns {string}
 */
function _getOpenRouterApiKey(settings) {
    if (settings?.eventbase_openrouter_api_key) {
        return settings.eventbase_openrouter_api_key.trim();
    }

    // Fall back to summarizer key (same account often)
    if (settings?.summarize_openrouter_api_key) {
        return settings.summarize_openrouter_api_key.trim();
    }

    // Fall back to ST secrets store
    const stored = secret_state[SECRET_KEYS.OPENROUTER];
    if (typeof stored === 'string') return stored.trim();
    if (Array.isArray(stored) && stored.length > 0) {
        const active = stored.find(s => s?.active) || stored[0];
        if (typeof active?.value === 'string') return active.value.trim();
    }
    if (stored && typeof stored === 'object' && typeof stored.value === 'string') {
        return stored.value.trim();
    }
    return '';
}

// ---------------------------------------------------------------------------
// Response body builder
// ---------------------------------------------------------------------------

/**
 * Build an OpenAI-compatible chat completions request body with JSON mode.
 * @param {string} prompt
 * @param {string} model
 * @param {number} maxTokens
 * @param {number} temperature
 * @returns {object}
 */
function _buildBody(prompt, model, maxTokens, temperature) {
    return {
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: maxTokens,
        temperature,
        response_format: { type: 'json_object' },
    };
}

// ---------------------------------------------------------------------------
// Reply extraction
// ---------------------------------------------------------------------------

/**
 * @param {object} data
 * @returns {string|null}
 */
function _extractReply(data) {
    return data?.choices?.[0]?.message?.content?.trim() || null;
}

// ---------------------------------------------------------------------------
// JSON parse + repair
// ---------------------------------------------------------------------------

/**
 * Attempt to parse a JSON array from raw LLM output.
 * Strips code fences and locates the outermost [ ... ] block.
 * @param {string} raw
 * @returns {unknown[]}
 */
function _parseJsonArray(raw, debugLog = false, windowIndex = -1) {
    let text = (raw || '').trim();

    if (debugLog) {
        console.log(`[EventBase] Parser window=${windowIndex}: raw length=${text.length}, preview:`, text.slice(0, 150));
    }

    // Strip code fences
    if (text.startsWith('```')) {
        text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    }

    if (!text) {
        throw new EventBaseExtractionError('Empty LLM response');
    }

    /** @type {unknown[][]} */
    const candidates = [];

    // 1) Direct parse first (covers valid array JSON immediately).
    try {
        const direct = JSON.parse(text);
        if (Array.isArray(direct)) candidates.push(direct);
        if (direct && typeof direct === 'object' && !Array.isArray(direct)) {
            const wrappedArr = Object.values(direct).find(v => Array.isArray(v));
            if (Array.isArray(wrappedArr)) candidates.push(wrappedArr);
        }
    } catch {
        // Continue with extraction-based parsing.
    }

    // 2) NDJSON / object-stream: one JSON object per line.
    if (text.includes('\n')) {
        const lines = text
            .split('\n')
            .map(l => l.trim())
            .filter(l => l.length > 0 && l.startsWith('{') && l.endsWith('}'));
        if (lines.length > 0) {
            try {
                const arr = lines.map(line => JSON.parse(line));
                candidates.push(arr);
            } catch {
                // Ignore and continue.
            }
        }
    }

    // 3) Try every balanced array slice and keep parseable ones.
    for (let i = 0; i < text.length; i++) {
        if (text[i] !== '[') continue;
        let depth = 0;
        let end = -1;
        for (let j = i; j < text.length; j++) {
            if (text[j] === '[') depth++;
            else if (text[j] === ']') {
                depth--;
                if (depth === 0) {
                    end = j;
                    break;
                }
            }
        }
        if (end === -1) continue;

        const slice = text.slice(i, end + 1);
        try {
            const parsed = JSON.parse(slice);
            if (Array.isArray(parsed)) candidates.push(parsed);
        } catch {
            // Keep scanning for other candidates.
        }
    }

    // 4) Extract top-level object stream from first '{' to last '}' as a fallback.
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
        const objectRegion = text.slice(firstBrace, lastBrace + 1);
        const stream = [];
        let depth = 0;
        let start = -1;
        for (let i = 0; i < objectRegion.length; i++) {
            if (objectRegion[i] === '{') {
                if (depth === 0) start = i;
                depth++;
            } else if (objectRegion[i] === '}') {
                depth--;
                if (depth === 0 && start !== -1) {
                    const part = objectRegion.slice(start, i + 1);
                    try {
                        const obj = JSON.parse(part);
                        if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
                            stream.push(obj);
                        }
                    } catch {
                        // Skip malformed object parts.
                    }
                    start = -1;
                }
            }
        }
        if (stream.length > 0) {
            candidates.push(stream);
        }
    }

    // Pick the first candidate that looks like event objects.
    if (debugLog) {
        console.log(`[EventBase] Parser window=${windowIndex}: ${candidates.length} candidate array(s) found:`,
            candidates.map((c, i) => {
                const first = c[0];
                const type = Array.isArray(first) ? 'array' : typeof first;
                const keys = (first && typeof first === 'object' && !Array.isArray(first))
                    ? Object.keys(first).slice(0, 5).join(',')
                    : JSON.stringify(first)?.slice(0, 40);
                return `[${i}] len=${c.length} firstType=${type} keys/val=${keys}`;
            })
        );
    }

    const chosen = candidates.find(arr => {
        if (!Array.isArray(arr)) return false;
        if (arr.length === 0) return true;
        const first = arr[0];
        if (!first || typeof first !== 'object' || Array.isArray(first)) return false;
        return Object.prototype.hasOwnProperty.call(first, 'event_type')
            || Object.prototype.hasOwnProperty.call(first, 'summary')
            || Object.prototype.hasOwnProperty.call(first, 'importance');
    });

    if (!chosen) {
        const sample = candidates[0];
        const sampleType = Array.isArray(sample) && sample.length > 0 ? typeof sample[0] : 'none';
        throw new EventBaseExtractionError(
            `Unable to find event-object array in LLM response. ` +
            `candidateCount=${candidates.length}, firstCandidateItemType=${sampleType}, ` +
            `rawPreview=${text.slice(0, 200)}`
        );
    }

    if (debugLog) {
        const chosenIdx = candidates.indexOf(chosen);
        console.log(`[EventBase] Parser window=${windowIndex}: chose candidate[${chosenIdx}] len=${chosen.length}`);
    }

    if (chosen.length > 0 && (typeof chosen[0] !== 'object' || Array.isArray(chosen[0]))) {
        throw new EventBaseExtractionError(
            `Parsed array contains non-object items (first type: ${typeof chosen[0]}). ` +
            `Raw: ${JSON.stringify(chosen).slice(0, 120)}`
        );
    }

    return chosen;
}

// ---------------------------------------------------------------------------
// Script detection (lightweight)
// ---------------------------------------------------------------------------

/**
 * Returns the dominant script class of a string.
 * Used as a post-parse sanity check to catch language-rule violations.
 * @param {string} text
 * @returns {'cjk'|'latin'|'mixed'|'empty'}
 */
function _detectScript(text) {
    if (!text) return 'empty';
    const cjk = (text.match(/[\u3000-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]/g) || []).length;
    const latin = (text.match(/[a-zA-Z]/g) || []).length;
    const total = cjk + latin;
    if (total === 0) return 'empty';
    const cjkRatio = cjk / total;
    if (cjkRatio > 0.6) return 'cjk';
    if (cjkRatio < 0.2) return 'latin';
    return 'mixed';
}

// ---------------------------------------------------------------------------
// HTTP callers
// ---------------------------------------------------------------------------

async function _callOpenRouter(prompt, settings, windowIndex) {
    const apiKey = _getOpenRouterApiKey(settings);
    if (!apiKey) {
        throw new EventBaseFatalError(
            'EventBase: OpenRouter API key not found. Add it in EventBase settings (or Summarize Before Store settings uses the same key).',
            'missing_api_key',
        );
    }

    const model = (settings.eventbase_model || '').trim();
    if (!model) {
        throw new EventBaseFatalError(
            'EventBase: No model configured. Set eventbase_model in EventBase settings.',
            'missing_model',
        );
    }

    const maxTokens = settings.eventbase_max_tokens || DEFAULT_MAX_TOKENS;
    const temperature = settings.eventbase_temperature ?? DEFAULT_TEMPERATURE;
    const timeoutMs = settings.eventbase_timeout_ms || DEFAULT_TIMEOUT_MS;

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(_buildBody(prompt, model, maxTokens, temperature)),
        signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
        const errText = await response.text().catch(() => response.statusText);
        if (response.status === 401 || response.status === 403) {
            throw new EventBaseFatalError(
                `EventBase: OpenRouter authentication failed (${response.status}). Check your API key.`,
                'invalid_api_key',
            );
        }
        throw new EventBaseExtractionError(
            `EventBase: OpenRouter HTTP ${response.status}: ${errText}`,
            windowIndex,
        );
    }

    const data = await response.json();
    const reply = _extractReply(data);
    if (!reply) {
        throw new EventBaseExtractionError('EventBase: OpenRouter returned empty response', windowIndex);
    }
    return reply;
}

async function _callVLLM(prompt, settings, windowIndex) {
    const baseUrl = (settings.eventbase_vllm_url || '').replace(/\/$/, '');
    if (!baseUrl) {
        throw new EventBaseFatalError(
            'EventBase: vLLM URL not configured. Set eventbase_vllm_url in EventBase settings.',
            'missing_url',
        );
    }

    const model = (settings.eventbase_model || '').trim();
    if (!model) {
        throw new EventBaseFatalError(
            'EventBase: No model configured. Set eventbase_model in EventBase settings.',
            'missing_model',
        );
    }

    const maxTokens = settings.eventbase_max_tokens || DEFAULT_MAX_TOKENS;
    const temperature = settings.eventbase_temperature ?? DEFAULT_TEMPERATURE;
    const timeoutMs = settings.eventbase_timeout_ms || DEFAULT_TIMEOUT_MS;

    const headers = { 'Content-Type': 'application/json' };
    const apiKey = settings.eventbase_vllm_api_key;
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(_buildBody(prompt, model, maxTokens, temperature)),
        signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
        const errText = await response.text().catch(() => response.statusText);
        if (response.status === 401 || response.status === 403) {
            throw new EventBaseFatalError(
                `EventBase: vLLM authentication failed (${response.status}). Check your API key.`,
                'invalid_api_key',
            );
        }
        throw new EventBaseExtractionError(
            `EventBase: vLLM HTTP ${response.status}: ${errText}`,
            windowIndex,
        );
    }

    const data = await response.json();
    const reply = _extractReply(data);
    if (!reply) {
        throw new EventBaseExtractionError('EventBase: vLLM returned empty response', windowIndex);
    }
    return reply;
}

// ---------------------------------------------------------------------------
// Main extraction function
// ---------------------------------------------------------------------------

/**
 * Extract structured event records from a window of chat messages.
 *
 * @param {object} params
 * @param {object[]} params.messages  - Array of chat message objects with .mes and .name
 * @param {number} params.windowStart - 0-based start index in the full chat
 * @param {number} params.windowEnd   - 0-based end index (inclusive)
 * @param {object} params.settings    - VectHare settings
 * @param {number} [params.windowIndex] - Window index for error reporting
 * @returns {Promise<object[]>} Array of full EventRecord objects (ingestion fields attached)
 */
export async function extractEvents({ messages, windowStart, windowEnd, settings, windowIndex = 0 }) {
    const debugLog = settings.eventbase_debug_logging;

    // Build excerpt text from messages
    const excerptLines = messages.map(m => {
        const speaker = m.name || (m.is_user ? 'User' : 'Assistant');
        const text = (m.mes || '').trim();
        return `${speaker}: ${text}`;
    });
    const excerptText = excerptLines.join('\n\n');

    if (!excerptText.trim()) {
        if (debugLog) console.log('[EventBase] Skipping empty window');
        return [];
    }

    const maxCount = settings.eventbase_max_events_per_window || 5;
    const prompt = buildExtractionPrompt(excerptText, maxCount);
    const provider = (settings.eventbase_provider || 'openrouter').toLowerCase();

    if (debugLog) {
        console.log(`[EventBase] Extracting events — window=${windowIndex}, provider=${provider}, messages=${messages.length}`);
    }

    // Detect dominant script of excerpt for post-parse sanity check
    const excerptScript = _detectScript(excerptText);

    // Call provider
    let rawReply;
    try {
        if (provider === 'vllm') {
            rawReply = await _callVLLM(prompt, settings, windowIndex);
        } else {
            rawReply = await _callOpenRouter(prompt, settings, windowIndex);
        }
    } catch (err) {
        // Fatal errors propagate; extraction errors are caught by caller
        throw err;
    }

    if (debugLog) {
        console.log(`[EventBase] Raw LLM reply (window=${windowIndex}):`, rawReply.slice(0, 500));
    }

    // Parse JSON
    let rawArray;
    try {
        rawArray = _parseJsonArray(rawReply, debugLog, windowIndex);
    } catch (parseErr) {
        // Always log full raw reply on parse failure regardless of debugLog flag
        console.warn(`[EventBase] Window ${windowIndex}: parse failed. Full raw reply:\n${rawReply}`);
        throw new EventBaseExtractionError(
            `EventBase: JSON parse failed for window ${windowIndex}: ${parseErr.message}`,
            windowIndex,
        );
    }

    // Empty array is valid (no events extracted)
    if (rawArray.length === 0) {
        if (debugLog) console.log(`[EventBase] Window ${windowIndex}: LLM returned no events (valid skip)`);
        return [];
    }

    if (debugLog) {
        console.log(`[EventBase] Parsed array (window=${windowIndex}): ${rawArray.length} items, types: [${rawArray.map(item => typeof item).join(', ')}]`);
        if (rawArray.length > 0 && typeof rawArray[0] !== 'object') {
            console.log(`[EventBase] First item (non-object): ${JSON.stringify(rawArray[0]).slice(0, 100)}`);
        }
    }

    // Enforce hard cap — sort by importance desc, then truncate
    if (rawArray.length > maxCount) {
        console.warn(`[EventBase] Window ${windowIndex}: LLM returned ${rawArray.length} events (> cap ${maxCount}), truncating by importance`);
        rawArray = rawArray
            .slice()
            .sort((a, b) => (Number(b.importance) || 0) - (Number(a.importance) || 0))
            .slice(0, maxCount);
    }

    // Validate + coerce each event
    const validatedEvents = [];
    const now = Date.now();
    for (let i = 0; i < rawArray.length; i++) {
        const { ok, errors, event } = validateEvent(rawArray[i]);
        if (!ok) {
            console.warn(`[EventBase] Window ${windowIndex}, item ${i}: validation failed — ${errors.join('; ')} — skipped`);
            continue;
        }
        if (errors.length > 0) {
            console.warn(`[EventBase] Window ${windowIndex}, item ${i}: coercion warnings — ${errors.join('; ')}`);
        }

        // Post-parse language sanity check
        const summaryScript = _detectScript(event.summary);
        if (excerptScript !== 'empty' && excerptScript !== 'mixed' && summaryScript !== 'empty' && summaryScript !== 'mixed') {
            if (excerptScript !== summaryScript) {
                console.warn(`[EventBase] Window ${windowIndex}, item ${i}: language mismatch (excerpt=${excerptScript}, summary=${summaryScript}) — dropped`);
                continue;
            }
        }

        // Attach ingestion metadata (event_id, source info, timestamps)
        const eventId = `eb_${now}_${windowIndex}_${i}_${Math.random().toString(36).slice(2, 8)}`;
        const sourceHashes = messages.map(m => {
            // Use the message's hash if stored, otherwise hash the text
            const text = (m.mes || '').trim();
            return m.hash ?? _simpleHash(`${m.name || ''}:${text}`);
        });

        validatedEvents.push({
            ...event,
            event_id: eventId,
            source_message_ids: messages.map((_, idx) => windowStart + idx),
            source_message_hashes: sourceHashes,
            source_window_start: windowStart,
            source_window_end: windowEnd,
            created_at: now,
            schema_version: EVENTBASE_SCHEMA_VERSION,
        });
    }

    if (debugLog) {
        console.log(`[EventBase] Window ${windowIndex}: extracted ${validatedEvents.length} valid events`);
    }

    return validatedEvents;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Minimal djb2-style hash for message dedup (used when m.hash is not present).
 * @param {string} str
 * @returns {number}
 */
function _simpleHash(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) {
        h = ((h << 5) + h) ^ str.charCodeAt(i);
        h >>>= 0;
    }
    return h;
}
