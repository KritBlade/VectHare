# Plan: EventBase Phase 2 — AI Event Extraction, Qdrant Storage, and Retrieval

> Prereq: Phase 1 (`plans/eventbase-workflow-plan.md`) is implemented. The
> `eventbase_enabled` toggle, EventBase tab, branch gates in
> `core/chat-vectorization.js`, `core/content-vectorization.js`, and
> `core/core-vector-api.js`, and the throwing stubs in
> `core/eventbase-workflow.js` are in place.
>
> This phase replaces the throwing stubs with a real ingestion + retrieval
> pipeline that extracts structured events with an LLM, stores them in Qdrant,
> and retrieves them for prompt injection. Existing legacy workflow remains
> untouched when `eventbase_enabled` is false.

---

## 0. Goals and non-goals

### Goals
- Convert N-message windows of chat into structured **Event JSON** records via LLM.
- Persist each event as a Qdrant point: vector from event text, full JSON in payload.
- Retrieve relevant events at generation time using vector + payload filters.
- Inject selected events into the prompt with deterministic formatting.
- Keep the path fully isolated; legacy chunking/summarization untouched.
- Hard fail on configuration/extraction errors with actionable messages.

### Non-goals
- Removing or migrating legacy collections.
- Cross-chat global event base (scoped per chat in this phase).
- Reranker model integration (reserved for a later phase).
- UI editor for events (read-only browser only in this phase).

---

## 1. Canonical Event Schema

All extraction, storage, and retrieval rely on this single schema. Define it
once in `core/eventbase-schema.js` and import everywhere.

### 1.1 TypeScript-style shape (for reference)

```ts
interface EventRecord {
  // Required
  event_type: string;        // controlled vocabulary, see 1.2
  importance: number;        // integer 1..10
  summary: string;           // 1-3 sentences, language matches source
  cause: string;             // why this happened (may be "")
  result: string;            // outcome/state change (may be "")
  characters: string[];      // proper nouns; preserve original script
  locations: string[];
  factions: string[];
  items: string[];
  concepts: string[];
  keywords: string[];        // search aids; deduplicated
  open_threads: string[];    // unresolved questions/promises
  should_persist: boolean;   // false = ephemeral, lower retention

  // Added by ingestion (not produced by LLM)
  event_id: string;          // uuid v4
  chat_uuid: string;         // current chat UUID
  source_message_ids: number[]; // 0-based indices of source chat messages
  source_message_hashes: number[]; // hashes of source messages for dedup
  source_window_start: number;
  source_window_end: number;
  created_at: number;        // epoch ms
  schema_version: 1;
}
```

### 1.2 Controlled `event_type` vocabulary

Frozen list in `core/eventbase-schema.js`:

```
main_quest_update
side_quest_update
combat
travel
discovery
dialogue_significant
relationship_change
character_introduction
character_state_change   // injury, illness, transformation
item_acquired
item_lost
faction_change
location_change
revelation               // new lore/world fact
promise_or_oath
betrayal
death
other
```

LLM is instructed to map any event into one of these. `other` is the safety
fallback.

### 1.3 Validation

`validateEvent(raw): { ok: boolean, errors: string[], event?: EventRecord }`

- Reject if missing required fields, wrong types, or empty `summary`.
- Coerce `importance` to integer in [1..10]; out-of-range => clamp + warn.
- `event_type` not in vocabulary => coerce to `"other"` + warn.
- All array fields default to `[]` if missing.
- Trim strings; drop empty entries from arrays; dedupe arrays.

---

## 2. New / changed files

### New
- `core/eventbase-schema.js` — schema constants, validator, JSON Schema for LLM.
- `core/eventbase-extractor.js` — LLM extraction client (OpenRouter + vLLM).
- `core/eventbase-store.js` — Qdrant insert/query/delete wrappers for events.
- `core/eventbase-retrieval.js` — Query orchestration, filter building, scoring.
- `core/eventbase-injection.js` — Format selected events into prompt block.
- `ui/eventbase-browser.js` — Read-only event browser (list/inspect/delete).
- `tests/eventbase/*.test.js` — Schema validator, extractor parsing, store, retrieval.

