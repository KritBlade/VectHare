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
import { getCurrentChatId, chat_metadata, saveSettingsDebounced } from '../../../../../script.js';
import { extension_settings } from '../../../../extensions.js';
import { getChatUUID, buildEventBaseCollectionId, getRegistryBackend, COLLECTION_PREFIXES, parseRegistryKey } from './collection-ids.js';
import { registerCollection, getCollectionRegistry } from './collection-loader.js';
import { setCollectionLock } from './collection-metadata.js';
import { buildEmbedText } from './eventbase-schema.js';

// Re-export so callers can import from here if needed
export { buildEventBaseCollectionId };

// In-memory Set cache for O(1) window dedup lookups.
// Backed by the serialized array in extension_settings (which survives reload).
// Built lazily on first access per chat UUID.
const _windowCacheSet = new Map(); // chatUUID → Set<fingerprint>

// ---------------------------------------------------------------------------
// Insert
// ---------------------------------------------------------------------------

/**
 * Embed and insert a batch of validated EventRecord objects into Qdrant.
 * Each event gets its own Qdrant point (vector = embedText embedding, payload = full record).
 *
 * @param {object[]} events      - Array of full EventRecord objects (with ingestion metadata)
 * @param {object}   settings    - VectHare settings
 * @param {AbortSignal|null} [abortSignal]
 * @returns {Promise<void>}
 */
export async function insertEvents(events, settings, abortSignal = null, collectionIdOverride = null) {
    if (!events?.length) return;

    const chatUUID = events[0].chat_uuid;
    const collectionId = collectionIdOverride || buildEventBaseCollectionId(chatUUID, settings?.vector_backend);
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

        // The summary string lives inside `text` (first line, after the [event_type] prefix).
        // Storing it again as a separate field is pure duplication, so we strip it from both
        // the top-level item and the metadata spread before sending to the backend.
        const { summary: _droppedSummary, ...eventWithoutSummary } = event;

        return {
            hash,
            text: embedText,
            index: event.source_window_start != null ? event.source_window_start + 1 : idx + 1, // 1-based source message index for browser display
            vector,             // null → server-side embedding
            // Top-level fields read by qdrant.js's payload builder.
            // qdrant.js spreads item.metadata first then explicitly overwrites these
            // fields from the top-level item. Without them defined here, they are
            // undefined → JSON.stringify drops them → Similharity server applies its
            // own defaults (importance=100). EventBase does not use the legacy chunk
            // fields (chunkGroup, conditions, parentHash) so they stay null.
            importance: event.importance,
            keywords: event.keywords || [],
            customWeights: [],
            disabledKeywords: [],
            chunkGroup: null,
            conditions: null,
            isSummaryChunk: false,
            parentHash: null,
            metadata: {
                ...eventWithoutSummary,
                eventbase: true,        // marker for filter queries
                eventbase_schema_version: event.schema_version,
            },
        };
    });

    if (debugLog) {
        console.log(`[EventBase] Inserting ${items.length} event(s) into collection "${collectionId}"`);
    }

    await insertVectorItems(collectionId, items, settings, null, abortSignal);

    // Register collection so it appears in the registry / DB browser.
    // Use backend:collectionId format so the key survives plugin-based discovery
    // (which only knows about vectra/standard collections, not qdrant).
    const registryBackend = getRegistryBackend(settings?.vector_backend);
    const registryKey = `${registryBackend}:${collectionId}`;
    registerCollection(registryKey);

    // Auto-lock live EventBase collections to the current chat after first insert.
    // Archive event collections are NOT auto-locked — users must enable them manually
    // via the "Active for current chat" checkbox on the collection card.
    const isArchive = collectionId.startsWith(COLLECTION_PREFIXES.VECTHARE_ARCHIVE_EVENT);
    const currentChatId = getCurrentChatId();
    if (!isArchive && currentChatId) {
        setCollectionLock(collectionId, currentChatId);
        if (debugLog) {
            console.log(`[EventBase] Locked collection "${collectionId}" to current chat "${currentChatId}"`);
        }
    }

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

    const ebSettings = { ...settings, keyword_scoring_method: settings.eventbase_keyword_scoring_method || 'bm25' };
    const { hashes, metadata } = await queryCollection(collectionId, searchText, topK, ebSettings);
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
// ---------------------------------------------------------------------------
// Window fingerprint cache (stored in extension_settings, keyed by chatUUID)
// ---------------------------------------------------------------------------

