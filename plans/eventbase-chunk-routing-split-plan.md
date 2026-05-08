# EventBase + Chunk-Based Routing Split — Implementation Plan

## Background — what is broken

`rearrangeChat` in [chat-vectorization.js:1838](../core/chat-vectorization.js#L1838) currently treats EventBase as a **mutually exclusive replacement** for all retrieval:

```javascript
if (settings.eventbase_enabled) {
    // ... run EventBase ...
    return;   // <— exits, never queries lorebooks/docs/characters/files
}
// chunk-based path (registry query, lorebook semantic WI, etc.)
```

Symptoms confirmed in production logs:
1. User vectorized a lorebook and locked it to current chat — log shows `rearrangeChat called` then `[EventBase] Not active for current chat … skipping retrieval` and nothing else. Lorebook never queried.
2. Both popup toggles enabled but no popup shows. EventBase exits before reaching its popup line; chunk-based path never runs so its (non-existent) popups never fire either.
3. Dead code: [`applySemanticEntriesToPrompt`](../core/world-info-integration.js#L311) is defined and tested but never invoked outside tests.

## Content type taxonomy

| UI label | Internal type | Phase |
|---|---|---|
| Current Chat History | `CHAT` | A — EventBase |
| **Archive Chat History** (was "Custom Document") | `DOCUMENT` | A — EventBase |
| Lorebook | `LOREBOOK` | B — Chunk-based |
| Character Card | `CHARACTER` | B — Chunk-based |
| URL / Webpage | `URL` | B — Chunk-based |
| Wiki Page | `WIKI` | B — Chunk-based |
| YouTube Transcript | `YOUTUBE` | B — Chunk-based |

**Archive Chat History** = vectorized chat history loaded from a file. It is still chat history — just from a different source — so it belongs in Phase A alongside live chat collections, not in Phase B.

## Target architecture — single pipeline, two phases

Going forward, both phases run **on every reply**. EventBase handles chat-history content; the chunk-based phase handles every other content type.

```
rearrangeChat
├── Phase A — EventBase (chat history)
│     ├── always invoked; internally skips when no event collection
│     │   is locked to current chat
│     └── covers: CHAT + DOCUMENT (Archive Chat History)
│
└── Phase B — Chunk-based content
      ├── always invoked when at least one eligible non-chat collection
      │   is locked to current chat AND on a supported backend
      └── covers: LOREBOOK, CHARACTER, URL, WIKI, YOUTUBE
```

### Routing rules (the if/else)

```
For every collection in vecthare_collection_registry:

  parsed.type ∈ { CHAT, DOCUMENT }
    → Phase A (EventBase). Skip in Phase B.

  parsed.type ∈ { LOREBOOK, CHARACTER, URL, WIKI, YOUTUBE }
    AND collection is locked to current chat
    AND backend ∈ { standard, qdrant }
      → Phase B chunk query.

  Anything else
    → skip.
```

## Hard assumptions baked into this plan (per user direction)

1. **EventBase is the only chat-history retrieval path.** `settings.eventbase_enabled` is treated as `true` everywhere. Toggle removal is a follow-up plan, not this one — but new code MUST NOT branch on the value.
2. **Only `standard` and `qdrant` backends are supported.** Collections from `milvus` or `lancedb` are skipped at routing time. Backend-removal is a follow-up plan.
3. **Lock-to-chat is required for non-chat content.** Collections with no lock on the current chat are NOT queried, even if they have triggers/conditions. This intentionally tightens the existing "auto-activate when no rules" default — it is the explicit choice for the new architecture.

## Implementation steps

### Step 1 — Refactor `rearrangeChat` into the two-phase pipeline

File: [`core/chat-vectorization.js`](../core/chat-vectorization.js#L1838)

- Remove the `if (settings.eventbase_enabled) { ... return; }` early-return block at lines 1870–1888.
- Replace with:
  ```javascript
  // Phase A: EventBase (chat history + archive chat history)
  // CHAT and DOCUMENT type collections are both handled by EventBase.
  const queryText = buildSearchQuery(chat, settings);
  if (queryText) {
      const { runEventBaseRetrieval } = await import('./eventbase-workflow.js');
      await runEventBaseRetrieval({
          chat, searchText: queryText, settings, chatUUID: getChatUUID(),
      });
  } else {
      setExtensionPrompt(`${EXTENSION_PROMPT_TAG}_eventbase`, '', settings.position, settings.depth, false);
  }

  // Phase B: chunk-based non-chat content (lorebook / character / URL / wiki / youtube)
  // (continue into existing collection-query path, with the new routing filter)
  ```
- Keep the existing collection-query path (Stage 1 onwards, line 1890+) but apply the new routing filter (Step 2) to `gatherCollectionsToQuery` results.

### Step 2 — Add the routing filter

File: [`core/chat-vectorization.js`](../core/chat-vectorization.js) — modify `gatherCollectionsToQuery` (or add a wrapper).

For each candidate collection, include it in Phase B only when ALL of these hold:
1. `parseCollectionId(...).type ∉ { CHAT, DOCUMENT }` — both chat types are EventBase territory.
2. `parseRegistryKey(...).backend ∈ { 'standard', 'qdrant' }` — supported backends only.
3. `isCollectionLockedToChat(plainId, currentChatId) === true` — explicit opt-in for this chat.

Log each rejection with reason (`corrupted` / `chat-type` / `archive-chat-type` / `unsupported-backend` / `not-locked`) when `settings.eventbase_debug_logging` is true.

### Step 3 — Tighten activation filter for non-chat content

File: [`core/collection-metadata.js:980-983`](../core/collection-metadata.js#L980-L983)

Currently: a collection without triggers/conditions/lock auto-activates everywhere ("Priority 5 — backwards compatible auto-activate").

Change to:
- If `parsed.type ∉ { CHAT, DOCUMENT }` and there is no lock on the current chat → reject.
- Lorebooks/character cards/etc. that are intentionally global (not locked) become invisible to retrieval. This is the explicit new policy.

Document the change in a one-line comment so the regression in test fixtures is clear.

### Step 4 — Add lorebook/chunk-phase popup wiring

Files:
- [`core/chat-vectorization.js`](../core/chat-vectorization.js) — Phase B body
- [`ui-manager.js`](../ui/ui-manager.js) — confirm checkbox label scope ("Popup: show when retrieval starts" should cover both phases)

Add at the top of Phase B (after the routing filter resolves to non-empty):
```javascript
if (settings.retrieval_popup_on_start) {
    toastr.info('Retrieving content from vectorized collections...', 'VectHare Retrieval');
}
```

Add at the end of Phase B (after dedup, before injection):
```javascript
if (settings.retrieval_popup_on_result) {
    toastr.info(`Injected ${chunksToInject.length} chunk(s) from ${activeCollections.length} collection(s)`, 'VectHare Retrieval');
}
```

Match EventBase popup style/timing for consistency. Both popups must respect their own toggle independently.

### Step 5 — Rename "Custom Document" to "Archive Chat History" in the UI

File: [`ui/content-vectorizer.js`](../ui/content-vectorizer.js) (dropdown option)

- Change the dropdown label from "Custom Document" → "Archive Chat History".
- Update any associated help text or tooltips to clarify: "Vectorize a saved chat log file. This content is retrieved via the EventBase path, not the chunk-based path."
- Ensure the internal `COLLECTION_TYPES.DOCUMENT` constant is unchanged (only the display label changes).

### Step 6 — Wire or remove `applySemanticEntriesToPrompt`

File: [`core/world-info-integration.js:311`](../core/world-info-integration.js#L311)

This function does standalone lorebook semantic injection but is never called outside tests. Two choices:
- **Remove it.** With Phase B running on every reply, the existing inline path at [chat-vectorization.js:2026](../core/chat-vectorization.js#L2026) covers lorebooks. Delete the function and its tests.
- **Keep as a public API surface** for external integrations (e.g. quick-replies, user scripts). If keeping, call it out in dev_helper.md.

Recommendation: **Remove**. Less surface to maintain.

### Step 7 — Update activation-filter telemetry

The "✓ NO_TRIGGERS_OR_CONDITIONS (auto-activate)" log line will mostly disappear after Step 3. Update [collection-metadata.js:982](../core/collection-metadata.js#L982) to log the new rejection reasons clearly (e.g. `✗ NON_CHAT_NOT_LOCKED`).

### Step 8 — Update tests

Files:
- [`tests/world-info-integration.test.js`](../tests/world-info-integration.test.js) — update or remove `applySemanticEntriesToPrompt` tests depending on Step 6 decision.
- Any test fixture that relied on auto-activate behavior must be updated to set `lockedToChatIds` explicitly.
- New test: locked lorebook + EventBase enabled → both phases produce injection.
- New test: Archive Chat History collection (DOCUMENT type) → routed to Phase A, absent from Phase B query.

### Step 9 — Documentation

Update [`Doc/dev_helper.md`](../Doc/dev_helper.md):
- Section 9 currently describes A1/A2/A3 retrieval routing inside `queryCollection`. Add a new top-level section describing the **rearrangeChat two-phase pipeline** above that — A1/A2/A3 is the *per-collection* routing, the two-phase pipeline is the *system-level* routing.
- Note the lock-required policy for non-chat content.
- Note that DOCUMENT (Archive Chat History) is treated as chat content and routes to Phase A.

## Out of scope for this plan (separate follow-ups)

- Removing the `eventbase_enabled` toggle from settings UI/storage/index.js defaults.
- Deleting milvus and lancedb backend modules.
- Removing the `keyword_extraction_level` setting (already retrieval-irrelevant per dev_helper.md §9; only ingestion uses it).
- Cleanup of stacked-prefix folders on disk via the new "Cleanup Corrupted" button (already shipped).

## Test plan

For an existing chat with one locked lorebook on `standard` backend, EventBase enabled, no event collection for the chat:

| Pre-fix expectation | Post-fix expectation |
|---|---|
| `rearrangeChat` exits after EventBase early-skip; lorebook silent | EventBase early-skips, then Phase B queries the locked lorebook |
| No popups despite both toggles on | "Retrieving content…" toast on start + "Injected N chunk(s)…" on completion |
| Lorebook content never reaches prompt | Lorebook chunks injected via the existing chunk pipeline |

Repeat with:
- EventBase active for chat → both phases run.
- No locked non-chat collection → EventBase runs, Phase B logs "no eligible collections" and exits cleanly without popups.
- Lorebook locked but on milvus backend → skipped with "unsupported-backend" reason.
- Archive Chat History (DOCUMENT type) collection → appears in Phase A EventBase query, NOT in Phase B candidates.

## Open questions to confirm before coding

1. Should ingestion-time auto-lock fire for **all** non-chat content vectorized via "Vectorize Content" UI? Currently only chat collections auto-lock. If the new policy requires lock-for-retrieval, the vectorization UX should default to "lock to current chat" with a clear opt-out checkbox.
2. Should the "Active for current chat" UI control on collection cards become the primary affordance (since locking is now mandatory for retrieval)? May want to rename to "Use in this chat" for clarity.
3. For Archive Chat History ingestion: should it write into an EventBase-managed collection (keyed the same way as live chat EventBase collections) or remain a separate DOCUMENT-type collection that EventBase queries alongside CHAT collections?
