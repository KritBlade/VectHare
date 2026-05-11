/**
 * ============================================================================
 * VECTHARE COLLECTION ID UTILITIES
 * ============================================================================
 * Single source of truth for all collection ID operations:
 * - Building/generating collection IDs
 * - Parsing collection IDs (all formats)
 * - Pattern matching for discovery
 *
 * ALL other files should import from here instead of rolling their own.
 * ============================================================================
 */

import { getContext } from '../../../../extensions.js';
import { getCurrentChatId, chat_metadata } from '../../../../../script.js';

// ============================================================================
// CONSTANTS
// ============================================================================

/** Prefix for new VectHare format (not currently used for chats, but available) */
export const VH_PREFIX = 'vh';

/** Internal system collection IDs that must never participate in retrieval */
export const INTERNAL_COLLECTION_IDS = Object.freeze([
    '__vecthare_health_check__',
]);

/** All known collection prefixes for backwards compatibility */
export const COLLECTION_PREFIXES = {
    // VectHare formats
    VECTHARE_CHAT: 'vecthare_chat_',
    VECTHARE_LOREBOOK: 'vecthare_lorebook_',
    VECTHARE_CHARACTER: 'vecthare_character_',
    VECTHARE_DOCUMENT: 'vecthare_document_',
    VECTHARE_ARCHIVE_EVENT: 'vecthare_archiveevent_',
    VECTHARE_EVENTBASE: 'vecthare_eventbase_',

    // Legacy/external formats
    FILE: 'file_',
    LOREBOOK: 'lorebook_',
    RAGBOOKS_LOREBOOK: 'ragbooks_lorebook_',
    CARROTKERNEL_CHAR: 'carrotkernel_char_',
};

/** Collection types */
export const COLLECTION_TYPES = {
    CHAT: 'chat',
    LOREBOOK: 'lorebook',
    CHARACTER: 'character',
    DOCUMENT: 'document',
    ARCHIVE_EVENT: 'archive_event',
    FILE: 'file',
    URL: 'url',
    WIKI: 'wiki',
    YOUTUBE: 'youtube',
    UNKNOWN: 'unknown',
};

/** Collection scopes */
export const COLLECTION_SCOPES = {
    GLOBAL: 'global',
    CHARACTER: 'character',
    CHAT: 'chat',
    UNKNOWN: 'unknown',
};

/**
 * Normalize backend names used in IDs.
 * Keeps old alias "vectra" mapped to "standard" to avoid split IDs.
 * @param {string} backend
 * @returns {string}
 */
function normalizeBackendForId(backend) {
    const b = String(backend || '').toLowerCase();
    if (!b) return '';
    return b === 'vectra' ? 'standard' : b;
}

/**
 * Returns the storage backend label used in registry keys.
 * The user-facing setting is 'standard' but the actual storage is Vectra,
 * so we normalise 'standard' → 'vectra' to match what the Similharity plugin
 * reports.  'qdrant' passes through unchanged.
 * @param {string} vectorBackend Value from settings.vector_backend
 * @returns {string} 'vectra' | 'qdrant' | ...
 */
export function getRegistryBackend(vectorBackend) {
    const b = String(vectorBackend || 'standard').toLowerCase();
    return b === 'standard' ? 'vectra' : b;
}

// ============================================================================
// CHAT UUID UTILITIES
// ============================================================================

/**
 * Gets the unique chat UUID from chat_metadata.integrity
 * This is the authoritative identifier for a chat.
 * @returns {string|null} Chat UUID or null if no chat
 */
export function getChatUUID() {
    const integrity = chat_metadata?.integrity;
    if (integrity) {
        return integrity;
    }
    // Fallback: use chatId (less ideal but works for old chats)
    const chatId = getCurrentChatId();
    if (chatId) {
        console.warn('VectHare: chat_metadata.integrity not found, falling back to chatId');
        return chatId;
    }
    return null;
}

// ============================================================================
// COLLECTION ID BUILDERS
// ============================================================================

// ============================================================================
// DEAD-CHUNK-CHAT — disabled for good
// ============================================================================
// Chat history is hard-routed through the EventBase pipeline (see dev_helper.md §1).
// The legacy chunk-based chat format `vecthare_chat_{handle}_{char}_{uuid}` is no
// longer produced or queried anywhere. These builders return null so any leftover
// callers degrade gracefully (no fake IDs leaking into the registry / Qdrant).
//
// Search tag: DEAD-CHUNK-CHAT — used at every callsite that previously built or
// consumed `vecthare_chat_*` IDs. Remove entirely once the codebase is fully audited.
// ============================================================================

