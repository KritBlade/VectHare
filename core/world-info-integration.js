/**
 * ============================================================================
 * VectFox WORLD INFO INTEGRATION
 * ============================================================================
 * Enhanced integration between vectorized lorebooks and ST's world info system
 * Provides semantic activation of WI entries based on vector similarity
 *
 * @author VectFox Team
 * @version 1.0.0
 * ============================================================================
 */

import { extension_settings, getContext } from '../../../../extensions.js';
import { queryCollection } from './core-vector-api.js';
import { getCollectionMeta, isCollectionEnabled, shouldCollectionActivate } from './collection-metadata.js';
import { parseRegistryKey } from './collection-ids.js';
// Lorebook collection ID lookup uses registry scan (see _findLorebookRegistryEntry below);
// the builder is intentionally not imported here because lookups can't reconstruct the
// exact ID (backend + handle + timestamp segments are not known at lookup time).
import { setExtensionPrompt, getCurrentChatId } from '../../../../../script.js';
import { EXTENSION_PROMPT_TAG } from './constants.js';
import { buildSearchContext } from './conditional-activation.js';

// ============================================================================
// WORLD INFO ACTIVATION HOOKS
// ============================================================================

/**
 * Get vectorized lorebook entries that should be activated based on semantic similarity
 * This function is called by ST's world info system to get additional entries to activate
 *
 * @param {string[]} recentMessages - Recent chat messages to use as query
 * @param {object[]} activeEntries - Currently active WI entries (from keyword matching)
 * @param {object} settings - VectFox settings
 * @returns {Promise<object[]>} Array of WI entries to activate { uid, key, content, score }
 */
export async function getSemanticWorldInfoEntries(recentMessages, activeEntries, settings) {
    if (!settings.enabled_world_info) {
        return [];
    }

    // Build search query from recent messages
    const query = recentMessages.slice(-settings.world_info_query_depth || -3).join('\n');
    if (!query.trim()) {
        return [];
    }

    console.log(`VectFox: Querying vectorized lorebooks for semantic WI activation...`);

    const semanticEntries = [];
    // Lower threshold for hybrid retrieval since RRF/weighted fusion produces lower absolute scores
    const baseThreshold = settings.world_info_threshold || 0.3;
    const supportsNativeHybrid = settings.vector_backend === 'qdrant';
    const preferNative = settings.hybrid_native_prefer !== false;
    const hybridActive = (supportsNativeHybrid && preferNative) || settings.keyword_scoring_method === 'hybrid';
    const threshold = hybridActive ? baseThreshold * 0.8 : baseThreshold;
    const topK = settings.world_info_top_k || 3;

    // Build search context for activation filter evaluation
    const context = getContext();
    const searchContext = buildSearchContext(
        context.chat || [],
        settings.query || 10,
        recentMessages,
        {
            generationType: 'normal',
            isGroupChat: context.groupId != null,
            currentCharacter: context.name2 || null,
            activeLorebookEntries: activeEntries.map(e => e.key || e.uid),
            currentChatId: getCurrentChatId(),
            currentCharacterId: context.characterId || null
        }
    );

    // Get all enabled lorebook collections that pass activation filters
    const lorebookCollections = await getEnabledLorebookCollections(settings, searchContext);

    for (const collection of lorebookCollections) {
        try {
            // collection.id may be a registry key like 'backend:source:collectionId'
            // Parse it to extract the actual collectionId used by backends
            const parsed = parseRegistryKey(collection.id || collection.registryKey || '');
            const rawCollectionId = parsed.collectionId || collection.id;

            // Query this lorebook collection (use raw collection ID)
            const results = await queryCollection(rawCollectionId, query, topK, settings);

            if (results && results.metadata) {
                for (let i = 0; i < results.metadata.length; i++) {
                    const meta = results.metadata[i];
                    const score = meta.score || 0;

                    if (score >= threshold) {
                        // Extract WI entry data from metadata
                        const entry = {
                            uid: meta.uid || meta.hash,
                            key: meta.keywords || meta.entryName || [],
                            content: meta.text || '',
                            score: score,
                            lorebookName: collection.name,
                            collectionId: rawCollectionId,
                            registryKey: collection.id, // preserve registry key for metadata lookups
                            vectorActivated: true,
                            metadata: meta
                        };

                        semanticEntries.push(entry);
                        // Format key for display - handle arrays of strings or objects
                        const keyDisplay = Array.isArray(entry.key)
                            ? entry.key.map(k => typeof k === 'object' ? (k.text || k.keyword || JSON.stringify(k)) : k).join(', ')
                            : (entry.key || 'unknown');
                        console.log(`VectFox: Semantic WI activation: "${keyDisplay}" (score: ${score.toFixed(3)})`);
                    }
                }
            }
        } catch (error) {
            console.warn(`VectFox: Failed to query lorebook collection ${collection.id}:`, error);
        }
    }

    // Sort by score descending
    semanticEntries.sort((a, b) => b.score - a.score);

    // Deduplicate with already active entries (avoid duplicates from keyword matching)
    const deduplicatedEntries = deduplicateWithActiveEntries(semanticEntries, activeEntries);

    console.log(`VectFox: Found ${deduplicatedEntries.length} semantic WI entries to activate`);
    return deduplicatedEntries;
}

