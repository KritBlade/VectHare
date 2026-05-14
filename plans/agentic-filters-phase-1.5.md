# Plan: Phase 1.5 — Apply Planner-Emitted Filters to Qdrant Queries

**TL;DR:** The AgentMode planner already emits structured payload filters (`characters_any`, `locations_any`, `factions_any`, `concepts_any`, `event_type_any`, `importance_gte`) in its JSON output, but they are dropped on the floor. This plan threads those filters end-to-end so Qdrant can narrow the candidate pool server-side, dramatically improving precision for character/concept-anchored questions. **Purely additive — empty filters preserve today's behavior exactly. Qdrant (A3) only.**

Related: [Doc/dev_helper.md §10](../Doc/dev_helper.md), [plans/executed/agentic-retrieval-plan.md](executed/agentic-retrieval-plan.md).

---

## 0. Goals and non-goals

### Goals
- Translate planner-emitted `*_any` arrays into Qdrant `should` clauses.
- Translate `importance_gte` into a Qdrant `range: { gte }` clause inside `must`.
- Preserve today's sentinel-exclusion (`must_not: type=_vectfox_meta`) and multitenancy (`content_type` filter) behavior.
- Plumb a single optional `filters` argument through the chain
  `agentic-retrieval.js → queryCollection → backend.hybridQuery → similharity plugin → _buildHybridFilter`.
- Zero behavior change when `filters` is empty / undefined — agentic with no filters and non-agentic paths run exactly as today.
- Add a settings toggle so users can disable filter application even while AgentMode is on (debug / A-B testing).

### Non-goals
- Phase-1.5 does **not** touch the EventBase native re-rank formula query. Filters
  layer on top of the existing `filter` block, they do not modify the `formula`.
- Does **not** support `must_all` / `must_not_any` planner shapes. Phase 1.5 is
  strictly the "match any of these" semantics that the planner currently emits.
- Does **not** add filter UI. The planner LLM emits filters automatically; users
  never edit them directly.
- Does **not** extend filters to A1 / A2 (Standard backend). Qdrant only.
- Does **not** change the planner prompt or schema — they already emit the shape.

---

## 1. Why `should` vs `must`?

Each `*_any` field is **OR within the field** (e.g. event mentions Character A OR B). The set of `*_any` fields is **OR across fields too** — the planner emits these as soft hints, not hard gates. A hard `must` AND across `characters_any` and `concepts_any` would over-filter the candidate set and frequently return zero hits when the planner guesses too aggressively.

Qdrant semantics:
- `must`: AND across clauses. Used for hard constraints (`type`, `sourceId`, `importance_gte`, sentinel exclusion).
- `should`: OR across clauses, with a configurable `min_should` (defaults to 1 when `must` is empty, 0 when `must` is present).
- `must_not`: NAND. Used for sentinel exclusion.

**Decision:** `*_any` filters go into `should` so any single match boosts/qualifies. `importance_gte` goes into `must` because it's a hard floor the user explicitly asked for ("remember the time when..." questions).

**Important Qdrant quirk:** When `must` is non-empty, `should` defaults to soft-boost (matches still pass even if no `should` clause hits). Phase 1.5 explicitly sets `min_should: { conditions: 1, ... }` only when `should` is non-empty AND `importance_gte` is absent — otherwise `importance_gte` alone would be enough to qualify a doc with zero `*_any` matches, which the planner does not want.

---

## 2. End-to-end data flow

```
agentic-retrieval.js
    plan.filters  (from planner JSON)
        │
        ▼
queryCollection(collectionId, searchText, topK, settings, filters?)
        │   (new optional 5th arg)
        ▼
hybridSearch(..., { queryVector, filters })
        │   (extends options object)
        ▼
backend.hybridQuery(collectionId, searchText, topK, settings, hybridOptions, filters?)
        │   (new optional 6th arg on QdrantBackend)
        ▼
POST /api/plugins/similharity/chunks/hybrid-query
    body: { ..., filters: { characters_any, ... } }
        │
        ▼
similharity plugin route handler
        │
        ▼
qdrantBackend._buildHybridFilter(filters)
        │
        ▼
Qdrant /points/query  → filtered results
```

Same flow for `hybridQueryWithRerank` (the native formula rerank path).

---

## 3. File-level surface area

