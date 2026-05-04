# Plan: VectHare Legacy & Multi-Backend Removal

Strip VectHare down to **EventBase-only** workflow with **standard + qdrant** backends only. The goal is to remove the legacy chunk-based RAG pipeline entirely, delete LanceDB and Milvus support, and clean up all settings/UI/tests that no longer apply.

This plan must be saved to `h:\Github\Dev\VectHare\plans\eventbase-only-cleanup.md` for the worker AI.

---

## Executive Summary

**Current state**: VectHare has TWO complete RAG pipelines coexisting:
1. **Legacy** (chunk-based): chunks chat → vectorizes → BM25/hybrid scoring → keyword boost → temporal decay → conditional activation → dedup → inject. ~2300 LOC in `chat-vectorization.js` plus 17 supporting modules.
2. **EventBase** (event-based): sliding window → LLM extraction to structured `EventRecord` → vector store → re-rank → inject as JSON/bullets. ~6 dedicated modules in `core/eventbase-*.js`.

**Target state**: Only EventBase. Legacy modules deleted. Backends reduced to `standard.js` + `qdrant.js` (LanceDB/Milvus deleted). UI tabs trimmed to: Core (slimmed), RAG, Action, EventBase.

**Scope**: ~1,300 LOC test deletion, ~2,300 LOC `chat-vectorization.js` deletion, 17 modules deleted, 4 UI tabs deleted (Weight, WorldInfo, Summarize, AutoSync may simplify rather than delete — see Phase 4).

---

## Pre-Execution Notes for Worker AI

**The user has a complete backup of this project** — proceed aggressively, do not preserve "just in case" code.

**You will NOT have prior conversation context.** Read this plan carefully and follow exactly. If you find something not covered here, prefer DELETION over preservation, EXCEPT:
- Never delete anything under `core/eventbase-*.js`
- Never delete `core/collection-ids.js`, `core/collection-loader.js`, `core/providers.js`, `core/core-vector-api.js`, `core/constants.js`
- Never delete `backends/standard.js`, `backends/qdrant.js`, `backends/backend-interface.js`, `backends/backend-manager.js`
- Never modify `eventbase_*` settings keys or UI elements

**Settings safety**: The setting key `deduplication_depth` is shared — it is consumed by `eventbase-retrieval.js` line ~176. KEEP IT.

**Verification cadence**: After each phase, run `npm test` (or equivalent in `package.json`). Stop and report if a test that should still pass starts failing.

---

## Phase 1: Backend Removal (LanceDB + Milvus)

Quick, isolated, low-risk. Do this first to confirm the build still works before tackling the bigger surgery.

### 1.1 Delete files
- `backends/lancedb.js`
- `backends/milvus.js`

### 1.2 Modify `backends/backend-manager.js`
Remove imports and registry entries for `lancedb` and `milvus`. The `BACKENDS` object should retain only `standard` and `qdrant`. Remove the `vectra` alias (or keep aliasing `vectra → standard`). Update JSDoc.

### 1.3 Modify `index.js` (defaultSettings)
Remove these keys:
- `milvus_host`, `milvus_port`, `milvus_username`, `milvus_password`, `milvus_token`, `milvus_address`

Update `vector_backend` default comment to mention only `standard | qdrant`.

### 1.4 Modify `ui/ui-manager.js`
- Remove `<option value="lancedb">` and `<option value="milvus">` from `#vecthare_vector_backend`
- Delete the entire `<div id="vecthare_milvus_settings">...</div>` block (~50 lines)
- Remove all `#vecthare_milvus_*` input event handlers
- Remove the dropdown change handler that shows/hides `#vecthare_milvus_settings`

### 1.5 Modify `ui/database-browser.js`
Remove `lancedb: "LanceDB"` from the backend label map.

### 1.6 Modify `core/collection-ids.js`
Update `knownBackends` array → `['standard', 'vectra', 'qdrant']`.

### 1.7 Delete tests
- Remove `LanceDBBackend` and `MilvusBackend` describe blocks from `tests/backends.test.js`
- Remove `lancedb`/`milvus` references from `tests/backend-manager.test.js`

### 1.8 Update `README.md` and `BM25_INTEGRATION.md`
Strip mentions of LanceDB and Milvus from the backend table, capabilities section, and prerequisites. Most of this disappears in Phase 3 anyway when BM25 is deleted.

### 1.9 Verify Phase 1
```
npm test
```
All non-deleted tests must pass. Manual smoke test: load extension, confirm backend dropdown shows only Standard + Qdrant.

---

## Phase 2: Delete Pure-Legacy Modules

These modules have no EventBase usage. Delete in dependency order (leaves first) so import errors surface predictably.