### Modified
- `core/eventbase-workflow.js` — Replace throw-stubs with real `runEventBaseIngestion` and `runEventBaseRetrieval`.
- `core/chat-vectorization.js` — Branch already gated; wire to new ingestion.
- `core/core-vector-api.js` — Branch already gated; wire to new retrieval.
- `ui/ui-manager.js` — Expand EventBase tab with config + browser launcher.
- `index.js` — Add new EventBase settings defaults (see §4).

---

## 3. Collection layout in Qdrant

### 3.1 Collection ID

Per chat: `vecthare_eventbase_{handleId}_{charName}_{chatUUID}`.

Use existing `collection-ids.js` helpers; add:

```js
export function buildEventBaseCollectionId(chatUUID) { ... }
```

### 3.2 Vector

Same embedding provider/model as legacy path — reuse
`getAdditionalArgs([embedText], settings)` so EventBase shares config.

`embedText` composition (deterministic, stored in payload `embed_text`):

```
[event_type] {summary}
CAUSE: {cause}
RESULT: {result}
CHARS: {characters joined with ', '}
LOCS: {locations joined with ', '}
ITEMS: {items joined with ', '}
KEYS: {keywords joined with ', '}
THREADS: {open_threads joined with ', '}
```

Empty fields are skipped to keep the embedding signal clean.

### 3.3 Payload

Store the full validated `EventRecord` plus `embed_text` and an
`eventbase_schema_version` field. The Similharity plugin already accepts
arbitrary `metadata` on `/chunks/insert`; reuse it as-is — no plugin change
required.

### 3.4 Point ID / hash

- Qdrant point id: numeric hash of `event_id` (use existing `getStringHash`).
- Keep `event_id` as a payload field for human-readable lookup.

---

## 4. New settings (defaults in `index.js`)

```js
eventbase_enabled: false,                   // already added in Phase 1
eventbase_window_size: 6,                   // chat messages per extraction batch
eventbase_window_overlap: 1,                // overlap to avoid edge cuts
eventbase_min_importance_store: 3,          // drop events below this
eventbase_provider: 'openrouter',           // 'openrouter' | 'vllm'
eventbase_model: '',                        // user-selected
eventbase_vllm_url: '',
eventbase_temperature: 0.2,
eventbase_max_tokens: 2048,
eventbase_timeout_ms: 60000,
eventbase_retrieval_top_k: 8,
eventbase_retrieval_min_importance: 1,
eventbase_retrieval_filters_enabled: true,  // intent-based filters (chars/locs)
eventbase_inject_format: 'json',            // 'json' | 'bullet'
eventbase_inject_max_chars: 4000,
eventbase_debug_logging: false,

// Re-rank weights (user-tunable, see §6.4)
eventbase_rerank_w_cosine: 0.55,
eventbase_rerank_w_importance: 0.20,
eventbase_rerank_w_persist: 0.15,
eventbase_rerank_w_recency: 0.10,

// Hard cap per extraction window (LLM may return fewer, including zero)
eventbase_max_events_per_window: 5,
```

All keys merged through the existing
`{...defaultSettings, ...extension_settings.vecthareplus}` bootstrap. Surface
each one in the EventBase tab (see §8).

---

## 5. Ingestion pipeline

Entry: `runEventBaseIngestion({ messages, settings, abortSignal })` in
`core/eventbase-workflow.js`.

### 5.1 Windowing
- Build sliding windows of size `eventbase_window_size` with overlap
  `eventbase_window_overlap` over the chat messages slice that needs
  ingestion (use existing dirty-detection from `synchronizeChat`).
- Each window has: `messages[]`, `start`, `end`, `hashes[]`.
- Skip windows whose `hashes[]` set is fully covered by an already stored
  event (dedup via payload `source_message_hashes`).

