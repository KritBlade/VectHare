/**
 * ============================================================================
 * VECTHARE CHAT VECTORIZATION
 * ============================================================================
 * Core logic for vectorizing chat messages and retrieving relevant context
 *
 * @author Coneja Chibi
 * @version 2.2.0-alpha
 * ============================================================================
 */

import { getCurrentChatId, is_send_press, setExtensionPrompt, substituteParams, chat_metadata, extension_prompts } from '../../../../../script.js';
import { getContext } from '../../../../extensions.js';
import { getStringHash as calculateHash, waitUntilCondition, onlyUnique } from '../../../../utils.js';
import { isUnitStrategy } from './chunking.js';
import { extractChatKeywords, extractBM25Keywords } from './keyword-boost.js';
import { cleanText } from './text-cleaning.js';
import {
    getSavedHashes,
    insertVectorItems,
    queryCollection,
    queryActiveCollections,
    deleteVectorItems,
    purgeVectorIndex,
} from './core-vector-api.js';
import { isBackendAvailable } from '../backends/backend-manager.js';
import {
    summarizeText,
    isSummarizationFatalError,
    getSummarizationConfigFingerprint,
} from './summarizer.js';
import { applyDecayToResults, applySceneAwareDecay } from './temporal-decay.js';
import { isChunkDisabledByScene } from './scenes.js';
import { registerCollection, getCollectionRegistry } from './collection-loader.js';
import { isCollectionEnabled, filterActiveCollections, setCollectionLock } from './collection-metadata.js';
import { progressTracker } from '../ui/progress-tracker.js';
import { buildSearchContext, filterChunksByConditions, processChunkLinks } from './conditional-activation.js';
import { getChunkMetadata, getCollectionMeta } from './collection-metadata.js';
import { processChunkGroups, mergeVirtualLinks } from './chunk-groups.js';
import { createDebugData, setLastSearchDebug, addTrace, recordChunkFate } from '../ui/search-debug.js';
import { getSemanticWorldInfoEntries } from './world-info-integration.js';
import { Queue, LRUCache } from '../utils/data-structures.js';
import { getRequestHeaders } from '../../../../../script.js';
import { EXTENSION_PROMPT_TAG, HASH_CACHE_SIZE } from './constants.js';
// Import from collection-ids.js - single source of truth for collection ID operations
import {
    getChatUUID,
    buildChatCollectionId,
    buildLegacyChatCollectionId,
    getAllChatCollectionIds,
    parseCollectionId,
    parseRegistryKey,
} from './collection-ids.js';

// Hash cache for performance
const hashCache = new LRUCache(HASH_CACHE_SIZE);

// Synchronization state
let syncBlocked = false;
let summarizationFailureLatch = null;

// ============================================================================
// RE-EXPORTS from collection-ids.js for backwards compatibility
// Other files importing from chat-vectorization.js will still work.
// ============================================================================

// Re-export getChatUUID (already imported above)
export { getChatUUID };

/**
 * Builds chat collection ID using the chat's unique UUID
 * Format: vecthare_chat_{handleId}_{charName}_{uuid}
 * @param {string} [chatUUID] Optional UUID override, otherwise uses current chat
 * @returns {string|null} Collection ID or null if no chat
 */
export function getChatCollectionId(chatUUID) {
    return buildChatCollectionId(chatUUID);
}

/**
 * Gets the legacy format collection ID for backwards compatibility
 * @param {string} [chatId] Optional chatId override, otherwise uses current chat
 * @returns {string|null} Legacy collection ID or null if no chat
 */
export function getLegacyChatCollectionId(chatId) {
    return buildLegacyChatCollectionId(chatId);
}

// Re-export getAllChatCollectionIds with adapted return format for backwards compat
export { getAllChatCollectionIds, parseCollectionId, parseRegistryKey };

/**
 * Gets the hash value for a string (with LRU caching)
 * @param {string} str Input string
 * @returns {number} Hash value
 */
function getStringHash(str) {
    const cached = hashCache.get(str);
    if (cached !== undefined) {
        return cached;
    }
    const hash = calculateHash(str);
    hashCache.set(str, hash);
    return hash;
}

/**
 * Gets message text without file attachments
 * Matches behavior of ST vectors extension for hash compatibility
 * @param {object} message Chat message object
 * @returns {string} Message text without attachment prefix
 */
function getTextWithoutAttachments(message) {
    const fileLength = message?.extra?.fileLength || 0;
    return String(message?.mes || '').substring(fileLength).trim();
}

/**
 * Prepares items for insertion by adding source metadata
 * @param {object[]} items Array of vector items
 * @returns {object[]} Items with source metadata added
 */
function prepareItemsForInsertion(items) {
    return items.map(item => ({
        ...item,
        metadata: {
            ...item.metadata,
            source: 'chat',
        }
    }));
}

/**
 * Groups messages according to chunking strategy
 *
 * HASH DESIGN NOTE: Hashes are calculated from combined text ONLY (not message indices).
 * This is INTENTIONAL semantic deduplication - identical text produces identical embeddings,
 * so storing duplicates would waste storage and query budget. Individual message IDs are
 * preserved in metadata.messageIds and metadata.messageHashes for injection lookup.
 * DO NOT add message indices to hash calculation - it would break incremental sync and
 * disable deduplication with no functional benefit.
 *
 * @param {object[]} messages Messages to group
 * @param {string} strategy Chunking strategy: 'per_message', 'conversation_turns', 'message_batch'
 * @param {number} batchSize Number of messages per batch (for message_batch strategy)
 * @param {string} keywordLevel Keyword extraction level: 'off', 'minimal', 'balanced', 'aggressive'
 * @returns {object[]} Grouped message items ready for chunking
 */
async function groupMessagesByStrategy(messages, strategy, batchSize = 4, keywordLevel = 'balanced', settings = {}) {
    if (!messages.length) return [];

    console.log(`[VectHare] groupMessagesByStrategy: ${messages.length} messages, strategy=${strategy}, summarize_provider=${settings?.summarize_provider || 'off'}`);

    const summarize = (text) => summarizeText(text, settings);

    // Helper to extract keywords based on level
    const getKeywords = (text) => {
        if (keywordLevel === 'off') return [];
        return extractBM25Keywords(text, { level: keywordLevel });
    };

    switch (strategy) {
        case 'conversation_turns': {
            // Group user + AI message pairs
            const grouped = [];
            for (let i = 0; i < messages.length; i += 2) {
                const pair = [messages[i]];
                if (i + 1 < messages.length) {
                    pair.push(messages[i + 1]);
                }
                // Combine texts with speaker labels
                const combinedText = pair.map(m => {
                    const role = m.is_user ? 'User' : 'Character';
                    return `[${role}]: ${m.text}`;
                }).join('\n\n');
                const storedText = await summarize(combinedText);

                grouped.push({
                    text: storedText,
                    hash: getStringHash(combinedText),
                    index: messages[i].index,
                    keywords: getKeywords(storedText),
                    metadata: {
                        strategy: 'conversation_turns',
                        messageIds: pair.map(m => m.index),
                        messageHashes: pair.map(m => m.hash), // Store individual hashes for injection lookup
                        startIndex: messages[i].index,
                        endIndex: pair[pair.length - 1].index
                    }
                });
            }
            return grouped;
        }

        case 'message_batch': {
            // Group N messages together
            const grouped = [];
            for (let i = 0; i < messages.length; i += batchSize) {
                const batch = messages.slice(i, i + batchSize);
                // Combine texts with speaker labels
                const combinedText = batch.map(m => {
                    const role = m.is_user ? 'User' : 'Character';
                    return `[${role}]: ${m.text}`;
                }).join('\n\n');
                const storedText = await summarize(combinedText);

                grouped.push({
                    text: storedText,
                    hash: getStringHash(combinedText),
                    index: batch[0].index,
                    keywords: getKeywords(storedText),
                    metadata: {
                        strategy: 'message_batch',
                        batchSize: batch.length,
                        messageIds: batch.map(m => m.index),
                        messageHashes: batch.map(m => m.hash), // Store individual hashes for injection lookup
                        startIndex: batch[0].index,
                        endIndex: batch[batch.length - 1].index
                    }
                });
            }
            return grouped;
        }

        case 'per_message':
        default: {
            // Each message is its own item
            const grouped = [];
            for (const m of messages) {
                const storedText = await summarize(m.text);
                grouped.push({
                    text: storedText,
                    hash: m.hash,
                    index: m.index,
                    is_user: m.is_user,
                    keywords: getKeywords(storedText),
                    metadata: {
                        strategy: 'per_message',
                        messageId: m.index,
                        messageHashes: [m.hash] // Consistent with grouped strategies
                    }
                });
            }
            return grouped;
        }
    }
}

/**
 * Filters out chunks that have been disabled by scene vectorization
 * @param {object[]} chunks Chunks to filter
 * @returns {object[]} Chunks not disabled by scenes
 */
function filterSceneDisabledChunks(chunks) {
    const filtered = chunks.filter(chunk => {
        const isDisabled = isChunkDisabledByScene(chunk.hash);
        if (isDisabled) {
            console.debug(`VectHare: Chunk ${chunk.hash} is disabled by scene`);
        }
        return !isDisabled;
    });

    if (filtered.length !== chunks.length) {
        console.log(`VectHare: Scene filtering: ${chunks.length} → ${filtered.length} chunks (${chunks.length - filtered.length} disabled by scenes)`);
    }

    return filtered;
}

/**
 * Applies chunk-level conditions to filter results
 * @param {object[]} chunks Chunks with metadata
 * @param {object[]} chat Chat messages for context
 * @param {object} settings VectHare settings
 * @returns {Promise<object[]>} Filtered chunks
 */
