import { porterStemmer, extractCJKTokens, getCjkTokenizerMode, CJK_TOKENIZER_MODES } from './bm25-scorer.js';
import { substituteParams } from '../../../../../script.js';

/**
 * ============================================================================
 * VECTHARE KEYWORD SYSTEM
 * ============================================================================
 * Keyword extraction and boosting for vector search.
 *
 * EXTRACTION LEVELS:
 *   - off: No auto-extraction, only manual/WI trigger keys
 *   - minimal: Title only (first line), max 3 keywords
 *   - balanced: Header area (first 300 chars), max 8 keywords
 *   - aggressive: Full text scan, max 15 keywords
 *
 * FREQUENCY-BASED WEIGHTING:
 *   Words that appear more often get higher weights.
 *   Formula: baseWeight + (frequency - minFreq) * 0.1
 *   Example: base 1.5x, word appears 5x (min 2) → 1.5 + (5-2)*0.1 = 1.8x
 *
 * BOOST MATH (Additive):
 *   Each keyword has a weight (e.g., 1.5x, 2.0x, 3.0x).
 *   The boost above 1.0 is added together:
 *     - "magic" (1.5x) + "divine" (2.0x) = 1 + 0.5 + 1.0 = 2.5x total boost
 *
 * @version 4.0.0
 * ============================================================================
 */

/** Extraction level configurations */
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

/** Default extraction level */
export const DEFAULT_EXTRACTION_LEVEL = 'balanced';

/** Default base weight for keywords */
export const DEFAULT_BASE_WEIGHT = 1.5;

/** Weight increment per frequency count above minimum */
const FREQUENCY_WEIGHT_INCREMENT = 0.1;

/** Maximum weight cap (prevent runaway weights) */
const MAX_KEYWORD_WEIGHT = 3.0;

const CJK_CHAR_RE = /[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF\u3040-\u309F\u30A0-\u30FF]/;

// In Japanese mode, allow a small set of high-signal 1-char tokens (mostly RPG terms)
// plus frequency-based survival to avoid losing recurring key concepts.
// In Japanese mode, allow a small set of high-signal 1-char tokens 
// (RPG, School, and Slice-of-Life terms)
// plus frequency-based survival to avoid losing recurring key concepts.
const JAPANESE_SINGLE_CHAR_ALLOWLIST = new Set([
    // RPG Original
    '剣', '刀', '弓', '槍', '盾', '魔', '王', '神', '龍', '竜', '炎', '氷', '闇', '光', '聖',
    // RPG Magic & Combat
    '雷', '水', '風', '土', '毒', '幻', '魂', '気', '斧', '杖', '鞭', '鎧', '血', '傷', '罠',
    // RPG Locations & Entities
    '城', '塔', '森', '牢', '街', '村', '扉', '橋', '鬼', '獣', '霊', '姫', '帝', '敵', '賊',
    // RPG Items
    '鍵', '薬', '宝', '本', '鏡',
    
    // School & Academics
    '寮', '塾', '席', '部', '組', '噂', '罰',
    // Romance & Drama
    '恋', '愛', '涙', '嘘', '絆',
    // SoL Locations & Events
    '駅', '家', '店', '海', '祭',
    // SoL Items, Weather & Animals
    '傘', '雨', '雪', '桜', '猫', '犬', '茶', '酒',
    // Relationships
    '友', '親', '兄', '弟', '姉', '妹'
]);

// In Traditional Chinese mode, allow a focused set of high-signal 1-char tokens
// (RPG + school + slice-of-life), plus frequency-based survival.
const TRADITIONAL_CHINESE_SINGLE_CHAR_ALLOWLIST = new Set([
    // RPG Core
    '劍', '刀', '弓', '槍', '盾', '魔', '王', '神', '龍', '炎', '冰', '闇', '光', '聖',
    // RPG Combat & Elements
    '雷', '水', '風', '土', '毒', '幻', '魂', '氣', '斧', '杖', '鞭', '鎧', '血', '傷', '陣',
    // RPG Places & Entities
    '城', '塔', '森', '牢', '街', '村', '門', '橋', '鬼', '獸', '靈', '姬', '帝', '敵', '賊',
    // RPG Items
    '鑰', '藥', '寶', '書', '鏡',

    // School & Academics
    '班', '組', '課', '部', '社', '室', '寮', '罰',
    // Romance & Drama
    '戀', '愛', '淚', '謊', '絆',
    // SoL Locations & Events
    '家', '店', '海', '祭', '站',
    // SoL Items, Weather & Animals
    '傘', '雨', '雪', '櫻', '貓', '狗', '茶', '酒',
    // Relationships
    '友', '親', '兄', '弟', '姊', '妹',
]);

// In Simplified Chinese mode, allow a focused set of high-signal 1-char tokens
// (RPG + school + slice-of-life), plus frequency-based survival.
const SIMPLIFIED_CHINESE_SINGLE_CHAR_ALLOWLIST = new Set([
    // RPG Core
    '剑', '刀', '弓', '枪', '盾', '魔', '王', '神', '龙', '炎', '冰', '暗', '光', '圣',
    // RPG Combat & Elements
    '雷', '水', '风', '土', '毒', '幻', '魂', '气', '斧', '杖', '鞭', '铠', '血', '伤', '阵',
    // RPG Places & Entities
    '城', '塔', '森', '牢', '街', '村', '门', '桥', '鬼', '兽', '灵', '姬', '帝', '敌', '贼',
    // RPG Items
    '钥', '药', '宝', '书', '镜',

    // School & Academics
    '班', '组', '课', '部', '社', '室', '宿', '罚',
    // Romance & Drama
    '恋', '爱', '泪', '谎', '绊',
    // SoL Locations & Events
    '家', '店', '海', '祭', '站',
    // SoL Items, Weather & Animals
    '伞', '雨', '雪', '樱', '猫', '狗', '茶', '酒',
    // Relationships
    '友', '亲', '兄', '弟', '姐', '妹',
]);

function isCjkToken(token) {
    return typeof token === 'string' && CJK_CHAR_RE.test(token);
}

function shouldKeepCjkKeyword(token, frequency, isJapaneseMode, isTraditionalChineseMode, isSimplifiedChineseMode) {
    if (!isCjkToken(token)) return true;
    if (token.length >= 2) return true;
    if (isJapaneseMode) {
        if (frequency >= 2) return true;
        return JAPANESE_SINGLE_CHAR_ALLOWLIST.has(token);
    }
    if (isTraditionalChineseMode) {
        if (frequency >= 2) return true;
        return TRADITIONAL_CHINESE_SINGLE_CHAR_ALLOWLIST.has(token);
    }
    if (isSimplifiedChineseMode) {
        if (frequency >= 2) return true;
        return SIMPLIFIED_CHINESE_SINGLE_CHAR_ALLOWLIST.has(token);
    }
    return false;
}

/**
 * Common words that shouldn't be auto-extracted as keywords
 * Comprehensive English stopwords list
 */
