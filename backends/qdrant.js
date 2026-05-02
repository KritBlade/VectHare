/**
 * ============================================================================
 * QDRANT BACKEND (via Unified Plugin API)
 * ============================================================================
 * Uses the Similharity plugin's unified /chunks/* endpoints.
 * Backend: Qdrant (external vector database server)
 *
 * COLLECTION STRATEGY (configurable via settings.qdrant_multitenancy):
 *
 * MULTITENANCY MODE (qdrant_multitenancy = true):
 * - Uses a single shared collection: "vecthare_multitenancy"
 * - Adds content_type metadata field to distinguish different sources
 * - Uses Qdrant filtering to query only the relevant content_type
 * - More efficient for resource usage, suitable for smaller deployments
 *
 * SEPARATE COLLECTIONS MODE (qdrant_multitenancy = false, DEFAULT):
 * - Creates separate collections per content type/source
 * - Each chat vectorization gets its own collection
 * - Each character gets its own collection
 * - Each lorebook gets its own collection
 * - Better organization and isolation of data
 * - Recommended for production use
 *
 * Requires either a local Qdrant instance or Qdrant Cloud account.
 *
 * @author VectHare
 * @version 3.2.0
 * ============================================================================
 */

import { getRequestHeaders } from '../../../../../script.js';
import { VectorBackend } from './backend-interface.js';
import { getModelField } from '../core/providers.js';
import { VECTOR_LIST_LIMIT } from '../core/constants.js';
import { textgen_types, textgenerationwebui_settings } from '../../../../textgen-settings.js';

const BACKEND_TYPE = 'qdrant';
const MULTITENANCY_COLLECTION = 'vecthare_multitenancy';

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

/**
 * Determines the actual collection name to use based on multitenancy setting
 * @param {string} collectionId - Original collection ID
 * @param {object} settings - VectHare settings
 * @returns {string} - Actual collection name to use
 */
function getActualCollectionId(collectionId, settings) {
    if (settings.qdrant_multitenancy) {
        return MULTITENANCY_COLLECTION;
    }
    return collectionId;
}

export class QdrantBackend extends VectorBackend {
    async initialize(settings) {
        // Get Qdrant config from settings
        // Only send relevant config based on cloud vs local mode
        let config;

        if (settings.qdrant_use_cloud) {
            // Cloud mode: use URL and API key
            config = {
                url: settings.qdrant_url || null,
                apiKey: settings.qdrant_api_key || null,
                // Explicitly clear local settings to prevent conflicts
                host: null,
                port: null,
            };
            console.log('VectHare: Initializing Qdrant Cloud:', config.url);
        } else {
            // Local mode: use host and port
            config = {
                host: settings.qdrant_host || 'localhost',
                port: settings.qdrant_port || 6333,
                // Explicitly clear cloud settings to prevent conflicts
                url: null,
                apiKey: null,
            };
            console.log('VectHare: Initializing local Qdrant:', `${config.host}:${config.port}`);
        }

        console.log('VectHare: Sending Qdrant config to Similharity plugin:', JSON.stringify(config));

        const response = await fetch('/api/plugins/similharity/backend/init/qdrant', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(config),
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`[Qdrant] Failed to initialize Qdrant: ${response.status} ${response.statusText} - ${errorBody}`);
        }

