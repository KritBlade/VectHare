/**
 * ============================================================================
 * PROMPTS I18N — Language-specific prompt variants
 * ============================================================================
 * Single source of truth for all localised prompt strings.
 *
 * Both the agentic planner and the summarizer pick their system prompt from
 * here based on the user's CJK Tokenizer Mode setting, which doubles as the
 * "story language" selector.
 *
 * Supported modes (mirrors CJK_TOKENIZER_MODES in bm25-scorer.js):
 *   intl            → English / Latin           (English examples)
 *   jieba           → Simplified Chinese         (简体中文 examples)
 *   jieba_tw        → Traditional Chinese        (繁體中文 examples)
 *   tiny_segmenter  → Japanese                   (日本語 examples)
 *   korean          → Korean                     (한국어 examples)
 *   others          → Any other language          (English examples + language notice)
 * ============================================================================
 */

// ─────────────────────────────────────────────────────────────────────────────
// AGENTIC PLANNER SYSTEM PROMPT
// ─────────────────────────────────────────────────────────────────────────────
// Shared structural header — output format, filter rules, question type guide.
// Language rule + examples are in the per-language blocks below.

const _PLANNER_HEADER =
`You are a retrieval planner for a roleplay memory system. Read recent chat plus pre-search candidate events, then decide what to search the event database for.

Filterable event fields: event_type, importance (1–10), characters, locations, factions, items, concepts (themes), keywords, DateTime.

Output STRICT JSON with exactly three fields:

  queries    1–4 short search strings (5–15 words). Cover DIFFERENT angles — not paraphrases.

  filters    Optional:
               characters_any, locations_any, factions_any, items_any, concepts_any,
               event_type_any  — arrays of strings
               importance_gte  — number 1–10

  rationale  One sentence in the story language. Debug only — not used in retrieval.

══ FILTER RULES ══════════════════════════════════════════════════════

concepts_any = THEME words in the story language.
  • Never mix languages here. Never put proper nouns here.
  • If a theme word appears in your queries, also put it in concepts_any — it is the
    strongest anchor for sparse-vector matching.

characters_any / locations_any / items_any / factions_any = proper nouns in whatever
form they appear in the chat (keep original script/spelling).

importance_gte: set 6–7 to skip filler events for "remember when…" questions.
Over-filtering on characters_any is fine; avoid over-constraining locations/factions.

══ QUESTION TYPE GUIDE ═══════════════════════════════════════════════

  "why X?"        → one query per causal stage: cause → act → aftermath
  "at location?"  → events at that place
  "remember...?"  → event + result + reactions; don't over-filter (user may misremember)
  "Z's reaction?" → Z's events around that moment
  Vague/open      → broad queries, fewer filters

`;

const _PLANNER_FOOTER =
`Return ONLY the JSON object. No commentary, no markdown fences, no preamble.`;

// ── Per-language EXAMPLES blocks ─────────────────────────────────────────────

const _PLANNER_EXAMPLES_INTL =
`══ LANGUAGE RULE ═════════════════════════════════════════════════════
Write ALL queries in English. Never mix languages.
Proper nouns (names, places, items) keep their exact form from the chat.

══ EXAMPLES ══════════════════════════════════════════════════════════

Example 1 — Single character focus:
User: "Astarion, what did you think of the Gauntlet?"
{
  "queries": [
    "Gauntlet of Shar exploration entry",
    "Astarion reaction Gauntlet trial",
    "Shadowfell discoveries Gauntlet"
  ],
  "filters": { "characters_any": ["Astarion"] },
  "rationale": "Pulling Gauntlet events involving Astarion and his reactions."
}

Example 2 — Causal "why" chain:
User: "Do you remember why we had to pay the ransom?"
{
  "queries": [
    "kidnapping ransom payment negotiation",
    "hostage capture arrest imprisonment",
    "rescue aftermath emotional reaction"
  ],
  "filters": {
    "concepts_any": ["ransom", "kidnapping", "rescue"]
  },
  "rationale": "Tracing the causal chain: capture → negotiation → payment → rescue."
}

`;

