/**
 * VectHare Collection Metadata Manager
 *
 * Manages collection-level metadata in extension_settings.vecthare.collections
 * This is the "settings layer" - user preferences for collections.
 *
 * Separation of concerns:
 * - collection-loader.js = Discovery & loading (talks to vector backends)
 * - collection-metadata.js = Settings & state (talks to extension_settings)
 */

import { extension_settings } from '../../../../extensions.js';
import { saveSettingsDebounced } from '../../../../../script.js';
import { parseRegistryKey, COLLECTION_PREFIXES } from './collection-ids.js';

// ============================================================================
// COLLECTION METADATA CRUD
// ============================================================================

/**
 * Default metadata for a new collection
 */
const defaultCollectionMeta = {
    enabled: true,
    autoSync: false,  // Per-collection auto-sync for chat vectorization
    scope: 'unknown',
    displayName: null,
    description: '',
    tags: [],
    color: null,
    createdAt: null,
    lastUsed: null,
    queryCount: 0,

    // =========================================================================
    // ACTIVATION TRIGGERS (PRIMARY METHOD - Like Lorebook)
    // =========================================================================
    // Simple keyword-based activation. If ANY trigger matches recent messages,
    // the collection activates. This is the primary, user-friendly method.
    //
    // Priority order:
    // 1. alwaysActive=true → Collection always queries (ignores triggers)
    // 2. triggers[] not empty → Match keywords in recent messages
    // 3. conditions.enabled=true → Advanced rules (secondary method)
    // 4. No triggers + no conditions → Auto-activates (like alwaysActive)
    alwaysActive: false,           // If true, ignores triggers and conditions
    triggers: [],                  // Array of trigger keywords (case-insensitive)
    triggerMatchMode: 'any',       // 'any' = OR logic, 'all' = AND logic
    triggerCaseSensitive: false,   // Case sensitivity for trigger matching
    triggerScanDepth: 5,           // How many recent messages to scan for triggers

    // =========================================================================
    // CONDITIONAL ACTIVATION (ADVANCED METHOD - Secondary)
    // =========================================================================
    // Complex rule-based activation. Only evaluated if triggers don't match
    // or if no triggers are set. Use for sophisticated activation logic.
    conditions: {
        enabled: false,
        logic: 'AND', // 'AND' = all rules must pass, 'OR' = any rule passes
        rules: [],    // Array of condition rules
    },

    // =========================================================================
    // TEMPORAL DECAY (Per-Collection)
    // =========================================================================
    // Controls how older chunks lose relevance over time.
    // Chat collections default to enabled; others default to disabled.
    temporalDecay: {
        enabled: false,           // Enable temporal decay for this collection
        type: 'decay',            // 'decay' (favor recent) or 'nostalgia' (favor old)
        mode: 'exponential',      // 'exponential' or 'linear'
        halfLife: 50,             // Messages until 50% relevance (exponential)
        linearRate: 0.01,         // % per message (linear mode)
        minRelevance: 0.3,        // Never decay below this (0-1) - decay mode only
        maxBoost: 2.0,            // Maximum boost multiplier (1-5) - nostalgia mode only
        sceneAware: false,        // Reset decay at scene boundaries
    },

    // =========================================================================
    // CHUNK GROUPS (Per-Collection)
    // =========================================================================
    // Groups chunks together for collective activation or mutual exclusion.
    // - Inclusive mode: When any member matches, affect other members
    //   - Soft link: Other members get score boost
    //   - Hard link: Other members are force-included
    // - Exclusive mode: Only highest-scoring member passes through
    //   - Mandatory: At least one member MUST be included
    groups: [],  // Array of ChunkGroup objects (see core/chunk-groups.js)

    // =========================================================================
    // PROMPT CONTEXT (Per-Collection)
    // =========================================================================
    // Wraps all chunks from this collection with context/guidance for the AI.
    // Supports {{user}} and {{char}} variables.
    // Example: "Things {{char}} remembers about {{user}}:"
    context: '',      // Natural language context shown before this collection's chunks
    xmlTag: '',       // XML tag to wrap this collection's chunks (e.g., "memories")
};

/**
 * Gets default temporal decay settings based on collection type
 * Uses global defaults from settings, with chat collections getting scene-awareness
 * @param {string} collectionType - 'chat', 'lorebook', 'file', 'document', etc.
 * @returns {object} Default decay settings for this type
 */
export function getDefaultDecayForType(collectionType) {
    // Get global defaults from settings
    const globalSettings = extension_settings.vecthare || {};
    const globalEnabled = globalSettings.default_decay_enabled ?? false;
    const globalType = globalSettings.default_decay_type || 'decay';

    const baseDefaults = {
        enabled: globalEnabled,
        type: globalType,
        mode: 'exponential',
        halfLife: 50,
        linearRate: 0.01,
        minRelevance: 0.3,
        maxBoost: 2.0,
        sceneAware: false,
    };

    // Chat collections get scene-awareness by default (if decay is enabled)
    if (collectionType === 'chat') {
        return {
            ...baseDefaults,
            sceneAware: globalEnabled, // Only enable scene-aware if decay is enabled
        };
    }

    return baseDefaults;
}

