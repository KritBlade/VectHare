/**
 * ============================================================================
 * CORE VECTOR API CLIENT
 * ============================================================================
 * Abstraction layer for vector operations.
 * Routes to different backends: ST's Vectra API (Standard) or Qdrant.
 *
 * Functions:
 * - getVectorsRequestBody() - Builds request body for embedding providers
 * - getAdditionalArgs() - Special handling for WebLLM/KoboldCpp
 * - throwIfSourceInvalid() - Validates provider configuration
 * - getSavedHashes() - GET existing hashes from a collection
 * - insertVectorItems() - POST embeddings to backend
 * - queryCollection() - POST query to find similar vectors
 * - queryMultipleCollections() - POST query across multiple collections
 * - deleteVectorItems() - DELETE specific hashes
 * - purgeVectorIndex() - DELETE entire collection
 * - purgeAllVectorIndexes() - DELETE all collections
 * - purgeFileVectorIndex() - DELETE file-specific collection
 *
 * @author Base: Cohee#1207 | VectFox: Backend abstraction
 * ============================================================================
 */

import { getRequestHeaders } from '../../../../../script.js';
import { extension_settings, modules } from '../../../../extensions.js';
import { secret_state } from '../../../../secrets.js';
import { textgen_types, textgenerationwebui_settings } from '../../../../textgen-settings.js';
import { oai_settings } from '../../../../openai.js';
import { isWebLlmSupported } from '../../../shared.js';
import { getWebLlmProvider } from '../providers/webllm.js';
import { getBackend, getBackendForCollection, invalidateBackendHealth, recordQuery, recordInsert, recordDelete, recordError } from '../backends/backend-manager.js';
import { parseRegistryKey } from './collection-ids.js';
import {
    getProviderConfig,
    getModelField,
    getSecretKey,
    requiresApiKey,
    requiresUrl,
    getUrlProviders
} from './providers.js';
import { getOverfetchAmount } from './keyword-boost.js';
import { applyBM25Scoring, porterStemmer } from './bm25-scorer.js';
import { hybridSearch } from './hybrid-search.js';
import { extractQueryKeywords, RETRIEVAL_KEYWORD_LEVELS, isCJKToken } from './query-keyword-extractor.js';
import AsyncUtils from '../utils/async-utils.js';
import StringUtils from '../utils/string-utils.js';
import {
    RATE_LIMIT_CALLS,
    RATE_LIMIT_WINDOW_MS,
    API_TIMEOUT_MS,
    RETRY_MAX_ATTEMPTS,
    RETRY_INITIAL_DELAY_MS,
    RETRY_MAX_DELAY_MS,
    RETRY_BACKOFF_MULTIPLIER
} from './constants.js';

// Get shared WebLLM provider singleton (lazy-initialized)
const webllmProvider = getWebLlmProvider();

/**
 * VEC-33: Wrapper for backend operations that invalidates health cache on error
 * @param {Function} operation - Async function that performs the backend operation
 * @param {object} settings - Settings object (used to determine backend name)
 * @returns {Promise<any>} Result of the operation
 * @throws {Error} Re-throws the original error after invalidating cache
 */
async function withHealthInvalidation(operation, settings) {
    try {
        return await operation();
    } catch (error) {
        // Invalidate health cache for the backend that failed
        const backendName = settings?.vector_backend || 'standard';
        invalidateBackendHealth(backendName, error);
        throw error;
    }
}

/**
 * Rate limiter that respects user settings dynamically.
 */
class DynamicRateLimiter {
    constructor() {
        this.timestamps = [];
    }

    /**
     * Executes a function if rate limits allow, or waits until they do.
     * @param {Function} fn Function to execute
     * @param {object} settings Settings containing rate_limit_calls and rate_limit_interval
     * @returns {Promise<any>} Result of the function
     */
    async execute(fn, settings) {
        const maxCalls = settings.rate_limit_calls || 0; // 0 = disabled
        const intervalMs = (settings.rate_limit_interval || 60) * 1000;

        if (maxCalls <= 0) {
            return await fn();
        }

        // Clean up old timestamps
        const now = Date.now();
        this.timestamps = this.timestamps.filter(t => now - t < intervalMs);

        if (this.timestamps.length >= maxCalls) {
            // Calculate wait time
            const oldest = this.timestamps[0];
            const waitTime = (oldest + intervalMs) - now;

            if (waitTime > 0) {
                console.log(`VectFox: Rate limit reached. Waiting ${Math.round(waitTime / 1000)}s...`);
                await AsyncUtils.sleep(waitTime + 100); // Add small buffer
            }

            // Recursive call to re-check
            return this.execute(fn, settings);
        }

        // Add timestamp and execute
        this.timestamps.push(Date.now());
        return await fn();
    }
}

// Global rate limiter instance
const dynamicRateLimiter = new DynamicRateLimiter();

/**
 * Helper to batch array into chunks
 * @template T
 * @param {T[]} array
 * @param {number} size
 * @returns {T[][]}
 */
function chunkArray(array, size) {
    const chunks = [];
    for (let i = 0; i < array.length; i += size) {
        chunks.push(array.slice(i, i + size));
    }
    return chunks;
}

// Retry configuration for transient failures (matches AsyncUtils.retry signature)
const RETRY_CONFIG = {
    maxAttempts: RETRY_MAX_ATTEMPTS,
    delay: RETRY_INITIAL_DELAY_MS,
    maxDelay: RETRY_MAX_DELAY_MS,
    backoffFactor: RETRY_BACKOFF_MULTIPLIER,
    shouldRetry: (error) => {
        // Retry on network errors and rate limits
        const message = error?.message?.toLowerCase() || '';
        const isRetryable =
            message.includes('network') ||
            message.includes('timeout') ||
            message.includes('failed to fetch') ||
            message.includes('fetch') ||
            message.includes('suspended') ||
            message.includes('429') ||
            message.includes('rate limit') ||
            message.includes('too many requests') ||
            message.includes('502') ||
            message.includes('503') ||
            message.includes('504');
        return isRetryable;
    }
};

