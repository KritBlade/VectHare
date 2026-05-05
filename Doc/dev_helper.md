# Dev Helper

## 1) Extraction Level Location
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

## 2) Default Summarizer Token/Timeout Constants
Located in: `core/summarizer.js`

Exact constant names:
- `DEFAULT_MAX_TOKENS`
- `DEFAULT_TIMEOUT_MS`

## 3) Group Batch Message Settings
Located in: `core/summarizer.js`

Exact variable names used in grouped summarize flow:
- `groupMaxTokens`
- `groupTimeoutMs`

Notes:
- `groupMaxTokens` is computed from per-item budget and count, capped at 8192.
- `groupTimeoutMs` is computed as base timeout + per-item scaling, capped at 180000 ms.

## 4) Collection Active State — Two Separate Controls

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
- **Gating logic:** Only applies when `lockedToChatIds` exists as an own property in stored metadata (meaning the user has saved the settings panel at least once). If the key is absent, the collection is unrestricted by default.

### Where EventBase Retrieval Checks Both
File: `core/eventbase-workflow.js`, function `runEventBaseRetrieval`

```javascript
// Gate A: card pause toggle
const disabledKey = candidateKeys.find(key => key && !isCollectionEnabled(key));
if (disabledKey) return;

// Gate B: "Active for current chat" checkbox
const storedMeta = extension_settings?.vecthareplus?.collections?.[collectionId];
if (storedMeta && Object.prototype.hasOwnProperty.call(storedMeta, 'lockedToChatIds')) {
    if (!isCollectionLockedToChat(collectionId, currentChatId)) return;
}
```

### Key files
- `core/collection-metadata.js` — `isCollectionEnabled`, `setCollectionEnabled`, `isCollectionLockedToChat`, `setCollectionLock`, `removeCollectionLock`, `getCollectionLocks`
- `ui/database-browser.js` line ~1055 — card toggle handler (`vecthare-action-toggle`)
- `ui/database-browser.js` function `saveActivation` — "Active for current chat" save handler
- `ui/database-browser.js` function `openActivationEditor` — reads lock state to populate checkbox

---

## 5) Similharity Plugin Speedup (Simultaneous Embedding Requests)
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