### 5.2 LLM call (`core/eventbase-extractor.js`)

Single function: `extractEvents(window, settings) -> Promise<EventRecord[]>`.

- Provider routing matches `summarizer.js` patterns — reuse helpers where
  possible (`_getOpenRouterApiKey`, error classes).
- Use **JSON-only** output. Prefer provider's structured-output / JSON mode
  when available:
  - OpenRouter: `response_format: { type: 'json_object' }` and embed schema in
    prompt.
  - vLLM: same `response_format` if the served model supports it; otherwise
    rely on prompt + post-parse.
- Parse with `JSON.parse`. If it fails, attempt one repair pass: strip code
  fences, trim before first `[` and after last `]`. If still invalid → throw
  `EventBaseExtractionError` (fail hard for that window; record + skip,
  continue with next window).

### 5.3 Prompt template

The template MUST enforce three non-negotiable rules: (a) language match, (b)
zero-event allowance, (c) hard cap of
`eventbase_max_events_per_window` events. The wording below is the canonical
version used at runtime — the worker AI must implement it verbatim (only
`{{count}}` and `{{text}}` are templated).

```
You are a story event archivist for a roleplay session. Extract ONLY narratively significant story events from the excerpt below.

=========================
ABSOLUTE RULES (DO NOT BREAK)
=========================
1. LANGUAGE MATCH — MANDATORY:
   - You MUST write every string field (summary, cause, result, characters, locations, factions, items, concepts, keywords, open_threads) in the EXACT SAME LANGUAGE AND SCRIPT as the excerpt.
   - If the excerpt is in Traditional Chinese (繁體中文), write in Traditional Chinese. Do not convert to Simplified.
   - If the excerpt is in Simplified Chinese (简体中文), write in Simplified Chinese. Do not convert to Traditional.
   - If the excerpt is in Japanese, write in Japanese.
   - If the excerpt is in Korean, write in Korean.
   - If the excerpt is in English, write in English.
   - If the excerpt mixes languages, follow the dominant language of each individual field's source content.
   - DO NOT translate. DO NOT romanize. DO NOT transliterate proper nouns.
   - Violating this rule makes the output invalid.

2. EVENT COUNT — STRICT:
   - Return AT MOST {{count}} events.
   - Returning fewer is correct and expected. Returning ZERO events ([]) is correct when the excerpt has no narrative impact.
   - DO NOT pad. DO NOT invent events. DO NOT split one event into multiple. Quality over quantity.

3. WHEN TO RETURN ZERO EVENTS ([]):
   - Pure 日常生活 / slice-of-life chatter with no plot, relationship, or world impact.
   - Pure sexual / intimate scenes with no narrative consequence (no confession, no promise, no revelation, no relationship change, no plot information).
   - Filler banter, greetings, small talk, scene transitions with no new information.
   - EXCEPTION: If important plot, lore, promises, revelations, betrayals, or relationship changes occur DURING such scenes, DO extract those — the surrounding context does not disqualify them.

=========================
OUTPUT SCHEMA
=========================
Return ONLY a valid JSON array. No prose. No markdown. No code fences.

Each event object MUST have these fields:
- event_type: one of [main_quest_update, side_quest_update, combat, travel, discovery, dialogue_significant, relationship_change, character_introduction, character_state_change, item_acquired, item_lost, faction_change, location_change, revelation, promise_or_oath, betrayal, death, other]
- importance: integer 1-10 (10 = pivotal main plot, 1 = minor flavor worth remembering)
- summary: 1-3 sentences, SAME LANGUAGE AS EXCERPT (see Rule 1)
- cause: short explanation of why it happened, SAME LANGUAGE AS EXCERPT (may be "")
- result: outcome / state change, SAME LANGUAGE AS EXCERPT (may be "")
- characters: array of proper-noun names, EXACT ORIGINAL SCRIPT
- locations: array of strings, EXACT ORIGINAL SCRIPT
- factions: array of strings, EXACT ORIGINAL SCRIPT
- items: array of strings, EXACT ORIGINAL SCRIPT
- concepts: array of strings, SAME LANGUAGE AS EXCERPT
- keywords: array of strings, SAME LANGUAGE AS EXCERPT (search aids)
- open_threads: array of strings, SAME LANGUAGE AS EXCERPT (unresolved questions/promises)
- should_persist: boolean (false for ephemeral moments unlikely to matter later)

=========================
VALID OUTPUT EXAMPLES
=========================
Zero events (filler scene):
[]

One event (Traditional Chinese excerpt):
[{"event_type":"promise_or_oath","importance":9,"summary":"師傅承諾幫梅拉尋找失蹤的父親暗影之翼。","cause":"梅拉在房間中央哭著請求幫助。","result":"尋找暗影之翼成為隊伍的核心目標。","characters":["梅拉","師父"],"locations":["星月綠洲頂樓公寓"],"factions":[],"items":[],"concepts":["失蹤的父親"],"keywords":["暗影之翼","尋找父親"],"open_threads":["確定暗影之翼是生是死"],"should_persist":true}]

=========================
EXCERPT
=========================
{{text}}
```