/**
 * Strips HTML and Markdown formatting from text before embedding.
 * Uses StringUtils from ST-Helpers for consistent text cleaning.
 * @param {string} text - Text to clean
 * @returns {string} Cleaned text
 */
function stripFormatting(text) {
    if (!text || typeof text !== 'string') {
        return text;
    }
    // Strip HTML first, then Markdown
    let cleaned = StringUtils.stripHtml(text, true);
    cleaned = StringUtils.stripMarkdown(cleaned);
    return cleaned.trim();
}

/**
 * Gets common body parameters for vector requests.
 * @param {object} args Additional arguments
 * @param {object} settings VectFox settings object
 * @returns {object} Request body
 */
export function getVectorsRequestBody(args = {}, settings) {
    const body = Object.assign({}, args);
    switch (settings.source) {
        case 'extras':
            body.extrasUrl = extension_settings.apiUrl;
            body.extrasKey = extension_settings.apiKey;
            break;
        case 'electronhub':
            body.model = settings.electronhub_model;
            break;
        case 'openrouter':
            body.model = settings.openrouter_model;
            break;
        case 'togetherai':
            body.model = settings.togetherai_model;
            break;
        case 'openai':
            body.model = settings.openai_model;
            break;
        case 'cohere':
            body.model = settings.cohere_model;
            break;
        case 'ollama':
            body.model = settings.ollama_model;
            body.apiUrl = settings.use_alt_endpoint ? settings.alt_endpoint_url : textgenerationwebui_settings.server_urls[textgen_types.OLLAMA];
            body.keep = !!settings.ollama_keep;
            break;
        case 'llamacpp':
            body.apiUrl = settings.use_alt_endpoint ? settings.alt_endpoint_url : textgenerationwebui_settings.server_urls[textgen_types.LLAMACPP];
            console.log(`VectFox DEBUG llamacpp (core-vector-api): use_alt_endpoint=${settings.use_alt_endpoint}, alt_endpoint_url="${settings.alt_endpoint_url}", ST_url="${textgenerationwebui_settings.server_urls[textgen_types.LLAMACPP]}", final apiUrl="${body.apiUrl}"`);
            break;
        case 'vllm':
            body.apiUrl = (settings.use_alt_endpoint ? settings.alt_endpoint_url : textgenerationwebui_settings.server_urls[textgen_types.VLLM])
                ?.replace(/\/$/, '')
                .replace(/\/v1\/embeddings$/, '')
                .replace(/\/embeddings$/, '');
            body.model = settings.vllm_model;
            if (settings.vllm_api_key) body.apiKey = settings.vllm_api_key;
            break;
        case 'bananabread':
            body.apiUrl = settings.use_alt_endpoint ? settings.alt_endpoint_url : 'http://localhost:8008';
            // Use extension settings for API key (custom keys aren't returned by ST's readSecretState)
            if (settings.bananabread_api_key) {
                body.apiKey = settings.bananabread_api_key;
            }
            break;
        case 'webllm':
            body.model = settings.webllm_model;
            break;
        case 'palm':
            body.model = settings.google_model;
            body.api = 'makersuite';
            break;
        case 'vertexai':
            body.model = settings.google_model;
            body.api = 'vertexai';
            body.vertexai_auth_mode = oai_settings.vertexai_auth_mode;
            body.vertexai_region = oai_settings.vertexai_region;
            body.vertexai_express_project_id = oai_settings.vertexai_express_project_id;
            break;
        default:
            break;
    }
    return body;
}

/**
 * Gets additional arguments for embeddings.
 * For client-side providers (webllm, koboldcpp, bananabread), this generates embeddings.
 * @param {string[]} items Items to embed
 * @param {object} settings VectFox settings object
 * @param {Function} onProgress - Optional callback (embedded, total) => void for progress updates
 * @returns {Promise<object>} Additional arguments
 */
export async function getAdditionalArgs(items, settings, onProgress = null) {
    const args = {};
    switch (settings.source) {
        case 'webllm':
            args.embeddings = await createWebLlmEmbeddings(items, settings);
            break;
        case 'koboldcpp': {
            const { embeddings, model } = await createKoboldCppEmbeddings(items, settings, onProgress);
            args.embeddings = embeddings;
            args.model = model;
            break;
        }
        case 'bananabread': {
            const { embeddings, model } = await createBananaBreadEmbeddings(items, settings);
            args.embeddings = embeddings;
            args.model = model;
            break;
        }
    }
    return args;
}

/**
 * Creates WebLLM embeddings for a list of items.
 * Wrapped with retry and timeout for robustness.
 * @param {string[]} items Items to embed
 * @param {object} settings VectFox settings object
 * @returns {Promise<Record<string, number[]>>} Calculated embeddings
 */
async function createWebLlmEmbeddings(items, settings) {
    if (items.length === 0) {
        return /** @type {Record<string, number[]>} */ ({});
    }

    if (!isWebLlmSupported()) {
        throw new Error('VectFox: WebLLM is not supported', { cause: 'webllm_not_supported' });
    }

    // Clean text before embedding
    const cleanedItems = items.map(item => stripFormatting(item) || item);

    return await AsyncUtils.retry(async () => {
        const embedPromise = webllmProvider.embedTexts(cleanedItems, settings.webllm_model);
        const embeddings = await AsyncUtils.timeout(embedPromise, API_TIMEOUT_MS * 2, 'WebLLM embedding request timed out');

        const result = /** @type {Record<string, number[]>} */ ({});
        for (let i = 0; i < items.length; i++) {
            // Map back to original items for hash consistency
            result[items[i]] = embeddings[i];
        }
        return result;
    }, {
        ...RETRY_CONFIG,
        onRetry: (attempt, error) => {
            console.warn(`VectFox: WebLLM embedding retry ${attempt} - ${error.message}`);
        }
    });
}

/**
 * Creates KoboldCpp embeddings for a list of items.
 * Wrapped with retry and rate limiting for robustness.
 * @param {string[]} items Items to embed
 * @param {object} settings VectFox settings object
 * @param {Function} onProgress - Optional callback (embedded, total) => void for progress updates
 * @returns {Promise<{embeddings: Record<string, number[]>, model: string}>} Calculated embeddings
 */