| File | Role | Action |
|---|---|---|
| [similharity/qdrant-backend.js](../../similharity/qdrant-backend.js) | `_buildHybridFilter()` translates filter dict → Qdrant filter; `createPayloadIndexes()` declares Qdrant indexes | Extend filter with `*_any` and `importance_gte`; add 6 EventBase fields to index list (§4.10) |
| [similharity/index.js](../../similharity/index.js) (routes section) | `/chunks/hybrid-query`, `/chunks/hybrid-query-rerank`, plus new `/chunks/ensure-eventbase-indexes` | Accept `filters` in request body; add backfill route (§4.10.2) |
| [VectFox/backends/qdrant.js](../backends/qdrant.js) | `hybridQuery`, `hybridQueryWithRerank` | Add `filters` arg, include in POST body |
| [VectFox/core/hybrid-search.js](../core/hybrid-search.js) | `hybridSearch()` wrapper | Pass `options.filters` through to `backend.hybridQuery` |
| [VectFox/core/core-vector-api.js](../core/core-vector-api.js) | `queryCollection()` public API | Add optional `filters` 5th argument, forward into `hybridSearch` options |
| [VectFox/core/agentic-retrieval.js](../core/agentic-retrieval.js) | Fanout loop | Validate/sanitize `plan.filters`, pass to each `queryCollection` call |
| [VectFox/core/agentic-prompt.js](../core/agentic-prompt.js) | Planner prompt | One-line fix: add `items_any` to the filter-schema declaration (§4.6.1) |
| [VectFox/core/eventbase-store.js](../core/eventbase-store.js) | Insert + registry | New exported `ensureEventBaseIndexes(settings)` for one-time backfill (§4.10.2) |
| [VectFox/core/eventbase-retrieval.js](../core/eventbase-retrieval.js) | `_runOneLiveQuery` (native rerank path) | No change for Phase 1.5 — pre-search stays unfiltered (broad recall). Filters only apply to planner fanout. |
| [VectFox/index.js](../index.js) | Default settings | Add `agentic_filters_enabled: true` (master kill switch) |
| [VectFox/ui/ui-manager.js](../ui/ui-manager.js) | AgentMode tab | Add single checkbox "Apply planner filters" (default on) |
| [VectFox/Doc/dev_helper.md](../Doc/dev_helper.md) §10 | Phase 1 limitations list | Remove the filter-limitation bullet once shipped |
| [VectFox/tests/](../tests/) | New | Add `agentic-filters.test.js` for `_validatePlannerFilters` |

**Net:** 2 files in similharity (1 with backfill route added), 8 files in VectFox (incl. eventbase-store.js for backfill and the one-line planner-prompt fix), 1 doc, 1 test.

---

## 4. Detailed changes

### 4.1 `similharity/qdrant-backend.js` — extend `_buildHybridFilter`

Existing function handles single-value `match` and `range` clauses on scalar payload fields. Extend with:

```js
_buildHybridFilter(filters) {
    const must = [];
    const should = [];
    // Use the existing module-level constant — do NOT inline the string literal.
    const must_not = [{ key: 'type', match: { value: SENTINEL_POINT_TYPE } }];

    const add = (key, clause) => must.push({ key, ...clause });

    // — existing scalar filters (unchanged) —
    if (filters.type)               add('type',            { match: { value: filters.type } });
    if (filters.sourceId)           add('sourceId',        { match: { value: filters.sourceId } });
    if (filters.minImportance !== undefined) add('importance', { range: { gte: filters.minImportance } });
    if (filters.timestampAfter !== undefined) add('timestamp', { range: { gte: filters.timestampAfter } });
    if (filters.characterName)      add('characterName',   { match: { value: filters.characterName } });
    if (filters.chatId)             add('chatId',          { match: { value: filters.chatId } });
    if (filters.embeddingSource)    add('embeddingSource', { match: { value: filters.embeddingSource } });
    if (filters.content_type)       add('content_type',    { match: { value: filters.content_type } });

    // — NEW: planner-emitted *_any filters (OR within and across fields) —
    const anyMap = {
        characters_any: 'characters',
        locations_any:  'locations',
        factions_any:   'factions',
        concepts_any:   'concepts',
        items_any:      'items',
        event_type_any: 'event_type',
    };
    for (const [src, payloadKey] of Object.entries(anyMap)) {
        const vals = filters[src];
        if (Array.isArray(vals) && vals.length > 0) {
            should.push({ key: payloadKey, match: { any: vals } });
        }
    }

    // — NEW: planner-emitted hard floor —
    if (typeof filters.importance_gte === 'number') {
        must.push({ key: 'importance', range: { gte: filters.importance_gte } });
    }

    const out = { must_not };
    if (must.length > 0) out.must = must;
    if (should.length > 0) {
        out.should = should;
        // Require at least one *_any match when no other hard constraint qualifies.
        // If `must` already contains a non-sentinel hard filter, leave should as a
        // soft boost (Qdrant default behavior).
        const hasHardConstraint = must.some(c =>
            c.key !== 'type' && c.key !== 'sourceId' && c.key !== 'content_type');
        if (!hasHardConstraint) {
            out.min_should = { conditions: 1 };
        }
    }
    return out;
}
```

