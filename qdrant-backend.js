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
     */
    async ensureCollection(collectionName, vectorSize = 768) {
        try {
            // Check if collection exists
            const collections = await this._request('GET', '/collections');
            collectionName = this._parseCollectionName(collectionName);
            const exists = collections.result?.collections?.some(c => c.name === collectionName);
            if (!exists) {
                // Create collection
                await this._request('PUT', `/collections/${collectionName}`, {
                    vectors: {
                        size: vectorSize,
                        distance: 'Cosine',
                    },
                });
                console.log(`[Qdrant] Created collection: ${collectionName} (dim=${vectorSize})`);

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
     * @param {Array} items - Items with {hash, text, vector, metadata}
     * @param {object} tenantMetadata - Tenant info {type, sourceId, embeddingSource}
     * @returns {Promise<void>}
     */
    async insertVectors(collectionName, items, tenantMetadata = {}) {
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
        await this.ensureCollection(mainCollection, vectorSize);

        // Format points for Qdrant with multitenancy payload
        // NOTE: Spread item.metadata FIRST so critical fields can override it
        // IMPORTANT: Ensure hash is a number - Qdrant accepts unsigned integers or UUID strings,
        // but NOT numeric strings like "977206". JSON parsing from HTTP requests can sometimes
        // convert numbers to strings, so we explicitly coerce here.
        const points = items.map(item => ({
            id: typeof item.hash === 'string' ? parseInt(item.hash, 10) : item.hash, // Ensure numeric ID for Qdrant
            vector: item.vector,
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
                messageIndex: item.metadata?.messageIndex,

                // ===== LEGACY VECTHARE FEATURES =====
                // Fall back to item.metadata.* when the top-level field is undefined.
                // EventBase items store importance/summary inside metadata only;
                // legacy chunk items set them at the top level.
                importance: item.importance !== undefined ? item.importance : (item.metadata?.importance ?? 100),
                keywords: item.keywords || item.metadata?.keywords || [],
                customWeights: item.customWeights || item.metadata?.customWeights || {},
                disabledKeywords: item.disabledKeywords || item.metadata?.disabledKeywords || [],
                chunkGroup: item.chunkGroup !== undefined ? item.chunkGroup : (item.metadata?.chunkGroup ?? null),
                conditions: item.conditions !== undefined ? item.conditions : (item.metadata?.conditions ?? null),
                summary: item.summary !== undefined ? item.summary : (item.metadata?.summary ?? null),
                isSummaryChunk: item.isSummaryChunk !== undefined ? item.isSummaryChunk : (item.metadata?.isSummaryChunk ?? false),
                parentHash: item.parentHash !== undefined ? item.parentHash : (item.metadata?.parentHash ?? null),

                // ===== CHAT-SPECIFIC =====
                speaker: item.metadata?.speaker,
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
     * Native hybrid query combining vector similarity and keyword matching (QDRANT OPTIMIZED)
     * Uses Qdrant's built-in full-text search capabilities for better performance
     * @param {string} collectionName - Collection name (always "vecthare_main")
     * @param {number[]} queryVector - Query vector for semantic search
     * @param {string[]} keywords - Keywords for full-text matching (BM25-like)
     * @param {number} topK - Number of results to return
     * @param {object} options - Query options
     *   - vectorWeight: Weight for vector similarity (0-1, default: 0.5)
     *   - keywordWeight: Weight for keyword matching (0-1, default: 0.5)
     *   - fusionMethod: 'rrf' or 'weighted' (default: 'rrf')
     *   - rrfK: RRF constant (default: 60)
     *   - keywordBoost: Multiplier for keyword matches (default: 1.5)
     * @param {object} filters - Payload filters {type, sourceId, etc.}
     * @returns {Promise<Array>} Hybrid search results with {hash, text, score, metadata, debug}
     */
    async hybridQuery(collectionName, queryVector, keywords = [], topK = 10, options = {}, filters = {}) {
        if (!this.baseUrl) throw new Error('Qdrant not initialized');

        collectionName = this._parseCollectionName(collectionName);
        const mainCollection = collectionName;

        console.log(`[Qdrant] Hybrid query START: collection=${mainCollection}, keywords=${keywords.length}, topK=${topK}`);

        // Default options
        const vectorWeight = options.vectorWeight ?? 0.5;
        const keywordWeight = options.keywordWeight ?? 0.5;
        const fusionMethod = options.fusionMethod || 'rrf';
        const rrfK = options.rrfK || 60;
        const keywordBoost = options.keywordBoost || 1.5;

        console.log(`[Qdrant] Hybrid options: vectorWeight=${vectorWeight}, keywordWeight=${keywordWeight}, fusion=${fusionMethod}`);

        try {
            // Check if collection exists
            const collections = await this._request('GET', '/collections');
            const exists = collections.result?.collections?.some(c => c.name === mainCollection);
            if (!exists) {
                console.warn(`[Qdrant] Hybrid query ABORT: Collection ${mainCollection} does not exist`);
                return [];
            }

            console.log(`[Qdrant] Collection ${mainCollection} exists, proceeding with hybrid search`);

            // Build base filter conditions
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

            // ================================================================
            // STRATEGY 1: Vector Search (Semantic Similarity)
            // ================================================================
            const vectorPayload = {
                vector: queryVector,
                limit: topK * 2, // Fetch more for fusion
                with_payload: true,
                score_threshold: 0.1, // Filter very low scores
            };

            if (must.length > 0) {
                vectorPayload.filter = { must: [...must] };
            }

            const vectorResponse = await this._request('POST', `/collections/${mainCollection}/points/search`, vectorPayload);
            const vectorResults = (vectorResponse.result || []).map(result => ({
                hash: result.payload.hash,
                text: result.payload.text,
                score: result.score,
                vectorScore: result.score,
                metadata: result.payload,
            }));

            console.log(`[Qdrant] Vector search complete: ${vectorResults.length} results`);

            // ================================================================
            // STRATEGY 2: Keyword Search (Full-Text Matching)
            // ================================================================
            let keywordResults = [];

            if (keywords && keywords.length > 0) {
                console.log(`[Qdrant] Starting keyword search with ${keywords.length} keywords: ${keywords.join(', ')}`);

                // Build keyword filter using text matching on 'text' and 'keywords' payload fields
                const keywordConditions = [];

                for (const keyword of keywords) {
                    // Search in text field (full-text)
                    keywordConditions.push({
                        key: 'text',
                        match: { text: keyword }
                    });

                    // Search in keywords array field (stored keywords)
                    keywordConditions.push({
                        key: 'keywords',
                        match: { any: [keyword] }
                    });
                }

                // Scroll through points matching keyword filter
                let offset = null;
                const maxScrollIterations = 10;
                let scrollCount = 0;

                do {
                    const scrollPayload = {
                        limit: 100,
                        with_payload: true,
                        with_vector: false,
                        filter: {
                            must: [...must],
                            should: keywordConditions,
                        }
                    };

                    if (offset !== null) {
                        scrollPayload.offset = offset;
                    }

                    const scrollResponse = await this._request('POST', `/collections/${mainCollection}/points/scroll`, scrollPayload);
                    const points = scrollResponse.result?.points || [];

                    // Calculate keyword match scores for each point
                    for (const point of points) {
                        const text = (point.payload.text || '').toLowerCase();
                        const storedKeywords = (point.payload.keywords || []).map(k =>
                            typeof k === 'string' ? k.toLowerCase() : (k.text || '').toLowerCase()
                        );

                        let matchCount = 0;
                        for (const keyword of keywords) {
                            const kw = keyword.toLowerCase();
                            // Check text content
                            if (text.includes(kw)) matchCount++;
                            // Check stored keywords
                            if (storedKeywords.some(sk => sk.includes(kw) || kw.includes(sk))) matchCount++;
                        }

                        if (matchCount > 0) {
                            const keywordScore = Math.min(1.0, (matchCount / keywords.length) * keywordBoost);
                            keywordResults.push({
                                hash: point.payload.hash,
                                text: point.payload.text,
                                keywordScore: keywordScore,
                                matchedKeywords: matchCount,
                                metadata: point.payload,
                            });
                        }
                    }

                    offset = scrollResponse.result?.next_page_offset;
                    scrollCount++;

                    // Safety limit
                    if (scrollCount >= maxScrollIterations) {
                        console.warn(`[Qdrant] Keyword search exceeded max iterations (${maxScrollIterations})`);
                        break;
                    }

                } while (offset !== null && offset !== undefined);

                console.log(`[Qdrant] Keyword search complete: ${keywordResults.length} results`);
            } else {
                console.log(`[Qdrant] No keywords provided, skipping keyword search`);
            }

            // ================================================================
            // STRATEGY 3: Fusion (Combine Vector + Keyword Results)
            // ================================================================
            console.log(`[Qdrant] Starting fusion: ${vectorResults.length} vector + ${keywordResults.length} keyword results`);

            const fusedResults = this._fuseResults(vectorResults, keywordResults, {
                method: fusionMethod,
                vectorWeight,
                keywordWeight,
                rrfK,
                topK,
            });

            console.log(`[Qdrant] Hybrid query: ${vectorResults.length} vector + ${keywordResults.length} keyword = ${fusedResults.length} fused results`);

            return fusedResults;

        } catch (error) {
            console.error(`[Qdrant] Hybrid query failed for ${mainCollection}:`, error.message);
            return [];
        }
    }

    /**
     * Fuse vector and keyword search results using RRF or weighted combination
     * @param {Array} vectorResults - Results from vector search
     * @param {Array} keywordResults - Results from keyword search
     * @param {object} options - Fusion options {method, vectorWeight, keywordWeight, rrfK, topK}
     * @returns {Array} Fused results sorted by combined score
     */
    _fuseResults(vectorResults, keywordResults, options) {
        const { method, vectorWeight, keywordWeight, rrfK, topK } = options;

        // Create hash map for merging results
        const resultsMap = new Map();

        // Add vector results
        vectorResults.forEach((result, index) => {
            resultsMap.set(result.hash, {
                ...result,
                vectorRank: index + 1,
                vectorScore: result.vectorScore || result.score,
                keywordScore: 0,
                keywordRank: Infinity,
            });
        });

        // Merge keyword results
        keywordResults.forEach((result, index) => {
            if (resultsMap.has(result.hash)) {
                const existing = resultsMap.get(result.hash);
                existing.keywordScore = result.keywordScore;
                existing.keywordRank = index + 1;
                existing.matchedKeywords = result.matchedKeywords;
            } else {
                resultsMap.set(result.hash, {
                    ...result,
                    vectorScore: 0,
                    vectorRank: Infinity,
                    keywordScore: result.keywordScore,
                    keywordRank: index + 1,
                });
            }
        });

        // Calculate fused scores
        const fusedResults = Array.from(resultsMap.values()).map(result => {
            let fusedScore;

            if (method === 'rrf') {
                // Reciprocal Rank Fusion (RRF)
                const vectorRRF = 1 / (rrfK + result.vectorRank);
                const keywordRRF = 1 / (rrfK + result.keywordRank);
                fusedScore = (vectorWeight * vectorRRF) + (keywordWeight * keywordRRF);
            } else {
                // Weighted linear combination
                fusedScore = (vectorWeight * result.vectorScore) + (keywordWeight * result.keywordScore);
            }

            return {
                hash: result.hash,
                text: result.text,
                score: fusedScore,
                metadata: result.metadata,
                debug: {
                    vectorScore: result.vectorScore,
                    keywordScore: result.keywordScore,
                    vectorRank: result.vectorRank,
                    keywordRank: result.keywordRank,
                    matchedKeywords: result.matchedKeywords || 0,
                    fusionMethod: method,
                },
            };
        });

        // Sort by fused score and return top K
        return fusedResults
            .sort((a, b) => b.score - a.score)
            .slice(0, topK);
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