/**
 * ============================================================================
 * CONDITION TYPES
 * ============================================================================
 *
 * COLLECTION & CHUNK CONDITIONS (11 types):
 * Can be used at both collection-level and chunk-level.
 * Collection-level: Determines if a collection should be queried
 * Chunk-level: Determines if a specific chunk should be included
 *
 * - pattern:          Advanced regex/pattern matching (replaces keyword)
 * - speaker:          Match by who spoke last
 * - characterPresent: Check if specific character(s) spoke recently
 * - messageCount:     Conversation length pacing (eq, gte, lte, between)
 * - emotion:          Hybrid emotion detection (Expressions + patterns)
 * - isGroupChat:      Group vs 1-on-1 chat
 * - generationType:   Normal, swipe, continue, regenerate, impersonate
 * - lorebookActive:   Specific lorebook entries are triggered
 * - swipeCount:       Number of swipes on last message
 * - timeOfDay:        Real-world time window (supports midnight crossing)
 * - randomChance:     Probabilistic activation (0-100%)
 *
 * CHUNK-ONLY FEATURES:
 * Only make sense at chunk-level, not collection-level.
 *
 * - links:            Hard/soft links to other chunks
 *                     - hard: Target chunk MUST appear if source appears
 *                     - soft: Target chunk gets score boost if source appears
 *                     Each chunk defines its own links independently.
 *                     For two-way linking, add links on both chunks.
 * - scoreThreshold:   Per-chunk minimum similarity score override
 * - recency:          Filter by message age (messagesAgo)
 * - frequency:        Limit activations (maxActivations, cooldownMessages)
 *
 * EMOTION DETECTION:
 * Uses hybrid approach with Character Expressions extension + keyword/regex patterns.
 * Detection methods: 'auto' (recommended), 'expressions', 'patterns', 'both'
 * - Character Expressions: Uses sprite-based emotion from last message
 * - Pattern matching: Keywords + regex patterns (wrapped in forward slashes)
 * Call getExpressionsExtensionStatus() to check if extension is available.
 * See: conditional-activation.js for full implementation.
 * ============================================================================
 */

/**
 * Condition rule structure (for reference):
 * {
 *     type: 'keyword',           // Condition type
 *     negate: false,             // Invert the result
 *     settings: {                // Type-specific settings
 *         values: ['combat'],
 *         matchMode: 'contains', // contains, exact, startsWith, endsWith
 *         caseSensitive: false,
 *     }
 * }
 */

/**
 * Ensures the collections object exists in extension_settings
 */
function ensureCollectionsObject() {
    // VEC-26: Add proper null checks to prevent crashes
    if (!extension_settings) {
        console.error('VectHare: extension_settings is null/undefined - cannot access collections');
        return false;
    }
    if (!extension_settings.vecthare) {
        extension_settings.vecthare = {};
    }
    if (!extension_settings.vecthare.collections) {
        extension_settings.vecthare.collections = {};
    }
    return true;
}

/**
 * Gets metadata for a collection
 * @param {string} collectionId Collection identifier
 * @returns {object} Collection metadata (with defaults applied)
 */
export function getCollectionMeta(collectionId) {
    // VEC-26: Add comprehensive null checks
    if (!ensureCollectionsObject()) {
        return { ...defaultCollectionMeta };
    }

    let stored = extension_settings.vecthare.collections[collectionId];

    // Fallback: Try alternate key formats for backward compatibility
    if (!stored && collectionId) {
        // If looking up with full key (backend:source:id), try without backend
        const parsed = parseRegistryKey(collectionId);
        if (parsed.backend && parsed.source) {
            // Try source:collectionId format
            const legacyKey = `${parsed.source}:${parsed.collectionId}`;
            stored = extension_settings.vecthare.collections[legacyKey];

            // Try just collectionId
            if (!stored) {
                stored = extension_settings.vecthare.collections[parsed.collectionId];
            }
        } else if (parsed.source) {
            // Already source:collectionId format, try just collectionId
            stored = extension_settings.vecthare.collections[parsed.collectionId];
        }
    }

    if (!stored) {
        return { ...defaultCollectionMeta };
    }

    // Merge with defaults to ensure all fields exist
    return {
        ...defaultCollectionMeta,
        ...stored,
    };
}

/**
 * Sets metadata for a collection (merges with existing)
 * @param {string} collectionId Collection identifier
 * @param {object} data Metadata to set (partial or full)
 */
export function setCollectionMeta(collectionId, data) {
    if (!collectionId) {
        console.warn('VectHare: setCollectionMeta called with null/undefined collectionId');
        return;
    }

    ensureCollectionsObject();

    const existing = extension_settings.vecthare.collections[collectionId] || {};

    extension_settings.vecthare.collections[collectionId] = {
        ...defaultCollectionMeta,
        ...existing,
        ...data,
    };

    saveSettingsDebounced();
    console.log(`VectHare: Updated metadata for collection ${collectionId}`);
}

/**
 * Deletes metadata for a collection
 * @param {string} collectionId Collection identifier
 */
export function deleteCollectionMeta(collectionId) {
    ensureCollectionsObject();

    if (extension_settings.vecthare.collections[collectionId]) {
        delete extension_settings.vecthare.collections[collectionId];
        saveSettingsDebounced();
        console.log(`VectHare: Deleted metadata for collection ${collectionId}`);
    }
}

/**
 * Gets all collection metadata
 * @returns {object} Map of collectionId -> metadata
 */
export function getAllCollectionMeta() {
    ensureCollectionsObject();
    return extension_settings.vecthare.collections;
}

