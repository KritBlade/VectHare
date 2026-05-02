/**
 * ============================================================================
 * MILVUS BACKEND (via Unified Plugin API)
 * ============================================================================
 * Uses the Similharity plugin's unified /chunks/* endpoints.
 * Backend: Milvus (external vector database server)
 *
 * MULTITENANCY SUPPORT:
 * - Uses ONE collection ("vecthare_main") with payload filters
 * - Passes type and sourceId for data isolation
 * - Supports all VectHare features via payload metadata
 *
 * Requires either a local Milvus instance or Milvus Cloud account.
 *
 * @author VectHare
 * @version 3.0.0
 * ============================================================================
 */

import { getRequestHeaders } from '../../../../../script.js';
import { VectorBackend } from './backend-interface.js';
import { getModelField } from '../core/providers.js';
import { VECTOR_LIST_LIMIT } from '../core/constants.js';
import { textgen_types, textgenerationwebui_settings } from '../../../../textgen-settings.js';

const BACKEND_TYPE = 'milvus';

/**
 * Get the model value from settings based on provider
 */
function getModelFromSettings(settings) {
    const modelField = getModelField(settings.source);
    return modelField ? settings[modelField] || '' : '';
}

function getPluginProviderParams(settings) {
    const params = {};

    switch (settings.source) {
        case 'ollama':
            params.apiUrl = settings.use_alt_endpoint
                ? settings.alt_endpoint_url
                : textgenerationwebui_settings.server_urls[textgen_types.OLLAMA];
            params.keep = !!settings.ollama_keep;
            break;
        case 'llamacpp':
            params.apiUrl = settings.use_alt_endpoint
                ? settings.alt_endpoint_url
                : textgenerationwebui_settings.server_urls[textgen_types.LLAMACPP];
            break;
        case 'vllm':
            params.apiUrl = settings.use_alt_endpoint
                ? settings.alt_endpoint_url
                : textgenerationwebui_settings.server_urls[textgen_types.VLLM];
            break;
        case 'koboldcpp':
            params.apiUrl = settings.use_alt_endpoint
                ? settings.alt_endpoint_url
                : textgenerationwebui_settings.server_urls[textgen_types.KOBOLDCPP];
            break;
        case 'bananabread':
            params.apiUrl = settings.use_alt_endpoint
                ? settings.alt_endpoint_url
                : 'http://localhost:8008';
            if (settings.bananabread_api_key) {
                params.apiKey = settings.bananabread_api_key;
            }
            break;
        default:
            break;
    }

    return params;
}