/**
 * @deprecated DEAD-CHUNK-CHAT. Chat history uses EventBase (`vecthare_eventbase_*`).
 * Returns null to disable any leftover callers.
 */
export function buildChatCollectionId(chatUUID) {
    console.warn('VectHare: buildChatCollectionId() called but chunk-based chat is disabled (use EventBase). Returning null. Stack:', new Error().stack);
    return null;
    /* DEAD-CHUNK-CHAT — original implementation:
    const uuid = chatUUID || getChatUUID();
    if (!uuid) {
        return null;
    }

    const context = getContext();
    const handleId = context?.name1 || 'user';
    const charName = context?.name2 || 'chat';

    const sanitizedHandle = handleId
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, '_')
        .replace(/^_|_$/g, '')
        .substring(0, 30) || 'user';

    const sanitizedChar = charName
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, '_')
        .replace(/^_|_$/g, '')
        .substring(0, 30) || 'chat';

    return `${COLLECTION_PREFIXES.VECTHARE_CHAT}${sanitizedHandle}_${sanitizedChar}_${uuid}`;
    */
}

/**
 * @deprecated DEAD-CHUNK-CHAT. Legacy chunk-based chat collections are not used anywhere.
 */
export function buildLegacyChatCollectionId(chatId) {
    console.warn('VectHare: buildLegacyChatCollectionId() called but chunk-based chat is disabled. Returning null.');
    return null;
    /* DEAD-CHUNK-CHAT — original implementation:
    const id = chatId || getCurrentChatId();
    if (!id) {
        return null;
    }
    return `${COLLECTION_PREFIXES.VECTHARE_CHAT}${id}`;
    */
}

/**
 * Sanitize a name segment for use in collection IDs (lowercase, alphanumeric + underscores).
 */
function _sanitizeNameSegment(name, maxLength) {
    return String(name || '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, '_')
        .substring(0, maxLength);
}

/**
 * Sanitize the persona handle from the active context. Must match the logic in the eventbase /
 * archive builders so registerCollection's stamp check sees the handle in the collection name.
 */
function _currentHandleId() {
    const ctx = getContext();
    return String(ctx?.name1 || 'user')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, '_')
        .replace(/^_|_$/g, '')
        .substring(0, 30) || 'user';
}

/**
 * Builds a lorebook collection ID following the unified protocol:
 *   vecthare_lorebook_<backend>_<handle>_<name>_<timestamp>
 * Backend is optional but recommended; without it the format drops the backend segment:
 *   vecthare_lorebook_<handle>_<name>_<timestamp>
 *
 * @param {string} lorebookName Lorebook name
 * @param {string} [backend]    Vector backend (e.g. 'qdrant', 'standard')
 * @param {number} [timestamp]  Optional timestamp, defaults to Date.now()
 * @returns {string} Collection ID
 */
export function buildLorebookCollectionId(lorebookName, backend, timestamp) {
    const sanitizedName = _sanitizeNameSegment(lorebookName, 50);
    const handle = _currentHandleId();
    const normalizedBackend = normalizeBackendForId(backend);
    const ts = timestamp || Date.now();
    if (normalizedBackend) {
        return `${COLLECTION_PREFIXES.VECTHARE_LOREBOOK}${normalizedBackend}_${handle}_${sanitizedName}_${ts}`;
    }
    return `${COLLECTION_PREFIXES.VECTHARE_LOREBOOK}${handle}_${sanitizedName}_${ts}`;
}

/**
 * Builds a character collection ID following the unified protocol:
 *   vecthare_character_<backend>_<handle>_<name>_<timestamp>
 *
 * @param {string} characterName Character name
 * @param {string} [backend]     Vector backend
 * @param {number} [timestamp]   Optional timestamp
 * @returns {string} Collection ID
 */
export function buildCharacterCollectionId(characterName, backend, timestamp) {
    const sanitizedName = _sanitizeNameSegment(characterName, 50);
    const handle = _currentHandleId();
    const normalizedBackend = normalizeBackendForId(backend);
    const ts = timestamp || Date.now();
    if (normalizedBackend) {
        return `${COLLECTION_PREFIXES.VECTHARE_CHARACTER}${normalizedBackend}_${handle}_${sanitizedName}_${ts}`;
    }
    return `${COLLECTION_PREFIXES.VECTHARE_CHARACTER}${handle}_${sanitizedName}_${ts}`;
}

