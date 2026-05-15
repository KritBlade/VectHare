/**
 * ============================================================================
 * VECTFOX COLLECTION LOADER
 * ============================================================================
 * Data access layer for managing vector collections and chunks
 *
 * @author Kritblade
 * @version 3.3.1
 * ============================================================================
 */

import { extension_settings } from '../../../../extensions.js';
import { getContext } from '../../../../extensions.js';
import { characters, substituteParams, getRequestHeaders, saveSettingsDebounced } from '../../../../../script.js';
import { getSavedHashes, queryCollection } from './core-vector-api.js';
import { getStringHash } from '../../../../utils.js';
import {
    isCollectionEnabled,
    setCollectionEnabled,
    getChunkMetadata,
    saveChunkMetadata,
    deleteChunkMetadata,
    deleteCollectionMeta,
    ensureCollectionMeta,
    getCollectionMeta,
    setCollectionMeta,
} from './collection-metadata.js';
import { purgeVectorIndex } from './core-vector-api.js';
// Import from collection-ids.js - single source of truth for collection ID operations
import {
    getChatUUID,
    buildChatCollectionId as getChatCollectionId,
    buildLegacyChatCollectionId as getLegacyChatCollectionId,
    parseCollectionId,
    buildChatSearchPatterns,
    matchesPatterns,
    parseRegistryKey,
    COLLECTION_PREFIXES,
    getRegistryBackend,
} from './collection-ids.js';

// Plugin detection state
let pluginAvailable = null;

/**
 * Detect collection IDs that VECTFOX should NOT register or query.
 * Two categories:
 *   1. Prefix-stacked corruption — IDs that start with a known backend name without
 *      a colon separator (e.g. "vectraopenrouterfile_xxx"). These come from a prior
 *      bug where the registry key was used as the on-disk collection name. The
 *      filesystem stripped colons, leaving folders that get re-discovered each load.
 *   2. ST-native file attachments — IDs starting with "file_<digits>". Created by
 *      SillyTavern's built-in Vector Storage extension when files are attached to
 *      chat. VECTFOX can't usefully retrieve from them (different embedding model
 *      and lifecycle) and they pollute the query path.
 *
 * @param {string} collectionId - Plain collection ID (no backend:source: prefix)
 * @returns {string|null} Reason string when filtered, null when ID is OK
 */
export function getCollectionFilterReason(collectionId) {
    if (!collectionId || typeof collectionId !== 'string') return null;

    // (1) Internal VECTFOX system collections (health checks, test indexes).
    if (collectionId.startsWith('__vectfox_')) {
        return 'internal-system';
    }

    // (2) Stacked-prefix corruption. Real collection IDs never start with a backend
    // name; backend is only used in the registry key with colon separators.
    if (/^(vectra|qdrant|standard)(?![:_])/i.test(collectionId)) {
        return 'corrupted-prefix-stacked';
    }

    // (3) ST-native file attachments — `file_` followed by digits.
    if (/^file_\d+$/.test(collectionId)) {
        return 'st-native-file';
    }

    return null;
}

/**
 * Gets or initializes the collection registry
 * @returns {string[]} Array of collection IDs
 */
export function getCollectionRegistry() {
    if (!extension_settings.vectfox.vectfox_collection_registry) {
        extension_settings.vectfox.vectfox_collection_registry = [];
    }
    return extension_settings.vectfox.vectfox_collection_registry;
}

/**
 * Registers a collection in the registry (idempotent)
 * @param {string} collectionId Collection identifier
 */
/**
 * Sanitize a persona name into the handleId form used by collection-ID builders.
 * Must match buildChatCollectionId / buildEventBaseCollectionId / buildArchiveEventCollectionId.
 */
export function sanitizeHandleId(name) {
    return String(name || 'user')
        .normalize('NFC')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, '_')
        .replace(/^_|_$/g, '')
        .substring(0, 30) || 'user';
}

function _sanitizeHandleId(name) { return sanitizeHandleId(name); }

export function registerCollection(collectionId) {
    if (!collectionId) {
        console.warn('VectFox: Attempted to register null/undefined collectionId, skipping');
        return;
    }
    const registry = getCollectionRegistry();
    const isNew = !registry.includes(collectionId);
    if (isNew) {
        registry.push(collectionId);
        console.log(`VectFox: Registered collection: ${collectionId}`);
    }

    // Stamp the creator's persona handle on the collection metadata so the DB Browser can
    // filter by current persona without parsing the collection name (which is ambiguous when
    // handle / charName contain underscores).
    //
    // Two safety conditions:
    //   (a) Don't overwrite an existing creatorHandle — first stamper wins, so a later
    //       discovery on a different persona's machine can't claim someone else's collection.
    //   (b) Only stamp when the collection name actually contains the current persona's
    //       handle. Auto-discovery registers ALL collections on the server, including ones
    //       belonging to other personas; those names won't contain our handle, so we skip
    //       them. This means foreign collections stay unstamped → DB browser falls back to
    //       name-parse filter for them (which correctly hides them from the current persona).
    try {
        const meta = getCollectionMeta(collectionId);
        if (!meta?.creatorHandle) {
            const ctx = getContext();
            const handle = _sanitizeHandleId(ctx?.name1);
            const idLower = String(collectionId).toLowerCase();
            if (idLower.includes(`_${handle}_`)) {
                setCollectionMeta(collectionId, { creatorHandle: handle });
                if (extension_settings.vectfox?.eventbase_debug_logging) console.log(`VectFox: Stamped creatorHandle="${handle}" on ${collectionId}`);
            }
        }
    } catch (e) {
        console.warn('VectFox: failed to stamp creatorHandle:', e?.message);
    }

    if (isNew) {
        saveSettingsDebounced(); // Persist to disk!
    }
}

