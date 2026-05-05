/**
 * ============================================================================
 * EVENTBASE INJECTION
 * ============================================================================
 * Formats retrieved EventRecord objects into a JSON prompt block for injection.
 * No hard character budget is enforced — Top-K and retrieval filters control
 * payload size.
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
        DateTime: event.DateTime || null,
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
// Main formatter
// ---------------------------------------------------------------------------

/**
 * Format retrieved events into a prompt injection string.
 * No hard cap is applied here; Top-K and retrieval filters control payload size.
 *
 * @param {object[]} events   - Re-ranked EventRecord objects (highest score first)
 * @param {object}   settings - VectHare settings
 * @returns {string}          - Formatted string ready for injection (empty string if nothing fits)
 */
export function formatEventsForInjectionDetailed(events, _settings) {
    if (!events?.length) {
        return { text: '', includedCount: 0, requestedCount: 0 };
    }

    const text = _formatAsJson(events);
    return {
        text,
        includedCount: events.length,
        requestedCount: events.length,
    };
}

/**
 * Backward-compatible wrapper that returns only the formatted text.
 * @param {object[]} events
 * @param {object} settings
 * @returns {string}
 */
export function formatEventsForInjection(events, settings) {
    return formatEventsForInjectionDetailed(events, settings).text;
}
