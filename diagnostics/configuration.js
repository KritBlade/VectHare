/**
 * ============================================================================
 * VectFox DIAGNOSTICS - CONFIGURATION
 * ============================================================================
 * Settings validation and configuration checks
 *
 * @author Kritblade
 * @version 3.3.1
 * ============================================================================
 *
 * NOTE — DEAD-CHUNK-CHAT branches present in this file:
 * Several checks below call `getChatCollectionId()`, which is now disabled (returns
 * null). Chat history runs through the EventBase pipeline; there are no more
 * `VectFox_chat_*` collections to validate. The conditional branches that depend
 * on `chatCollectionId` are effectively skipped at runtime.
 *
 * These diagnostics need to be rewritten to inspect EventBase collections instead.
 * Until then, the no-op behavior is harmless — diagnostics that previously reported
 * "chat collection healthy" will silently skip.
 *
 * Search tag: DEAD-CHUNK-CHAT
 * ============================================================================
 */

import { getSavedHashes } from '../core/core-vector-api.js';
import { VALID_EMOTIONS, VALID_GENERATION_TYPES, validateConditionRule } from '../core/conditional-activation.js';
import { getTemporallyBlindCount, getTemporallyBlindChunks, isCollectionEnabled } from '../core/collection-metadata.js';
import { getCollectionRegistry } from '../core/collection-loader.js';

// DEAD-CHUNK-CHAT: chunk-based chat is removed; chat runs through the EventBase pipeline.
// Diagnostics that used to validate chunk-based chat collections now report "not applicable".
// EventBase (vf_eventbase_*) collections use their own validation rules.
const CHAT_NOT_APPLICABLE_MESSAGE = 'Not applicable (EventBase mode — chat is not stored as a chunk collection)';

/**
 * Check: RAG Query Status
 * Checks if there are ANY enabled collections (chat or otherwise)
 * that can be queried during generation.
 */
export function checkChatEnabled(settings) {
    const chatEnabled = settings.enabled_chats;
    // DEAD-CHUNK-CHAT: chat collection ID is always null; the "skip current chat" branch
    // below is preserved for legacy registries but is now a no-op.
    const chatCollectionId = null;

    // Count other enabled collections (not the current chat)
    const registry = getCollectionRegistry();
    let otherEnabledCount = 0;
    const otherEnabledNames = [];

    for (const registryKey of registry) {
        // Parse registry key to get collection ID
        let collectionId = registryKey;
        if (registryKey.includes(':')) {
            collectionId = registryKey.substring(registryKey.indexOf(':') + 1);
        }

        // Skip current chat collection (handled separately)
        if (collectionId === chatCollectionId) {
            continue;
        }

        if (isCollectionEnabled(registryKey)) {
            otherEnabledCount++;
            if (otherEnabledNames.length < 3) {
                otherEnabledNames.push(collectionId.substring(0, 20));
            }
        }
    }

    const hasAnyEnabled = chatEnabled || otherEnabledCount > 0;

    if (!hasAnyEnabled) {
        return {
            name: 'RAG Query Status',
            status: 'warning',
            message: 'No collections enabled for querying. Enable chat vectorization or enable other collections in the Database Browser.',
            fixable: true,
            fixAction: 'enable_chats'
        };
    }

    // Build status message
    const parts = [];
    if (chatEnabled) {
        parts.push('Chat: enabled');
    }
    if (otherEnabledCount > 0) {
        const names = otherEnabledNames.length < otherEnabledCount
            ? `${otherEnabledNames.join(', ')}... (+${otherEnabledCount - otherEnabledNames.length} more)`
            : otherEnabledNames.join(', ');
        parts.push(`Other collections: ${otherEnabledCount} enabled`);
    }

    return {
        name: 'RAG Query Status',
        status: 'pass',
        message: parts.join(' | ')
    };
}

/**
 * Check: Chunk size (for adaptive strategy)
 */
