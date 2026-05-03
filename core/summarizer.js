/**
 * ============================================================================
 * VECTHARE SUMMARIZER
 * ============================================================================
 * Summarizes chat message text before it is embedded and stored, producing
 * compact, information-dense summaries optimized for semantic retrieval.
 *
 * Supported providers:
 *   - openrouter : Uses the OpenRouter chat completions API
 *   - vllm       : Uses a local vLLM server (OpenAI-compatible endpoint)
 *
 * Non-fatal summarization failures fall back to original text.
 * Fatal configuration/auth failures (missing/invalid key, missing URL) throw
 * SummarizationFatalError so callers can abort vectorization with clear UX.
 * ============================================================================
 */

import { SECRET_KEYS, secret_state } from '../../../../secrets.js';

/**
 * Fatal summarization error that should abort vectorization instead of silently
 * falling back to raw text.
 */
export class SummarizationFatalError extends Error {
    /**
     * @param {string} message
     * @param {string} provider
     * @param {string} code
     */
    constructor(message, provider, code) {
        super(message);
        this.name = 'SummarizationFatalError';
        this.provider = provider;
        this.code = code;
    }
}

/**
 * @param {unknown} err
 * @returns {err is SummarizationFatalError}
 */
export function isSummarizationFatalError(err) {
    return err instanceof SummarizationFatalError;
}

/**
 * Build a fingerprint of active summarization configuration.
 * Includes effective credential source so callers can detect when user fixes settings.
 * @param {object} settings
 * @returns {string}
 */
export function getSummarizationConfigFingerprint(settings = {}) {
    const provider = settings?.summarize_provider || 'off';
    if (provider === 'off') return 'off';

    if (provider === 'openrouter') {
        const key = _getOpenRouterApiKey(settings);
        // Avoid logging key material: only include deterministic length + boundary chars.
        const keySig = key ? `${key.length}:${key.slice(0, 2)}:${key.slice(-2)}` : 'missing';
        return `openrouter|${keySig}`;
    }

    if (provider === 'vllm') {
        const url = (settings?.summarize_vllm_url || '').trim();
        const key = (settings?.summarize_vllm_api_key || '').trim();
        const keySig = key ? `${key.length}:${key.slice(0, 2)}:${key.slice(-2)}` : 'missing';
        return `vllm|${url}|${keySig}`;
    }

    return `other|${provider}`;
}

/** Default summarization prompt template */
export const DEFAULT_SUMMARIZE_PROMPT =
`You are a story memory archivist. Compress the following roleplay excerpt into a dense 2-10 sentence summary optimized for semantic search and retrieval.

Requirements:
- If a Date or Date + Time is in the main text, always include that in your summary.
- Preserve ALL proper nouns exactly as written: character names, location names, item names, organization names, and titles
- Capture: who is present, where the scene takes place, what actions occurred, any significant items or abilities referenced, and the emotional/relationship dynamics
- Write in the same language as the input — do not translate
- Be factual and information-dense — no filler phrases, no meta-commentary, no interpretation
- Output only the summary with no preamble or explanation

Story excerpt:
{{text}}`;

const GROUP_OUTPUT_CONSTRAINTS =
`INTERNAL FORMAT REQUIREMENTS (do not ignore):
- You must return valid JSON only.
- Return a JSON array with exactly {{count}} items.
- Each item must be an object: {"index": <1-based integer>, "summary": "<text>"}.
- The array order must be index ascending from 1 to {{count}}.
- Preserve language of each input item and include no extra keys or prose outside JSON.`;

/**
 * Summarize a chunk of text using the configured provider.
 *
 * @param {string} text - Raw message/chunk text to summarize
 * @param {object} settings - VectHare settings object
 * @returns {Promise<string>} Summary text, or original text on non-fatal failure
 */
export async function summarizeText(text, settings) {
    if (!text || typeof text !== 'string') return text;

    const provider = settings?.summarize_provider || 'off';
    // don't remove 
    //console.log(`[VectHare Summarizer] summarizeText called — provider=${provider}, textLen=${text.length}`);
    if (provider === 'off') return text;

    const model = (settings?.summarize_model || '').trim();
    if (!model) {
        throw new SummarizationFatalError(
            'No summarization model configured. Set a model in Summarize Before Store settings.',
            provider,
            'missing_model'
        );
    }
    const promptTemplate = settings?.summarize_prompt || DEFAULT_SUMMARIZE_PROMPT;
    const prompt = promptTemplate.replace('{{text}}', text);

    try {
        if (provider === 'openrouter') {
            return await _callOpenRouter(prompt, model, settings, text.length);
        } else if (provider === 'vllm') {
            return await _callVLLM(prompt, model, settings);
        }
    } catch (err) {
        if (isSummarizationFatalError(err)) {
            throw err;
        }
        // don't remove 
        //console.warn(`[VectHare Summarizer] ${provider} call failed, using original text:`, err?.message || err);
    }

    return text;
}