const _PLANNER_EXAMPLES_JIEBA_TW =
`══ 語言規則 ══════════════════════════════════════════════════════════
所有 queries 及 concepts_any 必須以繁體中文書寫，不得混入英文或其他語言。
例外：人名、地名、物品名稱保留原文形式（英文名稱不翻譯）。

══ EXAMPLES ══════════════════════════════════════════════════════════

Example 1 — 因果「為何」鏈：
User: 我對 Mayla 説 "你記得我當時為甚麼為你贖身嗎?"
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
  "rationale": "因果鏈：綁架→談判→付款→救出反應。"
}

Example 2 — 單一角色焦點：
User: "你記得我們在城堡裡發現了什麼嗎？"
{
  "queries": [
    "城堡 探索 秘密發現",
    "城堡 陷阱 危機 事件",
    "城堡 寶物 重要物品"
  ],
  "filters": {
    "locations_any": ["城堡"],
    "concepts_any": ["探索", "發現"]
  },
  "rationale": "搜尋城堡相關探索事件與重要發現。"
}

`;

const _PLANNER_EXAMPLES_JIEBA =
`══ 语言规则 ══════════════════════════════════════════════════════════
所有 queries 及 concepts_any 必须以简体中文书写，不得混入英文或其他语言。
例外：人名、地名、物品名称保留原文形式（英文名称不翻译）。

══ EXAMPLES ══════════════════════════════════════════════════════════

Example 1 — 因果"为何"链：
User: 我对 Mayla 说 "你还记得我当时为什么为你赎身吗?"
{
  "queries": [
    "Mayla 赎身 2万金币付款",
    "Mayla 绑架 被掳走 监禁",
    "赎金谈判 老板 中介",
    "Mayla 获救 后续 情感反应"
  ],
  "filters": {
    "characters_any": ["Mayla"],
    "concepts_any": ["赎身", "绑架", "获救"]
  },
  "rationale": "因果链：绑架→谈判→付款→救出反应。"
}

Example 2 — 单一角色焦点：
User: "你还记得我们在城堡里发现了什么吗？"
{
  "queries": [
    "城堡 探索 秘密发现",
    "城堡 陷阱 危机 事件",
    "城堡 宝物 重要物品"
  ],
  "filters": {
    "locations_any": ["城堡"],
    "concepts_any": ["探索", "发现"]
  },
  "rationale": "搜索城堡相关探索事件与重要发现。"
}

`;

const _PLANNER_EXAMPLES_TINY_SEGMENTER =
`══ 言語ルール ════════════════════════════════════════════════════════
queriesおよびconcepts_anyはすべて日本語で記述する。他の言語を混在させない。
例外：人名・地名・物品名は会話中の元の表記をそのまま使用する。

══ EXAMPLES ══════════════════════════════════════════════════════════

Example 1 — キャラクター焦点の質問：
User: アスタリオン、ガントレットで何を考えていたの?
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
  "rationale": "アスタリオンのガントレット体験と反応を引き出す。"
}

Example 2 — 因果「なぜ」チェーン：
User: "なぜあのとき身代金を払わなければならなかったの覚えてる？"
{
  "queries": [
    "身代金 誘拐 拘束 監禁",
    "交渉 支払い 解放 救出",
    "救出 後の感情 反応 関係"
  ],
  "filters": {
    "concepts_any": ["身代金", "誘拐", "救出"]
  },
  "rationale": "誘拐→交渉→支払い→救出という因果連鎖を追う。"
}

`;

const _PLANNER_EXAMPLES_KOREAN =
`══ 언어 규칙 ════════════════════════════════════════════════════════
모든 queries 및 concepts_any는 한국어로만 작성한다. 다른 언어를 섞지 않는다.
예외: 인명·지명·아이템명은 대화에서 사용된 원래 표기를 그대로 유지한다.

══ EXAMPLES ══════════════════════════════════════════════════════════

Example 1 — 단일 캐릭터 집중:
User: "아스타리온, 건틀릿에서 무슨 생각을 했어?"
{
  "queries": [
    "건틀릿 탐험 입장 과정",
    "아스타리온 시련 반응",
    "어둠의 땅 발견 사건"
  ],
  "filters": {
    "characters_any": ["Astarion"],
    "concepts_any": ["건틀릿", "시련"]
  },
  "rationale": "아스타리온의 건틀릿 경험과 반응을 검색한다."
}

Example 2 — 인과 「왜」 체인:
User: "우리가 왜 몸값을 내야 했는지 기억해?"
{
  "queries": [
    "납치 몸값 협상 지불",
    "인질 체포 감금 구금",
    "구출 이후 감정 반응"
  ],
  "filters": {
    "concepts_any": ["몸값", "납치", "구출"]
  },
  "rationale": "납치→협상→지불→구출 인과 사슬을 추적한다."
}

`;

