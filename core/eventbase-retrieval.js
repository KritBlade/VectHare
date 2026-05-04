/**
 * ============================================================================
 * EVENTBASE RETRIEVAL
 * ============================================================================
 * Retrieves and re-ranks EventRecord objects from Qdrant for prompt injection.
 *
 * Pipeline:
 *  1. Query EventBase collection with search text (vector similarity)
 *  2. Filter by minimum importance
 *  3. Re-rank using weighted formula: cosine + importance + persist + recency
 *  4. Suppress near-duplicate events (same type + high character overlap)
 *  5. Return top-K events with debug metadata
 * ============================================================================
 */

import { queryEvents } from './eventbase-store.js';
import { getChatUUID } from './collection-ids.js';

// ---------------------------------------------------------------------------
// Default re-rank weights (tuned for long-form SillyTavern RP)
// ---------------------------------------------------------------------------

const DEFAULT_WEIGHTS = {
    cosine: 0.55,
    importance: 0.20,
    persist: 0.15,
    recency: 0.10,
};

// ---------------------------------------------------------------------------
// Re-rank helpers
// ---------------------------------------------------------------------------

/**
 * Compute overlap ratio between two string arrays (Jaccard index).
 * @param {string[]} a
 * @param {string[]} b
 * @returns {number} 0..1
 */
function _characterOverlap(a, b) {
    if (!a?.length || !b?.length) return 0;
    const setA = new Set(a.map(s => s.toLowerCase()));
    const setB = new Set(b.map(s => s.toLowerCase()));
    let intersection = 0;
    for (const v of setA) {
        if (setB.has(v)) intersection++;
    }
    return intersection / (setA.size + setB.size - intersection);
}

/**
 * Recency bonus: exponential decay over the distance from the latest message.
 * Events whose source window ends near the current chat tail score higher.
 * @param {object} event
 * @param {number} chatLength
 * @returns {number} 0..1
 */
function _recencyBonus(event, chatLength) {
    if (!chatLength || chatLength === 0) return 0.5;
    const endIdx = event.source_window_end ?? 0;
    const age = chatLength - endIdx;
    // Half-life = 40 messages (configurable in future)
    return Math.pow(0.5, Math.max(0, age) / 40);
}

/**
 * Normalize 4 weights so they sum to 1.0.
 * @param {object} w
 * @returns {object}
 */
function _normalizeWeights(w) {
    const sum = w.cosine + w.importance + w.persist + w.recency;
    if (sum <= 0) return { ...DEFAULT_WEIGHTS };
    return {
        cosine: w.cosine / sum,
        importance: w.importance / sum,
        persist: w.persist / sum,
        recency: w.recency / sum,
    };
}

// ---------------------------------------------------------------------------
// Main retrieval function
// ---------------------------------------------------------------------------

/**
 * Query and re-rank EventBase records for injection.
 *
 * @param {object} params
 * @param {string} params.searchText  - Recent chat messages joined (from buildSearchQuery)
 * @param {number} params.chatLength  - Current total chat message count (for recency)
 * @param {object} params.settings    - VectHare settings
 * @param {string} [params.chatUUID]  - Override chat UUID
 * @returns {Promise<{ events: object[], debug: object }>}
 */
export async function retrieveEvents({ searchText, chatLength, settings, chatUUID }) {
    const debugLog = settings.eventbase_debug_logging;
    const uuid = chatUUID || getChatUUID();

    const topK = (settings.eventbase_retrieval_top_k || 8) * 2; // overfetch for re-rank
    const minImportance = settings.eventbase_retrieval_min_importance || 1;

    if (debugLog) {
        console.log(`[EventBase] Retrieval start — topK overfetch=${topK}, minImportance=${minImportance}`);
    }

    // 1. Vector query
    let rawCandidates;
    try {
        rawCandidates = await queryEvents(searchText, topK, settings, uuid);
    } catch (err) {
        console.error('[EventBase] Query failed:', err);
        return { events: [], debug: { error: err.message } };
    }

    if (debugLog) {
        console.log(`[EventBase] Query returned ${rawCandidates.length} raw candidates`);
    }

    // 2. Filter by minimum importance
    const importanceFiltered = rawCandidates.filter(m => {
        const imp = m.importance ?? m.metadata?.importance ?? 0;
        return imp >= minImportance;
    });

    if (debugLog) {
        console.log(`[EventBase] After importance filter (>=${minImportance}): ${importanceFiltered.length} candidates`);
    }

    // 3. Build weights from settings
    const rawWeights = {
        cosine: settings.eventbase_rerank_w_cosine ?? DEFAULT_WEIGHTS.cosine,
        importance: settings.eventbase_rerank_w_importance ?? DEFAULT_WEIGHTS.importance,
        persist: settings.eventbase_rerank_w_persist ?? DEFAULT_WEIGHTS.persist,
        recency: settings.eventbase_rerank_w_recency ?? DEFAULT_WEIGHTS.recency,
    };
    const weights = _normalizeWeights(rawWeights);

    // 4. Re-rank
    const scored = importanceFiltered.map(meta => {
        const cosineScore = typeof meta.score === 'number' ? meta.score : 0;
        const importanceNorm = (meta.importance ?? 5) / 10;
        const persistBonus = meta.should_persist === true ? 1 : 0;
        const recencyBonus = _recencyBonus(meta, chatLength);

        const finalScore =
            weights.cosine * cosineScore +
            weights.importance * importanceNorm +
            weights.persist * persistBonus +
            weights.recency * recencyBonus;

        return { ...meta, _finalScore: finalScore };
    });

    scored.sort((a, b) => b._finalScore - a._finalScore);

    // 5. Duplicate suppression (same event_type + character overlap >= 60%)
    const dedupedEvents = [];
    for (const candidate of scored) {
        let isDuplicate = false;
        for (const accepted of dedupedEvents) {
            if (
                accepted.event_type === candidate.event_type &&
                _characterOverlap(accepted.characters || [], candidate.characters || []) >= 0.6
            ) {
                isDuplicate = true;
                break;
            }
        }
        if (!isDuplicate) dedupedEvents.push(candidate);
    }

    // 6. Trim to requested top-K
    const finalTopK = settings.eventbase_retrieval_top_k || 8;
    const finalEvents = dedupedEvents.slice(0, finalTopK);

    if (debugLog) {
        console.log(`[EventBase] Final events after dedup + trim: ${finalEvents.length}`);
        finalEvents.forEach((e, i) => {
            console.log(`  [${i}] type=${e.event_type} imp=${e.importance} score=${e._finalScore?.toFixed(3)} persist=${e.should_persist}`);
        });
    }

    return {
        events: finalEvents,
        debug: {
            rawCount: rawCandidates.length,
            afterImportanceFilter: importanceFiltered.length,
            afterDedup: dedupedEvents.length,
            finalCount: finalEvents.length,
            weights,
        },
    };
}