/**
 * Builds a document collection ID following the unified protocol:
 *   vecthare_document_<backend>_<handle>_<name>_<timestamp>
 *
 * @param {string} documentName Document name
 * @param {string} [backend]    Vector backend
 * @param {number} [timestamp]  Optional timestamp
 * @returns {string} Collection ID
 */
export function buildDocumentCollectionId(documentName, backend, timestamp) {
    const sanitizedName = _sanitizeNameSegment(documentName, 50);
    const handle = _currentHandleId();
    const normalizedBackend = normalizeBackendForId(backend);
    const ts = timestamp || Date.now();
    if (normalizedBackend) {
        return `${COLLECTION_PREFIXES.VECTHARE_DOCUMENT}${normalizedBackend}_${handle}_${sanitizedName}_${ts}`;
    }
    return `${COLLECTION_PREFIXES.VECTHARE_DOCUMENT}${handle}_${sanitizedName}_${ts}`;
}

/**
 * Builds an EventBase collection ID for the given chat.
 * New format (backend-aware): vecthare_eventbase_{backend}_{handleId}_{charName}_{chatUUID}
 * Legacy format (no backend):  vecthare_eventbase_{handleId}_{charName}_{chatUUID}
 * Kept in collection-ids.js as the single source of truth for IDs.
 * @param {string} [chatUUID] Optional UUID override
 * @param {string} [backend] Optional backend name; when omitted, returns legacy format
 * @returns {string|null} Collection ID or null if no chat
 */
export function buildEventBaseCollectionId(chatUUID, backend) {
    const uuid = chatUUID || getChatUUID();
    if (!uuid) return null;

    const context = getContext();
    const sanitizedHandle = (context?.name1 || 'user')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, '_')
        .replace(/^_|_$/g, '')
        .substring(0, 30) || 'user';

    const sanitizedChar = (context?.name2 || 'chat')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, '_')
        .replace(/^_|_$/g, '')
        .substring(0, 30) || 'chat';

    const normalizedBackend = normalizeBackendForId(backend);
    if (normalizedBackend) {
        return `${COLLECTION_PREFIXES.VECTHARE_EVENTBASE}${normalizedBackend}_${sanitizedHandle}_${sanitizedChar}_${uuid}`;
    }

    return `${COLLECTION_PREFIXES.VECTHARE_EVENTBASE}${sanitizedHandle}_${sanitizedChar}_${uuid}`;
}

/**
 * Builds a collection ID for an archived chat's EventBase events.
 * Format: vecthare_archiveevent_{backend}_{handle}_{filenameCharName}_{archiveUUID}
 *
 * The ID is independent of the current chat's UUID — same archive uploaded from
 * any ST chat produces the same ID, enabling fingerprint-cache dedup across re-uploads.
 *
 * @param {object} params
 * @param {string} params.filenameCharName  - Character name parsed from the archive filename
 * @param {string} params.archiveUUID       - archive's chat_metadata.integrity, or SHA-1 of file content
 * @param {string} [params.backend]         - Vector backend (defaults to settings.vector_backend)
 * @returns {string|null}
 */
export function buildArchiveEventCollectionId({ filenameCharName, archiveUUID, backend }) {
    if (!archiveUUID) return null;

    const context = getContext();
    const sanitizedHandle = (context?.name1 || 'user')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, '_')
        .replace(/^_|_$/g, '')
        .substring(0, 30) || 'user';

    const sanitizedChar = (filenameCharName || 'archive')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, '_')
        .replace(/^_|_$/g, '')
        .substring(0, 30) || 'archive';

    const normalizedBackend = normalizeBackendForId(backend);
    if (normalizedBackend) {
        return `${COLLECTION_PREFIXES.VECTHARE_ARCHIVE_EVENT}${normalizedBackend}_${sanitizedHandle}_${sanitizedChar}_${archiveUUID}`;
    }
    return `${COLLECTION_PREFIXES.VECTHARE_ARCHIVE_EVENT}${sanitizedHandle}_${sanitizedChar}_${archiveUUID}`;
}

/**
 * @deprecated DEAD-CHUNK-CHAT. Both inner builders are dead; this helper now returns
 * `{current: null, legacy: null}` so leftover callers see nothing-to-discover.
 */