const KEYWORD_STOP_WORDS = new Set([
    // Articles & determiners
    'the', 'a', 'an', 'this', 'that', 'these', 'those', 'some', 'any', 'each',
    'every', 'both', 'either', 'neither', 'such', 'what', 'which', 'whose',

    // Pronouns
    'i', 'me', 'my', 'mine', 'myself',
    'you', 'your', 'yours', 'yourself', 'yourselves',
    'he', 'him', 'his', 'himself',
    'she', 'her', 'hers', 'herself',
    'it', 'its', 'itself',
    'we', 'us', 'our', 'ours', 'ourselves',
    'they', 'them', 'their', 'theirs', 'themselves',
    'who', 'whom', 'whose', 'whoever', 'whomever',
    'someone', 'anyone', 'everyone', 'nobody', 'somebody', 'anybody', 'everybody',
    'something', 'anything', 'everything', 'nothing',

    // Contractions
    "i'll", "i've", "i'd", "i'm",
    "you'll", "you've", "you'd", "you're",
    "he'll", "he'd", "he's",
    "she'll", "she'd", "she's",
    "it'll", "it'd", "it's",
    "we'll", "we've", "we'd", "we're",
    "they'll", "they've", "they'd", "they're",
    "won't", "wouldn't", "can't", "couldn't", "shouldn't", "mustn't", "mightn't",
    "doesn't", "don't", "didn't", "hasn't", "haven't", "hadn't",
    "isn't", "aren't", "wasn't", "weren't",
    "that's", "there's", "here's", "what's", "where's", "who's", "how's", "why's",
    "let's", "ain't", "gonna", "wanna", "gotta",

    // Conjunctions
    'and', 'or', 'but', 'nor', 'so', 'yet', 'for', 'because', 'although', 'though',
    'while', 'whereas', 'unless', 'until', 'since', 'once', 'when', 'whenever',
    'where', 'wherever', 'whether', 'if', 'then', 'than', 'that', 'as',

    // Prepositions
    'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'into', 'onto',
    'upon', 'out', 'off', 'over', 'under', 'above', 'below', 'between', 'among',
    'through', 'during', 'before', 'after', 'behind', 'beside', 'besides',
    'beyond', 'within', 'without', 'about', 'around', 'against', 'along',
    'across', 'toward', 'towards', 'near', 'inside', 'outside',

    // Common verbs (be, have, do, modal)
    'be', 'am', 'is', 'are', 'was', 'were', 'been', 'being',
    'have', 'has', 'had', 'having',
    'do', 'does', 'did', 'doing', 'done',
    'will', 'would', 'shall', 'should', 'may', 'might', 'must', 'can', 'could',
    'need', 'dare', 'ought', 'used',
    'get', 'gets', 'got', 'getting', 'gotten',
    'make', 'makes', 'made', 'making',
    'go', 'goes', 'went', 'going', 'gone',
    'come', 'comes', 'came', 'coming',
    'take', 'takes', 'took', 'taking', 'taken',
    'give', 'gives', 'gave', 'giving', 'given',
    'say', 'says', 'said', 'saying',
    'know', 'knows', 'knew', 'knowing', 'known',
    'think', 'thinks', 'thought', 'thinking',
    'see', 'sees', 'saw', 'seeing', 'seen',
    'want', 'wants', 'wanted', 'wanting',
    'use', 'uses', 'used', 'using',
    'find', 'finds', 'found', 'finding',
    'tell', 'tells', 'told', 'telling',
    'ask', 'asks', 'asked', 'asking',
    'seem', 'seems', 'seemed', 'seeming',
    'feel', 'feels', 'felt', 'feeling',
    'try', 'tries', 'tried', 'trying',
    'leave', 'leaves', 'left', 'leaving',
    'call', 'calls', 'called', 'calling',
    'keep', 'keeps', 'kept', 'keeping',
    'let', 'lets', 'letting',
    'begin', 'begins', 'began', 'beginning', 'begun',
    'show', 'shows', 'showed', 'showing', 'shown',
    'hear', 'hears', 'heard', 'hearing',
    'play', 'plays', 'played', 'playing',
    'run', 'runs', 'ran', 'running',
    'move', 'moves', 'moved', 'moving',
    'live', 'lives', 'lived', 'living',
    'believe', 'believes', 'believed', 'believing',
    'hold', 'holds', 'held', 'holding',
    'bring', 'brings', 'brought', 'bringing',
    'happen', 'happens', 'happened', 'happening',
    'write', 'writes', 'wrote', 'writing', 'written',
    'provide', 'provides', 'provided', 'providing',
    'sit', 'sits', 'sat', 'sitting',
    'stand', 'stands', 'stood', 'standing',
    'lose', 'loses', 'lost', 'losing',
    'pay', 'pays', 'paid', 'paying',
    'meet', 'meets', 'met', 'meeting',
    'include', 'includes', 'included', 'including',
    'continue', 'continues', 'continued', 'continuing',
    'set', 'sets', 'setting',
    'learn', 'learns', 'learned', 'learning',
    'change', 'changes', 'changed', 'changing',
    'lead', 'leads', 'led', 'leading',
    'understand', 'understands', 'understood', 'understanding',
    'watch', 'watches', 'watched', 'watching',
    'follow', 'follows', 'followed', 'following',
    'stop', 'stops', 'stopped', 'stopping',
    'create', 'creates', 'created', 'creating',
    'speak', 'speaks', 'spoke', 'speaking', 'spoken',
    'read', 'reads', 'reading',
    'allow', 'allows', 'allowed', 'allowing',
    'add', 'adds', 'added', 'adding',
    'spend', 'spends', 'spent', 'spending',
    'grow', 'grows', 'grew', 'growing', 'grown',
    'open', 'opens', 'opened', 'opening',
    'walk', 'walks', 'walked', 'walking',
    'win', 'wins', 'won', 'winning',
    'offer', 'offers', 'offered', 'offering',
    'remember', 'remembers', 'remembered', 'remembering',
    'consider', 'considers', 'considered', 'considering',
    'appear', 'appears', 'appeared', 'appearing',
    'buy', 'buys', 'bought', 'buying',
    'wait', 'waits', 'waited', 'waiting',
    'serve', 'serves', 'served', 'serving',
    'die', 'dies', 'died', 'dying',
    'send', 'sends', 'sent', 'sending',
    'expect', 'expects', 'expected', 'expecting',
    'build', 'builds', 'built', 'building',
    'stay', 'stays', 'stayed', 'staying',
    'fall', 'falls', 'fell', 'falling', 'fallen',
    'cut', 'cuts', 'cutting',
    'reach', 'reaches', 'reached', 'reaching',
    'kill', 'kills', 'killed', 'killing',
    'remain', 'remains', 'remained', 'remaining',

    // Adverbs
    'very', 'really', 'quite', 'just', 'only', 'even', 'also', 'still', 'already',
    'always', 'never', 'ever', 'often', 'sometimes', 'usually', 'rarely', 'seldom',
    'now', 'then', 'here', 'there', 'today', 'yesterday', 'tomorrow',
    'soon', 'later', 'early', 'late', 'again', 'once', 'twice',
    'much', 'more', 'most', 'less', 'least', 'well', 'better', 'best',
    'far', 'further', 'fast', 'hard', 'long', 'short', 'high', 'low',
    'almost', 'nearly', 'probably', 'perhaps', 'maybe', 'certainly', 'definitely',
    'however', 'therefore', 'thus', 'hence', 'otherwise', 'anyway', 'besides',
    'instead', 'rather', 'else', 'too', 'enough', 'especially', 'particularly',

    // Adjectives (very common/generic)
    'good', 'great', 'best', 'better', 'bad', 'worse', 'worst',
    'new', 'old', 'young', 'big', 'small', 'large', 'little', 'long', 'short',
    'high', 'low', 'same', 'different', 'other', 'another', 'next', 'last',
    'first', 'second', 'third', 'many', 'much', 'few', 'several', 'own',
    'certain', 'sure', 'true', 'real', 'right', 'wrong', 'able', 'possible',
    'likely', 'important', 'main', 'major', 'full', 'whole', 'general',

    // Numbers
    'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
    'hundred', 'thousand', 'million', 'billion', 'first', 'second', 'third',

    // Time-related
    'time', 'times', 'year', 'years', 'month', 'months', 'week', 'weeks',
    'day', 'days', 'hour', 'hours', 'minute', 'minutes', 'moment', 'moments',

    // Question words
    'how', 'why', 'what', 'when', 'where', 'which', 'who', 'whom', 'whose',

    // Other common words
    'thing', 'things', 'way', 'ways', 'place', 'places', 'part', 'parts',
    'case', 'cases', 'point', 'points', 'fact', 'facts', 'kind', 'kinds',
    'sort', 'sorts', 'type', 'types', 'form', 'forms', 'example', 'examples',
    'like', 'back', 'even', 'still', 'well', 'just', 'only', 'over',

    // RP/chat specific
    'character', 'characters', 'user', 'assistant', 'system', 'message', 'messages',
    'response', 'responses', 'reply', 'replies', 'chat', 'chats',

    // Chinese stopwords (Simplified) - particles, pronouns, function verbs, conjunctions, prepositions, quantifiers, locations, time, connectives
    '的', '地', '得', '着', '了', '过', '嘛', '呢', '吧', '啊', '哦', '哈', '嗯',
    '我', '你', '他', '她', '它', '谁', '这', '那', '哪',
    '我们', '你们', '他们', '她们', '它们',
    '是', '有', '在', '被', '让', '把', '使', '叫', '会', '要', '能', '说', '做', '来', '去', '到', '看', '用', '将',
    '和', '与', '及', '或', '但', '而', '因', '所', '如', '既', '虽', '若', '则', '就', '才', '也', '还', '都', '又', '再', '不', '没', '很', '最', '更', '只',
    '其', '此', '已', '正', '便', '即', '仍', '曾', '各', '该',
    '于', '以', '从', '由', '向', '往', '对', '为', '给', '按', '比', '跟', '同',
    '什么', '怎么', '为什么', '哪里',
    '一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '百', '千', '万', '亿', '个', '些', '点', '多', '少', '几',
    '上', '下', '中', '内', '外', '里', '前', '后', '左', '右', '今', '年', '月', '日', '时', '现在', '以前', '以后',
    '但是', '所以', '因此', '然后', '虽然', '不过', '而且', '另外', '此外', '总之', '如果', '即使',

    // Chinese stopwords (Traditional - additional glyphs not covered above)
    '著', '過', '這', '誰', '什麼', '我們', '你們', '他們', '她們', '它們',
    '讓', '會', '沒', '說', '將',
    '與', '卻', '還', '雖',
    '其', '此', '已', '正', '便', '即', '仍', '曾', '各', '該',
    '從', '對', '為', '給', '於',
    '哪裡', '怎麼', '為什麼',
    '萬', '億', '個', '點', '幾',
    '裡', '裏', '後', '時', '現',
    '然後', '雖然', '不過', '總之',
    // Traditional Chinese pronouns & filler missed by Simplified set
    '妳', '妳們', '您',                          // feminine/polite "you"
    '她的', '他的', '它的', '妳的', '你的', '我的', '牠', '牠們',  // possessives + animal pronouns
    // Generic verbs that leak through as false keywords
    '發出', '進行', '出現', '開始', '表示', '感到', '看到', '聽到', '走向',
    '回到', '走進', '走出', '拿出', '拿起', '放下', '站起', '坐下', '轉向',
    '繼續', '停下', '離開', '來到', '回來', '出來', '進來', '上來', '下來',
    '完成', '結束', '發現', '明白', '知道', '覺得', '認為', '希望', '想到',
    // Filler adverbs and descriptors
    '一下', '一起', '一直', '一樣', '一邊', '一旁', '一番', '一聲', '先',
    '微微', '輕輕', '慢慢', '緩緩', '漸漸', '稍微', '略微', '稍稍',
    '臉上', '身上', '手上', '眼中', '心中', '腦中', '胸口',  // body-location phrases
    '那是', '這是', '就是', '只是', '還是', '或是', '但是', '可是',
    '因為', '所以', '雖然', '如果', '即使', '不管', '無論',
    '已經', '正在', '將要', '可以', '應該', '需要', '必須',
    '非常', '十分', '相當', '有些', '有點', '有時', '有人', '有什麼',
    '自己', '彼此', '大家', '大概', '可能', '似乎', '好像', '確實',
    '布料', '聲音', '氣息', '氣氛', '動作', '姿態', '表情', '眼神',  // overly generic nouns
]);