/**
 * Unregisters a collection from the registry
 * @param {string} collectionId Collection identifier (can be plain id or source:id format)
 */
export function unregisterCollection(collectionId) {
    const registry = getCollectionRegistry();
    const index = registry.indexOf(collectionId);
    if (index !== -1) {
        registry.splice(index, 1);
        console.log(`VectFox: Unregistered collection: ${collectionId}`);
        saveSettingsDebounced(); // Persist to disk!
    } else {
        console.log(`VectFox: Collection not found in registry: ${collectionId}`);
    }
}

/**
 * COMPLETE collection deletion - removes from ALL THREE stores:
 * 1. Vector backend (actual embeddings)
 * 2. Registry (collection tracking)
 * 3. Metadata (display names, settings, chunk info)
 *
 * This is the ONE function that should be called to fully delete a collection.
 * All other delete functions are partial and will leave ghosts.
 *
 * @param {string} collectionId - Collection ID to delete
 * @param {object} settings - VECTFOX settings (for backend routing)
 * @param {string} [registryKey] - Optional registry key (source:id format) if different from collectionId
 * @returns {Promise<{success: boolean, errors: string[], vectorsDeleted: boolean, registryDeleted: boolean, metadataDeleted: boolean}>}
 */
export async function deleteCollection(collectionId, settings, registryKey = null) {
    const errors = [];
    let vectorsDeleted = false;
    let registryDeleted = false;
    let metadataDeleted = false;

    console.log(`VectFox: Deleting collection ${collectionId} (registry key: ${registryKey || collectionId})`);

    // Step 1: Delete vectors from backend (most important - actual data)
    try {
        await purgeVectorIndex(collectionId, settings);
        vectorsDeleted = true;
        console.log(`VectFox: ✓ Deleted vectors for ${collectionId}`);
    } catch (error) {
        errors.push(`Vectors: ${error.message}`);
        console.warn(`VectFox: ✗ Failed to delete vectors for ${collectionId}:`, error.message);
        // Continue anyway - registry/metadata cleanup is still valuable
    }

    // Step 2: Unregister from registry (try both formats)
    try {
        const keyToUnregister = registryKey || collectionId;
        unregisterCollection(keyToUnregister);

        // Also try the other format if they differ
        if (registryKey && registryKey !== collectionId) {
            unregisterCollection(collectionId);
        }

        registryDeleted = true;
        console.log(`VectFox: ✓ Unregistered ${collectionId}`);
    } catch (error) {
        errors.push(`Registry: ${error.message}`);
        console.warn(`VectFox: ✗ Failed to unregister ${collectionId}:`, error.message);
    }

    // Step 3: Delete metadata
    try {
        deleteCollectionMeta(collectionId);
        metadataDeleted = true;
        console.log(`VectFox: ✓ Deleted metadata for ${collectionId}`);
    } catch (error) {
        errors.push(`Metadata: ${error.message}`);
        console.warn(`VectFox: ✗ Failed to delete metadata for ${collectionId}:`, error.message);
    }

    // Step 4: Clear EventBase window fingerprint cache if this is an EventBase collection.
    // The UUID is always the last underscore-separated segment of the collection ID.
    if (collectionId.startsWith(COLLECTION_PREFIXES.VECTFOX_EVENTBASE)) {
        try {
            const { clearWindowCacheForChat } = await import('./eventbase-store.js');
            const chatUUID = collectionId.split('_').pop();
            if (chatUUID) clearWindowCacheForChat(chatUUID);
        } catch {
            // Best-effort — don't fail the whole delete if this breaks.
        }
    }

    const success = vectorsDeleted && registryDeleted && metadataDeleted;

    if (success) {
        console.log(`VectFox: ✓ Fully deleted collection ${collectionId}`);
    } else {
        // VEC-28: Warn about partial deletion to prevent zombie collections
        const warningMsg = `VectFox: ⚠️ PARTIAL DELETION of ${collectionId} - may create zombie collection. Errors: ${errors.join(', ')}`;
        console.error(warningMsg);
        // Only treat as critical failure if ALL steps failed
        if (!vectorsDeleted && !registryDeleted && !metadataDeleted) {
            throw new Error(`Complete deletion failure for ${collectionId}: ${errors.join(', ')}`);
        }
    }

    return {
        success,
        errors,
        vectorsDeleted,
        registryDeleted,
        metadataDeleted,
    };
}

/**
 * Clears the entire registry (useful for debugging/reset)
 */
export function clearCollectionRegistry() {
    extension_settings.vectfox.vectfox_collection_registry = [];
    console.log('VectFox: Cleared collection registry');
    saveSettingsDebounced(); // Persist to disk!
}

/**
 * Cleans up registry by removing null entries and duplicates
 */