/**
 * Returns a stable string fingerprint for a window from its source hashes.
 * @param {number[]} sourceHashes
 * @returns {string}
 */
export function windowFingerprint(sourceHashes) {
    return [...sourceHashes].map(String).sort().join(',');
}

/**
 * Marks a window as extracted. Stored in extension_settings so it survives
 * page reloads without requiring a chat save.
 * @param {number[]} sourceHashes
 * @param {string} [chatUUID]
 */
export function markWindowExtracted(sourceHashes, chatUUID) {
    if (!sourceHashes?.length) return;
    const uuid = chatUUID || getChatUUID();
    if (!uuid) return;

    const store = extension_settings.vecthareplus;
    if (!store) return;
    if (!store.eventbase_extracted_windows) store.eventbase_extracted_windows = {};
    if (!store.eventbase_extracted_windows[uuid]) store.eventbase_extracted_windows[uuid] = [];

    const fp = windowFingerprint(sourceHashes);

    // Update the in-memory Set first (O(1) check)
    if (!_windowCacheSet.has(uuid)) {
        _windowCacheSet.set(uuid, new Set(store.eventbase_extracted_windows[uuid]));
    }
    const set = _windowCacheSet.get(uuid);
    if (!set.has(fp)) {
        set.add(fp);
        store.eventbase_extracted_windows[uuid].push(fp);
        saveSettingsDebounced();
    }
}

/**
 * Clears the extraction cache for a specific chat.
 * Call this whenever an EventBase collection is deleted so that
 * the next vectorization run starts fresh.
 * @param {string} [chatUUID]
 */
export function clearWindowCacheForChat(chatUUID) {
    const uuid = chatUUID || getChatUUID();
    if (!uuid) return;
    const store = extension_settings?.vecthareplus;
    if (!store?.eventbase_extracted_windows) return;
    delete store.eventbase_extracted_windows[uuid];
    _windowCacheSet.delete(uuid);
    saveSettingsDebounced();
}

/**
 * Quick-exit check: returns true if the LAST complete window in the message list
 * is already extracted. When true, all prior windows are also done (windows are
 * always processed in-order from the tail). Avoids building O(n) window objects.
 *
 * @param {object[]} messages  - Filtered message array (same as passed to runEventBaseIngestion)
 * @param {number}   windowSize
 * @param {number}   step       - windowSize - windowOverlap
 * @param {string}   [chatUUID]
 * @param {Function} hashFn     - (message) => number hash for that message
 * @returns {boolean}
 */
export function isLastWindowExtracted(messages, windowSize, step, chatUUID, hashFn) {
    const uuid = chatUUID;
    if (!uuid || messages.length < windowSize) return false;

    const totalPossible = Math.floor((messages.length - windowSize) / step) + 1;
    if (totalPossible <= 0) return false;

    const lastStart = (totalPossible - 1) * step;
    const lastMsgs = messages.slice(lastStart, lastStart + windowSize);
    if (lastMsgs.length < windowSize) return false;

    const hashes = lastMsgs.map(hashFn);

    if (!_windowCacheSet.has(uuid)) {
        const arr = extension_settings?.vecthareplus?.eventbase_extracted_windows?.[uuid];
        _windowCacheSet.set(uuid, new Set(Array.isArray(arr) ? arr : []));
    }

    return _windowCacheSet.get(uuid).has(windowFingerprint(hashes));
}