export function checkChunkSize(settings) {
    const size = settings.chunk_size || 500;

    if (size < 50) {
        return {
            name: 'Chunk Size',
            status: 'fail',
            message: `Chunk size too small (${size} chars). Minimum: 50`,
            fixable: true,
            fixAction: 'fix_chunk_size'
        };
    }

    if (size < 100) {
        return {
            name: 'Chunk Size',
            status: 'warning',
            message: `Chunk size is very small (${size} chars). Recommended: 200-800`
        };
    }

    if (size > 2000) {
        return {
            name: 'Chunk Size',
            status: 'warning',
            message: `Chunk size is very large (${size} chars). May cause context issues`
        };
    }

    return {
        name: 'Chunk Size',
        status: 'pass',
        message: `${size} characters`
    };
}

/**
 * Check: Score threshold validation
 */
export function checkScoreThreshold(settings) {
    const threshold = settings.score_threshold;

    if (threshold < 0 || threshold > 1) {
        return {
            name: 'Score Threshold',
            status: 'fail',
            message: `Invalid threshold (${threshold}). Must be 0.0-1.0`,
            fixable: true,
            fixAction: 'fix_threshold'
        };
    }

    if (threshold < 0.1) {
        return {
            name: 'Score Threshold',
            status: 'warning',
            message: `Very low threshold (${threshold}). May retrieve irrelevant results`
        };
    }

    if (threshold > 0.8) {
        return {
            name: 'Score Threshold',
            status: 'warning',
            message: `Very high threshold (${threshold}). May retrieve nothing`
        };
    }

    return {
        name: 'Score Threshold',
        status: 'pass',
        message: `${threshold}`
    };
}

/**
 * Check: Insert and query counts
 */
export function checkInsertQueryCounts(settings) {
    const insert = settings.insert;
    const query = settings.query;

    if (insert < 1 || query < 1) {
        return {
            name: 'Insert/Query Counts',
            status: 'fail',
            message: `Invalid counts (insert: ${insert}, query: ${query}). Must be >= 1`,
            fixable: true,
            fixAction: 'fix_counts'
        };
    }

    if (insert > 20 || query > 20) {
        return {
            name: 'Insert/Query Counts',
            status: 'warning',
            message: `High counts (insert: ${insert}, query: ${query}). May use too much context`
        };
    }

    return {
        name: 'Insert/Query Counts',
        status: 'pass',
        message: `Insert: ${insert}, Query: ${query}`
    };
}

/**
 * Check: Current chat has vectors
 */
export async function checkChatVectors(settings) {
    // DEAD-CHUNK-CHAT: chat is no longer stored as a chunk collection; EventBase
    // handles chat history. This check has nothing to validate.
    return {
        name: 'Chat Vectors',
        status: 'pass',
        message: CHAT_NOT_APPLICABLE_MESSAGE
    };
}

/**
 * Check: Temporal decay system status
 * Note: Temporal decay is now per-collection (chat collections enabled by default)
 */
export function checkTemporalDecaySettings(settings) {
    // Check for temporally blind chunks
    const blindCount = getTemporallyBlindCount();

    return {
        name: 'Temporal Decay',
        status: 'pass',
        message: `Per-collection decay active. ${blindCount} chunk(s) temporally blind.`
    };
}

/**
 * Check: Temporally blind chunks integrity
 */
export async function checkTemporallyBlindChunks(settings) {
    // DEAD-CHUNK-CHAT: the "in current chat" cross-check is gone with chunk-based chat.
    // Just report the global blind-chunk count instead.
    try {
        const blindChunks = getTemporallyBlindChunks();
        const blindCount = blindChunks.length;

        if (blindCount === 0) {
            return {
                name: 'Temporally Blind Chunks',
                status: 'pass',
                message: 'No chunks marked as temporally blind',
                category: 'configuration'
            };
        }

        return {
            name: 'Temporally Blind Chunks',
            status: 'pass',
            message: `${blindCount} total blind chunk(s)`,
            category: 'configuration'
        };
    } catch (error) {
        return {
            name: 'Temporally Blind Chunks',
            status: 'warning',
            message: `Could not verify: ${error.message}`,
            category: 'configuration'
        };
    }
}

