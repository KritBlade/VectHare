/**
 * ============================================================================
 * QDRANT BACKEND (DIRECT REST API)
 * ============================================================================
 * Server-side Qdrant vector database operations using direct REST API calls.
 * Uses ONE main collection with payload filters for different data types.
 *
 * Why Direct REST instead of SDK?
 * - More transparent error handling
 * - Works better with various Qdrant setups
 * - Explicit control over headers and requests
 * - Better debugging capabilities
 *
 * Note: Qdrant Cloud may have CORS issues when accessed from browser.
 * This backend runs server-side so CORS is not an issue here.
 *
 * Multitenancy Strategy:
 * - ONE collection: "vecthare_main"
 * - Payload fields: type, sourceId, timestamp, etc.
 * - Filters for isolation: {type: "chat", sourceId: "chat_001"}
 *
 * @author VectHare
 * @version 3.0.0
 * ============================================================================
 */

/**
 * Qdrant Backend Manager
 * Manages Qdrant REST API connection and operations
 */
class QdrantBackend {
    constructor() {
        this.baseUrl = null;
        this.apiKey = null;
        this.config = {
            host: '127.0.0.1',
            port: 6333,
            url: null,
            apiKey: null,
        };
    }

    /**
     * Parse collection name to handle both old (source:id) and new (backend:source:id) formats
     * @param {string} collectionName - Collection name in format "qdrant:source:id" or "source:id"
     * @returns {string} - Actual collection name (source:id)
     */
    _parseCollectionName(collectionName) {
        if (!collectionName) return collectionName;

        // New format: backend:source:id (e.g., "qdrant:bananabread:chat_123")
        // Old format: source:id (e.g., "bananabread:chat_123")
        if (collectionName.startsWith('qdrant:')) {
            // Strip "qdrant:" prefix to get "source:id"
            return collectionName.substring(7); // 'qdrant:'.length === 7
        }
        // Now strip the source prefix if present
        if (collectionName.indexOf(':') !== -1) {
            collectionName = collectionName.split(':')[1];
        }

        // Already in correct format or old format
        return collectionName;
    }

    /**
     * Build headers for Qdrant API requests
     */
    _getHeaders() {
        const headers = {
            'Content-Type': 'application/json',
        };
        if (this.apiKey) {
            headers['api-key'] = this.apiKey;
        }
        return headers;
    }

    /**
     * Make a request to Qdrant API with retry logic
     * @param {string} method - HTTP method
     * @param {string} endpoint - API endpoint
     * @param {object|null} body - Request body
     * @param {number} maxRetries - Maximum retry attempts for transient failures
     */
    async _request(method, endpoint, body = null, maxRetries = 3) {
        const url = `${this.baseUrl}${endpoint}`;

        // Add explicit timeout of 60s to prevent indefinite hangs during heavy operations (like wait=true)
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 60000);

        const options = {
            method,
            headers: this._getHeaders(),
            signal: controller.signal,
        };
        if (body) {
            options.body = JSON.stringify(body);
        }

        let lastError;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                const response = await fetch(url, options);
                clearTimeout(timeoutId);

                if (!response.ok) {
                    const errorText = await response.text();
                    let errorMessage;
                    try {
                        const errorJson = JSON.parse(errorText);
                        errorMessage = errorJson.status?.error || errorJson.message || errorText;
                    } catch {
                        errorMessage = errorText;
                    }

                    // Check if error is retryable (5xx errors, 429 rate limit)
                    const isRetryable = response.status >= 500 || response.status === 429;
                    if (isRetryable && attempt < maxRetries) {
                        const delay = Math.min(1000 * Math.pow(2, attempt), 10000); // Exponential backoff, max 10s
                        console.warn(`[Qdrant] ${method} ${endpoint} failed (${response.status}), retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`);
                        await new Promise(resolve => setTimeout(resolve, delay));
                        continue;
                    }

                    throw new Error(`Qdrant ${method} ${endpoint} failed: ${response.status} ${errorMessage}`);
                }

