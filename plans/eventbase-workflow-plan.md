## Plan: EventBase Tab And Workflow Gate

Add a new EventBase tab with one checkbox that enables a completely separate workflow path for both ingestion and retrieval. Keep existing workflow untouched unless `eventbase_enabled` is true. For this phase, implement UI + settings persistence + explicit branch skeleton only, and fail hard if EventBase is enabled but path is not implemented/ready.

**Steps**
1. Define EventBase setting surface (blocking)
1. Add `eventbase_enabled: false` to defaults in `h:/Github/Dev/VectHare/index.js`.
2. Keep scope minimal: one boolean only (no extra EventBase config fields yet).
3. Ensure setting is merged through existing settings bootstrap (`defaultSettings + extension_settings.vecthareplus`) without affecting existing keys.

2. Add EventBase tab UI (depends on 1)
1. In `h:/Github/Dev/VectHare/ui/ui-manager.js`, add a new tab button `data-tab="eventbase"` alongside existing tabs.
2. Add a new tab card panel `data-vecthare-tab="eventbase"` using existing card structure/classes (header, subtitle, body).
3. Add one checkbox control in this tab:
4. Input id: `vecthare_eventbase_enabled`.
5. Label: clear language indicating this switches to a separate EventBase workflow.
6. Add a warning hint that EventBase mode currently uses a separate experimental path and may fail hard.

3. Wire settings persistence and runtime flag (depends on 1,2)
1. In `bindSettingsEvents` in `h:/Github/Dev/VectHare/ui/ui-manager.js`, bind `#vecthare_eventbase_enabled` with `.prop('checked', settings.eventbase_enabled || false)` and `.on('change', ...)`.
2. Persist via `Object.assign(extension_settings.vecthareplus, settings)` + `saveSettingsDebounced()` following existing checkbox pattern.
3. Add concise debug log when toggled to make branch behavior observable.

4. Add ingestion branch skeleton (depends on 3)
1. Locate ingestion orchestrator entry used by chat/content vectorization in `h:/Github/Dev/VectHare/core/chat-vectorization.js` and `h:/Github/Dev/VectHare/core/content-vectorization.js`.
2. Add early branch: if `settings.eventbase_enabled`, route to new EventBase ingestion function(s) in a dedicated module (e.g., `h:/Github/Dev/VectHare/core/eventbase-workflow.js`).
3. In skeleton phase, EventBase ingestion function should explicitly throw a descriptive error (fail hard by design) indicating EventBase path not yet implemented.
4. Do not alter existing ingestion logic in else path.

5. Add retrieval branch skeleton (depends on 3)
1. In `h:/Github/Dev/VectHare/core/core-vector-api.js` at the query orchestration branch point, add EventBase check before hybrid/standard path.
2. Route to dedicated EventBase retrieval function in `h:/Github/Dev/VectHare/core/eventbase-workflow.js`.
3. Skeleton retrieval function throws a descriptive error when EventBase mode is enabled (fail hard requirement).
4. Leave hybrid/standard retrieval untouched when EventBase is disabled.

6. Isolate new path and keep compatibility (parallel with 4 and 5, blocks release)
1. Keep EventBase code in a dedicated module so future implementation replaces internals without touching legacy path.
2. Ensure no side effects in legacy collections, chunking strategy behavior, summarization behavior, or BM25 flow when `eventbase_enabled` is false.
3. Ensure all new error messages are actionable and clearly mention how to disable EventBase to recover.

7. Verification and safety checks (depends on 2-6)
1. Static verification:
2. No tab regression: existing tabs still switch correctly.
3. EventBase tab renders and checkbox state persists across reload.
4. Runtime verification:
5. With EventBase off: ingestion and retrieval behave exactly as before.
6. With EventBase on: ingestion/retrieval hit EventBase branch and fail hard with expected descriptive error.
7. No silent fallback to legacy path when EventBase is on.
8. Run project checks/tests (`npm run check` and relevant tests) and fix any lint/type issues from added wiring.

**Relevant files**
- `h:/Github/Dev/VectHare/index.js` — add `eventbase_enabled` default.
- `h:/Github/Dev/VectHare/ui/ui-manager.js` — add EventBase tab button/card and checkbox event binding.
- `h:/Github/Dev/VectHare/core/core-vector-api.js` — add retrieval branch gate for EventBase.
- `h:/Github/Dev/VectHare/core/chat-vectorization.js` — add ingestion branch gate in chat pipeline entry.
- `h:/Github/Dev/VectHare/core/content-vectorization.js` — add ingestion branch gate for content vectorization orchestration.
- `h:/Github/Dev/VectHare/core/eventbase-workflow.js` — new isolated EventBase skeleton module (throwing stubs for ingestion/retrieval).

**Verification**
1. Start extension UI and confirm new EventBase tab appears and switches correctly.
2. Toggle EventBase checkbox, reload UI, verify persisted state.
3. Run one normal vectorization + retrieval with EventBase disabled and compare behavior to current baseline.
4. Enable EventBase and trigger vectorization: verify explicit EventBase-not-implemented hard failure.
5. Enable EventBase and trigger retrieval path: verify explicit EventBase-not-implemented hard failure.
6. Run `npm run check` in `h:/Github/Dev/VectHare`.

**Decisions**
- Included: new EventBase tab, one checkbox, full wiring, and branch skeleton for both ingestion/retrieval.
- Included: fail hard behavior when EventBase is enabled and EventBase path is not implemented.
- Excluded: full EventBase extraction/storage/retrieval implementation (JSON event extraction, dual collections, reranker).
- Excluded: removing existing workflow in this phase.

**Further Considerations**
1. Branch granularity: keep separate function exports for `runEventBaseIngestion` and `runEventBaseRetrieval` so next phase can be implemented independently.
2. Error UX: consider a user-facing toast/dialog in addition to thrown errors so users understand why requests stopped.
3. Future cutover: after EventBase is validated, migrate default to EventBase and then remove legacy path in a dedicated cleanup PR.