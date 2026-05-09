# Dev Helper

## 1) Pipeline Architecture — EventBase Always On

EventBase is the **default and permanent** retrieval mode. There is no "EventBase OFF" path going forward.

### Two pipelines, strict ownership

| Pipeline | Owned collections | Code entry point |
|---|---|---|
| **EventBase pipeline** | `vecthare_eventbase_*`, `vecthare_archiveevent_*` | `eventbase-workflow.js` → `eventbase-retrieval.js` |
| **Standard pipeline** | `vecthare_lorebook_*`, `vecthare_document_*`, user collections | `chat-vectorization.js` → `queryAndMergeCollections` |

`vecthare_chat_*` collections (plain chunk-based chat history) are being phased out. When they still exist, they are excluded from the standard pipeline when EventBase is ON.

### Key isolation rule (`core/chat-vectorization.js` → `gatherCollectionsToQuery`)

- `vecthare_eventbase_*` → **always** skipped by the standard pipeline (EventBase pipeline owns them exclusively)
- `vecthare_archiveevent_*` → **always** skipped by the standard pipeline (EventBase pipeline owns them exclusively)
- `vecthare_chat_*` → skipped by the standard pipeline when EventBase is ON

### Archive Chat History — Two content paths

| Path | Content Type in UI | Collection prefix | Storage format | Retrieval |
|---|---|---|---|---|
| **A — EventBase** | `Chat → Upload` tab (EventBase ON) | `vecthare_archiveevent_*` | Event-shaped (same schema as live EventBase) | Phase A (EventBase re-ranker) |
| **B — Chunk** | `Document` content type | `vecthare_document_*` | Chunk-shaped | Phase B (standard pipeline) |

Archive event collections are **not** auto-locked to any chat after ingestion. Users must manually check "Active for current chat" on the collection card to activate retrieval for a given chat.

### Why this matters

Before this was fixed, `vecthare_eventbase_*` collections were included in the standard pipeline when EventBase was ON, causing them to be queried twice per generation: once by the EventBase pipeline (structured event retrieval with dedup-depth) and once by the standard pipeline (raw chunk retrieval). The standard pipeline query was always redundant and could inject duplicate content.

---

## 2) Extraction Level Location
Extraction levels are defined in: `core/keyword-boost.js`

Exact export name:
`EXTRACTION_LEVELS`

```javascript
export const EXTRACTION_LEVELS = {
    off: {
        label: 'Off',
        description: 'No auto-extraction, only WI trigger keys',
        enabled: false,
    },
    minimal: {
        label: 'Minimal',
        description: 'First 1500 chars, max 5 keywords',
        enabled: true,
        headerSize: 1500,
        minFrequency: 1,
        maxKeywords: 5,
    },
    balanced: {
        label: 'Balanced',
        description: 'First 5000 chars, max 12 keywords',
        enabled: true,
        headerSize: 5000,
        minFrequency: 1,
        maxKeywords: 12,
    },
    aggressive: {
        label: 'Aggressive',
        description: 'Full text scan, max 15 keywords',
        enabled: true,
        headerSize: null, // null = full text
        minFrequency: 1,
        maxKeywords: 15,
    },
};
```

## 3) Default Summarizer Token/Timeout Constants 
Located in: `core/summarizer.js`

Exact constant names:
- `DEFAULT_MAX_TOKENS`
- `DEFAULT_TIMEOUT_MS`

## 4) Group Batch Message Settings (going to demise as this is chunk based logic)
Located in: `core/summarizer.js`

Exact variable names used in grouped summarize flow:
- `groupMaxTokens`
- `groupTimeoutMs`

Notes:
- `groupMaxTokens` is computed from per-item budget and count, capped at 8192.
- `groupTimeoutMs` is computed as base timeout + per-item scaling, capped at 180000 ms.

## 5) Collection Active State — Two Separate Controls

There are **two independent toggles** for collection activity. They store data in different fields and must be checked separately.

### A) Card Pause/Resume Button (`enabled` flag)
- **UI:** Play/pause icon button on each collection card in the Database Browser
- **Writes:** `setCollectionEnabled(registryKey, false)` → stores `{ enabled: false }` under `extension_settings.vecthareplus.collections[registryKey]`
- **Key format:** `collection.registryKey || collection.id` — for EventBase collections registered via `eventbase-store.js`, this is the **plain collection ID** (no `backend:source:` prefix) because `registerCollection(collectionId)` is called with the raw ID
- **Read:** `isCollectionEnabled(collectionId)` in `core/collection-metadata.js` line 318
- **Default:** `true` (enabled) when no metadata exists