/**
 * Get all enabled lorebook collections that pass activation filters
 * @param {object} settings - VectFox settings
 * @param {object} searchContext - Search context for activation filter evaluation
 * @returns {Promise<Array<{id: string, name: string}>>}
 */
async function getEnabledLorebookCollections(settings, searchContext) {
    const collections = [];
    const collectionRegistry = settings.VectFox_collection_registry || [];

    for (const collectionId of collectionRegistry) {
        // Check if this is a lorebook collection
        if (!collectionId.includes('lorebook')) {
            continue;
        }

        // Check if collection is enabled
        if (!isCollectionEnabled(collectionId, settings)) {
            continue;
        }

        // Check if collection passes activation filters
        const passesActivation = await shouldCollectionActivate(collectionId, searchContext);
        if (!passesActivation) {
            console.log(`VectFox WI: Lorebook collection ${collectionId} did not pass activation filters, skipping`);
            continue;
        }

        // Get collection metadata
        const meta = getCollectionMeta(collectionId);
        const name = meta?.sourceName || collectionId;

        collections.push({ id: collectionId, name });
    }

    console.log(`VectFox WI: ${collections.length} lorebook collection(s) passed activation filters`);
    return collections;
}

/**
 * Deduplicate semantic entries with already active entries
 * @param {object[]} semanticEntries - Entries from vector search
 * @param {object[]} activeEntries - Already active entries from keyword matching
 * @returns {object[]} Deduplicated entries
 */
function deduplicateWithActiveEntries(semanticEntries, activeEntries) {
    const activeUids = new Set(activeEntries.map(e => e.uid));
    const activeContents = new Set(activeEntries.map(e => e.content?.trim().toLowerCase()));

    return semanticEntries.filter(entry => {
        // Skip if UID already active
        if (activeUids.has(entry.uid)) {
            return false;
        }

        // Skip if content already active (fuzzy match)
        const content = entry.content?.trim().toLowerCase();
        if (content && activeContents.has(content)) {
            return false;
        }

        return true;
    });
}

// ============================================================================
// LOREBOOK VECTORIZATION HELPERS
// ============================================================================

/**
 * Sanitize a lorebook name the same way the builder does, for registry-scan matching.
 */
function _sanitizeLorebookName(name) {
    return String(name || '')
        .normalize('NFC')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, '_')
        .substring(0, 50);
}

/**
 * Find the registry key for a lorebook by name. Scans the registry instead of trying to
 * rebuild the exact ID — collection IDs include backend + handle + timestamp segments,
 * none of which can be known ahead of time during a lookup. We match on the lorebook
 * prefix + sanitized name segment.
 *
 * @param {string} lorebookName
 * @param {object} settings
 * @returns {string|null} Full registry key (may include "backend:" prefix), or null if not found.
 */
function _findLorebookRegistryEntry(lorebookName, settings) {
    const sanitizedName = _sanitizeLorebookName(lorebookName);
    if (!sanitizedName) return null;
    const lorebookPrefix = 'vf_lorebook_';
    const nameNeedle = `_${sanitizedName}_`;

    const registry = settings.VectFox_collection_registry || [];
    for (const key of registry) {
        // Registry keys can be "backend:collectionId" or bare "collectionId".
        const id = String(key).includes(':') ? String(key).split(':').slice(1).join(':') : String(key);
        const idLower = id.toLowerCase();
        if (idLower.startsWith(lorebookPrefix) && idLower.includes(nameNeedle)) {
            return key;
        }
    }
    return null;
}

/**
 * Check if a lorebook is already vectorized
 * @param {string} lorebookName - Name of the lorebook
 * @param {object} settings - VectFox settings
 * @returns {boolean}
 */
export function isLorebookVectorized(lorebookName, settings) {
    return _findLorebookRegistryEntry(lorebookName, settings) !== null;
}

