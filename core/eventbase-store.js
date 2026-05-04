/**
 * ============================================================================
 * EVENTBASE STORE
 * ============================================================================
 * Qdrant insert / query / list / delete wrappers for EventBase collections.
 * All operations target a per-chat EventBase collection, isolated from the
 * legacy chunk collection.
 * ============================================================================
 */

import {
    insertVectorItems,
    queryCollection,
    deleteVectorItems,
    getAdditionalArgs,
    getSavedHashes,
} from './core-vector-api.js';
import { getChatUUID, buildEventBaseCollectionId } from './collection-ids.js';
import { registerCollection } from './collection-loader.js';
import { buildEmbedText } from './eventbase-schema.js';

// Re-export so callers can import from here if needed
export { buildEventBaseCollectionId };

// ---------------------------------------------------------------------------
// Insert
// ---------------------------------------------------------------------------

/**
 * Embed and insert a batch of validated EventRecord objects into Qdrant.
 * Each event gets its own Qdrant point (vector = embed_text embedding, payload = full record).
 *
 * @param {object[]} events      - Array of full EventRecord objects (with ingestion metadata)
 * @param {object}   settings    - VectHare settings
 * @param {AbortSignal|null} [abortSignal]
 * @returns {Promise<void>}
 */
export async function insertEvents(events, settings, abortSignal = null) {
    if (!events?.length) return;

    const chatUUID = events[0].chat_uuid;
    const collectionId = buildEventBaseCollectionId(chatUUID, settings?.vector_backend);
    if (!collectionId) throw new Error('EventBase: Cannot build collection ID — no active chat');

    const debugLog = settings.eventbase_debug_logging;

    // Build embed texts for all events at once (for efficient batched embedding)
    const embedTexts = events.map(e => buildEmbedText(e));

    // Generate embeddings (reuses same provider/model as legacy path)
    const additionalArgs = await getAdditionalArgs(embedTexts, settings);
    const clientEmbeddings = additionalArgs.embeddings || null;

    // Build insertable items
    const items = events.map((event, idx) => {
        const embedText = embedTexts[idx];
        const hash = _eventHash(event.event_id);
        const vector = clientEmbeddings?.[embedText] || null;

        return {
            hash,
            text: embedText,
            index: idx,
            vector,             // null → server-side embedding
            // Top-level fields read by qdrant.js's payload builder.
            // qdrant.js spreads item.metadata first then explicitly overwrites these
            // fields from the top-level item. Without them defined here, they are
            // undefined → JSON.stringify drops them → Similharity server applies its
            // own defaults (importance=100, summary=null). EventBase does not use the
            // legacy chunk fields (chunkGroup, conditions, parentHash) so they stay null.
            importance: event.importance,
            summary: event.summary,
            keywords: event.keywords || [],
            customWeights: [],
            disabledKeywords: [],
            chunkGroup: null,
            conditions: null,
            isSummaryChunk: false,
            parentHash: null,
            metadata: {
                ...event,
                embed_text: embedText,
                eventbase: true,        // marker for filter queries
                eventbase_schema_version: event.schema_version,
            },
        };
    });

    if (debugLog) {
        console.log(`[EventBase] Inserting ${items.length} event(s) into collection "${collectionId}"`);
    }

    await insertVectorItems(collectionId, items, settings, null, abortSignal);

    // Register collection so it appears in the registry / DB browser
    await registerCollection(collectionId, settings);

    if (debugLog) {
        console.log(`[EventBase] Insert complete for collection "${collectionId}"`);
    }
}

// ---------------------------------------------------------------------------
// Query (for retrieval)
// ---------------------------------------------------------------------------

/**
 * Query the EventBase collection for events semantically similar to searchText.
 * Returns raw metadata array sorted by score (descending).
 *
 * @param {string} searchText
 * @param {number} topK
 * @param {object} settings
 * @param {string} [chatUUID]
 * @returns {Promise<object[]>}  Array of event metadata objects with `.score`
 */
export async function queryEvents(searchText, topK, settings, chatUUID) {
    const uuid = chatUUID || getChatUUID();
    const collectionId = await _resolveEventBaseCollectionIdForRead(settings, uuid);
    if (!collectionId) return [];

    const { hashes, metadata } = await queryCollection(collectionId, searchText, topK, settings);
    if (!hashes?.length) return [];

    // Attach hash to each metadata item for dedup / downstream use
    return metadata.map((meta, i) => ({
        ...meta,
        _hash: hashes[i],
    }));
}

// ---------------------------------------------------------------------------
// List (for Event Browser)
// ---------------------------------------------------------------------------