/**
 * Get combined stopwords (default + custom from settings)
 * Processes ST macros like {{char}}, {{user}} in custom stopwords
 * @param {object} settings - VectHare settings (optional)
 * @returns {Set<string>} Combined stopwords set
 */
function getCombinedStopwords(settings = null) {
    const combined = new Set(KEYWORD_STOP_WORDS);

    // Add custom stopwords if settings provided
    if (settings && settings.custom_stopwords && typeof settings.custom_stopwords === 'string') {
        // Process ST macros ({{char}}, {{user}}, etc.) before splitting
        let processedString = substituteParams(settings.custom_stopwords);
        processedString = processedString.toLowerCase();

        const customWords = processedString
            .split(',')
            .map(w => w.trim())
            .filter(w => w.length > 0);

        for (const word of customWords) {
            combined.add(word);
        }
    }

    return combined;
}

/**
 * Extract keywords from a lorebook entry
 * @param {object} entry - Lorebook entry with key array
 * @param {object} settings - VectHare settings (optional)
 * @returns {string[]} Array of keywords
 */
export function extractLorebookKeywords(entry, settings = null) {
    if (!entry) return [];

    const stopwords = getCombinedStopwords(settings);
    const keywords = [];

    // Primary keys (trigger words)
    if (Array.isArray(entry.key)) {
        entry.key.forEach(k => {
            if (k && typeof k === 'string' && k.trim()) {
                const normalized = k.trim().toLowerCase();
                // Filter out stop words - they're too common to be useful as keywords
                // Don't stem: keys are often names/titles that should match exactly
                if (!stopwords.has(normalized) && normalized.length >= 2) {
                    keywords.push(normalized);
                }
            }
        });
    }

    // Secondary keys
    if (Array.isArray(entry.keysecondary)) {
        entry.keysecondary.forEach(k => {
            if (k && typeof k === 'string' && k.trim()) {
                const normalized = k.trim().toLowerCase();
                // Filter out stop words
                // Don't stem: keys are often names/titles that should match exactly
                if (!stopwords.has(normalized) && normalized.length >= 2) {
                    keywords.push(normalized);
                }
            }
        });
    }

    return [...new Set(keywords)]; // Dedupe
}

