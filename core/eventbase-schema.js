/**
 * ============================================================================
 * EVENTBASE SCHEMA
 * ============================================================================
 * Canonical schema constants, validator, and embed-text builder for EventBase.
 * All extraction, storage, and retrieval depend on this single module.
 * ============================================================================
 */

/**
 * Controlled vocabulary for event_type field.
 * LLM is instructed to map any event to one of these; 'other' is the fallback.
 * @type {readonly string[]}
 */
export const EVENT_TYPES = Object.freeze([
    'main_quest_update',
    'side_quest_update',
    'combat',
    'travel',
    'discovery',
    'dialogue_significant',
    'relationship_change',
    'character_introduction',
    'character_state_change',
    'item_acquired',
    'item_lost',
    'faction_change',
    'location_change',
    'revelation',
    'promise_or_oath',
    'betrayal',
    'death',
    'other',
]);

export const EVENTBASE_SCHEMA_VERSION = 1;

/**
 * Non-fatal extraction parse error (per-window; caller should log + skip).
 */
export class EventBaseExtractionError extends Error {
    /**
     * @param {string} message
     * @param {number} [windowIndex]
     */
    constructor(message, windowIndex = -1) {
        super(message);
        this.name = 'EventBaseExtractionError';
        this.windowIndex = windowIndex;
    }
}

/**
 * Fatal configuration/auth error (aborts entire ingestion run).
 */
export class EventBaseFatalError extends Error {
    /**
     * @param {string} message
     * @param {string} [code]
     */
    constructor(message, code = 'fatal') {
        super(message);
        this.name = 'EventBaseFatalError';
        this.code = code;
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Deduplicate + trim an array of strings; drop empties.
 * @param {unknown} val
 * @returns {string[]}
 */
function ensureArray(val) {
    if (!Array.isArray(val)) return [];
    return [...new Set(val.map(s => (typeof s === 'string' ? s.trim() : String(s ?? '').trim())).filter(Boolean))];
}

/**
 * Normalize optional DateTime field (ISO 8601 string) from LLM output.
 * Accepts DateTime/dateTime/datetime/date_time keys; invalid values become null.
 * @param {unknown} raw
 * @param {string[]} errors
 * @returns {string|null}
 */
function ensureDateTime(raw, errors) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const v = (/** @type {any} */ (raw)).DateTime
        ?? (/** @type {any} */ (raw)).dateTime
        ?? (/** @type {any} */ (raw)).datetime
        ?? (/** @type {any} */ (raw)).date_time
        ?? null;

    if (v == null || v === '') return null;
    const s = String(v).trim();
    const ms = Date.parse(s);
    if (!Number.isNaN(ms)) return new Date(ms).toISOString();

    errors.push(`DateTime "${s}" is not valid ISO-8601 — dropped`);
    return null;
}

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

/**
 * Validates and coerces a raw LLM-produced event object.
 * @param {unknown} raw
 * @returns {{ ok: boolean, errors: string[], event?: import('./eventbase-schema.js').EventRecord }}
 */
export function validateEvent(raw) {
    const errors = [];

    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        const debugInfo = typeof raw === 'string' ? `string "${raw.slice(0, 50)}"` : typeof raw;
        return { ok: false, errors: [`Event is not an object (got ${debugInfo})`] };
    }

    // event_type — coerce unknown to 'other'
    let event_type = String((/** @type {any} */ (raw)).event_type ?? '').trim();
    if (!EVENT_TYPES.includes(event_type)) {
        errors.push(`event_type "${event_type}" not in vocabulary — coerced to "other"`);
        event_type = 'other';
    }

    // importance — number 1-10 integer
    let importance = Number((/** @type {any} */ (raw)).importance);
    if (!Number.isFinite(importance)) {
        errors.push(`importance "${(/** @type {any} */ (raw)).importance}" is not a number — defaulted to 5`);
        importance = 5;
    } else {
        const clamped = Math.round(Math.max(1, Math.min(10, importance)));
        if (clamped !== Math.round(importance)) {
            errors.push(`importance clamped from ${importance} to ${clamped}`);
        }
        importance = clamped;
    }

    // summary — required non-empty string
    const summary = typeof (/** @type {any} */ (raw)).summary === 'string' ? (/** @type {any} */ (raw)).summary.trim() : '';
    if (!summary) {
        return { ok: false, errors: ['summary is empty or missing'] };
    }