Notes for the worker AI:
- `{{count}}` is replaced with `settings.eventbase_max_events_per_window`.
- Do NOT include the example block in retrieval/injection prompts — it is for extraction only.
- Post-parse: if returned array length exceeds `{{count}}`, sort by `importance` desc and truncate. Log a warn.
- Post-parse: language sanity check — run a lightweight script-detection on the `summary` field; if it diverges from the dominant script of the excerpt (e.g., excerpt is CJK but summary is pure ASCII Latin), drop the event and log a warn. Do NOT auto-translate.

### 5.4 Post-processing
- Run `validateEvent` for each item; drop invalid ones with a warn log.
- Drop events with `importance < eventbase_min_importance_store`.
- Attach: `event_id`, `chat_uuid`, `source_message_ids`,
  `source_message_hashes`, `source_window_start/end`, `created_at`,
  `schema_version`.
- Build `embed_text` (§3.2).

### 5.5 Embedding + Insert
- Batch all `embed_text` strings, call `getAdditionalArgs(texts, settings)`.
- For each event:
  - `vector` = embedding for its `embed_text`.
  - Build chunk item compatible with existing `insertVectorItems(...)`:
    ```js
    {
      hash: getStringHash(event_id),
      text: embed_text,
      index: i,
      vector,
      metadata: { ...eventRecord, embed_text, eventbase: true },
    }
    ```
- Call `backend.insertVectorItems(collectionId, items, settings, abortSignal)`.
- Register collection with `registerCollection` so it appears in registry.

### 5.6 Concurrency, abort, progress
- Process windows with bounded concurrency (default 3).
- Honor `abortSignal` between windows and during fetches.
- Push progress to the existing `progressTracker` so the Stop button works.
- Errors:
  - Provider auth/config → throw `EventBaseFatalError` (abort entire run).
  - Per-window parse/validation → log + skip + continue.

### 5.7 Idempotency
- Before insert, query by payload filter `{ source_message_hashes any of [...] }`
  to find existing events from the same window; replace (delete + insert) only
  if the source hash set matches exactly. Otherwise treat as new.

---

## 6. Retrieval pipeline

Entry: `runEventBaseRetrieval({ chat, settings, abortSignal })` in
`core/eventbase-workflow.js`, returning the same shape the legacy retrieval
returns to `rearrangeChat` (so injection logic can stay unified later).

### 6.1 Query construction
- Reuse `buildSearchQuery(...)` to get the recent N-message window text.
- Reuse `extractChatKeywords(...)` to get proper nouns + keywords from the
  query window.

### 6.2 Filters (Qdrant payload filter)

Build only when `eventbase_retrieval_filters_enabled` is true:

