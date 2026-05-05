/**
 * ============================================================================
 * EVENTBASE WORKFLOW
 * ============================================================================
 * Top-level orchestrators for EventBase ingestion and retrieval.
 * These replace the Phase-1 throwing stubs.
 *
 * Exported:
 *   runEventBaseIngestion({ messages, chatUUID, settings, abortSignal })
 *   runEventBaseRetrieval({ chat, searchText, settings })
 * ============================================================================
 */

import { setExtensionPrompt, extension_prompts, getCurrentChatId } from '../../../../../script.js';
import { extension_settings } from '../../../../extensions.js';
import { getChatUUID } from './collection-ids.js';
import { EXTENSION_PROMPT_TAG } from './constants.js';
import { EventBaseFatalError, EventBaseExtractionError } from './eventbase-schema.js';
import { extractEvents } from './eventbase-extractor.js';
import { insertEvents, isWindowAlreadyExtracted, markWindowExtracted, buildEventBaseCollectionId } from './eventbase-store.js';
import { retrieveEvents } from './eventbase-retrieval.js';
import { formatEventsForInjectionDetailed } from './eventbase-injection.js';
import { isCollectionEnabled, isCollectionLockedToChat } from './collection-metadata.js';
import { progressTracker } from '../ui/progress-tracker.js';

/** Extension prompt tag for EventBase (distinct from legacy chunks tag) */
const EVENTBASE_PROMPT_TAG = `${EXTENSION_PROMPT_TAG}_eventbase`;

// ---------------------------------------------------------------------------
// Ingestion
// ---------------------------------------------------------------------------

/**
 * Run the EventBase ingestion pipeline over a slice of chat messages.
 *
 * Sliding window approach:
 *   - Window size:    settings.eventbase_window_size   (default 6)
 *   - Overlap:        settings.eventbase_window_overlap (default 1)
 * Each window is sent to the LLM for structured event extraction.
 * Already-extracted windows are skipped (dedup by source hashes).
 *
 * @param {object} params
 * @param {object[]} params.messages    - Chat messages to process (array of ST message objects)
 * @param {string}  [params.chatUUID]   - Override chat UUID
 * @param {object}   params.settings    - VectHare settings
 * @param {AbortSignal|null} [params.abortSignal]
 * @param {{ strategy?: string, batchSize?: number, totalChunks?: number }|null} [params.progressPlan]
 * @returns {Promise<{ eventsExtracted: number, windowsProcessed: number, windowsSkipped: number }>}
 */