    const concepts = ensureArray((/** @type {any} */ (raw)).concepts);
    const rawKeywords = ensureArray((/** @type {any} */ (raw)).keywords);

    // Merge concepts into keywords (case-insensitive dedup) so concept terms are
    // always searchable via the keyword index even if the LLM forgot to copy them
    // over. Characters/locations/items are NOT merged — they appear in the embed
    // text already and would dominate keyword recall with generic name matches.
    const seen = new Set(rawKeywords.map(k => k.toLowerCase()));
    const mergedKeywords = [...rawKeywords];
    for (const c of concepts) {
        const key = c.toLowerCase();
        if (!seen.has(key)) {
            seen.add(key);
            mergedKeywords.push(c);
        }
    }

    const event = {
        event_type,
        importance,
        summary,
        DateTime: ensureDateTime(raw, errors),
        cause: typeof (/** @type {any} */ (raw)).cause === 'string' ? (/** @type {any} */ (raw)).cause.trim() : '',
        result: typeof (/** @type {any} */ (raw)).result === 'string' ? (/** @type {any} */ (raw)).result.trim() : '',
        characters: ensureArray((/** @type {any} */ (raw)).characters),
        locations: ensureArray((/** @type {any} */ (raw)).locations),
        factions: ensureArray((/** @type {any} */ (raw)).factions),
        items: ensureArray((/** @type {any} */ (raw)).items),
        concepts,
        keywords: mergedKeywords,
        open_threads: ensureArray((/** @type {any} */ (raw)).open_threads),
        should_persist: (/** @type {any} */ (raw)).should_persist === true,
    };

    return { ok: true, errors, event };
}

// ---------------------------------------------------------------------------
// Embed-text builder
// ---------------------------------------------------------------------------

/**
 * Builds the deterministic text string used for embedding an event.
 * Empty fields are skipped so they don't dilute the semantic signal.
 * @param {object} event
 * @returns {string}
 */