```jsonc
{
  "must": [
    { "key": "chat_uuid",  "match": { "value": "<current chat uuid>" } },
    { "key": "eventbase",  "match": { "value": true } },
    { "key": "importance", "range": { "gte": <min_importance> } }
  ],
  "should": [
    // boost via 'should' when extracted entities exist
    { "key": "characters", "match": { "any": ["<extracted names>"] } },
    { "key": "locations",  "match": { "any": ["<extracted locs>"] } },
    { "key": "keywords",   "match": { "any": ["<extracted keys>"] } }
  ]
}
```

Pass via the existing Similharity `/chunks/query` `filter` field
(already supported by `qdrant.js` for multitenancy — extend to pass through
caller-provided filters).

### 6.3 Vector search
- Embed query window text once (reuse `getAdditionalArgs`).
- Send vector + filter to backend with `topK = eventbase_retrieval_top_k`
  (overfetch x2 to allow re-scoring).

### 6.4 Re-ranking

Score each candidate using user-tunable weights from settings (defaults below
are tuned for typical SillyTavern long-form RP chats):

```
final = w_cosine     * cosine_score          // semantic similarity
      + w_importance * (importance / 10)     // narrative weight
      + w_persist    * (should_persist?1:0)  // long-term flag
      + w_recency    * recency_bonus         // exp decay over msg distance
```

Defaults (settings keys, see §4):
- `eventbase_rerank_w_cosine`     = **0.55**
- `eventbase_rerank_w_importance` = **0.20**
- `eventbase_rerank_w_persist`    = **0.15**
- `eventbase_rerank_w_recency`    = **0.10**

Rationale for defaults:
- Cosine dominates (0.55) so semantic intent leads.
- Importance (0.20) keeps pivotal plot above incidental matches.
- Persist (0.15) gently lifts long-term flagged events.
- Recency (0.10) is intentionally small — old events should still surface
  when relevant in long RPs.

Weights are exposed in the EventBase tab (see §8.1 → Re-rank Weights). At
run-time:
- Read the four weights from settings.
- Normalize so they sum to 1.0 (defensive — UI also enforces this on save).
- Pass into the re-rank function.

Duplicate suppression:
- Same `event_type` + character overlap ≥ 60% → keep highest-scoring one.
- Keep top `eventbase_retrieval_top_k` after re-rank.

### 6.5 Output shape

Return `{ events: EventRecord[], debug: {...} }`. Adapter at the call site
maps this into the existing chunks-shaped object expected by injection.

---

## 7. Prompt injection

`core/eventbase-injection.js` exports `formatEventsForInjection(events, settings)`.

### 7.1 JSON format (default, matches user example)

```json
[
  {
    "event_type": "...",
    "importance": 10,
    "summary": "...",
    "cause": "...",
    "result": "...",
    "characters": ["..."],
    "locations": ["..."],
    "factions": [],
    "items": [],
    "concepts": ["..."],
    "keywords": ["..."],
    "open_threads": ["..."],
    "should_persist": true
  }
]
```

### 7.2 Bullet format (alternative)

```
# Story Memory
- [main_quest_update | importance 10] {summary}
  cause: {cause}
  result: {result}
  chars: {characters}
  open: {open_threads}
```

### 7.3 Budget
- Truncate by `eventbase_inject_max_chars`.
- Drop lowest-scoring events first.
- Always preserve at least the highest-importance event (if any) unless even
  it exceeds the budget (then trim its arrays before dropping).

### 7.4 Insertion
Reuse the existing `setExtensionPrompt(...)` slot used by legacy injection so
the rest of ST sees identical behavior. Tag with the existing
`EXTENSION_PROMPT_TAG` plus suffix `:eventbase` for debug logs.

---

## 8. UI changes (`ui/ui-manager.js`)

### 8.1 Expanded EventBase tab

Sections (each rendered conditionally on `eventbase_enabled`):

1. **Mode**
   - Existing checkbox `vecthare_eventbase_enabled` (Phase 1).
   - Warning hint: enabling switches retrieval/ingestion to a separate
     experimental path; legacy path is bypassed.