export function cleanupCollectionRegistry() {
    const registry = getCollectionRegistry();
    const cleaned = [...new Set(registry.filter(id => id != null && id !== ''))];
    extension_settings.vectfox.vectfox_collection_registry = cleaned;
    const removed = registry.length - cleaned.length;
    if (removed > 0) {
        console.log(`VectFox: Cleaned registry - removed ${removed} invalid/duplicate entries`);
        saveSettingsDebounced(); // Persist to disk!
    }
    return removed;
}

/**
 * Cleans up test collections from registry (visualizer/production tests)
 * Call this to remove ghost test entries that weren't properly cleaned up
 * @returns {number} Number of test entries removed
 */
export function cleanupTestCollections() {
    const registry = getCollectionRegistry();
    const testPatterns = [
        'vectfox_visualizer_test_',
        '__vectfox_test_',
        'vectfox_test_',
    ];

    const cleaned = registry.filter(id => {
        if (!id) return false;
        // Check if this is a test collection
        for (const pattern of testPatterns) {
            if (id.includes(pattern)) {
                console.log(`VectFox: Removing test collection from registry: ${id}`);
                return false;
            }
        }
        return true;
    });

    const removed = registry.length - cleaned.length;
    if (removed > 0) {
        extension_settings.vectfox.vectfox_collection_registry = cleaned;
        console.log(`VectFox: Cleaned ${removed} test collection entries from registry`);
        saveSettingsDebounced(); // Persist to disk!
    }
    return removed;
}

// parseCollectionId is now imported from collection-ids.js

/**
 * Gets display name for a collection
 * @param {string} collectionId Collection identifier
 * @param {object} metadata Parsed collection metadata
 * @returns {string} Human-readable name
 */
function getCollectionDisplayName(collectionId, metadata) {
    // Check for custom display name first
    const collectionMeta = getCollectionMeta(collectionId);
    if (collectionMeta.displayName) {
        return collectionMeta.displayName;
    }

    // Generate name based on type
    const context = getContext();

    switch (metadata.type) {
        case 'chat': {
            // Try to get chat name from ST
            const chatId = metadata.rawId;

            // Check if it's the current chat
            if (context.chatId === chatId && context.name2) {
                return `💬 Chat: ${context.name2}`;
            }

            // Try to find in characters list
            const character = characters.find(c => c.chat === chatId);
            if (character) {
                return `💬 Chat: ${character.name}`;
            }

              // Fallback: extract character name from rawId if it follows pattern: charName_uuid
            // Format: assistant_503c1099-b769-41e7-8e15-0d652cd6d1b4
            const underscoreIndex = chatId.lastIndexOf('_');
            if (underscoreIndex > 0) {
                // Extract everything before the last underscore (the character name)
                const charName = chatId.substring(0, underscoreIndex);
                return `💬 Chat: ${charName}`;
            }

            // Final fallback to just the ID
            return `💬 Chat #${chatId.substring(0, 8)}`;
        }

        case 'file':
            return `📄 File: ${metadata.rawId}`;

        case 'lorebook':
            return `📚 Lorebook: ${metadata.rawId}`;

        default:
            return collectionId;
    }
}

/**
 * Checks if VECTFOX server plugin is available
 * @returns {Promise<boolean>} True if plugin is available
 */
async function checkPluginAvailable() {
    if (pluginAvailable !== null) {
        return pluginAvailable;
    }

    try {
        const response = await fetch('/api/plugins/similharity/health', {
            method: 'GET',
            headers: getRequestHeaders()
        });

        if (response.ok) {
            const data = await response.json();
            pluginAvailable = data.status === 'ok';
            console.log(`VectFox: Plugin ${pluginAvailable ? 'detected' : 'not found'} (v${data.version || 'unknown'})`);
        } else {
            pluginAvailable = false;
        }
    } catch (error) {
        pluginAvailable = false;
    }

    return pluginAvailable;
}

// Cache for plugin collection data
let pluginCollectionData = null;

/**
 * Discovers existing collections using server plugin (scans file system)
 * @param {object} settings VECTFOX settings
 * @returns {Promise<string[]>} Array of discovered collection IDs
 */
