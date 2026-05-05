/**
 * ============================================================================
 * EVENTBASE RETRIEVAL
 * ============================================================================
 * Retrieves and re-ranks EventRecord objects from Qdrant for prompt injection.
 *
 * Pipeline:
 *  1. Dual vector query — user's last message + full context (Promise.all); merge by max score
 *  2. Filter by minimum importance
 *  3. Re-rank using weighted formula: cosine + importance + persist + recency
 *  4. Suppress near-duplicate events (same type + high character overlap)
 *  5. Return top-K events with debug metadata
 * ============================================================================
 */

import { queryEvents } from './eventbase-store.js';
import { getChatUUID } from './collection-ids.js';
import { extractChatKeywords, applyKeywordBoost } from './keyword-boost.js';

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
 * @param {string} params.searchText    - Recent chat messages joined (from buildSearchQuery)
 * @param {string} [params.keywordQuery] - User's last message; used for keyword extraction and
 *                                         a second parallel vector query (dual-query mode).
 *                                         Falls back to searchText when absent or identical.
 * @param {number} params.chatLength    - Current total chat message count (for recency)
 * @param {object} params.settings      - VectHare settings
 * @param {string} [params.chatUUID]    - Override chat UUID
 * @returns {Promise<{ events: object[], debug: object }>}
 */
export async function retrieveEvents({ searchText, keywordQuery, chatLength, settings, chatUUID }) {
    const debugLog = settings.eventbase_debug_logging;
    const uuid = chatUUID || getChatUUID();

    const topK = (settings.eventbase_retrieval_top_k || 8) * 2; // overfetch for re-rank
    const minImportance = settings.eventbase_retrieval_min_importance || 1;

    // keywordQuery: focused text for keyword extraction (user's last message).
    // Falls back to full searchText if not provided.
    const effectiveKeywordQuery = keywordQuery || searchText;

    if (debugLog) {
        console.log(`[EventBase] Retrieval start — topK overfetch=${topK}, minImportance=${minImportance}`);
    }

    // 1. Dual vector query — fire both in parallel (each is an independent HTTP fetch).
    //    userQuery  → user's last message: high-precision, intent-focused
    //    searchText → full multi-message context: broad narrative coverage
    //    When both strings are identical (no user message extracted) fall back to a
    //    single query to avoid paying double cost for the same embedding.
    let rawCandidates;
    const dualQuery = keywordQuery && keywordQuery !== searchText;

    if (dualQuery) {
        const [userResults, contextResults] = await Promise.all([
            queryEvents(keywordQuery, topK, settings, uuid).catch(err => {
                console.error('[EventBase] User-query failed:', err);
                return [];
            }),
            queryEvents(searchText, topK, settings, uuid).catch(err => {
                console.error('[EventBase] Context-query failed:', err);
                return [];
            }),
        ]);

        // Merge by event_id — keep the copy with the higher cosine score so the
        // re-ranker receives the best available similarity signal for each event.
        const mergedMap = new Map();
        for (const event of [...userResults, ...contextResults]) {
            const key = event.event_id ?? event.hash ?? JSON.stringify(event);
            const existing = mergedMap.get(key);
            if (!existing || event.score > existing.score) {
                mergedMap.set(key, event);
            }
        }
        rawCandidates = [...mergedMap.values()];

        if (debugLog) {
            console.log(`[EventBase] Dual-query: user=${userResults.length} + context=${contextResults.length} → merged=${rawCandidates.length} unique events`);
        }
    } else {
        try {
            rawCandidates = await queryEvents(searchText, topK, settings, uuid);
        } catch (err) {
            console.error('[EventBase] Query failed:', err);
            return { events: [], debug: { error: err.message } };
        }

        if (debugLog) {
            console.log(`[EventBase] Query returned ${rawCandidates.length} raw candidates`);
        }
    }

    // 2. Keyword boost — honour the same Core-tab settings as the legacy pipeline.
    //    Keywords are extracted from effectiveKeywordQuery (the user's last message when
    //    provided) rather than the full searchText, so the user's intent dominates over
    //    the much longer AI response that typically follows it in the query blob.
    //    The vector search above still uses the full searchText for richer semantic context.
    const extractionLevel = settings.keyword_extraction_level || 'balanced';
    const baseWeight = settings.keyword_boost_base_weight || 1.5;
    const queryKeywords = extractChatKeywords(effectiveKeywordQuery, { level: extractionLevel, baseWeight });
    let boostedCandidates = rawCandidates;
    if (queryKeywords.length > 0) {
        boostedCandidates = applyKeywordBoost(rawCandidates, effectiveKeywordQuery, { diminishingReturns: true, perKeywordCap: true });
        if (debugLog) {
            const boostedCount = boostedCandidates.filter(c => c.keywordBoosted).length;
            console.log(`[EventBase] Keyword boost: ${queryKeywords.length} keyword(s) from "${effectiveKeywordQuery.slice(0, 60)}...", ${boostedCount}/${boostedCandidates.length} events boosted`);
        }
    }

    // 3. Filter by minimum importance
    const importanceFiltered = boostedCandidates.filter(m => {
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

    // 6. Dedup depth — skip events whose source window is already visible in recent context.
    // If source_window_end falls within the last deduplication_depth messages, the LLM can
    // already see that content directly; injecting the event adds redundant information.
    const dedupDepth = settings.deduplication_depth ?? 50;
    const visibleThreshold = dedupDepth > 0 ? chatLength - dedupDepth : -1;

    const contextDedupedEvents = dedupedEvents.filter(e => {
        const windowEnd = e.source_window_end ?? -1;
        const inRecentContext = dedupDepth > 0 && windowEnd >= visibleThreshold;
        if (inRecentContext && debugLog) {
            console.log(`[EventBase] Dedup-depth skip: event "${e.event_type}" source_window_end=${windowEnd} is within last ${dedupDepth} messages (threshold=${visibleThreshold})`);
        }
        return !inRecentContext;
    });

    if (debugLog && contextDedupedEvents.length < dedupedEvents.length) {
        console.log(`[EventBase] Dedup depth (${dedupDepth}) removed ${dedupedEvents.length - contextDedupedEvents.length} event(s) already visible in context`);
    }

    // 7. Trim to requested top-K
    const finalTopK = settings.eventbase_retrieval_top_k || 8;
    const finalEvents = contextDedupedEvents.slice(0, finalTopK);

    if (debugLog) {
        console.log(`[EventBase] Final events after dedup + trim: ${finalEvents.length}`);
        finalEvents.forEach((e, i) => {
            console.log(`  [${i}] type=${e.event_type} imp=${e.importance} score=${e._finalScore?.toFixed(3)} persist=${e.should_persist}`);
        });
    }

    return {
        events: finalEvents,
        debug: {
            dualQuery,
            rawCount: rawCandidates.length,
            keywordsBoosted: boostedCandidates.filter(c => c.keywordBoosted).length,
            queryKeywords: queryKeywords.map(k => k.text),
            afterImportanceFilter: importanceFiltered.length,
            afterDedup: dedupedEvents.length,
            afterContextDedup: contextDedupedEvents.length,
            finalCount: finalEvents.length,
            weights,
        },
    };
}
