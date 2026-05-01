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
 * When summarization fails for any reason (network error, missing key, etc.)
 * the original text is returned unchanged so vectorization is never blocked.
 * ============================================================================
 */

import { SECRET_KEYS, secret_state } from '../../../../secrets.js';

/** Default summarization prompt template */
export const DEFAULT_SUMMARIZE_PROMPT =
`You are a story memory archivist. Compress the following roleplay excerpt into a dense 3-5 sentence summary optimized for semantic search and retrieval.

Requirements:
- Preserve ALL proper nouns exactly as written: character names, location names, item names, organization names, and titles
- Capture: who is present, where the scene takes place, what actions occurred, any significant items or abilities referenced, and the emotional/relationship dynamics
- Write in the same language as the input — do not translate
- Be factual and information-dense — no filler phrases, no meta-commentary, no interpretation
- Output only the summary with no preamble or explanation

Story excerpt:
{{text}}`;

/**
 * Summarize a chunk of text using the configured provider.
 *
 * @param {string} text - Raw message/chunk text to summarize
 * @param {object} settings - VectHare settings object
 * @returns {Promise<string>} Summary text, or original text on any failure
 */
export async function summarizeText(text, settings) {
    if (!text || typeof text !== 'string') return text;

    const provider = settings?.summarize_provider || 'off';
    console.log(`[VectHare Summarizer] summarizeText called — provider=${provider}, textLen=${text.length}`);
    if (provider === 'off') return text;

    const model = settings?.summarize_model || '';
    const promptTemplate = settings?.summarize_prompt || DEFAULT_SUMMARIZE_PROMPT;
    const prompt = promptTemplate.replace('{{text}}', text);

    try {
        if (provider === 'openrouter') {
            return await _callOpenRouter(prompt, model, settings, text.length);
        } else if (provider === 'vllm') {
            return await _callVLLM(prompt, model, settings);
        }
    } catch (err) {
        console.warn(`[VectHare Summarizer] ${provider} call failed, using original text:`, err?.message || err);
    }

    return text;
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
function _buildBody(prompt, model) {
    return {
        model: model || 'google/gemini-flash-1.5-8b',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 512,
        temperature: 0.3,
    };
}

/**
 * Extract the assistant reply text from an OpenAI-compatible response.
 * @param {object} data
 * @returns {string|null}
 */
function _extractReply(data) {
    return data?.choices?.[0]?.message?.content?.trim() || null;
}

async function _callOpenRouter(prompt, model, settings, originalLength) {
    const apiKey = secret_state[SECRET_KEYS.OPENROUTER];
    console.log(`[VectHare Summarizer] OpenRouter key present: ${!!apiKey}`);
    if (!apiKey) {
        console.warn('[VectHare Summarizer] OpenRouter API key not found in ST secrets — configure it in ST\'s API settings.');
        return null; // Will fall through to original text return in caller
    }

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(_buildBody(prompt, model)),
        signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
        const errText = await response.text().catch(() => response.statusText);
        throw new Error(`OpenRouter HTTP ${response.status}: ${errText}`);
    }

    const data = await response.json();
    const summary = _extractReply(data);
    if (!summary) throw new Error('OpenRouter returned empty summary');

    console.log(`[VectHare Summarizer] OpenRouter: ${originalLength} chars → ${summary.length} chars`);
    return summary;
}

async function _callVLLM(prompt, model, settings) {
    const baseUrl = (settings?.summarize_vllm_url || '').replace(/\/$/, '');
    if (!baseUrl) {
        console.warn('[VectHare Summarizer] vLLM summarization URL not configured.');
        return null;
    }

    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(_buildBody(prompt, model)),
        signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
        const errText = await response.text().catch(() => response.statusText);
        throw new Error(`vLLM HTTP ${response.status}: ${errText}`);
    }

    const data = await response.json();
    const summary = _extractReply(data);
    if (!summary) throw new Error('vLLM returned empty summary');

    console.log(`[VectHare Summarizer] vLLM: ${prompt.length} chars prompt → ${summary.length} chars summary`);
    return summary;
}