2. **Provider**
   - `eventbase_provider` dropdown (`openrouter`, `vllm`).
   - `eventbase_model` text input.
   - `eventbase_vllm_url` (visible only when provider=vllm).
3. **Extraction**
   - `eventbase_window_size` (number 2..20, default 6).
   - `eventbase_window_overlap` (number 0..5, default 1).
   - `eventbase_min_importance_store` (1..10).
   - `eventbase_max_events_per_window` (1..10, default 5) — hint text:
     “Hard upper bound. The AI is instructed to return fewer (or zero) when
     the excerpt is filler / 日常生活 / non-narrative.”
   - `eventbase_temperature`, `eventbase_max_tokens`, `eventbase_timeout_ms`.
4. **Retrieval**
   - `eventbase_retrieval_top_k` (1..32).
   - `eventbase_retrieval_min_importance` (1..10).
   - `eventbase_retrieval_filters_enabled` checkbox.
   - **Re-rank Weights** (4 number inputs, step 0.05, range 0..1):
     - `eventbase_rerank_w_cosine` (default 0.55)
     - `eventbase_rerank_w_importance` (default 0.20)
     - `eventbase_rerank_w_persist` (default 0.15)
     - `eventbase_rerank_w_recency` (default 0.10)
     - Hint text: “Weights are normalized to sum to 1.0 on save. Defaults
       are tuned for long-form SillyTavern RP.”
     - Add a “Reset to defaults” button next to the four inputs.
5. **Injection**
   - `eventbase_inject_format` dropdown (`json`, `bullet`).
   - `eventbase_inject_max_chars` (number).
6. **Debug**
   - `eventbase_debug_logging` checkbox (gates `[EventBase]` console logs).
7. **Browser launcher**
   - Button: “Open Event Browser” → opens read-only modal listing events for
     the current chat with: importance, type, summary, source range, delete.

### 8.2 Wiring
- Bind every input in `bindSettingsEvents` using the existing pattern
  (`Object.assign(extension_settings.vecthareplus, settings); saveSettingsDebounced();`).
- Provider/model toggles must hide/show vLLM URL row dynamically.

### 8.3 Event Browser (`ui/eventbase-browser.js`)
- Query the EventBase collection via `eventbase-store.list({ chatUUID, limit, offset })`.
- Render compact cards: event_type badge, importance bar, summary, source range.
- Actions: inspect (modal with full JSON), delete (calls
  `eventbase-store.deleteByEventId`).
- No editing in this phase.

---

## 9. Branch wiring (replace Phase 1 stubs)

### 9.1 Ingestion (`core/chat-vectorization.js`)

Existing gate (Phase 1) currently throws. Replace with:

```js
if (settings.eventbase_enabled) {
  const { runEventBaseIngestion } = await import('./eventbase-workflow.js');
  return runEventBaseIngestion({
    messages: pendingMessages,
    chatUUID: getChatUUID(),
    settings,
    abortSignal,
  });
}
// ...legacy path unchanged...
```

Apply the same in `core/content-vectorization.js` for orchestrator entry.

### 9.2 Retrieval (`core/core-vector-api.js`)

Inside `queryCollection` (or the unified retrieval entry called from
`rearrangeChat`), replace Phase 1 throw with:

```js
if (settings.eventbase_enabled) {
  const { runEventBaseRetrieval } = await import('./eventbase-workflow.js');
  return runEventBaseRetrieval({ collectionId, searchText, topK, settings });
}
// ...standard or hybrid flow unchanged...
```

Adapter at end maps `{ events, debug }` → the `{ hashes, metadata }` shape
expected by callers.

---

## 10. Tests (`tests/eventbase/`)

Follow existing vitest patterns and factories.

1. `schema.test.js`
   - Validates required fields, importance clamping, vocabulary coercion,
     trim/dedupe behavior.