### 2.1 Files to DELETE entirely (under `core/`)
1. `chunking.js`
2. `chunk-groups.js`
3. `bm25-scorer.js`
4. `keyword-boost.js`
5. `keyword-learner.js`
6. `hybrid-search.js`
7. `temporal-decay.js`
8. `scenes.js`
9. `conditional-activation.js`
10. `summarizer.js`
11. `content-vectorization.js`
12. `collection-export.js`
13. `world-info-integration.js`
14. `emotion-classifier.js`
15. `png-export.js`

### 2.2 UI files to DELETE
- `ui/chunk-visualizer.js` (if exists)
- `ui/scene-markers.js` (if exists)
- `ui/text-cleaning-manager.js` (if exists — verify no EventBase dependency first)

### 2.3 Tests to DELETE (under `tests/`)
- `bm25-scorer.test.js`
- `keyword-boost.test.js`
- `keyword-comparison.test.js`
- `temporal-decay.test.js`
- `hybrid-search.test.js`
- `world-info-integration.test.js`
- Any test files matching deleted modules above

### 2.4 Risk: `core/text-cleaning.js`
Check if `eventbase-extractor.js` or any other `eventbase-*.js` imports it. If NO → DELETE. If YES → KEEP and skip.

### 2.5 Verify Phase 2
After deletion, `npm test` will fail with import errors. That's expected. **Do not fix import errors yet** — Phase 3 strips the importers.

---

## Phase 3: Strip `chat-vectorization.js` to Routers Only

This is the biggest surgical edit. The current file is ~2400 LOC; target is ~100 LOC.

### 3.1 What to KEEP
- `synchronizeChat()` — but strip out all chunking strategy branches; only the `if (settings.eventbase_enabled)` branch remains, calling `runEventBaseIngestion`
- `rearrangeChat()` — but strip out the legacy 8-stage pipeline; only the EventBase early-return branch remains, calling `runEventBaseRetrieval`
- `buildSearchQuery(chat, settings)` — used by EventBase
- `getChatCollectionId()` and any minimal collection ID helpers needed by EventBase routing
- All exports actually consumed by `index.js` or EventBase modules

### 3.2 What to DELETE (functions, not just dead code)
- `gatherCollectionsToQuery()`
- `queryAndMergeCollections()`
- `expandSummaryChunks()`
- `applyThresholdFilter()`
- `applyTemporalDecayStage()`
- `applyConditionsStage()`
- `applyGroupsAndLinksStage()`
- `deduplicateChunks()` (legacy chunk version — EventBase has its own)
- `injectChunksIntoPrompt()`
- `buildNestedInjectionText()`
- `resolveChunkInjectionPosition()`
- `applyChunkConditions()`
- `trackChunkActivation()`
- `rerankWithBananaBread()`
- `vectorizeAll()`
- `purgeChatIndex()` — UNLESS exported and called by EventBase Action tab; if so, simplify it to purge EventBase collections only

### 3.3 Imports cleanup
Strip imports from deleted modules. The remaining imports should be roughly:
- `getContext`, `eventSource`, `setExtensionPrompt`, `extension_prompts`, `chat`, `substituteParams` — from ST core
- `getChatUUID`, `buildEventBaseCollectionId` — from `collection-ids.js`
- Whatever `runEventBaseIngestion`, `runEventBaseRetrieval` need (dynamic import — already in place)

### 3.4 Strip `index.js` imports
Remove imports of deleted modules. Specifically:
- `getDefaultDecaySettings` from `temporal-decay.js`
- `migrateOldEnabledKeys` from `collection-metadata.js` — only if it's a legacy migration; verify
- `ensureJiebaTokenizerLoaded`, `ensureJiebaTwLoaded`, `CJK_TOKENIZER_MODES` from `bm25-scorer.js`
- `DEFAULT_SUMMARIZE_PROMPT` from `summarizer.js`
- `initializeVisualizer`, `initializeSceneMarkers` from UI modules

### 3.5 Strip `core/core-vector-api.js`
- Remove BM25-related code paths and the `bm25-scorer.js` import
- Remove `hybridSearch` import and the `if (settings.hybrid_search_enabled)` branch in `queryCollection`
- The `scoreResults` keyword-boost call → remove (use plain rawResults). `eventbase-store.js` calls `queryCollection`, so make sure the function still returns `{ hashes, metadata }` shape.

### 3.6 Audit `core/collection-metadata.js`
Read every exported function. Keep only those called by EventBase modules or by the surviving `chat-vectorization.js` / `index.js` / UI files. Delete the rest. If unsure, KEEP — this module is a lower-priority cleanup target.