export function getAllChatCollectionIds(chatId, chatUUID) {
    return {
        current: buildChatCollectionId(chatUUID),
        legacy: buildLegacyChatCollectionId(chatId),
    };
}

// ============================================================================
// COLLECTION ID PARSER
// ============================================================================

/**
 * Parses any collection ID format and returns structured info
 * Handles all legacy and current formats.
 *
 * @param {string} collectionId Collection ID to parse
 * @returns {{type: string, rawId: string, scope: string, format: string}} Parsed info
 */
export function parseCollectionId(collectionId) {
    if (!collectionId || typeof collectionId !== 'string') {
        return {
            type: COLLECTION_TYPES.UNKNOWN,
            rawId: 'unknown',
            scope: COLLECTION_SCOPES.UNKNOWN,
            format: 'invalid',
        };
    }

    // New VH format: vh:type:sourceId
    if (collectionId.startsWith(`${VH_PREFIX}:`)) {
        const parts = collectionId.split(':');
        if (parts.length >= 3) {
            return {
                type: parts[1],
                rawId: parts.slice(2).join(':'),
                scope: parts[1] === 'chat' ? COLLECTION_SCOPES.CHAT : COLLECTION_SCOPES.GLOBAL,
                format: 'vh',
            };
        }
    }

    // VectHare chat format: vecthare_chat_*
    if (collectionId.startsWith(COLLECTION_PREFIXES.VECTHARE_CHAT)) {
        return {
            type: COLLECTION_TYPES.CHAT,
            rawId: collectionId.replace(COLLECTION_PREFIXES.VECTHARE_CHAT, ''),
            scope: COLLECTION_SCOPES.CHAT,
            format: 'vecthare',
        };
    }

    // VectHare lorebook format: vecthare_lorebook_*
    if (collectionId.startsWith(COLLECTION_PREFIXES.VECTHARE_LOREBOOK)) {
        return {
            type: COLLECTION_TYPES.LOREBOOK,
            rawId: collectionId.replace(COLLECTION_PREFIXES.VECTHARE_LOREBOOK, ''),
            scope: COLLECTION_SCOPES.GLOBAL,
            format: 'vecthare',
        };
    }

    // VectHare character format: vecthare_character_*
    if (collectionId.startsWith(COLLECTION_PREFIXES.VECTHARE_CHARACTER)) {
        return {
            type: COLLECTION_TYPES.CHARACTER,
            rawId: collectionId.replace(COLLECTION_PREFIXES.VECTHARE_CHARACTER, ''),
            scope: COLLECTION_SCOPES.CHARACTER,
            format: 'vecthare',
        };
    }

    // VectHare document format: vecthare_document_*
    if (collectionId.startsWith(COLLECTION_PREFIXES.VECTHARE_DOCUMENT)) {
        return {
            type: COLLECTION_TYPES.DOCUMENT,
            rawId: collectionId.replace(COLLECTION_PREFIXES.VECTHARE_DOCUMENT, ''),
            scope: COLLECTION_SCOPES.GLOBAL,
            format: 'vecthare',
        };
    }

    // VectHare archive event format: vecthare_archiveevent_*
    if (collectionId.startsWith(COLLECTION_PREFIXES.VECTHARE_ARCHIVE_EVENT)) {
        return {
            type: COLLECTION_TYPES.ARCHIVE_EVENT,
            rawId: collectionId.replace(COLLECTION_PREFIXES.VECTHARE_ARCHIVE_EVENT, ''),
            scope: COLLECTION_SCOPES.GLOBAL,
            format: 'vecthare',
        };
    }

    // Legacy file format: file_*
    if (collectionId.startsWith(COLLECTION_PREFIXES.FILE)) {
        return {
            type: COLLECTION_TYPES.FILE,
            rawId: collectionId.replace(COLLECTION_PREFIXES.FILE, ''),
            scope: COLLECTION_SCOPES.GLOBAL,
            format: 'legacy',
        };
    }

    // Legacy lorebook format: lorebook_*
    if (collectionId.startsWith(COLLECTION_PREFIXES.LOREBOOK)) {
        return {
            type: COLLECTION_TYPES.LOREBOOK,
            rawId: collectionId.replace(COLLECTION_PREFIXES.LOREBOOK, ''),
            scope: COLLECTION_SCOPES.GLOBAL,
            format: 'legacy',
        };
    }

    // Ragbooks lorebook format: ragbooks_lorebook_*
    if (collectionId.startsWith(COLLECTION_PREFIXES.RAGBOOKS_LOREBOOK)) {
        return {
            type: COLLECTION_TYPES.LOREBOOK,
            rawId: collectionId.replace(COLLECTION_PREFIXES.RAGBOOKS_LOREBOOK, ''),
            scope: COLLECTION_SCOPES.GLOBAL,
            format: 'ragbooks',
        };
    }

    // CarrotKernel/Fullsheet character format: carrotkernel_char_*
    if (collectionId.startsWith(COLLECTION_PREFIXES.CARROTKERNEL_CHAR)) {
        return {
            type: COLLECTION_TYPES.CHARACTER,
            rawId: collectionId.replace(COLLECTION_PREFIXES.CARROTKERNEL_CHAR, ''),
            scope: COLLECTION_SCOPES.CHARACTER,
            format: 'fullsheet',
        };
    }

    // Heuristic: date/timestamp patterns suggest chat
    if (collectionId.includes('@') || /\d{4}-\d{2}-\d{2}/.test(collectionId)) {
        return {
            type: COLLECTION_TYPES.CHAT,
            rawId: collectionId,
            scope: COLLECTION_SCOPES.CHAT,
            format: 'legacy_chat',
        };
    }

    // Default: unknown
    return {
        type: COLLECTION_TYPES.UNKNOWN,
        rawId: collectionId,
        scope: COLLECTION_SCOPES.UNKNOWN,
        format: 'unknown',
    };
}