/**
 * Check: Chunk visualizer API readiness
 * Verifies the visualizer can perform edit/delete operations
 */
export function checkVisualizerApiReadiness(settings) {
    const checks = [];

    // Check if settings are valid for API operations
    if (!settings) {
        return {
            name: 'Visualizer API',
            status: 'fail',
            message: 'No settings available for visualizer operations',
            category: 'configuration'
        };
    }

    // Check for required source configuration
    if (!settings.source) {
        return {
            name: 'Visualizer API',
            status: 'fail',
            message: 'No embedding source configured - cannot create/edit vectors',
            category: 'configuration'
        };
    }

    // Check backend configuration
    if (!settings.vector_backend) {
        return {
            name: 'Visualizer API',
            status: 'warning',
            message: 'No backend database specified (using default)',
            category: 'configuration'
        };
    }

    return {
        name: 'Visualizer API',
        status: 'pass',
        message: `Ready for vector operations (source: ${settings.source}, backend: ${settings.vector_backend || 'standard'})`,
        category: 'configuration'
    };
}

/**
 * Check: Collection ID format and UUID availability
 * DEAD-CHUNK-CHAT — see function body.
 */
export function checkCollectionIdFormat() {
    // DEAD-CHUNK-CHAT: chunk-based chat collections are no longer used.
    // EventBase collections use their own naming scheme and don't need
    // this validation.
    return {
        name: 'Collection ID Format',
        status: 'pass',
        message: CHAT_NOT_APPLICABLE_MESSAGE,
        category: 'configuration'
    };
}

/**
 * Check: Conditional activation module is available
 */
export function checkConditionalActivationModule() {
    try {
        if (!VALID_EMOTIONS || VALID_EMOTIONS.length === 0) {
            return {
                name: 'Conditional Activation',
                status: 'fail',
                message: 'VALID_EMOTIONS not loaded correctly',
                category: 'configuration'
            };
        }

        if (!VALID_GENERATION_TYPES || VALID_GENERATION_TYPES.length === 0) {
            return {
                name: 'Conditional Activation',
                status: 'fail',
                message: 'VALID_GENERATION_TYPES not loaded correctly',
                category: 'configuration'
            };
        }

        if (typeof validateConditionRule !== 'function') {
            return {
                name: 'Conditional Activation',
                status: 'fail',
                message: 'Validation functions not available',
                category: 'configuration'
            };
        }

        return {
            name: 'Conditional Activation',
            status: 'pass',
            message: `Module loaded (${VALID_EMOTIONS.length} emotions, ${VALID_GENERATION_TYPES.length} gen types)`,
            category: 'configuration'
        };
    } catch (error) {
        return {
            name: 'Conditional Activation',
            status: 'fail',
            message: `Module error: ${error.message}`,
            category: 'configuration'
        };
    }
}

/**
 * Check: Hash collision rate in current chat
 * This is INFORMATIONAL - collisions are intentional semantic deduplication.
 * High collision rate (>10%) may indicate repetitive conversations or chunking misconfiguration.
 */
export async function checkHashCollisionRate(settings) {
    // DEAD-CHUNK-CHAT: the per-chat collection used for this check no longer exists.
    // (Could be re-implemented to walk EventBase collections later; not worth it now.)
    return {
        name: 'Hash Collision Rate',
        status: 'pass',
        message: CHAT_NOT_APPLICABLE_MESSAGE,
        category: 'configuration'
    };
}

/**
 * Check: Chat Metadata Integrity
 * Verifies the chat has a valid UUID for vector collection identification.
 * Missing or malformed UUIDs can cause collection mismatches.
 */
