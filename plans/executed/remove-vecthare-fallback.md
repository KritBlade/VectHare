# Plan: Remove All VectHare Fallback + Rename On-Disk Literals

**TL;DR:** Eliminate every `VectHare`, `vecthare`, `VectHarePlus`, `vecthareplus`, `vh_` reference from the codebase. Rename on-disk Qdrant literals (`_vecthare_meta`, `_vecthare_sentinel`, `vecthare_main`) to their `vectfox` / `_vectfox_meta` equivalents. Replace the existing "Migrate Collections" button with a single one-shot **"Upgrade to VectFox v2"** button that rewrites the on-disk literals. After this PR, the codebase has zero VectHare strings.

Related: [plans/executed/vectfox-rename-plan.md](executed/vectfox-rename-plan.md) — the prior rename pass that intentionally **kept** these literals for compatibility. This plan finishes that work.

## Guiding principle — NO FALLBACK

**Fallback code makes troubleshooting harder and is fragile.** Every conditional like `if (legacy) ... else (new) ...` is a place where bugs hide and behavior diverges silently between users. This plan deliberately rejects safety nets and dual-path code:

- No "exclude both old and new sentinel types" filters.
- No "read legacy literal if new is absent" routes.
- No globally-visible `LEGACY_*` constants that linger after the upgrade.
- No silent migration on first read.

Instead: **detect → warn loudly → upgrade → run.** Per D1, if the user has un-upgraded data, queries proceed normally but log a prominent warning. The code only knows the new literals — no silent dual-filter, no auto-recovery.

The only "legacy awareness" lives **inside the upgrade route**, scoped to local variables in that one function. Once the upgrade runs and the flag is set, that function never runs again. Deleting it in a follow-up PR (say, 3 versions later) is a one-line change.

---

## Decisions (resolved by user — 2026-05-14)

**Context:** Extension is pre-release. User is the only operator with one (1) collection. No backwards-compat constraints, no other users to break, no version negotiation needed. Failures should be loud so the user can debug.

| ID | Decision | Resolution |
|---|---|---|
| D1 | Un-upgraded data detection | **Loud warning.** Queries proceed normally. When a legacy sentinel is detected (in query results or scroll), log a prominent `[VectFox] LEGACY DATA DETECTED — run upgrade` warning. No silent dual-filter, no blocking modal, no auto-recovery. |
| D2 | Legacy literals scope | **Function-local only.** No module-level `LEGACY_*` constants. The strings `_vecthare_meta`, `_vecthare_sentinel`, `vecthare_main` appear ONLY inside the upgrade route's function body. |
| D3 | Lifecycle of upgrade route | **Ship in-plugin now, delete in a follow-up PR.** Code must be written for easy deletion: one self-contained route handler with all legacy strings function-local, one self-contained button, one settings flag. Follow-up PR is a single revert-style commit. See §4.3 isolation rules. |
| D4 | Delete `migrateVectHarePlusToVectFox()` + defineProperty trap | **Delete both.** No usage to preserve. |
| D5 | Cross-repo version mismatch | **Big warning, loud failure.** Add a startup version check in VectFox that pings similharity for a `pluginVersion` and logs a prominent banner if mismatched. Don't refuse — just shout. |
| D6 | Collection has BOTH old + new sentinels | **Big warning, refuse to auto-resolve.** Upgrade route prints a loud error with the collection name and exits without touching that collection. User resolves manually (probably by deleting one sentinel via Qdrant API). |
| D7 | README translation files (JP/KR/ZH) | **Skip.** Don't touch READMEs in this PR. |
| D8 | "===== LEGACY VECTHARE FEATURES =====" block | **Audited (see below). Code is live; only the comment label needs updating.** Action: rename comment label, leave code alone. |

### D8 — Audit result for the LEGACY VECTHARE FEATURES block