// ============================================================================
// ENABLED STATE (convenience wrappers)
// ============================================================================

/**
 * Sets whether a collection is enabled
 * @param {string} collectionId Collection identifier
 * @param {boolean} enabled Whether collection is enabled
 */
export function setCollectionEnabled(collectionId, enabled) {
    setCollectionMeta(collectionId, { enabled: enabled });
}

/**
 * Checks if a collection is enabled
 * @param {string} collectionId Collection identifier
 * @returns {boolean} Whether collection is enabled (default: true)
 */
export function isCollectionEnabled(collectionId) {
    const meta = getCollectionMeta(collectionId);
    return meta.enabled !== false;
}

// ============================================================================
// AUTO-SYNC STATE (per-collection auto-sync for chat vectorization)
// ============================================================================

/**
 * Sets whether auto-sync is enabled for a collection
 * @param {string} collectionId Collection identifier
 * @param {boolean} autoSync Whether auto-sync is enabled
 */
export function setCollectionAutoSync(collectionId, autoSync) {
    setCollectionMeta(collectionId, { autoSync: autoSync });
}

/**
 * Checks if auto-sync is enabled for a collection
 * @param {string} collectionId Collection identifier
 * @returns {boolean} Whether auto-sync is enabled (default: false)
 */
export function isCollectionAutoSyncEnabled(collectionId) {
    if (!collectionId) {
        return false;
    }
    const meta = getCollectionMeta(collectionId);
    return meta.autoSync === true;
}

// ============================================================================
// CHUNK METADATA (per-chunk settings, stored separately)
// ============================================================================
// Chunk metadata is stored per-hash and can include:
// - conditions: { ... }     - Conditional activation rules
// - sceneId: string         - Scene boundary marker
// - links: []               - Soft/hard links to other chunks
// - disabled: boolean       - Exclude from results
// - isSummary: boolean      - Dual-vector summary chunk
// - parentHash: string      - Parent chunk for summaries
// - context: string         - Prompt context text (supports {{user}}/{{char}})
// - xmlTag: string          - XML tag to wrap this chunk
// ============================================================================

/**
 * Gets metadata for a specific chunk
 * @param {string} hash Chunk hash
 * @returns {object|null} Chunk metadata or null if not found
 */
export function getChunkMetadata(hash) {
    if (!extension_settings.vecthare) {
        return null;
    }

    const key = `vecthare_chunk_meta_${hash}`;
    return extension_settings.vecthare[key] || null;
}

/**
 * Saves metadata for a specific chunk
 * @param {string} hash Chunk hash
 * @param {object} metadata Chunk metadata
 */
export function saveChunkMetadata(hash, metadata) {
    if (!extension_settings.vecthare) {
        extension_settings.vecthare = {};
    }

    const key = `vecthare_chunk_meta_${hash}`;
    extension_settings.vecthare[key] = {
        ...metadata,
        updatedAt: Date.now(),
    };

    saveSettingsDebounced();
}

/**
 * Deletes metadata for a specific chunk
 * @param {string} hash Chunk hash
 */
export function deleteChunkMetadata(hash) {
    if (!extension_settings.vecthare) {
        return;
    }

    const key = `vecthare_chunk_meta_${hash}`;
    if (extension_settings.vecthare[key]) {
        delete extension_settings.vecthare[key];
        saveSettingsDebounced();
    }
}

/**
 * Gets all chunk metadata entries
 * @returns {object} Map of hash -> metadata
 */
export function getAllChunkMetadata() {
    if (!extension_settings.vecthare) {
        return {};
    }

    const result = {};
    const prefix = 'vecthare_chunk_meta_';

    for (const key in extension_settings.vecthare) {
        if (key.startsWith(prefix)) {
            const hash = key.replace(prefix, '');
            result[hash] = extension_settings.vecthare[key];
        }
    }

    return result;
}

// ============================================================================
// MIGRATION & CLEANUP
// ============================================================================

/**
 * Migrates old scattered enabled keys to new collections structure
 * Old format: vecthare_collection_enabled_{collectionId} = true/false
 * New format: collections[collectionId].enabled = true/false
 */
export function migrateOldEnabledKeys() {
    if (!extension_settings.vecthare) {
        return { migrated: 0 };
    }

    ensureCollectionsObject();

    let migrated = 0;
    const keysToDelete = [];

    for (const key in extension_settings.vecthare) {
        if (key.startsWith('vecthare_collection_enabled_')) {
            const collectionId = key.replace('vecthare_collection_enabled_', '');
            const enabled = extension_settings.vecthare[key];

            // Only migrate if we don't already have metadata for this collection
            if (!extension_settings.vecthare.collections[collectionId]) {
                extension_settings.vecthare.collections[collectionId] = {
                    ...defaultCollectionMeta,
                    enabled: enabled !== false,
                };
                console.log(`VectHare: Migrated enabled key for ${collectionId}`);
            }

            keysToDelete.push(key);
            migrated++;
        }
    }

    // Delete old keys
    for (const key of keysToDelete) {
        delete extension_settings.vecthare[key];
    }

    if (migrated > 0) {
        saveSettingsDebounced();
        console.log(`VectHare: Migrated ${migrated} old enabled keys to new collections structure`);
    }

    return { migrated };
}