        const responseData = await response.json().catch(() => ({}));
        console.log('VectHare: Qdrant initialization response:', responseData);
        console.log('VectHare: Using Qdrant backend (production-grade vector search)');
    }

    async healthCheck() {
        try {
            const response = await fetch('/api/plugins/similharity/backend/health/qdrant', {
                headers: getRequestHeaders(),
            });

            if (!response.ok) return false;

            const data = await response.json();
            return data.healthy === true;
        } catch (error) {
            console.error('[Qdrant] Health check failed:', error);
            return false;
        }
    }

    /**
     * Strip registry key prefix (backend:source:collectionId) to get just the collection ID
     * @param {string} collectionId - May be plain ID or prefixed registry key
     * @returns {string} - Just the collection ID part
     */
    _stripRegistryPrefix(collectionId) {
        if (!collectionId || typeof collectionId !== 'string') {
            return collectionId;
        }

        const knownBackends = ['standard', 'lancedb', 'vectra', 'milvus', 'qdrant'];
        const knownSources = ['transformers', 'openai', 'cohere', 'ollama', 'llamacpp',
            'vllm', 'koboldcpp', 'webllm', 'bananabread', 'openrouter'];

        const parts = collectionId.split(':');

        // Check if it starts with backend:source: prefix
        if (parts.length >= 3 && knownBackends.includes(parts[0]) && knownSources.includes(parts[1])) {
            return parts.slice(2).join(':');
        }
        // Check if it starts with source: prefix (old format)
        else if (parts.length >= 2 && knownSources.includes(parts[0])) {
            return parts.slice(1).join(':');
        }

        // Already plain collection ID
        return collectionId;
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
        // First strip any registry prefix
        collectionId = this._stripRegistryPrefix(collectionId);
        if (!collectionId || typeof collectionId !== 'string') {
            return { type: 'unknown', sourceId: 'unknown' };
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
        const strippedCollectionId = this._stripRegistryPrefix(collectionId);
        const actualCollectionId = getActualCollectionId(strippedCollectionId, settings);

        const body = {
            backend: BACKEND_TYPE,
            collectionId: actualCollectionId,
            source: settings.source || 'transformers',
            model: getModelFromSettings(settings),
            limit: VECTOR_LIST_LIMIT,
        };

        // Add content_type filter for multitenancy mode
        if (settings.qdrant_multitenancy) {
            body.filter = {
                must: [
                    { key: 'content_type', match: { value: strippedCollectionId } }
                ]
            };
        }

        const response = await fetch('/api/plugins/similharity/chunks/list', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`[Qdrant] Failed to get saved hashes for ${collectionId}: ${response.status} ${response.statusText} - ${errorBody}`);
        }

        const data = await response.json();
        return data.items ? data.items.map(item => item.hash) : [];
    }

    async insertVectorItems(collectionId, items, settings) {
        if (items.length === 0) return;

        // Strip registry key prefix to get the actual collection ID for Qdrant
        const strippedCollectionId = this._stripRegistryPrefix(collectionId);
        const actualCollectionId = getActualCollectionId(strippedCollectionId, settings);

        // Batch items to avoid exceeding Qdrant's 32MB payload limit
        // Qdrant's default limit is 33554432 bytes (32MB)
        const BATCH_SIZE = 100; // Conservative batch size to stay well under limit
        const batches = [];
        for (let i = 0; i < items.length; i += BATCH_SIZE) {
            batches.push(items.slice(i, i + BATCH_SIZE));
        }

        console.log(`VectHare Qdrant: Inserting ${items.length} vectors in ${batches.length} batch(es) of up to ${BATCH_SIZE} items`);

        // Process each batch
        for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
            const batch = batches[batchIndex];
            const batchNum = batchIndex + 1;

            const response = await fetch('/api/plugins/similharity/chunks/insert', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({
                    backend: BACKEND_TYPE,
                    collectionId: actualCollectionId,
                    items: batch.map(item => {
                        // Include keywords in the text for embedding/indexing
                        let textWithKeywords = item.text || '';
                        if (item.keywords && item.keywords.length > 0) {
                            const keywordTexts = item.keywords.map(kw => kw.text || kw).join(' ');
                            textWithKeywords += ` [KEYWORDS: ${keywordTexts}]`;
                        }

                        const metadata = {
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
                        };

                        // Add content_type for multitenancy mode
                        if (settings.qdrant_multitenancy) {
                            metadata.content_type = strippedCollectionId;
                        }

                        return {
                            hash: item.hash,
                            text: textWithKeywords,
                            index: item.index,
                            vector: item.vector,
                            metadata,
                        };
                    }),
                    source: settings.source || 'transformers',
                    model: getModelFromSettings(settings),
                    ...getPluginProviderParams(settings),
                }),
            });

            if (!response.ok) {
                const errorBody = await response.text().catch(() => 'No response body');

                // Check for dimension mismatch error
                if (errorBody.includes('Vector dimension error') || errorBody.includes('dimension')) {
                    const dimensionMatch = errorBody.match(/expected dim: (\d+), got (\d+)/);
                    if (dimensionMatch) {
                        const expectedDim = dimensionMatch[1];
                        const gotDim = dimensionMatch[2];
                        throw new Error(
                            `[Qdrant] Vector dimension mismatch: Collection "${actualCollectionId}" expects ${expectedDim}-dimensional vectors, but received ${gotDim}-dimensional vectors. ` +
                            `This happens when switching embedding models. Solution: Delete the collection in Database Browser or use Qdrant API to drop it, then re-vectorize.`
                        );
                    }
                    throw new Error(
                        `[Qdrant] Vector dimension mismatch in collection "${actualCollectionId}". ` +
                        `This typically means you switched embedding models. Solution: Delete the collection and re-vectorize. Error: ${errorBody}`
                    );
                }

                throw new Error(`[Qdrant] Failed to insert ${items.length} vectors into ${actualCollectionId}: ${response.status} ${response.statusText} - ${errorBody}`);
            }

            console.log(`VectHare Qdrant: Batch ${batchNum}/${batches.length} completed (${batch.length} vectors)`);
        }
        try {
            // Dynamic import to avoid circular dependency
            const { registerCollection } = await import('../core/collection-loader.js');
            registerCollection(collectionId);
        } catch (e) {
            console.warn('VectHare: Failed to register collection after Qdrant insert:', e);
        }

        const mode = settings.qdrant_multitenancy ? 'multitenancy' : 'separate';
        console.log(`VectHare Qdrant: Inserted ${items.length} vectors into ${actualCollectionId} (${mode} mode, content_type: ${strippedCollectionId})`);
    }

    async deleteVectorItems(collectionId, hashes, settings) {
        const strippedCollectionId = this._stripRegistryPrefix(collectionId);
        const actualCollectionId = getActualCollectionId(strippedCollectionId, settings);

        const body = {
            backend: BACKEND_TYPE,
            collectionId: actualCollectionId,
            hashes: hashes,
            source: settings.source || 'transformers',
            model: getModelFromSettings(settings),
        };

        // Add content_type filter for multitenancy mode
        if (settings.qdrant_multitenancy) {
            body.filter = {
                must: [
                    { key: 'content_type', match: { value: strippedCollectionId } }
                ]
            };
        }

        const response = await fetch('/api/plugins/similharity/chunks/delete', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`[Qdrant] Failed to delete vectors from ${collectionId}: ${response.status} ${response.statusText} - ${errorBody}`);
        }
    }

    async queryCollection(collectionId, searchText, topK, settings, queryVector = null) {
        const strippedCollectionId = this._stripRegistryPrefix(collectionId);
        const actualCollectionId = getActualCollectionId(strippedCollectionId, settings);

        const body = {
            backend: BACKEND_TYPE,
            collectionId: actualCollectionId,
            searchText: searchText,
            topK: topK,
            threshold: 0.0,
            source: settings.source || 'transformers',
            model: getModelFromSettings(settings),
            ...getPluginProviderParams(settings),
        };

    //Use queryVector if provided, otherwise searchText
        if (queryVector) {
            body.queryVector = queryVector;
        } else if (searchText?.trim()) {
            body.searchText = searchText;
        } else {
            console.warn('[Qdrant] No queryVector or searchText provided');
            return { hashes: [], metadata: [] };
        }

        // Add content_type filter for multitenancy mode
        if (settings.qdrant_multitenancy) {
            body.filter = {
                must: [
                    { key: 'content_type', match: { value: strippedCollectionId } }
                ]
            };
        }

        const response = await fetch('/api/plugins/similharity/chunks/query', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`[Qdrant] Failed to query collection ${collectionId}: ${response.status} ${response.statusText} - ${errorBody}`);
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
                const strippedCollectionId = this._stripRegistryPrefix(collectionId);
                const actualCollectionId = getActualCollectionId(strippedCollectionId, settings);

                const body = {
                    backend: BACKEND_TYPE,
                    collectionId: actualCollectionId,
                    searchText: searchText,
                    topK: topK,
                    threshold: threshold,
                    source: settings.source || 'transformers',
                    model: getModelFromSettings(settings),
                    ...getPluginProviderParams(settings),
                };


                // Use queryVector if provided, otherwise searchText
                if (queryVector) {
                    body.queryVector = queryVector;
                } else if (searchText?.trim()) {
                    body.searchText = searchText;
                } else {
                    console.warn(`[Qdrant] No queryVector or searchText for ${collectionId}`);
                    results[collectionId] = { hashes: [], metadata: [] };
                    continue;
                }

                // Add content_type filter for multitenancy mode
                if (settings.qdrant_multitenancy) {
                    body.filter = {
                        must: [
                            { key: 'content_type', match: { value: strippedCollectionId } }
                        ]
                    };
                }

                const response = await fetch('/api/plugins/similharity/chunks/query', {
                    method: 'POST',
                    headers: getRequestHeaders(),
                    body: JSON.stringify(body),
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
                    const errorBody = await response.text().catch(() => 'No response body');
                    const errorMsg = `${response.status} ${response.statusText} - ${errorBody}`;
                    console.error(`VectHare: Query failed for ${collectionId}: ${errorMsg}`);
                    results[collectionId] = { hashes: [], metadata: [], error: errorMsg };
                }
            } catch (error) {
                console.error(`Failed to query collection ${collectionId}:`, error);
                results[collectionId] = { hashes: [], metadata: [], error: error.message };
            }
        }

        return results;
    }

    async purgeVectorIndex(collectionId, settings) {
        const actualCollectionId = this._stripRegistryPrefix(collectionId);
        const response = await fetch('/api/plugins/similharity/chunks/purge', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                backend: BACKEND_TYPE,
                collectionId: actualCollectionId, // Use separate collection per content type
                source: settings.source || 'transformers',
                model: getModelFromSettings(settings),
            }),
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`[Qdrant] Failed to purge collection ${collectionId}: ${response.status} ${response.statusText} - ${errorBody}`);
        }

         console.log(`VectHare Qdrant: Purged (type: ${type}, sourceId: ${sourceId})`);
    }

    async purgeFileVectorIndex(collectionId, settings) {
        return this.purgeVectorIndex(collectionId, settings);
    }

    async purgeAllVectorIndexes(settings) {
        // Note: With separate collections per content type, we need to purge each collection individually
        console.warn('VectHare: purgeAllVectorIndexes now requires calling purgeVectorIndex for each collection');
        throw new Error('purgeAllVectorIndexes requires collection IDs - call purgeVectorIndex for each collection instead');
    }

    // ========================================================================
    // EXTENDED API METHODS (for UI components)
    // ========================================================================

    /**
     * Get a single chunk by hash
     */
    async getChunk(collectionId, hash, settings) {
        const actualCollectionId = this._stripRegistryPrefix(collectionId);
        const response = await fetch(`/api/plugins/similharity/chunks/${encodeURIComponent(hash)}?` + new URLSearchParams({
            backend: BACKEND_TYPE,
            collectionId: actualCollectionId, // Use separate collection per content type
            source: settings.source || 'transformers',
            model: getModelFromSettings(settings),
        }), {
            headers: getRequestHeaders(),
        });

        if (!response.ok) {
            if (response.status === 404) return null;
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`[Qdrant] Failed to get chunk ${hash} from ${collectionId}: ${response.status} ${response.statusText} - ${errorBody}`);
        }

        const data = await response.json();
        return data.chunk;
    }

    /**
     * List chunks with pagination
     */
    async listChunks(collectionId, settings, options = {}) {
        const actualCollectionId = this._stripRegistryPrefix(collectionId);
        const response = await fetch('/api/plugins/similharity/chunks/list', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                backend: BACKEND_TYPE,
                collectionId: actualCollectionId, // Use separate collection per content type
                source: settings.source || 'transformers',
                model: getModelFromSettings(settings),
                offset: options.offset || 0,
                limit: options.limit || 100,
                includeVectors: options.includeVectors || false,
            }),
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`[Qdrant] Failed to list chunks in ${collectionId}: ${response.status} ${response.statusText} - ${errorBody}`);
        }

        return await response.json();
    }

    /**
     * Update chunk text (triggers re-embedding)
     */
    async updateChunkText(collectionId, hash, newText, settings) {
        const actualCollectionId = this._stripRegistryPrefix(collectionId);
        const response = await fetch(`/api/plugins/similharity/chunks/${encodeURIComponent(hash)}/text`, {
            method: 'PATCH',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                backend: BACKEND_TYPE,
                collectionId: actualCollectionId, // Use separate collection per content type
                text: newText,
                source: settings.source || 'transformers',
                model: getModelFromSettings(settings),
            }),
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`[Qdrant] Failed to update chunk text in ${collectionId} (hash: ${hash}): ${response.status} ${response.statusText} - ${errorBody}`);
        }

        return await response.json();
    }

    /**
     * Update chunk metadata (no re-embedding)
     */
    async updateChunkMetadata(collectionId, hash, metadata, settings) {
        const actualCollectionId = this._stripRegistryPrefix(collectionId);
        const response = await fetch(`/api/plugins/similharity/chunks/${encodeURIComponent(hash)}/metadata`, {
            method: 'PATCH',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                backend: BACKEND_TYPE,
                collectionId: actualCollectionId, // Use separate collection per content type
                metadata: metadata,
                source: settings.source || 'transformers',
                model: getModelFromSettings(settings),
            }),
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`[Qdrant] Failed to update chunk metadata in ${collectionId} (hash: ${hash}): ${response.status} ${response.statusText} - ${errorBody}`);
        }

        return await response.json();
    }

    /**
     * Get collection statistics
     */
    async getStats(collectionId, settings) {
        const actualCollectionId = this._stripRegistryPrefix(collectionId);
        const response = await fetch('/api/plugins/similharity/chunks/stats', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                backend: BACKEND_TYPE,
                collectionId: actualCollectionId, // Use separate collection per content type
                source: settings.source || 'transformers',
                model: getModelFromSettings(settings),
            }),
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`[Qdrant] Failed to get stats for ${collectionId}: ${response.status} ${response.statusText} - ${errorBody}`);
        }

        const data = await response.json();
        return data.stats;
    }

    // ========================================================================
    // HYBRID SEARCH METHODS
    // ========================================================================

    /**
     * Check if this backend supports native hybrid search.
     * Qdrant supports sparse vectors for hybrid search via the Similharity plugin.
     * @returns {boolean}
     */
    supportsHybridSearch() {
        return true;
    }

    /**
     * Perform hybrid search using Qdrant's sparse + dense vector capabilities.
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

        const strippedCollectionId = this._stripRegistryPrefix(collectionId);
        const actualCollectionId = getActualCollectionId(strippedCollectionId, settings);

        const body = {
            backend: BACKEND_TYPE,
            collectionId: actualCollectionId,
            searchText: searchText,
            topK: topK,
            threshold: 0.0,
            source: settings.source || 'transformers',
            model: getModelFromSettings(settings),
            // Hybrid-specific parameters
            hybrid: true,
            hybridOptions: {
                vectorWeight,
                textWeight,
                fusionMethod,
                rrfK
            }
        };

        // Add content_type filter for multitenancy mode
        if (settings.qdrant_multitenancy) {
            body.filter = {
                must: [
                    { key: 'content_type', match: { value: strippedCollectionId } }
                ]
            };
        }

        try {
            // Try the hybrid endpoint first
            const response = await fetch('/api/plugins/similharity/chunks/hybrid-query', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify(body),
            });

            if (response.ok) {
                const data = await response.json();
                console.log(`[Qdrant] Native hybrid search returned ${data.results?.length || 0} results`);

                return {
                    hashes: data.results.map(r => r.hash),
                    metadata: data.results.map(r => ({
                        hash: r.hash,
                        text: r.text,
                        score: r.score,
                        vectorScore: r.vectorScore || r.debug?.vectorScore,
                        textScore: r.textScore || r.debug?.keywordScore,
                        fusionMethod: r.debug?.fusionMethod || fusionMethod,
                        hybridSearch: true,
                        vectorRank: r.debug?.vectorRank,
                        keywordRank: r.debug?.keywordRank,
                        matchedKeywords: r.debug?.matchedKeywords,
                        ...r.metadata,
                    }))
                };
            }

            // If hybrid endpoint returns 404 or similar, fall back
            console.warn(`[Qdrant] Hybrid endpoint not available (${response.status}), falling back to vector-only search`);
        } catch (error) {
            console.warn(`[Qdrant] Hybrid search failed:`, error.message);
        }

        // Fallback to regular vector search
        return this.queryCollection(collectionId, searchText, topK, settings);
    }
}