/**
 * Summarize multiple units in one request and return one summary per input item.
 * If grouped output is malformed, retries once with a correction prompt.
 * If still malformed, falls back to per-item summarizeText calls.
 *
 * @param {string[]} texts - Input units to summarize
 * @param {object} settings - VectHare settings object
 * @returns {Promise<string[]>} Summaries aligned to input order
 */
export async function summarizeTextGroup(texts, settings) {
    if (!Array.isArray(texts) || texts.length === 0) return [];

    const inputTexts = texts.map(t => typeof t === 'string' ? t : String(t ?? ''));
    const provider = settings?.summarize_provider || 'off';
    if (provider === 'off') return inputTexts;

    const model = (settings?.summarize_model || '').trim();
    if (!model) {
        throw new SummarizationFatalError(
            'No summarization model configured. Set a model in Summarize Before Store settings.',
            provider,
            'missing_model'
        );
    }
    const expectedCount = inputTexts.length;

    const prompt = _buildGroupPrompt(inputTexts, settings);
    // Scale token budget: ~400 tokens per summary item, min 512, max 8192
    const groupMaxTokens = Math.min(8192, Math.max(512, expectedCount * 400));

    try {
        const firstResponse = await _callSummaryProvider(provider, prompt, model, settings, prompt.length, groupMaxTokens);
        console.log('[VectHare Summarizer] grouped summary raw response (retry=0):', firstResponse);
        const parsedFirst = _parseGroupedResponse(firstResponse, expectedCount);
        console.log(`[VectHare Summarizer] grouped summary success: expected=${expectedCount}, parsed=${parsedFirst.length}, retry=0`);
        return parsedFirst;
    } catch (err) {
        if (isSummarizationFatalError(err)) throw err;

        const firstMessage = err?.message || String(err);
        console.warn(`[VectHare Summarizer] grouped summary parse failed, retrying once: ${firstMessage}`);

        try {
            const correctionPrompt = _buildGroupCorrectionPrompt(inputTexts, settings, firstMessage);
            const retryResponse = await _callSummaryProvider(provider, correctionPrompt, model, settings, correctionPrompt.length, groupMaxTokens);
            console.log('[VectHare Summarizer] grouped summary raw response (retry=1):', retryResponse);
            const parsedRetry = _parseGroupedResponse(retryResponse, expectedCount);
            console.log(`[VectHare Summarizer] grouped summary success: expected=${expectedCount}, parsed=${parsedRetry.length}, retry=1`);
            return parsedRetry;
        } catch (retryErr) {
            if (isSummarizationFatalError(retryErr)) throw retryErr;
            const retryMessage = retryErr?.message || String(retryErr);
            console.warn(`[VectHare Summarizer] grouped summary fallback to per-item: expected=${expectedCount}, reason=${retryMessage}`);
            return _fallbackSummarizePerItem(inputTexts, settings);
        }
    }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build a standard OpenAI-compatible chat completions request body.
 * @param {string} prompt
 * @param {string} model
 * @returns {object}
 */
function _buildBody(prompt, model, maxTokens = 512) {
    return {
        model: model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: maxTokens,
        temperature: 0.3,
    };
}

function _buildGroupPrompt(texts, settings) {
    const promptTemplate = settings?.summarize_prompt || DEFAULT_SUMMARIZE_PROMPT;
    const merged = texts.map((text, idx) => `[ITEM ${idx + 1}]\n${text}`).join('\n\n');
    const basePrompt = promptTemplate.includes('{{text}}')
        ? promptTemplate.replace('{{text}}', merged)
        : `${promptTemplate}\n\nStory excerpt:\n${merged}`;
    const constraints = GROUP_OUTPUT_CONSTRAINTS.replaceAll('{{count}}', String(texts.length));
    return `${basePrompt}\n\n${constraints}`;
}

function _buildGroupCorrectionPrompt(texts, settings, parseError) {
    const base = _buildGroupPrompt(texts, settings);
    return `${base}\n\nYour previous response failed validation: ${parseError}\nReturn corrected JSON now.`;
}

function _stripCodeFences(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed.startsWith('```')) return trimmed;
    return trimmed
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/, '')
        .trim();
}