/**
 * Cleans up orphaned metadata entries (collections that no longer exist)
 * @param {string[]} actualCollectionIds Array of collection IDs that actually exist
 * @returns {object} Cleanup stats
 */
export function cleanupOrphanedMeta(actualCollectionIds) {
    ensureCollectionsObject();

    const actualSet = new Set(actualCollectionIds);
    const orphaned = [];

    for (const collectionId in extension_settings.vecthare.collections) {
        if (!actualSet.has(collectionId)) {
            orphaned.push(collectionId);
        }
    }

    for (const collectionId of orphaned) {
        delete extension_settings.vecthare.collections[collectionId];
        console.log(`VectHare: Removed orphaned metadata for ${collectionId}`);
    }

    if (orphaned.length > 0) {
        saveSettingsDebounced();
        console.log(`VectHare: Cleaned up ${orphaned.length} orphaned metadata entries`);
    }

    return { removed: orphaned.length, orphanedIds: orphaned };
}

// ============================================================================
// COLLECTION LOCKING (Bind collection to one or more chats)
// ============================================================================

/**
 * Adds a chat to the collection's lock list. Supports multiple chats per collection.
 * Stores chat IDs in metadata field `lockedToChatIds` (array).
 * Automatically migrates old single-value `lockedToChatId` to array format.
 * @param {string} collectionId
 * @param {string|null} chatId - Chat ID to lock to, or null to remove all locks
 */
export function setCollectionLock(collectionId, chatId) {
    if (!collectionId) return;
    const meta = getCollectionMeta(collectionId);
    const update = {};

    if (chatId === null) {
        // Clear all locks
        update.lockedToChatIds = [];
        update.lockedToChatId = null; // Clear old format for backward compat
    } else {
        chatId = String(chatId);
        let locks = Array.isArray(meta.lockedToChatIds) ? [...meta.lockedToChatIds] : [];

        // Migrate old single-value format if present
        if (meta.lockedToChatId && !locks.includes(String(meta.lockedToChatId))) {
            locks.push(String(meta.lockedToChatId));
        }

        // Add chat if not already present
        if (!locks.includes(chatId)) {
            locks.push(chatId);
        }

        update.lockedToChatIds = locks;
        update.lockedToChatId = null; // Clear old format
    }

    setCollectionMeta(collectionId, update);
    console.log(`VectHare: Collection ${collectionId} locks updated:`, update.lockedToChatIds);
}

/**
 * Removes a specific chat from a collection's lock list
 * @param {string} collectionId
 * @param {string} chatId - Chat ID to remove from lock list
 */
export function removeCollectionLock(collectionId, chatId) {
    if (!collectionId || !chatId) return;
    const meta = getCollectionMeta(collectionId);
    const update = {};

    let locks = Array.isArray(meta.lockedToChatIds) ? [...meta.lockedToChatIds] : [];

    // Migrate old format if present
    if (meta.lockedToChatId && !locks.includes(String(meta.lockedToChatId))) {
        locks.push(String(meta.lockedToChatId));
    }

    // Remove the chat
    locks = locks.filter(id => String(id) !== String(chatId));

    update.lockedToChatIds = locks;
    update.lockedToChatId = null; // Clear old format

    setCollectionMeta(collectionId, update);
    console.log(`VectHare: Removed chat ${chatId} from collection ${collectionId} locks`);
}

/**
 * Clears all locks for a collection (removes from all chats)
 * @param {string} collectionId
 */
export function clearCollectionLock(collectionId) {
    setCollectionLock(collectionId, null);
}

/**
 * Gets the array of locked chat IDs for a collection, or empty array if not locked
 * Includes backward compatibility for old single-value `lockedToChatId` format
 * @param {string} collectionId
 * @returns {string[]}
 */
export function getCollectionLocks(collectionId) {
    const meta = getCollectionMeta(collectionId);
    let locks = Array.isArray(meta.lockedToChatIds) ? [...meta.lockedToChatIds] : [];

    // Backward compatibility: if old format exists and not already in new format, include it
    if (meta.lockedToChatId && !locks.includes(String(meta.lockedToChatId))) {
        locks.push(String(meta.lockedToChatId));
    }

    return locks;
}

/**
 * Gets the first locked chat ID (for backward compat with single-lock code)
 * @param {string} collectionId
 * @returns {string|null}
 */
export function getCollectionLock(collectionId) {
    const locks = getCollectionLocks(collectionId);
    return locks.length > 0 ? locks[0] : null;
}

/**
 * Checks whether the collection is locked to the provided chatId
 * @param {string} collectionId
 * @param {string} chatId
 * @returns {boolean}
 */
export function isCollectionLockedToChat(collectionId, chatId) {
    if (!collectionId || !chatId) return false;
    const locks = getCollectionLocks(collectionId);
    return locks.some(id => String(id) === String(chatId));
}

/**
 * Gets the count of chats this collection is locked to
 * @param {string} collectionId
 * @returns {number}
 */
export function getCollectionLockCount(collectionId) {
    return getCollectionLocks(collectionId).length;
}

// ============================================================================
// CHARACTER LOCKING (Bind collection to one or more character cards)
// ============================================================================

/**
 * Adds a character to the collection's character lock list. Supports multiple characters per collection.
 * Stores character IDs in metadata field `lockedToCharacterIds` (array).
 * @param {string} collectionId
 * @param {string} characterId - Character ID to lock to
 */