async function applyChunkConditions(chunks, chat, settings) {
    // First filter out chunks disabled by scenes
    let filtered = filterSceneDisabledChunks(chunks);

    // Check if any chunks have conditions (from chunk metadata)
    const chunksWithConditions = filtered.map(chunk => {
        const chunkMeta = getChunkMetadata(chunk.hash);
        if (chunkMeta?.conditions?.enabled) {
            return { ...chunk, conditions: chunkMeta.conditions };
        }
        return chunk;
    });

    // If no chunks have conditions, return filtered
    const hasAnyConditions = chunksWithConditions.some(c => c.conditions?.enabled);
    if (!hasAnyConditions) {
        return filtered;
    }

    // Build search context for condition evaluation
    const context = buildSearchContext(chat, settings.query || 10, chunksWithConditions, {
        generationType: settings.generationType || 'normal',
        isGroupChat: settings.isGroupChat || false,
        currentCharacter: settings.currentCharacter || null,
        activeLorebookEntries: settings.activeLorebookEntries || [],
        activationHistory: window.VectHare_ActivationHistory || {}
    });

    // Filter chunks by their conditions
    const conditionFilteredChunks = filterChunksByConditions(chunksWithConditions, context);

    // Track activation for frequency conditions
    conditionFilteredChunks.forEach(chunk => {
        if (chunk.conditions?.enabled) {
            trackChunkActivation(chunk.hash, chat.length);
        }
    });

    console.log(`VectHare: Chunk conditions filtered ${filtered.length} → ${conditionFilteredChunks.length}`);
    return conditionFilteredChunks;
}

/**
 * Tracks chunk activation for frequency/cooldown conditions
 * @param {number} hash Chunk hash
 * @param {number} messageCount Current message count
 */
function trackChunkActivation(hash, messageCount) {
    if (!window.VectHare_ActivationHistory) {
        window.VectHare_ActivationHistory = {};
    }

    const history = window.VectHare_ActivationHistory[hash] || { count: 0, lastActivation: null };
    window.VectHare_ActivationHistory[hash] = {
        count: history.count + 1,
        lastActivation: messageCount
    };
}

/**
 * Rerank chunks using BananaBread's reranking endpoint
 * @param {string} query The search query
 * @param {Array} chunks Array of chunks with text
 * @param {object} settings VectHare settings
 * @returns {Promise<Array>} Chunks with updated scores from reranker
 */
async function rerankWithBananaBread(query, chunks, settings) {
    if (!chunks.length) return chunks;

    const apiUrl = settings.use_alt_endpoint ? settings.alt_endpoint_url : 'http://localhost:8008';
    const documents = chunks.map(c => c.text);

    try {
        const response = await fetch('/api/plugins/similharity/rerank', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                apiUrl,
                apiKey: settings.bananabread_api_key || '', // Include API key for authentication
                query,
                documents,
                top_k: chunks.length
            }),
        });

        if (!response.ok) {
            console.warn('VectHare: Reranking failed, using original scores');
            return chunks;
        }

        const data = await response.json();
        if (!data.results || !Array.isArray(data.results)) {
            return chunks;
        }

        // Apply rerank scores - results are sorted by score desc
        // Each result has { index, score } where index refers to original position
        const rerankedChunks = data.results.map(r => {
            const chunk = { ...chunks[r.index] };
            chunk.rerankScore = r.score;
            chunk.originalScore = chunk.score;
            chunk.score = r.score; // Replace score with rerank score
            return chunk;
        });

        console.log(`VectHare: Reranked ${rerankedChunks.length} chunks with BananaBread`);
        return rerankedChunks;
    } catch (error) {
        console.warn('VectHare: Reranking error:', error.message);
        return chunks;
    }
}

/**
 * Synchronizes chat with vector index using simple FIFO queue
 *
 * How it works:
 * 1. Get all messages, get all vectorized hashes from DB
 * 2. Queue = messages not yet in DB (by hash)
 * 3. Process batch: take message, chunk it, insert chunks, remove from queue
 * 4. Repeat until queue empty
 *
 * @param {object} settings VectHare settings
 * @param {number} batchSize Number of messages to process per call
 * @returns {Promise<object>} Progress info
 */
export async function synchronizeChat(settings, batchSize = 5) {
    const summarizeFingerprint = getSummarizationConfigFingerprint(settings);
    if (summarizationFailureLatch) {
        if (summarizationFailureLatch.fingerprint === summarizeFingerprint) {
            // Same broken config: keep sync halted silently to avoid popup spam.
            return { remaining: -1, messagesProcessed: 0, chunksCreated: 0 };
        }
        // Config changed: clear latch and allow sync attempt again.
        summarizationFailureLatch = null;
    }

    // Build proper collection ID using chat UUID first
    const collectionId = getChatCollectionId();
    console.log(`🔍 VectHare DEBUG: getChatCollectionId() returned: "${collectionId}"`);
    console.log(`🔍 VectHare DEBUG: settings.vector_backend = "${settings.vector_backend}"`);
    console.log(`🔍 VectHare DEBUG: settings.source = "${settings.source}"`);
    if (!collectionId) {
        return { remaining: -1, messagesProcessed: 0, chunksCreated: 0 };
    }

    // Check per-collection autoSync setting instead of global enabled_chats
    const { isCollectionAutoSyncEnabled } = await import('./collection-metadata.js');
    if (!isCollectionAutoSyncEnabled(collectionId)) {
        console.log(`[VectHare] synchronizeChat: collection "${collectionId}" has auto-sync disabled — skipping`);
        return { remaining: -1, messagesProcessed: 0, chunksCreated: 0 };
    }

    // Per Scene strategy: don't auto-vectorize on message events
    // Scenes are vectorized when user marks scene end (via createSceneChunk)
    if (settings.chunking_strategy === 'per_scene') {
        return { remaining: 0, messagesProcessed: 0, chunksCreated: 0 };
    }

    try {
        await waitUntilCondition(() => !syncBlocked && !is_send_press, 1000);
    } catch {
        syncBlocked = false; // VEC-30: Reset flag on timeout
        return { remaining: -1, messagesProcessed: 0, chunksCreated: 0 };
    }

    try {
        syncBlocked = true;
        const context = getContext();

        if (!getCurrentChatId() || !Array.isArray(context.chat)) {
            return { remaining: -1, messagesProcessed: 0, chunksCreated: 0 };
        }

        // NOTE: Registration happens AFTER first successful insert to prevent ghosts
        let isRegistered = false;

        // Step 1: What's already vectorized? (source of truth = DB)
        const existingHashes = new Set(await getSavedHashes(collectionId, settings));

        // Step 2: Build list of messages NOT in DB
        const strategy = settings.chunking_strategy || 'per_message';
        const strategyBatchSize = settings.batch_size || 4;

        // Collect all non-system messages with their data
        // PERF: Use index from loop instead of indexOf() to avoid O(n²)
        const allMessages = [];
        for (let i = 0; i < context.chat.length; i++) {
            const msg = context.chat[i];
            if (msg.is_system) continue;
            // Apply text cleaning to remove HTML tags, metadata blocks, etc.
            const rawText = String(substituteParams(msg.mes));
            const text = cleanText(rawText);
            allMessages.push({
                text,
                hash: getStringHash(substituteParams(getTextWithoutAttachments(msg))),
                index: i,
                is_user: msg.is_user
            });
        }

        // Group messages according to strategy
        const keywordLevel = settings.keyword_extraction_level || 'balanced';
        const groupedItems = await groupMessagesByStrategy(allMessages, strategy, strategyBatchSize, keywordLevel, settings);

        // Filter out already vectorized items (by their grouped hash)
        const queue = new Queue();
        for (const item of groupedItems) {
            if (!existingHashes.has(item.hash)) {
                queue.enqueue(item);
            }
        }

        if (queue.isEmpty()) {
            return { remaining: 0, messagesProcessed: 0, chunksCreated: 0 };
        }

        // Step 3: Process batch
        let itemsProcessed = 0;
        let chunksCreated = 0;
        let itemsFailed = 0;
        const label = strategy === 'per_message' ? 'Message' : 'Group';

        while (!queue.isEmpty() && itemsProcessed < batchSize) {
            const item = queue.dequeue();

            try {
                // Prepare item for insertion (add source metadata)
                const chunks = prepareItemsForInsertion([item]);

                // Insert chunks (insertVectorItems handles duplicates at DB level)
                if (chunks.length > 0) {
                    await insertVectorItems(collectionId, chunks, settings, (embedded, total) => {
                        // Update progress tracker with embedding progress
                        console.log(`[Chat Vectorization] Embedding progress callback: ${embedded}/${total}`);
                        progressTracker.updateEmbeddingProgress(embedded, total);

                        // Determine phase based on progress (0-50% = Embedding, 50-100% = Writing)
                        const progressPercent = (embedded / total) * 100;
                        const phase = progressPercent <= 50 ? 'Embedding' : 'Writing to database';
                        progressTracker.updateCurrentItem(`${label} ${itemsProcessed}/${batchSize} - ${phase}: ${embedded}/${total} chunks`);
                    });
                    chunksCreated += chunks.length;

                    // Register on first successful insert (prevents ghost collections)
                    if (!isRegistered) {
                        // Construct proper registry key: backend:source:collectionId
                        const backend = settings.vector_backend || 'standard';
                        const source = settings.source || 'transformers';
                        const registryKey = `${backend}:${source}:${collectionId}`;
                        console.log(`🔍 VectHare DEBUG: Registering collection with key: "${registryKey}"`);
                        console.log(`🔍 VectHare DEBUG: Components: backend="${backend}", source="${source}", collectionId="${collectionId}"`);
                        registerCollection(registryKey);
                        isRegistered = true;
                        // Chat collections should be scoped to the current chat, not globally always-active.
                        const chatId = getCurrentChatId();
                        if (chatId) {
                            setCollectionLock(collectionId, chatId);
                        }
                        console.log(`VectHare: Registered collection ${registryKey} after first successful insert`);
                    }
                }
            } catch (itemError) {
                // Log error but continue processing other items
                console.warn(`VectHare: Failed to process item (hash: ${item.hash}, index: ${item.index}):`, itemError.message);
                itemsFailed++;
                // Don't rethrow - continue with next item
            }

            itemsProcessed++;
            progressTracker.updateCurrentItem(`${label} ${itemsProcessed}/${batchSize}${itemsFailed > 0 ? ` (${itemsFailed} failed)` : ''}`);
        }

        progressTracker.updateCurrentItem(null);

        if (itemsFailed > 0) {
            console.warn(`VectHare: Sync completed with ${itemsFailed} failed items out of ${itemsProcessed}`);
        }

        return {
            remaining: queue.size,
            messagesProcessed: itemsProcessed,
            chunksCreated,
            itemsFailed
        };
    } catch (error) {
        if (isSummarizationFatalError(error)) {
            const providerLabel = (settings?.summarize_provider || 'summarizer').toUpperCase();
            const msg = `Summarization is enabled but misconfigured: ${error.message}`;
            summarizationFailureLatch = { fingerprint: summarizeFingerprint, reason: msg };
            try {
                toastr.error(msg, `${providerLabel} configuration error`);
            } catch (_) {
                // no-op
            }
            console.error('VectHare: Synchronization halted due to fatal summarization error:', error.message);
            return { remaining: -1, messagesProcessed: 0, chunksCreated: 0 };
        }
        console.error('VectHare: Sync failed', error);
        throw error;
    } finally {
        syncBlocked = false;
    }
}