// ============================================================================
// PATTERN MATCHING FOR DISCOVERY
// ============================================================================

/**
 * Builds search patterns for finding a chat's collections
 * Used by doesChatHaveVectors and similar discovery functions
 *
 * @param {string} [chatId] Chat ID (filename)
 * @param {string} [chatUUID] Chat UUID
 * @returns {string[]} Array of patterns to search for (all lowercase)
 */
export function buildChatSearchPatterns(chatId, chatUUID) {
    const patterns = [];
    const uuid = chatUUID || getChatUUID();
    const id = chatId || getCurrentChatId();

    // Primary: UUID (the unique identifier)
    if (uuid) {
        patterns.push(uuid.toLowerCase());
    }

    // Legacy: full chatId
    if (id) {
        patterns.push(`${COLLECTION_PREFIXES.VECTHARE_CHAT}${id}`.toLowerCase());

        // Extract character name (before " - " in filename)
        const charNameMatch = id.match(/^([^-]+)/);
        if (charNameMatch) {
            const charName = charNameMatch[1].trim().toLowerCase();
            if (charName) {
                patterns.push(`${COLLECTION_PREFIXES.VECTHARE_CHAT}${charName}`.toLowerCase());
            }
        }
    }

    return patterns;
}

/**
 * Checks if a collection ID matches any of the given patterns
 * Case-insensitive, uses substring matching for flexibility
 *
 * @param {string} collectionId Collection ID to check
 * @param {string[]} patterns Patterns to match against
 * @returns {boolean} True if matches any pattern
 */
export function matchesPatterns(collectionId, patterns) {
    if (!collectionId || !patterns || patterns.length === 0) {
        return false;
    }

    const idLower = collectionId.toLowerCase();

    return patterns.some(pattern =>
        idLower === pattern ||
        idLower.includes(pattern)
    );
}

/**
 * Extracts backend and source from a registry key
 * Registry keys can be:
 * - "backend:source:collectionId" (new format)
 * - "source:collectionId" (migration format)
 * - "collectionId" (legacy format)
 *
 * @param {string} registryKey Registry key to parse
 * @returns {{backend: string|null, source: string|null, collectionId: string}} Parsed key
 */
export function parseRegistryKey(registryKey) {
    if (!registryKey || typeof registryKey !== 'string') {
        return { backend: null, source: null, collectionId: '' };
    }

    // Known storage backends
    const knownBackends = ['standard', 'vectra', 'qdrant'];

    const parts = registryKey.split(':');

    // Current format: backend:collectionId (starts with a known backend)
    if (parts.length >= 2 && knownBackends.includes(parts[0])) {
        return {
            backend: parts[0],
            source: null,
            collectionId: parts.slice(1).join(':'),
        };
    }

    // Legacy format: just collectionId (no recognized prefix)
    return { backend: null, source: null, collectionId: registryKey };
}