export class MilvusBackend extends VectorBackend {
    async _autoDetectDimensions(settings) {
        try {
            // Don't auto-detect for sources that are handled client-side in VectHare 
            // but missing in Similharity servers-side generation (e.g. KoboldCpp/WebLLM)
            // Although WebLLM is client-side, we can't easily run it here without importing providers.
            // This is a best-effort for server-side providers (OpenAI, etc.) supported by Similharity.
            
            console.log(`VectHare: Attempting to auto-detect embedding dimensions for ${settings.source}...`);
            
            const response = await fetch('/api/plugins/similharity/get-embedding', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({
                    text: 'test',
                    source: settings.source || 'transformers',
                    model: getModelFromSettings(settings),
                    ...getPluginProviderParams(settings),
                }),
            });

            if (response.ok) {
                const data = await response.json();
                if (data.success && data.embedding && Array.isArray(data.embedding)) {
                    console.log(`VectHare: Auto-detected dimension: ${data.embedding.length}`);
                    return data.embedding.length;
                }
            }
        } catch (e) {
            console.warn('VectHare: Failed to auto-detect dimensions:', e);
        }
        return null;
    }

    async initialize(settings) {
        // Determine dimensions: Manual setting > Auto-detect > Default (null)
        let dimensions = settings.milvus_dimensions ? parseInt(settings.milvus_dimensions) : null;
        
        if (!dimensions || isNaN(dimensions)) {
            dimensions = await this._autoDetectDimensions(settings);
        }

        // Get Milvus config from settings
        const config = {
            host: settings.milvus_host || 'localhost',
            port: settings.milvus_port || 19530,
            address: settings.milvus_address || (settings.milvus_host ? `${settings.milvus_host}:${settings.milvus_port || 19530}` : 'localhost:19530'),
            username: settings.milvus_username || null,
            password: settings.milvus_password || null,
            token: settings.milvus_token || null,
            dimensions: dimensions,
        };

        const response = await fetch('/api/plugins/similharity/backend/init/milvus', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(config),
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`[Milvus] Failed to initialize Milvus: ${response.status} ${response.statusText} - ${errorBody}`);
        }

        console.log('VectHare: Using Milvus backend (production-grade vector search)');
    }

    async healthCheck() {
        try {
            const response = await fetch('/api/plugins/similharity/backend/health/milvus', {
                headers: getRequestHeaders(),
            });

            if (!response.ok) return false;

            const data = await response.json();
            return data.healthy === true;
        } catch (error) {
            console.error('[Milvus] Health check failed:', error);
            return false;
        }
    }

    /**
     * Parse collection ID to extract type and sourceId for multitenancy
     * Handles registry key format: backend:source:collectionId
     * Extracts just the collectionId part and parses it
     * 
     * New format: vh:{type}:{uuid}
     * Examples:
     *   "vh:chat:a1b2c3d4-e5f6-7890-abcd-ef1234567890" → {type: "chat", sourceId: "a1b2..."}
     *   "vh:lorebook:world_info_123" → {type: "lorebook", sourceId: "world_info_123"}
     *   "vh:doc:char_456" → {type: "doc", sourceId: "char_456"}
     * 
     * Legacy format: vecthare_{type}_{sourceId}
     */
    _parseCollectionId(collectionId) {
        if (!collectionId || typeof collectionId !== 'string') {
            return { type: 'unknown', sourceId: 'unknown' };
        }

        // Strip registry key prefix if present (backend:source:collectionId)
        const knownBackends = ['standard', 'lancedb', 'vectra', 'milvus', 'qdrant'];
        const knownSources = ['transformers', 'openai', 'cohere', 'ollama', 'llamacpp',
            'vllm', 'koboldcpp', 'webllm', 'bananabread', 'openrouter'];
        
        const parts = collectionId.split(':');
        
        // Check if it starts with backend:source: prefix
        if (parts.length >= 3 && knownBackends.includes(parts[0]) && knownSources.includes(parts[1])) {
            // Strip the backend:source: prefix and work with just the collection ID
            collectionId = parts.slice(2).join(':');
        }
        // Check if it starts with source: prefix (old format)
        else if (parts.length >= 2 && knownSources.includes(parts[0])) {
            // Strip the source: prefix
            collectionId = parts.slice(1).join(':');
        }

        // Now parse the actual collection ID
        const idParts = collectionId.split(':');

        // New format: vh:{type}:{sourceId}
        if (idParts.length >= 3 && idParts[0] === 'vh') {
            return {
                type: idParts[1],
                sourceId: idParts.slice(2).join(':') // Handle UUIDs that might have colons
            };
        }

        // Legacy format: vecthare_{type}_{sourceId}
        const legacyParts = collectionId.split('_');
        if (legacyParts.length >= 3 && legacyParts[0] === 'vecthare') {
            return {
                type: legacyParts[1],
                sourceId: legacyParts.slice(2).join('_')
            };
        }

        // Fallback: assume it's a chat with raw ID
        console.warn('VectHare: Unknown collection ID format:', collectionId);
        return {
            type: 'chat',
            sourceId: collectionId
        };
    }

    async getSavedHashes(collectionId, settings) {
        const { type, sourceId } = this._parseCollectionId(collectionId);

        const response = await fetch('/api/plugins/similharity/chunks/list', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                backend: BACKEND_TYPE,
                collectionId: 'vecthare_main', // Always use main collection
                source: settings.source || 'transformers',
                model: getModelFromSettings(settings),
                limit: VECTOR_LIST_LIMIT,
                filters: { type, sourceId }, // Filter by tenant
            }),
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`[Milvus] Failed to get saved hashes for ${collectionId} (type: ${type}, sourceId: ${sourceId}): ${response.status} ${response.statusText} - ${errorBody}`);
        }

        const data = await response.json();
        return data.items ? data.items.map(item => item.hash) : [];
    }

    async insertVectorItems(collectionId, items, settings) {
        if (items.length === 0) return;

        const { type, sourceId } = this._parseCollectionId(collectionId);

        const response = await fetch('/api/plugins/similharity/chunks/insert', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                backend: BACKEND_TYPE,
                collectionId: 'vecthare_main', // Always use main collection
                items: items.map(item => ({
                    hash: item.hash,
                    text: item.text,
                    index: item.index,
                    vector: item.vector,
                    metadata: {
                        ...item.metadata,
                        // Pass through VectHare-specific fields
                        importance: item.importance,
                        keywords: item.keywords,
                        customWeights: item.customWeights,
                        disabledKeywords: item.disabledKeywords,
                        chunkGroup: item.chunkGroup,
                        conditions: item.conditions,
                        summary: item.summary,
                        isSummaryChunk: item.isSummaryChunk,
                        parentHash: item.parentHash,
                    }
                })),
                source: settings.source || 'transformers',
                model: getModelFromSettings(settings),
                ...getPluginProviderParams(settings),
                filters: { type, sourceId }, // Pass multitenancy info
            }),
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`[Milvus] Failed to insert ${items.length} vectors into ${collectionId} (type: ${type}, sourceId: ${sourceId}): ${response.status} ${response.statusText} - ${errorBody}`);
        }

        console.log(`VectHare Milvus: Inserted ${items.length} vectors (type: ${type}, sourceId: ${sourceId})`);
    }

    async deleteVectorItems(collectionId, hashes, settings) {
        const { type, sourceId } = this._parseCollectionId(collectionId);

        const response = await fetch('/api/plugins/similharity/chunks/delete', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                backend: BACKEND_TYPE,
                collectionId: 'vecthare_main',
                hashes: hashes,
                source: settings.source || 'transformers',
                model: getModelFromSettings(settings),
                filters: { type, sourceId },
            }),
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`[Milvus] Failed to delete vectors from ${collectionId} (type: ${type}, sourceId: ${sourceId}): ${response.status} ${response.statusText} - ${errorBody}`);
        }
    }

    async queryCollection(collectionId, searchText, topK, settings) {
        const { type, sourceId } = this._parseCollectionId(collectionId);

        const response = await fetch('/api/plugins/similharity/chunks/query', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                backend: BACKEND_TYPE,
                collectionId: 'vecthare_main',
                searchText: searchText,
                topK: topK,
                threshold: 0.0,
                source: settings.source || 'transformers',
                model: getModelFromSettings(settings),
                ...getPluginProviderParams(settings),
                filters: { type, sourceId },
            }),
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`[Milvus] Failed to query collection ${collectionId} (type: ${type}, sourceId: ${sourceId}): ${response.status} ${response.statusText} - ${errorBody}`);
        }

        const data = await response.json();

        // Format results to match expected output
        const hashes = data.results.map(r => r.hash);
        const metadata = data.results.map(r => ({
            hash: r.hash,
            text: r.text,
            score: r.score,
            ...r.metadata,
        }));

        return { hashes, metadata };
    }

    async queryMultipleCollections(collectionIds, searchText, topK, threshold, settings) {
        const results = {};

        for (const collectionId of collectionIds) {
            try {
                const { type, sourceId } = this._parseCollectionId(collectionId);

                const response = await fetch('/api/plugins/similharity/chunks/query', {
                    method: 'POST',
                    headers: getRequestHeaders(),
                    body: JSON.stringify({
                        backend: BACKEND_TYPE,
                        collectionId: 'vecthare_main',
                        searchText: searchText,
                        topK: topK,
                        threshold: threshold,
                        source: settings.source || 'transformers',
                        model: getModelFromSettings(settings),
                        ...getPluginProviderParams(settings),
                        filters: { type, sourceId },
                    }),
                });

                if (response.ok) {
                    const data = await response.json();
                    const resultArray = data.results || data.chunks || [];

                    results[collectionId] = {
                        hashes: resultArray.map(r => r.hash),
                        metadata: resultArray.map(r => ({
                            hash: r.hash,
                            text: r.text,
                            score: r.score,
                            ...r.metadata,
                        })),
                    };
                } else {
                    console.error(`VectHare: Query failed for ${collectionId}: ${response.status} ${response.statusText}`);
                    results[collectionId] = { hashes: [], metadata: [] };
                }
            } catch (error) {
                console.error(`Failed to query collection ${collectionId}:`, error);
                results[collectionId] = { hashes: [], metadata: [] };
            }
        }

        return results;
    }

    async purgeVectorIndex(collectionId, settings) {
        const { type, sourceId } = this._parseCollectionId(collectionId);

        const response = await fetch('/api/plugins/similharity/chunks/purge', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                backend: BACKEND_TYPE,
                collectionId: 'vecthare_main',
                source: settings.source || 'transformers',
                model: getModelFromSettings(settings),
                filters: { type, sourceId }, // Purge specific tenant
            }),
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`[Milvus] Failed to purge collection ${collectionId} (type: ${type}, sourceId: ${sourceId}): ${response.status} ${response.statusText} - ${errorBody}`);
        }

        console.log(`VectHare Milvus: Purged (type: ${type}, sourceId: ${sourceId})`);
    }

    async purgeFileVectorIndex(collectionId, settings) {
        return this.purgeVectorIndex(collectionId, settings);
    }

    async purgeAllVectorIndexes(settings) {
        // Purge the entire main collection
        const response = await fetch('/api/plugins/similharity/chunks/purge', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                backend: BACKEND_TYPE,
                collectionId: 'vecthare_main',
                source: settings.source || 'transformers',
                model: getModelFromSettings(settings),
                // No filters = purge everything
            }),
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`[Milvus] Failed to purge all collections: ${response.status} ${response.statusText} - ${errorBody}`);
        }
    }

    // ========================================================================
    // EXTENDED API METHODS (for UI components)
    // ========================================================================

    /**
     * Get a single chunk by hash
     */
    async getChunk(collectionId, hash, settings) {
        const { type, sourceId } = this._parseCollectionId(collectionId);

        const response = await fetch(`/api/plugins/similharity/chunks/${encodeURIComponent(hash)}?` + new URLSearchParams({
            backend: BACKEND_TYPE,
            collectionId: 'vecthare_main',
            source: settings.source || 'transformers',
                model: getModelFromSettings(settings),
        }), {
            headers: getRequestHeaders(),
        });

        if (!response.ok) {
            if (response.status === 404) return null;
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`[Milvus] Failed to get chunk ${hash} from ${collectionId}: ${response.status} ${response.statusText} - ${errorBody}`);
        }

        const data = await response.json();
        return data.chunk;
    }

    /**
     * List chunks with pagination
     */
    async listChunks(collectionId, settings, options = {}) {
        const { type, sourceId } = this._parseCollectionId(collectionId);

        const response = await fetch('/api/plugins/similharity/chunks/list', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                backend: BACKEND_TYPE,
                collectionId: 'vecthare_main',
                source: settings.source || 'transformers',
                model: getModelFromSettings(settings),
                offset: options.offset || 0,
                limit: options.limit || 100,
                includeVectors: options.includeVectors || false,
                filters: { type, sourceId },
            }),
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`[Milvus] Failed to list chunks in ${collectionId} (type: ${type}, sourceId: ${sourceId}): ${response.status} ${response.statusText} - ${errorBody}`);
        }

        return await response.json();
    }

    /**
     * Update chunk text (triggers re-embedding)
     */
    async updateChunkText(collectionId, hash, newText, settings) {
        const { type, sourceId } = this._parseCollectionId(collectionId);

        const response = await fetch(`/api/plugins/similharity/chunks/${encodeURIComponent(hash)}/text`, {
            method: 'PATCH',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                backend: BACKEND_TYPE,
                collectionId: 'vecthare_main',
                text: newText,
                source: settings.source || 'transformers',
                model: getModelFromSettings(settings),
                filters: { type, sourceId },
            }),
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`[Milvus] Failed to update chunk text in ${collectionId} (hash: ${hash}): ${response.status} ${response.statusText} - ${errorBody}`);
        }

        return await response.json();
    }

    /**
     * Update chunk metadata (no re-embedding)
     */
    async updateChunkMetadata(collectionId, hash, metadata, settings) {
        const { type, sourceId } = this._parseCollectionId(collectionId);

        const response = await fetch(`/api/plugins/similharity/chunks/${encodeURIComponent(hash)}/metadata`, {
            method: 'PATCH',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                backend: BACKEND_TYPE,
                collectionId: 'vecthare_main',
                metadata: metadata,
                source: settings.source || 'transformers',
                model: getModelFromSettings(settings),
                filters: { type, sourceId },
            }),
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`[Milvus] Failed to update chunk metadata in ${collectionId} (hash: ${hash}): ${response.status} ${response.statusText} - ${errorBody}`);
        }

        return await response.json();
    }

    /**
     * Get collection statistics
     */
    async getStats(collectionId, settings) {
        const { type, sourceId } = this._parseCollectionId(collectionId);

        const response = await fetch('/api/plugins/similharity/chunks/stats', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                backend: BACKEND_TYPE,
                collectionId: 'vecthare_main',
                source: settings.source || 'transformers',
                model: getModelFromSettings(settings),
                filters: { type, sourceId },
            }),
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`[Milvus] Failed to get stats for ${collectionId} (type: ${type}, sourceId: ${sourceId}): ${response.status} ${response.statusText} - ${errorBody}`);
        }

        const data = await response.json();
        return data.stats;
    }

    // ========================================================================
    // HYBRID SEARCH METHODS
    // ========================================================================

    /**
     * Check if this backend supports native hybrid search.
     * Milvus supports hybrid search via the Similharity plugin.
     * @returns {boolean}
     */
    supportsHybridSearch() {
        return true;
    }

    /**
     * Perform hybrid search using Milvus's hybrid capabilities.
     * Falls back to regular vector search if hybrid endpoint is unavailable.
     *
     * @param {string} collectionId - Collection to query
     * @param {string} searchText - Query text
     * @param {number} topK - Number of results to return
     * @param {object} settings - VectHare settings
     * @param {object} hybridOptions - Hybrid search options
     * @returns {Promise<{hashes: number[], metadata: object[]}>}
     */
    async hybridQuery(collectionId, searchText, topK, settings, hybridOptions = {}) {
        const {
            vectorWeight = 0.5,
            textWeight = 0.5,
            fusionMethod = 'rrf',
            rrfK = 60
        } = hybridOptions;

        const { type, sourceId } = this._parseCollectionId(collectionId);

        const body = {
            backend: BACKEND_TYPE,
            collectionId: 'vecthare_main',
            searchText: searchText,
            topK: topK,
            threshold: 0.0,
            source: settings.source || 'transformers',
            model: getModelFromSettings(settings),
            filters: { type, sourceId },
            // Hybrid-specific parameters
            hybrid: true,
            hybridOptions: {
                vectorWeight,
                textWeight,
                fusionMethod,
                rrfK
            }
        };

        try {
            // Try the hybrid endpoint first
            const response = await fetch('/api/plugins/similharity/chunks/hybrid-query', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify(body),
            });

            if (response.ok) {
                const data = await response.json();
                console.log(`[Milvus] Native hybrid search returned ${data.results?.length || 0} results`);

                return {
                    hashes: data.results.map(r => r.hash),
                    metadata: data.results.map(r => ({
                        hash: r.hash,
                        text: r.text,
                        score: r.score,
                        vectorScore: r.vectorScore,
                        textScore: r.textScore,
                        fusionMethod: fusionMethod,
                        hybridSearch: true,
                        ...r.metadata,
                    }))
                };
            }

            // If hybrid endpoint returns 404 or similar, fall back
            console.warn(`[Milvus] Hybrid endpoint not available (${response.status}), falling back to vector-only search`);
        } catch (error) {
            console.warn(`[Milvus] Hybrid search failed:`, error.message);
        }

        // Fallback to regular vector search
        return this.queryCollection(collectionId, searchText, topK, settings);
    }
}