export function checkChatMetadataIntegrity() {
    // DEAD-CHUNK-CHAT: this check validated the chat UUID used to build chunk-based
    // chat collection IDs. With chat handled by EventBase, the UUID is no longer
    // load-bearing for collection identification.
    return {
        name: 'Chat Metadata Integrity',
        status: 'pass',
        message: CHAT_NOT_APPLICABLE_MESSAGE,
        category: 'configuration'
    };
}

/**
 * Check: Condition Rule Validity
 * Verifies all chunk conditions in the current chat collection use valid operators and values.
 */
export async function checkConditionRuleValidity(settings) {
    // DEAD-CHUNK-CHAT: this used to scan the per-chat chunk collection for
    // condition rules. Condition rules now live on EventBase / Lorebook /
    // ArchiveEvent collections; a full validator would need to walk those
    // separately. Skipping for now rather than reporting a misleading status.
    return {
        name: 'Condition Rules',
        status: 'pass',
        message: CHAT_NOT_APPLICABLE_MESSAGE,
        category: 'configuration'
    };
}

/**
 * Check: Collection Registry Status
 * Verifies collections are discoverable and the registry is populated.
 * Empty registry with available backend = discovery issue.
 */
export async function checkCollectionRegistryStatus(settings) {
    const registry = getCollectionRegistry();
    const registryCount = registry.length;

    if (registryCount === 0) {
        // Try to determine if there SHOULD be collections by checking the backend
        // If the user has the plugin, we can check for actual collections
        const hasPlugin = settings.vector_backend === 'qdrant';

        if (hasPlugin) {
            return {
                name: 'Collection Registry',
                status: 'warning',
                message: 'Registry empty. Collections will auto-discover on first message. Open Database Browser to populate now.',
                category: 'configuration'
            };
        }

        return {
            name: 'Collection Registry',
            status: 'pass',
            message: 'Registry empty (no collections vectorized yet)',
            category: 'configuration'
        };
    }

    // Count enabled collections
    const enabledCount = registry.filter(key => isCollectionEnabled(key)).length;

    return {
        name: 'Collection Registry',
        status: 'pass',
        message: `${registryCount} collection(s) registered, ${enabledCount} enabled for querying`,
        category: 'configuration'
    };
}

/**
 * Check: Chunk Groups Module
 * Verifies the chunk groups system is loaded and functional.
 */
export async function checkChunkGroupsModule() {
    try {
        // Dynamically import to check if module is available
        const { validateGroup, createGroup, getGroupStats } = await import('../core/chunk-groups.js');

        if (typeof validateGroup !== 'function') {
            return {
                name: 'Chunk Groups Module',
                status: 'fail',
                message: 'validateGroup function not available',
                category: 'configuration'
            };
        }

        if (typeof createGroup !== 'function') {
            return {
                name: 'Chunk Groups Module',
                status: 'fail',
                message: 'createGroup function not available',
                category: 'configuration'
            };
        }

        // Test that createGroup works
        const testGroup = createGroup('Test', 'inclusive');
        if (!testGroup || !testGroup.id || testGroup.mode !== 'inclusive') {
            return {
                name: 'Chunk Groups Module',
                status: 'fail',
                message: 'createGroup returned invalid result',
                category: 'configuration'
            };
        }

        return {
            name: 'Chunk Groups Module',
            status: 'pass',
            message: 'Module loaded and functional',
            category: 'configuration'
        };
    } catch (error) {
        return {
            name: 'Chunk Groups Module',
            status: 'fail',
            message: `Module error: ${error.message}`,
            category: 'configuration'
        };
    }
}

/**
 * Check: Chunk Groups Validity
 * Verifies all chunk groups across collections have valid structure.
 */
