/**
 * ============================================================================
 * EVENTBASE INJECTION
 * ============================================================================
 * Formats retrieved EventRecord objects into a prompt block for injection.
 *
 * Two formats:
 *  - 'json'   : Full JSON array (matches the user's example format exactly)
 *  - 'bullet' : Compact bullet-point summary
 *
 * Budget enforcement: drops lowest-scoring events first. If even the
 * highest-importance event exceeds the budget, its arrays are trimmed.
 * ============================================================================
 */

// ---------------------------------------------------------------------------
// JSON format
// ---------------------------------------------------------------------------

/**
 * Strip internal scoring/ingestion fields that should not be injected.
 * Returns only the canonical EventRecord fields.
 * @param {object} event
 * @returns {object}
 */
function _cleanEventForInjection(event) {
    return {
        event_type: event.event_type,
        importance: event.importance,
        summary: event.summary,
        cause: event.cause || '',
        result: event.result || '',
        characters: event.characters || [],
        locations: event.locations || [],
        factions: event.factions || [],
        items: event.items || [],
        concepts: event.concepts || [],
        keywords: event.keywords || [],
        open_threads: event.open_threads || [],
        should_persist: event.should_persist === true,
    };
}

/**
 * Format events as a JSON array string (canonical format).
 * @param {object[]} events
 * @returns {string}
 */
function _formatAsJson(events) {
    return JSON.stringify(events.map(_cleanEventForInjection), null, 2);
}

// ---------------------------------------------------------------------------
// Bullet format
// ---------------------------------------------------------------------------

/**
 * Format events as compact human-readable bullet points.
 * @param {object[]} events
 * @returns {string}
 */
function _formatAsBullet(events) {
    const lines = ['# Story Memory'];
    for (const e of events) {
        lines.push(`\n- [${e.event_type} | importance ${e.importance}] ${e.summary}`);
        if (e.cause) lines.push(`  cause: ${e.cause}`);
        if (e.result) lines.push(`  result: ${e.result}`);
        if (e.characters?.length) lines.push(`  characters: ${e.characters.join(', ')}`);
        if (e.locations?.length) lines.push(`  locations: ${e.locations.join(', ')}`);
        if (e.open_threads?.length) lines.push(`  open: ${e.open_threads.join(', ')}`);
    }
    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Budget enforcement
// ---------------------------------------------------------------------------

/**
 * Trim an event's array fields to reduce character count.
 * Used as last resort before dropping the highest-importance event.
 * @param {object} event
 * @returns {object}
 */
function _trimEventArrays(event) {
    return {
        ...event,
        concepts: [],
        keywords: [],
        factions: [],
        open_threads: (event.open_threads || []).slice(0, 1),
        characters: (event.characters || []).slice(0, 3),
        locations: (event.locations || []).slice(0, 2),
        items: (event.items || []).slice(0, 2),
    };
}

// ---------------------------------------------------------------------------
// Main formatter
// ---------------------------------------------------------------------------

/**
 * Format retrieved events into a prompt injection string.
 * Applies character budget: drops lowest-scoring events first.
 *
 * @param {object[]} events   - Re-ranked EventRecord objects (highest score first)
 * @param {object}   settings - VectHare settings
 * @returns {string}          - Formatted string ready for injection (empty string if nothing fits)
 */
export function formatEventsForInjection(events, settings) {
    if (!events?.length) return '';

    const format = (settings.eventbase_inject_format || 'json').toLowerCase();
    const maxChars = settings.eventbase_inject_max_chars || 4000;

    const formatFn = format === 'bullet' ? _formatAsBullet : _formatAsJson;

    // Try including all events; if over budget, drop from lowest score upwards
    let included = events.slice();

    while (included.length > 0) {
        const text = formatFn(included);
        if (text.length <= maxChars) return text;
        included = included.slice(0, included.length - 1);
    }

    // Even a single event exceeds budget — trim its arrays and try once more
    if (events.length > 0) {
        const trimmed = _trimEventArrays(events[0]);
        const text = formatFn([trimmed]);
        if (text.length <= maxChars) return text;
        // As absolute last resort, return just the summary
        return `[${events[0].event_type} | imp:${events[0].importance}] ${events[0].summary}`.slice(0, maxChars);
    }

    return '';
}