export function setCollectionCharacterLock(collectionId, characterId) {
    if (!collectionId || !characterId) return;
    const meta = getCollectionMeta(collectionId);
    const update = {};

    characterId = String(characterId);
    let locks = Array.isArray(meta.lockedToCharacterIds) ? [...meta.lockedToCharacterIds] : [];

    // Add character if not already present
    if (!locks.includes(characterId)) {
        locks.push(characterId);
    }

    update.lockedToCharacterIds = locks;
    setCollectionMeta(collectionId, update);
    console.log(`VectHare: Collection ${collectionId} character locks updated:`, update.lockedToCharacterIds);
}

/**
 * Removes a specific character from a collection's character lock list
 * @param {string} collectionId
 * @param {string} characterId - Character ID to remove from lock list
 */
export function removeCollectionCharacterLock(collectionId, characterId) {
    if (!collectionId || !characterId) return;
    const meta = getCollectionMeta(collectionId);
    const update = {};

    let locks = Array.isArray(meta.lockedToCharacterIds) ? [...meta.lockedToCharacterIds] : [];

    // Remove the character
    locks = locks.filter(id => String(id) !== String(characterId));

    update.lockedToCharacterIds = locks;
    setCollectionMeta(collectionId, update);
    console.log(`VectHare: Removed character ${characterId} from collection ${collectionId} locks`);
}

/**
 * Clears all character locks for a collection
 * @param {string} collectionId
 */
export function clearCollectionCharacterLocks(collectionId) {
    if (!collectionId) return;
    setCollectionMeta(collectionId, { lockedToCharacterIds: [] });
    console.log(`VectHare: Cleared all character locks for collection ${collectionId}`);
}

/**
 * Gets the array of locked character IDs for a collection, or empty array if not locked
 * @param {string} collectionId
 * @returns {string[]}
 */
export function getCollectionCharacterLocks(collectionId) {
    const meta = getCollectionMeta(collectionId);
    return Array.isArray(meta.lockedToCharacterIds) ? [...meta.lockedToCharacterIds] : [];
}

/**
 * Checks whether the collection is locked to the provided character ID
 * @param {string} collectionId
 * @param {string} characterId
 * @returns {boolean}
 */
export function isCollectionLockedToCharacter(collectionId, characterId) {
    if (!collectionId || !characterId) return false;
    const locks = getCollectionCharacterLocks(collectionId);
    return locks.some(id => String(id) === String(characterId));
}

/**
 * Gets the count of characters this collection is locked to
 * @param {string} collectionId
 * @returns {number}
 */
export function getCollectionCharacterLockCount(collectionId) {
    return getCollectionCharacterLocks(collectionId).length;
}

/**
 * Ensures a collection has metadata (creates with defaults if missing)
 * Called when a collection is discovered/created
 * @param {string} collectionId Collection identifier
 * @param {object} initialData Optional initial data to set (can include 'type' for collection type)
 */
export function ensureCollectionMeta(collectionId, initialData = {}) {
    if (!collectionId) {
        return;
    }

    ensureCollectionsObject();

    if (!extension_settings.vecthare.collections[collectionId]) {
        // Determine collection type for temporal decay defaults
        // Check initialData.type, or infer from scope, or parse from collectionId
        let collectionType = initialData.type || initialData.scope || 'unknown';
        if (collectionType === 'unknown' && collectionId.includes('_chat_')) {
            collectionType = 'chat';
        } else if (collectionType === 'unknown' && collectionId.includes('_lorebook_')) {
            collectionType = 'lorebook';
        }

        extension_settings.vecthare.collections[collectionId] = {
            ...defaultCollectionMeta,
            temporalDecay: getDefaultDecayForType(collectionType),
            createdAt: Date.now(),
            ...initialData,
        };
        saveSettingsDebounced();
        console.log(`VectHare: Created metadata for new collection ${collectionId} (type: ${collectionType})`);
    }
}

/**
 * Updates lastUsed timestamp and increments queryCount
 * Called when a collection is queried
 * @param {string} collectionId Collection identifier
 */
export function recordCollectionUsage(collectionId) {
    if (!collectionId) {
        return;
    }

    ensureCollectionsObject();

    const existing = extension_settings.vecthare.collections[collectionId];
    if (existing) {
        existing.lastUsed = Date.now();
        existing.queryCount = (existing.queryCount || 0) + 1;
        saveSettingsDebounced();
    }
}

// ============================================================================
// ACTIVATION TRIGGERS (Primary Method)
// ============================================================================

/**
 * Checks if any activation triggers match the recent messages
 * @param {string[]} triggers Array of trigger keywords
 * @param {object} context Search context containing recentMessages
 * @param {object} options Matching options
 * @returns {boolean} Whether triggers matched
 */