async function createKoboldCppEmbeddings(items, settings, onProgress = null) {
    // Clean text before embedding (strip HTML/Markdown)
    const cleanedItems = items.map(item => stripFormatting(item) || item);

    // Batch size for progress tracking
    const BATCH_SIZE = 10;
    const allEmbeddings = /** @type {Record<string, number[]>} */ ({});
    let modelName = 'koboldcpp';

    // Process in batches to show progress
    for (let i = 0; i < cleanedItems.length; i += BATCH_SIZE) {
        const batchItems = cleanedItems.slice(i, Math.min(i + BATCH_SIZE, cleanedItems.length));
        const originalBatchItems = items.slice(i, Math.min(i + BATCH_SIZE, items.length));

        const result = await dynamicRateLimiter.execute(async () => {
            return await AsyncUtils.retry(async () => {
                const serverUrl = settings.use_alt_endpoint ? settings.alt_endpoint_url : textgenerationwebui_settings.server_urls[textgen_types.KOBOLDCPP];
                if (!serverUrl) {
                    throw new Error('KoboldCpp URL not found');
                }

                const cleanUrl = serverUrl.replace(/\/$/, '');
                const response = await fetch(`${cleanUrl}/v1/embeddings`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        input: batchItems,
                        model: settings.koboldcpp_model || 'koboldcpp',
                    }),
                });

                if (!response.ok) {
                    // Try legacy endpoint if v1 fails (fallback)
                    if (response.status === 404) {
                        console.warn('VectFox: KoboldCpp /v1/embeddings not found, trying legacy endpoint...');
                        // Fallthrough to retry or handle legacy?
                        // Better to throw specific error so we can potentially retry with legacy logic if we wanted,
                        // but for now let's stick to the directive of using OpenAI compatible endpoint.
                    }
                    throw new Error(`Failed to get KoboldCpp embeddings: ${response.status} ${response.statusText}`);
                }

                const data = await response.json();

                // OpenAI format: { data: [{ embedding: [], index: 0, ... }, ...], model: "..." }
                if (!data.data || !Array.isArray(data.data) || data.data.length !== batchItems.length) {
                     throw new Error('Invalid response from KoboldCpp embeddings (OpenAI format)');
                }

                // Sort by index to ensure order matches items
                data.data.sort((a, b) => a.index - b.index);

                const batchEmbeddings = {};
                for (let j = 0; j < data.data.length; j++) {
                    const embedding = data.data[j].embedding;
                    if (!Array.isArray(embedding) || embedding.length === 0) {
                        throw new Error('KoboldCpp returned an empty embedding.');
                    }
                    // Map back to original items (not cleaned) for hash consistency
                    batchEmbeddings[originalBatchItems[j]] = embedding;
                }

                return {
                    embeddings: batchEmbeddings,
                    model: data.model || 'koboldcpp',
                };
            }, {
                ...RETRY_CONFIG,
                onRetry: (attempt, error) => {
                    console.warn(`VectFox: KoboldCpp embedding retry ${attempt} - ${error.message}`);
                }
            });
        }, settings);

        // Merge batch embeddings into all embeddings
        Object.assign(allEmbeddings, result.embeddings);
        modelName = result.model;

        // Call progress callback after each batch
        const embeddedSoFar = Math.min(i + BATCH_SIZE, items.length);
        if (onProgress) {
            console.log(`[KoboldCpp] Calling progress callback: ${embeddedSoFar}/${items.length}`);
            onProgress(embeddedSoFar, items.length);
        }
    }

    return {
        embeddings: allEmbeddings,
        model: modelName,
    };
}

/**
 * Creates BananaBread embeddings for a list of items.
 * Wrapped with retry, timeout, and rate limiting for robustness.
 * @param {string[]} items Items to embed
 * @param {object} settings VectFox settings object
 * @returns {Promise<{embeddings: number[][], model: string}>} Calculated embeddings as array (index-aligned with input items)
 */
async function createBananaBreadEmbeddings(items, settings) {
    // Clean text before embedding (strip HTML/Markdown & Handle mixed types: strings vs objects)
    // Note: Must preserve 1:1 mapping with input items, so we replace empty strings with space instead of filtering
    const cleanedItems = items.map(item => {
        let text = '';
        // 1. Handle primitive strings
        if (typeof item === 'string') {
            text = stripFormatting(item) || item;
        }
        // 2. Handle objects: Extract known text fields (e.g., item.text, item.content)
        else if (item && typeof item === 'object') {
            const textValue = item.text || item.content || '';
            text = stripFormatting(textValue) || textValue;
        }

        // 3. Fallback for unexpected types or empty result
        return text.length > 0 ? text : ' ';
    });

    return await dynamicRateLimiter.execute(async () => {
        return await AsyncUtils.retry(async () => {
            const serverUrl = settings.use_alt_endpoint ? settings.alt_endpoint_url : 'http://localhost:8008';
            const cleanUrl = serverUrl.replace(/\/$/, '');

            const headers = {
                'Content-Type': 'application/json',
            };

            // Use extension settings for API key (custom keys aren't returned by ST's readSecretState)
            if (settings.bananabread_api_key) {
                headers['Authorization'] = `Bearer ${settings.bananabread_api_key}`;
            }

            const fetchPromise = fetch(`${cleanUrl}/v1/embeddings`, {
                method: 'POST',
                headers: headers,
                body: JSON.stringify({
                    input: cleanedItems,
                    model: settings.bananabread_model || 'bananabread',
                }),
            });

            const response = await AsyncUtils.timeout(fetchPromise, API_TIMEOUT_MS * 20, 'BananaBread embedding request timed out');

            if (!response.ok) {
                throw new Error(`Failed to get BananaBread embeddings: ${response.status} ${response.statusText}`);
            }

            const data = await response.json();

            // OpenAI format: { data: [{ embedding: [], index: 0, ... }, ...], model: "..." }
            if (!data.data || !Array.isArray(data.data) || data.data.length !== cleanedItems.length) {
                throw new Error(`Invalid response from BananaBread embeddings (OpenAI format): expected ${cleanedItems.length} embeddings, got ${data.data?.length || 0}`);
            }

            // Sort by index to ensure order matches input items
            data.data.sort((a, b) => a.index - b.index);

            // Build map of embeddings keyed by original item text
            const embeddings = /** @type {Record<string, number[]>} */ ({});
            for (let i = 0; i < data.data.length; i++) {
                const embedding = data.data[i].embedding;
                if (!Array.isArray(embedding) || embedding.length === 0) {
                    throw new Error(`BananaBread returned an empty or invalid embedding at index ${i}.`);
                }
                // Map back to original items for hash consistency/lookup
                embeddings[items[i]] = embedding;
            }

            return {
                embeddings: embeddings,
                model: data.model || 'bananabread',
            };
        }, {
            ...RETRY_CONFIG,
            onRetry: (attempt, error) => {
                console.warn(`VectFox: BananaBread embedding retry ${attempt} - ${error.message}`);
            }
        });
    }, settings);
}