// ============================================================================
// REARRANGE CHAT PIPELINE - Helper Functions
// ============================================================================
// These functions break down the rearrangeChat logic into discrete stages
// for better maintainability and testability.
// ============================================================================

/**
 * Stage 1: Gather all collections that should be queried
 * @param {object} settings VectHare settings
 * @returns {string[]} Array of collection IDs to query
 */
function gatherCollectionsToQuery(settings) {
    const chatCollectionId = getChatCollectionId();
    const collectionsToQuery = [];

    // Include chat collection if it's enabled AND we have a valid collection ID
    // Uses per-collection enabled state, not global enabled_chats
    if (chatCollectionId && isCollectionEnabled(chatCollectionId)) {
        collectionsToQuery.push(chatCollectionId);
    }

    // Get all other registered collections that are enabled
    const registry = getCollectionRegistry();
    for (const registryKey of registry) {
        // Use proper registry key parser to extract collection ID
        const parsedKey = parseRegistryKey(registryKey);
        const collectionId = parsedKey.collectionId;

        // Skip if this is the current chat collection (already handled above)
        if (collectionId === chatCollectionId) {
            continue;
        }

        // Check if collection is enabled (use registryKey for metadata lookup)
        if (isCollectionEnabled(registryKey)) {
            // Push registryKey, not collectionId - activation filters need the full key for metadata
            collectionsToQuery.push(registryKey);
        }
    }

    return collectionsToQuery;
}

/**
 * Stage 2: Build the search query from recent messages
 * @param {object[]} chat Current chat messages
 * @param {object} settings VectHare settings
 * @returns {string} Query text
 */
function buildSearchQuery(chat, settings) {
    const recentMessages = chat
        .filter(x => !x.is_system)
        .reverse()
        .slice(0, settings.query)
        .map(x => substituteParams(x.mes));

    return recentMessages.join('\n').trim();
}

/**
 * Stage 3: Query all active collections and merge results
 * @param {string[]} activeCollections Collections that passed activation filters
 * @param {string} queryText Search query
 * @param {object} settings VectHare settings
 * @param {object[]} chat Current chat messages
 * @param {object} debugData Debug tracking object
 * @returns {Promise<object[]>} Array of chunk objects with scores
 */
async function queryAndMergeCollections(activeCollections, queryText, settings, chat, debugData) {
    let chunksForVisualizer = [];
    const effectiveTopK = settings.top_k ?? settings.insert;

    // PERF: Build hash-to-message Map once for O(1) lookups instead of O(n) find() per chunk
    const chatHashMap = new Map();
    for (const msg of chat) {
        if (msg.mes) {
            const hash = getStringHash(substituteParams(getTextWithoutAttachments(msg)));
            if (!chatHashMap.has(hash)) {
                chatHashMap.set(hash, msg);
            }
        }
    }

    for (const collectionId of activeCollections) {
        try {
            const queryResults = await queryCollection(collectionId, queryText, effectiveTopK, settings);

            // TRACE: Vector query results for this collection
            addTrace(debugData, 'vector_search', `Query completed for ${collectionId}`, {
                hashesReturned: queryResults.hashes.length,
                hashes: queryResults.hashes.slice(0, 5),
                scoreBreakdown: queryResults.metadata.slice(0, 5).map(m => ({
                    finalScore: m.score?.toFixed(3),
                    originalScore: m.originalScore?.toFixed(3),
                    keywordBoost: m.keywordBoost?.toFixed(2) || '1.00',
                    matchedKeywords: m.matchedKeywords || [],
                    keywordBoosted: m.keywordBoosted || false
                }))
            });

            console.log(`VectHare: Retrieved ${queryResults.hashes.length} chunks from ${collectionId}`);

            // Build chunks with text for visualizer
            const collectionChunks = queryResults.metadata.map((meta, idx) => {
                const hash = queryResults.hashes[idx];

                // Prefer text from metadata (stored in vector DB)
                let text = meta.text;
                let textSource = 'metadata';

                // Fallback: try to find in chat messages if not in metadata
                // PERF: Use pre-built Map for O(1) lookup instead of O(n) find()
                if (!text) {
                    const chatMessage = chatHashMap.get(hash);
                    text = chatMessage ? substituteParams(chatMessage.mes) : '(text not found)';
                    textSource = chatMessage ? 'chat_lookup' : 'not_found';

                    // Debug: Log when text is not found
                    if (textSource === 'not_found') {
                        console.warn(`[VectHare] ⚠️ Chunk text not found! hash=${hash}, meta.text=${meta.text ? 'exists' : 'missing'}, chatMessage=${chatMessage ? 'found' : 'not found'}`);
                    }
                }

                // TRACE: Record initial chunk state
                recordChunkFate(debugData, hash, 'vector_search', 'passed', null, {
                    finalScore: meta.score || 1.0,
                    originalScore: meta.originalScore,
                    keywordBoost: meta.keywordBoost,
                    matchedKeywords: meta.matchedKeywords,
                    textSource,
                    textLength: text?.length || 0,
                    collectionId
                });

                return {
                    hash: hash,
                    metadata: meta,
                    score: meta.score || 1.0,
                    originalScore: meta.originalScore,
                    keywordBoost: meta.keywordBoost,
                    matchedKeywords: meta.matchedKeywords,
                    matchedKeywordsWithWeights: meta.matchedKeywordsWithWeights,
                    keywordBoosted: meta.keywordBoosted,
                    similarity: meta.score || 1.0,
                    text: text,
                    index: meta.messageId || meta.index || 0,
                    collectionId: collectionId,
                    decayApplied: false,
                    // Hybrid search scores
                    vectorScore: meta.vectorScore,
                    textScore: meta.textScore,
                    hybridSearch: meta.hybridSearch
                };
            });

            chunksForVisualizer.push(...collectionChunks);
        } catch (error) {
            console.warn(`VectHare: Failed to query collection ${collectionId}:`, error.message);
            addTrace(debugData, 'vector_search', `Query failed for ${collectionId}`, {
                error: error.message
            });
        }
    }

    // Sort merged results by score (descending) and limit to topK
    chunksForVisualizer.sort((a, b) => b.score - a.score);
    chunksForVisualizer = chunksForVisualizer.slice(0, effectiveTopK);

    return chunksForVisualizer;
}

/**
 * Stage 3.5: Expand summary chunks to their parent chunks (dual-vector system)
 * When a summary chunk matches a query, we want to inject the full parent text instead.
 * The summary's score is preserved since that's what semantically matched.
 *
 * @param {object[]} chunks Chunks from query results
 * @param {string[]} activeCollections Collections that were queried
 * @param {object} settings VectHare settings
 * @param {object} debugData Debug tracking object
 * @returns {Promise<object[]>} Chunks with summaries expanded to parents
 */