### B) "Active for current chat" Checkbox (lock system)
- **UI:** Checkbox in the Collection Settings panel (gear icon → "Active for current chat")
- **Writes:** `setCollectionLock(collectionId, chatId)` / `removeCollectionLock(collectionId, chatId)` → stores chat IDs in `{ lockedToChatIds: [...] }` under the **plain collection ID** entry in metadata
- **Key format:** Plain collection ID (`state.collectionId` which is `collection.id`, not `collection.registryKey`)
- **Read:** `isCollectionLockedToChat(collectionId, chatId)` in `core/collection-metadata.js` line 626
- **Role:** This is a **fallback activation** — not a gate. A collection locked to the current chat activates even with no triggers/conditions. A collection NOT locked can still activate if its triggers or conditions match.

### Activation Priority (in `shouldCollectionActivate`, `core/collection-metadata.js`)

```
1. Pause button (enabled=false)     → BLOCKED always, nothing else checked
2. Activation Triggers match        → ACTIVE  (regardless of lock state)
3. Advanced Conditions pass         → ACTIVE  (regardless of lock state)
4. "Active for current chat" locked → ACTIVE  (manual always-on fallback)
5. Nothing matched                  → BLOCKED
```

Behaviour matrix:

| Checkbox | Triggers/Conditions | Result |
|---|---|---|
| ✗ unchecked | keywords match | ✓ ACTIVE (triggers win) |
| ✓ checked | empty | ✓ ACTIVE (lock fallback) |
| ✓ checked | keywords match | ✓ ACTIVE (triggers win) |
| ✓ checked | set but no match | ✓ ACTIVE (lock fallback) |
| ✗ unchecked | set but no match | ✗ BLOCKED |
| ✗ unchecked | empty | ✗ BLOCKED |
| any | Pause button on | ✗ BLOCKED always |

> **Old Priority 1.3 is removed.** Previously there was a blocking gate (`NOT_LOCKED_TO_CURRENT_CHAT`) that prevented collections with a `lockedToChatIds` field from activating in other chats. This gate is gone — the lock is now purely additive (activation fallback), not restrictive.

### Key files
- `core/collection-metadata.js` — `shouldCollectionActivate`, `isCollectionEnabled`, `setCollectionEnabled`, `isCollectionLockedToChat`, `setCollectionLock`, `removeCollectionLock`, `getCollectionLocks`
- `ui/database-browser.js` line ~1055 — card toggle handler (`vecthare-action-toggle`)
- `ui/database-browser.js` function `saveActivation` — "Active for current chat" save handler
- `ui/database-browser.js` function `openActivationEditor` — reads lock state to populate checkbox

---

## 6) EventBase Window Dedup — chat_metadata Fingerprint Cache

### Problem with old approach
`isWindowAlreadyExtracted` used a semantic DB query (`queryCollection(..., 50, ...)`) to check if a window was already extracted. This was:
- Capped at 50 results → missed already-extracted windows if >50 events in DB
- Slow — requires embedding a dummy query + ANN search on every window

### Current approach (O(1), no DB query)
Window fingerprints are stored in `extension_settings.vecthareplus.eventbase_extracted_windows[chatUUID]` as a flat string array. Using `extension_settings` (not `chat_metadata`) ensures they survive page reloads — `saveSettingsDebounced()` is called after each window so the cache is immediately persisted.

- **Fingerprint format:** sorted source hashes joined by comma, e.g. `"123,456,789"`
- **On extraction:** `markWindowExtracted(sourceHashes, uuid)` appends the fingerprint (called in `eventbase-workflow.js` after successful insert)
- **On dedup check:** `isWindowAlreadyExtracted(sourceHashes, ...)` does `array.includes(fingerprint)` — synchronous, instant
- **Why NOT chat_metadata:** `chat_metadata` is only saved to disk when ST saves the chat (e.g. when a message is generated). Stopping mid-vectorization and reloading Chrome would lose all fingerprints written during that run.

### Key files
- `core/eventbase-store.js` — `isWindowAlreadyExtracted`, `markWindowExtracted`, `EXTRACTED_WINDOWS_KEY`
- `core/eventbase-workflow.js` — calls `markWindowExtracted(sourceHashes)` after `insertEvents` succeeds

### Migration note
Windows extracted before this fix have no fingerprint in cache. First run after update will attempt to re-insert them — Qdrant silently overwrites same hash-keyed points (no duplicates). All future runs use the cache correctly.

---

## 7) GUI Settings — EventBase Relevance

Two settings in the VectHare settings panel that look similar to EventBase internals:

| Setting | EventBase relevant? | What it actually does |
|---|---|---|
| **Insert Batch Size** (default 50) | **No** | Controls chunks-per-API-call during chunk vectorization. EventBase inserts tiny batches (2–10 events per window) so this has no meaningful effect on EventBase. |
| **Dedup Depth** (default 50 messages) | **Yes** | Used in `eventbase-retrieval.js` as `settings.deduplication_depth`. Filters out retrieved events whose source window falls within the last N messages of the current chat — avoids injecting content already visible in context. 0 = disabled. |

