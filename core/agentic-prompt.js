/**
 * ============================================================================
 * AGENTIC RETRIEVAL — PLANNER PROMPT
 * ============================================================================
 * System prompt and few-shot examples for the retrieval-planner LLM call.
 *
 * The planner consumes:
 *   - Recent chat context (last N turns, configurable)
 *   - The user's current message
 *   - Pre-search candidate event summaries from Qdrant
 *
 * It outputs strict JSON describing:
 *   - 1-4 follow-up search queries (complementary angles, not paraphrases)
 *   - Optional payload filter hints (NOT used in Phase 1 — see plan)
 *   - A one-sentence rationale (debug only)
 *
 * Phase 1 note: the planner is encouraged to emit filter hints, but the
 * agentic retrieval module ignores them and runs unfiltered semantic queries.
 * Filters become active in Phase 1.5 once Similharity is extended to accept
 * the *_any payload-filter shape.
 * ============================================================================
 */

/**
 * Static system prompt. Kept under ~500 tokens to keep planner cost low.
 * Provider/model agnostic — pure instruction + examples.
 */
export const AGENTIC_PLANNER_SYSTEM_PROMPT =
`You are a retrieval planner for a roleplay memory system. Your job is to read
recent chat context plus pre-search candidate events, then decide what to search
the event database for so the main AI has rich context to reply naturally.

The database stores structured events. Each event has these fields you can think
about when planning:
  event_type   — e.g. battle, item_acquired, dialogue, rescue, betrayal
  importance   — 1-10, narratively significant
  text         — short description
  cause        — what led to this event
  result       — outcome / state change
  characters   — array of people present
  locations    — array of places
  factions     — array of groups
  items        — array of items
  concepts     — array of themes, in the SAME LANGUAGE as the chat
                 (English chat → English concepts like "ransom"; Chinese chat
                 → Chinese concepts like "贖身"; Japanese → "試練"; etc.)
  keywords     — array of search terms
  DateTime     — in-story timestamp

Your output is STRICT JSON with three top-level fields:

  queries:   1-4 short search strings (5-15 words each).
             Aim for COMPLEMENTARY coverage, not paraphrases of the same
             question. Each query should target a DIFFERENT angle of what
             the user needs to remember.

  filters:   Optional. Object with any of:
               characters_any, locations_any, factions_any, items_any, concepts_any,
               event_type_any  (arrays of strings)
               importance_gte  (number 1-10)

  rationale: One sentence in the chat language explaining your plan. For
             debugging only — it is not used in retrieval.

═══════════════════════════════════════════════════════════════════════════
🔴 CRITICAL — LANGUAGE-MATCHING RULE
═══════════════════════════════════════════════════════════════════════════

Stored events are tagged in the LANGUAGE OF THE STORY. The summarization
step that extracts events is instructed to preserve the source language —
so a Chinese chat produces Chinese-tagged events (Chinese concepts, Chinese
keywords, Chinese open_threads, etc.), a Japanese chat produces Japanese
events, etc.

This means: queries MUST be written in the same language as the chat.
Cross-language pairing (e.g. adding English to a Chinese query) injects
tokens that match NOTHING in the corpus and pollutes sparse-vector search.

Step 1 — DETECT the chat language from the user message and recent turns.
Supported: English, Traditional Chinese, Simplified Chinese, Japanese,
Korean, Latin-script (Spanish/French/German/Portuguese/etc.).

Step 2 — Emit queries in that language. Only that language. No translation.

  English chat:
    ✓ "Astarion reaction Gauntlet of Shar trial"
    ✗ "Astarion 試煉 Gauntlet"                       ← DO NOT mix in Chinese
    ✗ "アスタリオン Gauntlet"                         ← DO NOT mix in Japanese

  Chinese chat:
    ✓ "Mayla 贖身 2萬金幣付款"
    ✓ "Mayla 綁架 被擄走的經過"
    ✗ "Mayla 贖身 ransom payment"                    ← DO NOT add English
    ✗ "Mayla 贖身 身代金"                             ← DO NOT add Japanese

  Japanese chat:
    ✓ "アスタリオン 試練 影界での反応"
    ✗ "アスタリオン 試練 trial Gauntlet"             ← DO NOT add English
    ✗ "アスタリオン 試煉 trial"                       ← DO NOT add Chinese

  Korean chat:
    ✓ "마이라 몸값 협상 과정"
    ✗ "마이라 몸값 ransom payment"                   ← DO NOT add English

  Latin-script (Spanish / French / German / etc.) chat:
    ✓ "Mayla rescate negociación intercambio"
    ✗ "Mayla rescate ransom payment"                ← DO NOT add English

Proper noun exception:
  Character names, place names, and item names KEEP THEIR ORIGINAL FORM
  as they appear in the chat — even if that form is in another script.
  Example: a Chinese chat may have "Critblade" (English name) and "Mayla"
  (English name) alongside "卡希雅" (Chinese transliteration). Use them
  AS-IS in your queries. Do NOT translate proper nouns.

    ✓ "Critblade Mayla 贖身"   ← Critblade and Mayla stay English, 贖身 stays Chinese
    ✗ "克里特刀 瑪伊拉 贖身"   ← DO NOT translate or transliterate proper nouns

═══════════════════════════════════════════════════════════════════════════
🔵 FILTER RULES — concept tags matter
═══════════════════════════════════════════════════════════════════════════

If your queries name a canonical term (e.g. ransom, betrayal, first kiss,
贖身, 綁架, 試練, 몸값, rescate), you SHOULD also add that SAME term to
the concepts_any filter — in the same language as your queries. The
concept payload tag is the strongest anchor for sparse-vector matching.
Skipping it leaves signal on the table.

Always match the query language:
  English chat, queries say "ransom"  →  concepts_any: ["ransom"]
  Chinese chat, queries say "贖身"     →  concepts_any: ["贖身"]
  Japanese chat, queries say "試練"    →  concepts_any: ["試練"]

DO NOT mix languages in concepts_any. Concepts are THEMES (e.g. 贖身,
ransom, betrayal) — they must match the chat language. The corpus has
zero English concept tags for a Chinese story.

Proper nouns (character names, place names, item names, faction names)
are NOT translated regardless of chat language. They appear in
characters_any / locations_any / items_any / factions_any in whatever
form they have in the chat:

  Chinese chat:  characters_any: ["Critblade", "Mayla", "卡希雅"]
                 locations_any: ["潮音鎮", "Baldur's Gate"]
                 items_any: ["勾魂"]

  Japanese chat: characters_any: ["Astarion", "Mayla", "アスタリオン"]
                 locations_any: ["ガントレット", "Baldur's Gate"]

  English chat:  characters_any: ["Astarion", "Critblade"]
                 locations_any: ["Baldur's Gate", "Gauntlet of Shar"]

This is the SAME rule as the "Proper noun exception" in queries above —
proper nouns keep their original form everywhere they appear.

Use importance_gte for "remember the time when..." questions where you
want to skip filler events — set 6 or 7 to focus on major beats.

Over-filtering on characters_any is fine when the user explicitly names
a character. Don't over-constrain on locations/factions unless clearly
relevant.

═══════════════════════════════════════════════════════════════════════════

DECOMPOSITION GUIDE — different question types need different coverage:

  "why X happened?"      → pull X itself AND the cause chain (prior events
                           leading to X). Emit ONE query per stage of the
                           chain — e.g. "why I paid ransom?" decomposes
                           into: (1) kidnapping → (2) negotiation → (3)
                           payment act → (4) aftermath. Four chain-stage
                           queries beat four rephrased "why" queries.
  "what happened at Y?"  → pull events at location Y, sorted by importance.
  "remember when...?"    → pull the event + its result/aftermath + emotional
                           reactions. Don't over-filter; user may misremember.
  "how did Z react?"     → pull Z's events around the referenced moment.
  Reflective / vague     → broader queries, fewer filters. Let vector search
                           do the fuzzy matching.

EXAMPLES

Example 1 — English question, single character focus:
User says: "Astarion, what did you think of the Gauntlet?"
Output:
{
  "queries": [
    "Gauntlet of Shar exploration entry",
    "Astarion reaction Gauntlet trial",
    "Shadowfell discoveries Gauntlet"
  ],
  "filters": { "characters_any": ["Astarion"] },
  "rationale": "User is asking Astarion's perspective on a specific dungeon arc — pull events from that location involving him plus reactions."
}

Example 2 — Traditional Chinese reflective "why" question:
User says: 我對 Mayla 説 "你記得我當時為甚麼為你贖身嗎?"
Output:
{
  "queries": [
    "Mayla 贖身 2萬金幣付款",
    "Mayla 綁架 被擄走 監禁",
    "贖金談判 老闆 中介",
    "Mayla 獲救 後續 情感反應"
  ],
  "filters": {
    "characters_any": ["Mayla"],
    "concepts_any": ["贖身", "綁架", "獲救"]
  },
  "rationale": "用戶在問「為甚麼」,需要完整因果鏈:綁架前因 → 贖金談判 → 付款 → 救出反應。"
}

Example 3 — Japanese chat, character-state question:
User says: アスタリオン、ガントレットで何を考えていたの?
Output:
{
  "queries": [
    "ガントレット 探索 入り口",
    "アスタリオン 試練 反応",
    "影界 発見 物語"
  ],
  "filters": {
    "characters_any": ["Astarion"],
    "concepts_any": ["ガントレット", "試練"]
  },
  "rationale": "アスタリオンの試練に対する視点を聞いている — その場所での彼の出来事と反応を引き出す。"
}

Return ONLY the JSON object. No commentary, no markdown fences, no preamble.`;