async function expandSummaryChunks(chunks, activeCollections, settings, debugData) {
    const expandedChunks = [];
    const parentHashesNeeded = new Map(); // parentHash -> { summaryChunk, collectionId }

    // First pass: identify which chunks are summaries and need parent expansion
    for (const chunk of chunks) {
        const meta = chunk.metadata || {};
        const isSummary = meta.isSummaryChunk || meta.isSummary || meta.isSummaryVector;
        const parentHash = meta.parentHash;

        if (isSummary && parentHash) {
            // Track this summary for parent lookup
            parentHashesNeeded.set(String(parentHash), {
                summaryChunk: chunk,
                collectionId: chunk.collectionId
            });

            addTrace(debugData, 'summary_expansion', `Summary chunk found, will expand to parent`, {
                summaryHash: chunk.hash,
                parentHash: parentHash,
                summaryScore: chunk.score?.toFixed(3),
                collectionId: chunk.collectionId
            });
        } else {
            // Not a summary, keep as-is
            expandedChunks.push(chunk);
        }
    }

    // If no summaries found, return original chunks
    if (parentHashesNeeded.size === 0) {
        return chunks;
    }

    // Second pass: fetch parent chunks from the vector DB
    // Group by collection for efficiency
    const parentsByCollection = new Map();
    for (const [parentHash, info] of parentHashesNeeded) {
        const collectionId = info.collectionId;
        if (!parentsByCollection.has(collectionId)) {
            parentsByCollection.set(collectionId, []);
        }
        parentsByCollection.get(collectionId).push({ parentHash, summaryChunk: info.summaryChunk });
    }

    // Fetch parents from each collection
    for (const [collectionId, parentInfos] of parentsByCollection) {
        try {
            // Get all chunks from this collection with metadata
            const collectionData = await getSavedHashes(collectionId, settings, true);

            if (collectionData && collectionData.metadata) {
                // Build a lookup map of hash -> chunk data
                const chunkLookup = new Map();
                for (let i = 0; i < collectionData.hashes.length; i++) {
                    const hash = String(collectionData.hashes[i]);
                    chunkLookup.set(hash, collectionData.metadata[i]);
                }

                // Find each parent and create expanded chunk
                for (const { parentHash, summaryChunk } of parentInfos) {
                    const parentData = chunkLookup.get(String(parentHash));

                    if (parentData) {
                        // Found parent - create expanded chunk with parent's text but summary's score
                        const expandedChunk = {
                            ...summaryChunk,
                            hash: parentHash, // Use parent's hash for deduplication
                            text: parentData.text || parentData.mes || '(parent text not found)',
                            metadata: {
                                ...parentData,
                                expandedFromSummary: true,
                                originalSummaryHash: summaryChunk.hash,
                                originalSummaryScore: summaryChunk.score
                            },
                            // Keep summary's score since that's what matched the query
                            score: summaryChunk.score,
                            originalScore: summaryChunk.originalScore,
                            expandedFromSummary: true
                        };

                        expandedChunks.push(expandedChunk);

                        recordChunkFate(debugData, parentHash, 'summary_expansion', 'passed',
                            `Expanded from summary #${summaryChunk.hash}`, {
                                summaryHash: summaryChunk.hash,
                                parentTextLength: expandedChunk.text?.length || 0,
                                inheritedScore: summaryChunk.score?.toFixed(3)
                            });

                        addTrace(debugData, 'summary_expansion', `Parent chunk retrieved`, {
                            parentHash: parentHash,
                            summaryHash: summaryChunk.hash,
                            parentTextLength: expandedChunk.text?.length || 0
                        });
                    } else {
                        // Parent not found - keep the summary chunk as fallback
                        console.warn(`VectHare: Parent chunk ${parentHash} not found for summary ${summaryChunk.hash}, using summary text`);
                        expandedChunks.push(summaryChunk);

                        recordChunkFate(debugData, summaryChunk.hash, 'summary_expansion', 'passed',
                            `Parent not found, using summary text`, {
                                parentHash: parentHash,
                                fallback: true
                            });
                    }
                }
            } else {
                // Couldn't get collection data - keep summaries as-is
                for (const { summaryChunk } of parentInfos) {
                    expandedChunks.push(summaryChunk);
                }
            }
        } catch (error) {
            console.warn(`VectHare: Failed to expand summaries from ${collectionId}:`, error.message);
            // Keep summaries as-is on error
            for (const { summaryChunk } of parentInfos) {
                expandedChunks.push(summaryChunk);
            }
        }
    }

    addTrace(debugData, 'summary_expansion', 'Summary expansion complete', {
        originalCount: chunks.length,
        summariesExpanded: parentHashesNeeded.size,
        finalCount: expandedChunks.length
    });

    return expandedChunks;
}

/**
 * Stage 4: Apply threshold filter to chunks
 * @param {object[]} chunks Chunks to filter
 * @param {number} threshold Score threshold
 * @param {object} debugData Debug tracking object
 * @returns {object[]} Filtered chunks
 */
function applyThresholdFilter(chunks, threshold, debugData) {
    const beforeCount = chunks.length;
    const filtered = chunks.filter(chunk => {
        const passes = chunk.score >= threshold;
        if (!passes) {
            recordChunkFate(debugData, chunk.hash, 'threshold', 'dropped',
                `Score ${chunk.score.toFixed(3)} < threshold ${threshold}`,
                { score: chunk.score, threshold }
            );
        } else {
            recordChunkFate(debugData, chunk.hash, 'threshold', 'passed', null,
                { score: chunk.score, threshold }
            );
        }
        return passes;
    });

    addTrace(debugData, 'threshold', 'Threshold filter applied', {
        threshold,
        before: beforeCount,
        after: filtered.length,
        dropped: beforeCount - filtered.length
    });

    return filtered;
}

/**
 * Stage 5: Apply temporal decay to chunks
 * @param {object[]} chunks Chunks to process
 * @param {object[]} chat Current chat messages
 * @param {object} settings VectHare settings
 * @param {number} threshold Score threshold for re-filtering
 * @param {object} debugData Debug tracking object
 * @returns {object[]} Chunks with decay applied
 */
function applyTemporalDecayStage(chunks, chat, settings, threshold, debugData) {
    if (!settings.temporal_decay || !settings.temporal_decay.enabled) {
        addTrace(debugData, 'decay', 'Temporal decay skipped (disabled)', { enabled: false });
        chunks.forEach(chunk => {
            recordChunkFate(debugData, chunk.hash, 'decay', 'passed', 'Decay disabled', {
                score: chunk.score
            });
        });
        return chunks;
    }

    const beforeCount = chunks.length;
    addTrace(debugData, 'decay', 'Starting temporal decay', {
        enabled: true,
        sceneAware: settings.temporal_decay.sceneAware,
        halfLife: settings.temporal_decay.halfLife || settings.temporal_decay.half_life,
        strength: settings.temporal_decay.strength || settings.temporal_decay.rate
    });

    const currentMessageId = chat.length - 1;
    const chunksWithScores = chunks.map(chunk => ({
        hash: chunk.hash,
        metadata: chunk.metadata,
        score: chunk.score
    }));

    let decayedChunks;
    let decayType = 'standard';

    // Use scene-aware decay if enabled and scenes exist
    if (settings.temporal_decay.sceneAware) {
        const sceneChunks = chunks.filter(c => c.metadata?.isScene === true);
        const scenes = sceneChunks.map(c => ({
            start: c.metadata.sceneStart,
            end: c.metadata.sceneEnd,
            hash: c.hash,
        }));

        if (scenes.length > 0) {
            decayedChunks = applySceneAwareDecay(chunksWithScores, currentMessageId, scenes, settings.temporal_decay);
            decayType = 'scene_aware';
            console.log('VectHare: Applied scene-aware temporal decay to search results');
        } else {
            decayedChunks = applyDecayToResults(chunksWithScores, currentMessageId, settings.temporal_decay);
            decayType = 'standard_no_scenes';
            console.log('VectHare: Applied temporal decay to search results (no scenes marked)');
        }
    } else {
        decayedChunks = applyDecayToResults(chunksWithScores, currentMessageId, settings.temporal_decay);
        console.log('VectHare: Applied temporal decay to search results');
    }

    decayedChunks.sort((a, b) => b.score - a.score);

    // PERF: Build Map for O(1) lookups instead of O(n) find() per chunk
    const decayedChunksMap = new Map(decayedChunks.map(dc => [dc.hash, dc]));

    // Map decay results back to chunks and record fate
    let result = chunks.map(chunk => {
        const decayedChunk = decayedChunksMap.get(chunk.hash);
        if (decayedChunk && (decayedChunk.decayApplied || decayedChunk.sceneAwareDecay)) {
            const decayMultiplier = decayedChunk.score / (decayedChunk.originalScore || 1);
            const newScore = decayedChunk.score;
            const stillAboveThreshold = newScore >= threshold;

            if (stillAboveThreshold) {
                recordChunkFate(debugData, chunk.hash, 'decay', 'passed', null, {
                    originalScore: decayedChunk.originalScore,
                    decayedScore: newScore,
                    decayMultiplier,
                    messageAge: decayedChunk.messageAge || decayedChunk.effectiveAge,
                    decayType
                });
            } else {
                recordChunkFate(debugData, chunk.hash, 'decay', 'dropped',
                    `Decayed score ${newScore.toFixed(3)} < threshold ${threshold}`,
                    {
                        originalScore: decayedChunk.originalScore,
                        decayedScore: newScore,
                        decayMultiplier,
                        messageAge: decayedChunk.messageAge || decayedChunk.effectiveAge,
                        decayType
                    }
                );
            }

            return {
                ...chunk,
                score: newScore,
                originalScore: decayedChunk.originalScore,
                messageAge: decayedChunk.messageAge || decayedChunk.effectiveAge,
                decayApplied: true,
                sceneAwareDecay: decayedChunk.sceneAwareDecay || false,
                decayMultiplier
            };
        }

        recordChunkFate(debugData, chunk.hash, 'decay', 'passed', 'No decay applied', {
            score: chunk.score
        });
        return chunk;
    });

    // Re-filter by threshold after decay
    result = result.filter(c => c.score >= threshold);

    addTrace(debugData, 'decay', 'Temporal decay completed', {
        decayType,
        before: beforeCount,
        after: result.length,
        dropped: beforeCount - result.length
    });

    return result;
}

/**
 * Stage 6: Apply chunk-level conditions
 * @param {object[]} chunks Chunks to filter
 * @param {object[]} chat Current chat messages
 * @param {object} settings VectHare settings
 * @param {object} debugData Debug tracking object
 * @returns {Promise<object[]>} Chunks that passed conditions
 */
async function applyConditionsStage(chunks, chat, settings, debugData) {
    const beforeCount = chunks.length;
    // PERF: Build a Map of hash -> chunk data for tracking instead of copying entire array
    const chunkDataByHash = new Map(chunks.map(c => [c.hash, { score: c.score, conditions: c.metadata?.conditions }]));

    addTrace(debugData, 'conditions', 'Starting condition filtering', {
        chunksToFilter: beforeCount,
        hasConditions: chunks.some(c => c.metadata?.conditions)
    });

    const filtered = await applyChunkConditions(chunks, chat, settings);

    // Record which chunks were dropped by conditions
    const afterConditionsHashes = new Set(filtered.map(c => c.hash));
    for (const [hash, data] of chunkDataByHash) {
        if (afterConditionsHashes.has(hash)) {
            recordChunkFate(debugData, hash, 'conditions', 'passed', null, {
                score: data.score,
                hadConditions: !!data.conditions
            });
        } else {
            recordChunkFate(debugData, hash, 'conditions', 'dropped',
                data.conditions
                    ? `Failed condition: ${JSON.stringify(data.conditions)}`
                    : 'Filtered by condition system',
                {
                    score: data.score,
                    conditions: data.conditions
                }
            );
        }
    }

    addTrace(debugData, 'conditions', 'Condition filtering completed', {
        before: beforeCount,
        after: filtered.length,
        dropped: beforeCount - filtered.length
    });

    return filtered;
}