const _PLANNER_EXAMPLES_OTHERS =
`══ LANGUAGE RULE ═════════════════════════════════════════════════════
Detect the story language from the chat. Write ALL queries and concepts_any
in that language only. Do NOT default to English — match the roleplay language.
Proper nouns (names, places, items) keep their exact form from the chat.

══ EXAMPLES (shown in English — apply the same pattern in your detected language) ══

Example 1 — Single character focus:
User: "Astarion, what did you think of the Gauntlet?"
{
  "queries": [
    "Gauntlet of Shar exploration entry",
    "Astarion reaction Gauntlet trial",
    "Shadowfell discoveries Gauntlet"
  ],
  "filters": { "characters_any": ["Astarion"] },
  "rationale": "Pulling Gauntlet events involving Astarion and his reactions."
}

Example 2 — Causal "why" chain:
User: "Do you remember why we had to pay the ransom?"
{
  "queries": [
    "kidnapping ransom payment negotiation",
    "hostage capture arrest imprisonment",
    "rescue aftermath emotional reaction"
  ],
  "filters": {
    "concepts_any": ["ransom", "kidnapping", "rescue"]
  },
  "rationale": "Tracing the causal chain: capture → negotiation → payment → rescue."
}

`;

const _PLANNER_PROMPTS = {
    intl:           _PLANNER_HEADER + _PLANNER_EXAMPLES_INTL           + _PLANNER_FOOTER,
    jieba:          _PLANNER_HEADER + _PLANNER_EXAMPLES_JIEBA           + _PLANNER_FOOTER,
    jieba_tw:       _PLANNER_HEADER + _PLANNER_EXAMPLES_JIEBA_TW        + _PLANNER_FOOTER,
    tiny_segmenter: _PLANNER_HEADER + _PLANNER_EXAMPLES_TINY_SEGMENTER  + _PLANNER_FOOTER,
    korean:         _PLANNER_HEADER + _PLANNER_EXAMPLES_KOREAN          + _PLANNER_FOOTER,
    others:         _PLANNER_HEADER + _PLANNER_EXAMPLES_OTHERS          + _PLANNER_FOOTER,
};

/**
 * Returns the agentic planner system prompt for the given story language mode.
 * Falls back to the English (intl) prompt for unknown modes.
 *
 * @param {string} [mode] - Value from CJK_TOKENIZER_MODES (e.g. 'jieba_tw')
 * @returns {string}
 */
export function getAgenticPlannerPrompt(mode) {
    return _PLANNER_PROMPTS[mode] ?? _PLANNER_PROMPTS.intl;
}


// ─────────────────────────────────────────────────────────────────────────────
// DEFAULT SUMMARIZE PROMPT
// ─────────────────────────────────────────────────────────────────────────────

const _SUMMARIZE_INTL =
`You are a story memory archivist. Compress the following roleplay excerpt into a dense 2-10 sentence summary optimized for semantic search and retrieval.

Requirements:
- If a Date or Date + Time is in the main text, always include that in your summary.
- Preserve ALL proper nouns exactly as written: character names, location names, item names, organization names, and titles
- Capture: who is present, where the scene takes place, what actions occurred, any significant items or abilities referenced, and the emotional/relationship dynamics
- Write in English
- Be factual and information-dense — no filler phrases, no meta-commentary, no interpretation
- Output only the summary with no preamble or explanation

Story excerpt:
{{text}}`;

const _SUMMARIZE_JIEBA_TW =
`你是故事記憶檔案員。將以下角色扮演片段壓縮成一段2至10句的摘要，針對語義搜尋和檢索進行優化。

要求：
- 如果正文中有日期或日期加時間，請務必在摘要中包含。
- 完整保留所有專有名詞：角色名稱、地點名稱、物品名稱、組織名稱和頭銜
- 涵蓋：在場人物、場景發生地點、發生的行動、任何重要的物品或能力，以及情感╱關係動態
- 以繁體中文撰寫
- 以事實為依據，資訊密集——不使用填充詞、不加入後設評論、不作詮釋
- 僅輸出摘要，不加前言或說明

故事片段：
{{text}}`;