function checkTriggers(triggers, context, options = {}) {
    if (!triggers || triggers.length === 0) {
        return false;
    }

    const {
        matchMode = 'any',
        caseSensitive = false,
        scanDepth = 5,
    } = options;

    // Get recent message text to scan
    const recentMessages = context.recentMessages || [];
    const messagesToScan = recentMessages.slice(0, scanDepth);
    const searchText = messagesToScan.join('\n');

    if (!searchText) {
        return false;
    }

    const textToSearch = caseSensitive ? searchText : searchText.toLowerCase();

    // Check each trigger
    const results = triggers.map(trigger => {
        const triggerText = caseSensitive ? trigger : trigger.toLowerCase();

        // Support regex triggers (wrapped in /.../)
        if (trigger.startsWith('/') && trigger.lastIndexOf('/') > 0) {
            try {
                const lastSlash = trigger.lastIndexOf('/');
                const pattern = trigger.slice(1, lastSlash);
                const flags = trigger.slice(lastSlash + 1) || (caseSensitive ? '' : 'i');
                const regex = new RegExp(pattern, flags);
                return regex.test(searchText);
            } catch (e) {
                console.warn(`VectHare: Invalid trigger regex: ${trigger}`);
                return false;
            }
        }

        // Plain text matching
        return textToSearch.includes(triggerText);
    });

    // Apply match mode
    if (matchMode === 'all') {
        return results.every(r => r);
    }
    return results.some(r => r); // 'any' mode (default)
}

// ============================================================================
// CONDITIONAL ACTIVATION (Advanced Method - Secondary)
// ============================================================================

// Import condition evaluator (lazy loaded to avoid circular deps)
let evaluateConditionRule = null;

/**
 * Lazily loads the condition evaluator
 */
async function getConditionEvaluator() {
    if (!evaluateConditionRule) {
        const module = await import('./conditional-activation.js');
        evaluateConditionRule = module.evaluateConditionRule;
    }
    return evaluateConditionRule;
}

/**
 * Evaluates advanced conditions for a collection
 * @param {object} meta Collection metadata
 * @param {object} context Search context
 * @param {string} collectionId Collection identifier (for logging)
 * @returns {Promise<boolean>} Whether conditions pass
 */
async function evaluateAdvancedConditions(meta, context, collectionId) {
    if (!meta.conditions || !meta.conditions.enabled) {
        return true; // No conditions = pass
    }

    const rules = meta.conditions.rules || [];
    if (rules.length === 0) {
        return true; // Enabled but no rules = pass
    }

    const evaluate = await getConditionEvaluator();

    const results = rules.map(rule => {
        const result = evaluate(rule, context);
        console.log(`VectHare: Collection ${collectionId} condition ${rule.type}: ${result}`);
        return result;
    });

    const logic = meta.conditions.logic || 'AND';
    return logic === 'AND' ? results.every(r => r) : results.some(r => r);
}

/**
 * Checks if a collection should activate based on triggers and conditions
 *
 * ACTIVATION PRIORITY:
 * 1. Disabled (enabled=false) → Never activate
 * 2. Always Active → Always activate (ignores triggers and conditions)
 * 2.5. Locked to current chat → Activate (overrides triggers/conditions)
 * 2.6. Locked to current character → Activate (overrides triggers/conditions)
 * 3. Triggers match → Activate (primary method)
 * 4. Advanced conditions pass → Activate (secondary method)
 * 5. No triggers AND no conditions → Auto-activate (backwards compatible)
 *
 * @param {string} collectionId Collection identifier
 * @param {object} context Search context (from buildSearchContext)
 * @returns {Promise<boolean>} Whether the collection should be queried
 */
export async function shouldCollectionActivate(collectionId, context) {
    const meta = getCollectionMeta(collectionId);

    // Priority 1: Check if collection is disabled entirely
    if (meta.enabled === false) {
        console.log(`[VectHare Activation Filter] Collection ${collectionId}: ✗ DISABLED`);
        return false;
    }

    // Priority 2: Check if always active (ignores everything else)
    if (meta.alwaysActive === true) {
        console.log(`[VectHare Activation Filter] Collection ${collectionId}: ✓ ALWAYS_ACTIVE`);
        return true;
    }

    // Priority 2.5: Check if locked to current chat (overrides other conditions)
    const currentChatId = context?.currentChatId;
    if (currentChatId && isCollectionLockedToChat(collectionId, currentChatId)) {
        console.log(`[VectHare Activation Filter] Collection ${collectionId}: ✓ LOCKED_TO_CURRENT_CHAT (${currentChatId})`);
        return true;
    }

    // Priority 2.6: Check if locked to current character (overrides other conditions)
    const currentCharacterId = context?.currentCharacterId;
    if (currentCharacterId && isCollectionLockedToCharacter(collectionId, currentCharacterId)) {
        console.log(`[VectHare Activation Filter] Collection ${collectionId}: ✓ LOCKED_TO_CURRENT_CHARACTER (${currentCharacterId})`);
        return true;
    }

    const hasTriggers = meta.triggers && meta.triggers.length > 0;
    const hasConditions = meta.conditions?.enabled && meta.conditions?.rules?.length > 0;

    console.log(`[VectHare Activation Filter] Collection ${collectionId}: hasTriggers=${hasTriggers}, hasConditions=${hasConditions}`);

    // Priority 3: Check activation triggers (PRIMARY method)
    if (hasTriggers) {
        const triggersMatch = checkTriggers(meta.triggers, context, {
            matchMode: meta.triggerMatchMode || 'any',
            caseSensitive: meta.triggerCaseSensitive || false,
            scanDepth: meta.triggerScanDepth || 5,
        });

        if (triggersMatch) {
            console.log(`[VectHare Activation Filter] Collection ${collectionId}: ✓ TRIGGERS_MATCHED (${meta.triggers.join(', ')})`);
            return true;
        }

        // Triggers set but didn't match - check if we should fall through to conditions
        if (!hasConditions) {
            console.log(`[VectHare Activation Filter] Collection ${collectionId}: ✗ TRIGGERS_NOT_MATCHED (no conditions to fallthrough)`);
            return false;
        }
    }

    // Priority 4: Check advanced conditions (SECONDARY method)
    if (hasConditions) {
        const conditionsPass = await evaluateAdvancedConditions(meta, context, collectionId);
        console.log(`[VectHare Activation Filter] Collection ${collectionId}: ${conditionsPass ? '✓' : '✗'} CONDITIONS_${conditionsPass ? 'PASS' : 'FAIL'}`);
        return conditionsPass;
    }

    // Priority 5: Chat collections auto-activate when no triggers/conditions are configured.
    // Non-chat collections (documents, lorebooks, characters) require explicit triggers/conditions
    // because they are shared across chats and should not pollute every conversation by default.
    const parsed = parseRegistryKey(collectionId);
    const isChatCollection = parsed.collectionId?.startsWith(COLLECTION_PREFIXES.VECTHARE_CHAT)
        || collectionId.startsWith(COLLECTION_PREFIXES.VECTHARE_CHAT);

    if (isChatCollection) {
        console.log(`[VectHare Activation Filter] Collection ${collectionId}: ✓ AUTO_ACTIVATED (chat collection, no triggers needed)`);
        return true;
    }

    console.log(`[VectHare Activation Filter] Collection ${collectionId}: ✗ NO_TRIGGERS_OR_CONDITIONS (non-chat collection requires explicit triggers)`);
    return false;
}