/**
 * Stage 6.5: Process chunk groups and links
 * - Applies exclusive group filtering (only highest-scoring member passes)
 * - Expands inclusive groups into virtual links
 * - Processes chunk links (both explicit and group-generated)
 * @param {object[]} chunks Chunks to process
 * @param {string[]} activeCollections Active collection IDs
 * @param {object} settings VectHare settings
 * @param {object} debugData Debug tracking object
 * @returns {Promise<object[]>} Processed chunks with links applied
 */
async function applyGroupsAndLinksStage(chunks, activeCollections, settings, debugData) {
    const beforeCount = chunks.length;
    let processedChunks = [...chunks];

    addTrace(debugData, 'groups', 'Starting groups and links processing', {
        chunksCount: beforeCount,
        collectionsToCheck: activeCollections.length
    });

    // Collect groups from all active collections
    // PERF: Count modes during collection instead of separate filter passes
    const allGroups = [];
    let inclusiveCount = 0;
    let exclusiveCount = 0;
    for (const collectionId of activeCollections) {
        const meta = getCollectionMeta(collectionId);
        if (meta.groups && meta.groups.length > 0) {
            for (const group of meta.groups) {
                allGroups.push(group);
                if (group.mode === 'inclusive') inclusiveCount++;
                else if (group.mode === 'exclusive') exclusiveCount++;
            }
        }
    }

    if (allGroups.length === 0) {
        addTrace(debugData, 'groups', 'No groups defined in active collections', {});
        // Still process explicit chunk links even without groups
    } else {
        addTrace(debugData, 'groups', `Found ${allGroups.length} groups across collections`, {
            inclusive: inclusiveCount,
            exclusive: exclusiveCount
        });

        // Build a map of all chunks for mandatory group lookup
        const allChunksMap = new Map(chunks.map(c => [String(c.hash), c]));

        // Process groups
        const groupResult = processChunkGroups(chunks, allGroups, allChunksMap, {
            softBoost: settings.group_soft_boost || 0.15
        });

        processedChunks = groupResult.chunks;

        // Log group processing results
        if (groupResult.debug.excluded.length > 0) {
            addTrace(debugData, 'groups', `Exclusive groups filtered ${groupResult.debug.excluded.length} chunks`, {
                excluded: groupResult.debug.excluded.map(e => ({
                    hash: String(e.hash).substring(0, 8),
                    group: e.groupName,
                    beatBy: String(e.beatBy).substring(0, 8)
                }))
            });

            // Record fates for excluded chunks
            for (const ex of groupResult.debug.excluded) {
                recordChunkFate(debugData, ex.hash, 'groups', 'dropped',
                    `Excluded by group "${ex.groupName}" - beaten by chunk #${String(ex.beatBy).substring(0, 8)}`,
                    { score: ex.score, winnerScore: ex.winnerScore }
                );
            }
        }

        if (groupResult.debug.forced.length > 0) {
            addTrace(debugData, 'groups', `Mandatory groups force-included ${groupResult.debug.forced.length} chunks`, {
                forced: groupResult.debug.forced.map(f => ({
                    hash: String(f.hash).substring(0, 8),
                    group: f.groupName
                }))
            });

            // Record fates for forced chunks
            for (const f of groupResult.debug.forced) {
                recordChunkFate(debugData, f.hash, 'groups', 'passed',
                    `Force-included by mandatory group "${f.groupName}"`,
                    { reason: f.reason }
                );
            }
        }

        // PERF: Build chunk metadata map ONCE and reuse for both virtual and explicit links
        const chunkMetadataMap = new Map();
        for (const chunk of processedChunks) {
            const meta = getChunkMetadata(chunk.hash) || {};
            chunkMetadataMap.set(String(chunk.hash), meta);
        }

        // If there are virtual links from inclusive groups, merge them with chunk metadata
        if (groupResult.virtualLinks && groupResult.virtualLinks.size > 0) {
            addTrace(debugData, 'groups', `Inclusive groups generated ${groupResult.debug.virtualLinksCreated} virtual links`, {});

            // Merge virtual links into metadata
            const mergedMetadata = mergeVirtualLinks(chunkMetadataMap, groupResult.virtualLinks);

            // Process links (both explicit and group-generated)
            const linkResult = processChunkLinks(processedChunks, mergedMetadata, settings.group_soft_boost || 0.15);
            processedChunks = linkResult.chunks;

            // Handle hard-linked chunks that need to be fetched
            // Note: Fetching missing hard-linked chunks would require additional backend calls
            // and complex deduplication logic. Currently, hard links only boost already-matched chunks.
            if (linkResult.missingHardLinks && linkResult.missingHardLinks.length > 0) {
                addTrace(debugData, 'groups', `Hard links require ${linkResult.missingHardLinks.length} additional chunks (not fetched)`, {
                    hashes: linkResult.missingHardLinks.map(h => String(h).substring(0, 8))
                });
            }

            // Log soft link boosts
            const boostedChunks = processedChunks.filter(c => c.softLinked);
            if (boostedChunks.length > 0) {
                addTrace(debugData, 'groups', `Soft links boosted ${boostedChunks.length} chunks`, {
                    boosted: boostedChunks.map(c => ({
                        hash: String(c.hash).substring(0, 8),
                        boost: c.linkBoost
                    }))
                });
            }
        } else {
            // No virtual links - process explicit chunk links only
            // Filter to only chunks with explicit links
            const chunksWithLinks = new Map();
            for (const [hash, meta] of chunkMetadataMap) {
                if (meta.links && meta.links.length > 0) {
                    chunksWithLinks.set(hash, meta);
                }
            }

            if (chunksWithLinks.size > 0) {
                const linkResult = processChunkLinks(processedChunks, chunksWithLinks, settings.group_soft_boost || 0.15);
                processedChunks = linkResult.chunks;

                const boostedByExplicitLinks = processedChunks.filter(c => c.softLinked && !c.groupBoosted);
                if (boostedByExplicitLinks.length > 0) {
                    addTrace(debugData, 'links', `Explicit links boosted ${boostedByExplicitLinks.length} chunks`, {});
                }
            }
        }
    }

    // Also process explicit chunk links when there are no groups at all
    // (This handles the case where allGroups.length === 0)
    if (allGroups.length === 0) {
        // PERF: Build metadata map once for chunks with links only
        const chunkMetadataMap = new Map();
        for (const chunk of processedChunks) {
            const meta = getChunkMetadata(chunk.hash) || {};
            if (meta.links && meta.links.length > 0) {
                chunkMetadataMap.set(String(chunk.hash), meta);
            }
        }

        if (chunkMetadataMap.size > 0) {
            const linkResult = processChunkLinks(processedChunks, chunkMetadataMap, settings.group_soft_boost || 0.15);
            processedChunks = linkResult.chunks;

            const boostedByExplicitLinks = processedChunks.filter(c => c.softLinked && !c.groupBoosted);
            if (boostedByExplicitLinks.length > 0) {
                addTrace(debugData, 'links', `Explicit links boosted ${boostedByExplicitLinks.length} chunks`, {});
            }
        }
    }

    addTrace(debugData, 'groups', 'Groups and links processing complete', {
        before: beforeCount,
        after: processedChunks.length,
        groupsProcessed: allGroups.length
    });

    return processedChunks;
}

/**
 * Stage 7: Deduplicate chunks already in chat context
 * Only checks against recent messages within the context window, not entire chat history.
 * @param {object[]} chunks Chunks to deduplicate
 * @param {object[]} chat Current chat messages
 * @param {object} settings VectHare settings (uses deduplication_depth)
 * @param {object} debugData Debug tracking object
 * @returns {{toInject: object[], skipped: object[]}} Chunks to inject and skipped duplicates
 */
function deduplicateChunks(chunks, chat, settings, debugData) {
    // Determine how far back to check for duplicates
    // Default to 50 messages if not specified (reasonable context window)
    const deduplicationDepth = settings.deduplication_depth ?? 50;

    addTrace(debugData, 'injection', 'Starting deduplication and injection', {
        chunksToInject: chunks.length,
        chatLength: chat.length,
        deduplicationDepth: deduplicationDepth
    });

    // Only check the most recent N messages (within context window)
    const recentMessages = deduplicationDepth > 0 && deduplicationDepth < chat.length
        ? chat.slice(-deduplicationDepth)
        : chat;

    console.log(`[VectHare Dedup] Building hash set from ${recentMessages.length} recent messages (depth: ${deduplicationDepth})`);
    console.log(`[VectHare Dedup] Total chat length: ${chat.length}, checking duplicates in last ${recentMessages.length} messages`);

    // Build set of hashes currently in chat context
    const currentChatHashes = new Set();
    const chatHashMap = new Map(); // For debugging: hash -> message preview

    recentMessages.forEach((msg, idx) => {
        if (msg.mes) {
            const cleanedText = substituteParams(getTextWithoutAttachments(msg));
            const hash = getStringHash(cleanedText);
            currentChatHashes.add(hash);

            // Store sample for debugging (first occurrence only)
            // Calculate absolute index in full chat
            const absoluteIndex = chat.length - recentMessages.length + idx;
            if (!chatHashMap.has(hash)) {
                chatHashMap.set(hash, {
                    index: absoluteIndex,
                    preview: cleanedText.substring(0, 80),
                    isUser: msg.is_user,
                    name: msg.name
                });
            }
        }
    });

    console.log(`[VectHare Dedup] Built hash set with ${currentChatHashes.size} unique message hashes from recent context`);

    const toInject = [];
    const skipped = [];

    for (const chunk of chunks) {
        const isInChat = currentChatHashes.has(chunk.hash);

        if (isInChat) {
            const matchedMsg = chatHashMap.get(chunk.hash);
            console.debug(`[VectHare Dedup] ❌ SKIPPING chunk (hash: ${chunk.hash})`);
            console.debug(`  Chunk text: "${chunk.text?.substring(0, 80)}..."`);
            console.debug(`  Matches chat message #${matchedMsg.index} from ${matchedMsg.name}: "${matchedMsg.preview}..."`);
            console.debug(`  Score: ${chunk.score?.toFixed(4)}, Collection: ${chunk.collectionId}`);

            skipped.push(chunk);
            recordChunkFate(debugData, chunk.hash, 'injection', 'skipped',
                'Already in current chat context - no injection needed',
                { score: chunk.score }
            );
        } else {
            console.debug(`[VectHare Dedup] ✅ KEEPING chunk (hash: ${chunk.hash}, score: ${chunk.score?.toFixed(4)})`);
            console.debug(`  Text: "${chunk.text?.substring(0, 80)}..."`);

            toInject.push(chunk);
            recordChunkFate(debugData, chunk.hash, 'injection', 'passed',
                'Not in current context - will inject',
                { score: chunk.score, collectionId: chunk.collectionId }
            );
        }
    }

    addTrace(debugData, 'injection', 'Deduplication complete', {
        totalChunks: chunks.length,
        toInject: toInject.length,
        skippedDuplicates: skipped.length
    });

    console.log(`[VectHare Dedup] FINAL: ${toInject.length} will inject, ${skipped.length} skipped as duplicates`);

    return { toInject, skipped };
}