/**
 * Checks whether a window has already been extracted (O(1), no DB query).
 * Uses an in-memory Set keyed by chatUUID; built lazily from the persisted array.
 *
 * @param {number[]} sourceHashes
 * @param {number[]} messageIds     - unused, kept for API compat
 * @param {object}   settings       - unused, kept for API compat
 * @param {string}   [chatUUID]
 * @returns {Promise<boolean>}
 */
export async function isWindowAlreadyExtracted(sourceHashes, messageIds, settings, chatUUID) {
    if (!sourceHashes?.length) return false;
    const uuid = chatUUID || getChatUUID();
    if (!uuid) return false;

    // Build the Set from the persisted array on first access for this chat
    if (!_windowCacheSet.has(uuid)) {
        const arr = extension_settings?.vecthareplus?.eventbase_extracted_windows?.[uuid];
        _windowCacheSet.set(uuid, new Set(Array.isArray(arr) ? arr : []));
    }

    const fp = windowFingerprint(sourceHashes);
    return _windowCacheSet.get(uuid).has(fp);  // O(1)
}

/**
 * Find every EventBase collection registered for the given chat UUID.
 *
 * The registry — not `buildEventBaseCollectionId` — is the source of truth for
 * which collection holds a chat's data. The collection ID embeds a sanitized
 * form of `name1`/`name2`, and that sanitization can change over time
 * (e.g. the CJK-name fix). Recomputing the ID at read-time therefore can't
 * be trusted; the registry remembers the actual stored ID.
 *
 * Returned entries are ordered most-preferred first:
 *   1. Backend-scoped IDs matching the current backend setting
 *   2. Other backend-scoped IDs
 *   3. Legacy (no backend) IDs
 *
 * @param {string} uuid Chat UUID
 * @param {string} [preferredBackend] Backend to prefer (e.g. 'qdrant', 'vectra')
 * @returns {{ registryKey: string, collectionId: string }[]}
 */
export function findEventBaseCollectionIdsForChat(uuid, preferredBackend) {
    if (!uuid) return [];
    const matches = [];
    for (const registryKey of getCollectionRegistry()) {
        const parsed = parseRegistryKey(registryKey);
        const colId = parsed.collectionId;
        if (!colId?.startsWith(COLLECTION_PREFIXES.VECTHARE_EVENTBASE)) continue;
        if (!colId.endsWith(uuid)) continue;
        matches.push({ registryKey, collectionId: colId, backend: parsed.backend });
    }

    const wantBackend = String(preferredBackend || '').toLowerCase();
    const rank = (m) => {
        if (wantBackend && m.backend === wantBackend) return 0;
        if (m.backend) return 1;
        return 2;
    };
    matches.sort((a, b) => rank(a) - rank(b));
    return matches.map(({ registryKey, collectionId }) => ({ registryKey, collectionId }));
}

/**
 * Resolve which EventBase collection ID to read from for the given chat.
 *
 * Looks up the registered collection(s) by UUID and returns the first one
 * that actually has data. When no collection has been registered yet (first
 * ingestion), returns the freshly-computed backend-scoped ID so the write
 * path has somewhere to insert.
 *
 * @param {object} settings
 * @param {string} [chatUUID]
 * @returns {Promise<string|null>}
 */
async function _resolveEventBaseCollectionIdForRead(settings, chatUUID) {
    const uuid = chatUUID || getChatUUID();
    if (!uuid) return null;

    const backend = getRegistryBackend(settings?.vector_backend);
    const registered = findEventBaseCollectionIdsForChat(uuid, backend);

    for (const { collectionId } of registered) {
        try {
            const hashes = await getSavedHashes(collectionId, settings);
            if (hashes?.length > 0) return collectionId;
        } catch {
            // Try next candidate.
        }
    }

    // No registered collection has data yet — return the would-be ID so
    // first-time writers have a target. May be null if no chat is active.
    return buildEventBaseCollectionId(uuid, settings?.vector_backend);
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