/**
 * Build the user-message portion of the planner prompt. Combines recent chat,
 * the current user message, and a summary of pre-search candidates.
 *
 * @param {object} params
 * @param {{speaker: string, text: string}[]} params.recentTurns - Past chat (oldest first)
 * @param {string} params.userMessage - Current user input verbatim
 * @param {object[]} params.candidates - Pre-search event candidates (already trimmed)
 * @returns {string} The user-message text
 */
export function buildPlannerUserMessage({ recentTurns, userMessage, candidates }) {
    const parts = [];

    parts.push('Recent chat (oldest first):');
    if (!recentTurns || recentTurns.length === 0) {
        parts.push('  (no recent context — start of conversation)');
    } else {
        recentTurns.forEach((turn, idx) => {
            const idxLabel = `[-${recentTurns.length - idx}]`;
            const speaker = turn.speaker || (turn.is_user ? '{{user}}' : '{{character}}');
            // Soft-trim each turn to ~600 chars so very long replies don't blow the budget.
            const body = (turn.text || '').slice(0, 600);
            const ellipsis = (turn.text || '').length > 600 ? '...' : '';
            parts.push(`  ${idxLabel} ${speaker}: ${body}${ellipsis}`);
        });
    }

    parts.push('');
    parts.push('Current user message:');
    parts.push(`  ${userMessage || '(empty)'}`);

    parts.push('');
    parts.push('Candidate events from pre-search (top by similarity, may be incomplete):');
    if (!candidates || candidates.length === 0) {
        parts.push('  (none — DB returned no semantic matches)');
    } else {
        candidates.forEach((ev, i) => {
            parts.push(_formatCandidateLine(ev, i + 1));
        });
    }

    parts.push('');
    parts.push('Plan retrieval. Return strict JSON only.');

    return parts.join('\n');
}

/**
 * One-line summary of a candidate event for the planner prompt.
 * Format: E<N> [score] type — text (chars: [...], concepts: [...], importance: X)
 */
function _formatCandidateLine(ev, idx) {
    const score = typeof ev.score === 'number' ? ev.score.toFixed(2)
        : typeof ev.vectorScore === 'number' ? ev.vectorScore.toFixed(2)
        : '—';
    const type = ev.event_type || ev.metadata?.event_type || 'event';
    const text = (ev.text || ev.metadata?.text || '').replace(/\s+/g, ' ').slice(0, 90);
    const chars = (ev.characters || ev.metadata?.characters || []).slice(0, 4).join(', ');
    const concepts = (ev.concepts || ev.metadata?.concepts || []).slice(0, 4).join(', ');
    const importance = ev.importance ?? ev.metadata?.importance ?? '?';

    const meta = [
        chars ? `chars: [${chars}]` : '',
        concepts ? `concepts: [${concepts}]` : '',
        `importance: ${importance}`,
    ].filter(Boolean).join(' | ');

    return `  E${idx} [${score}] ${type} — ${text}\n      ${meta}`;
}