**File:** [similharity/qdrant-backend.js:562-575](../../similharity/qdrant-backend.js#L562-L575)

**What it does:** Sets 8 payload fields with a fallback chain (top-level `item.X` OR `item.metadata.X`).

**Per-field status (audited after user feedback that chunkGroup was removed):**

| Field | Status | Notes |
|---|---|---|
| `importance` | LIVE | Set by every event/chunk pipeline |
| `keywords` | LIVE | Extracted by event/chunk pipelines |
| `customWeights` | DEAD (likely) | No producer code found in VectFox; only consumer is this line. Verify before removing. |
| `disabledKeywords` | DEAD (likely) | Same as above |
| `chunkGroup` | **DEAD** | User confirmed: removed when `message_group_batch` strategy was deleted ([plans/executed/remove-message-group-batch.md](executed/remove-message-group-batch.md)). Leftover references still exist at: [backends/qdrant.js:330](../backends/qdrant.js#L330), [backends/standard.js:251](../backends/standard.js#L251), [core/collection-export.js:134,280](../core/collection-export.js#L134), [core/eventbase-store.js:88](../core/eventbase-store.js#L88), and similharity ([qdrant-backend.js:572,675-678,734](../../similharity/qdrant-backend.js#L572)) |
| `conditions` | LIVE | Chunk activation rules (see [ui/chunk-visualizer.js:121](../ui/chunk-visualizer.js#L121), [diagnostics/activation-tests.js](../diagnostics/activation-tests.js#L131)) |
| `isSummaryChunk` | LIVE | Summary-parent linking in [core/chat-vectorization.js:809](../core/chat-vectorization.js#L809) |
| `parentHash` | LIVE | Summary-parent linking, same path |

**Action for AI worker:**

1. Rename the comment header at line 562:
   - Before: `// ===== LEGACY VECTHARE FEATURES =====`
   - After: `// ===== LEGACY FIELDS =====`
2. Update the comment block at lines 563-567 to drop "VectHare":
   > `// Fall back to item.metadata.* when the top-level field is undefined.`
   > `// EventBase items store these inside metadata; older chunk items set them`
   > `// at the top level. Both shapes coexist.`
3. **Do NOT** remove dead fields (`chunkGroup`, `customWeights`, `disabledKeywords`) in this PR. The user wants that flagged for a separate cleanup PR — see the callout below.

**User decision (2026-05-14):** Bundle dead-field removal into this PR. See §11 below.

### Plan simplifications from user context

Because the project hasn't gone live and the user has ONE collection:
- **No transitional warnings needed for "other users."** No first-launch modal, no toast warnings for late-clicking users. Just one upgrade run, then never again.
- **No idempotency / partial-failure recovery.** If the upgrade script fails mid-way, the user can manually rerun or fix in Qdrant directly.
- **No dry-run mode needed.** User runs it once, verifies it worked by manually inspecting the one collection.
- **No version check between similharity and VectFox needed for end users** — but per D5 still add a loud startup warning to help future debugging.

---

## 0. Outcome

After landing:
- Grep across the whole repo for any of `vecthare|VectHare|VectHarePlus|vecthareplus|vh_` (case-insensitive) returns **zero hits** outside `plans/executed/` and `README_*.md` historical changelog sections.
- The Action tab has **one new button** "Upgrade to VectFox v2" (replaces the old "Migrate Collections" button). User clicks it once → sentinel points and multitenancy collection are rewritten on disk → flag is saved → button hides itself.
- `core/collection-migrator.js` is **deleted**.
- The `migrateVectHarePlusToVectFox()` settings-migration function in `index.js` is **deleted** along with the `extension_settings.vecthare` defineProperty trap.
- Tests, docs, and CSS use only `vectfox` / `vf_` identifiers.

---

## 1. Scope decision (already made by user)

> **"REname everything, I just need 1 button in action tab to migrate current collection. I only have 1 collection, it's easy to do."**

Implication: this plan covers code AND on-disk Qdrant data. No backwards-compat path. The upgrade button is single-purpose: rewrite sentinels + rename multitenancy collection, then never run again.

---

## 2. Repo-level prerequisite: cross-repo ordering

Two repos must change together:
- **`h:\Github\Dev\similharity`** (the SillyTavern server plugin) — owns the Qdrant constants and sentinel exclusion filters.
- **`h:\Github\Dev\VectFox`** (the extension) — owns the UI, settings, and collection routing.

**Critical ordering:** the similharity plugin must be the one that **writes** the new literals. If VectFox ships first and similharity still writes `_vecthare_meta`, sentinels won't be excluded after the new code lands.

**Safe land order:** single-PR per repo, but **install order matters**:
1. Pull similharity plugin (server-side).
2. Restart SillyTavern (so the plugin reloads).
3. Pull VectFox extension.
4. Reload SillyTavern UI.
5. Click "Upgrade to VectFox v2" in Action tab.

Document this in the PR description. Per the "Plan simplifications" section, no first-launch toast/modal — the upgrade button is self-explanatory.

---

## 3. The five name patterns + how each is handled

| Pattern | Where | Action |
|---|---|---|
| `vecthare_chat_*`, `vecthare_lorebook_*`, `vecthare_character_*`, `vecthare_document_*`, `vecthare_eventbase_*`, `vecthare_archiveevent_*` | Collection-ID prefixes in code | Delete `VECTHARE_*` constants and fallback parse branches in `core/collection-ids.js`. Code only knows `vf_*` after this. |
| `vecthare_main` | Qdrant collection name (multitenancy backplane) | Upgrade button clones to `vectfox_main` and deletes old. Constant in code becomes `'vectfox_main'`. |
| `_vecthare_meta`, `_vecthare_sentinel` | Payload `type` value + boolean key on sentinel points | Upgrade button rewrites each collection's sentinel point. Constants in code become `'_vectfox_meta'` / `'_vectfox_sentinel'`. |
| `VectHare`, `VectHarePlus`, `vecthareplus` | JS variables, log strings, toast titles, UI element IDs, CSS classes, comments | Plain find-replace to `VectFox`. CSS/HTML id renames done atomically (id in HTML + querySelector in JS). |
| `vh_` | Search target found **0 hits** in current scan (no `vh_` exists today). | No action needed; just verify with final grep. |

---

## 4. similharity changes (do these FIRST)

### 4.1 New constants at top of `qdrant-backend.js`

Replace the scattered string literals with named constants. **Only the new VectFox literals live at module scope.** Per D2, legacy strings are function-local inside the upgrade route — not module constants.

```js
// Qdrant on-disk constants. NEVER change these without an upgrade routine —
// they live inside user Qdrant databases.
const SENTINEL_POINT_TYPE = '_vectfox_meta';
const SENTINEL_FLAG_KEY = '_vectfox_sentinel';
const MULTITENANCY_COLLECTION = 'vectfox_main';
```

⚠️ **Do NOT** add module-level `LEGACY_*` constants. Doing so creates a permanent legacy surface that contradicts the no-fallback principle. The upgrade route handles legacy literals as scoped strings inside its own function (see §4.3).

### 4.2 Replace every literal use

Lines in `similharity/qdrant-backend.js` to update (current line numbers — verify before editing):

| Line | Current | New |
|---|---|---|
| 11 (comment) | `"vecthare_multitenancy"` | `"${MULTITENANCY_COLLECTION}"` (just update the comment text) |
| 39, 41 | `MULTITENANCY_COLLECTION = 'vecthare_main'` | use the new constant |
| 207, 227-228 | Legacy `vecthare` prefix parsing in `_parseCollectionName` | **DELETE** the entire legacy branch — `vf_*` only |
| 248-249 | `ensurePayloadIndexes('vecthare_main')` | use `MULTITENANCY_COLLECTION` |
| 361, 368, 392, 395 (comments/JSDoc) | "VectHare sentinel/metadata" | "VectFox sentinel/metadata" |
| 405-406 | `type: '_vecthare_meta'`, `_vecthare_sentinel: true` | use the new constants |
| 447, 459, 562, 610, 720, 738, 895, 986, 994, 1021, 1024, 1064, 1132, 1157, 1174, 1228, 1232, 1269 | comments + `must_not: [{ key: 'type', match: { value: '_vecthare_meta' } }]` filters | use `SENTINEL_POINT_TYPE` constant. ALL `must_not` sentinel exclusions point at the new constant. |

Special handling:
- The hardcoded `purgeAll(collectionName = 'vecthare_main')` default parameter at line 1232 — change to `MULTITENANCY_COLLECTION`.
- The "===== LEGACY VECTHARE FEATURES =====" comment block around line 562 — read the surrounding code carefully. If it's dead code, delete the whole block. If it's still wired, rename to "===== LEGACY FEATURES =====" (no "VectHare").

### 4.3 New route: `POST /chunks/upgrade-vectfox-v2`

In `similharity/index.js`. Single endpoint that performs the v2 migration. Legacy literals are **function-local strings** — they don't escape this handler.

**Isolation rules** (per D3 — must be trivial to delete in a follow-up PR):

1. **Single contiguous block.** All route code lives in one place — no helpers extracted into other files.
2. **All legacy strings function-local.** No module-level constants, no imports of legacy names.
3. **Bracketed by delete markers.** Wrap the entire route block with:
   ```js
   // ──── DELETE-IN-FOLLOWUP: VectFox v2 one-shot upgrade route ────
   // After confirming the single existing collection has been upgraded,
   // this entire block (down to the matching END marker) can be removed
   // in a single revert-style commit. No external code references it.
   router.post('/chunks/upgrade-vectfox-v2', async (req, res) => { ... });
   // ──── END DELETE-IN-FOLLOWUP ────
   ```
4. **VectFox-side button + handler use the same markers.** The button HTML, the click handler, and the `vectfox_v2_upgrade_done` settings flag all carry the `// DELETE-IN-FOLLOWUP:` marker so a grep for that marker shows every line to remove.
5. **No utility methods on `qdrantBackend`.** If the route needs `_scrollByPayloadFilter`, `_upsertPoint`, `_copyCollection`, write them **inline inside the route handler** as local functions, not as class methods. This keeps the deletion atomic.

```js
// ──── DELETE-IN-FOLLOWUP: VectFox v2 one-shot upgrade route ────
// All state scoped to this block; helpers are local fns.
// Follow-up PR: delete from this marker to the END marker. No external refs.
router.post('/chunks/upgrade-vectfox-v2', async (req, res) => {
    // Function-local legacy strings — no module-level legacy constants.
    const LEGACY_SENTINEL_TYPE = '_vecthare_meta';
    const LEGACY_SENTINEL_FLAG = '_vecthare_sentinel';
    const LEGACY_MT_COLLECTION = 'vecthare_main';

    // Helpers — local, NOT class methods (so they disappear with the route).
    const scrollByPayloadFilter = async (collection, filter) => {
        const out = [];
        let offset = null;
        do {
            const body = { filter, limit: 256, with_payload: true, with_vector: true };
            if (offset !== null) body.offset = offset;
            const resp = await qdrantBackend._request('POST', `/collections/${collection}/points/scroll`, body);
            out.push(...(resp?.result?.points || []));
            offset = resp?.result?.next_page_offset ?? null;
        } while (offset !== null);
        return out;
    };
    const upsertPoint = (collection, id, vector, payload) =>
        qdrantBackend._request('PUT', `/collections/${collection}/points?wait=true`, {
            points: [{ id, vector, payload }],
        });
    const copyCollection = async (src, dst) => {
        const srcInfo = await qdrantBackend._request('GET', `/collections/${src}`);
        // Create dst mirroring src's vector/sparse config. The exact shape of
        // `srcInfo.result.config.params` is what `PUT /collections/{dst}` expects.
        await qdrantBackend._request('PUT', `/collections/${dst}`, srcInfo.result.config.params);
        const points = await scrollByPayloadFilter(src, { must: [] });
        let copied = 0;
        for (const pt of points) {
            await upsertPoint(dst, pt.id, pt.vector, pt.payload);
            copied++;
        }
        return copied;
    };

    try {
        const report = { sentinelRewrites: [], multitenancyRename: null, errors: [] };

        // Step 1 — per-collection sentinel rewrite
        const collections = await qdrantBackend.getCollections();
        for (const colName of collections) {
            if (colName === LEGACY_MT_COLLECTION) continue;
            try {
                const legacyPoints = await scrollByPayloadFilter(
                    colName,
                    { must: [{ key: 'type', match: { value: LEGACY_SENTINEL_TYPE } }] }
                );
                if (legacyPoints.length === 0) {
                    report.sentinelRewrites.push({ collection: colName, hadLegacy: false, rewroteCount: 0 });
                    continue;
                }
                // D6: detect & refuse if both old + new sentinels coexist in same collection.
                const newPoints = await scrollByPayloadFilter(
                    colName,
                    { must: [{ key: 'type', match: { value: SENTINEL_POINT_TYPE } }] }
                );
                if (newPoints.length > 0) {
                    report.errors.push({
                        collection: colName, phase: 'sentinel',
                        error: `Collection has BOTH '${LEGACY_SENTINEL_TYPE}' and '${SENTINEL_POINT_TYPE}' sentinels — refusing to auto-resolve. Delete one manually (see D6 in plan).`,
                    });
                    continue;
                }
                for (const pt of legacyPoints) {
                    const newPayload = { ...pt.payload };
                    delete newPayload[LEGACY_SENTINEL_FLAG];
                    newPayload.type = SENTINEL_POINT_TYPE;
                    newPayload[SENTINEL_FLAG_KEY] = true;
                    await upsertPoint(colName, pt.id, pt.vector, newPayload);
                }
                report.sentinelRewrites.push({
                    collection: colName, hadLegacy: true, rewroteCount: legacyPoints.length,
                });
            } catch (err) {
                report.errors.push({ collection: colName, phase: 'sentinel', error: err.message });
            }
        }

        // Step 2 — multitenancy collection rename (clone + delete; Qdrant has no rename op)
        const hasLegacyMT = collections.includes(LEGACY_MT_COLLECTION);
        const hasNewMT = collections.includes(MULTITENANCY_COLLECTION);
        if (hasLegacyMT && hasNewMT) {
            // D6 — surface to user, do not auto-resolve.
            report.errors.push({
                phase: 'multitenancy',
                error: `Both '${LEGACY_MT_COLLECTION}' and '${MULTITENANCY_COLLECTION}' exist — refusing to auto-resolve. See D6 in plan.`,
            });
        } else if (hasLegacyMT) {
            const pointCount = await copyCollection(LEGACY_MT_COLLECTION, MULTITENANCY_COLLECTION);
            await qdrantBackend._request('DELETE', `/collections/${LEGACY_MT_COLLECTION}`);
            report.multitenancyRename = {
                from: LEGACY_MT_COLLECTION, to: MULTITENANCY_COLLECTION, pointCount, success: true,
            };
        }

        res.json({ success: report.errors.length === 0, report });
    } catch (error) {
        console.error('[similharity] upgrade-vectfox-v2 error:', error);
        res.status(500).json({ error: error.message });
    }
});
// ──── END DELETE-IN-FOLLOWUP ────
```

**Removed `dryRun` mode** — per "Plan simplifications" section, user runs once on one collection and inspects manually. Dry-run adds complexity for no benefit.

**Helper functions — INLINE inside the route handler** (per isolation rule #5 above — NOT class methods on `qdrantBackend`, so they vanish with the route in the follow-up deletion PR):

- `scrollByPayloadFilter(collection, filter)` — returns `[{ id, vector, payload }]`. Calls Qdrant scroll API with `with_payload: true, with_vector: true`. Wrap `qdrantBackend._request('POST', '/collections/X/points/scroll', {...})` directly.
- `upsertPoint(collection, id, vector, payload)` — calls `qdrantBackend._request('PUT', '/collections/X/points?wait=true', { points: [{ id, vector, payload }] })`.
- `copyCollection(src, dst)` — creates `dst` via `qdrantBackend._request('PUT', '/collections/X', {...})` mirroring src's vector/sparse config (fetch via `GET /collections/X`), then page-scrolls src (256/page), upserts into dst. Returns total points copied.

Each helper is a `const fn = async (...) => { ... }` inside the route. Zero new methods on the class.

### 4.4 Remove old sentinel-exclusion filters that read legacy literal

Critical: after this change ships, every `must_not: [{ key: 'type', match: { value: '_vecthare_meta' } }]` in similharity must reference the new constant `SENTINEL_POINT_TYPE`. If any one is missed, queries against un-upgraded collections will return the sentinel point as a real result.

**Do NOT** add a "dual-filter" that excludes both old and new sentinel types. That's exactly the kind of fallback the user rejected — it would silently mask un-upgraded data and make troubleshooting harder. Per D1, when un-upgraded data is detected the code logs a prominent `[VectFox] LEGACY DATA DETECTED — run upgrade` warning but proceeds normally.

Audit checklist after edit (grep should return 0 hits in `similharity/` outside the upgrade route's function-local strings):
```
grep -rn "_vecthare_meta\|_vecthare_sentinel\|vecthare_main\|vecthare_multitenancy" h:\Github\Dev\similharity
```

### 4.5 `similharity/routes/migrate-to-sparse.js`

Two `must_not` filters at lines 78, 247 reference `_vecthare_meta`. Replace with the new constant (import from `qdrant-backend.js` or duplicate as a local const — match repo convention).

### 4.6 `similharity/index.js` line 1774-1776

`hasVecthareMain` check + comment — this block exists at line 1774-1776 as a "just-in-case support for multitenancy" check that looks for the `vecthare_main` collection.

Per D2 (no module-level legacy constants) and the no-fallback principle: **delete this block entirely**. The new code only knows about `vectfox_main` via `MULTITENANCY_COLLECTION`. After the user clicks the upgrade button, only `vectfox_main` will exist; the legacy check is redundant.

---

## 5. VectFox changes (do these AFTER similharity is updated and restarted)

### 5.1 Delete files

- `core/collection-migrator.js` — fully delete. No imports remain after step 5.2.

### 5.2 `index.js`

| Lines | Action |
|---|---|
| 370-435 (`onMigrateCollectionsClick`) | **Delete entire function.** |
| 437-476 (`migrateVectHarePlusToVectFox`) | **Delete entire function.** |
| 485 (call site) | Delete the call. |
| 487-498 (defineProperty trap on `extension_settings.vecthare`) | **Delete entire block.** No more legacy folder name to defend against. |
| 569 (`onMigrateCollections` in callbacks) | Delete the entry. |
| 622-623 (comment about `vecthare_chat_*` and `vecthare_eventbase_*`) | Update to `vf_chat_*` / `vf_eventbase_*`, or remove the comment if obsolete. |

Add a NEW handler `onUpgradeVectFoxV2Click` that:
- POSTs to `/api/plugins/similharity/chunks/upgrade-vectfox-v2`.
- Shows progress in the existing `progressTracker`.
- On success: sets `settings.vectfox_v2_upgrade_done = true`, saves, hides the button.
- On failure: toastr error with the report.

### 5.3 `core/collection-ids.js`

| Lines | Action |
|---|---|
| 30 (NOTE comment about backward compat) | Delete the note. |
| 43-49 (`VECTHARE_*` prefix constants) | **Delete all 6 constants.** |
| 130-135 (legacy `vecthare_chat_*` comments) | Delete the comment block. |
| 165-167 (`buildChatCollectionId` builds `vecthare_chat_` prefix) | This function is for legacy chat collections — if no longer used (chat history is now EventBase), **delete the function entirely**. Verify with grep before deleting. |
| 182 (`vecthare_chat_${id}` build) | Same — likely in the same function. |
| 441-498 (six `if (collectionId.startsWith(COLLECTION_PREFIXES.VECTHARE_*))` parse branches) | **Delete all 6 branches.** Parser now recognizes only `vf_*`. |
| 534, 541 (legacy pattern push for chat collections in match helper) | Delete. |

### 5.4 `core/collection-loader.js`

| Lines | Action |
|---|---|
| 64 (`startsWith('__vecthare_')`) | Find the surrounding context — likely a test/visualizer collection filter. Delete the legacy branch. |
| 232 (`COLLECTION_PREFIXES.VECTHARE_EVENTBASE` reference) | The constant won't exist after 5.3. Delete this branch (it's a legacy filter). |
| 298-300 (legacy test prefixes in some allowlist) | Delete `'vecthare_visualizer_test_'`, `'__vecthare_test_'`, `'vecthare_test_'` entries. |
| 734, 746 (parsing comments for legacy chat formats) | Delete the legacy-parse branches and comments. |
| 766 (`VECTHARE_CHARACTER` reference) | If this function still routes character collections, it's already dead (chat is EventBase). Delete the line and the branch. |
| 781-783 (`VECTHARE_LOREBOOK`, `VECTHARE_DOCUMENT` in some pattern push) | Delete. |
| 1073 (JSDoc example with `vecthare:` prefix) | Update example to `vf_lorebook_qdrant_...`. |

### 5.5 `core/chat-vectorization.js`

| Lines | Action |
|---|---|
| 76 (comment about `vecthare_chat_*`) | Delete. |
| 158, 402, 738, 1988 (log prefixes `[VectHare] …`) | Rename to `[VectFox] …`. |
| 283, 306-311 (`window.VectHare_ActivationHistory`) | Rename global to `window.VectFox_ActivationHistory`. Update all read/write sites. |
| 614-616 (comment listing `vecthare_*` patterns) | Update to `vf_*`. |
| 623-624, 631, 643 (`COLLECTION_PREFIXES.VECTHARE_*` references) | Delete the OR'd legacy-prefix branches. After 5.3, these constants don't exist. |
| 1902 (`vecthare_wi:` fallback collection ID) | Rename to `vf_wi:`. |
| 1963 (`window.VectHare_LastSearch`) | Rename to `window.VectFox_LastSearch`. Update all read sites. |
| 2036, 2124, 2130, 2151, 2154 (toastr titles `'VectHare'`) | Rename to `'VectFox'`. |

### 5.6 `core/constants.js`

| Line | Action |
|---|---|
| 18 (`EXTENSION_PROMPT_TAG = '3_vecthare'`) | Rename to `'3_vectfox'`. This is the key in SillyTavern's `extension_prompts` map — it's per-session, not persisted, so renaming is safe but means the eventbase variant key changes too (line 1721 builds `${EXTENSION_PROMPT_TAG}_eventbase` → `'3_vectfox_eventbase'`). |
| Reference in `eventbase-workflow.js` line 522 (`'3_vecthare_eventbase'` injection tag) | Audit and rename. |

### 5.7 `backends/qdrant.js`

| Lines | Action |
|---|---|
| 11 (comment "vecthare_multitenancy") | Update to "vectfox_main" (matching the new on-disk literal). |
| 39 (NOTE comment) | Delete the back-compat note. |
| 41 (`MULTITENANCY_COLLECTION = 'vecthare_multitenancy'`) | **Wait — this differs from similharity's `'vecthare_main'`. Audit before changing.** Line 11 says `"vecthare_multitenancy"` but similharity uses `'vecthare_main'`. One of these is wrong / dead code. Verify with grep before assuming. |
| 207, 227-228 (Legacy `vecthare_{type}_{sourceId}` parse branch in `_parseCollectionName`) | Delete the legacy parse branch entirely. |

### 5.8 `ui/ui-manager.js`

- Line 39 (JSDoc for `onMigrateCollections` callback) — delete.
- Line 939 (Migrate Collections button HTML) — **replace** with new "Upgrade to VectFox v2" button. Hide the new button when `settings.vectfox_v2_upgrade_done === true`.
- Line 3784 (`$('#VectFox_migrate_collections').on('click', ...)`) — replace with the new button's click handler.
- New button id: `VectFox_upgrade_v2` (or similar).
- New button only visible when `!settings.vectfox_v2_upgrade_done`. Show a yellow border + warning hint: *"One-time upgrade required after pulling new VectFox version. Click to rewrite legacy on-disk markers."*

### 5.9 `ui/database-browser.js` + `ui/content-vectorizer.js`

All `#vecthare_*` jQuery selectors and corresponding HTML element IDs:

```
ui/database-browser.js: 13 occurrences of #vecthare_*
ui/content-vectorizer.js: ~15 occurrences of #vecthare_cv_*
```

For each file:
1. Find every HTML id starting with `vecthare_` in the embedded template string.
2. Rename to `vectfox_`.
3. Update every `$('#vecthare_...')` selector to match.

These IDs are purely DOM — they're regenerated every session. No persisted-state risk.

### 5.10 `ui/settings.html`

146 occurrences of `vecthare_` as HTML element ids. Find-replace `vecthare_` → `vectfox_` across the whole file. Then verify the JS that binds to those IDs (probably also in `ui/ui-manager.js`) is updated in lockstep — search VectFox source for any `#vecthare_` or `'vecthare_'` selector references and update them too.

**Risk:** if SillyTavern's i18n system caches `data-i18n` attributes by id, those bindings might break. The `data-i18n` attribute value is independent of the id, so this should be fine, but verify on first reload.

### 5.11 CSS files

| File | Count | Action |
|---|---|---|
| `styles/forms.css` | 22 | Rename `.vecthare-*` selectors and `#vecthare_*` ids. Most likely already paired to renamed HTML. |
| `styles/modals.css` | 2 | Same. |
| `styles/mobile.css` | 3 | Same. |
| `styles/base.css` | 1 | Same. |
| Other `.css` files flagged in grep | — | Final grep should be zero. |

Mechanical find-replace `vecthare` → `vectfox` in each CSS file is safe as long as the HTML in 5.10 is updated in the same commit.

### 5.12 Tests

`tests/world-info-integration.test.js` — many uses of `vecthare_collection_registry` (the legacy settings key name) and `window.VectHare_WorldInfo`.

- Rename `vecthare_collection_registry` → `vectfox_collection_registry` (matches what `migrateVectHarePlusToVectFox` was already converting to).
- Rename `window.VectHare_WorldInfo` → `window.VectFox_WorldInfo`. Update any production code that exports onto this global.
- Line 46: `EXTENSION_PROMPT_TAG: 'vecthare_world_info'` — rename to `'vectfox_world_info'`. Audit production code for the same string before changing.

`tests/backends.test.js`, `tests/keyword-comparison.test.js` — likely cosmetic (log strings, comments). Final grep to confirm.

### 5.13 README files

**Skip per D7.** Do NOT touch `README.md`, `README_JP.md`, `README_KR.md`, `README_ZH.md` in this PR. They will be addressed in a separate README pass once the rename is done.

The final verification grep (§11) accounts for this by excluding `README*.md` from the "must be zero" check.

### 5.14 Docs

- `Doc/dev_helper.md` — 16 hits. Update to current naming. Be careful with §10 (Phase 1 limitations) since `plans/agentic-filters-phase-1.5.md` references it.
- `Doc/hybrid-backend-comparison.adoc` — update text.
- `.github/copilot-instructions.md` — update.

### 5.15 Plans

- **DO NOT** edit `plans/executed/*.md` — they're historical record.
- Update `plans/agentic-filters-phase-1.5.md` per the prior audit (separate task; not blocked by this plan).

### 5.16 Cross-repo version warning (per D5)

Add a small startup check in VectFox `index.js` init sequence, after the backend probe:

```js
// Cross-repo version check — per D5, big warning on mismatch, do NOT refuse.
const VECTFOX_EXTENSION_VERSION = '2.0.0';  // bump on each release
try {
    const resp = await fetch('/api/plugins/similharity/version');
    if (resp.ok) {
        const { pluginVersion } = await resp.json();
        if (pluginVersion !== VECTFOX_EXTENSION_VERSION) {
            console.warn(`[VectFox] VERSION MISMATCH: extension v${VECTFOX_EXTENSION_VERSION}, similharity plugin v${pluginVersion}. Pull both to matching versions to avoid undefined behavior.`);
            toastr.warning(`Version mismatch — VectFox v${VECTFOX_EXTENSION_VERSION}, similharity v${pluginVersion}. See console.`, 'VectFox', { timeOut: 10000 });
        }
    }
} catch (err) {
    // Plugin missing entirely — separate problem, not a mismatch.
}
```

**Companion change in similharity:** add `GET /api/plugins/similharity/version` route returning `{ pluginVersion: '2.0.0' }`. Keep the constant near the plugin manifest so version bumps stay in one place.

Both version strings hard-coded for now — no semver matching, no auto-bump. Per D5 the goal is debugging visibility, not compatibility enforcement.

---

## 6. Step-by-step ordering for the AI worker

Execute in this exact order. Each step is independently verifiable and reversible.

**Phase A — similharity (server plugin)**
1. Add the **3 new constants** at the top of `qdrant-backend.js`: `SENTINEL_POINT_TYPE`, `SENTINEL_FLAG_KEY`, `MULTITENANCY_COLLECTION`. Per D2: **no module-level legacy constants**.
2. Replace every literal use of the three on-disk strings with the new constants (see §4.2 table).
3. Add the `/chunks/upgrade-vectfox-v2` route in `similharity/index.js` with helpers (`scrollByPayloadFilter`, `upsertPoint`, `copyCollection`) defined **inline as local functions** inside the route handler (per §4.3 isolation rule #5).
4. Wrap the route block with `// ──── DELETE-IN-FOLLOWUP: ... ────` markers (top and bottom).
5. Update `routes/migrate-to-sparse.js` sentinel filters to reference `SENTINEL_POINT_TYPE` (import from `qdrant-backend.js` or duplicate as a local const).
6. Delete the `hasVecthareMain` block in `similharity/index.js` line 1774-1776 (per §4.6).
7. Add D1 loud-warning detection: in `_buildHybridFilter` or in the query result handler, scan results once for `payload.type === '_vecthare_meta'` (function-local string, not a module constant — per D2). If found, `console.warn('[VectFox] LEGACY DATA DETECTED — run upgrade-vectfox-v2 button')`. The warning is one-shot per process (gate with a module-level boolean).
8. **Verify:** `grep -rn "vecthare_meta\|vecthare_sentinel\|vecthare_main\|vecthare_multitenancy" similharity/` should return ONLY hits inside the upgrade route's function body AND the D1 detection warning. No other hits.
9. Restart SillyTavern. Pre-upgrade collections will trigger the D1 warning on first query — this is the expected detection behavior.

**Phase B — VectFox extension**
1. `core/collection-ids.js` — delete `VECTHARE_*` constants + all 6 legacy parse branches + `buildChatCollectionId` (if unused).
2. Fix every importer broken by step 1 (compile errors will guide you — search for `VECTHARE_` references across the codebase).
3. Delete `core/collection-migrator.js`.
4. `index.js` — delete `onMigrateCollectionsClick`, `migrateVectHarePlusToVectFox`, the defineProperty trap, the callback wiring.
5. `core/constants.js` — rename `EXTENSION_PROMPT_TAG`.
6. Add `onUpgradeVectFoxV2Click` handler in `index.js`.
7. `ui/ui-manager.js` — swap Migrate Collections button for Upgrade to VectFox v2.
8. Rename all `[VectHare]` log strings, toastr titles, `window.VectHare_*` globals.
9. Rename all HTML element ids `vecthare_*` → `vectfox_*` in `settings.html`, `database-browser.js`, `content-vectorizer.js`, plus paired CSS selectors and jQuery selectors.
10. Update tests.
11. Update docs (`Doc/dev_helper.md`, `Doc/hybrid-backend-comparison.adoc`, `.github/copilot-instructions.md`). **Skip READMEs per D7.**
12. **Verify:** `grep -rin "vecthare\|VectHare\|VectHarePlus\|vecthareplus\|vh_" h:\Github\Dev\VectFox --include="*.js" --include="*.html" --include="*.css"` excluding `plans/executed/`, `README*.md`, and the lockfile → 0 hits.

**Phase C — user-facing upgrade (single user, single collection)**
1. User pulls similharity → restarts ST.
2. User pulls VectFox → reloads UI.
3. User opens the Action tab and clicks "Upgrade to VectFox v2". Progress tracker shows the sentinel rewrite + (if applicable) multitenancy clone. On success, button hides itself. Per the "Plan simplifications" section, there is NO first-launch toast or modal — the user knows to click the button because they're the one running the upgrade.

---

## 7. Verification checklist

Before merging:
- [ ] `grep -rin "vecthare\|VectHare\|VectHarePlus\|vecthareplus\|vh_" h:\Github\Dev\VectFox --include="*.js" --include="*.html" --include="*.css"` returns 0 hits outside `plans/executed/`.
- [ ] Same grep across `h:\Github\Dev\similharity` returns only the three `LEGACY_*` constant declarations.
- [ ] All tests pass: `npm test` in VectFox.
- [ ] Manual: fresh-install a clean SillyTavern, create a chat, vectorize, query — verify no sentinel point appears in results.
- [ ] Manual: simulate "user with pre-v2 data" by hand-creating a sentinel point with `type=_vecthare_meta` in a test collection. Confirm:
  - It appears as a query result (sanity — no filter excludes it).
  - The D1 loud-warning fires in the browser console: `[VectFox] LEGACY DATA DETECTED — run upgrade-vectfox-v2 button`.
  - After clicking Upgrade to VectFox v2, the sentinel point's payload reads `type: _vectfox_meta`, `_vectfox_sentinel: true`.
  - The legacy keys are gone from the payload.
  - On the next query, the sentinel no longer appears (now excluded by the new `must_not` filter) and the D1 warning does NOT fire.
- [ ] Manual: if you have a `vecthare_main` multitenancy collection, confirm:
  - Before upgrade: still queryable via legacy reads.
  - After upgrade: `vectfox_main` exists with the same point count; `vecthare_main` is deleted.
- [ ] Manual: click the upgrade button twice. Second click is a no-op (report shows 0 legacy points found) and the button hides itself.

---

## 8. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| User pulls VectFox before similharity → similharity still writes legacy sentinels but VectFox-side code expects new ones | Sentinels not excluded → appear in results | Detection behavior resolved by decision D1. No silent dual-filter — failures must be loud. |
| Upgrade button fails mid-collection (network blip during multitenancy clone) | Partial state: some points copied, source still exists | Idempotent retry: re-clicking re-scrolls source, re-upserts (Qdrant upserts are idempotent on point id), skips already-copied points. Source is deleted ONLY after copy point-count matches. |
| `vectfox_main` already exists when upgrade runs (user manually pre-created) | Refuse and report — don't overwrite | §4.3 step 2 already handles via the `hasLegacyMT && hasNewMT` branch. |
| Hidden references to `VECTHARE_*` constants in code paths we missed | Compile / runtime error | After §5.3 deletes the constants, every importer becomes a compile error pointing to the exact line. Run dev build + test suite to surface them. |
| `EXTENSION_PROMPT_TAG` rename breaks an injected prompt slot mid-session | One session loses injection, fixable by reload | Tag is per-session in ST; only affects users with an open tab when the update lands. Acceptable. |
| ST persists `extension_settings.vecthare` again because folder name is "vecthare" | Settings duplicated under both keys | Once the extension folder is `VectFox`, ST writes `extension_settings.VectFox`. The defineProperty trap was a workaround; deleting it after the folder rename is the correct cleanup. **Verify the folder name in the user's install** before deleting the trap. |
| CSS selector rename breaks an in-flight modal | One-time visual glitch on reload | All renames happen in the same commit; CSS + HTML stay paired. |
| Test file uses `vecthare_collection_registry` to assert against legacy data shape | Tests fail | Rename test fixtures in lockstep with production code. |

---

## 9. Out of scope (not part of this PR)

- Renaming the extension folder itself on the user's filesystem (`VectFox` is already correct per user setup).
- Migrating user settings.json from older legacy keys — `migrateVectHarePlusToVectFox` already ran once for users on the current installed version, so settings are already on `vectfox_*` keys. The function deletion is safe.
- Touching the agentic-filters-phase-1.5 plan (separate concern; addressed in a different audit).
- Renaming `plans/executed/*.md` historical files.

---

## 10. Phase D — Dead field cleanup (bundled into this PR)

Per user directive, remove three fields confirmed to have **zero readers** anywhere in the codebase. Trace verified by grep: each field is only written/passed-through/exported, never consumed by any retrieval, filter, scoring, or UI logic.

**Remove:** `customWeights`, `disabledKeywords`, `chunkGroup`
**Keep:** `conditions`, `isSummaryChunk`, `parentHash` (live features even if user's data currently shows them as null)

### 10.1 VectFox changes

| File | Line | Change |
|---|---|---|
| [backends/qdrant.js](../backends/qdrant.js#L328-L330) | 328-330 | Delete the three `customWeights / disabledKeywords / chunkGroup: item.X` lines from the payload object. |
| [backends/standard.js](../backends/standard.js#L249-L251) | 249-251 | Same three lines, delete. |
| [core/collection-export.js](../core/collection-export.js#L128) | 128-129 | Delete `customWeights` and `disabledKeywords` from the metadata export shape. |
| [core/collection-export.js](../core/collection-export.js#L134) | 134 | Delete `chunkGroup` from the export shape. |
| [core/collection-export.js](../core/collection-export.js#L274) | 274-275 | Same pair, delete from the second export site. |
| [core/collection-export.js](../core/collection-export.js#L280) | 280 | Delete `chunkGroup` from the second export site. |
| [core/eventbase-store.js](../core/eventbase-store.js#L83-L88) | 83-88 | Delete the three hardcoded-empty lines (`customWeights: []`, `disabledKeywords: []`, `chunkGroup: null`). Update the comment at line 83 to drop the mention of `chunkGroup`. |

### 10.2 similharity changes

| File | Line | Change |
|---|---|---|
| [similharity/qdrant-backend.js](../../similharity/qdrant-backend.js#L570-L572) | 570-572 | Delete the three lines in the LEGACY block (`customWeights`, `disabledKeywords`, `chunkGroup`). |
| similharity/qdrant-backend.js | 675-678 | Delete the entire `if (filters.chunkGroup) { ... }` block from `queryCollection`'s filter builder. |
| similharity/qdrant-backend.js | 734 | Delete the `if (filters.chunkGroup) add(...)` line from `_buildHybridFilter`. |
| similharity/README.md | (search) | **Skip** per D7 (README untouched this PR). The dead documentation can be cleaned up in a future README pass. |

### 10.3 Verification grep (after Phase D)

```bash
# VectFox repo
grep -rn "customWeights\|disabledKeywords\|chunkGroup" h:\Github\Dev\VectFox --include="*.js" \
  | grep -v "plans/"
# Expect: 0 hits

# similharity repo
grep -rn "customWeights\|disabledKeywords\|chunkGroup" h:\Github\Dev\similharity --include="*.js"
# Expect: 0 hits (README hits OK, will be cleaned later)
```

### 10.4 Sanity check before deleting

For each field, before deletion the AI worker should re-run the read-site grep one more time to confirm no producer added a reader since this plan was written:

```bash
grep -rn "\.customWeights\b\|\.disabledKeywords\b\|\.chunkGroup\b" h:\Github\Dev\VectFox h:\Github\Dev\similharity --include="*.js"
```

If any line looks like a READ (e.g., `if (x.customWeights)` or `filters.chunkGroup &&` or `for (const k of meta.disabledKeywords)`), **STOP** and surface to the user. All current hits are writes/pass-throughs.

---

## 11. Final grep command for the AI worker

Run this from the repo root after all edits. Should return zero matches (excluding the LEGACY_ constants and plans/executed/):

```bash
# Inside h:\Github\Dev\VectFox
grep -rni --include="*.js" --include="*.html" --include="*.css" --include="*.md" \
    -E "vecthare|VectHare|VectHarePlus|vecthareplus|vh_" \
    . | grep -v "plans/executed/" | grep -v "node_modules/"

# Inside h:\Github\Dev\similharity
grep -rni --include="*.js" \
    -E "vecthare|VectHare|VectHarePlus|vecthareplus|vh_" \
    . | grep -v "LEGACY_" | grep -v "node_modules/"
```

If either returns hits, finish those before merging.
