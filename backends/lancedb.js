/**
 * ============================================================================
 * LANCEDB BACKEND (via Unified Plugin API)
 * ============================================================================
 * Uses the Similharity plugin's unified /chunks/* endpoints.
 * Backend: LanceDB (disk-based columnar storage)
 *
 * Provides disk-based, scalable vector storage for large collections.
 * Requires the VectHare plugin to be installed.
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

const BACKEND_TYPE = 'lancedb';

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

export class LanceDBBackend extends VectorBackend {
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
            'vllm', 'koboldcpp', 'webllm', 'bananabread', 'openrouter', 'togetherai', 'mistral'];

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

    async initialize(settings) {
        // Initialize LanceDB backend via plugin
        const response = await fetch('/api/plugins/similharity/backend/init/lancedb', {
            method: 'POST',
            headers: getRequestHeaders(),
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`Failed to initialize LanceDB: ${response.status} ${response.statusText} - ${errorBody}`);
        }

        console.log('VectHare: Using LanceDB backend (disk-based, scalable)');
    }

    async healthCheck() {
        try {
            const response = await fetch('/api/plugins/similharity/backend/health/lancedb', {
                headers: getRequestHeaders(),
            });

            if (!response.ok) return false;

            const data = await response.json();
            return data.healthy === true;
        } catch (error) {
            console.error('[LanceDB] Health check failed:', error);
            return false;
        }
    }

    async getSavedHashes(collectionId, settings) {
        const actualCollectionId = this._stripRegistryPrefix(collectionId);
        const response = await fetch('/api/plugins/similharity/chunks/list', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                backend: BACKEND_TYPE,
                collectionId: actualCollectionId,
                source: settings.source || 'transformers',
                model: getModelFromSettings(settings),
                limit: VECTOR_LIST_LIMIT, // Get all for hash comparison
            }),
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`[LanceDB] Failed to get saved hashes for ${collectionId}: ${response.status} ${response.statusText} - ${errorBody}`);
        }

        const data = await response.json();
        return data.items ? data.items.map(item => item.hash) : [];
    }

    async insertVectorItems(collectionId, items, settings) {
        if (items.length === 0) return;

        const actualCollectionId = this._stripRegistryPrefix(collectionId);
        const response = await fetch('/api/plugins/similharity/chunks/insert', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                backend: BACKEND_TYPE,
                collectionId: actualCollectionId,
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
                    } || {},
                })),
                source: settings.source || 'transformers',
                model: getModelFromSettings(settings),
                ...getPluginProviderParams(settings),
            }),
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`[LanceDB] Failed to insert ${items.length} vectors into ${collectionId}: ${response.status} ${response.statusText} - ${errorBody}`);
        }

        console.log(`VectHare LanceDB: Inserted ${items.length} vectors into ${collectionId}`);
    }

    async deleteVectorItems(collectionId, hashes, settings) {
        const actualCollectionId = this._stripRegistryPrefix(collectionId);
        const response = await fetch('/api/plugins/similharity/chunks/delete', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                backend: BACKEND_TYPE,
                collectionId: actualCollectionId,
                hashes: hashes,
                source: settings.source || 'transformers',
                model: getModelFromSettings(settings),
            }),
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`[LanceDB] Failed to delete vectors from ${collectionId}: ${response.status} ${response.statusText} - ${errorBody}`);
        }
    }

    async queryCollection(collectionId, searchText, topK, settings) {
        const actualCollectionId = this._stripRegistryPrefix(collectionId);
        console.log(`[LanceDB] queryCollection: original=${collectionId}, stripped=${actualCollectionId}`);
        const response = await fetch('/api/plugins/similharity/chunks/query', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                backend: BACKEND_TYPE,
                collectionId: actualCollectionId,
                searchText: searchText,
                topK: topK,
                threshold: 0.0,
                source: settings.source || 'transformers',
                model: getModelFromSettings(settings),
                ...getPluginProviderParams(settings),
            }),
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`[LanceDB] Failed to query collection ${collectionId}: ${response.status} ${response.statusText} - ${errorBody}`);
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
        // Query each collection separately
        const results = {};

        for (const collectionId of collectionIds) {
            const actualCollectionId = this._stripRegistryPrefix(collectionId);
            try {
                const response = await fetch('/api/plugins/similharity/chunks/query', {
                    method: 'POST',
                    headers: getRequestHeaders(),
                    body: JSON.stringify({
                        backend: BACKEND_TYPE,
                        collectionId: actualCollectionId,
                        searchText: searchText,
                        topK: topK,
                        threshold: threshold,
                        source: settings.source || 'transformers',
                        model: getModelFromSettings(settings),
                        ...getPluginProviderParams(settings),
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
        const actualCollectionId = this._stripRegistryPrefix(collectionId);
        const response = await fetch('/api/plugins/similharity/chunks/purge', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                backend: BACKEND_TYPE,
                collectionId: actualCollectionId,
                source: settings.source || 'transformers',
                model: getModelFromSettings(settings),
            }),
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`[LanceDB] Failed to purge collection ${collectionId}: ${response.status} ${response.statusText} - ${errorBody}`);
        }
    }

    async purgeFileVectorIndex(collectionId, settings) {
        return this.purgeVectorIndex(collectionId, settings);
    }

    async purgeAllVectorIndexes(settings) {
        // Get all collections and purge ALL of them - no filtering
        const response = await fetch('/api/plugins/similharity/collections', {
            headers: getRequestHeaders(),
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`[LanceDB] Failed to get collections: ${response.status} ${response.statusText} - ${errorBody}`);
        }

        const data = await response.json();

        // Purge ALL collections - don't filter by backend
        for (const collection of data.collections || []) {
            try {
                await this.purgeVectorIndex(collection.id, {
                    ...settings,
                    source: collection.source,
                });
            } catch (e) {
                console.error(`Failed to purge ${collection.id}:`, e);
            }
        }
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
            collectionId: actualCollectionId,
            source: settings.source || 'transformers',
                model: getModelFromSettings(settings),
        }), {
            headers: getRequestHeaders(),
        });

        if (!response.ok) {
            if (response.status === 404) return null;
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`[LanceDB] Failed to get chunk ${hash} from ${collectionId}: ${response.status} ${response.statusText} - ${errorBody}`);
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
                collectionId: actualCollectionId,
                source: settings.source || 'transformers',
                model: getModelFromSettings(settings),
                offset: options.offset || 0,
                limit: options.limit || 100,
                includeVectors: options.includeVectors || false,
            }),
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`[LanceDB] Failed to list chunks in ${collectionId}: ${response.status} ${response.statusText} - ${errorBody}`);
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
                collectionId: actualCollectionId,
                text: newText,
                source: settings.source || 'transformers',
                model: getModelFromSettings(settings),
            }),
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`[LanceDB] Failed to update chunk text in ${collectionId}: ${response.status} ${response.statusText} - ${errorBody}`);
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
                collectionId: actualCollectionId,
                metadata: metadata,
                source: settings.source || 'transformers',
                model: getModelFromSettings(settings),
            }),
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`[LanceDB] Failed to update chunk metadata in ${collectionId}: ${response.status} ${response.statusText} - ${errorBody}`);
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
                collectionId: actualCollectionId,
                source: settings.source || 'transformers',
                model: getModelFromSettings(settings),
            }),
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`[LanceDB] Failed to get stats for ${collectionId}: ${response.status} ${response.statusText} - ${errorBody}`);
        }

        const data = await response.json();
        return data.stats;
    }
}