/**
 * Throws an error if the source is invalid (missing API key or URL, or missing module)
 * @param {object} settings VectFox settings object
 */
export function throwIfSourceInvalid(settings) {
    const source = settings.source;
    const config = getProviderConfig(source);

    if (!config) {
        throw new Error(`VectFox: Unknown provider ${source}`, { cause: 'unknown_provider' });
    }

    // Check API key requirement
    if (requiresApiKey(source)) {
        const secretKey = getSecretKey(source);
        if (secretKey && !secret_state[secretKey]) {
            // Special case: VertexAI can use service account as fallback
            if (source === 'vertexai' && secret_state['VERTEXAI_SERVICE_ACCOUNT']) {
                // Service account auth is available, continue
            } else {
                throw new Error('VectFox: API key missing', { cause: 'api_key_missing' });
            }
        }
    }

    // Check URL requirement
    if (requiresUrl(source)) {
        if (settings.use_alt_endpoint) {
            if (!settings.alt_endpoint_url) {
                throw new Error('VectFox: API URL missing', { cause: 'api_url_missing' });
            }
        } else {
            // Check textgen settings for local providers
            const textgenMapping = {
                'ollama': textgen_types.OLLAMA,
                'vllm': textgen_types.VLLM,
                'koboldcpp': textgen_types.KOBOLDCPP,
                'llamacpp': textgen_types.LLAMACPP
            };

            if (textgenMapping[source] && !textgenerationwebui_settings.server_urls[textgenMapping[source]]) {
                throw new Error('VectFox: API URL missing', { cause: 'api_url_missing' });
            }
        }
    }

    // Check model requirement
    if (config.requiresModel) {
        const modelField = getModelField(source);
        if (modelField && !settings[modelField]) {
            throw new Error('VectFox: API model missing', { cause: 'api_model_missing' });
        }
    }

    // Special case: extras requires embeddings module
    if (source === 'extras' && !modules.includes('embeddings')) {
        throw new Error('VectFox: Embeddings module missing', { cause: 'extras_module_missing' });
    }

    // Special case: WebLLM requires browser support
    if (source === 'webllm' && !isWebLlmSupported()) {
        throw new Error('VectFox: WebLLM is not supported', { cause: 'webllm_not_supported' });
    }
}

/**
 * Gets the saved hashes for a collection
 * @param {string} collectionId Collection ID
 * @param {object} settings VectFox settings object
 * @param {boolean} includeMetadata If true, returns {hashes: [], metadata: []} instead of just hashes
 * @returns {Promise<number[]|{hashes: number[], metadata: object[]}>} Saved hashes or full data
 */
export async function getSavedHashes(collectionId, settings, includeMetadata = false) {
    const backend = await getBackend(settings);
    const hashes = await backend.getSavedHashes(collectionId, settings);

    if (!includeMetadata) {
        return hashes;
    }

    // Use unified chunks API to get full metadata (works with all backends)
    try {
        const backendName = settings.vector_backend || 'standard';
        const response = await fetch('/api/plugins/similharity/chunks/list', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                backend: backendName === 'standard' ? 'vectra' : backendName,
                collectionId: collectionId,
                source: settings.source || 'transformers',
                model: settings.model || '',
                limit: 10000
            })
        });

        if (response.ok) {
            const data = await response.json();
            if (data.success && data.items) {
                return {
                    hashes: hashes,
                    metadata: data.items.map(item => item.metadata || item)
                };
            }
        }
    } catch (error) {
        console.warn('VectFox: Failed to get full metadata from chunks API, returning hashes only', error);
    }

    // Fallback: return hashes as array (old format)
    return hashes;
}

/**
 * Inserts vector items into a collection
 * Handles batching and rate limiting.
 * For client-side embedding sources (webllm, koboldcpp, bananabread), generates embeddings first.
 * @param {string} collectionId - The collection to insert into
 * @param {{ hash: number, text: string }[]} items - The items to insert
 * @param {object} settings VectFox settings object
 * @param {Function} onProgress - Optional callback (embedded, total) => void for progress updates
 * @returns {Promise<void>}
 */