export async function runEventBaseIngestion({ messages, chatUUID, settings, abortSignal = null, progressPlan = null }) {
    const debugLog = settings.eventbase_debug_logging;
    const debugVectorizing = settings.debug_vectorizing_log === true;
    const uuid = chatUUID || getChatUUID();

    const windowSize = Math.max(2, settings.eventbase_window_size || 6);
    const windowOverlap = Math.max(0, Math.min(windowSize - 1, settings.eventbase_window_overlap ?? 1));
    const step = windowSize - windowOverlap;
    const minImportanceStore = settings.eventbase_min_importance_store || 1;

    // Bounded concurrency (process at most 3 windows in parallel)
    const CONCURRENCY = 3;

    if (!messages?.length) return { eventsExtracted: 0, windowsProcessed: 0, windowsSkipped: 0 };

    // Build list of windows — skip tail windows that haven't accumulated a full
    // windowSize of messages yet. This prevents the same partial tail from being
    // re-extracted (and potentially duplicating events) on every auto-sync fire.
    // A tail window becomes eligible once it reaches windowSize messages, at which
    // point the next step boundary also produces a fresh overlap window correctly.
    const windows = [];
    for (let start = 0; start < messages.length; start += step) {
        const end = Math.min(start + windowSize - 1, messages.length - 1);
        const msgs = messages.slice(start, end + 1);
        if (msgs.length < windowSize) break; // tail is incomplete — wait for more messages
        windows.push({ start, end, msgs });
    }

    if (debugLog) {
        console.log(`[EventBase] Ingestion: ${messages.length} messages → ${windows.length} windows (size=${windowSize}, overlap=${windowOverlap})`);
    }

    progressTracker.show('EventBase Extraction', windows.length, 'Windows');

    const totalLegacyChunks = Number(progressPlan?.totalChunks) || 0;
    const legacyStrategy = progressPlan?.strategy || 'per_message';
    const legacyBatchSize = Math.max(1, Number(progressPlan?.batchSize) || 1);
    if (totalLegacyChunks > 0) {
        // Keep the CHUNKS card on legacy math (total + remaining), like standard vectorization.
        progressTracker.updateEmbeddingProgress(0, totalLegacyChunks);
    }

    let eventsExtracted = 0;
    let windowsProcessed = 0;
    let windowsSkipped = 0;
    let windowIdx = 0;

    while (windowIdx < windows.length) {
        if (abortSignal?.aborted) {
            progressTracker.complete(false, 'Stopped by user');
            return { eventsExtracted, windowsProcessed, windowsSkipped };
        }

        const batch = windows.slice(windowIdx, windowIdx + CONCURRENCY);
        windowIdx += batch.length;

        // Process batch in parallel
        const batchResults = await Promise.allSettled(
            batch.map(async (win, batchOffset) => {
                const wIdx = windowIdx - batch.length + batchOffset;

                if (abortSignal?.aborted) return { skipped: true };

                // Compute source hashes for dedup check
                const sourceHashes = win.msgs.map(m => {
                    const text = (m.mes || '').trim();
                    return m.hash ?? _djb2(`${m.name || ''}:${text}`);
                });

                // Skip if already extracted
                const alreadyDone = await isWindowAlreadyExtracted(
                    sourceHashes,
                    win.msgs.map((_, i) => win.start + i),
                    settings,
                    uuid,
                );
                if (alreadyDone) {
                    if (debugLog) console.log(`[EventBase] Window ${wIdx} already extracted — skip`);
                    return { skipped: true };
                }

                // LLM extraction
                let rawEvents;
                try {
                    rawEvents = await extractEvents({
                        messages: win.msgs,
                        windowStart: win.start,
                        windowEnd: win.end,
                        settings,
                        windowIndex: wIdx,
                    });
                } catch (err) {
                    // User/request cancellation is expected and should not be logged as a failure.
                    if (err?.name === 'AbortError' || abortSignal?.aborted) {
                        if (debugLog) {
                            console.log(`[EventBase] Window ${wIdx}: request aborted`);
                        }
                        return { skipped: true };
                    }
                    if (err instanceof EventBaseFatalError) throw err; // propagate
                    if (err instanceof EventBaseExtractionError) {
                        console.warn(`[EventBase] Window ${wIdx}: extraction error (skipped) — ${err.message}`);
                        return { skipped: false, events: [] };
                    }
                    console.warn(`[EventBase] Window ${wIdx}: unexpected error (skipped) — ${err.message}`);
                    return { skipped: false, events: [] };
                }

                // Attach chat_uuid to each event
                const annotated = rawEvents.map(e => ({ ...e, chat_uuid: uuid }));

                // Filter by minimum importance
                const toStore = annotated.filter(e => e.importance >= minImportanceStore);
                if (debugLog && toStore.length < annotated.length) {
                    console.log(`[EventBase] Window ${wIdx}: dropped ${annotated.length - toStore.length} event(s) below minImportance=${minImportanceStore}`);
                }

                // Insert
                if (toStore.length > 0) {
                    await insertEvents(toStore, settings, abortSignal);
                }

                // Mark window as done in the extension_settings fingerprint cache
                // so future runs (including after page reload) skip it instantly.
                markWindowExtracted(sourceHashes, uuid);

                return { skipped: false, events: toStore };
            }),
        );

        // Tally results, watch for fatal errors
        for (const result of batchResults) {
            if (result.status === 'rejected') {
                const err = result.reason;
                if (err instanceof EventBaseFatalError) {
                    progressTracker.complete(false, `EventBase fatal error: ${err.message}`);
                    throw err; // bubble up to caller
                }
                if (debugVectorizing || debugLog) {
                    console.warn('[EventBase] Batch window error:', err?.message || err);
                }
            } else {
                if (result.value?.skipped) {
                    windowsSkipped++;
                } else {
                    windowsProcessed++;
                    const extractedThisBatch = result.value?.events?.length || 0;
                    eventsExtracted += extractedThisBatch;
                    
                    // Update display with running event count (shown in "Chunks" stat)
                    progressTracker.updateChunks(eventsExtracted);
                }
            }
        }

        // Update progress with current window number and running event count
        if (totalLegacyChunks > 0) {
            const coveredMessages = Math.min(messages.length, (windowIdx * step) + windowOverlap);
            const processedLegacyChunks = _estimateProcessedLegacyChunks({
                coveredMessages,
                totalMessages: messages.length,
                totalChunks: totalLegacyChunks,
                strategy: legacyStrategy,
                batchSize: legacyBatchSize,
            });
            progressTracker.updateEmbeddingProgress(processedLegacyChunks, totalLegacyChunks);
        }

        progressTracker.updateProgress(
            windowIdx,
            `${eventsExtracted} event(s) found, processing windows...`
        );
    }

    progressTracker.complete(true, `EventBase: extracted ${eventsExtracted} event(s) from ${windowsProcessed} window(s)`);

    if (debugLog) {
        console.log(`[EventBase] Ingestion complete: extracted=${eventsExtracted}, processed=${windowsProcessed}, skipped=${windowsSkipped}`);
    }

    return { eventsExtracted, windowsProcessed, windowsSkipped };
}

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