### 3.7 Verify Phase 3
- `npm test` — all surviving tests must pass
- Smoke test: enable EventBase in UI, run a chat generation, confirm event extraction + retrieval still work end-to-end (look for `[EventBase] Injected N event(s)` in console)

---

## Phase 4: UI Tab Cleanup

After Phase 3, the UI references many settings whose code is gone. Now strip the UI to match.

### 4.1 Tab verdicts

| Tab | Verdict | Action |
|---|---|---|
| Core | **KEEP, slim** | Strip BM25/hybrid/CJK/stopwords/score threshold/insert batch size sections |
| Weight | **DELETE entire tab** | All settings (decay, keyword boost weights) are legacy |
| RAG | **KEEP as-is** | `rag_context` + `rag_xml_tag` are used by EventBase |
| WorldInfo | **DELETE entire tab** | EventBase does not activate WI |
| AutoSync | **KEEP, simplify** | Keep "Enable Auto-Sync" toggle + min chat length. Delete chunking strategy / batch size / group batch size selectors. Add note: "Auto-sync triggers EventBase ingestion on new messages." |
| Summarize | **DELETE entire tab** | EventBase has its own extraction prompt |
| Action | **KEEP as-is** | Buttons (Vectorize, Sync, DB Browser, Diagnostics, Purge) — verify each routes only to EventBase or shared code |
| EventBase | **KEEP as-is** | This is the new home |

### 4.2 Settings keys to DELETE from `index.js` defaultSettings
```
enabled_chats, chunking_strategy, batch_size, group_batch_size,
top_k, score_threshold,
keyword_extraction_level, keyword_scoring_method, keyword_boost_base_weight,
bm25_k1, bm25_b, bm25_*,
hybrid_search_enabled, hybrid_*,
cjk_tokenizer_mode, custom_stopwords,
temporal_decay, default_decay_*, default_decay_enabled, default_decay_type,
summarize_*, DEFAULT_SUMMARIZE_PROMPT references,
enabled_world_info, world_info_*, world_info_query_depth,
bananabread_*,
insert_batch_size,
collections, vecthare_collection_registry  (verify — may be used for collection persistence; if so KEEP)
```

### 4.3 Settings keys to KEEP
Shared by both or used by EventBase / Action UI:
```
position, depth                         (injection placement — EventBase uses)
rag_context, rag_xml_tag               (wrapping/context — EventBase uses)
query                                   (search query depth — buildSearchQuery uses)
deduplication_depth                    (EventBase retrieval uses — DO NOT REMOVE)
retrieval_popup_on_start, retrieval_popup_on_result   (EventBase shows popups)
min_chat_length                        (gating)
vector_backend, source                 (backend + embedding provider)
all eventbase_*  keys                  (everything)
provider-specific embedding settings   (openai_*, koboldcpp_*, webllm_*, etc.)
```

### 4.4 Action tab buttons audit
For each button in the Action tab, verify the handler:
- **Vectorize Content** — if it routes to legacy `content-vectorization.js`, decide: delete the button OR rewire to EventBase ingestion. Recommend: **delete the button** since content vectorization (lorebooks/character cards) was a legacy-chunking feature.
- **Sync Chat** — should route to `synchronizeChat()` which now only does EventBase. Keep.
- **Database Browser** — must still display EventBase collections. Verify `ui/database-browser.js` works with EventBase collection IDs.
- **Diagnostics** — review `diagnostics/` folder. Likely needs trimming (remove BM25/keyword/hybrid tests). Optional — keep for Phase 5.
- **Debug Query** — verify it works with EventBase retrieval pipeline.
- **Purge** — must wipe EventBase collections (and legacy ones if any remain from before cleanup).

### 4.5 Verify Phase 4
- Reload extension in SillyTavern
- Open settings: confirm only Core, RAG, AutoSync, Action, EventBase tabs visible
- Test full flow: enable EventBase → vectorize → trigger generation → verify events injected

---

## Phase 5: Diagnostics & Misc Cleanup (optional)

### 5.1 Review `diagnostics/`
- `activation-tests.js`, `production-tests.js`, `visualizer-tests.js` — likely all legacy. Delete if so.
- `infrastructure.js`, `configuration.js`, `index.js` — check; keep only EventBase-relevant tests.

### 5.2 Review `core/vendor/` (under `core/`)
Investigate what's there — may be Jieba / NLP libs only used by deleted BM25 module. Delete if unused.

### 5.3 Update `package.json`
Remove dev dependencies only used by deleted modules (e.g., BM25 / Langchain / Jieba). Run `npm install` to regenerate lockfile.

### 5.4 Update `manifest.json`
Verify no references to deleted UI files in script load order.