export async function insertVectorItems(collectionId, items, settings, onProgress = null, abortSignal = null) {
    const backend = await getBackend(settings);

    // Sources that require client-side embedding generation
    const clientSideEmbeddingSources = ['webllm', 'koboldcpp', 'bananabread'];

    try {
        // If source requires client-side embeddings, use streaming approach
        if (clientSideEmbeddingSources.includes(settings.source)) {
            console.log(`VectFox: Streaming embeddings and writing for ${settings.source}...`);

            // Extract text strings - getAdditionalArgs expects string[], not objects
            const textStrings = items.map(item => {
                const text = item.text || item;
                // Ensure we have valid text (not empty after cleaning)
                return typeof text === 'string' && text.trim().length > 0 ? text : ' ';
            });

            // Use streaming embedding generation with immediate writes
            await streamEmbeddingsAndWrite(backend, collectionId, items, textStrings, settings, onProgress, abortSignal);
        } else {
            // Server-side embeddings - backend handles everything
            // VEC-6: Use configurable batch size for optimized bulk inserts
            // Some providers need smaller batches - Ollama and Transformers work best with batch size of 1
            // Qdrant with local GPU sources (transformers/ollama/llamacpp) also defaults to 1:
            // the Similharity server embeds all items in a single HTTP request sequentially,
            // so 5 items = 5×T on the GPU inside one request, which 504s for large models.
            // Sending 1 item per call keeps each request under the gateway timeout.
            // API-based sources (openai, openrouter, etc.) can batch safely — the server
            // runs those in parallel so total time stays ~T regardless of item count.
            const localGpuSources = new Set(['transformers', 'ollama', 'llamacpp', 'koboldcpp']);
            const configuredBatchSize = settings.insert_batch_size || 50;
            const hasExplicitBatchSize = !!settings.insert_batch_size;
            // Force 1-item batches for local GPU sources unless user overrides explicitly.
            // The Similharity server embeds items sequentially in one HTTP request, so
            // N items = N×T on the GPU — large batches 504 with high-dim models.
            const BATCH_SIZE = (!hasExplicitBatchSize && localGpuSources.has(settings.source)) ? 1 : configuredBatchSize;
            const batches = chunkArray(items, BATCH_SIZE);

            const hasRateLimit = settings.rate_limit_calls > 0;
            console.log(`VectFox: Processing ${items.length} items in ${batches.length} batch(es) of up to ${BATCH_SIZE}${hasRateLimit ? ` with rate limit (Max ${settings.rate_limit_calls} calls / ${settings.rate_limit_interval}s)` : ''}`);

            if (abortSignal?.aborted) throw Object.assign(new Error('Vectorization stopped by user'), { name: 'AbortError' });

            for (let i = 0; i < batches.length; i++) {
                const processBatch = async () => {
                    await AsyncUtils.retry(async () => {
                        if (abortSignal?.aborted) throw Object.assign(new Error('Vectorization stopped by user'), { name: 'AbortError' });
                        await backend.insertVectorItems(collectionId, batches[i], settings, abortSignal);
                    }, RETRY_CONFIG);
                };

                // Apply rate limiting if configured, otherwise execute directly
                if (hasRateLimit) {
                    await dynamicRateLimiter.execute(processBatch, settings);
                } else {
                    await processBatch();
                }

                if (onProgress) {
                    const embeddedCount = (i + 1) * BATCH_SIZE;
                    const actualEmbedded = Math.min(embeddedCount, items.length);
                    onProgress(actualEmbedded, items.length);
                }
            }
        }

        // VEC-18: Record successful insert operation
        recordInsert(settings?.vector_backend || 'standard', items.length);
    } catch (error) {
        // VEC-18: Record error
        recordError(settings?.vector_backend || 'standard', error);
        throw error;
    }
}

/**
 * Stream embeddings and write to database as batches complete
 * @param {object} backend - The backend instance
 * @param {string} collectionId - Collection ID
 * @param {Array} items - Original items
 * @param {string[]} textStrings - Text strings extracted from items
 * @param {object} settings - Settings object
 * @param {Function} onProgress - Progress callback
 */
async function streamEmbeddingsAndWrite(backend, collectionId, items, textStrings, settings, onProgress, abortSignal = null) {
    // VEC-6: Use configurable batch size for optimized bulk inserts
    const EMBEDDING_BATCH_SIZE = settings.insert_batch_size || 50;
    let totalProcessed = 0;
    const totalBatches = Math.ceil(textStrings.length / EMBEDDING_BATCH_SIZE);

    console.log(`VectFox: Streaming ${items.length} items in ${totalBatches} batch(es) of up to ${EMBEDDING_BATCH_SIZE}`);

    // Process embeddings in batches
    for (let i = 0; i < textStrings.length; i += EMBEDDING_BATCH_SIZE) {
        const batchEnd = Math.min(i + EMBEDDING_BATCH_SIZE, textStrings.length);
        const batchTextStrings = textStrings.slice(i, batchEnd);
        const batchItems = items.slice(i, batchEnd);
        const batchNum = Math.floor(i / EMBEDDING_BATCH_SIZE) + 1;

        console.log(`VectFox: Embedding batch ${batchNum}/${totalBatches} (items ${i + 1}-${batchEnd})`);

        // VEC-6: Retry logic per batch instead of per chunk
        let additionalArgs;
        try {
            additionalArgs = await AsyncUtils.retry(async () => {
                return await getAdditionalArgs(batchTextStrings, settings);
            }, RETRY_CONFIG);
        } catch (error) {
            throw new Error(`VectFox: Failed to generate embeddings for batch ${batchNum} after retries: ${error.message}`);
        }

        if (!additionalArgs.embeddings) {
            throw new Error(`VectFox: No embeddings returned from ${settings.source} for batch ${batchNum}`);
        }

        // Attach embeddings to items and validate
        let missingEmbeddings = 0;
        const itemsToWrite = [];

        for (let j = 0; j < batchItems.length; j++) {
            const text = batchTextStrings[j];
            const embedding = additionalArgs.embeddings[text];

            if (embedding && Array.isArray(embedding) && embedding.length > 0) {
                // Validate embedding values
                const isValidEmbedding = embedding.every(val => typeof val === 'number' && !isNaN(val));
                if (!isValidEmbedding) {
                    console.error(`VectFox: Invalid embedding values for item ${i + j}:`, embedding.slice(0, 5));
                    missingEmbeddings++;
                    continue;
                }
                batchItems[j].vector = embedding;
                itemsToWrite.push(batchItems[j]);
            } else {
                missingEmbeddings++;
                console.warn(`VectFox: No embedding found for item ${i + j}, text: "${text.substring(0, 50)}..."`);
            }
        }

        if (missingEmbeddings > 0) {
            throw new Error(`VectFox: Failed to generate embeddings for ${settings.source} - ${missingEmbeddings} items missing in batch`);
        }

        // VEC-6: Write batch to database with retry logic
        console.log(`VectFox: Writing batch ${batchNum} to database (${itemsToWrite.length} items)`);
        try {
            await AsyncUtils.retry(async () => {
                if (abortSignal?.aborted) throw Object.assign(new Error('Vectorization stopped by user'), { name: 'AbortError' });
                await backend.insertVectorItems(collectionId, itemsToWrite, settings, abortSignal);
            }, RETRY_CONFIG);
        } catch (error) {
            throw new Error(`VectFox: Failed to write batch ${batchNum} to database after retries: ${error.message}`);
        }

        totalProcessed += itemsToWrite.length;

        // Update progress
        if (onProgress) {
            console.log(`[Core Vector API] Streamed ${totalProcessed}/${items.length} (${Math.round((totalProcessed / items.length) * 100)}%)`);
            onProgress(totalProcessed, items.length);
        }
    }

    console.log(`VectFox: Completed streaming ${totalProcessed} items to database`);
}