/**
 * Get vectorization status for all lorebooks
 * @param {string[]} lorebookNames - Array of lorebook names
 * @param {object} settings - VectFox settings
 * @returns {Map<string, boolean>} Map of lorebook name -> is vectorized
 */
export function getLorebooksVectorizationStatus(lorebookNames, settings) {
    const statusMap = new Map();

    for (const name of lorebookNames) {
        statusMap.set(name, isLorebookVectorized(name, settings));
    }

    return statusMap;
}

/**
 * Get statistics for vectorized lorebook
 * @param {string} lorebookName - Name of the lorebook
 * @param {object} settings - VectFox settings
 * @returns {Promise<object|null>} Stats object or null if not vectorized
 */
export async function getLorebookVectorStats(lorebookName, settings) {
    const registryKey = _findLorebookRegistryEntry(lorebookName, settings);
    if (!registryKey) return null;

    // Try metadata on the registry key first (preferred), fall back to bare id.
    const collectionId = String(registryKey).includes(':')
        ? String(registryKey).split(':').slice(1).join(':')
        : String(registryKey);
    const meta = getCollectionMeta(registryKey) || getCollectionMeta(collectionId);
    if (!meta) return null;

    return {
        collectionId,
        sourceName: meta.sourceName,
        chunkCount: meta.chunkCount || 0,
        createdAt: meta.createdAt,
        enabled: isCollectionEnabled(collectionId, settings),
        strategy: meta.settings?.strategy || 'per_entry',
        scope: meta.scope || 'global',
    };
}

// ============================================================================
// WORLD INFO UI INTEGRATION
// ============================================================================

/**
 * Add vector status indicators to world info entries in the UI
 * This function can be called to enhance the WI editor UI
 *
 * @param {string} lorebookName - Name of the current lorebook
 * @param {object[]} entries - World info entries
 * @param {object} settings - VectFox settings
 * @returns {object[]} Enhanced entries with vector status
 */
export function enhanceWorldInfoEntriesUI(lorebookName, entries, settings) {
    const isVectorized = isLorebookVectorized(lorebookName, settings);

    if (!isVectorized) {
        return entries;
    }

    // Add vector status to each entry
    return entries.map(entry => ({
        ...entry,
        vectorized: true,
        vectorStatus: {
            isVectorized: true,
            canUseSemanticActivation: true,
            lorebookVectorized: isVectorized
        }
    }));
}

// ============================================================================
// EXPORT FOR ST INTEGRATION
// ============================================================================

/**
 * Initialize world info integration hooks
 * This should be called when VectFox loads
 */
export function initializeWorldInfoIntegration() {
    // Make functions available globally for ST to call
    window.VectFox_WorldInfo = {
        getSemanticEntries: getSemanticWorldInfoEntries,
        isLorebookVectorized: isLorebookVectorized,
        getVectorizationStatus: getLorebooksVectorizationStatus,
        getVectorStats: getLorebookVectorStats,
        enhanceEntriesUI: enhanceWorldInfoEntriesUI
    };

    console.log('VectFox: World Info integration hooks initialized');
}

/**
 * Query semantic WI entries and inject them into the prompt extension tag.
 * Intended to be called on MESSAGE_SENT to ensure lorebook semantic hits
 * are available for the subsequent generation.
 * @param {object[]} chat Current chat messages
 * @param {object} settings VectFox settings
 */
export async function applySemanticEntriesToPrompt(chat, settings) {
    try {
        if (!settings || !settings.enabled_world_info) return;

        const recentMessages = chat
            .filter(m => !m.is_system)
            .reverse()
            .slice(0, settings.world_info_query_depth || settings.query || 3)
            .map(m => (m.mes || '').toString());

        const entries = await getSemanticWorldInfoEntries(recentMessages, [], settings);
        if (!entries || entries.length === 0) {
            return;
        }

        // Build simple injection text from entries (preserve order by score)
        const text = entries.map(e => e.content || (Array.isArray(e.key) ? e.key.join(' ') : e.key || '')).join('\n\n');

        // Respect global RAG wrappers if configured
        const fullText = (settings.rag_context ? settings.rag_context + '\n\n' : '') + text;

        // Inject into ST extension prompt tag so generation will include it
        setExtensionPrompt(EXTENSION_PROMPT_TAG, fullText, settings.position || 0, settings.depth || 2, false);
        console.log(`VectFox: Injected ${entries.length} semantic WI entries into prompt`);
    } catch (err) {
        console.warn('VectFox: Failed to apply semantic WI to prompt', err.message || err);
    }
}