                // Some endpoints return empty response
                const text = await response.text();
                return text ? JSON.parse(text) : null;

            } catch (error) {
                lastError = error;

                // Network errors (ECONNREFUSED, timeout, etc.) are retryable
                const isNetworkError = error.name === 'TypeError' ||
                    error.name === 'AbortError' ||
                    error.message?.includes('fetch failed') ||
                    error.message?.includes('ECONNREFUSED') ||
                    error.message?.includes('ETIMEDOUT');

                if (isNetworkError && attempt < maxRetries) {
                    const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
                    console.warn(`[Qdrant] Network error, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries}): ${error.message}${error.cause ? ` (Cause: ${error.cause})` : ''}`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    continue;
                }

                throw error;
            } finally {
                // Ensure timeout is cleared on success or error thrown
                clearTimeout(timeoutId);
            }
        }

        throw lastError;
    }

    /**
     * Initialize Qdrant connection
     * @param {object} config - Configuration { host, port, url, apiKey }
     */
    async initialize(config = {}) {
        // Merge config
        this.config = { ...this.config, ...config };
        this.apiKey = this.config.apiKey || null;

        // Build base URL
        if (this.config.url) {
            // Cloud or custom URL - remove trailing slash
            this.baseUrl = this.config.url.replace(/\/+$/, '');
        } else {
            // Local instance
            this.baseUrl = `http://${this.config.host}:${this.config.port}`;
        }

        console.log('[Qdrant] Initializing with URL:', this.baseUrl);
        console.log('[Qdrant] API Key:', this.apiKey ? '(set)' : '(not set)');

        // Test connection
        try {
            await this._request('GET', '/collections');
            console.log('[Qdrant] Connection successful');
        } catch (error) {
            console.error('[Qdrant] Connection failed:', error.message);
            throw error;
        }

        // Ensure indexes exist on any existing vecthare_main collection
        await this.ensurePayloadIndexes('vecthare_main');
        const collections = await this.getCollections();
        for (const collectionName of collections || []) {
            await this.ensurePayloadIndexes(collectionName);
        }
    }

    /**
     * Health check
     * @returns {Promise<boolean>}
     */
    async healthCheck() {
        try {
            if (!this.baseUrl) return false;
            await this._request('GET', '/collections');
            return true;
        } catch (error) {
            console.error('[Qdrant] Health check failed:', error.message);
            return false;
        }
    }

    /**
     * Ensure collection exists with proper schema and payload indexes
     * @param {string} collectionName - Collection name
     * @param {number} vectorSize - Vector dimension (e.g., 768)
     * @param {object} [opts]
     * @param {boolean} [opts.nativeSparse=false] - Declare a `text_sparse` named sparse vector with `modifier: "idf"` for native BM25
     */
    async ensureCollection(collectionName, vectorSize = 768, opts = {}) {
        const { nativeSparse = false } = opts;
        try {
            // Check if collection exists
            const collections = await this._request('GET', '/collections');
            collectionName = this._parseCollectionName(collectionName);
            const exists = collections.result?.collections?.some(c => c.name === collectionName);
            if (!exists) {
                // Create collection
                const body = {
                    vectors: {
                        size: vectorSize,
                        distance: 'Cosine',
                    },
                };
                if (nativeSparse) {
                    // Qdrant 1.10+: declare a named sparse vector with IDF modifier so BM25 is
                    // computed server-side over the true global corpus. Index params left as
                    // defaults — Qdrant uses on-disk by default for sparse.
                    body.sparse_vectors = {
                        text_sparse: { modifier: 'idf' },
                    };
                }
                await this._request('PUT', `/collections/${collectionName}`, body);
                console.log(`[Qdrant] Created collection: ${collectionName} (dim=${vectorSize}${nativeSparse ? ', +text_sparse[idf]' : ''})`);

                // Create payload indexes for filterable fields
                await this.createPayloadIndexes(collectionName);
            }
        } catch (error) {
            console.error(`[Qdrant] Failed to ensure collection ${collectionName}:`, error.message);
            throw error;
        }
    }

    /**
     * Create payload indexes for filterable fields
     * @param {string} collectionName - Collection name
     */
    async createPayloadIndexes(collectionName) {
        collectionName = this._parseCollectionName(collectionName);
        // Fields that need indexes for filtering
        // Tenant fields use { type: 'keyword', is_tenant: true } for optimized multitenancy
        // Regular fields use simple type string
        const indexConfigs = [
            // TENANT FIELDS (is_tenant: true for optimized multitenancy)
            { field: 'type', schema: { type: 'keyword', is_tenant: true } },
            { field: 'sourceId', schema: { type: 'keyword', is_tenant: true } },
            // REGULAR KEYWORD FIELDS
            { field: 'embeddingSource', schema: 'keyword' },
            { field: 'embeddingModel', schema: 'keyword' },
            { field: 'characterName', schema: 'keyword' },
            { field: 'chatId', schema: 'keyword' },
            { field: 'keywords', schema: 'keyword' },
            // TEXT FIELDS (for full-text search)
            { field: 'text', schema: 'text' },
            // INTEGER FIELDS
            { field: 'hash', schema: 'integer' },
            { field: 'timestamp', schema: 'integer' },
            { field: 'importance', schema: 'integer' },
        ];

        for (const { field, schema } of indexConfigs) {
            try {
                await this._request('PUT', `/collections/${collectionName}/index`, {
                    field_name: field,
                    field_schema: schema,
                });
                const schemaType = typeof schema === 'object' ? `${schema.type}${schema.is_tenant ? ' (tenant)' : ''}` : schema;
                console.log(`[Qdrant] Created index for ${field} (${schemaType})`);
            } catch (error) {
                // Index might already exist, that's fine
                if (!error.message?.includes('already exists') && !error.message?.includes('409')) {
                    console.warn(`[Qdrant] Failed to create index for ${field}:`, error.message);
                }
            }
        }
    }

    /**
     * Sentinel point ID used to store per-collection VectHare metadata
     * (e.g. the CJK tokenizer mode this collection was built with).
     * Uses a fixed UUID so it never collides with hash-derived integer IDs.
     */
    _SENTINEL_ID = '00000000-0000-0000-0000-0000feedf00d';

    /**
     * Read VectHare's sentinel metadata point for a collection. Returns null when
     * the collection or the sentinel point is missing.
     *
     * @param {string} collectionName
     * @returns {Promise<object|null>}
     */
    async getCollectionMetadata(collectionName) {
        collectionName = this._parseCollectionName(collectionName);
        try {
            const resp = await this._request('POST', `/collections/${collectionName}/points`, {
                ids: [this._SENTINEL_ID],
                with_payload: true,
                with_vector: false,
            });
            const point = resp.result?.[0];
            if (!point) return null;
            return point.payload || null;
        } catch (error) {
            console.debug(`[Qdrant] getCollectionMetadata(${collectionName}) failed:`, error.message);
            return null;
        }
    }

    /**
     * Write VectHare's sentinel metadata point. Creates or overwrites the
     * sentinel; uses a zero dense vector so the point exists but won't surface
     * in any normal vector search (also filtered out by the `type` payload).
     *
     * @param {string} collectionName
     * @param {object} metadata - free-form, must serialise cleanly
     * @param {number} vectorSize - dimension of the dense vector slot
     */
    async setCollectionMetadata(collectionName, metadata, vectorSize) {
        collectionName = this._parseCollectionName(collectionName);
        const zero = new Array(vectorSize).fill(0);
        const payload = {
            ...metadata,
            type: '_vecthare_meta',
            _vecthare_sentinel: true,
            updated_at: Date.now(),
        };
        // Inspect the collection so we know whether it has named sparse vectors;
        // if so the sentinel needs the object-form vector slot.
        let usesNamedVectors = false;
        try {
            const info = await this._request('GET', `/collections/${collectionName}`);
            usesNamedVectors = !!info.result?.config?.params?.sparse_vectors;
        } catch (e) { /* assume plain */ }

        const point = {
            id: this._SENTINEL_ID,
            vector: usesNamedVectors ? { '': zero } : zero,
            payload,
        };
        await this._request('PUT', `/collections/${collectionName}/points?wait=true`, {
            points: [point],
        });
        console.log(`[Qdrant] Wrote sentinel for ${collectionName}:`, metadata);
    }

    /**
     * Ensure payload indexes exist on an existing collection
     * @param {string} collectionName - Collection name
     */
    async ensurePayloadIndexes(collectionName) {
        try {
            const collections = await this._request('GET', '/collections');
            const exists = collections.result?.collections?.some(c => c.name === collectionName);
            if (exists) {
                await this.createPayloadIndexes(collectionName);
                console.log(`[Qdrant] Ensured payload indexes for ${collectionName}`);
            }
        } catch (error) {
            console.error(`[Qdrant] Failed to ensure indexes for ${collectionName}:`, error.message);
        }
    }

    /**
     * Insert vector items into collection (MULTITENANCY)
     * @param {string} collectionName - Collection name (always "vecthare_main")
     * @param {Array} items - Items with {hash, text, vector, sparseVector?, metadata}
     * @param {object} tenantMetadata - Tenant info {type, sourceId, embeddingSource}
     * @param {object} [opts]
     * @param {boolean} [opts.nativeSparse=false] - Use named-vector point shape and ship `item.sparseVector` to Qdrant's `text_sparse` field
     * @returns {Promise<void>}
     */
    async insertVectors(collectionName, items, tenantMetadata = {}, opts = {}) {
        const { nativeSparse = false, cjkTokenizerMode = null } = opts;
        if (!this.baseUrl) throw new Error('Qdrant not initialized');
        if (items.length === 0) return;

        // MULTITENANCY: Always use vecthare_main collection
        collectionName = this._parseCollectionName(collectionName);
        const mainCollection = collectionName;

        // Validate all items have vectors
        const missingVectors = items.filter(item => !item.vector || !Array.isArray(item.vector));
        if (missingVectors.length > 0) {
            throw new Error(`[Qdrant] ${missingVectors.length} items are missing vectors. Hashes: ${missingVectors.slice(0, 5).map(i => i.hash).join(', ')}${missingVectors.length > 5 ? '...' : ''}`);
        }

        // Get expected dimension from first vector
        const expectedDimension = items[0].vector.length;
        if (expectedDimension === 0) {
            throw new Error('[Qdrant] First item has empty vector (dimension 0)');
        }

        // Validate all vectors have the same dimension
        const mismatchedItems = items.filter(item => item.vector.length !== expectedDimension);
        if (mismatchedItems.length > 0) {
            const examples = mismatchedItems.slice(0, 3).map(i => `hash ${i.hash}: ${i.vector.length}`).join(', ');
            throw new Error(`[Qdrant] Vector dimension mismatch. Expected ${expectedDimension}, but found: ${examples}${mismatchedItems.length > 3 ? '...' : ''} (${mismatchedItems.length} total mismatches)`);
        }

        // Check if collection exists and validate dimension matches
        try {
            const collections = await this._request('GET', '/collections');
            const exists = collections.result?.collections?.some(c => c.name === mainCollection);

            if (exists) {
                const collectionInfo = await this._request('GET', `/collections/${mainCollection}`);
                const existingDimension = collectionInfo.result?.config?.params?.vectors?.size;

                if (existingDimension && existingDimension !== expectedDimension) {
                    console.warn(`[Qdrant] Vector dimension mismatch. Collection has ${existingDimension} dimensions, but insert requires ${expectedDimension}. Dropping collection to recreate...`);
                    await this.purgeAll();
                    // Wait slightly for deletion to propagate (optional but safe)
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
            }
        } catch (error) {
             console.debug('[Qdrant] Could not check existing collection dimension:', error.message);
        }

        // Ensure collection exists (use first vector's size)
        const vectorSize = expectedDimension;
        await this.ensureCollection(mainCollection, vectorSize, { nativeSparse });

        // Sentinel handling: when native sparse is enabled, the CJK tokenizer mode is baked
        // into the indexed sparse vectors. Write the sentinel on first insert; verify it
        // matches on subsequent inserts so a mid-stream mode change is caught early.
        if (nativeSparse && cjkTokenizerMode) {
            try {
                const existing = await this.getCollectionMetadata(mainCollection);
                if (!existing || !existing.cjk_tokenizer_mode) {
                    await this.setCollectionMetadata(mainCollection, {
                        cjk_tokenizer_mode: cjkTokenizerMode,
                    }, vectorSize);
                } else if (existing.cjk_tokenizer_mode !== cjkTokenizerMode) {
                    throw new Error(
                        `[Qdrant] Tokenizer mode mismatch: collection "${mainCollection}" was built with "${existing.cjk_tokenizer_mode}" but insert is using "${cjkTokenizerMode}". ` +
                        `Delete the collection and re-vectorize to switch tokenizer modes.`
                    );
                }
            } catch (error) {
                if (error.message?.includes('Tokenizer mode mismatch')) throw error;
                console.warn(`[Qdrant] Sentinel read/write failed for ${mainCollection}:`, error.message);
            }
        }

        // Format points for Qdrant with multitenancy payload
        // NOTE: Spread item.metadata FIRST so critical fields can override it
        // IMPORTANT: Ensure hash is a number - Qdrant accepts unsigned integers or UUID strings,
        // but NOT numeric strings like "977206". JSON parsing from HTTP requests can sometimes
        // convert numbers to strings, so we explicitly coerce here.
        const points = items.map(item => ({
            id: typeof item.hash === 'string' ? parseInt(item.hash, 10) : item.hash, // Ensure numeric ID for Qdrant
            // When the collection has a named sparse vector, Qdrant requires the point's vector
            // field to be an object keyed by vector name. Default dense vector is keyed by "".
            // Without sparse, keep the plain-array form so we don't break existing collections.
            vector: nativeSparse && item.sparseVector
                ? { '': item.vector, text_sparse: item.sparseVector }
                : item.vector,
            payload: {
                // ===== SPREAD ADDITIONAL METADATA FIRST (so it can be overridden) =====
                ...(item.metadata || {}),

                // ===== CORE FIELDS (override metadata) =====
                text: item.text,
                hash: typeof item.hash === 'string' ? parseInt(item.hash, 10) : item.hash, // Keep consistent with ID

                // ===== MULTITENANCY FIELDS (CRITICAL - must not be overwritten) =====
                type: tenantMetadata.type || 'chat',
                sourceId: tenantMetadata.sourceId || 'unknown',
                embeddingSource: tenantMetadata.embeddingSource || 'transformers',
                embeddingModel: tenantMetadata.embeddingModel || '',

                // ===== TIMESTAMPS (for temporal decay) =====
                timestamp: item.metadata?.timestamp || Date.now(),
                // messageIndex carries the chat message number for ordering in the visualizer.
                // Both ingestion paths set top-level item.index (legacy chat: batch[0].index;
                // EventBase: source_window_start + 1) — persist it here so the field is queryable.
                messageIndex: item.index ?? item.metadata?.messageIndex ?? null,

                // ===== LEGACY VECTHARE FEATURES =====
                // Fall back to item.metadata.* when the top-level field is undefined.
                // EventBase items store importance inside metadata only; legacy chunk
                // items set it at the top level. EventBase summary is no longer stored —
                // it lives inside `text` and is parsed back at injection time.
                // Scene chunks DO store summary (user-editable search hint, not AI-derived).
                importance: item.importance !== undefined ? item.importance : (item.metadata?.importance ?? 100),
                keywords: item.keywords || item.metadata?.keywords || [],
                customWeights: item.customWeights || item.metadata?.customWeights || {},
                disabledKeywords: item.disabledKeywords || item.metadata?.disabledKeywords || [],
                chunkGroup: item.chunkGroup !== undefined ? item.chunkGroup : (item.metadata?.chunkGroup ?? null),
                conditions: item.conditions !== undefined ? item.conditions : (item.metadata?.conditions ?? null),
                isSummaryChunk: item.isSummaryChunk !== undefined ? item.isSummaryChunk : (item.metadata?.isSummaryChunk ?? false),
                parentHash: item.parentHash !== undefined ? item.parentHash : (item.metadata?.parentHash ?? null),

                // ===== CHAT-SPECIFIC =====
                speaker: item.metadata?.speaker,
                summary: item.metadata?.summary ?? null,
                sceneTitle: item.metadata?.sceneTitle,
                sceneIndex: item.metadata?.sceneIndex,
                sceneStart: item.metadata?.sceneStart,
                sceneEnd: item.metadata?.sceneEnd,

                // ===== LOREBOOK-SPECIFIC =====
                entryName: item.metadata?.entryName,
                lorebookId: item.metadata?.lorebookId,

                // ===== CHARACTER-SPECIFIC =====
                characterName: item.metadata?.characterName,
                fieldName: item.metadata?.fieldName,

                // ===== DOCUMENT-SPECIFIC =====
                documentName: item.metadata?.documentName,
                url: item.metadata?.url,
                scrapeDate: item.metadata?.scrapeDate,
            },
        }));

        // Upsert points (PUT with wait=true for reliability)
        await this._request('PUT', `/collections/${mainCollection}/points?wait=true`, {
            points: points,
        });

        console.log(`[Qdrant] Inserted ${items.length} vectors into ${mainCollection} (type: ${tenantMetadata.type}, sourceId: ${tenantMetadata.sourceId})`);
    }

    /**
     * Query collection for similar vectors (MULTITENANCY)
     * @param {string} collectionName - Collection name (always "vecthare_main")
     * @param {number[]} queryVector - Query vector
     * @param {number} topK - Number of results
     * @param {object} filters - Payload filters {type, sourceId, minImportance, timestampAfter, etc.}
     * @returns {Promise<Array>} Results with {hash, text, score, metadata}
     */
    async queryCollection(collectionName, queryVector, topK = 10, filters = {}) {
        if (!this.baseUrl) throw new Error('Qdrant not initialized');

        collectionName = this._parseCollectionName(collectionName);
        const mainCollection = collectionName;

        try {
            // Check if collection exists
            const collections = await this._request('GET', '/collections');
            const exists = collections.result?.collections?.some(c => c.name === mainCollection);
            if (!exists) {
                return [];
            }

            // Build filter conditions
            const must = [];

            if (filters.type) {
                must.push({
                    key: 'type',
                    match: { value: filters.type }
                });
            }

            if (filters.sourceId) {
                must.push({
                    key: 'sourceId',
                    match: { value: filters.sourceId }
                });
            }

            if (filters.minImportance !== undefined) {
                must.push({
                    key: 'importance',
                    range: { gte: filters.minImportance }
                });
            }

            if (filters.timestampAfter !== undefined) {
                must.push({
                    key: 'timestamp',
                    range: { gte: filters.timestampAfter }
                });
            }

            if (filters.characterName) {
                must.push({
                    key: 'characterName',
                    match: { value: filters.characterName }
                });
            }

            if (filters.chatId) {
                must.push({
                    key: 'chatId',
                    match: { value: filters.chatId }
                });
            }

            if (filters.chunkGroup) {
                must.push({
                    key: 'chunkGroup.name',
                    match: { value: filters.chunkGroup }
                });
            }

            if (filters.embeddingSource) {
                must.push({
                    key: 'embeddingSource',
                    match: { value: filters.embeddingSource }
                });
            }

            // Build search payload
            const searchPayload = {
                vector: queryVector,
                limit: topK,
                with_payload: true,
            };

            // Add filters if any
            if (must.length > 0) {
                searchPayload.filter = { must };
            }

            // Search
            const response = await this._request('POST', `/collections/${mainCollection}/points/search`, searchPayload);

            // Format results
            return (response.result || []).map(result => ({
                hash: result.payload.hash,
                text: result.payload.text,
                score: result.score,
                metadata: result.payload,
            }));
        } catch (error) {
            console.error(`[Qdrant] Query failed for ${mainCollection}:`, error.message);
            return [];
        }
    }


    /**
     * Build a Qdrant filter object from VectHare's filter shape. Shared by all hybrid paths.
     * Always excludes the `_vecthare_meta` sentinel point.
     * Returns `null` when there are no must clauses (only sentinel exclusion stays).
     * @private
     * @returns {object|null}
     */
    _buildHybridFilter(filters) {
        const must = [];
        const add = (key, clause) => must.push({ key, ...clause });
        if (filters.type)               add('type',            { match: { value: filters.type } });
        if (filters.sourceId)           add('sourceId',        { match: { value: filters.sourceId } });
        if (filters.minImportance !== undefined) add('importance', { range: { gte: filters.minImportance } });
        if (filters.timestampAfter !== undefined) add('timestamp', { range: { gte: filters.timestampAfter } });
        if (filters.characterName)      add('characterName',   { match: { value: filters.characterName } });
        if (filters.chatId)             add('chatId',          { match: { value: filters.chatId } });
        if (filters.chunkGroup)         add('chunkGroup.name', { match: { value: filters.chunkGroup } });
        if (filters.embeddingSource)    add('embeddingSource', { match: { value: filters.embeddingSource } });
        if (filters.content_type)       add('content_type',    { match: { value: filters.content_type } });
        // Always exclude the sentinel metadata point.
        const must_not = [{ key: 'type', match: { value: '_vecthare_meta' } }];

        const out = {};
        if (must.length > 0) out.must = must;
        out.must_not = must_not;
        return out;
    }

    /**
     * Native Qdrant hybrid query: single /query call with prefetch on dense + sparse, fused
     * server-side via RRF (or DBSF). Returns the final ranked list.
     *
     * Requires:
     *   - Qdrant 1.10+
     *   - Collection created with `sparse_vectors: { text_sparse: { modifier: 'idf' } }`
     *   - Sparse query vector tokenized with the same CJK mode used at ingest
     *
     * @param {string} collectionName
     * @param {number[]} denseVector
     * @param {{indices:number[], values:number[]}} sparseVector
     * @param {number} topK
     * @param {object} options - { fusion: 'rrf'|'dbsf' (default 'rrf'), prefetchLimit: int (default topK*4) }
     * @param {object} filters
     * @returns {Promise<Array<{hash, text, score, metadata}>>}
     */
    async hybridQueryNative(collectionName, denseVector, sparseVector, topK = 10, options = {}, filters = {}) {
        if (!this.baseUrl) throw new Error('Qdrant not initialized');
        collectionName = this._parseCollectionName(collectionName);

        const fusion = options.fusion || 'rrf';
        const prefetchLimit = options.prefetchLimit || topK * 4;
        const filter = this._buildHybridFilter(filters);

        // For the default (unnamed) dense vector Qdrant expects `using` to be OMITTED, not "".
        const densePrefetch  = { query: denseVector,  limit: prefetchLimit };
        const sparsePrefetch = { query: sparseVector, using: 'text_sparse', limit: prefetchLimit };
        if (filter) { densePrefetch.filter = filter; sparsePrefetch.filter = filter; }

        const body = {
            prefetch: [densePrefetch, sparsePrefetch],
            query: { fusion },
            limit: topK,
            with_payload: true,
        };

        let resp;
        try {
            resp = await this._request('POST', `/collections/${collectionName}/points/query`, body);
        } catch (err) {
            // Surface the full Qdrant error so the route can include it in the 500 response.
            console.error('[Qdrant] hybridQueryNative request failed. Body:', JSON.stringify(body).slice(0, 500), 'Error:', err.message);
            throw err;
        }
        const points = resp.result?.points || [];

        console.log(`[Qdrant] Native hybrid (fusion=${fusion}) returned ${points.length} results from ${collectionName}`);

        return points.map(p => ({
            hash: p.payload?.hash,
            text: p.payload?.text,
            score: p.score,
            metadata: p.payload,
            fusionMethod: fusion,
            nativeSparse: true,
        }));
    }


    /**
     * List all items in a collection (MULTITENANCY)
     * @param {string} collectionName - Collection name (always "vecthare_main")
     * @param {object} filters - Payload filters {type, sourceId}
     * @param {object} options - Options { includeVectors }
     * @returns {Promise<Array>} Array of items with {hash, text, metadata, vector?}
     */
    async listItems(collectionName, filters = {}, options = {}) {
        if (!this.baseUrl) throw new Error('Qdrant not initialized');

        // MULTITENANCY: Always use vecthare_main collection
        collectionName = this._parseCollectionName(collectionName);
        const mainCollection = collectionName;

        try {
            // Check if collection exists
            const collections = await this._request('GET', '/collections');
            const exists = collections.result?.collections?.some(c => c.name === mainCollection);
            if (!exists) {
                return [];
            }

            // Build filter conditions
            const must = [];
            if (filters.type) {
                must.push({
                    key: 'type',
                    match: { value: filters.type }
                });
            }
            if (filters.sourceId) {
                must.push({
                    key: 'sourceId',
                    match: { value: filters.sourceId }
                });
            }

            // Scroll through all points
            const items = [];
            let offset = null;

            do {
                const scrollPayload = {
                    limit: 100,
                    with_payload: true,
                    with_vector: options.includeVectors || false,
                };

                if (offset !== null) {
                    scrollPayload.offset = offset;
                }

                // Add filters if any
                if (must.length > 0) {
                    scrollPayload.filter = { must };
                }

                const response = await this._request('POST', `/collections/${mainCollection}/points/scroll`, scrollPayload);

                items.push(...(response.result?.points || []).map(p => ({
                    hash: p.payload.hash,
                    text: p.payload.text,
                    metadata: p.payload,
                    vector: options.includeVectors ? p.vector : undefined,
                })));
                offset = response.result?.next_page_offset;
            } while (offset !== null && offset !== undefined);

            console.log(">>> [Qdrant] Listed", items.length, "items from", mainCollection);
            return items;
        } catch (error) {
            console.error(`[Qdrant] Failed to list items from ${mainCollection}:`, error.message);
            return [];
        }
    }

    /**
     * Get all saved hashes from a collection (MULTITENANCY)
     * @param {string} collectionName - Collection name (always "vecthare_main")
     * @param {object} filters - Payload filters {type, sourceId}
     * @returns {Promise<number[]>} Array of hashes
     */
    async getSavedHashes(collectionName, filters = {}) {
        if (!this.baseUrl) throw new Error('Qdrant not initialized');

        collectionName = this._parseCollectionName(collectionName);
        const mainCollection = collectionName;

        try {
            // Check if collection exists
            const collections = await this._request('GET', '/collections');
            const exists = collections.result?.collections?.some(c => c.name === mainCollection);
            if (!exists) {
                return [];
            }

            // Build filter conditions
            const must = [];
            if (filters.type) {
                must.push({
                    key: 'type',
                    match: { value: filters.type }
                });
            }
            if (filters.sourceId) {
                must.push({
                    key: 'sourceId',
                    match: { value: filters.sourceId }
                });
            }

            // Scroll through all points to get hashes
            const hashes = [];
            let offset = null;

            do {
                const scrollPayload = {
                    limit: 100,
                    with_payload: { include: ['hash'] },
                    with_vector: false,
                };

                if (offset !== null) {
                    scrollPayload.offset = offset;
                }

                // Add filters if any
                if (must.length > 0) {
                    scrollPayload.filter = { must };
                }

                const response = await this._request('POST', `/collections/${mainCollection}/points/scroll`, scrollPayload);

                hashes.push(...(response.result?.points || []).map(p => p.payload.hash));
                offset = response.result?.next_page_offset;
            } while (offset !== null && offset !== undefined);

            return hashes;
        } catch (error) {
            console.error(`[Qdrant] Failed to get hashes from ${mainCollection}:`, error.message);
            return [];
        }
    }

    /**
     * Delete specific items by hash (MULTITENANCY)
     * @param {string} collectionName - Collection name (always "vecthare_main")
     * @param {number[]} hashes - Hashes to delete
     * @returns {Promise<void>}
     */
    async deleteVectors(collectionName, hashes) {
        if (!this.baseUrl) throw new Error('Qdrant not initialized');
        if (hashes.length === 0) return;

        collectionName = this._parseCollectionName(collectionName);
        const mainCollection = collectionName;

        try {
            // Delete points by ID (hash)
            // Ensure hashes are numbers - Qdrant requires unsigned integers or UUID strings
            const numericHashes = hashes.map(h => typeof h === 'string' ? parseInt(h, 10) : h);
            await this._request('POST', `/collections/${mainCollection}/points/delete?wait=true`, {
                points: numericHashes,
            });

            console.log(`[Qdrant] Deleted ${hashes.length} items from ${mainCollection}`);
        } catch (error) {
            console.error(`[Qdrant] Delete failed for ${mainCollection}:`, error.message);
        }
    }

    /**
     * Purge collection for a specific source (MULTITENANCY)
     * Deletes all points matching type and sourceId filters
     * @param {string} collectionName - Collection name (always "vecthare_main")
     * @param {object} filters - Payload filters {type, sourceId}
     * @returns {Promise<void>}
     */
    async purgeCollection(collectionName, filters = {}) {
        if (!this.baseUrl) throw new Error('Qdrant not initialized');

        collectionName = this._parseCollectionName(collectionName);
        const mainCollection = collectionName;

        try {
            // Check if collection exists
            const collections = await this._request('GET', '/collections');
            const exists = collections.result?.collections?.some(c => c.name === mainCollection);
            if (!exists) {
                return;
            }

            // Build filter conditions
            const must = [];
            if (filters.type) {
                must.push({
                    key: 'type',
                    match: { value: filters.type }
                });
            }
            if (filters.sourceId) {
                must.push({
                    key: 'sourceId',
                    match: { value: filters.sourceId }
                });
            }

            if (must.length === 0) {
                console.warn('[Qdrant] No filters provided to purgeCollection - use purgeAll() instead');
                return;
            }

            // Delete points by filter
            await this._request('POST', `/collections/${mainCollection}/points/delete?wait=true`, {
                filter: { must }
            });

            console.log(`[Qdrant] Purged ${mainCollection} (type: ${filters.type}, sourceId: ${filters.sourceId})`);
        } catch (error) {
            if (error.message?.includes('404')) {
                return;
            }
            console.error(`[Qdrant] Purge failed for ${mainCollection}:`, error.message);
            throw error;
        }
    }

    /**
     * Purge entire vecthare_main collection (MULTITENANCY)
     * WARNING: Deletes ALL data from ALL sources
     * @returns {Promise<void>}
     */
    async purgeAll(collectionName = 'vecthare_main') {
        if (!this.baseUrl) throw new Error('Qdrant not initialized');

        collectionName = this._parseCollectionName(collectionName);
        const mainCollection = collectionName;

        try {
            await this._request('DELETE', `/collections/${mainCollection}`);
            console.log(`[Qdrant] Purged entire collection: ${mainCollection}`);
        } catch (error) {
            if (error.message?.includes('404')) {
                return;
            }
            console.error(`[Qdrant] Purge all failed:`, error.message);
            throw error;
        }
    }

    // ========================================================================
    // ADDITIONAL METHODS REQUIRED BY PLUGIN ROUTER
    // ========================================================================



    async getCollections() {
        if (!this.baseUrl) throw new Error('Qdrant not initialized');
        try {
            const collections = await this._request('GET', '/collections');
            return collections.result?.collections?.map(c => c.name) || [];
        } catch (error) {
            console.error(`[Qdrant] getCollections failed:`, error.message);
            return [];
        }
    }

    /**
     * Get a single item by hash (MULTITENANCY)
     * @param {string} collectionName - Collection name (always "vecthare_main")
     * @param {number} hash - Item hash to find
     * @param {object} filters - Payload filters {type, sourceId}
     * @returns {Promise<object|null>} Item or null if not found
     */
    async getItem(collectionName, hash, filters = {}) {
        if (!this.baseUrl) throw new Error('Qdrant not initialized');

        collectionName = this._parseCollectionName(collectionName);
        const mainCollection = collectionName;
        console.log(mainCollection);
        // Ensure hash is numeric for consistent matching with stored payload
        const numericHash = typeof hash === 'string' ? parseInt(hash, 10) : hash;

        try {
            // Build filter to find specific item
            const must = [
                { key: 'hash', match: { value: numericHash } }
            ];

            if (filters.type) {
                must.push({ key: 'type', match: { value: filters.type } });
            }
            if (filters.sourceId) {
                must.push({ key: 'sourceId', match: { value: filters.sourceId } });
            }

            const response = await this._request('POST', `/collections/${mainCollection}/points/scroll`, {
                filter: { must },
                limit: 1,
                with_payload: true,
                with_vector: true,
            });

            const points = response.result?.points || [];
            if (points.length === 0) {
                return null;
            }

            const p = points[0];
            return {
                hash: p.payload.hash,
                text: p.payload.text,
                vector: p.vector,
                metadata: p.payload,
            };
        } catch (error) {
            console.error(`[Qdrant] getItem failed:`, error.message);
            return null;
        }
    }

    /**
     * Update an item (delete and re-insert with new data)
     * @param {string} collectionName - Collection name
     * @param {number} hash - Item hash to update
     * @param {object} updates - Updated fields {text?, hash?, vector?, ...metadata}
     * @param {object} filters - Multitenancy filters {type, sourceId}
     * @returns {Promise<void>}
     */
    async updateItem(collectionName, hash, updates, filters = {}) {
        if (!this.baseUrl) throw new Error('Qdrant not initialized');

        // Get existing item
        const existing = await this.getItem(collectionName, hash, filters);
        if (!existing) {
            throw new Error(`Item with hash ${hash} not found`);
        }

        // Delete old item
        await this.deleteVectors(collectionName, [hash]);

        // Merge updates with existing data
        const newHash = updates.hash || hash;
        const newItem = {
            hash: newHash,
            text: updates.text || existing.text,
            vector: updates.vector || existing.vector,
            metadata: { ...existing.metadata, ...updates },
        };

        // Insert updated item
        await this.insertVectors(collectionName, [newItem], filters);

        console.log(`[Qdrant] Updated item ${hash} -> ${newHash}`);
    }

    /**
     * Update item metadata only (no re-embedding needed)
     * @param {string} collectionName - Collection name
     * @param {number} hash - Item hash to update
     * @param {object} metadata - New metadata fields to merge
     * @param {object} filters - Multitenancy filters {type, sourceId}
     * @returns {Promise<void>}
     */
    async updateItemMetadata(collectionName, hash, metadata, filters = {}) {
        if (!this.baseUrl) throw new Error('Qdrant not initialized');

        // Get existing item (need the vector)
        const existing = await this.getItem(collectionName, hash, filters);
        if (!existing) {
            throw new Error(`Item with hash ${hash} not found`);
        }

        // Delete old item
        await this.deleteVectors(collectionName, [hash]);

        // Create updated item with same text/vector but new metadata
        const updatedItem = {
            hash: hash,
            text: existing.text,
            vector: existing.vector,
            metadata: { ...existing.metadata, ...metadata },
        };

        // Insert updated item
        await this.insertVectors(collectionName, [updatedItem], filters);

        console.log(`[Qdrant] Updated metadata for item ${hash}`);
    }

    /**
     * Query vectors with threshold filtering (alias for queryCollection)
     * @param {string} collectionName - Collection name
     * @param {number[]} queryVector - Query vector
     * @param {number} topK - Number of results
     * @param {number} threshold - Minimum score threshold
     * @param {object} filters - Payload filters
     * @returns {Promise<Array>} Results above threshold
     */
    async queryVectors(collectionName, queryVector, topK, threshold, filters = {}) {
        const results = await this.queryCollection(collectionName, queryVector, topK, filters);
        // Filter by threshold
        return results.filter(r => r.score >= threshold);
    }

    /**
     * Get collection statistics (MULTITENANCY)
     * @param {string} collectionName - Collection name
     * @param {object} filters - Payload filters {type, sourceId}
     * @returns {Promise<object>} Statistics object
     */
    async getCollectionStats(collectionName, filters = {}) {
        if (!this.baseUrl) throw new Error('Qdrant not initialized');

        collectionName = this._parseCollectionName(collectionName);
        const mainCollection = collectionName;

        try {
            // Check if collection exists
            const collections = await this._request('GET', '/collections');
            const exists = collections.result?.collections?.some(c => c.name === mainCollection);
            if (!exists) {
                return {
                    chunkCount: 0,
                    totalCharacters: 0,
                    totalTokens: 0,
                    storageSize: 0,
                    embeddingDimensions: 0,
                    avgChunkSize: 0,
                    messageCount: 0,
                    sources: {},
                    backend: 'qdrant',
                };
            }

            // Get collection info from Qdrant
            const collectionInfo = await this._request('GET', `/collections/${mainCollection}`);
            const totalPoints = collectionInfo.result?.points_count || 0;
            const vectorSize = collectionInfo.result?.config?.params?.vectors?.size || 0;

            // Get items matching filters to calculate stats
            const items = await this.listItems(collectionName, filters, { includeVectors: false });

            let totalCharacters = 0;
            let totalTokens = 0;
            const sources = {};
            const messageHashes = new Set();

            for (const item of items) {
                const text = item.text || '';
                totalCharacters += text.length;
                totalTokens += Math.ceil(text.length / 4); // Rough estimate

                const src = item.metadata?.embeddingSource || 'unknown';
                sources[src] = (sources[src] || 0) + 1;

                if (item.metadata?.originalMessageHash) {
                    messageHashes.add(item.metadata.originalMessageHash);
                }
            }

            return {
                chunkCount: items.length,
                totalPoints: totalPoints, // Total in collection (all tenants)
                totalCharacters,
                totalTokens,
                storageSize: 0, // Qdrant doesn't expose this easily
                embeddingDimensions: vectorSize,
                avgChunkSize: items.length > 0 ? Math.round(totalCharacters / items.length) : 0,
                messageCount: messageHashes.size,
                sources,
                backend: 'qdrant',
            };
        } catch (error) {
            console.error(`[Qdrant] getCollectionStats failed:`, error.message);
            return {
                chunkCount: 0,
                totalCharacters: 0,
                totalTokens: 0,
                storageSize: 0,
                embeddingDimensions: 0,
                avgChunkSize: 0,
                messageCount: 0,
                sources: {},
                backend: 'qdrant',
                error: error.message,
            };
        }
    }

    /**
     * Check if a chunk with given message IDs already exists (duplicate detection)
     * Like st-qdrant-memory's chunkExists function
     * @param {string} collectionName - Collection name
     * @param {string[]} messageIds - Array of message IDs to check
     * @param {object} filters - Multitenancy filters
     * @returns {Promise<boolean>} True if any chunk contains these message IDs
     */
    async chunkExists(collectionName, messageIds, filters = {}) {
        if (!this.baseUrl) throw new Error('Qdrant not initialized');
        if (!messageIds || messageIds.length === 0) return false;

        collectionName = this._parseCollectionName(collectionName);
        const mainCollection = collectionName;

        try {
            // Build OR conditions for message ID matching
            const should = messageIds.map(id => ({
                key: 'messageIds',
                match: { text: String(id) }
            }));

            // Also add type/sourceId filters as must conditions
            const must = [];
            if (filters.type) {
                must.push({ key: 'type', match: { value: filters.type } });
            }
            if (filters.sourceId) {
                must.push({ key: 'sourceId', match: { value: filters.sourceId } });
            }

            const filter = { should };
            if (must.length > 0) {
                filter.must = must;
            }

            const response = await this._request('POST', `/collections/${mainCollection}/points/scroll`, {
                filter,
                limit: 1,
                with_payload: false,
                with_vector: false,
            });

            return (response.result?.points?.length || 0) > 0;
        } catch (error) {
            console.error(`[Qdrant] chunkExists failed:`, error.message);
            return false;
        }
    }
}

// Export singleton instance
const qdrantBackend = new QdrantBackend();
export default qdrantBackend;