/**
 * Deletes vector items from a collection
 * @param {string} collectionId - The collection to delete from
 * @param {number[]} hashes - The hashes of the items to delete
 * @param {object} settings VectFox settings object
 * @returns {Promise<void>}
 */
export async function deleteVectorItems(collectionId, hashes, settings) {
    const backend = await getBackend(settings);
    try {
        // VEC-33: Wrap with health invalidation
        const result = await withHealthInvalidation(
            () => backend.deleteVectorItems(collectionId, hashes, settings),
            settings
        );
        // VEC-18: Record successful delete operation
        recordDelete(settings?.vector_backend || 'standard', hashes.length);
        return result;
    } catch (error) {
        // VEC-18: Record error
        recordError(settings?.vector_backend || 'standard', error);
        throw error;
    }
}

/**
 * Queries a single collection for similar vectors
 * Applies keyword boost system: overfetch → boost → trim
 * For client-side embedding sources (webllm, koboldcpp, bananabread), generates query embedding first.
 * @param {string} collectionId - The collection to query
 * @param {string} searchText - The text to query
 * @param {number} topK - The number of results to return
 * @param {object} settings VectFox settings object
 * @returns {Promise<{ hashes: number[], metadata: object[]}>} - Hashes and metadata of the results
 */
export async function queryCollection(collectionId, searchText, topK, settings, filters = {}) {
    const parsed = parseRegistryKey(collectionId);
    const backend = parsed.backend
        ? await getBackendForCollection(parsed.backend, settings)
        : await getBackend(settings);

    // Sources that require client-side embedding generation
    const clientSideEmbeddingSources = ['webllm', 'koboldcpp', 'bananabread'];
    let queryVector = null;

    // If source requires client-side embeddings, generate query vector
    if (clientSideEmbeddingSources.includes(settings.source)) {
        const queryItem = [searchText];
        try {
            const additionalArgs = await getAdditionalArgs(queryItem, settings);
            // additionalArgs.embeddings is a Record<string, number[]> where keys are original text
            if (additionalArgs.embeddings && additionalArgs.embeddings[searchText]) {
                queryVector = additionalArgs.embeddings[searchText];
                if (settings.eventbase_debug_logging) {
                    console.log(`[EventBase] Embedding model (${settings.source}) returned vector: dim=${queryVector.length}, first5=[${queryVector.slice(0, 5).map(v => v.toFixed(4)).join(', ')}], last5=[${queryVector.slice(-5).map(v => v.toFixed(4)).join(', ')}], model=${additionalArgs.model || 'n/a'}`);
                }
            } else {
                // VEC-35: Fallback to server-side embedding instead of failing completely
                console.warn(`[VectFox] Client-side embedding generation returned empty result for ${settings.source}, falling back to server-side embedding`);
            }
        } catch (clientEmbedError) {
            // VEC-35: Fallback to server-side embedding when client-side fails
            console.warn(`[VectFox] Client-side embedding failed for ${settings.source}: ${clientEmbedError.message}. Falling back to server-side embedding.`);
        }
    }

    // Three-case routing:
    //   A3 — server-side hybrid (Qdrant with prefer_native ON) — dense vector search +
    //         full-corpus payload/text keyword matching via Qdrant scroll, fused in plugin code
    //         (NOT Qdrant native dense+sparse-vector hybrid; no sparse vectors stored)
    //   A2 — client-side hybrid over ANN candidates (standard backend, method = 'hybrid')
    //   A1 — BM25 re-rank of ANN top-K (standard backend default, method = 'bm25')
    const nativeHybridAvailable = backend?.supportsHybridSearch?.() === true;
    const preferNative = settings.hybrid_native_prefer !== false;
    const useHybridPath = (nativeHybridAvailable && preferNative) || settings.keyword_scoring_method === 'hybrid';

    if (useHybridPath) {
        if (settings.eventbase_debug_logging) {
            const reason = nativeHybridAvailable && preferNative ? 'native' : 'client-side';
            console.log(`[VectFox] Hybrid search (${reason}), dispatching to hybrid search module`);
        }
        const queryStart = Date.now();
        try {
            const result = await hybridSearch(collectionId, searchText, topK, settings, { queryVector, filters });
            const queryLatency = Date.now() - queryStart;
            recordQuery(settings?.vector_backend || 'standard', queryLatency);
            if (settings.eventbase_debug_logging) {
                const scores = (result.metadata || []).map(m => (m.score ?? 0).toFixed(4));
                const fusionMethod = (settings.hybrid_fusion_method || 'rrf').toUpperCase();
                console.log(`[VectFox] Hybrid search (${fusionMethod}) response: ${result.hashes?.length ?? 0} result(s) in ${queryLatency}ms, scores=[${scores.join(', ')}]`);
            }
            return result;
        } catch (error) {
            recordError(settings?.vector_backend || 'standard', error);
            throw error;
        }
    }

    // Standard vector search flow (A1/A2). Filters are not supported here.
    if (Object.keys(filters).length > 0 && settings.eventbase_debug_logging) {
        console.warn('[VectFox] queryCollection: filters ignored on A1/A2 Standard backend path');
    }
    // Overfetch to allow keyword-boosted chunks to surface
    const overfetchAmount = getOverfetchAmount(topK);
    // VEC-18: Track query latency for health dashboard
    const queryStart = Date.now();
    let rawResults;
    // Derive the actual backend name from the collection's registry key prefix,
    // falling back to settings.vector_backend so metrics go to the right backend.
    const actualBackendName = parsed.backend || settings?.vector_backend || 'standard';
    try {
        rawResults = await backend.queryCollection(collectionId, searchText, overfetchAmount, settings, queryVector);
        const queryLatency = Date.now() - queryStart;
        recordQuery(actualBackendName, queryLatency);
        if (settings.eventbase_debug_logging) {
            const scores = (rawResults.metadata || []).map(m => (m.score ?? 0).toFixed(4));
            console.log(`[EventBase] Embedding search response: ${rawResults.hashes?.length ?? 0} result(s) in ${queryLatency}ms, scores=[${scores.join(', ')}]`);
        }
    } catch (error) {
        // VEC-18: Record query error
        recordError(actualBackendName, error);
        throw error;
    }

    // Convert to format expected by keyword boost
    const resultsForBoost = rawResults.metadata.map((meta, idx) => ({
        hash: rawResults.hashes[idx],
        score: meta.score || 0,
        metadata: meta,
        text: meta.text || ''
    }));

    let finalResults = scoreResults(resultsForBoost, searchText, topK, settings);

    if (settings.eventbase_debug_logging) {
        finalResults.forEach((r, i) => {
            console.log(`[VectFox] #${i + 1} final=${r.score?.toFixed(4)} vector=${r.vectorScore?.toFixed(4) ?? 'n/a'} bm25=${r.bm25Score?.toFixed(4) ?? 'n/a'} (A1 BM25 re-rank)`);
        });
    }

    // Convert back to expected format
    return {
        hashes: finalResults.map(r => r.hash),
        metadata: finalResults.map(r => ({
            ...r.metadata,
            score: r.score,
            originalScore: r.originalScore || r.vectorScore,
            keywordBoost: r.keywordBoost,
            bm25Score: r.bm25Score,
            normalizedBM25: r.normalizedBM25,
            vectorScore: r.vectorScore,
            matchedKeywords: r.matchedKeywords,
            matchedKeywordsWithWeights: r.matchedKeywordsWithWeights,
            keywordBoosted: r.keywordBoosted
        }))
    };
}