### 5.5 Documentation
- `README.md` — rewrite around EventBase as the sole feature
- `BM25_INTEGRATION.md` — DELETE (BM25 is gone)
- `bm25-test.js` — DELETE
- `plans/keyword-comparison-plan.md` — DELETE (legacy planning doc)

---

## Risk Areas (read carefully)

1. **`core/text-cleaning.js`** — KEEP unless verified no EventBase consumer. Safe default: keep.

2. **`core/collection-metadata.js`** — DO NOT DELETE the file. Audit and trim function-by-function. EventBase needs at least: per-collection enable flags, locking primitives.

3. **`core/core-vector-api.js`** — Both paths use this. Surgical edits only — keep `queryCollection`, `insertVectorItems`, `deleteVectorItems`, `getAdditionalArgs`. Remove BM25 + hybrid branches. Keep `scoreResults` only if it's a no-op pass-through after removing keyword boost; otherwise delete the call site in `queryCollection` and let raw results flow through.

4. **`deduplication_depth`** setting — used by EventBase retrieval. KEEP.

5. **`buildSearchQuery`** — used by EventBase. KEEP in `chat-vectorization.js`.

6. **EventBase retrieval imports `queryEvents` → `queryCollection` → backend** — confirm chain stays intact after Phase 3.5.

7. **`collections` / `vecthare_collection_registry` settings** — these may persist EventBase collection IDs across reloads. Verify before removing. Look at `collection-loader.js` for usage.

---

## Relevant Files (full paths)

### Definitely modify
- `h:\Github\Dev\VectHare\index.js`
- `h:\Github\Dev\VectHare\core\chat-vectorization.js`
- `h:\Github\Dev\VectHare\core\core-vector-api.js`
- `h:\Github\Dev\VectHare\core\collection-metadata.js`
- `h:\Github\Dev\VectHare\core\collection-ids.js`
- `h:\Github\Dev\VectHare\backends\backend-manager.js`
- `h:\Github\Dev\VectHare\ui\ui-manager.js`
- `h:\Github\Dev\VectHare\ui\database-browser.js`
- `h:\Github\Dev\VectHare\manifest.json`
- `h:\Github\Dev\VectHare\package.json`
- `h:\Github\Dev\VectHare\README.md`

### Definitely keep (do not touch unless instructed)
- All `h:\Github\Dev\VectHare\core\eventbase-*.js`
- `h:\Github\Dev\VectHare\backends\standard.js`
- `h:\Github\Dev\VectHare\backends\qdrant.js`
- `h:\Github\Dev\VectHare\backends\backend-interface.js`
- `h:\Github\Dev\VectHare\core\providers.js`
- `h:\Github\Dev\VectHare\core\collection-loader.js`
- `h:\Github\Dev\VectHare\core\constants.js`

---

## Verification (after all phases)

1. `npm test` passes (only EventBase + backend + utility tests remain)
2. Extension loads without console errors in SillyTavern
3. UI shows only: Core, RAG, AutoSync, Action, EventBase tabs
4. Backend dropdown shows only: Standard, Qdrant
5. Enable EventBase → backfill chat → see Qdrant collection `vecthare_eventbase_*` populated
6. Trigger AI generation → see `[EventBase] Injected N event(s)` in console
7. Open Database Browser → EventBase collection visible with stored events
8. Purge button works for EventBase collections
9. No stale settings persist in `extension_settings.vecthareplus` (cleanup script optional)

---

## Decisions

- **AutoSync tab**: KEEP simplified (not deleted) because EventBase ingestion still benefits from auto-trigger on message events.
- **Action tab "Vectorize Content" button**: DELETE — content vectorization was a legacy-only feature.
- **Diagnostics**: optional cleanup in Phase 5 — non-blocking for the main goal.
- **`vector_backend` setting**: KEEP. Default to `qdrant`. Standard remains as fallback.
- **`vectra` alias**: KEEP as alias to `standard`.
- **`deduplication_depth`**: KEEP — shared between paths.

---

## Further Considerations

1. **Should EventBase ingestion auto-register on chat changes?** Currently the workflow runs when triggered. Worker should verify the auto-sync wiring still calls EventBase after chunking strategy selectors are removed.

2. **Existing legacy collections in user Qdrant** — the user has `vecthare_chat_*` collections from prior usage. After cleanup, those collections become unreachable from UI. Recommend: leave them alone (user can manually delete via Qdrant dashboard) OR add a one-shot migration that prompts to delete on first launch. Default in this plan: **leave them alone**, document in README.

3. **Settings migration** — old users have stale legacy settings in `extension_settings.vecthareplus`. The settings-load logic in `index.js` typically merges with `defaultSettings`, so stale keys persist but are unread. Optional cleanup: prune unknown keys on load. Default in this plan: **leave them**, harmless.