/**
 * Filters a list of collection IDs to only those that should activate
 * @param {string[]} collectionIds Array of collection IDs to check
 * @param {object} context Search context (from buildSearchContext)
 * @returns {Promise<string[]>} Collection IDs that should be queried
 */
export async function filterActiveCollections(collectionIds, context) {
    const results = await Promise.all(
        collectionIds.map(async (id) => ({
            id,
            active: await shouldCollectionActivate(id, context)
        }))
    );

    const activeIds = results.filter(r => r.active).map(r => r.id);

    console.log(`[VectHare Activation Filter] Summary: ${collectionIds.length} collections → ${activeIds.length} active`);
    if (activeIds.length > 0) {
        console.log(`[VectHare Activation Filter] Active collections:`, activeIds);
    }

    return activeIds;
}

// ============================================================================
// ACTIVATION TRIGGER HELPERS
// ============================================================================

/**
 * Sets activation triggers for a collection
 * @param {string} collectionId Collection identifier
 * @param {string[]} triggers Array of trigger keywords
 * @param {object} options Optional: matchMode, caseSensitive, scanDepth
 */
export function setCollectionTriggers(collectionId, triggers, options = {}) {
    const update = { triggers };
    if (options.matchMode !== undefined) update.triggerMatchMode = options.matchMode;
    if (options.caseSensitive !== undefined) update.triggerCaseSensitive = options.caseSensitive;
    if (options.scanDepth !== undefined) update.triggerScanDepth = options.scanDepth;
    setCollectionMeta(collectionId, update);
}

/**
 * Gets activation triggers for a collection
 * @param {string} collectionId Collection identifier
 * @returns {object} { triggers, matchMode, caseSensitive, scanDepth }
 */
export function getCollectionTriggers(collectionId) {
    const meta = getCollectionMeta(collectionId);
    return {
        triggers: meta.triggers || [],
        matchMode: meta.triggerMatchMode || 'any',
        caseSensitive: meta.triggerCaseSensitive || false,
        scanDepth: meta.triggerScanDepth || 5,
    };
}

/**
 * Sets the always active flag for a collection
 * @param {string} collectionId Collection identifier
 * @param {boolean} alwaysActive Whether to always activate
 */
export function setCollectionAlwaysActive(collectionId, alwaysActive) {
    setCollectionMeta(collectionId, { alwaysActive });
}

/**
 * Checks if a collection is set to always active
 * @param {string} collectionId Collection identifier
 * @returns {boolean} Whether collection is always active
 */
export function isCollectionAlwaysActive(collectionId) {
    const meta = getCollectionMeta(collectionId);
    return meta.alwaysActive === true;
}

/**
 * Gets a summary of a collection's activation settings
 * @param {string} collectionId Collection identifier
 * @returns {object} Summary of activation state
 */
export function getCollectionActivationSummary(collectionId) {
    const meta = getCollectionMeta(collectionId);
    const triggers = meta.triggers || [];
    const hasConditions = meta.conditions?.enabled && meta.conditions?.rules?.length > 0;

    let mode = 'auto'; // No triggers, no conditions = auto-activate
    if (meta.alwaysActive) {
        mode = 'always';
    } else if (triggers.length > 0) {
        mode = 'triggers';
    } else if (hasConditions) {
        mode = 'conditions';
    }

    return {
        mode,
        alwaysActive: meta.alwaysActive || false,
        triggerCount: triggers.length,
        conditionCount: meta.conditions?.rules?.length || 0,
        conditionsEnabled: hasConditions,
    };
}

// ============================================================================
// ADVANCED CONDITIONS HELPERS
// ============================================================================

/**
 * Sets conditions for a collection
 * @param {string} collectionId Collection identifier
 * @param {object} conditions Conditions object { enabled, logic, rules }
 */