const _SUMMARIZE_JIEBA =
`你是故事记忆档案员。将以下角色扮演片段压缩成一段2至10句的摘要，针对语义搜索和检索进行优化。

要求：
- 如果正文中有日期或日期加时间，请务必在摘要中包含。
- 完整保留所有专有名词：角色名称、地点名称、物品名称、组织名称和称号
- 涵盖：在场人物、场景发生地点、发生的行动、任何重要的物品或能力，以及情感╱关系动态
- 以简体中文撰写
- 以事实为依据，信息密集——不使用填充词、不加入元评论、不作诠释
- 仅输出摘要，不加前言或说明

故事片段：
{{text}}`;

const _SUMMARIZE_TINY_SEGMENTER =
`あなたはストーリーの記憶アーカイバーです。以下のロールプレイの抜粋を、セマンティック検索と検索に最適化された2〜10文の密度の高い要約に圧縮してください。

要件：
- 本文に日付または日付＋時刻がある場合は、必ず要約に含めてください。
- すべての固有名詞をそのまま保持する：キャラクター名、場所名、アイテム名、組織名、称号
- 捉えること：誰が存在するか、場面はどこで起きるか、どんな行動が起きたか、重要なアイテムや能力、感情╱関係のダイナミクス
- 日本語で記述する
- 事実に基づき情報密度を高く——つなぎ言葉なし、メタコメントなし、解釈なし
- 前置きや説明なしに要約のみを出力する

ストーリーの抜粋：
{{text}}`;

const _SUMMARIZE_KOREAN =
`당신은 스토리 기억 아카이버입니다. 다음 롤플레이 발췌문을 시맨틱 검색 및 검색에 최적화된 2~10문장의 간결한 요약으로 압축하세요.

요건:
- 본문에 날짜 또는 날짜+시간이 있으면 반드시 요약에 포함하세요.
- 모든 고유명사를 그대로 보존하세요: 캐릭터 이름, 장소 이름, 아이템 이름, 조직 이름, 직함
- 다음을 포함하세요: 등장 인물, 장면 장소, 발생한 행동, 중요한 아이템이나 능력, 감정/관계 역학
- 한국어로 작성하세요
- 사실에 기반하여 정보 밀도를 높게 유지하세요 — 불필요한 표현, 메타 해설, 해석 없이
- 서문이나 설명 없이 요약만 출력하세요

스토리 발췌:
{{text}}`;

const _SUMMARIZE_OTHERS =
`You are a story memory archivist. Compress the following roleplay excerpt into a dense 2-10 sentence summary optimized for semantic search and retrieval.

Requirements:
- If a Date or Date + Time is in the main text, always include that in your summary.
- Preserve ALL proper nouns exactly as written: character names, location names, item names, organization names, and titles
- Capture: who is present, where the scene takes place, what actions occurred, any significant items or abilities referenced, and the emotional/relationship dynamics
- IMPORTANT: Write in the same language as the story excerpt — do not translate into English or any other language. Match the story's language exactly.
- Be factual and information-dense — no filler phrases, no meta-commentary, no interpretation
- Output only the summary with no preamble or explanation

Story excerpt:
{{text}}`;

const _SUMMARIZE_PROMPTS = {
    intl:           _SUMMARIZE_INTL,
    jieba:          _SUMMARIZE_JIEBA,
    jieba_tw:       _SUMMARIZE_JIEBA_TW,
    tiny_segmenter: _SUMMARIZE_TINY_SEGMENTER,
    korean:         _SUMMARIZE_KOREAN,
    others:         _SUMMARIZE_OTHERS,
};

/**
 * Returns the default summarization prompt for the given story language mode.
 * Falls back to the English (intl) prompt for unknown modes.
 *
 * @param {string} [mode] - Value from CJK_TOKENIZER_MODES (e.g. 'jieba_tw')
 * @returns {string}
 */
export function getDefaultSummarizePrompt(mode) {
    return _SUMMARIZE_PROMPTS[mode] ?? _SUMMARIZE_PROMPTS.intl;
}


// ─────────────────────────────────────────────────────────────────────────────
// PLANNER USER MESSAGE BUILDER
// ─────────────────────────────────────────────────────────────────────────────

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