async function discoverViaPlugin(settings) {
    try {
        console.debug('🔍 VectFox: Requesting collection discovery from plugin...');

        // Plugin now scans ALL sources, not just the current one
        const response = await fetch(`/api/plugins/similharity/collections`, {
            method: 'GET',
            headers: getRequestHeaders()
        });

        if (!response.ok) {
            console.warn(`⚠️ VectFox: Plugin collections endpoint failed (status: ${response.status})`);
            console.log('   💡 Make sure the Similharity plugin is installed and running');
            return [];
        }

        const data = await response.json();

        if (data.success && Array.isArray(data.collections)) {
            if (settings?.eventbase_debug_logging) console.log(`✅ VectFox: Plugin found ${data.collections.length} collections across all sources`);

            // Log the sources found
            const sourcesSummary = {};
            data.collections.forEach(c => {
                sourcesSummary[c.source] = (sourcesSummary[c.source] || 0) + 1;
            });
            console.debug('   Sources:', Object.entries(sourcesSummary).map(([s, count]) => `${s}: ${count}`).join(', '));

            // Cache the plugin data (includes chunk counts, sources, AND backends)
            // Key format: "backend:source:collectionId" to handle same collection in multiple backends
            pluginCollectionData = {};
            const uniqueKeys = [];

            let skippedCorruption = 0;
            let skippedStFile = 0;
            let skippedInternal = 0;
            let emptyCount = 0;
            const emptyList = [];
            for (const collection of data.collections) {
                const backend = collection.backend || 'standard';

                // Strip backend prefix from collection.id if it's already there
                // Some backends (like Qdrant) may return IDs with backend prefix
                let collectionId = collection.id;
                if (collectionId.startsWith(`${backend}:`)) {
                    collectionId = collectionId.substring(backend.length + 1);
                    console.debug(`   🔧 Stripped backend prefix from collection ID: ${collection.id} → ${collectionId}`);
                }

                // Skip corrupted/ST-native/internal IDs at discovery time
                const filterReason = getCollectionFilterReason(collectionId);
                if (filterReason) {
                    if (filterReason === 'corrupted-prefix-stacked') skippedCorruption++;
                    else if (filterReason === 'st-native-file') skippedStFile++;
                    else if (filterReason === 'internal-system') skippedInternal++;
                    console.debug(`   ⛔ Skipping ${collectionId} (${filterReason})`);
                    continue;
                }

                // Track empty collections for the summary log (still added to registry
                // so DB Browser can show them and the user can delete them)
                if (!collection.chunkCount) {
                    emptyCount++;
                    emptyList.push(`${backend}:${collectionId}`);
                }

                console.debug(`   - ${backend}:${collectionId} (${collection.chunkCount} chunks)`);

                const collectionData = {
                    chunkCount: collection.chunkCount,
                    source: collection.source,
                    backend: backend,
                    model: collection.model || '',  // Primary model path
                    models: collection.models || []  // All available models
                };

                // Cache by "backend:id" — embedding source is not part of the key
                const cacheKey = `${backend}:${collectionId}`;
                pluginCollectionData[cacheKey] = collectionData;
                uniqueKeys.push(cacheKey);

                // Also cache by sanitized version (for backend lookups)
                const sanitized = collectionId.replace(/[^a-zA-Z0-9_.-]/g, '_');
                if (sanitized !== collectionId) {
                    pluginCollectionData[`${backend}:${sanitized}`] = collectionData;
                }
            }

            // IMPORTANT: Replace registry with what plugin found (removes stale entries)
            // This ensures the registry matches actual disk state
            const currentRegistry = getCollectionRegistry();
            const pluginKeySet = new Set(uniqueKeys);

            if (skippedCorruption > 0 || skippedStFile > 0 || skippedInternal > 0) {
                if (settings?.eventbase_debug_logging) console.log(`   🛡️ Discovery filter excluded ${skippedCorruption} corrupted + ${skippedStFile} ST-native + ${skippedInternal} internal collection(s)`);
            }
            if (emptyCount > 0) {
                console.log(`   ⚠️ ${emptyCount} empty collection(s) with 0 chunks (kept in registry — delete from DB Browser to clean up):`);
                emptyList.forEach(id => console.log(`      - ${id}`));
            }

            console.debug(`\n📋 VectFox: Updating registry...`);
            console.debug(`   Current registry has ${currentRegistry.length} entries`);
            console.debug(`   Plugin discovered ${uniqueKeys.length} collections`);

            // The plugin probes every standard (vectra) and qdrant collection that
            // actually exists. Anything in the registry that was NOT found = stale.
            // Remove it unconditionally — no backend exemptions.
            const updatedRegistry = getCollectionRegistry();
            const staleEntries = updatedRegistry.filter(key => !pluginKeySet.has(key));
            if (staleEntries.length > 0) {
                console.debug(`   🗑️  Removing ${staleEntries.length} stale registry entries:`);
                for (const staleKey of staleEntries) {
                    console.debug(`      - ${staleKey}`);
                    unregisterCollection(staleKey);
                }
            }

            // Register all discovered collections with backend:id format
            let newRegistrations = 0;
            for (const key of uniqueKeys) {
                if (!getCollectionRegistry().includes(key)) {
                    newRegistrations++;
                    console.debug(`   ➕ Registering: ${key}`);
                } else {
                    console.debug(`   ⏭️  Already registered: ${key}`);
                }
                registerCollection(key);
            }            if (newRegistrations > 0 && settings?.eventbase_debug_logging) {
                console.log(`   ✅ Registered ${newRegistrations} new collections`);
            }

            if (settings?.eventbase_debug_logging) console.log(`   Final registry size: ${getCollectionRegistry().length}\n`);

            return uniqueKeys;
        }
    } catch (error) {
        console.error('VectFox: Plugin discovery failed:', error);
    }

    return [];
}

/**
 * Cleanup corrupted/ST-native collections from disk.
 *
 * Re-fetches the raw plugin discovery list (bypasses the discovery filter so we
 * can SEE the corrupted entries), then calls the plugin's /chunks/purge endpoint
 * for each one. Also clears any matching registry entries.
 *
 * @returns {Promise<{purged: Array<{key: string, ok: boolean, error?: string}>, total: number, corruption: number, stFile: number}>}
 */