function _parseGroupedResponse(raw, expectedCount) {
    const cleaned = _stripCodeFences(raw);
    let parsed;
    try {
        parsed = JSON.parse(cleaned);
    } catch {
        throw new Error('Response is not valid JSON');
    }

    const arrayData = Array.isArray(parsed)
        ? parsed
        : (Array.isArray(parsed?.items) ? parsed.items : null);

    if (!arrayData) {
        throw new Error('JSON must be an array (or object with items array)');
    }

    if (arrayData.length === 0) {
        throw new Error('Response contains empty array');
    }

    if (arrayData.length !== expectedCount) {
        console.warn(`[VectHare Summarizer] grouped response count mismatch: expected=${expectedCount}, got=${arrayData.length}`);
        // Allow if count is close (within 1) — handle alignment in caller; reject if very wrong
        if (arrayData.length < Math.ceil(expectedCount * 0.5)) {
            throw new Error(`Expected ${expectedCount} items, got only ${arrayData.length}`);
        }
    }

    const summaries = [];
    for (let i = 0; i < arrayData.length; i++) {
        const item = arrayData[i];
        if (!item || typeof item !== 'object') {
            throw new Error(`Item ${i + 1} is not an object`);
        }
        // Accept items with a summary field; ignore index mismatches (LLM sometimes reorders)
        const summary = typeof item.summary === 'string' ? item.summary.trim() : '';
        if (!summary) {
            throw new Error(`Item ${i + 1} has empty summary`);
        }
        summaries.push(summary);
    }

    return summaries;
}

async function _fallbackSummarizePerItem(texts, settings) {
    const out = [];
    for (const text of texts) {
        try {
            out.push(await summarizeText(text, settings));
        } catch (err) {
            if (isSummarizationFatalError(err)) throw err;
            out.push(text);
        }
    }
    return out;
}

async function _callSummaryProvider(provider, prompt, model, settings, originalLength, maxTokens = 512) {
    if (provider === 'openrouter') {
        return _callOpenRouter(prompt, model, settings, originalLength, maxTokens);
    }
    if (provider === 'vllm') {
        return _callVLLM(prompt, model, settings, maxTokens);
    }
    return prompt;
}

/**
 * Extract the assistant reply text from an OpenAI-compatible response.
 * @param {object} data
 * @returns {string|null}
 */
function _extractReply(data) {
    return data?.choices?.[0]?.message?.content?.trim() || null;
}

function _getOpenRouterApiKey(settings) {
    // Prefer key stored directly in VectHare settings (most reliable)
    if (settings?.summarize_openrouter_api_key) {
        return settings.summarize_openrouter_api_key.trim();
    }

    // Fall back to ST secrets store
    const stored = secret_state[SECRET_KEYS.OPENROUTER];

    if (typeof stored === 'string') {
        return stored.trim();
    }

    if (Array.isArray(stored) && stored.length > 0) {
        const activeSecret = stored.find(secret => secret?.active) || stored[0];
        if (typeof activeSecret?.value === 'string') {
            return activeSecret.value.trim();
        }
    }

    if (stored && typeof stored === 'object' && typeof stored.value === 'string') {
        return stored.value.trim();
    }

    return '';
}

async function _callOpenRouter(prompt, model, settings, originalLength, maxTokens = 512) {
    const apiKey = _getOpenRouterApiKey(settings);
    // don't remove 
    // console.log(`[VectHare Summarizer] OpenRouter key present: ${!!apiKey}`);
    if (!apiKey) {
        throw new SummarizationFatalError(
            'OpenRouter API key not found. Add it in Summarize Before Store settings.',
            'openrouter',
            'missing_api_key'
        );
    }

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(_buildBody(prompt, model, maxTokens)),
        signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
        const errText = await response.text().catch(() => response.statusText);
        if (response.status === 401 || response.status === 403) {
            throw new SummarizationFatalError(
                `OpenRouter authentication failed (${response.status}). Check your API key.`,
                'openrouter',
                'invalid_api_key'
            );
        }
        throw new Error(`OpenRouter HTTP ${response.status}: ${errText}`);
    }

    const data = await response.json();
    const summary = _extractReply(data);
    if (!summary) throw new Error('OpenRouter returned empty summary');
    // don't remove 
    //console.log(`[VectHare Summarizer] OpenRouter: ${originalLength} chars → ${summary.length} chars`);
    return summary;
}

async function _callVLLM(prompt, model, settings, maxTokens = 512) {
    const baseUrl = (settings?.summarize_vllm_url || '').replace(/\/$/, '');
    if (!baseUrl) {
        throw new SummarizationFatalError(
            'vLLM summarization URL not configured.',
            'vllm',
            'missing_url'
        );
    }

    const headers = { 'Content-Type': 'application/json' };
    const apiKey = settings?.summarize_vllm_api_key;
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(_buildBody(prompt, model, maxTokens)),
        signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
        const errText = await response.text().catch(() => response.statusText);
        if (response.status === 401 || response.status === 403) {
            throw new SummarizationFatalError(
                `vLLM authentication failed (${response.status}). Check your API key.`,
                'vllm',
                'invalid_api_key'
            );
        }
        throw new Error(`vLLM HTTP ${response.status}: ${errText}`);
    }

    const data = await response.json();
    const summary = _extractReply(data);
    if (!summary) throw new Error('vLLM returned empty summary');

    // don't remove 
    //console.log(`[VectHare Summarizer] vLLM: ${prompt.length} chars prompt → ${summary.length} chars summary`);
    return summary;
}