/**
 * Builds the nested prompt structure with context and XML tags at each level.
 * Groups chunks by collection and applies wrapping in this order:
 * 1. Global wrapper (outermost)
 * 2. Collection wrapper (groups chunks from same collection)
 * 3. Chunk wrapper (innermost, per-chunk)
 *
 * @param {object[]} chunks Chunks to inject
 * @param {object} settings VectHare settings
 * @returns {string} Formatted injection text
 */
function buildNestedInjectionText(chunks, settings) {
    // Group chunks by collection
    const byCollection = new Map();
    for (const chunk of chunks) {
        const collId = chunk.collectionId || 'unknown';
        if (!byCollection.has(collId)) {
            byCollection.set(collId, []);
        }
        byCollection.get(collId).push(chunk);
    }

    // Build collection blocks
    const collectionBlocks = [];

    for (const [collectionId, collChunks] of byCollection) {
        // Get collection metadata for context/xmlTag
        const collMeta = getCollectionMeta(collectionId) || {};
        const collContext = collMeta.context ? substituteParams(collMeta.context) : '';
        const collXmlTag = collMeta.xmlTag || '';

        // Build chunk texts with per-chunk wrapping
        const chunkTexts = collChunks.map(chunk => {
            const chunkMeta = getChunkMetadata(chunk.hash) || {};
            const chunkContext = chunkMeta.context ? substituteParams(chunkMeta.context) : '';
            const chunkXmlTag = chunkMeta.xmlTag || '';
            const text = chunk.text || '(text not available)';

            // Build chunk with optional wrapping
            let chunkBlock = '';

            if (chunkContext) {
                chunkBlock += chunkContext + '\n';
            }

            if (chunkXmlTag) {
                chunkBlock += `<${chunkXmlTag}>\n${text}\n</${chunkXmlTag}>`;
            } else {
                chunkBlock += text;
            }

            return chunkBlock;
        });

        // Join chunks within this collection
        let collectionBlock = chunkTexts.join('\n\n');

        // Apply collection-level wrapping
        if (collContext) {
            collectionBlock = collContext + '\n\n' + collectionBlock;
        }

        if (collXmlTag) {
            collectionBlock = `<${collXmlTag}>\n${collectionBlock}\n</${collXmlTag}>`;
        }

        collectionBlocks.push(collectionBlock);
    }

    // Join all collection blocks
    let fullText = collectionBlocks.join('\n\n');

    // Apply global-level wrapping
    const globalContext = settings.rag_context ? substituteParams(settings.rag_context) : '';
    const globalXmlTag = settings.rag_xml_tag || '';

    if (globalContext) {
        fullText = globalContext + '\n\n' + fullText;
    }

    if (globalXmlTag) {
        fullText = `<${globalXmlTag}>\n${fullText}\n</${globalXmlTag}>`;
    }

    return fullText;
}

/**
 * Resolves the effective injection position for a chunk using cascade:
 * chunk → collection → global
 * @param {object} chunk Chunk with collectionId
 * @param {object} settings VectHare settings
 * @returns {{position: number, depth: number}} Resolved position and depth
 */
function resolveChunkInjectionPosition(chunk, settings) {
    const chunkMeta = getChunkMetadata(chunk.hash) || {};
    const collMeta = getCollectionMeta(chunk.collectionId) || {};

    // Cascade: chunk → collection → global
    const position = chunkMeta.position ?? collMeta.position ?? settings.position ?? 0;
    const depth = chunkMeta.depth ?? collMeta.depth ?? settings.depth ?? 2;

    return { position, depth };
}

/**
 * Stage 8: Format and inject chunks into prompt
 * Supports per-chunk/per-collection injection positions via cascade resolution.
 * Groups chunks by their resolved position+depth and creates separate injections.
 *
 * @param {object[]} chunksToInject Chunks to inject
 * @param {object} settings VectHare settings
 * @param {object} debugData Debug tracking object
 * @returns {{verified: boolean, text: string}} Injection result
 */