export async function cleanupCorruptedCollections() {
    const result = {
        purged: [],
        total: 0,
        corruption: 0,
        stFile: 0,
    };

    try {
        const response = await fetch('/api/plugins/similharity/collections', {
            method: 'GET',
            headers: getRequestHeaders(),
        });

        if (!response.ok) {
            throw new Error(`Plugin /collections returned ${response.status}`);
        }

        const data = await response.json();
        if (!data.success || !Array.isArray(data.collections)) {
            throw new Error('Plugin returned no collection list');
        }

        // Pick out everything our discovery filter would skip
        const targets = [];
        for (const collection of data.collections) {
            const backend = collection.backend || 'standard';
            let collectionId = collection.id;
            if (collectionId.startsWith(`${backend}:`)) {
                collectionId = collectionId.substring(backend.length + 1);
            }

            const reason = getCollectionFilterReason(collectionId);
            if (reason) {
                targets.push({
                    backend,
                    source: collection.source || 'transformers',
                    collectionId,
                    reason,
                    registryKey: `${backend}:${collection.source}:${collectionId}`,
                });
            }
        }

        result.total = targets.length;
        result.corruption = targets.filter(t => t.reason === 'corrupted-prefix-stacked').length;
        result.stFile = targets.filter(t => t.reason === 'st-native-file').length;

        if (targets.length === 0) {
            console.log('VECTFOX cleanup: no corrupted or ST-native file collections found on disk');
            return result;
        }

        console.log(`VECTFOX cleanup: purging ${targets.length} collection(s) (${result.corruption} corrupted, ${result.stFile} ST-native file)`);

        for (const target of targets) {
            try {
                const purgeResp = await fetch('/api/plugins/similharity/chunks/purge', {
                    method: 'POST',
                    headers: getRequestHeaders(),
                    body: JSON.stringify({
                        backend: target.backend,
                        collectionId: target.collectionId,
                        source: target.source,
                    }),
                });

                if (!purgeResp.ok) {
                    const body = await purgeResp.text().catch(() => '');
                    throw new Error(`HTTP ${purgeResp.status}: ${body.substring(0, 200)}`);
                }

                // Drop from registry too
                unregisterCollection(target.registryKey);

                result.purged.push({ key: target.registryKey, ok: true });
                console.log(`   ✅ Purged ${target.registryKey} (${target.reason})`);
            } catch (err) {
                result.purged.push({ key: target.registryKey, ok: false, error: err.message });
                console.warn(`   ❌ Failed to purge ${target.registryKey}: ${err.message}`);
            }
        }

        // Reset plugin cache so a subsequent discovery sees the fresh state
        pluginAvailable = null;
    } catch (error) {
        console.error('VECTFOX cleanup: failed', error);
        throw error;
    }

    return result;
}

/**
 * Probes a collection ID to check if it exists
 * @param {string} collectionId - Collection ID to probe
 * @param {object} settings - VECTFOX settings
 * @returns {Promise<{exists: boolean, count: number}>}
 */
async function probeCollection(collectionId, settings) {
    try {
        const hashes = await getSavedHashes(collectionId, settings);
        if (hashes && hashes.length > 0) {
            return { exists: true, count: hashes.length };
        }
    } catch (error) {
        // Collection doesn't exist or error - that's fine
    }
    return { exists: false, count: 0 };
}

/**
 * Discovers existing collections by probing the registry and known patterns
 * Without the plugin, we can't scan the filesystem directly, so we:
 * 1. Check all collections already in the registry (may have been created before)
 * 2. Probe for current chat's collection
 * 3. Probe for collections based on known character names
 *
 * @param {object} settings VECTFOX settings
 * @returns {Promise<string[]>} Array of discovered collection IDs
 */
async function discoverViaFallback(settings) {
    const context = getContext();
    const discovered = [];
    const probed = new Set();

    console.log('VectFox: Running fallback discovery (no plugin)...');

    // 1. Validate existing registry entries - remove stale ones
    const registry = getCollectionRegistry();
    const validRegistryEntries = [];

    for (const registryKey of [...registry]) {
        if (probed.has(registryKey)) continue;
        probed.add(registryKey);

        // Parse the registry key to get the actual collection ID
        const parsed = parseRegistryKey(registryKey);
        const collectionId = parsed.collectionId;

        const result = await probeCollection(collectionId, settings);
        if (result.exists) {
            validRegistryEntries.push(registryKey);
            if (!discovered.includes(registryKey)) {
                discovered.push(registryKey);
            }
            console.log(`VectFox: Verified registry entry: ${collectionId} (${result.count} chunks)`);
        } else {
            // Remove stale entry
            unregisterCollection(registryKey);
            console.log(`VectFox: Removed stale registry entry: ${registryKey}`);
        }
    }

    // 2. Probe for current chat's collection (both formats)
    if (context.chatId) {
        // vf_chat_{charName}_{uuid}
        const newFormatId = getChatCollectionId();
        if (newFormatId && !probed.has(newFormatId)) {
            probed.add(newFormatId);
            const result = await probeCollection(newFormatId, settings);
            if (result.exists) {
                registerCollection(newFormatId);
                discovered.push(newFormatId);
                console.log(`VectFox: Discovered current chat collection: ${newFormatId} (${result.count} chunks)`);
            }
        }

        // Legacy format (DEAD): vf_chat_{chatId}
        const legacyFormatId = getLegacyChatCollectionId(context.chatId);
        if (legacyFormatId && !probed.has(legacyFormatId)) {
            probed.add(legacyFormatId);
            const result = await probeCollection(legacyFormatId, settings);
            if (result.exists) {
                registerCollection(legacyFormatId);
                discovered.push(legacyFormatId);
                console.log(`VectFox: Discovered legacy chat collection: ${legacyFormatId} (${result.count} chunks)`);
            }
        }
    }

    // 3. Probe for character-based collections
    for (const char of characters) {
        if (!char.name) continue;

        const sanitizedName = char.name.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '_').substring(0, 30);

        // VECTFOX character collection format
        const charCollectionId = `${COLLECTION_PREFIXES.VECTFOX_CHARACTER}${sanitizedName}`;
        if (!probed.has(charCollectionId)) {
            probed.add(charCollectionId);
            const result = await probeCollection(charCollectionId, settings);
            if (result.exists) {
                registerCollection(charCollectionId);
                discovered.push(charCollectionId);
                console.log(`VectFox: Discovered character collection: ${charCollectionId} (${result.count} chunks)`);
            }
        }
    }

    // 4. Probe for common content type patterns that might exist
    const contentPatterns = [
        // Lorebook patterns
        `${COLLECTION_PREFIXES.VECTFOX_LOREBOOK}`,
        // Document patterns
        `${COLLECTION_PREFIXES.VECTFOX_DOCUMENT}`,
    ];

    // Note: Without filesystem access, we can't discover collections with unknown IDs
    // The registry is our primary source of truth for non-current-chat collections

    console.log(`VectFox: Fallback discovery complete. Found ${discovered.length} collections.`);
    return discovered;
}