export function setCollectionConditions(collectionId, conditions) {
    setCollectionMeta(collectionId, { conditions });
}

/**
 * Gets conditions for a collection
 * @param {string} collectionId Collection identifier
 * @returns {object} Conditions object
 */
export function getCollectionConditions(collectionId) {
    const meta = getCollectionMeta(collectionId);
    return meta.conditions || { enabled: false, logic: 'AND', rules: [] };
}

// ============================================================================
// TEMPORAL DECAY HELPERS (Per-Collection)
// ============================================================================

/**
 * Default temporal decay settings
 */
const defaultTemporalDecay = {
    enabled: false,
    mode: 'exponential',
    halfLife: 50,
    linearRate: 0.01,
    minRelevance: 0.3,
    sceneAware: false,
};

/**
 * Gets temporal decay settings for a collection
 * Uses type-aware defaults (chat = enabled by default)
 * @param {string} collectionId Collection identifier
 * @returns {object} Decay settings for this collection
 */
export function getCollectionDecaySettings(collectionId) {
    const meta = getCollectionMeta(collectionId);

    // If collection has explicit decay settings, use them
    if (meta.temporalDecay) {
        return {
            enabled: meta.temporalDecay.enabled ?? false,
            mode: meta.temporalDecay.mode || 'exponential',
            halfLife: meta.temporalDecay.halfLife || 50,
            linearRate: meta.temporalDecay.linearRate || 0.01,
            minRelevance: meta.temporalDecay.minRelevance || 0.3,
            sceneAware: meta.temporalDecay.sceneAware ?? false,
        };
    }

    // Otherwise use type-aware defaults
    const collectionType = meta.scope === 'chat' ? 'chat' : (meta.type || 'unknown');
    return getDefaultDecayForType(collectionType);
}

/**
 * Sets temporal decay settings for a collection
 * @param {string} collectionId Collection identifier
 * @param {object} decaySettings Temporal decay settings
 */
export function setCollectionDecaySettings(collectionId, decaySettings) {
    const existing = getCollectionMeta(collectionId);
    const merged = {
        ...defaultTemporalDecay,
        ...existing.temporalDecay,
        ...decaySettings,
    };
    setCollectionMeta(collectionId, { temporalDecay: merged });
}

/**
 * Checks if a collection has custom (non-default) decay settings
 * @param {string} collectionId Collection identifier
 * @returns {boolean} Whether collection has custom decay configuration
 */
export function hasCustomDecaySettings(collectionId) {
    const meta = getCollectionMeta(collectionId);
    return meta.temporalDecay !== undefined && meta.temporalDecay !== null;
}

/**
 * Gets a summary of temporal decay for display
 * @param {string} collectionId Collection identifier
 * @returns {object} Summary { isCustom, enabled, mode, description }
 */
export function getCollectionDecaySummary(collectionId) {
    const meta = getCollectionMeta(collectionId);
    const isCustom = hasCustomDecaySettings(collectionId);
    const settings = getCollectionDecaySettings(collectionId);

    let description = 'Disabled';
    if (settings.enabled) {
        if (settings.mode === 'exponential') {
            description = `Exponential (half-life: ${settings.halfLife} msgs)`;
        } else {
            description = `Linear (${(settings.linearRate * 100).toFixed(1)}% per msg)`;
        }
        if (settings.sceneAware) {
            description += ', scene-aware';
        }
    }

    return {
        isCustom,
        enabled: settings.enabled,
        mode: settings.mode,
        description,
    };
}

// ============================================================================
// TEMPORALLY BLIND CHUNKS
// ============================================================================
// Chunks marked as "temporally blind" are immune to temporal decay.
// Their relevance score will not decrease over time regardless of age.
// Useful for important context that should always remain relevant.

/**
 * Marks a chunk as temporally blind (immune to decay)
 * @param {string} hash Chunk hash
 * @param {boolean} isBlind Whether the chunk is temporally blind
 */
export function setChunkTemporallyBlind(hash, isBlind) {
    const existing = getChunkMetadata(hash) || {};
    saveChunkMetadata(hash, {
        ...existing,
        temporallyBlind: isBlind,
    });
    console.log(`VectHare: Chunk ${hash} temporally blind: ${isBlind}`);
}

/**
 * Checks if a chunk is temporally blind
 * @param {string} hash Chunk hash
 * @returns {boolean} Whether the chunk is immune to decay
 */
export function isChunkTemporallyBlind(hash) {
    const meta = getChunkMetadata(hash);
    return meta?.temporallyBlind === true;
}

/**
 * Gets all temporally blind chunk hashes
 * @returns {string[]} Array of chunk hashes that are temporally blind
 */
export function getTemporallyBlindChunks() {
    if (!extension_settings.vecthare) {
        return [];
    }

    const blindChunks = [];
    for (const key in extension_settings.vecthare) {
        if (key.startsWith('vecthare_chunk_meta_')) {
            const meta = extension_settings.vecthare[key];
            if (meta?.temporallyBlind === true) {
                const hash = key.replace('vecthare_chunk_meta_', '');
                blindChunks.push(hash);
            }
        }
    }
    return blindChunks;
}

/**
 * Gets count of temporally blind chunks
 * @returns {number} Number of temporally blind chunks
 */
export function getTemporallyBlindCount() {
    return getTemporallyBlindChunks().length;
}