function scoreResults(resultsForBoost, searchText, topK, settings) {
    // Short-circuit: nothing to re-rank means no need to extract keywords or run BM25.
    if (!resultsForBoost || resultsForBoost.length === 0) {
        return [];
    }

    // A1 — BM25 re-rank over ANN top-K candidates only (no full corpus scan)
    const level = settings?.hybrid_keyword_level || 'balance';
    const maxKeywords = RETRIEVAL_KEYWORD_LEVELS[level]?.maxKeywords ?? 50;
    const rawKeywords = extractQueryKeywords(searchText, maxKeywords);
    const queryTokens = rawKeywords.map(token => isCJKToken(token) ? token : porterStemmer(token));

    const bm25Results = applyBM25Scoring(resultsForBoost, searchText, {
        k1: settings.bm25_k1 || 1.5,
        b: settings.bm25_b || 0.75,
        alpha: 0.5,
        beta: 0.5,
        queryTokens
    });
    return bm25Results.slice(0, topK);
}

/**
 * Queries multiple collections for a given text.
 * For client-side embedding sources, generates query embedding once and reuses for all collections.
 * @param {string[]} collectionIds - Collection IDs to query
 * @param {string} searchText - Text to query
 * @param {number} topK - Number of results to return
 * @param {number} threshold - Score threshold
 * @param {object} settings VectFox settings object
 * @returns {Promise<Record<string, { hashes: number[], metadata: object[] }>>} - Results mapped to collection IDs
 */
export async function queryMultipleCollections(collectionIds, searchText, topK, threshold, settings) {
    const backend = await getBackend(settings);

    // Sources that require client-side embedding generation
    const clientSideEmbeddingSources = ['webllm', 'koboldcpp', 'bananabread'];
    let queryVector = null;

    // Generate query vector once for all collections (efficiency)
    if (clientSideEmbeddingSources.includes(settings.source)) {
        try {
            // getAdditionalArgs expects string[], not objects
            const additionalArgs = await getAdditionalArgs([searchText], settings);
            // additionalArgs.embeddings is a Record<string, number[]> where keys are original text
            if (additionalArgs.embeddings && additionalArgs.embeddings[searchText]) {
                queryVector = additionalArgs.embeddings[searchText];
            } else {
                // VEC-35: Fallback to server-side embedding instead of failing completely
                console.warn(`[VectFox] Client-side embedding generation returned empty result for ${settings.source}, falling back to server-side embedding`);
            }
        } catch (clientEmbedError) {
            // VEC-35: Fallback to server-side embedding when client-side fails
            console.warn(`[VectFox] Client-side embedding failed for ${settings.source}: ${clientEmbedError.message}. Falling back to server-side embedding.`);
        }
    }

    // Three-case routing (mirrors queryCollection):
    //   A3/A2 — native or client-side hybrid per collection
    //   A1    — BM25 re-rank after bulk ANN (below)
    const nativeHybridAvailable = backend?.supportsHybridSearch?.() === true;
    const preferNative = settings.hybrid_native_prefer !== false;
    const useHybridPath = (nativeHybridAvailable && preferNative) || settings.keyword_scoring_method === 'hybrid';

    if (useHybridPath) {
        if (settings.eventbase_debug_logging) {
            const reason = nativeHybridAvailable && preferNative ? 'native' : 'client-side';
            console.log(`[VectFox] Hybrid search (${reason}) for multi-collection query`);
        }
        const processedResults = {};
        for (const collectionId of collectionIds) {
            try {
                const queryStart = Date.now();
                processedResults[collectionId] = await hybridSearch(collectionId, searchText, topK, settings, { queryVector });
                const queryLatency = Date.now() - queryStart;
                recordQuery(settings?.vector_backend || 'standard', queryLatency);
            } catch (error) {
                console.warn(`[VectFox] Hybrid search failed for ${collectionId}:`, error.message);
                recordError(settings?.vector_backend || 'standard', error);
                processedResults[collectionId] = { hashes: [], metadata: [] };
            }
        }
        return processedResults;
    }

    // Standard vector search flow
    // Get raw results from backend (with overfetch for each collection)
    const overfetchAmount = getOverfetchAmount(topK);
    // VEC-18: Track query latency for health dashboard
    const queryStart = Date.now();
    let rawResults;
    try {
        rawResults = await backend.queryMultipleCollections(collectionIds, searchText, overfetchAmount, threshold, settings, queryVector);
        const queryLatency = Date.now() - queryStart;
        recordQuery(settings?.vector_backend || 'standard', queryLatency);
    } catch (error) {
        // VEC-18: Record query error
        recordError(settings?.vector_backend || 'standard', error);
        throw error;
    }

    // Apply scoring to each collection's results
    const processedResults = {};

    for (const [collectionId, collectionResults] of Object.entries(rawResults)) {
        if (!collectionResults || !collectionResults.metadata) {
            processedResults[collectionId] = collectionResults;
            continue;
        }

        // Convert to format expected by scoring functions
        const resultsForBoost = collectionResults.metadata.map((meta, idx) => ({
            hash: collectionResults.hashes[idx],
            score: meta.score || 0,
            metadata: meta,
            text: meta.text || ''
        }));

        let finalResults = scoreResults(resultsForBoost, searchText, topK, settings);

        // Convert back to expected format
        processedResults[collectionId] = {
            hashes: finalResults.map(r => r.hash),
            metadata: finalResults.map(r => ({
                ...r.metadata,
                score: r.score,
                originalScore: r.originalScore || r.vectorScore,
                keywordBoost: r.keywordBoost,
                bm25Score: r.bm25Score,
                normalizedBM25: r.normalizedBM25,
                vectorScore: r.vectorScore,
                matchedKeywords: r.matchedKeywords,
                matchedKeywordsWithWeights: r.matchedKeywordsWithWeights,
                keywordBoosted: r.keywordBoosted
            }))
        };
    }

    return processedResults;
}