/**
 * Run the EventBase retrieval pipeline and inject the result into the prompt.
 *
 * @param {object} params
 * @param {object[]} params.chat       - Full ST chat array
 * @param {string}   params.searchText - Query text (from buildSearchQuery)
 * @param {object}   params.settings   - VectHare settings
 * @param {string}  [params.chatUUID]  - Override chat UUID
 * @returns {Promise<void>}
 */
export async function runEventBaseRetrieval({ chat, searchText, settings, chatUUID }) {
    const debugLog = settings.eventbase_debug_logging;
    const uuid = chatUUID || getChatUUID();

    // Respect the "Active for current chat" toggle in Collection Settings.
    const collectionId = buildEventBaseCollectionId(uuid, settings?.vector_backend);

    // 1. Global enabled flag (collection card pause/resume toggle).
    //    Stored under registry key (backend:source:id) so check all key variants.
    const backend = settings?.vector_backend || 'standard';
    const source = settings?.source || 'transformers';
    const candidateKeys = [
        collectionId,
        `${source}:${collectionId}`,
        `${backend}:${source}:${collectionId}`,
    ];
    const disabledKey = candidateKeys.find(key => key && !isCollectionEnabled(key));
    if (disabledKey) {
        if (debugLog) {
            console.log(`[EventBase] Collection paused (key="${disabledKey}") — skipping retrieval`);
        }
        setExtensionPrompt(EVENTBASE_PROMPT_TAG, '', settings.position, settings.depth, false);
        return;
    }

    // 2. "Active for current chat" checkbox in Collection Settings.
    //    The checkbox writes to lockedToChatIds in the plain-ID metadata entry.
    //    If the user has ever saved that panel, lockedToChatIds will exist in the
    //    stored object (even when empty).  Only gate when it was explicitly set.
    const currentChatId = getCurrentChatId();
    const storedMeta = extension_settings?.vecthareplus?.collections?.[collectionId];
    if (storedMeta && Object.prototype.hasOwnProperty.call(storedMeta, 'lockedToChatIds')) {
        if (!isCollectionLockedToChat(collectionId, currentChatId)) {
            if (debugLog) {
                console.log(
                    `[EventBase] Not locked to current chat (${currentChatId}), ` +
                    `lockedChats=${JSON.stringify(storedMeta.lockedToChatIds)} — skipping retrieval`
                );
            }
            setExtensionPrompt(EVENTBASE_PROMPT_TAG, '', settings.position, settings.depth, false);
            return;
        }
    }

    if (debugLog) {
        console.log('[EventBase] Retrieval start, searchText length:', searchText?.length);
    }

    if (settings.retrieval_popup_on_start) {
        toastr.info('Retrieving context from EventBase...', 'VectHarePlus Retrieval');
    }

    const { events, debug } = await retrieveEvents({
        searchText,
        chatLength: chat?.length || 0,
        settings,
        chatUUID: uuid,
    });

    if (debugLog) {
        console.log('[EventBase] Retrieval debug:', debug);
    }

    if (!events?.length) {
        if (debugLog) console.log('[EventBase] No events to inject');
        if (settings.retrieval_popup_on_result) {
            toastr.info('EventBase: no events matched', 'VectHarePlus Retrieval');
        }
        return;
    }

    const injectionResult = formatEventsForInjectionDetailed(events, settings);
    let injectionText = injectionResult.text;
    const injectedCount = injectionResult.includedCount;
    if (!injectionText) {
        if (debugLog) console.log('[EventBase] Injection text empty after formatting');
        return;
    }

    // Wrap with XML tag if configured (same as legacy path)
    const xmlTag = settings.rag_xml_tag || '';
    if (xmlTag) {
        injectionText = `<${xmlTag}>\n${injectionText}\n</${xmlTag}>`;
    }

    // Clear any previous EventBase injection
    setExtensionPrompt(EVENTBASE_PROMPT_TAG, '', settings.position, settings.depth, false);

    // Inject using the same slot mechanism as legacy chunks
    setExtensionPrompt(EVENTBASE_PROMPT_TAG, injectionText, settings.position, settings.depth, false);

    if (debugLog) {
        console.log(`[EventBase] Injected ${injectedCount} event(s) (requested ${events.length}), text length: ${injectionText.length}`);
        console.log(`[EventBase] setExtensionPrompt tag="${EVENTBASE_PROMPT_TAG}" position=${settings.position} depth=${settings.depth}`);
        // Verify the slot is actually populated
        const slotContent = extension_prompts[EVENTBASE_PROMPT_TAG];
        console.log(`[EventBase] Slot verification — key exists: ${EVENTBASE_PROMPT_TAG in extension_prompts}, value type: ${typeof slotContent?.value}, length: ${slotContent?.value?.length ?? slotContent?.length ?? '?'}`);
        console.log('[EventBase] extension_prompts keys:', Object.keys(extension_prompts));
        console.log('[EventBase] Injection preview:', injectionText.slice(0, 300));
    }

    if (settings.retrieval_popup_on_result) {
        toastr.success(`EventBase: injected ${injectedCount} event(s)`, 'VectHarePlus Retrieval');
    }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Estimate how many legacy chunks are effectively processed based on covered messages.
 * This keeps EventBase progress aligned with the Vectorize Content chunk semantics.
 *
 * @param {object} params
 * @param {number} params.coveredMessages
 * @param {number} params.totalMessages
 * @param {number} params.totalChunks
 * @param {string} params.strategy
 * @param {number} params.batchSize
 * @returns {number}
 */
function _estimateProcessedLegacyChunks({ coveredMessages, totalMessages, totalChunks, strategy, batchSize }) {
    if (totalChunks <= 0 || totalMessages <= 0) return 0;

    const covered = Math.max(0, Math.min(totalMessages, coveredMessages));
    let processed = 0;

    switch (strategy) {
        case 'per_message':
            processed = covered;
            break;
        case 'conversation_turns':
            processed = Math.ceil(covered / 2);
            break;
        case 'message_batch':
        case 'message_group_batch':
            processed = Math.ceil(covered / Math.max(1, batchSize));
            break;
        default: {
            // Fallback to proportional estimate for size-based strategies.
            const ratio = covered / totalMessages;
            processed = Math.round(totalChunks * ratio);
            break;
        }
    }

    return Math.max(0, Math.min(totalChunks, processed));
}

/**
 * Minimal djb2 hash (matches eventbase-extractor.js — kept local to avoid circular dep).
 * @param {string} str
 * @returns {number}
 */
function _djb2(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) {
        h = ((h << 5) + h) ^ str.charCodeAt(i);
        h >>>= 0;
    }
    return h;
}