/**
 * Extract keywords from plain text with configurable extraction level
 *
 * Returns keywords with frequency-based weights.
 * Higher frequency = higher weight (capped at MAX_KEYWORD_WEIGHT)
 *
 * @param {string} text - Text to extract from
 * @param {object} options - Extraction options
 * @param {string} options.level - Extraction level: 'off', 'minimal', 'balanced', 'aggressive'
 * @param {number} options.baseWeight - Base weight for keywords (default 1.5)
 * @returns {Array<{text: string, weight: number}>} Array of weighted keywords
 */

/**
 * Extract terms enclosed in CJK bracket markers: 【】「」『』
 * These are structural markers in Chinese/Japanese text that explicitly signal
 * named concepts — game systems, skills, titles, item names, etc.
 * Bracket-enclosed terms are treated as high-priority keywords regardless of
 * their frequency in the surrounding text.
 *
 * To extend for other bracket styles, add to the bracket character class below.
 * @param {string} text
 * @returns {string[]} Unique bracket-enclosed terms containing at least one CJK char
 */
function extractBracketTerms(text) {
    const results = [];
    // 【...】 — CJK concept/system marker (game skills, item names, system panels)
    // [...] with CJK content — ASCII square bracket concept markers (e.g. [勇者之劍])
    // 「」 and 『』 are dialogue SPEECH QUOTES — intentionally excluded.
    const bracketRe = /(?:\u3010([^\u3011\n]{2,20})\u3011|\[([^\]\n]{2,20})\])/g;
    let m;
    const cjkRe = /[\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF\u3400-\u4DBF\uF900-\uFAFF]/;
    while ((m = bracketRe.exec(text)) !== null) {
        const inner = (m[1] ?? m[2]).trim();
        // Only include if the term contains at least one CJK character
        if (cjkRe.test(inner)) {
            results.push(inner);
        }
    }
    return [...new Set(results)];
}

export function extractTextKeywords(text, options = {}) {
    if (!text || typeof text !== 'string') return [];

    // Strip appended [KEYWORDS: ...] / [KEYWORD ...] tags (any case, colon optional)
    // to prevent bleed-through when the stored Qdrant text is re-processed.
    text = text.replace(/\s*\[keywords?[:\s][^\]]*\]/gi, '').trimEnd();
    // Strip structural markup tags: [User], [Character], [OOC], [location], [tag: content], etc.
    // Only strips brackets whose content is purely non-CJK (ASCII labels/formatting markers).
    // Brackets containing CJK characters (e.g. [勇者之劍]) are preserved for extractBracketTerms.
    text = text.replace(/\[[^\]\u4E00-\u9FFF\u3040-\u30FF\u3400-\u4DBF\uF900-\uFAFF]{1,30}\]/g, ' ').replace(/\s+/g, ' ').trim();

    const level = options.level || DEFAULT_EXTRACTION_LEVEL;
    const baseWeight = options.baseWeight || DEFAULT_BASE_WEIGHT;
    const config = EXTRACTION_LEVELS[level];

    // If extraction is disabled, return empty
    if (!config || !config.enabled) {
        return [];
    }

    const stopwords = getCombinedStopwords(options.settings);
    const cjkTokenizerMode = getCjkTokenizerMode();
    const isJapaneseMode = cjkTokenizerMode === CJK_TOKENIZER_MODES.tiny_segmenter;
    const isTraditionalChineseMode = cjkTokenizerMode === CJK_TOKENIZER_MODES.jieba_tw;
    const isSimplifiedChineseMode = cjkTokenizerMode === CJK_TOKENIZER_MODES.jieba;

    // Step 1: Clean text - remove example citations and italics
    let cleanedText = text.replace(/\([^)]+\)/g, ' '); // Remove (parenthetical citations)
    cleanedText = cleanedText.replace(/\*[^*]+\*/g, ' '); // Remove *italicized examples*
    // Strip possessive 's before tokenization (e.g., "Strovolos's" → "Strovolos")
    cleanedText = cleanedText.replace(/'s\b/g, '');

    // Step 2: Determine scan area based on level
    const scanArea = config.headerSize
        ? cleanedText.substring(0, config.headerSize)
        : cleanedText;

    // Step 2.5: Detect capitalized words (likely proper nouns/names) before lowercasing
    // Match words that are capitalized mid-sentence or in titles
    const properNouns = new Set();
    const capitalizedPattern = /\b[A-Z][a-z]{3,}\b/g;
    let match;
    while ((match = capitalizedPattern.exec(scanArea)) !== null) {
        properNouns.add(match[0].toLowerCase());
    }

    // Step 3: Extract and count words (Latin + CJK words; supports Simplified + Traditional)
    const topicWords = (scanArea.toLowerCase().match(/\b[a-z]{4,}\b/g) || [])
        .concat(extractCJKTokens(scanArea));
    const wordCounts = new Map();

    for (const word of topicWords) {
        if (stopwords.has(word)) continue;
        // Don't stem proper nouns/names - they should match exactly
        const stemmed = properNouns.has(word) ? word : porterStemmer(word);
        wordCounts.set(stemmed, (wordCounts.get(stemmed) || 0) + 1);
    }

    // Step 4: Filter by minimum frequency and build weighted keywords
    const weightedKeywords = [];

    for (const [word, count] of wordCounts) {
        if (count >= config.minFrequency) {
            if (!shouldKeepCjkKeyword(word, count, isJapaneseMode, isTraditionalChineseMode, isSimplifiedChineseMode)) continue;
            // Calculate weight based on frequency
            // More occurrences = higher weight
            const frequencyBonus = (count - config.minFrequency) * FREQUENCY_WEIGHT_INCREMENT;
            const weight = Math.min(MAX_KEYWORD_WEIGHT, baseWeight + frequencyBonus);

            weightedKeywords.push({ text: word, weight, frequency: count });
        }
    }

    // Step 5: Extract compound terms (e.g., "divine/time", "time_god")
    const compoundMatches = scanArea.match(/\b\w+[/_]\w+\b/gi) || [];
    for (const compound of compoundMatches) {
        const normalized = compound.toLowerCase().replace(/[/_]/g, '_');
        if (normalized.length >= 4) {
            // Compound terms get a slight weight bonus
            weightedKeywords.push({
                text: normalized,
                weight: Math.min(MAX_KEYWORD_WEIGHT, baseWeight + 0.2),
                frequency: 1,
            });
        }
    }

    // Step 5.5: Inject bracket-enclosed terms (【...】「...」『...』) as max-priority keywords.
    // These are explicit concept markers in CJK text — game systems, skills, titles, item names.
    // They bypass minFrequency: appearing once inside brackets is an intentional author signal.
    for (const term of extractBracketTerms(scanArea)) {
        if (!stopwords.has(term)) {
            weightedKeywords.push({ text: term, weight: MAX_KEYWORD_WEIGHT, frequency: 1 });
        }
    }

    // Step 6: Sort by weight (highest first), dedupe, and limit
    const seen = new Set();
    const result = [];

    weightedKeywords.sort((a, b) => b.weight - a.weight);

    for (const kw of weightedKeywords) {
        if (!seen.has(kw.text)) {
            seen.add(kw.text);
            result.push(kw);
            if (result.length >= config.maxKeywords) break;
        }
    }

    if (result.length > 0) {
        console.debug(`[VectHare Keyword Extraction] Extracted text keywords (${level} level): [${result.map(k => `${k.text}(${k.weight.toFixed(2)}x, freq:${k.frequency})`).join(', ')}] from: "${text.substring(0, 80)}${text.length > 80 ? '...' : ''}"`);
    }

    return result;
}

