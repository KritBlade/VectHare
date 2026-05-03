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

## 4) Similharity Plugin Speedup (Simultaneous Embedding Requests)
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