/**
 * Discovers existing collections (uses plugin if available, fallback otherwise)
 * @param {object} settings VECTFOX settings
 * @returns {Promise<string[]>} Array of discovered collection IDs
 */
export async function discoverExistingCollections(settings) {
    const hasPlugin = await checkPluginAvailable();

    if (hasPlugin) {
        if (settings?.eventbase_debug_logging) console.log('VectFox: Using plugin for collection discovery');
        return await discoverViaPlugin(settings);
    } else {
        console.log('VectFox: Plugin not available, using fallback discovery');
        return await discoverViaFallback(settings);
    }
}

/**
 * SINGLE SOURCE OF TRUTH: Check if a specific chat has vectors
 * This runs discovery if needed and checks all possible locations
 * @param {object} settings VECTFOX settings
 * @param {string} [overrideChatId] Optional chat ID override
 * @param {string} [overrideUUID] Optional UUID override
 * @returns {Promise<{hasVectors: boolean, collectionId: string|null, chunkCount: number}>}
 */
export async function doesChatHaveVectors(settings, overrideChatId, overrideUUID) {
    // Always run discovery first to ensure registry is current
    await discoverExistingCollections(settings);

    const registry = getCollectionRegistry();

    // Get current chat identifiers
    const uuid = overrideUUID || getChatUUID();
    const chatId = overrideChatId || (getContext().chatId);

    // Use unified pattern builder from collection-ids.js
    const searchPatterns = buildChatSearchPatterns(chatId, uuid);

    console.log(`VectFox: Searching for chat vectors. UUID: ${uuid}, Patterns:`, searchPatterns);

    // Collect ALL matching collections, then pick the best one
    // This handles ghost collections (empty) vs real collections (has chunks)
    const matchingCollections = [];

    for (const registryKey of registry) {
        // Use unified registry key parser from collection-ids.js
        const parsed = parseRegistryKey(registryKey);
        const collectionId = parsed.collectionId;

        // Use unified pattern matching from collection-ids.js
        const matches = matchesPatterns(registryKey, searchPatterns) ||
                       matchesPatterns(collectionId, searchPatterns);

        if (matches) {
            // Get chunk count, source, and backend from plugin cache if available
            let chunkCount = 0;
            let source = parsed.source || 'unknown';
            let backend = parsed.backend || 'standard';

            if (pluginCollectionData && pluginCollectionData[registryKey]) {
                const cacheData = pluginCollectionData[registryKey];
                chunkCount = cacheData.chunkCount || 0;
                source = cacheData.source || source;
                backend = cacheData.backend || backend;
            }

            matchingCollections.push({
                collectionId,
                registryKey,
                chunkCount,
                source,
                backend
            });
            console.log(`VectFox: Found matching collection ${collectionId} (${chunkCount} chunks, backend: ${backend})`);
        }
    }

    // If we found matches, return ALL of them sorted by chunk count (best first)
    if (matchingCollections.length > 0) {
        // Sort by chunk count descending
        matchingCollections.sort((a, b) => b.chunkCount - a.chunkCount);

        const best = matchingCollections[0];
        console.log(`VectFox: Found ${matchingCollections.length} matching collection(s), best is ${best.collectionId} with ${best.chunkCount} chunks`);

        return {
            hasVectors: true,
            collectionId: best.collectionId,
            registryKey: best.registryKey,
            chunkCount: best.chunkCount,
            allMatches: matchingCollections  // Return ALL matches for user selection
        };
    }

    // Not found in registry - try direct query as last resort
    const newFormatId = getChatCollectionId(uuid);
    const legacyFormatId = getLegacyChatCollectionId(chatId);

    for (const id of [newFormatId, legacyFormatId].filter(Boolean)) {
        try {
            const hashes = await getSavedHashes(id, settings);
            if (hashes && hashes.length > 0) {
                // Found vectors! Register it now
                registerCollection(id);
                console.log(`VectFox: Found ${hashes.length} vectors via direct query, registered ${id}`);
                return {
                    hasVectors: true,
                    collectionId: id,
                    registryKey: id,
                    chunkCount: hashes.length
                };
            }
        } catch (e) {
            // Query failed, continue to next format
        }
    }

    console.log('VectFox: No vectors found for current chat');
    return { hasVectors: false, collectionId: null, registryKey: null, chunkCount: 0 };
}