/**
 * Queries multiple collections with conditional activation filtering.
 * Collections that don't meet their activation conditions are skipped.
 *
 * @param {string[]} collectionIds - Collection IDs to potentially query
 * @param {string} searchText - Text to query
 * @param {number} topK - Number of results to return
 * @param {number} threshold - Score threshold
 * @param {object} settings - VectFox settings object
 * @param {object} context - Search context (from buildSearchContext)
 * @returns {Promise<Record<string, { hashes: number[], metadata: object[] }>>} - Results mapped to collection IDs
 */
export async function queryActiveCollections(collectionIds, searchText, topK, threshold, settings, context) {
    // Lazy import to avoid circular dependency
    const { filterActiveCollections } = await import('./collection-metadata.js');

    // Filter collections based on their activation conditions
    const activeCollectionIds = await filterActiveCollections(collectionIds, context);

    if (activeCollectionIds.length === 0) {
        console.log('VectFox: No collections passed activation conditions');
        return {};
    }

    // Query only the active collections
    const backend = await getBackend(settings);
    return await backend.queryMultipleCollections(activeCollectionIds, searchText, topK, threshold, settings);
}

/**
 * Purges the vector index for a collection.
 * @param {string} collectionId Collection ID to purge
 * @param {object} settings VectFox settings object
 * @returns {Promise<boolean>} True if deleted, false if not
 */
export async function purgeVectorIndex(collectionId, settings) {
    try {
        const backend = await getBackend(settings);
        await backend.purgeVectorIndex(collectionId, settings);
        console.log(`VectFox: Purged vector index for collection ${collectionId}`);
        return true;
    } catch (error) {
        // VEC-33: Invalidate health cache on operation error
        invalidateBackendHealth(settings?.vector_backend || 'standard', error);
        console.error('VectFox: Failed to purge', error);
        return false;
    }
}

/**
 * Purges the vector index for a file.
 * @param {string} collectionId File collection ID to purge
 * @param {object} settings VectFox settings object
 * @returns {Promise<void>}
 */
export async function purgeFileVectorIndex(collectionId, settings) {
    try {
        console.log(`VectFox: Purging file vector index for collection ${collectionId}`);
        const backend = await getBackend(settings);
        await backend.purgeFileVectorIndex(collectionId, settings);
        console.log(`VectFox: Purged vector index for collection ${collectionId}`);
    } catch (error) {
        // VEC-33: Invalidate health cache on operation error
        invalidateBackendHealth(settings?.vector_backend || 'standard', error);
        console.error('VectFox: Failed to purge file', error);
    }
}

/**
 * Purges all vector indexes.
 * @param {object} settings VectFox settings object
 * @returns {Promise<void>}
 */
export async function purgeAllVectorIndexes(settings) {
    try {
        const backend = await getBackend(settings);
        await backend.purgeAllVectorIndexes(settings);
        console.log('VectFox: Purged all vector indexes');
        toastr.success('All vector indexes purged', 'Purge successful');
    } catch (error) {
        // VEC-33: Invalidate health cache on operation error
        invalidateBackendHealth(settings?.vector_backend || 'standard', error);
        console.error('VectFox: Failed to purge all', error);
        toastr.error('Failed to purge all vector indexes', 'Purge failed');
    }
}

/**
 * Update chunk text (triggers re-embedding)
 * @param {string} collectionId - Collection ID
 * @param {number} hash - Chunk hash
 * @param {string} newText - New text content
 * @param {object} settings - VectFox settings
 */
export async function updateChunkText(collectionId, hash, newText, settings) {
    const backend = await getBackend(settings);
    return await backend.updateChunkText(collectionId, hash, newText, settings);
}

/**
 * Update chunk metadata (no re-embedding)
 * @param {string} collectionId - Collection ID
 * @param {number} hash - Chunk hash
 * @param {object} metadata - Metadata to update (keywords, enabled, etc.)
 * @param {object} settings - VectFox settings
 */
export async function updateChunkMetadata(collectionId, hash, metadata, settings) {
    const backend = await getBackend(settings);
    return await backend.updateChunkMetadata(collectionId, hash, metadata, settings);
}