export function buildEmbedText(event) {
    const parts = [`[${event.event_type}] ${event.summary}`];
    if (event.DateTime) parts.push(`TIME: ${event.DateTime}`);
    if (event.cause) parts.push(`CAUSE: ${event.cause}`);
    if (event.result) parts.push(`RESULT: ${event.result}`);
    if (event.characters?.length) parts.push(`CHARS: ${event.characters.join(', ')}`);
    if (event.locations?.length) parts.push(`LOCS: ${event.locations.join(', ')}`);
    if (event.items?.length) parts.push(`ITEMS: ${event.items.join(', ')}`);
    if (event.keywords?.length) parts.push(`KEYS: ${event.keywords.join(', ')}`);
    if (event.open_threads?.length) parts.push(`THREADS: ${event.open_threads.join(', ')}`);
    return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Extraction prompt builder
// ---------------------------------------------------------------------------

/**
 * The built-in default extraction prompt template.
 * Use {{maxCount}} and {{text}} as placeholders — they are replaced at runtime.
 * Exposed so the UI can pre-fill the custom prompt textarea with this value.
 */
export const DEFAULT_EXTRACTION_PROMPT = `You are a story event archivist for a roleplay session. Extract ONLY narratively significant story events from the excerpt below.

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

2. EVENT COUNT:
   - Return AT MOST {{maxCount}} events.
   - Return as many real events as actually occurred — do not artificially cap or pad.
   - Zero events ([]) is correct only when the excerpt is pure filler with no character interaction, relationship movement, world information, or narrative consequence whatsoever.
   - DO NOT invent events. DO NOT duplicate the same event under different names.

3. WHEN TO RETURN ZERO EVENTS ([]):
   Return [] if BOTH of the following are true:
   a) The excerpt does not contain any event that maps to the defined event_type list above.
   OR
   b) It does map to an event_type, but the event has no lasting consequence worth retrieving later.

   THE ONE-WEEK TEST — ask yourself: "If someone reads this story one week from now, would knowing this event change their understanding of the characters, world, or plot?"
   - If YES → extract it.
   - If NO → skip it.

   Examples that FAIL the test (return []):
   - The party has dinner at home with no plot discussion.
   - The main character teases the heroine playfully with no consequence.
   - Characters chat about the weather or daily routine.

   Examples that PASS the test (extract):
   - Main character pays for the heroine's freedom (贖身) — her status permanently changed.
   - A promise or oath is made — it shapes future obligations.
   - A character's inner fear or secret is revealed — it reframes past or future behaviour.

   Sexual / intimate scenes: return [] UNLESS the scene contains a confession, promise, relationship change, revelation, or any narrative consequence that would still matter one week later. The intimacy itself is not the event — extract only what changes.

=========================
OUTPUT SCHEMA
=========================
Return ONLY a valid JSON array. No prose. No markdown. No code fences.

Each event object MUST have these fields:
- event_type: one of [main_quest_update, side_quest_update, combat, travel, discovery, dialogue_significant, relationship_change, character_introduction, character_state_change, item_acquired, item_lost, faction_change, location_change, revelation, promise_or_oath, betrayal, death, other]
- importance: integer 1-10 (10 = pivotal main plot, 1 = minor flavor worth remembering)
- summary: 2-8 dense sentences capturing WHO did WHAT, the key detail, the emotional/narrative impact, and any important consequences or reactions. SAME LANGUAGE AS EXCERPT (see Rule 1)
- cause: short explanation of why it happened, SAME LANGUAGE AS EXCERPT (may be "")
- result: outcome / state change, SAME LANGUAGE AS EXCERPT (may be "")
- characters: array of proper-noun names, EXACT ORIGINAL SCRIPT
- locations: array of strings, EXACT ORIGINAL SCRIPT
- factions: array of strings, EXACT ORIGINAL SCRIPT
- DateTime: in the format of ISO 8601 string (e.g., "2024-01-01T12:00:00Z") representing when the event occurred in the story timeline, if it can be determined from the excerpt; otherwise, this field can be omitted or set to null. 
- items: array of strings, EXACT ORIGINAL SCRIPT
- concepts: array of strings, SAME LANGUAGE AS EXCERPT
- keywords: array of 8-15 strings, SAME LANGUAGE AS EXCERPT. These are search aids used by a keyword retrieval engine — be GENEROUS and INCLUSIVE. Include every distinctive term that a future query about this event might use: key actions/verbs (e.g. 贖身/誓言/背叛 or "ransom"/"oath"/"betray"), distinctive objects/items mentioned, emotional or thematic tags (e.g. 崩潰/忠誠/恐懼 or "breakdown"/"loyalty"/"fear"), unique concepts, and any rare/specific noun that isn't generic filler. DO NOT pad with generic words (the/and/then/我/你). Quality matters but err on the side of MORE rather than fewer — sparse keywords cause retrieval misses. NOTE: the Chinese terms above are only illustrative — the example below is in Traditional Chinese, but if the excerpt is in English/Japanese/Korean/etc., write keywords in that language. NEVER mix Chinese keywords into a non-Chinese excerpt's output.
- open_threads: array of strings, SAME LANGUAGE AS EXCERPT (unresolved questions/promises)
- should_persist: boolean (false for ephemeral moments unlikely to matter later)

=========================
VALID OUTPUT EXAMPLES
=========================
Zero events (filler scene):
[]

One event (Traditional Chinese excerpt):
[{"event_type":"promise_or_oath","importance":9,"summary":"師傅承諾幫梅拉尋找失蹤的父親暗影之翼。","cause":"梅拉在房間中央哭著請求幫助。","result":"尋找暗影之翼成為隊伍的核心目標。","characters":["梅拉","師父"],"locations":["星月綠洲頂樓公寓"],"factions":[],"DateTime":"2024-05-01T20:30:00Z","items":[],"concepts":["失蹤的父親"],"keywords":["暗影之翼","尋找父親","承諾","哭泣","請求","失蹤","核心目標","隊伍任務","誓言","親情"],"open_threads":["確定暗影之翼是生是死"],"should_persist":true}]

=========================
EXCERPT
=========================
{{text}}`;

/**
 * Builds the LLM extraction prompt for a given excerpt.
 * If settings.eventbase_custom_prompt is non-empty, it is used as the template
 * with `{{text}}` and `{{maxCount}}` replaced. Otherwise the built-in default is used.
 * @param {string} text  - The chat excerpt (already joined messages)
 * @param {number} maxCount - Max events to return (eventbase_max_events_per_window)
 * @param {string} [customPrompt] - Optional custom prompt template from settings
 * @returns {string}
 */
export function buildExtractionPrompt(text, maxCount, customPrompt = '') {
    const template = (customPrompt && customPrompt.trim()) ? customPrompt : DEFAULT_EXTRACTION_PROMPT;
    return template
        .replace(/\{\{maxCount\}\}/g, String(maxCount))
        .replace(/\{\{text\}\}/g, text);
}