/**
 * Loads all collections with metadata
 * @param {object} settings VECTFOX settings
 * @param {boolean} autoDiscover If true, attempts to discover unregistered collections
 * @returns {Promise<object[]>} Array of collection objects
 */
export async function loadAllCollections(settings, autoDiscover = true) {
    const debugLog = !!settings?.eventbase_debug_logging;
    console.debug('🐰 VectFox: Loading all collections for Database Browser...');

    // Clean up registry first (remove nulls and duplicates)
    cleanupCollectionRegistry();

    // Auto-discover existing collections on first load
    if (autoDiscover) {
        await discoverExistingCollections(settings);
    }

    const registry = getCollectionRegistry();
    console.debug(`VectFox: Registry contains ${registry.length} collection(s):`, registry);

    const collections = [];
    const hasPlugin = pluginAvailable === true;

    for (const registryKey of registry) {
        try {
            // Use unified registry key parser from collection-ids.js
            const parsedKey = parseRegistryKey(registryKey);
            const collectionId = parsedKey.collectionId;
            const registrySource = parsedKey.source;
            const registryBackend = parsedKey.backend;

            // Ensure creatorHandle is stamped for any entry that was registered before the stamp
            // logic landed, or imported from another session. registerCollection() is idempotent:
            // won't duplicate, won't overwrite an existing handle, and only saves for truly new entries.
            registerCollection(registryKey);

            if (debugLog) console.log(`VectFox: Loading collection: ${collectionId} (backend: ${registryBackend || 'unknown'}, source: ${registrySource || 'unknown'})`);

            // First check stored metadata for user-defined contentType (authoritative source)
            const storedMeta = getCollectionMeta(registryKey) || getCollectionMeta(collectionId);
            const parsedMeta = parseCollectionId(collectionId);

            // Use stored contentType if available, otherwise fall back to parsed
            const metadata = {
                type: storedMeta.contentType || parsedMeta.type,
                scope: storedMeta.scope || parsedMeta.scope,
                rawId: parsedMeta.rawId,
            };
            if (debugLog) console.log(`VectFox:   Type: ${metadata.type}, Scope: ${metadata.scope}${storedMeta.contentType ? ' (from stored meta)' : ' (parsed from ID)'}`);

            let chunkCount = 0;
            let hashes = [];
            let source = registrySource || 'unknown';
            let backend = registryBackend || 'standard';
            let model = '';
            let models = [];

            // If plugin is available, use chunk count, source, and backend from plugin cache
            // Cache key is "backend:collectionId" (same as registryKey for plugin-managed collections)
            const cacheKey = registryKey;
            if (hasPlugin && pluginCollectionData && pluginCollectionData[cacheKey]) {
                if (debugLog) console.log(`VectFox:   Using plugin mode - getting data from cache`);
                const cacheData = pluginCollectionData[cacheKey];
                source = cacheData.source;
                backend = cacheData.backend;
                models = cacheData.models || [];

                // Check if user has a preferred model saved
                const collectionMeta = getCollectionMeta(registryKey);
                const preferredModel = collectionMeta?.preferredModel;

                if (preferredModel !== undefined && models.some(m => m.path === preferredModel)) {
                    // User has a valid preferred model
                    model = preferredModel;
                    const modelInfo = models.find(m => m.path === preferredModel);
                    chunkCount = modelInfo?.chunkCount || 0;
                    console.log(`VectFox:   Using user's preferred model: ${model}`);
                } else {
                    // Use plugin's default (most chunks)
                    model = cacheData.model || '';
                    chunkCount = cacheData.chunkCount || 0;
                }

                if (debugLog) console.log(`VectFox:   Plugin reported ${chunkCount} chunks (backend: ${backend}, source: ${source}, models: ${models.length})`);
            } else {
                // Fallback mode: registry key tells us the backend. If it's qdrant, query
                // qdrant directly. Otherwise try standard first.
                const registryBk = registryBackend || settings.vector_backend || 'standard';
                console.log(`VectFox:   Using fallback mode - backend from registry: ${registryBk}`);
                const fallbackSettings = { ...settings, vector_backend: registryBk };
                try {
                    hashes = await getSavedHashes(collectionId, fallbackSettings);
                    chunkCount = hashes?.length || 0;
                    console.log(`VectFox:   Found ${chunkCount} hashes via ${registryBk} backend`);
                } catch (standardError) {
                    // Try the currently-configured backend if different
                    if (settings.vector_backend && settings.vector_backend !== registryBk) {
                        console.log(`VectFox:   ${registryBk} backend failed, trying ${settings.vector_backend}`);
                        try {
                            hashes = await getSavedHashes(collectionId, settings);
                            chunkCount = hashes?.length || 0;
                            console.log(`VectFox:   Found ${chunkCount} hashes via ${settings.vector_backend}`);
                        } catch (altError) {
                            console.warn(`VectFox:   Both backends failed for ${collectionId}`);
                            chunkCount = 0;
                        }
                    } else {
                        console.warn(`VectFox:   ${registryBk} backend failed for ${collectionId}`);
                        chunkCount = 0;
                    }
                }
            }

            const displayName = getCollectionDisplayName(collectionId, metadata);
            if (debugLog) console.log(`VectFox:   Display name: ${displayName}`);

            // Metadata is stored under the bare collectionId (no prefix) so it stays
            // consistent with setCollectionLock and the cleanupOrphanedMeta check.
            const enabled = isCollectionEnabled(registryKey);
            ensureCollectionMeta(collectionId, { scope: metadata.scope });

            collections.push({
                id: collectionId,           // Original collection ID (for API calls)
                registryKey: registryKey,   // Full key with source (for internal tracking)
                name: displayName,
                type: metadata.type,
                scope: metadata.scope,
                chunkCount: chunkCount,
                enabled: enabled,
                hashes: hashes,
                rawId: metadata.rawId,
                source: source,
                backend: backend,
                model: model,               // Primary model path for vectra lookups
                models: models              // All available models [{name, path, chunkCount}]
            });
            if (debugLog) console.log(`VectFox:   ✓ Added to collections list`);
        } catch (error) {
            console.error(`VectFox: Failed to load collection ${registryKey}`, error);
            console.error(`VectFox:   Error details:`, error.message);
            console.error(`VectFox:   Stack:`, error.stack);
            // Continue loading other collections
        }
    }

    if (debugLog) console.log(`\n✅ VectFox: Loaded ${collections.length} non-empty collections for Database Browser`);
    if (collections.length === 0 && registry.length > 0) {
        console.debug(`⚠️ VectFox: ${registry.length} collections in registry but all are empty!`);
        console.debug(`   💡 Collections need to have vectorized chunks to appear in Database Browser`);
        console.debug(`   💡 Try vectorizing your chat or content first`);
    } else if (collections.length === 0 && registry.length === 0) {
        console.debug(`ℹ️ VectFox: No collections registered yet`);
        console.debug(`   💡 Collections are created when you vectorize chat messages or documents`);
    }

    return collections;
}