---

## 8) Similharity Plugin Speedup (Simultaneous Embedding Requests)
Plugin file changed: `../similharity/index.js`

What we changed:
- In `getVectorsForSource(...)`, API/network providers now run embedding calls in parallel using `Promise.all(...)`.
- Parallel provider set:
  - `openai`
  - `togetherai`
  - `mistral`
  - `electronhub`
  - `openrouter`
  - `nomicai`
  - `cohere`
- Local GPU providers remain sequential to avoid contention/queueing/OOM behavior:
  - `transformers`
  - `ollama`
  - `llamacpp`
  - `koboldcpp`

Why this speeds up:
- Before: one request embedding N items sequentially, total about N x T.
- After (API providers): N requests fired concurrently inside one batch, total about T (subject to upstream limits).

Related client-side behavior (VectHare):
- In `core/core-vector-api.js`, local GPU sources default to small batch behavior unless user explicitly overrides `insert_batch_size`.

---

## 9) Module Integration Analysis — EventBase Compatibility

Analysis of whether non-EventBase modules should be integrated into the EventBase pipeline.

### temporal-decay.js — NOT compatible

**Module:** [`core/temporal-decay.js`](core/temporal-decay.js)
**Decision:** ❌ Do not add to EventBase.

`applyDecayToResults` checks `chunk.metadata.source === 'chat'` and `chunk.metadata.messageId`. EventBase [`EventBase`](core/eventbase-schema.js) events do not carry `source: 'chat'` or a `messageId` field — they use `source_window_end`. Every event would be skipped with `decayApplied: false`.

Additionally, EventBase already has its own `_recencyBonus` — an exponential decay term computed from `source_window_end` and `chatLength` — baked into the 4-weight re-ranker formula in [`eventbase-store.js`](core/eventbase-store.js). Applying `temporal-decay.js` would be redundant and silently do nothing.

### hybrid-search.js — Used indirectly (do not wire directly)

**Module:** [`core/hybrid-search.js`](core/hybrid-search.js)
**Decision:** ✅ EventBase benefits from it — but through `queryCollection()`, not by direct call.

EventBase calls `queryEvents()` → `queryCollection()`. Inside `queryCollection()`, the A1/A2/A3 routing decides whether to invoke `clientSideHybridSearch()` (A2) or the backend's native hybrid (A3) from `hybrid-search.js`. So EventBase automatically inherits hybrid search without any additional wiring.

Do **not** call `hybridSearch()` directly from `eventbase-retrieval.js` or `eventbase-workflow.js`. It operates at the backend/collection layer — returns raw `{ hashes, metadata }` and bypasses `queryEvents()`, the store schema hydration, and EventBase-specific field population (`score`, `importance`, etc.).

### Summary table

| Module | Add directly to EventBase? | Reason |
|---|---|---|
| [`temporal-decay.js`](core/temporal-decay.js) | No | Already covered by `_recencyBonus` in the 4-weight formula; `applyDecayToResults` would silently skip all events due to missing `source: 'chat'` / `messageId` fields |
| [`hybrid-search.js`](core/hybrid-search.js) | No (used indirectly) | EventBase inherits A2/A3 hybrid automatically via `queryCollection()`. Direct calls would bypass `queryEvents()` and the store layer. |

---

## 10) EventBase Settings Impact Table

Three retrieval paths exist after the keyword-level simplification. All paths are chosen inside `queryCollection()` — EventBase inherits whichever applies to the active backend.

| Path | When | Loads all chunks? | Keyword scoring | Fusion |
|---|---|---|---|---|
| A1 — BM25 re-rank | Default for standard/LanceDB; or Qdrant/Milvus with `hybrid_native_prefer=false` and `keyword_scoring_method=bm25` | No | Okapi BM25 over ANN top-K only | Weighted linear: `α·vectorScore + β·bm25Score` (no RRF, no dual-signal bonus) |
| A2 — client-side hybrid full scan | `keyword_scoring_method=hybrid` (non-native) | **Yes** — slow on large collections | Okapi BM25 over all chunks (full corpus scan in browser) | **RRF** (default) or weighted; **min-max normalization** per batch; **dual-signal bonus** (up to +8% for docs matching both signals); single-signal penalty (×0.55 vector-only, ×0.60 text-only) |
| A3 — server-side hybrid | Qdrant/Milvus with `hybrid_native_prefer=true` (default) | No | Okapi BM25 (k1/b configurable) over full collection via Qdrant scroll — IDF computed over keyword-matching candidates | **RRF** (default) or weighted; **saturation normalization** (`score/(score+3.0)`); implicit dual-signal reward via RRF (no explicit bonus or single-signal penalty) |