/**
 * Simple string array version for backwards compatibility
 * @param {string} text - Text to extract from
 * @param {object} options - Extraction options
 * @returns {string[]} Array of keyword strings
 */
export function extractTextKeywordsSimple(text, options = {}) {
    return extractTextKeywords(text, options).map(kw => kw.text);
}

/**
 * Extract keywords from chat messages using proper noun detection
 * Finds capitalized words mid-sentence (names, places, etc.)
 *
 * @param {string} text - Chat message text
 * @param {object} options - Extraction options
 * @param {number} options.baseWeight - Base weight for keywords (default 1.5)
 * @param {number} options.maxKeywords - Maximum keywords to return (default 8)
 * @returns {Array<{text: string, weight: number}>} Array of weighted keywords
 */
export function extractChatKeywords(text, options = {}) {
    if (!text || typeof text !== 'string') return [];

    const baseWeight = options.baseWeight || DEFAULT_BASE_WEIGHT;
    const maxKeywords = options.maxKeywords || 8;
    const stopwords = getCombinedStopwords(options.settings);

    const keywords = [];
    const seen = new Set();

    // Find capitalized words that aren't at sentence start
    // Looks for capital letter followed by lowercase, not preceded by sentence-ending punctuation
    const properNounRegex = /(?<![.!?]\s*)(?<=\s|^"|^'|^\*|"|'|\*)\b([A-Z][a-z]{2,})\b/g;
    let match;

    while ((match = properNounRegex.exec(text)) !== null) {
        const word = match[1].toLowerCase();

        // Skip common words that happen to be capitalized
        if (stopwords.has(word)) continue;

        // Don't stem proper nouns - preserve names/titles exactly
        // Skip if already seen
        if (seen.has(word)) continue;
        seen.add(word);

        keywords.push({ text: word, weight: baseWeight });

        if (keywords.length >= maxKeywords) break;
    }

    // Also extract CJK words (Simplified + Traditional)
    if (keywords.length < maxKeywords) {
        for (const word of extractCJKTokens(text)) {
            if (stopwords.has(word)) continue;
            if (seen.has(word)) continue;
            seen.add(word);
            keywords.push({ text: word, weight: baseWeight });
            if (keywords.length >= maxKeywords) break;
        }
    }

    if (keywords.length > 0) {
        console.debug(`[VectHare Keyword Extraction] Extracted chat keywords: [${keywords.map(k => `${k.text}(${k.weight.toFixed(2)}x)`).join(', ')}] from text: "${text.substring(0, 80)}${text.length > 80 ? '...' : ''}"`);
    }

    return keywords;
}

/**
 * Extract keywords using BM25/TF-IDF scoring
 * Finds the most distinctive and important words in a text by:
 * 1. Splitting text into sentences (mini-corpus)
 * 2. Calculating TF-IDF for each word
 * 3. Returning top-scoring words as keywords
 *
 * This is better than proper noun extraction because it finds
 * contextually important words, not just capitalized names.
 *
 * Respects extraction levels:
 * - minimal: First 100 chars, max 3 keywords, min freq 1
 * - balanced: First 300 chars, max 8 keywords, min freq 2
 * - aggressive: Full text, max 15 keywords, min freq 3
 *
 * @param {string} text - Text to extract keywords from
 * @param {object} options - Extraction options
 * @param {string} options.level - Extraction level: 'minimal', 'balanced', 'aggressive' (default: 'balanced')
 * @param {number} options.baseWeight - Base weight for keywords (default 1.5)
 * @param {number} options.maxKeywords - Override max keywords (uses level default if not set)
 * @param {number} options.minWordLength - Minimum word length (default 3)
 * @returns {Array<{text: string, weight: number, tfidf: number}>} Weighted keywords
 */
export function extractBM25Keywords(text, options = {}) {
    if (!text || typeof text !== 'string' || text.trim().length === 0) return [];

    // Strip appended [KEYWORDS: ...] / [KEYWORD ...] tags (any case, colon optional)
    // to prevent bleed-through when the stored Qdrant text is re-processed.
    text = text.replace(/\s*\[keywords?[:\s][^\]]*\]/gi, '').trimEnd();
    // Strip structural markup tags: [User], [Character], [OOC], [location], [tag: content], etc.
    // Only strips brackets whose content is purely non-CJK (ASCII labels/formatting markers).
    // Brackets containing CJK characters (e.g. [勇者之劍]) are preserved for extractBracketTerms.
    text = text.replace(/\[[^\]\u4E00-\u9FFF\u3040-\u30FF\u3400-\u4DBF\uF900-\uFAFF]{1,30}\]/g, ' ').replace(/\s+/g, ' ').trim();

    // Get extraction level config
    const level = options.level || DEFAULT_EXTRACTION_LEVEL;
    const config = EXTRACTION_LEVELS[level];

    // If extraction is disabled, return empty
    if (!config || !config.enabled) return [];

    const baseWeight = options.baseWeight || DEFAULT_BASE_WEIGHT;
    const maxKeywords = options.maxKeywords || config.maxKeywords || 8;
    const minFrequency = config.minFrequency || 1;
    const minWordLength = options.minWordLength || 3;
    const stopwords = getCombinedStopwords(options.settings);
    const cjkTokenizerMode = getCjkTokenizerMode();
    const isJapaneseMode = cjkTokenizerMode === CJK_TOKENIZER_MODES.tiny_segmenter;
    const isTraditionalChineseMode = cjkTokenizerMode === CJK_TOKENIZER_MODES.jieba_tw;
    const isSimplifiedChineseMode = cjkTokenizerMode === CJK_TOKENIZER_MODES.jieba;

    // Apply header size limit (scan area)
    let scanText = text;
    if (config.headerSize && text.length > config.headerSize) {
        // For minimal/balanced, focus on the beginning of the text
        scanText = text.substring(0, config.headerSize);
        // Try to end at a word boundary
        const lastSpace = scanText.lastIndexOf(' ');
        if (lastSpace > config.headerSize * 0.8) {
            scanText = scanText.substring(0, lastSpace);
        }
    }

    // Strip possessive 's before tokenization
    scanText = scanText.replace(/'s\b/g, '');

    // Detect capitalized words (proper nouns/names) before lowercasing
    const properNouns = new Set();
    const capitalizedPattern = /\b[A-Z][a-z]{3,}\b/g;
    let match;
    while ((match = capitalizedPattern.exec(scanText)) !== null) {
        properNouns.add(match[0].toLowerCase());
    }

    // Split into sentences (mini-corpus for IDF calculation)
    // Includes Chinese sentence-ending punctuation 。！？
    const sentences = scanText
        .split(/[.!?。！？\n]+/)
        .map(s => s.trim())
        .filter(s => s.length > 2); // Skip very short fragments (CJK sentences can be short)

    if (sentences.length === 0) {
        // Fallback: treat whole text as one sentence
        sentences.push(scanText);
    }

    // Tokenize each sentence (Latin words + CJK words; Simplified + Traditional)
    const _cjkStripReBM25 = /[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF]/g;
    const tokenizeSentence = (s) => {
        const cjkTokens = extractCJKTokens(s).filter(t => !stopwords.has(t));
        const latinTokens = s
            .replace(_cjkStripReBM25, ' ')
            .toLowerCase()
            .replace(/[^\w\s'-]/g, ' ')
            .split(/\s+/)
            .filter(t => t.length >= minWordLength && !stopwords.has(t))
            .map(t => {
                // Don't stem proper nouns (names) - preserve them exactly
                if (properNouns.has(t)) return t;
                return t.length > 3 ? porterStemmer(t) : t;
            });
        return [...latinTokens, ...cjkTokens];
    };

    const sentenceTokens = sentences.map(tokenizeSentence);

    // Calculate document frequency (how many sentences contain each word)
    const docFreq = new Map();
    for (const tokens of sentenceTokens) {
        const uniqueTokens = new Set(tokens);
        for (const token of uniqueTokens) {
            docFreq.set(token, (docFreq.get(token) || 0) + 1);
        }
    }

    // Calculate term frequency across entire scan area
    const allTokens = sentenceTokens.flat();
    const termFreq = new Map();
    for (const token of allTokens) {
        termFreq.set(token, (termFreq.get(token) || 0) + 1);
    }

    // Calculate TF-IDF for each unique word
    const numSentences = sentences.length;
    const tfidfScores = [];

    for (const [word, tf] of termFreq.entries()) {
        // Skip words below minimum frequency threshold
        if (tf < minFrequency) continue;
        if (!shouldKeepCjkKeyword(word, tf, isJapaneseMode, isTraditionalChineseMode, isSimplifiedChineseMode)) continue;

        const df = docFreq.get(word) || 1;

        // IDF: log((N + 1) / (df + 1)) + 1 (smoothed to avoid log(0))
        const idf = Math.log((numSentences + 1) / (df + 1)) + 1;

        // TF-IDF score
        const tfidf = tf * idf;

        // Boost for capitalized words (likely proper nouns/names)
        // Check in original text to preserve case info
        const isCapitalized = text.includes(word.charAt(0).toUpperCase() + word.slice(1));
        const capitalBoost = isCapitalized ? 1.3 : 1.0;

        tfidfScores.push({
            text: word,
            tf: tf,
            idf: idf,
            tfidf: tfidf * capitalBoost,
            isCapitalized
        });
    }

    // Inject bracket-enclosed terms (【...】「...」『...』) that aren't already scored.
    // Assign a synthetic TF-IDF score above the current maximum so they survive the
    // top-N cut even when their natural frequency is 1.
    const scoredTerms = new Set(tfidfScores.map(s => s.text));
    const currentMax = tfidfScores.reduce((max, s) => Math.max(max, s.tfidf), 0);
    const bracketBoost = currentMax * 1.5 + 10;
    for (const term of extractBracketTerms(scanText)) {
        if (!stopwords.has(term) && !scoredTerms.has(term)) {
            tfidfScores.push({ text: term, tf: 1, idf: bracketBoost, tfidf: bracketBoost, isCapitalized: false });
        }
    }

    // Sort by TF-IDF score (highest first)
    tfidfScores.sort((a, b) => b.tfidf - a.tfidf);

    // Take top N and assign weights based on relative TF-IDF
    const topWords = tfidfScores.slice(0, maxKeywords);

    if (topWords.length === 0) return [];

    const maxTfidf = topWords[0].tfidf;
    const keywords = topWords.map(w => ({
        text: w.text,
        // Weight scales from baseWeight to baseWeight + 0.5 based on TF-IDF rank
        weight: baseWeight + (w.tfidf / maxTfidf) * 0.5,
        tfidf: w.tfidf
    }));

    if (keywords.length > 0) {
        console.debug(`[VectHare BM25 Keywords] Level=${level}, scanned ${scanText.length}/${text.length} chars, ${sentences.length} sentences → [${keywords.map(k => `${k.text}(${k.weight.toFixed(2)}x)`).join(', ')}]`);
    }

    return keywords;
}

/**
 * ============================================================================
 * ENHANCED KEYWORD EXTRACTION (Named Entity Detection + TF-IDF + Position)
 * ============================================================================
 *
 * Multi-signal approach that combines:
 * 1. Named Entity Detection (proper nouns, acronyms)
 * 2. TF-IDF scoring for distinctive terms
 * 3. Position weighting (title/header boost)
 *
 * This is more sophisticated than pure TF-IDF and catches important
 * named entities that might have low frequency.
 */

/** Position weight multipliers */
const POSITION_WEIGHTS = {
    title: 2.5,    // First line (assumed title)
    header: 1.8,   // First 20% of text
    middle: 1.2,   // Middle 60%
    end: 0.9,      // Last 20%
};

/** Entity boost multiplier */
const ENTITY_BOOST = 1.3;

/**
 * Extract keywords using multi-signal approach
 * Combines Named Entity Detection + TF-IDF + Position Weighting
 *
 * @param {string} text - Text to extract keywords from
 * @param {object} options - Extraction options
 * @param {string} options.level - Extraction level (default: 'balanced')
 * @param {number} options.baseWeight - Base weight for keywords (default: 1.5)
 * @param {boolean} options.detectEntities - Detect named entities (default: true)
 * @param {boolean} options.positionWeighting - Apply position weighting (default: true)
 * @returns {Array<{text: string, weight: number, type: string}>} Weighted keywords
 */
export function extractSmartKeywords(text, options = {}) {
    if (!text || typeof text !== 'string' || text.trim().length === 0) return [];

    const level = options.level || DEFAULT_EXTRACTION_LEVEL;
    const config = EXTRACTION_LEVELS[level];
    if (!config || !config.enabled) return [];

    const baseWeight = options.baseWeight || DEFAULT_BASE_WEIGHT;
    const maxKeywords = options.maxKeywords || config.maxKeywords || 8;
    const detectEntities = options.detectEntities !== false;
    const positionWeighting = options.positionWeighting !== false;
    const stopwords = getCombinedStopwords(options.settings);

    // Apply header size limit
    let scanText = text;
    if (config.headerSize && text.length > config.headerSize) {
        scanText = text.substring(0, config.headerSize);
        const lastSpace = scanText.lastIndexOf(' ');
        if (lastSpace > config.headerSize * 0.8) {
            scanText = scanText.substring(0, lastSpace);
        }
    }

    // Strip possessive 's before tokenization
    scanText = scanText.replace(/'s\b/g, '');

    // Detect capitalized words (proper nouns/names) before lowercasing
    const properNouns = new Set();
    const capitalizedPattern = /\b[A-Z][a-z]{3,}\b/g;
    let match;
    while ((match = capitalizedPattern.exec(scanText)) !== null) {
        properNouns.add(match[0].toLowerCase());
    }

    const keywordCandidates = new Map(); // word -> { score, type, position }

    // ---------------------------
    // 1. Named Entity Detection
    // ---------------------------
    if (detectEntities) {
        // Proper nouns: Capitalized words not at sentence start
        // Pattern: Capitalized word following lowercase or punctuation
        const properNounRegex = /(?<=[a-z.,!?]\s+|\*|"|')([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]+){0,2})\b/g;
        let match;
        while ((match = properNounRegex.exec(text)) !== null) {
            const entity = match[1].toLowerCase();
            if (!stopwords.has(entity) && entity.length >= 3) {
                // Don't stem entities (names/titles) - preserve exactly
                const position = getPositionWeight(match.index, text.length, positionWeighting);
                const existing = keywordCandidates.get(entity);
                if (!existing || existing.score < ENTITY_BOOST * position) {
                    keywordCandidates.set(entity, {
                        score: ENTITY_BOOST * position,
                        type: 'entity',
                        position: position,
                        isEntity: true
                    });
                }
            }
        }

        // Acronyms: 2-5 uppercase letters (FBI, NASA, UK)
        const acronymRegex = /\b([A-Z]{2,5})\b/g;
        while ((match = acronymRegex.exec(text)) !== null) {
            const acronym = match[1].toLowerCase();
            // Skip common false positives
            if (['the', 'and', 'for', 'are', 'but', 'not', 'you', 'all'].includes(acronym)) continue;
            // Don't stem acronyms - they should match exactly
            const position = getPositionWeight(match.index, text.length, positionWeighting);
            const existing = keywordCandidates.get(acronym);
            if (!existing || existing.score < ENTITY_BOOST * position * 1.2) {
                keywordCandidates.set(acronym, {
                    score: ENTITY_BOOST * position * 1.2,
                    type: 'acronym',
                    position: position,
                    isEntity: true
                });
            }
        }
    }

    // ---------------------------
    // 2. TF-IDF Scoring
    // Includes Chinese sentence-ending punctuation 。！？
    // ---------------------------
    const sentences = scanText.split(/[.!?。！？\n]+/).map(s => s.trim()).filter(s => s.length > 2);
    if (sentences.length === 0) sentences.push(scanText);

    // Tokenize each sentence (Latin words + CJK words; Simplified + Traditional)
    const _cjkStripReSmart = /[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF]/g;
    const tokenizeSentence = (s) => {
        const cjkTokens = extractCJKTokens(s).filter(t => !stopwords.has(t));
        const latinTokens = s
            .replace(_cjkStripReSmart, ' ')
            .toLowerCase()
            .replace(/[^\w\s'-]/g, ' ')
            .split(/\s+/)
            .filter(t => t.length >= 3 && !stopwords.has(t))
            .map(t => {
                // Don't stem proper nouns (names) - preserve them exactly
                if (properNouns.has(t)) return t;
                return t.length > 3 ? porterStemmer(t) : t;
            });
        return [...latinTokens, ...cjkTokens];
    };

    const sentenceTokens = sentences.map(tokenizeSentence);

    // Document frequency
    const docFreq = new Map();
    for (const tokens of sentenceTokens) {
        for (const token of new Set(tokens)) {
            docFreq.set(token, (docFreq.get(token) || 0) + 1);
        }
    }

    // Term frequency
    const termFreq = new Map();
    for (const token of sentenceTokens.flat()) {
        termFreq.set(token, (termFreq.get(token) || 0) + 1);
    }

    // Calculate TF-IDF for each term
    const numSentences = sentences.length;
    for (const [word, tf] of termFreq.entries()) {
        if (tf < (config.minFrequency || 1)) continue;

        const df = docFreq.get(word) || 1;
        const idf = Math.log((numSentences + 1) / (df + 1)) + 1;
        const tfidf = tf * idf;

        // Find word position in text for position weighting
        const wordIndex = text.toLowerCase().indexOf(word);
        const posWeight = getPositionWeight(wordIndex, text.length, positionWeighting);

        // Check if already an entity (boost TF-IDF score for entities)
        const existing = keywordCandidates.get(word);
        const entityBonus = existing?.isEntity ? ENTITY_BOOST : 1.0;

        const finalScore = tfidf * posWeight * entityBonus;

        if (!existing || existing.score < finalScore) {
            keywordCandidates.set(word, {
                score: finalScore,
                type: existing?.isEntity ? 'entity+tfidf' : 'tfidf',
                position: posWeight,
                tfidf: tfidf,
                isEntity: existing?.isEntity || false
            });
        }
    }

    // ---------------------------
    // 3. Sort and Select Top Keywords
    // ---------------------------
    const sortedKeywords = Array.from(keywordCandidates.entries())
        .sort((a, b) => b[1].score - a[1].score)
        .slice(0, maxKeywords);

    if (sortedKeywords.length === 0) return [];

    const maxScore = sortedKeywords[0][1].score;
    const keywords = sortedKeywords.map(([word, data]) => ({
        text: word,
        weight: baseWeight + (data.score / maxScore) * 0.5,
        type: data.type,
        isEntity: data.isEntity,
        positionWeight: data.position,
        tfidf: data.tfidf
    }));

    if (keywords.length > 0) {
        const entityCount = keywords.filter(k => k.isEntity).length;
        console.debug(`[VectHare Smart Keywords] Level=${level}, ${keywords.length} keywords (${entityCount} entities) → [${keywords.map(k => `${k.text}(${k.type})`).join(', ')}]`);
    }

    return keywords;
}

/**
 * Get position weight based on where the word appears in text
 */
function getPositionWeight(index, textLength, enabled = true) {
    if (!enabled || index < 0 || textLength === 0) return 1.0;

    const position = index / textLength;

    // First line (approx first 100 chars or 5%) - likely title
    if (index < 100 || position < 0.05) {
        return POSITION_WEIGHTS.title;
    }
    // First 20% - header area
    if (position < 0.2) {
        return POSITION_WEIGHTS.header;
    }
    // Last 20%
    if (position > 0.8) {
        return POSITION_WEIGHTS.end;
    }
    // Middle 60%
    return POSITION_WEIGHTS.middle;
}

/**
 * Normalize a keyword to { text, weight } format
 * Handles both string and object formats
 * @param {string|object} kw - Keyword (string or { text, weight })
 * @param {number} defaultWeight - Default weight for string keywords
 * @returns {{ text: string, weight: number }}
 */
function normalizeKeyword(kw, defaultWeight = DEFAULT_BASE_WEIGHT) {
    if (typeof kw === 'string') {
        return { text: kw.toLowerCase(), weight: defaultWeight };
    }
    if (kw && typeof kw === 'object' && kw.text) {
        return {
            text: kw.text.toLowerCase(),
            weight: typeof kw.weight === 'number' ? kw.weight : defaultWeight
        };
    }
    return null;
}

/**
 * Check if query contains a keyword
 * @param {string} query - Search query (lowercased)
 * @param {string} keyword - Keyword to check (lowercased)
 * @returns {boolean}
 */
function queryHasKeyword(query, keyword) {
    if (!query || !keyword) return false;
    return query.includes(keyword);
}

/**
 * Maximum per-keyword contribution cap (prevents single high-weight keyword from dominating)
 */
const MAX_KEYWORD_CONTRIBUTION = 0.5;

/**
 * Scaling factors based on match count (diminishing returns)
 * This prevents spam where many low-relevance keywords could inflate scores
 */
const MATCH_SCALING_FACTORS = {
    1: 0.30,   // 1 match: 30% of raw boost
    2: 0.60,   // 2 matches: 60% of raw boost
    3: 1.00,   // 3+ matches: full boost
};

/**
 * Apply keyword boost with DIMINISHING RETURNS
 *
 * Enhanced boost calculation that prevents exploitation:
 * 1. Per-keyword contribution capped at 0.5 (prevents single high-weight keyword dominance)
 * 2. Scaling factor based on match count (1 match = 30%, 2 = 60%, 3+ = 100%)
 * 3. More keywords required for full boost effect
 *
 * Examples (with diminishing returns):
 *   - 1 match "magic" (1.5x): contribution=0.5, rawBoost=1.5, scale=30% → finalBoost=1.15x
 *   - 2 matches (1.5x each): contribution=0.5+0.5=1.0, rawBoost=2.0, scale=60% → finalBoost=1.6x
 *   - 3+ matches: full boost applied
 *
 * Spam Protection:
 *   - 1 match "magic" (3.0x): contribution=min(2.0,0.5)=0.5, rawBoost=1.5, scale=30% → 1.15x (not 3.0x!)
 *
 * @param {Array} results - Search results [{text, score, keywords, ...}]
 * @param {string} query - The search query
 * @param {object} options - Boost options
 * @param {boolean} options.diminishingReturns - Use diminishing returns (default: true)
 * @param {boolean} options.perKeywordCap - Cap per-keyword contribution (default: true)
 * @returns {Array} Results with boosted scores, sorted by score desc
 */
export function applyKeywordBoost(results, query, options = {}) {
    if (!results || !Array.isArray(results) || !query) return results;

    const {
        diminishingReturns = true,
        perKeywordCap = true
    } = options;

    const queryLower = query.toLowerCase();

    console.log(`[VectHare Keyword Boost] Starting keyword boost for query: "${query}" (diminishing=${diminishingReturns}, cap=${perKeywordCap})`);

    const boosted = results.map(result => {
        const rawKeywords = result.keywords || result.metadata?.keywords || [];
        const matchedKeywords = [];
        let boostSum = 0;

        for (const kw of rawKeywords) {
            const normalized = normalizeKeyword(kw);
            if (!normalized) continue;

            if (queryHasKeyword(queryLower, normalized.text)) {
                matchedKeywords.push(normalized);

                // Calculate contribution with optional per-keyword cap
                const rawContribution = normalized.weight - 1.0;
                const contribution = perKeywordCap
                    ? Math.min(rawContribution, MAX_KEYWORD_CONTRIBUTION)
                    : rawContribution;

                boostSum += contribution;
            }
        }

        // Calculate raw boost
        const rawBoost = 1.0 + boostSum;

        // Apply diminishing returns scaling based on match count
        let finalBoost;
        if (diminishingReturns && matchedKeywords.length > 0) {
            const matchCount = Math.min(matchedKeywords.length, 3);
            const scalingFactor = MATCH_SCALING_FACTORS[matchCount];

            // Scale only the boost portion, not the base 1.0
            finalBoost = 1.0 + (boostSum * scalingFactor);
        } else {
            finalBoost = rawBoost;
        }

        if (matchedKeywords.length > 0) {
            const scaleInfo = diminishingReturns
                ? ` (raw=${rawBoost.toFixed(2)}x, scale=${(MATCH_SCALING_FACTORS[Math.min(matchedKeywords.length, 3)] * 100).toFixed(0)}%)`
                : '';
            console.log(`[VectHare Keyword Boost] Result matched ${matchedKeywords.length} keyword(s): [${matchedKeywords.map(k => `${k.text}(${k.weight.toFixed(2)}x)`).join(', ')}] → boost: ${finalBoost.toFixed(2)}x${scaleInfo}, score: ${result.score.toFixed(4)} → ${(result.score * finalBoost).toFixed(4)}`);
        }

        return {
            ...result,
            score: Math.min(1.0, result.score * finalBoost), // Cap at 1.0
            originalScore: result.score,
            keywordBoost: finalBoost,
            rawBoost: rawBoost,
            matchedKeywords: matchedKeywords.map(k => k.text),
            matchedKeywordsWithWeights: matchedKeywords,
            keywordBoosted: matchedKeywords.length > 0,
            diminishingReturns: diminishingReturns,
        };
    });

    // Sort by boosted score
    boosted.sort((a, b) => b.score - a.score);

    const boostedCount = boosted.filter(r => r.keywordBoosted).length;
    console.log(`[VectHare Keyword Boost] Applied keyword boosts to ${boostedCount}/${boosted.length} results (diminishing=${diminishingReturns})`);

    return boosted;
}

/**
 * Calculate overfetch amount for keyword boosting
 * We fetch more results than requested so boosted items can surface
 * @param {number} topK - Requested number of results
 * @returns {number} Amount to actually fetch
 */
export function getOverfetchAmount(topK) {
    // Fetch 2x the requested amount (min 10, max 100)
    return Math.min(100, Math.max(10, topK * 2));
}

/**
 * Apply keyword boosts and trim to requested topK
 * This is the main entry point for the query pipeline
 * @param {Array} results - Search results
 * @param {string} query - Search query
 * @param {number} topK - Number of results to return
 * @returns {Array} Boosted and trimmed results
 */
export function applyKeywordBoosts(results, query, topK) {
    const boosted = applyKeywordBoost(results, query);
    return boosted.slice(0, topK);
}