// Re-export from collection-metadata.js for backwards compatibility
export { setCollectionEnabled, isCollectionEnabled } from './collection-metadata.js';

/**
 * Returns true if the collection has 0 chunks according to the plugin discovery cache.
 * Used by retrieval to skip empty collections without querying them.
 * @param {string} registryKey - e.g. "vectra:vf_lorebook_story1_..."
 * @returns {boolean}
 */
export function isCollectionEmpty(registryKey) {
    if (!pluginCollectionData) return false;
    const cached = pluginCollectionData[registryKey];
    return cached !== undefined && !cached.chunkCount;
}

/**
 * Loads chunks for a specific collection
 * @param {string} collectionId Collection identifier
 * @param {object} settings VECTFOX settings
 * @returns {Promise<object[]>} Array of chunk objects
 */
export async function loadCollectionChunks(collectionId, settings) {
    const context = getContext();
    const result = await getSavedHashes(collectionId, settings, true); // includeMetadata = true

    console.log(`VECTFOX DEBUG: loadCollectionChunks result type:`, Array.isArray(result) ? 'array' : 'object');
    if (!Array.isArray(result)) {
        console.log(`VECTFOX DEBUG: result.metadata length:`, result.metadata?.length);
        if (result.metadata?.length > 0) {
            console.log(`VECTFOX DEBUG: First item metadata:`, result.metadata[0]);
        }
    }

    // Handle both old format (array) and new format (object with hashes + metadata)
    const hashes = Array.isArray(result) ? result : result.hashes;
    const metadataArray = result.metadata || [];

    if (hashes.length === 0) {
        return [];
    }

    const chunks = [];
    const collectionMetadata = parseCollectionId(collectionId);

    // For chat collections, we can get text from chat messages
    if (collectionMetadata.type === 'chat' && context.chatId === collectionMetadata.rawId) {
        const chat = context.chat;

        for (let i = 0; i < hashes.length; i++) {
            const hash = hashes[i];
            const dbMetadata = metadataArray[i] || {};

            // Find message by hash
            const message = chat.find(msg => {
                if (!msg.mes || msg.is_system) return false;
                const msgText = substituteParams(msg.mes);
                return getStringHash(msgText) === hash;
            });

            if (message) {
                chunks.push({
                    text: substituteParams(message.mes),
                    hash: hash,
                    index: chat.indexOf(message),
                    metadata: {
                        messageId: chat.indexOf(message),
                        source: 'chat',
                        // Include keywords and other metadata from DB
                        keywords: dbMetadata.keywords || [],
                        ...dbMetadata
                    }
                });
            }
        }
    } else {
        // For other collection types or inactive chats, text is stored in the vector backend
        // and retrieved via the chunks visualizer's query functionality
        console.warn(`VectFox: Cannot load chunk text for non-active collection: ${collectionId}`);

        // Return minimal data with metadata
        for (let i = 0; i < hashes.length; i++) {
            const hash = hashes[i];
            const dbMetadata = metadataArray[i] || {};

            chunks.push({
                text: dbMetadata.text || '(Text not available - collection not active)',
                hash: hash,
                index: -1,
                metadata: {
                    source: collectionMetadata.type,
                    keywords: dbMetadata.keywords || [],
                    ...dbMetadata
                }
            });
        }
    }

    console.log(`VectFox: Loaded ${chunks.length} chunks for ${collectionId}`);
    return chunks;
}

// Re-export chunk metadata functions from collection-metadata.js for backwards compatibility
export { getChunkMetadata, saveChunkMetadata, deleteChunkMetadata } from './collection-metadata.js';