function injectChunksIntoPrompt(chunksToInject, settings, debugData) {
    // Control print: Log chunks QUEUED for injection (not yet injected)
    console.log(`[VectHare Injection Control] Preparing to inject ${chunksToInject.length} chunks`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    let emptyTextCount = 0;
    chunksToInject.forEach((chunk, idx) => {
        const textLength = chunk.text?.length || 0;
        const hasValidText = textLength > 0 && chunk.text !== '(text not found)' && chunk.text !== '(text not available)';
        if (!hasValidText) emptyTextCount++;

        console.log(`  [${idx + 1}/${chunksToInject.length}] CHUNK QUEUED FOR INJECTION ${!hasValidText ? '⚠️ EMPTY/INVALID TEXT' : ''}`);
        console.log(`      Hash: ${chunk.hash}`);
        console.log(`      Score: ${chunk.score?.toFixed(4)}`);
        console.log(`      Collection: ${chunk.collectionId}`);
        console.log(`      Text length: ${textLength} chars ${!hasValidText ? '⚠️' : '✓'}`);
        console.log(`      Text preview: "${chunk.text?.substring(0, 120)}${textLength > 120 ? '...' : ''}"`);
        console.log('      ─────────────────────────────────────────────────────────────────');
    });
    if (emptyTextCount > 0) {
        console.warn(`[VectHare Injection Control] ⚠️ WARNING: ${emptyTextCount}/${chunksToInject.length} chunks have empty or placeholder text!`);
    }
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    // Group chunks by resolved injection position+depth
    const positionGroups = new Map(); // "position:depth" → chunks[]

    for (const chunk of chunksToInject) {
        const { position, depth } = resolveChunkInjectionPosition(chunk, settings);
        const key = `${position}:${depth}`;

        if (!positionGroups.has(key)) {
            positionGroups.set(key, { position, depth, chunks: [] });
        }
        positionGroups.get(key).chunks.push(chunk);
    }

    // If all chunks go to the same position, use the simple single-injection path
    if (positionGroups.size === 1) {
        const [_, group] = [...positionGroups.entries()][0];
        const insertedText = buildNestedInjectionText(group.chunks, settings);

        console.log(`[VectHare Injection Control] Single position injection: position="${group.position}", depth=${group.depth}, chunks=${group.chunks.length}, textLength=${insertedText.length}`);
        console.log(`[VectHare Injection Control] Injection text preview: "${insertedText.substring(0, 200)}${insertedText.length > 200 ? '...' : ''}"`);

        setExtensionPrompt(EXTENSION_PROMPT_TAG, insertedText, group.position, group.depth, false);

        // Verify injection
        const verifiedPrompt = extension_prompts[EXTENSION_PROMPT_TAG];
        const injectionVerified = verifiedPrompt && verifiedPrompt.value === insertedText;

        console.log(`[VectHare Injection Control] Injection verification: ${injectionVerified ? '✓ PASSED' : '✗ FAILED'}`);
        console.log(`[VectHare Injection Control] extension_prompts[${EXTENSION_PROMPT_TAG}]:`, {
            exists: !!verifiedPrompt,
            valueLength: verifiedPrompt?.value?.length,
            position: verifiedPrompt?.position,
            depth: verifiedPrompt?.depth,
            valuePreview: verifiedPrompt?.value?.substring(0, 100)
        });

        if (!injectionVerified) {
            console.warn('VectHare: ⚠️ Injection verification failed!', {
                expected: insertedText.substring(0, 100) + '...',
                actual: verifiedPrompt?.value?.substring(0, 100) + '...',
                promptExists: !!verifiedPrompt
            });
        }

        // Record final fate for injected chunks
        group.chunks.forEach(chunk => {
            recordChunkFate(debugData, chunk.hash, 'final', 'injected', null, {
                score: chunk.score,
                collectionId: chunk.collectionId
            });
        });

        return { verified: injectionVerified, text: insertedText };
    }

    // Multiple injection positions - create separate extension prompts for each
    console.log(`[VectHare Injection Control] Multiple position injection: ${positionGroups.size} different positions`);

    // Clear the main tag first (will be unused when multi-position)
    setExtensionPrompt(EXTENSION_PROMPT_TAG, '', settings.position, settings.depth, false);

    let allVerified = true;
    const allTexts = [];
    let groupIndex = 0;

    for (const [key, group] of positionGroups) {
        // Build text for this position group (no global wrapper - that goes on outermost only)
        const groupSettings = { ...settings, rag_context: '', rag_xml_tag: '' };
        const groupText = buildNestedInjectionText(group.chunks, groupSettings);

        console.log(`[VectHare Injection Control] Position group ${groupIndex + 1}/${positionGroups.size}: key="${key}", chunks=${group.chunks.length}, textLength=${groupText.length}`);
        group.chunks.forEach((chunk, idx) => {
            console.log(`    [${idx + 1}/${group.chunks.length}] Hash: ${chunk.hash}, Score: ${chunk.score?.toFixed(4)}`);
        });

        // Use unique tag per position group
        const tag = `${EXTENSION_PROMPT_TAG}_pos${groupIndex}`;

        setExtensionPrompt(tag, groupText, group.position, group.depth, false);

        // Verify
        const verifiedPrompt = extension_prompts[tag];
        const verified = verifiedPrompt && verifiedPrompt.value === groupText;

        console.log(`[VectHare Injection Control] Position group ${groupIndex + 1} verification: ${verified ? '✓ PASSED' : '✗ FAILED'}`);

        if (!verified) {
            console.warn(`VectHare: ⚠️ Injection verification failed for position ${key}`, {
                tag,
                expected: groupText.substring(0, 100) + '...',
                actual: verifiedPrompt?.value?.substring(0, 100) + '...'
            });
            allVerified = false;
        }

        // Record fates
        group.chunks.forEach(chunk => {
            recordChunkFate(debugData, chunk.hash, 'final', 'injected', null, {
                score: chunk.score,
                collectionId: chunk.collectionId,
                position: group.position,
                depth: group.depth
            });
        });

        allTexts.push(groupText);
        groupIndex++;
    }

    console.log(`[VectHare Injection Control] Injection complete: ${allVerified ? '✓ All verified' : '✗ Some failed'}, ${allTexts.length} groups`);

    return {
        verified: allVerified,
        text: allTexts.join('\n\n---\n\n') // Combine for debug output
    };
}

// ============================================================================
// MAIN ORCHESTRATOR
// ============================================================================

/**
 * Searches for and injects relevant past messages from ALL enabled collections
 * This includes chat collections (if enabled_chats is true) AND any other
 * enabled collections like lorebooks, documents, character files, etc.
 *
 * @param {object[]} chat Current chat messages
 * @param {object} settings VectHare settings
 * @param {string} type Generation type
 */
export async function rearrangeChat(chat, settings, type) {
    console.log(`🐰 VectHare: rearrangeChat called (type: ${type}, chat length: ${chat?.length || 0})`);

    try {
        // === EARLY EXITS ===
        if (type === 'quiet') {
            console.debug('VectHare: Skipping quiet prompt');
            return;
        }

        // Clear extension prompts (main + any position-specific tags from previous run)
        setExtensionPrompt(EXTENSION_PROMPT_TAG, '', settings.position, settings.depth, false);
        // Clear position-specific tags (max 10 should be more than enough)
        for (let i = 0; i < 10; i++) {
            const posTag = `${EXTENSION_PROMPT_TAG}_pos${i}`;
            if (extension_prompts[posTag]) {
                setExtensionPrompt(posTag, '', 0, 0, false);
            }
        }

        if (!getCurrentChatId() || !Array.isArray(chat)) {
            console.debug('VectHare: No chat selected');
            return;
        }

        const minChatLength = settings.min_chat_length ?? 0;
        if (minChatLength > 0 && chat.length < minChatLength) {
            console.warn(`⚠️ VectHare: Not enough messages to inject chunks (${chat.length} < ${minChatLength})`);
            console.log(`   💡 You need at least ${minChatLength} messages before chunk injection starts`);
            return;
        }

        // === STAGE 1: Gather collections to query ===
        const collectionsToQuery = gatherCollectionsToQuery(settings);
        // Allow continuing with WI-only mode if enabled_world_info is set
        const hasCollections = collectionsToQuery.length > 0;
        const canQueryWI = settings.enabled_world_info;

        if (!hasCollections && !canQueryWI) {
            console.warn('⚠️ VectHare: No enabled collections to query and World Info disabled - chunks cannot be injected!');
            console.log('   💡 Make sure you have enabled at least one collection in VectHare settings, or enable World Info');
            return;
        }
        if (hasCollections) {
            console.log(`VectHare: Will query ${collectionsToQuery.length} collections:`, collectionsToQuery);
        } else {
            console.log('VectHare: No regular collections enabled, but World Info is enabled - will query lorebooks only');
        }

        // === STAGE 2: Build search query ===
        const queryText = buildSearchQuery(chat, settings);
        if (queryText.length === 0) {
            console.debug('VectHare: No text to query');
            return;
        }

        // === STAGE 2.5: Extract keywords from query message ===
        const extractionLevel = settings.keyword_extraction_level || 'balanced';
        const queryKeywords = extractChatKeywords(queryText, {
            level: extractionLevel,
            baseWeight: settings.keyword_boost_base_weight || 1.5
        });
        const queryKeywordTexts = queryKeywords.map(kw => kw.text.toLowerCase());
        console.log(`VectHare: Extracted ${queryKeywords.length} keywords from query:`, queryKeywordTexts);

        // === STAGE 3: Filter by activation conditions ===
        let activeCollections = [];
        if (hasCollections) {
            const searchContext = buildSearchContext(chat, settings.query || 10, [], {
                generationType: type || 'normal',
                isGroupChat: getContext().groupId != null,
                currentCharacter: getContext().name2 || null,
                activeLorebookEntries: [],
                currentChatId: getCurrentChatId(),
                currentCharacterId: getContext().characterId || null
            });
            activeCollections = await filterActiveCollections(collectionsToQuery, searchContext);
        }

        // Allow WI-only mode even if no regular collections pass filters
        if (activeCollections.length === 0 && !canQueryWI) {
            console.log('⚠️ VectHare: No collections passed activation conditions and World Info disabled - chunks cannot be injected!');
            console.log('   💡 Check your collection activation conditions in VectHare settings');
            return;
        }
        if (activeCollections.length > 0) {
            console.log(`✅ VectHare: ${activeCollections.length} collections passed activation filters:`, activeCollections);
        }

        // === INITIALIZE DEBUG DATA ===
        const debugData = createDebugData();
        debugData.query = queryText;
        debugData.queryKeywords = queryKeywordTexts;
        debugData.collectionId = activeCollections.length > 0 ? activeCollections.join(', ') : 'world_info_only';
        debugData.collectionsQueried = activeCollections;
        const effectiveTopK = settings.top_k ?? settings.insert;
        debugData.settings = {
            threshold: settings.score_threshold,
            topK: effectiveTopK,
            temporal_decay: settings.temporal_decay,
            protect: settings.protect,
            chatLength: chat.length
        };

        addTrace(debugData, 'init', 'Pipeline started', {
            collectionsQueried: activeCollections,
            queryLength: queryText.length,
            threshold: settings.score_threshold,
            topK: effectiveTopK,
            protect: settings.protect
        });

        // === STAGE 4: Query all collections and merge results ===
        if (settings.retrieval_popup_on_start) {
            toastr.info(`Retrieving context from ${activeCollections.length} collection(s)...`, 'VectHarePlus Retrieval');
        }

        let chunks = await queryAndMergeCollections(activeCollections, queryText, settings, chat, debugData);

        if (settings.retrieval_popup_on_result) {
            toastr.success(`Retrieved ${chunks.length} result(s) from backend`, 'VectHarePlus Retrieval');
        }

        // === STAGE 4.3: Boost chunks with matching query keywords ===
        if (queryKeywordTexts.length > 0 && chunks.length > 0) {
            let keywordMatchCount = 0;

            for (const chunk of chunks) {
                // Get chunk keywords from metadata
                const chunkKeywords = (chunk.metadata?.keywords || [])
                    .map(kw => (typeof kw === 'object' ? kw.text : kw)?.toLowerCase())
                    .filter(Boolean);

                // Check if chunk has any matching keywords
                const matchedKeywords = queryKeywordTexts.filter(qk => chunkKeywords.includes(qk));

                if (matchedKeywords.length > 0) {
                    // Chunk matches query keywords - boost to perfect hit
                    const oldScore = chunk.score;
                    chunk.keywordMatched = true;
                    chunk.matchedQueryKeywords = matchedKeywords;
                    chunk.score = 1.0; // 100% perfect match
                    chunk.originalScore = oldScore;
                    keywordMatchCount++;

                    addTrace(debugData, 'keyword_boost', `Chunk boosted by ${matchedKeywords.length} keyword(s)`, {
                        hash: chunk.hash,
                        matchedKeywords,
                        newScore: 1.0,
                        oldScore
                    });
                }
            }

            if (keywordMatchCount > 0) {
                console.log(`VectHare: Boosted ${keywordMatchCount}/${chunks.length} chunks with matching keywords to 100% score`);
                debugData.stages.afterKeywordBoost = [...chunks];
                debugData.stats.keywordBoosted = keywordMatchCount;
                addTrace(debugData, 'keyword_boost', `Boosted ${keywordMatchCount} chunks with keyword matches`, {
                    totalChunks: chunks.length,
                    boostedCount: keywordMatchCount
                });
            } else {
                console.log(`VectHare: No chunks matched query keywords, all ${chunks.length} chunks keep original scores`);
            }
        }

        // === WORLD INFO: Semantic WI entries ===
        try {
            if (settings.enabled_world_info) {
                // Build recentMessages array for WI query
                const recentMessages = chat
                    .filter(x => !x.is_system)
                    .reverse()
                    .slice(0, settings.world_info_query_depth || settings.query)
                    .map(x => substituteParams(x.mes));

                const wiEntries = await getSemanticWorldInfoEntries(recentMessages, [], settings);
                if (Array.isArray(wiEntries) && wiEntries.length > 0) {
                    addTrace(debugData, 'world_info', `Found ${wiEntries.length} semantic WI entries`, { entries: wiEntries.map(e => ({ uid: e.uid, score: e.score })) });

                    // Convert WI entries into chunk-like objects and merge
                    const wiChunks = wiEntries.map(e => {
                        const hash = String(e.uid || getStringHash(e.content || e.key || ''));
                        return {
                            hash,
                            metadata: e.metadata || {},
                            score: e.score || 1.0,
                            originalScore: e.score || 1.0,
                            similarity: e.score || 1.0,
                            text: e.content || (Array.isArray(e.key) ? e.key.join(' ') : e.key || ''),
                            index: 0,
                            collectionId: e.collectionId || `vecthare_wi:${e.lorebookName || 'lorebook'}`,
                            decayApplied: false
                        };
                    });

                    // Prepend WI chunks so they get considered equally in downstream stages
                    chunks = wiChunks.concat(chunks);
                    debugData.stages.worldInfo = wiChunks;
                }
            }
        } catch (wiError) {
            console.warn('VectHare: WorldInfo semantic integration failed', wiError.message);
            addTrace(debugData, 'world_info', 'WorldInfo query failed', { error: wiError.message });
        }
        console.log(`VectHare: Retrieved ${chunks.length} total chunks from ${activeCollections.length} collections`);

        debugData.stages.initial = [...chunks];
        debugData.stats.retrievedFromVector = chunks.length;

        // === STAGE 4.5: Expand summary chunks to parent chunks (dual-vector) ===
        const chunksBeforeExpansion = chunks.length;
        chunks = await expandSummaryChunks(chunks, activeCollections, settings, debugData);
        if (chunks.length !== chunksBeforeExpansion || chunks.some(c => c.expandedFromSummary)) {
            const expandedCount = chunks.filter(c => c.expandedFromSummary).length;
            console.log(`VectHare: Expanded ${expandedCount} summary chunks to parent text`);
            debugData.stages.afterSummaryExpansion = [...chunks];
            debugData.stats.summariesExpanded = expandedCount;
        }

        // === STAGE 5: BananaBread reranking (optional) ===
        if (settings.source === 'bananabread' && settings.bananabread_rerank && chunks.length > 0) {
            addTrace(debugData, 'rerank', 'Starting BananaBread reranking', {
                chunks: chunks.length,
                query: queryText.substring(0, 100)
            });
            chunks = await rerankWithBananaBread(queryText, chunks, settings);
            debugData.stages.afterRerank = [...chunks];
            addTrace(debugData, 'rerank', 'Reranking complete', { rerankedCount: chunks.length });
        }

        // === STAGE 6: Threshold filter ===
        const threshold = settings.score_threshold || 0;
        chunks = applyThresholdFilter(chunks, threshold, debugData);
        debugData.stages.afterThreshold = [...chunks];

        // === STAGE 7: Temporal decay ===
        chunks = applyTemporalDecayStage(chunks, chat, settings, threshold, debugData);
        debugData.stages.afterDecay = [...chunks];
        debugData.stats.afterDecay = chunks.length;

        // === STAGE 8: Chunk conditions ===
        chunks = await applyConditionsStage(chunks, chat, settings, debugData);
        debugData.stages.afterConditions = [...chunks];
        debugData.stats.afterConditions = chunks.length;

        // === STAGE 8.5: Chunk Groups and Links ===
        chunks = await applyGroupsAndLinksStage(chunks, activeCollections, settings, debugData);
        debugData.stages.afterGroups = [...chunks];
        debugData.stats.afterGroups = chunks.length;

        // Store for legacy visualizer
        window.VectHare_LastSearch = {
            chunks: chunks,
            query: queryText,
            timestamp: Date.now(),
            settings: { threshold: settings.score_threshold, topK: (settings.top_k ?? settings.insert), temporal_decay: settings.temporal_decay }
        };
        console.log(`VectHare: Stored ${chunks.length} chunks for visualizer`);

        // === STAGE 9: Deduplicate ===
        console.log(`[VectHare Deduplication] Starting with ${chunks.length} chunks before deduplication`);
        console.log(`[VectHare Deduplication] Current chat has ${chat.length} messages`);

        const { toInject: chunksToInject, skipped: skippedDuplicates } = deduplicateChunks(chunks, chat, settings, debugData);

        console.log(`[VectHare Deduplication] After deduplication: ${chunksToInject.length} to inject, ${skippedDuplicates.length} skipped`);
        if (skippedDuplicates.length > 0) {
            console.log(`[VectHare Deduplication] Skipped chunks (already in chat):`);
            skippedDuplicates.forEach((chunk, idx) => {
                console.log(`  [${idx + 1}] Hash: ${chunk.hash}, Score: ${chunk.score?.toFixed(4)}, Text: "${chunk.text?.substring(0, 80)}..."`);
            });
        }

        if (chunksToInject.length === 0) {
            console.log('ℹ️ VectHare: All retrieved chunks already in context, nothing to inject');
            console.log(`   ${skippedDuplicates.length} chunks were skipped (already in current chat)`);
            console.info('[VectHare] Injection blocked: All retrieved chunks are already present in the current chat context. Adjust temporal decay or query depth if you want older messages.');
            debugData.stages.injected = [];
            debugData.stats.actuallyInjected = 0;
            debugData.stats.skippedDuplicates = skippedDuplicates.length;
            addTrace(debugData, 'injection', 'PIPELINE COMPLETE - NO INJECTION NEEDED', {
                reason: 'All chunks already in current context',
                skippedCount: skippedDuplicates.length
            });
            setLastSearchDebug(debugData);
            return;
        }

        console.log(`[VectHare Deduplication] ✅ ${chunksToInject.length} chunks will proceed to injection`);

        // === STAGE 10: Inject into prompt ===
        const injection = injectChunksIntoPrompt(chunksToInject, settings, debugData);

        console.log(`\n✅ VectHare: Successfully injected ${chunksToInject.length} chunk(s) into prompt`);
        console.log(`   Verification: ${injection.verified ? '✓ PASSED' : '✗ FAILED'}`);
        console.log(`   Total characters injected: ${injection.text.length}\n`);

        // Finalize debug data
        debugData.stages.injected = chunksToInject;
        debugData.stats.actuallyInjected = chunksToInject.length;
        debugData.stats.skippedDuplicates = skippedDuplicates.length;
        debugData.injection = {
            verified: injection.verified,
            text: injection.text,
            position: settings.position,
            depth: settings.depth,
            promptTag: EXTENSION_PROMPT_TAG,
            charCount: injection.text.length
        };

        addTrace(debugData, 'final', 'PIPELINE COMPLETE - SUCCESS', {
            injectedCount: chunksToInject.length,
            skippedDuplicates: skippedDuplicates.length,
            injectedHashes: chunksToInject.map(c => c.hash),
            totalTokens: injection.text.length,
            position: settings.position,
            depth: settings.depth,
            verified: injection.verified
        });

        setLastSearchDebug(debugData);
        console.log(`VectHare: ✅ Injected ${chunksToInject.length} chunks (${skippedDuplicates.length} skipped - already in context)`);

    } catch (error) {
        toastr.error(`Generation interceptor aborted: ${error.message}`, 'VectHare');
        console.error('VectHare: Failed to rearrange chat', error);
    }
}

/**
 * Vectorizes entire chat
 * @param {object} settings VectHare settings
 * @param {number} batchSize Batch size
 */
export async function vectorizeAll(settings, batchSize, abortSignal = null) {
    try {
        if (!settings.enabled_chats) {
            return;
        }

        const chatId = getCurrentChatId();
        if (!chatId) {
            toastr.info('No chat selected', 'Vectorization aborted');
            return;
        }

        // Pre-flight check: verify backend is available before starting
        const backendName = settings.vector_backend || 'standard';
        const backendAvailable = await isBackendAvailable(backendName, settings);
        if (!backendAvailable) {
            toastr.error(
                `Backend "${backendName}" is not available. Check your settings or start the backend service.`,
                'Vectorization aborted'
            );
            console.error(`VectHare: Backend ${backendName} failed health check before vectorization`);
            return;
        }

        // Calculate total messages to vectorize
        const context = getContext();
        const totalMessages = context.chat ? context.chat.filter(x => !x.is_system).length : 0;

        // Show progress panel
        progressTracker.show('Vectorizing Chat', totalMessages, 'Messages');

        let finished = false;
        let iteration = 0;
        let processedCount = 0;
        let totalChunks = 0;

        while (!finished) {
            if (abortSignal?.aborted) {
                progressTracker.complete(false, 'Stopped by user');
                return;
            }
            if (is_send_press) {
                toastr.info('Message generation is in progress.', 'Vectorization aborted');
                progressTracker.complete(false, 'Aborted - message generation in progress');
                throw new Error('Message generation in progress');
            }

            const result = await synchronizeChat(settings, batchSize);

            // Handle disabled/blocked state
            if (result.remaining === -1) {
                console.log('VectHare: Vectorization blocked or disabled');
                progressTracker.complete(false, 'Blocked or disabled');
                return;
            }

            finished = result.remaining <= 0;
            iteration++;

            // Update progress with actual counts
            processedCount += result.messagesProcessed;
            totalChunks += result.chunksCreated;

            progressTracker.updateProgress(
                processedCount,
                result.remaining > 0 ? `Processing... ${result.remaining} messages remaining` : 'Finalizing...'
            );
            progressTracker.updateChunks(totalChunks);

            console.log(`VectHare: Vectorization iteration ${iteration}, ${result.remaining > 0 ? result.remaining + ' remaining' : 'complete'} (${result.chunksCreated} chunks this batch)`);

            if (chatId !== getCurrentChatId()) {
                progressTracker.complete(false, 'Chat changed during vectorization');
                throw new Error('Chat changed');
            }
        }

        progressTracker.complete(true, `Vectorized ${processedCount} messages (${totalChunks} chunks)`);
        toastr.success('Chat vectorized successfully', 'VectHare');
        console.log(`VectHare: ✅ Vectorization complete after ${iteration} iterations`);
    } catch (error) {
        console.error('VectHare: Failed to vectorize all', error);
        progressTracker.addError(error.message);
        progressTracker.complete(false, 'Vectorization failed');
        toastr.error(`Vectorization failed: ${error.message}`, 'VectHare');
    }
}

/**
 * Purges vector index for current chat
 * @param {object} settings VectHare settings
 */
export async function purgeChatIndex(settings) {
    if (!getCurrentChatId()) {
        toastr.info('No chat selected', 'Purge aborted');
        return;
    }

    const collectionId = getChatCollectionId();
    if (!collectionId) {
        toastr.error('Could not get collection ID', 'Purge aborted');
        return;
    }

    if (await purgeVectorIndex(collectionId, settings)) {
        toastr.success('Vector index purged', 'VectHare');
        console.log('VectHare: Index purged successfully');
    } else {
        toastr.error('Failed to purge vector index', 'VectHare');
    }
}