/**
 * List all stored events for the current chat.
 * @param {object} settings
 * @param {number} [limit]
 * @param {string} [chatUUID]
 * @returns {Promise<object[]>}
 */
export async function listEvents(settings, limit = 100, chatUUID) {
    // Reuse queryEvents with a broad query (empty string → backend returns recent/all items)
    // We overfetch and return up to `limit` items.
    return queryEvents('', Math.min(limit, 200), settings, chatUUID);
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

/**
 * Delete a stored event by its numeric hash.
 * @param {number} hash
 * @param {object} settings
 * @param {string} [chatUUID]
 * @returns {Promise<void>}
 */
export async function deleteEventByHash(hash, settings, chatUUID) {
    const uuid = chatUUID || getChatUUID();
    const collectionId = await _resolveEventBaseCollectionIdForRead(settings, uuid);
    if (!collectionId) return;

    await deleteVectorItems(collectionId, [hash], settings);
}

// ---------------------------------------------------------------------------
// Deduplication check
// ---------------------------------------------------------------------------

/**
 * Check which event IDs already exist in the collection for the given source
 * message hash set. Returns a Set of existing event_id strings.
 * Used by the ingestion pipeline to skip already-processed windows.
 *
 * NOTE: This is a best-effort check — it queries by overlap in
 * source_message_hashes. If Qdrant returns relevant existing events we
 * compare their source_message_hashes to find exact-coverage matches.
 *
 * @param {number[]} sourceHashes   - Hashes of messages in the candidate window
 * @param {number[]} messageIds     - 0-based message indices in the window
 * @param {object}   settings
 * @param {string}   [chatUUID]
 * @returns {Promise<boolean>}  true if this exact window is fully covered
 */
export async function isWindowAlreadyExtracted(sourceHashes, messageIds, settings, chatUUID) {
    if (!sourceHashes?.length) return false;

    try {
        const uuid = chatUUID || getChatUUID();
        const collectionId = await _resolveEventBaseCollectionIdForRead(settings, uuid);
        if (!collectionId) return false;

        // Query with a broad overfetch to find candidate events from this window
        // Use a dummy non-empty search text to avoid hybrid search errors when collection is empty
        const { metadata } = await queryCollection(collectionId, 'event', 50, settings);
        if (!metadata?.length) return false;

        const windowHashSet = new Set(sourceHashes.map(String));

        for (const meta of metadata) {
            const stored = meta.source_message_hashes;
            if (!Array.isArray(stored) || stored.length !== sourceHashes.length) continue;

            const storedSet = new Set(stored.map(String));
            let fullMatch = true;
            for (const h of windowHashSet) {
                if (!storedSet.has(h)) { fullMatch = false; break; }
            }
            if (fullMatch) return true;
        }
    } catch {
        // Dedup check is best-effort; don't abort ingestion on failure
    }

    return false;
}

/**
 * Resolve which EventBase collection ID to read from.
 * Prefers new backend-scoped ID, but falls back to legacy no-backend ID
 * so existing users can still read old data without re-vectorizing.
 *
 * @param {object} settings
 * @param {string} [chatUUID]
 * @returns {Promise<string|null>}
 */
async function _resolveEventBaseCollectionIdForRead(settings, chatUUID) {
    const uuid = chatUUID || getChatUUID();
    if (!uuid) return null;

    const backendScopedId = buildEventBaseCollectionId(uuid, settings?.vector_backend);
    const legacyId = buildEventBaseCollectionId(uuid);

    if (!backendScopedId) return legacyId || null;

    try {
        const scopedHashes = await getSavedHashes(backendScopedId, settings);
        if (scopedHashes?.length > 0) return backendScopedId;
    } catch {
        // Ignore and try legacy fallback.
    }

    // If no backend-scoped data exists yet, read legacy collection if present.
    if (legacyId && legacyId !== backendScopedId) {
        try {
            const legacyHashes = await getSavedHashes(legacyId, settings);
            if (legacyHashes?.length > 0) return legacyId;
        } catch {
            // Ignore; we'll return backend-scoped ID for future writes/reads.
        }
    }

    return backendScopedId;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Deterministic numeric hash for an event_id string.
 * Uses the same djb2 algorithm as bm25-scorer.js / chat-vectorization.js.
 * @param {string} id
 * @returns {number}
 */
function _eventHash(id) {
    let h = 5381;
    for (let i = 0; i < id.length; i++) {
        h = ((h << 5) + h) ^ id.charCodeAt(i);
        h >>>= 0;
    }
    return h;
}
