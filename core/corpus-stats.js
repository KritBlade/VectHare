/**
 * ============================================================================
 * CORPUS STATISTICS (full-corpus BM25 IDF source)
 * ============================================================================
 * Lazy, session-cached fetcher that pulls every chunk of a collection via the
 * /chunks/list plugin endpoint, tokenizes each one, and builds:
 *   - totalDocs        (N, used in IDF formula)
 *   - documentFrequencies  (term -> df, used in IDF formula)
 *   - avgDocLength     (used in BM25 length normalization)
 *
 * Gated by settings.bm25_use_corpus_idf. When ON, A1/A2 client-side BM25
 * paths plug these stats into BM25Scorer instead of computing IDF over the
 * local ANN candidate set. See dev_helper.md §10 (A1/A2 vs A3).
 *
 * Lifecycle:
 *   - Built lazily on the first getCorpusStats(collectionId) call after page
 *     load OR after the entry is invalidated.
 *   - Cached in module-level Map for the rest of the session.
 *   - Auto-invalidated by core-vector-api.js's insert / delete / purge paths
 *     and by collection-export.js's import path. Manual clear is also
 *     available via clearCorpusStatsCache(collectionId|undefined).
 *
 * Invalidation policy is LAZY-rebuild: the entry is just removed; the next
 * getCorpusStats() call sees a cache miss and rebuilds. This pays the rebuild
 * cost during the user's next query, not during the write — auto-sync /
 * vectorization stay snappy and the cost is amortized over future reads.
 * ============================================================================
 */
import { getRequestHeaders } from '../../../../../script.js';
import { extension_settings } from '../../../../extensions.js';
import { tokenize } from './bm25-scorer.js';
import { getModelFromSettings } from './providers.js';

const _cache = new Map(); // collectionId -> { totalDocs, documentFrequencies, avgDocLength, builtAt }
const _inflight = new Map(); // collectionId -> Promise (dedupe concurrent fetches)

const FETCH_LIMIT = 10000;

/**
 * Resolve the plugin's `backend` field from the user's vector_backend setting.
 * Matches what core-vector-api.js sends for chunks/list.
 */
function _pluginBackendName(settings) {
    const b = String(settings?.vector_backend || 'standard').toLowerCase();
    return b === 'standard' ? 'vectra' : b;
}

/**
 * Fetch full-corpus stats for a collection. Cached for the session.
 * Returns null on failure so callers can fall back to local-IDF behavior.
 *
 * @param {string} collectionId
 * @param {object} settings - VectFox settings (uses .source, .model, .vector_backend)
 * @returns {Promise<{totalDocs: number, documentFrequencies: Map<string, number>, avgDocLength: number} | null>}
 */
export async function getCorpusStats(collectionId, settings) {
    if (!collectionId) return null;

    const cached = _cache.get(collectionId);
    if (cached) return cached;

    const inflight = _inflight.get(collectionId);
    if (inflight) return inflight;

    const promise = _buildStats(collectionId, settings)
        .then(stats => {
            if (stats) _cache.set(collectionId, stats);
            return stats;
        })
        .catch(err => {
            console.warn(`[CorpusStats] Build failed for ${collectionId}:`, err?.message || err);
            return null;
        })
        .finally(() => {
            _inflight.delete(collectionId);
        });
    _inflight.set(collectionId, promise);
    return promise;
}

async function _buildStats(collectionId, settings) {
    // Per-stage timing so a slow build tells us WHICH stage is the choke point:
    //   1. HTTP fetch  → server-side work + network (large collections = lots of bytes)
    //   2. JSON parse  → usually negligible, can spike on huge arrays
    //   3. Tokenize    → main-thread CPU; CJK tokenizers (Jieba/Intl.Segmenter)
    //                    can be the dominant cost on chat content
    //   4. df-map build → cheap (O(unique-tokens))
    //
    // This logs even when eventbase_debug_logging is off — corpus-stats build
    // happens at most once per session per collection, so the noise is minimal
    // and the timing data is critical for diagnosing slow first-queries.
    const _now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const _ms = (start) => Math.round(_now() - start);
    const tStart = _now();

    // Stage 1 — HTTP fetch
    const tFetch = _now();
    const response = await fetch('/api/plugins/similharity/chunks/list', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            backend: _pluginBackendName(settings),
            collectionId,
            source: settings?.source || 'transformers',
            model: getModelFromSettings(settings),
            limit: FETCH_LIMIT,
            includeVectors: false,
        }),
    });
    if (!response.ok) {
        throw new Error(`chunks/list ${response.status}`);
    }
    const tFetchMs = _ms(tFetch);

    // Stage 2 — JSON parse
    const tParse = _now();
    const data = await response.json();
    const items = Array.isArray(data?.items) ? data.items : [];
    const tParseMs = _ms(tParse);

    // Stage 3 — Tokenize every chunk + accumulate df. This is synchronous JS
    // running on the main thread; for CJK collections with Jieba/Intl.Segmenter
    // it often dominates total build time. If we ever need to fix this,
    // candidates are: move to a Web Worker, batch + yield via requestIdleCallback,
    // or ask the plugin to return pre-computed token frequencies.
    const tTokenize = _now();
    const documentFrequencies = new Map();
    let totalLength = 0;
    let totalTokens = 0;
    let skipped = 0;
    for (const item of items) {
        const text = item?.text || item?.metadata?.text || '';
        if (!text) { skipped++; continue; }
        const tokens = tokenize(text);
        totalLength += tokens.length;
        totalTokens += tokens.length;
        const unique = new Set(tokens);
        for (const term of unique) {
            documentFrequencies.set(term, (documentFrequencies.get(term) || 0) + 1);
        }
    }
    const tTokenizeMs = _ms(tTokenize);

    const stats = {
        totalDocs: items.length,
        documentFrequencies,
        avgDocLength: items.length > 0 ? totalLength / items.length : 0,
        builtAt: Date.now(),
    };

    const totalMs = _ms(tStart);
    console.log(
        `[CorpusStats] Built for ${collectionId} in ${totalMs}ms ` +
        `(fetch=${tFetchMs}ms, parse=${tParseMs}ms, tokenize+df=${tTokenizeMs}ms) ` +
        `→ N=${stats.totalDocs}${skipped ? ` (${skipped} empty skipped)` : ''}, ` +
        `uniqueTerms=${documentFrequencies.size}, totalTokens=${totalTokens}, ` +
        `avgLen=${stats.avgDocLength.toFixed(1)}`
    );
    return stats;
}

/**
 * Clear the cache. Pass a collectionId to clear just one collection, or omit
 * to clear everything. Call after re-indexing or major collection edits.
 *
 * Logs are gated on eventbase_debug_logging — the auto-invalidation path
 * fires on every insert/delete/purge and would otherwise spam the console.
 * Enable debug logging when manually force-refreshing in DevTools to confirm
 * the call did something.
 */
export function clearCorpusStatsCache(collectionId) {
    const sizeBefore = _cache.size;
    const hadEntry = collectionId ? _cache.has(collectionId) : false;
    if (collectionId) {
        _cache.delete(collectionId);
        _inflight.delete(collectionId);
    } else {
        _cache.clear();
        _inflight.clear();
    }
    if (extension_settings?.vectfox?.eventbase_debug_logging) {
        if (collectionId) {
            console.log(`[CorpusStats] Manual clear: ${hadEntry ? 'removed' : 'no entry for'} "${collectionId}" (cache size: ${sizeBefore} → ${_cache.size})`);
        } else {
            console.log(`[CorpusStats] Manual clear: removed all ${sizeBefore} cached collection(s)`);
        }
    }
}