**Notes:**
- `match: { any: [...] }` is Qdrant's array-value match operator. Works on both
  scalar payload fields (matches if field equals any value) and array fields
  (matches if any element of the payload array equals any value in the list).
  EventBase stores `characters`, `locations`, `factions`, `concepts`, `items`
  as arrays and `event_type` as a scalar — the same operator handles both.
- `min_should: { conditions: 1 }` is the Qdrant ≥ 1.7 form. If the server is
  older the simpler integer form `min_should: 1` works as a fallback — gate this
  on `serverVersion` if needed.
- Backward compatible: empty / missing `filters` → same output as today.
- **Where `should` / `min_should` actually take effect:** both
  `hybridQueryNative` and `hybridQueryNativeWithRerank` attach the full
  `_buildHybridFilter` output (must + must_not + should + min_should) onto the
  dense and sparse **prefetch legs** in [qdrant-backend.js:782-784 / 904-906](../../similharity/qdrant-backend.js#L782).
  Anything that doesn't satisfy `min_should` is pruned at prefetch time and
  never reaches the outer fusion/formula step. The outer-filter merge in
  `hybridQueryNativeWithRerank` at [lines 877-899](../../similharity/qdrant-backend.js#L877)
  intentionally only re-uses `must` and `must_not` — it does NOT need to
  propagate `should` / `min_should`, because the prefetch already gated them.
  Workers: do not "fix" that merge code to forward `should` — it's correct as-is.
- **Empty payload arrays** (e.g. an event with `factions: []` and `items: []`)
  are common. `match: { any: [...] }` against an empty array simply fails to
  match — no error, no crash. No defensive guard required at the filter layer.

### 4.2 `similharity/index.js` — accept `filters` in route bodies

The `/chunks/hybrid-query` and `/chunks/hybrid-query-rerank` POST handlers currently destructure `hybridOptions` from the body. Add `filters` alongside:

```js
const { collectionId, searchText, topK, source, model, hybrid, hybridOptions, sparseQueryVector, filters } = req.body;
// ...
const results = await qdrantBackend.hybridQueryNative(
    collectionId, denseVector, sparseQueryVector, topK, hybridOptions, filters || {}
);
```

`_buildHybridFilter` is called inside `hybridQueryNative` / `hybridQueryNativeWithRerank` — both already pass `filters` through. No further change in those methods.

### 4.3 `VectFox/backends/qdrant.js` — add `filters` arg

```js
async hybridQuery(collectionId, searchText, topK, settings, hybridOptions = {}, filters = {}) {
    // ...existing setup...
    const body = {
        backend: BACKEND_TYPE,
        collectionId: actualCollectionId,
        searchText,
        topK,
        threshold: 0.0,
        source: settings.source || 'transformers',
        model: getModelFromSettings(settings),
        hybrid: true,
        hybridOptions: { /* unchanged */ },
        sparseQueryVector,
    };

    // Merge multitenancy filter with planner filters (multitenancy stays in `must`).
    if (settings.qdrant_multitenancy) {
        filters = { ...filters, content_type: strippedCollectionId };
    }
    if (Object.keys(filters).length > 0) {
        body.filters = filters;
    }
    // ...existing fetch...
}
```

Same pattern in `hybridQueryWithRerank`. The existing `body.filter = { must: [...] }` shortcut for multitenancy is removed in favor of letting the plugin's `_buildHybridFilter` handle it via the merged `filters.content_type`.

### 4.4 `VectFox/core/hybrid-search.js` — thread filters through options

```js
export async function hybridSearch(collectionId, searchText, topK, settings, options = {}) {
    const { queryVector, filters = {} } = options;
    // ...
    const result = await backend.hybridQuery(collectionId, searchText, topK, settings, hybridOptions, filters);
    // ...
}
```

### 4.5 `VectFox/core/core-vector-api.js` — extend `queryCollection`

```js
export async function queryCollection(collectionId, searchText, topK, settings, filters = {}) {
    // ...existing routing...
    if (useHybridPath) {
        const result = await hybridSearch(collectionId, searchText, topK, settings, { queryVector, filters });
        return result;
    }
    // A1 path: filters ignored (Standard backend doesn't support them). Log once if non-empty.
    if (Object.keys(filters).length > 0 && settings.eventbase_debug_logging) {
        console.warn('[VectFox] queryCollection: filters ignored on A1 / Standard backend path');
    }
    // ...existing A1 flow...
}
```

**Caller compatibility:** Every existing call site passes 4 args. The new 5th arg defaults to `{}`, so no other code changes are required.

### 4.6 `VectFox/core/agentic-retrieval.js` — validate and pass filters

Add a validator helper near `_validateAndTrimQueries`:

```js
/**
 * Sanitize planner-emitted filters. Drops unknown keys, trims arrays to
 * a reasonable max, and clamps `importance_gte` to 1-10. Returns `{}` on
 * empty / invalid input so callers can `Object.keys(out).length === 0`.
 */
function _validatePlannerFilters(raw, settings) {
    if (!raw || typeof raw !== 'object') return {};
    if (settings.agentic_filters_enabled === false) return {};

    const MAX_VALUES_PER_FIELD = 8;
    const out = {};
    const arrayFields = ['characters_any', 'locations_any', 'factions_any',
                         'concepts_any', 'items_any', 'event_type_any'];
    for (const key of arrayFields) {
        const v = raw[key];
        if (Array.isArray(v) && v.length > 0) {
            const cleaned = [...new Set(v
                .filter(x => typeof x === 'string')
                .map(x => x.trim())
                .filter(x => x.length > 0)
            )].slice(0, MAX_VALUES_PER_FIELD);
            if (cleaned.length > 0) out[key] = cleaned;
        }
    }
    if (typeof raw.importance_gte === 'number' && Number.isFinite(raw.importance_gte)) {
        out.importance_gte = Math.max(1, Math.min(10, Math.round(raw.importance_gte)));
    }
    return out;
}
```

Wire it into the fanout loop:

```js
const plannerFilters = _validatePlannerFilters(plan?.filters, settings);

if (agenticDebug) {
    if (Object.keys(plannerFilters).length === 0) {
        console.log('[vectfoxPlus-Agentic] Planner filters: (none — running unfiltered)');
    } else {
        console.log(`[vectfoxPlus-Agentic] Planner filters applied: ${JSON.stringify(plannerFilters)}`);
    }
}

const fanoutPromises = [];
for (const colId of liveCollectionIds) {
    for (const queryText of validatedQueries) {
        fanoutPromises.push(
            queryCollection(colId, queryText, topK, ebSettings, plannerFilters)
                .then(/* unchanged */)
                .catch(/* unchanged */)
        );
    }
}
```

Update the file header comment to remove the "filters NOT applied" line and drop the Phase 1 note above the fanout (line 165).

### 4.6.1 `core/agentic-prompt.js` — declare `items_any` in the planner's filter schema

The planner-prompt's filter-schema declaration at [agentic-prompt.js:57-60](../core/agentic-prompt.js#L57) currently lists only five `*_any` keys (`characters_any`, `locations_any`, `factions_any`, `concepts_any`, `event_type_any`) — `items_any` is missing from the schema even though the worked examples downstream (e.g. line 145: `items_any: ["勾魂"]`) reference it. Without the schema declaration the LLM is unlikely to emit `items_any` at all, so the planner→validator→filter pipeline never sees it in practice.

One-line fix:

```diff
   filters:   Optional. Object with any of:
-               characters_any, locations_any, factions_any, concepts_any,
+               characters_any, locations_any, factions_any, items_any, concepts_any,
               event_type_any  (arrays of strings)
               importance_gte  (number 1-10)
```

No other prompt changes required — the worked examples already use `items_any` correctly.

### 4.7 Settings — `index.js`

```js
agentic_filters_enabled: true,   // master switch for planner-emitted filter application
```

Defaults on. Users can flip to `false` via settings.json or the AgentMode tab checkbox (§4.8) to A/B against unfiltered behavior.

### 4.8 UI — `ui/ui-manager.js`

Single checkbox in the AgentMode tab, below the existing sliders:

```
[ ✓ ] Apply planner filters
       When on, planner-emitted character / concept / importance filters
       narrow the Qdrant query. When off, only the planner queries run —
       all candidates are considered. Has no effect on the pre-search.
```

Bound to `agentic_filters_enabled`. Hidden when `vector_backend !== 'qdrant'` (same condition as the rest of the AgentMode tab).

### 4.9 Documentation — `Doc/dev_helper.md` §10

Remove the "Planner-emitted filters are NOT applied" bullet from "Phase 1 limitations (intentional)". Replace with a new "Filter application" subsection describing the validator, the `should` vs `must` split, and the `agentic_filters_enabled` toggle.

### 4.10 Ingestion-side changes — payload indexes

The planner-filter fields (`characters`, `locations`, `factions`, `concepts`, `items`, `event_type`) are **already stored** on every EventBase point — [core/eventbase-store.js](../core/eventbase-store.js#L60) spreads the full event into `item.metadata`, and [similharity/qdrant-backend.js](../../similharity/qdrant-backend.js#L539) spreads `item.metadata` into the Qdrant payload. So `match: { any: [...] }` works correctly today on the data itself.

What's missing are **payload indexes**. Without them Qdrant falls back to a full payload scan per filter clause — acceptable at small scale, but degrades linearly with collection size.

#### 4.10.1 Extend `createPayloadIndexes()` in [similharity/qdrant-backend.js](../../similharity/qdrant-backend.js#L312)

Append six entries to the `indexConfigs` array:

```js
// EventBase planner-filterable fields (Phase 1.5 agentic filters).
// Qdrant's `keyword` schema handles both scalar and array-of-string
// payloads — `match: { any: [...] }` works on either shape.
{ field: 'characters', schema: 'keyword' },
{ field: 'locations',  schema: 'keyword' },
{ field: 'factions',   schema: 'keyword' },
{ field: 'concepts',   schema: 'keyword' },
{ field: 'items',      schema: 'keyword' },
{ field: 'event_type', schema: 'keyword' },
```

The existing catch block already swallows `409 already exists`, so this is idempotent — safe to call repeatedly on the same collection.

#### 4.10.2 Backfill strategy for existing collections

`createPayloadIndexes()` is only invoked when a collection is **first created**. Pre-existing EventBase collections (created before Phase 1.5 ships) won't have the new indexes unless we trigger backfill explicitly.

**Approach: auto-backfill on plugin/extension startup**, with a UI popup so the user knows it's happening (Qdrant builds indexes lazily but the first-pass scan can take a few seconds per collection on a large corpus).

Implementation:

1. **New similharity route** `POST /chunks/ensure-eventbase-indexes`:
   - Body: `{ collectionId }` (optional — omit to backfill *all* discovered EventBase collections)
   - Calls `qdrantBackend.createPayloadIndexes(collectionId)` per collection.
   - Returns `{ ensured: [{collectionId, fieldsCreated: [...]}], errors: [] }`.

2. **VectFox-side bootstrap** in [core/eventbase-store.js](../core/eventbase-store.js) (new exported function `ensureEventBaseIndexes(settings)`):
   - Triggered once per page load, gated by a flag in `extension_settings.vectfox.eventbase_indexes_v1_backfilled` so it doesn't repeat on every reload after success.
   - Discovers EventBase collections via the existing registry (`vf_eventbase_*` and `vf_archiveevent_*` prefixes).
   - Calls the new route. On success, sets the backfill flag.
   - Skipped entirely when `settings.vector_backend !== 'qdrant'`.

3. **UI popups** — small toast-style notifications, not blocking modals:
   - **On start:** `"VectFox: upgrading EventBase index (one-time, ~30s)…"` — appears when the bootstrap kicks off and at least one collection needs work.
   - **On finish:** `"VectFox: EventBase index upgrade complete (N collections)."` — appears when the route returns success.
   - **On error:** `"VectFox: EventBase index upgrade failed for <N> collection(s) — see console. AgentMode filters may run slower."` — non-fatal; filters still work, just unindexed.
   - Reuse the existing toast system in [ui/ui-manager.js](../ui/ui-manager.js) (SillyTavern's `toastr` global, same as other VectFox notifications).
   - Suppressed entirely when no collections need backfill (flag already set → silent no-op).

4. **Wiring** — call `ensureEventBaseIndexes(settings)` from VectFox's existing init path in [index.js](../index.js) (alongside the existing collection-registry cleanup). Non-blocking: errors are caught and logged, never bubble up to prevent extension load.

```js
// In VectFox/index.js init sequence (sketch)
import { ensureEventBaseIndexes } from './core/eventbase-store.js';

// ...after settings load, after backend init...
if (settings.vector_backend === 'qdrant') {
    ensureEventBaseIndexes(settings).catch(err => {
        console.warn('[VectFox] EventBase index backfill failed:', err);
    });
}
```

#### 4.10.3 Verification

After backfill, confirm indexes exist via `GET /collections/{name}`. The response includes `payload_schema` keyed by field name:

```json
{
  "result": {
    "payload_schema": {
      "characters": { "data_type": "keyword", "points": 142 },
      "locations":  { "data_type": "keyword", "points": 142 },
      "concepts":   { "data_type": "keyword", "points": 142 },
      ...
    }
  }
}
```

Add a verification helper to the plugin (optional, dev-only): `GET /chunks/eventbase-index-status?collectionId=<id>` returns which of the 6 fields are indexed vs missing. Useful for the diagnostics panel.

#### 4.10.4 No data migration required

The point payload itself does NOT change. Events ingested before Phase 1.5 already carry `characters`, `locations`, `concepts`, etc. in their payload (they have since EventBase was first introduced — see [core/eventbase-schema.js](../core/eventbase-schema.js) validator output). The backfill only adds indexes on top of existing data — no re-vectorization, no schema migration, no embedding regeneration.

---

## 5. Testing

### 5.1 Unit tests (`tests/agentic-filters.test.js`)

| Case | Expected |
|---|---|
| `_validatePlannerFilters(null, {})` | `{}` |
| `_validatePlannerFilters({}, {})` | `{}` |
| `{characters_any: ['A', 'B']}` | `{characters_any: ['A', 'B']}` |
| `{characters_any: ['A', '', 'A', 'A']}` (dedup + trim) | `{characters_any: ['A']}` |
| `{characters_any: [1, 2, 3]}` (non-string) | `{}` |
| `{characters_any: ['A', 1, 'B', null]}` (mixed types — filter non-strings, keep rest) | `{characters_any: ['A', 'B']}` |
| `{importance_gte: 15}` (clamp high) | `{importance_gte: 10}` |
| `{importance_gte: 0}` (clamp low) | `{importance_gte: 1}` |
| `{importance_gte: 7}` (valid passthrough) | `{importance_gte: 7}` |
| `{importance_gte: 'high'}` (invalid) | `{}` |
| `{event_type_any: ['relationship_change']}` (scalar payload field) | `{event_type_any: ['relationship_change']}` — and `_buildHybridFilter` produces a `should` clause on the `event_type` key |
| `{items_any: ['勾魂']}` (CJK proper noun, original script) | `{items_any: ['勾魂']}` — bytes preserved exactly |
| `{unknown_field: ['x']}` | `{}` |
| Long array (>8 items) | trimmed to 8 |
| `agentic_filters_enabled: false` settings | always `{}` |

### 5.2 Integration tests

Manual + scripted against a populated Qdrant collection:

1. **Recall preserved:** Run the planner with empty filters and with filters from a known matching event. Assert filtered top-K is a subset of unfiltered top-K *with re-rank applied*. Failure mode: filter is too strict and drops relevant events.
2. **Min-should gate:** Send `{characters_any: ['NonexistentName']}` only. Expect zero hits from that query (no doc has that character). Other fanout queries unaffected.
3. **importance_gte hard floor:** Send `{importance_gte: 8}` only. Verify all returned events have `importance >= 8` in the metadata.
4. **Mixed filters:** Send `{characters_any: ['Astarion'], importance_gte: 6}`. Verify every result has Astarion AND importance ≥ 6.
5. **Backward compatibility:** Disable AgentMode, run normal retrieval. Confirm zero new code paths fire (no `_validatePlannerFilters` log lines, no `filters` in request body).
6. **Index backfill (§4.10):**
   - First run on a pre-Phase-1.5 collection: toast `"upgrading EventBase index…"` appears, backfill completes, `"…upgrade complete (N collections)"` toast follows, `eventbase_indexes_v1_backfilled` flag is set.
   - Second run (same browser session or after reload): silent — no toast, no route call (flag short-circuits).
   - `GET /collections/<name>` after backfill shows all 6 new fields in `payload_schema` with `data_type: "keyword"`.
   - Forced retry by clearing the flag in console reproduces the toast pair.

### 5.3 A/B benchmark

Re-run the AgentMode benchmark suite (same fixtures as Phase 1) twice:
- `agentic_filters_enabled: false` → matches today's behavior (baseline).
- `agentic_filters_enabled: true` (default) → measure precision@K and recall@K shift.

Pass criterion: precision@8 improves ≥ 5% on character-anchored questions with no recall@8 regression > 3% on broad / reflective questions. If recall regresses too hard, tighten `_validatePlannerFilters` to drop low-confidence `*_any` arrays (e.g. only apply when array length ≤ 3).

---

## 6. Rollout

1. **Land code behind `agentic_filters_enabled: false` default.** All plumbing exists but defaults off so any latent bug only affects opt-in testers.
2. **Internal A/B for 1 week** on a populated test chat. Watch debug logs for filter shapes the planner actually emits in the wild.
3. **Flip default to `true`** once benchmark numbers settle.
4. **Remove the dev_helper Phase 1 limitation bullet** and update §10 with the new behavior matrix.
5. **Move this plan to `plans/executed/`** alongside the original `agentic-retrieval-plan.md`.

---

## 7. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Planner emits a wrong character name → zero hits | `should` semantics + multiple `*_any` fields = OR. One wrong name doesn't sink the query unless it's the only filter. Validator caps array size so a hallucinated long list can't dominate. |
| Older Qdrant rejects `min_should: { conditions: 1 }` syntax | Fall back to integer form `min_should: 1` when `serverVersion < 1.7`. Probe is already cached at backend init. |
| Multitenancy filter conflicts with `*_any` filters | Multitenancy stays in `must` (hard tenant gate). `*_any` stays in `should`. The two layers don't interact. |
| `_buildHybridFilter` regression breaks non-agentic chunk queries | Empty `filters = {}` produces exactly today's output (only `must_not: [sentinel]` plus any pre-existing scalar matches). Unit test the empty case explicitly. |
| Filter signal too aggressive on Latin / English chats (planner over-extracts characters) | Validator drops empty strings; planner prompt already warns against over-filtering. Benchmark gates the default flip. |
| A1/A2 callers accidentally pass filters and silently get unfiltered results | `queryCollection` logs a one-shot warning when `filters` is non-empty on a Standard-backend path. |
| Qdrant `match: { any: [...] }` is **byte-exact** — planner case / whitespace / script drift (e.g. "mayla" vs "Mayla", "潮音鎮 " trailing-space) silently drops candidates | Validator already `.trim()`s and de-dups; planner prompt repeatedly emphasizes "AS-IS in your queries" for proper nouns. If A/B benchmark shows recall misses traceable to case drift, add `.toLowerCase()` to both ingestion AND filter (invasive — defer to Phase 2). Do NOT lowercase only one side — that breaks both old and new data. |

---

## 8. Out of scope (Phase 2 candidates)

- **must_all semantics** — for questions where the planner is confident two
  characters MUST co-appear in an event (e.g. "the scene where A confronts B").
  Requires planner prompt extension AND a separate `characters_all` field.
- **Filter application on pre-search** — currently only the planner fanout sees
  filters; the original pre-search stays broad for recall. Could be tested in
  Phase 2 as a precision-focused mode.
- **Filter application on A1 / A2 (Standard backend)** — would require
  client-side post-filtering of the ANN top-K after metadata fetch. Cheaper
  than re-architecting Vectra, but adds a code path that doesn't benefit any
  current production user.
- **Negative filters** (`characters_not_any`) — planner doesn't emit these
  today and they invite over-pruning. Add only with strong benchmark backing.
