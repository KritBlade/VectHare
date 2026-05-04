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

import { setExtensionPrompt, extension_prompts } from '../../../../../script.js';
import { getChatUUID } from './collection-ids.js';
import { EXTENSION_PROMPT_TAG } from './constants.js';
import { EventBaseFatalError, EventBaseExtractionError } from './eventbase-schema.js';
import { extractEvents } from './eventbase-extractor.js';
import { insertEvents, isWindowAlreadyExtracted } from './eventbase-store.js';
import { retrieveEvents } from './eventbase-retrieval.js';
import { formatEventsForInjection } from './eventbase-injection.js';
import { progressTracker } from '../ui/progress-tracker.js';

/** Extension prompt tag suffix for EventBase (distinct from legacy chunks tag) */
const EVENTBASE_PROMPT_TAG = `${EXTENSION_PROMPT_TAG}:eventbase`;

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
 * @returns {Promise<{ eventsExtracted: number, windowsProcessed: number, windowsSkipped: number }>}
 */
export async function runEventBaseIngestion({ messages, chatUUID, settings, abortSignal = null }) {
    const debugLog = settings.eventbase_debug_logging;
    const uuid = chatUUID || getChatUUID();

    const windowSize = Math.max(2, settings.eventbase_window_size || 6);
    const windowOverlap = Math.max(0, Math.min(windowSize - 1, settings.eventbase_window_overlap ?? 1));
    const step = windowSize - windowOverlap;
    const minImportanceStore = settings.eventbase_min_importance_store || 1;

    // Bounded concurrency (process at most 3 windows in parallel)
    const CONCURRENCY = 3;

    if (!messages?.length) return { eventsExtracted: 0, windowsProcessed: 0, windowsSkipped: 0 };

    // Build list of windows
    const windows = [];
    for (let start = 0; start < messages.length; start += step) {
        const end = Math.min(start + windowSize - 1, messages.length - 1);
        windows.push({ start, end, msgs: messages.slice(start, end + 1) });
    }

    if (debugLog) {
        console.log(`[EventBase] Ingestion: ${messages.length} messages → ${windows.length} windows (size=${windowSize}, overlap=${windowOverlap})`);
    }

    progressTracker.show('EventBase Extraction', windows.length, 'Windows');

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
                console.warn('[EventBase] Batch window error:', err?.message || err);
            } else {
                if (result.value?.skipped) {
                    windowsSkipped++;
                } else {
                    windowsProcessed++;
                    eventsExtracted += result.value?.events?.length || 0;
                }
            }
        }

        progressTracker.updateProgress(windowIdx, `Extracted ${eventsExtracted} event(s)...`);
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

    if (debugLog) {
        console.log('[EventBase] Retrieval start, searchText length:', searchText?.length);
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
        return;
    }

    const injectionText = formatEventsForInjection(events, settings);
    if (!injectionText) {
        if (debugLog) console.log('[EventBase] Injection text empty after formatting');
        return;
    }

    // Clear any previous EventBase injection
    setExtensionPrompt(EVENTBASE_PROMPT_TAG, '', settings.position, settings.depth, false);

    // Inject using the same slot mechanism as legacy chunks
    setExtensionPrompt(EVENTBASE_PROMPT_TAG, injectionText, settings.position, settings.depth, false);

    if (debugLog) {
        console.log(`[EventBase] Injected ${events.length} event(s), text length: ${injectionText.length}`);
        console.log('[EventBase] Injection preview:', injectionText.slice(0, 300));
    }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

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
