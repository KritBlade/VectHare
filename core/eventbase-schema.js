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
        return { ok: false, errors: ['Event is not an object'] };
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

    const event = {
        event_type,
        importance,
        summary,
        cause: typeof (/** @type {any} */ (raw)).cause === 'string' ? (/** @type {any} */ (raw)).cause.trim() : '',
        result: typeof (/** @type {any} */ (raw)).result === 'string' ? (/** @type {any} */ (raw)).result.trim() : '',
        characters: ensureArray((/** @type {any} */ (raw)).characters),
        locations: ensureArray((/** @type {any} */ (raw)).locations),
        factions: ensureArray((/** @type {any} */ (raw)).factions),
        items: ensureArray((/** @type {any} */ (raw)).items),
        concepts: ensureArray((/** @type {any} */ (raw)).concepts),
        keywords: ensureArray((/** @type {any} */ (raw)).keywords),
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
 * Builds the LLM extraction prompt for a given excerpt.
 * @param {string} text  - The chat excerpt (already joined messages)
 * @param {number} maxCount - Max events to return (eventbase_max_events_per_window)
 * @returns {string}
 */
export function buildExtractionPrompt(text, maxCount) {
    return `You are a story event archivist for a roleplay session. Extract ONLY narratively significant story events from the excerpt below.

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
   - Return AT MOST ${maxCount} events.
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
${text}`;
}