**Fusion method detail:**

| Feature | A1 | A2 | A3 |
|---|---|---|---|
| RRF | ✗ | ✓ | ✓ |
| Weighted linear | ✓ (always) | ✓ (opt-in) | ✓ (opt-in) |
| Min-max normalization (batch-relative) | ✗ | ✓ | ✗ |
| Saturation normalization `score/(score+k)` | ✗ | ✓ (BM25 side) | ✓ (BM25 side, k=3.0) |
| Dual-signal bonus (explicit ×1.0–1.08) | ✗ | ✓ | ✗ (implicit via RRF) |
| Single-signal penalty | ✗ | ✓ | ✗ |
| BM25 corpus scope | ANN top-K | All chunks (full scan) | Keyword-matching candidates (scroll) |
| BM25 IDF accuracy | Biased (ANN subset) | Full corpus | Candidate subset (broader than A1, narrower than true full-corpus) |

| Setting | Affects EventBase? | Notes |
|---|---|---|
| `keyword_scoring_method` (`bm25` \| `hybrid`) | Yes | `bm25` = A1 fast re-rank; `hybrid` = A2 full corpus scan. Ignored when A3 active. |
| `hybrid_keyword_level` (`minimal` / `balance` / `maximum`) | Yes (A1 and A2) | Controls how many keywords (30/50/70) are extracted from the query for BM25 scoring. Ignored under A3. |
| `hybrid_native_prefer` | Yes | `true` (default for Qdrant/Milvus) → A3 server-side path. `false` → falls back to A1/A2 by `keyword_scoring_method`. |
| `hybrid_fusion_method` (`rrf` / `weighted`) | Yes (A2 and A3) | Fusion strategy. A2: RRF includes dual-signal bonus and single-signal penalty; weighted uses min-max normalization. A3: RRF provides implicit dual-signal reward via rank contribution; weighted uses saturation normalization. Not used in A1. |
| `hybrid_vector_weight`, `hybrid_text_weight` | Yes (A2/A3 weighted mode) | Used only when `hybrid_fusion_method = weighted`. |
| `hybrid_rrf_k` | Yes (A2/A3 RRF mode) | RRF constant k (default 60). Higher k flattens rank differences; lower k amplifies top-rank advantage. Used only when `hybrid_fusion_method = rrf`. |
| `bm25_k1`, `bm25_b` | Yes (A1 and A2) | BM25 TF saturation (k1, default 1.5) and length normalization (b, default 0.75) for A1 and A2. A3 also accepts these via `options.bm25k1` / `options.bm25b` passed through `hybridQuery`. |
| `keyword_extraction_level`, `keyword_boost_base_weight` | No | Ingestion-only settings. No longer used in any retrieval path. |
| `hybrid_search_enabled` | Removed | Setting deleted. Hybrid is now always available; path chosen by `keyword_scoring_method` + `hybrid_native_prefer`. |
| `deduplication_depth` | Yes | EventBase context deduplication — suppress events already visible in recent chat window. |
| `eventbase_retrieval_top_k`, `eventbase_retrieval_min_importance`, EventBase rerank weights | Yes | Active for all three retrieval paths. |

---

## 11) Mirrored Function — `extractQueryKeywords`

| Item | Value |
|---|---|
| Origin | `similharity/index.js` lines 54–146 |
| VectHare copy | `core/query-keyword-extractor.js` |
| Exports | `extractQueryKeywords(text, maxKeywords)`, `isCJKToken(token)`, `RETRIEVAL_KEYWORD_LEVELS`, `DEFAULT_RETRIEVAL_KEYWORD_LEVEL` |
| Stop-word source | Imports `DEFAULT_STOP_WORD_SET` from `./stop-words.js` (full multi-language list, English + CJK; mirrored from `similharity/stop-words.js`) |

**Keep-in-sync note:** if the extraction algorithm changes in `similharity/index.js` (e.g. anchor budget, bigram fallback, Latin regex), update `core/query-keyword-extractor.js` to match. The console log prefix was changed from `[Qdrant]` to `[VectHare]` — that difference is intentional.


## 12) javascript to get these variables in chrome console
const ctx = SillyTavern.getContext();
const chatUUID = ctx.chatMetadata?.integrity || ctx.chatId;
const handleId = (ctx.name1 || 'user').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_|_$/g, '').substring(0, 30) || 'user';
const charName = (ctx.name2 || 'chat').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_|_$/g, '').substring(0, 30) || 'chat';
console.log({ chatUUID, handleId, charName });

// Check current chat's integrity and which EventBase collection it WOULD map to
(() => {
  const md = SillyTavern.getContext().chatMetadata;
  return {
    integrity: md?.integrity || '(missing — using chatId fallback)',
    chatFile: SillyTavern.getContext().chatId,
  };
})()