2. `extractor.test.js`
   - Mocks fetch; asserts JSON-mode request body, prompt content, parse and
     repair logic, error classes.
3. `store.test.js`
   - Mocks `/api/plugins/similharity/chunks/insert` and `/chunks/query`.
   - Verifies payload shape, filter passthrough, idempotent replace.
4. `retrieval.test.js`
   - Re-rank scoring math, filter building from extracted entities,
     duplicate suppression.
5. `injection.test.js`
   - JSON vs bullet formatting, budget truncation, importance preservation.
6. `workflow.test.js`
   - End-to-end with stubbed fetches: 12-message chat → 2 windows →
     inserted events → retrieval returns expected ordering.

---

## 11. Verification checklist

Run after worker AI completes implementation:

1. `npm run check` (lint, jsdoc, css, typecheck) passes.
2. `npm run test -- eventbase` passes.
3. With `eventbase_enabled=false`: byte-for-byte identical legacy behavior
   (sanity check: run a baseline retrieval, compare top-K hashes).
4. With `eventbase_enabled=true` and provider misconfigured: clear
   `EventBaseFatalError` with actionable message; nothing inserted.
5. With proper provider config and a real ~30-message chat:
   - Vectorize → events appear in Event Browser with valid JSON.
   - Trigger generation → injected prompt block visible in ST prompt
     inspector under EventBase tag.
   - Disable EventBase → next generation uses legacy path; events untouched
     in Qdrant.

---

## 12. Worker execution order

Suggested order to keep each step green:

1. `core/eventbase-schema.js` + tests.
2. `core/eventbase-extractor.js` + tests (mocked fetch).
3. `core/eventbase-store.js` + tests (mocked plugin endpoints).
4. `core/eventbase-retrieval.js` + tests.
5. `core/eventbase-injection.js` + tests.
6. Replace stubs in `core/eventbase-workflow.js`; wire into
   `chat-vectorization.js`, `content-vectorization.js`, `core-vector-api.js`.
7. Add settings defaults in `index.js`.
8. Expand EventBase tab UI in `ui/ui-manager.js`; add
   `ui/eventbase-browser.js`.
9. Workflow integration test.
10. `npm run check` + manual verification per §11.

---

## 13. Decisions (locked)

- **Included**: full ingestion + retrieval + injection + browser (read-only).
- **Included**: per-chat collection scoping, importance-based filtering,
  re-rank, budgeted JSON injection.
- **Excluded**: cross-chat global event base, event editing UI, reranker
  model integration, automatic legacy migration.
- **Excluded**: changes to the Similharity plugin — reuse existing
  `/chunks/insert`, `/chunks/query`, `/chunks/delete` endpoints with payload
  metadata + filter passthrough.

### Locked answers (from user, this session)

1. **Embedding model**: reuse the SAME embedding provider + model used by the
   legacy path. No separate EventBase embedding configuration.
2. **Re-rank weights**: user-tunable in the EventBase tab GUI (§8.1 →
   Retrieval section). Defaults 0.55 / 0.20 / 0.15 / 0.10 (cosine /
   importance / persist / recency), tuned for long-form SillyTavern RP.
3. **Language enforcement**: the extraction prompt MUST instruct the AI to
   use the exact same language and script as the excerpt (Traditional
   Chinese stays Traditional, Simplified stays Simplified, Japanese stays
   Japanese, Korean stays Korean, English stays English). Wording is
   non-negotiable and uses ALL-CAPS rule blocks (see §5.3). A post-parse
   script-mismatch guard drops violating events.
4. **Per-window event cap**: hard maximum **5** events per extraction window
   (`eventbase_max_events_per_window` = 5). The prompt explicitly tells the
   AI it MAY (and SHOULD) return fewer events — including zero — when the
   excerpt is filler / 日常生活 / pure intimate-scene with no narrative
   consequence, while extracting events that occur DURING such scenes if
   they carry plot weight (promises, revelations, etc.). Post-parse
   truncation by importance enforces the cap defensively.