export async function checkChunkGroupsValidity(settings) {
    try {
        const { validateGroup, getGroupStats } = await import('../core/chunk-groups.js');
        const { getCollectionMeta } = await import('../core/collection-metadata.js');
        const registry = getCollectionRegistry();

        if (registry.length === 0) {
            return {
                name: 'Chunk Groups Validity',
                status: 'pass',
                message: 'No collections to check',
                category: 'configuration'
            };
        }

        let totalGroups = 0;
        let invalidGroups = 0;
        const invalidDetails = [];

        for (const registryKey of registry) {
            let collectionId = registryKey;
            if (registryKey.includes(':')) {
                collectionId = registryKey.substring(registryKey.indexOf(':') + 1);
            }

            const meta = getCollectionMeta(collectionId);
            const groups = meta?.groups || [];

            for (const group of groups) {
                totalGroups++;
                const validation = validateGroup(group);
                if (!validation.valid) {
                    invalidGroups++;
                    invalidDetails.push({
                        collectionId: collectionId.substring(0, 20),
                        groupName: group.name || 'unnamed',
                        errors: validation.errors
                    });
                }
            }
        }

        if (totalGroups === 0) {
            return {
                name: 'Chunk Groups Validity',
                status: 'pass',
                message: 'No groups configured',
                category: 'configuration'
            };
        }

        if (invalidGroups > 0) {
            return {
                name: 'Chunk Groups Validity',
                status: 'warning',
                message: `${invalidGroups}/${totalGroups} groups have invalid configuration`,
                category: 'configuration',
                data: { invalidDetails }
            };
        }

        return {
            name: 'Chunk Groups Validity',
            status: 'pass',
            message: `${totalGroups} group(s) configured, all valid`,
            category: 'configuration'
        };
    } catch (error) {
        return {
            name: 'Chunk Groups Validity',
            status: 'warning',
            message: `Could not validate: ${error.message}`,
            category: 'configuration'
        };
    }
}

/**
 * Check: Chunk Group Member Integrity
 * Verifies group members reference chunks that exist in the collection.
 */
export async function checkChunkGroupMemberIntegrity(settings) {
    try {
        const { getCollectionMeta } = await import('../core/collection-metadata.js');
        const registry = getCollectionRegistry();

        if (registry.length === 0) {
            return {
                name: 'Group Member Integrity',
                status: 'pass',
                message: 'No collections to check',
                category: 'configuration'
            };
        }

        let totalMembers = 0;
        let orphanedMembers = 0;
        const orphanedDetails = [];

        for (const registryKey of registry) {
            let collectionId = registryKey;
            if (registryKey.includes(':')) {
                collectionId = registryKey.substring(registryKey.indexOf(':') + 1);
            }

            const meta = getCollectionMeta(collectionId);
            const groups = meta?.groups || [];

            if (groups.length === 0) continue;

            // Get actual chunk hashes in this collection
            let existingHashes;
            try {
                existingHashes = new Set((await getSavedHashes(collectionId, settings)).map(h => String(h)));
            } catch {
                // Collection may not exist on backend yet
                continue;
            }

            for (const group of groups) {
                for (const memberHash of (group.members || [])) {
                    totalMembers++;
                    if (!existingHashes.has(String(memberHash))) {
                        orphanedMembers++;
                        if (orphanedDetails.length < 5) {
                            orphanedDetails.push({
                                groupName: group.name,
                                hash: String(memberHash).substring(0, 8)
                            });
                        }
                    }
                }
            }
        }

        if (totalMembers === 0) {
            return {
                name: 'Group Member Integrity',
                status: 'pass',
                message: 'No group members to check',
                category: 'configuration'
            };
        }

        if (orphanedMembers > 0) {
            return {
                name: 'Group Member Integrity',
                status: 'warning',
                message: `${orphanedMembers}/${totalMembers} group member(s) reference missing chunks`,
                category: 'configuration',
                fixable: true,
                fixAction: 'cleanOrphanedGroupMembers',
                data: { orphanedDetails, orphanedCount: orphanedMembers }
            };
        }

        return {
            name: 'Group Member Integrity',
            status: 'pass',
            message: `${totalMembers} group member(s), all reference valid chunks`,
            category: 'configuration'
        };
    } catch (error) {
        return {
            name: 'Group Member Integrity',
            status: 'warning',
            message: `Could not verify: ${error.message}`,
            category: 'configuration'
        };
    }
}

/**
 * Check: Prompt Context Configuration
 * Summarizes prompt context settings (global, collection, chunk levels).
 */
export async function checkPromptContextConfig(settings) {
    try {
        const { getCollectionMeta } = await import('../core/collection-metadata.js');
        const registry = getCollectionRegistry();

        // Check global settings
        const hasGlobalContext = !!(settings.rag_context && settings.rag_context.trim());
        const hasGlobalXmlTag = !!(settings.rag_xml_tag && settings.rag_xml_tag.trim());

        // Count collections with context
        let collectionsWithContext = 0;
        let collectionsWithXmlTag = 0;

        for (const registryKey of registry) {
            let collectionId = registryKey;
            if (registryKey.includes(':')) {
                collectionId = registryKey.substring(registryKey.indexOf(':') + 1);
            }

            const meta = getCollectionMeta(collectionId);
            if (meta?.context && meta.context.trim()) collectionsWithContext++;
            if (meta?.xmlTag && meta.xmlTag.trim()) collectionsWithXmlTag++;
        }

        // Build status message
        const parts = [];
        if (hasGlobalContext || hasGlobalXmlTag) {
            parts.push(`Global: ${hasGlobalContext ? 'context' : ''}${hasGlobalContext && hasGlobalXmlTag ? '+' : ''}${hasGlobalXmlTag ? 'xml' : ''}`);
        }
        if (collectionsWithContext > 0 || collectionsWithXmlTag > 0) {
            parts.push(`${collectionsWithContext} collection(s) with context`);
        }

        if (parts.length === 0) {
            return {
                name: 'Prompt Context',
                status: 'pass',
                message: 'No prompt context configured (chunks inject as plain text)',
                category: 'configuration'
            };
        }

        return {
            name: 'Prompt Context',
            status: 'pass',
            message: parts.join(' | '),
            category: 'configuration'
        };
    } catch (error) {
        return {
            name: 'Prompt Context',
            status: 'warning',
            message: `Could not check: ${error.message}`,
            category: 'configuration'
        };
    }
}

/**
 * Check: PNG Export Capability
 * Verifies the browser supports CompressionStream for PNG exports.
 */
export function checkPNGExportCapability() {
    const hasCompressionStream = typeof CompressionStream !== 'undefined';
    const hasDecompressionStream = typeof DecompressionStream !== 'undefined';
    const hasCanvas = typeof HTMLCanvasElement !== 'undefined';

    const allSupported = hasCompressionStream && hasDecompressionStream && hasCanvas;

    if (!allSupported) {
        const missing = [];
        if (!hasCompressionStream) missing.push('CompressionStream');
        if (!hasDecompressionStream) missing.push('DecompressionStream');
        if (!hasCanvas) missing.push('Canvas');

        return {
            name: 'PNG Export Capability',
            status: 'warning',
            message: `Missing browser APIs: ${missing.join(', ')}. PNG export may not work.`,
            category: 'configuration'
        };
    }

    // Test if deflate-raw is supported
    let deflateRawSupported = false;
    try {
        new CompressionStream('deflate-raw');
        deflateRawSupported = true;
    } catch {
        // deflate-raw not supported, will use fallback
    }

    return {
        name: 'PNG Export Capability',
        status: 'pass',
        message: deflateRawSupported
            ? 'Full PNG export support (native deflate-raw)'
            : 'PNG export supported (using deflate fallback)',
        category: 'configuration'
    };
}
