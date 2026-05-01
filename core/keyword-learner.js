/**
 * ============================================================================
 * VECTHARE KEYWORD LEARNER
 * ============================================================================
 * Analyzes individual entries to suggest keywords based on word frequency
 * within that entry's content.
 *
 * If a word appears X times in an entry, suggest it as a keyword for that entry.
 *
 * @version 1.0.0
 * ============================================================================
 */

import { extractCJKTokens } from './bm25-scorer.js';

// Stop words to ignore
const STOP_WORDS = new Set([
   "0o", "0s", "3a", "3b", "3d", "6b", "6o", "a", "a1", "a2", "a3", "a4",
            "ab", "able", "about", "above", "abst", "ac", "accordance", "according",
            "accordingly", "across", "act", "actually", "ad", "added", "adj", "ae",
            "af", "affected", "affecting", "affects", "after", "afterwards", "ag",
            "again", "against", "ah", "ain", "ain't", "aj", "al", "all", "allow",
            "allows", "almost", "alone", "along", "already", "also", "although",
            "always", "am", "among", "amongst", "amoungst", "amount", "an", "and",
            "announce", "another", "any", "anybody", "anyhow", "anymore", "anyone",
            "anything", "anyway", "anyways", "anywhere", "ao", "ap", "apart", "apparently",
            "appear", "appreciate", "appropriate", "approximately", "ar", "are", "aren", "arent",
            "aren't", "arise", "around", "as", "a's", "aside", "ask", "asking", "associated",
            "at", "au", "auth", "av", "available", "aw", "away", "awfully", "ax", "ay", "az",
            "b", "b1", "b2", "b3", "ba", "back", "bc", "bd", "be", "became", "because",
            "become", "becomes", "becoming", "been", "before", "beforehand", "begin",
            "beginning", "beginnings", "begins", "behind", "being", "believe",
            "below", "beside", "besides", "best", "better", "between", "beyond",
            "bi", "bill", "biol", "bj", "bk", "bl", "bn", "both", "bottom", "bp", "br",
            "brief", "briefly", "bs", "bt", "bu", "but", "bx", "by", "c", "c1", "c2",
            "c3", "ca", "call", "came", "can", "cannot", "cant", "can't", "cause",
            "causes", "cc", "cd", "ce", "certain", "certainly", "cf", "cg", "ch",
            "changes", "ci", "cit", "cj", "cl", "clearly", "cm", "c'mon", "cn",
            "co", "com", "come", "comes", "con", "concerning", "consequently",
            "consider", "considering", "contain", "containing", "contains",
            "corresponding", "could", "couldn", "couldnt", "couldn't", "course",
            "cp", "cq", "cr", "cry", "cs", "c's", "ct", "cu", "currently", "cv",
            "cx", "cy", "cz", "d", "d2", "da", "date", "dc", "dd", "de", "definitely",
            "describe", "described", "despite", "detail", "df", "di", "did", "didn",
            "didn't", "different", "dj", "dk", "dl", "do", "does", "doesn", "doesn't",
            "doing", "don", "done", "don't", "down", "downwards", "dp", "dr", "ds",
            "dt", "du", "due", "during", "dx", "dy", "e", "e2", "e3", "ea", "each", "ec",
            "ed", "edu", "ee", "ef", "effect", "eg", "ei", "eight", "eighty", "either", "ej",
            "el", "eleven", "else", "elsewhere", "em", "empty", "en", "end", "ending", "enough",
            "entirely", "eo", "ep", "eq", "er", "es", "especially", "est", "et", "et-al",
            "etc", "eu", "ev", "even", "ever", "every", "everybody", "everyone",
            "everything", "everywhere", "ex", "exactly", "example", "except", "ey",
            "f", "f2", "fa", "far", "fc", "few", "ff", "fi", "fifteen", "fifth", "fify",
            "fill", "find", "fire", "first", "five", "fix", "fj", "fl", "fn", "fo", "followed",
            "following", "follows", "for", "former", "formerly", "forth", "forty", "found", "four", "fr",
            "from", "front", "fs", "ft", "fu", "full", "further", "furthermore", "fy", "g", "ga",
            "gave", "ge", "get", "gets", "getting", "gi", "give", "given", "gives", "giving", "gj",
            "gl", "go", "goes", "going", "gone", "got", "gotten", "gr", "greetings", "gs", "gy", "h",
            "h2", "h3", "had", "hadn", "hadn't", "happens", "hardly", "has", "hasn", "hasnt", "hasn't",
            "have", "haven", "haven't", "having", "he", "hed", "he'd", "he'll", "hello", "help", "hence",
            "her", "here", "hereafter", "hereby", "herein", "heres", "here's", "hereupon", "hers", "herself",
            "hes", "he's", "hh", "hi", "hid", "him", "himself", "his", "hither", "hj", "ho",
            "home", "hopefully", "how", "howbeit", "however", "how's", "hr", "hs", "http", "hu",
            "hundred", "hy", "i", "i2", "i3", "i4", "i6", "i7", "i8", "ia", "ib", "ibid", "ic",
            "id", "i'd", "ie", "if", "ig", "ignored", "ih", "ii", "ij", "il", "i'll", "im", "i'm",
            "immediate", "immediately", "importance", "important", "in", "inasmuch", "inc", "indeed",
            "index", "indicate", "indicated", "indicates", "information", "inner", "insofar", "instead",
            "interest", "into", "invention", "inward", "io", "ip", "iq", "ir", "is", "isn", "isn't",
            "it", "itd", "it'd", "it'll", "its", "it's", "itself", "iv", "i've", "ix", "iy", "iz",
            "j", "jj", "jr", "js", "jt", "ju", "just", "k", "ke", "keep", "keeps", "kept", "kg", "kj",
            "km", "know", "known", "knows", "ko", "l", "l2", "la", "largely", "last", "lately", "later",
            "latter", "latterly", "lb", "lc", "le", "least", "les", "less", "lest", "let", "lets", "let's",
            "lf", "like", "liked", "likely", "line", "little", "lj", "ll", "ll", "ln", "lo", "look",
            "looking", "looks", "los", "lr", "ls", "lt", "ltd", "m", "m2", "ma", "made", "mainly", "make",
            "makes", "many", "may", "maybe", "me", "mean", "means", "meantime", "meanwhile", "merely", "mg",
            "might", "mightn", "mightn't", "mill", "million", "mine", "miss", "ml", "mn", "mo", "more",
            "moreover", "most", "mostly", "move", "mr", "mrs", "ms", "mt", "mu", "much", "mug", "must", "mustn",
            "mustn't", "my", "myself", "n", "n2", "na", "name", "namely", "nay", "nc", "nd", "ne", "near", "nearly",
            "necessarily", "necessary", "need", "needn", "needn't", "needs", "neither", "never", "nevertheless", "new",
            "next", "ng", "ni", "nine", "ninety", "nj", "nl", "nn", "no", "nobody", "non", "none", "nonetheless", "noone",
            "nor", "normally", "nos", "not", "noted", "nothing", "novel", "now", "nowhere", "nr", "ns", "nt", "ny", "o", "oa",
            "ob", "obtain", "obtained", "obviously", "oc", "od", "of", "off", "often", "og", "oh", "oi", "oj", "ok", "okay", "ol",
            "old", "om", "omitted", "on", "once", "one", "ones", "only", "onto", "oo", "op", "oq", "or", "ord", "os", "ot",
            "other", "others", "otherwise", "ou", "ought", "our", "ours", "ourselves", "out", "outside", "over", "overall", "ow",
            "owing", "own", "ox", "oz", "p", "p1", "p2", "p3", "page", "pagecount", "pages", "par", "part", "particular", "particularly",
            "pas", "past", "pc", "pd", "pe", "per", "perhaps", "pf", "ph", "pi", "pj", "pk", "pl", "placed", "please", "plus", "pm", "pn", "po",
            "poorly", "possible", "possibly", "potentially", "pp", "pq", "pr", "predominantly", "present", "presumably", "previously", "primarily",
            "probably", "promptly", "proud", "provides", "ps", "pt", "pu", "put", "py", "q", "qj", "qu", "que",
            "quickly", "quite", "qv", "r", "r2", "ra", "ran", "rather", "rc", "rd", "re", "readily", "really",
            "reasonably", "recent", "recently", "ref", "refs", "regarding", "regardless", "regards", "related",
            "relatively", "research", "research-articl", "respectively", "resulted", "resulting", "results",
            "rf", "rh", "ri", "right", "rj", "rl", "rm", "rn", "ro", "rq", "rr", "rs", "rt", "ru", "run", "rv", "ry", "s", "s2",
            "sa", "said", "same", "saw", "say", "saying", "says", "sc", "sd", "se", "sec", "second", "secondly",
            "section", "see", "seeing", "seem", "seemed", "seeming", "seems", "seen", "self", "selves", "sensible",
            "sent", "serious", "seriously", "seven", "several", "sf", "shall", "shan", "shan't", "she", "shed", "she'd",
            "she'll", "shes", "she's", "should", "shouldn", "shouldn't", "should've", "show", "showed", "shown",
            "showns", "shows", "si", "side", "significant", "significantly", "similar", "similarly", "since",
            "sincere", "six", "sixty", "sj", "sl", "slightly", "sm", "sn", "so", "some", "somebody", "somehow",
            "someone", "somethan", "something", "sometime", "sometimes", "somewhat", "somewhere", "soon",
            "sorry", "sp", "specifically", "specified", "specify", "specifying", "sq", "sr", "ss", "st", "still",
            "stop", "strongly", "sub", "substantially", "successfully", "such", "sufficiently", "suggest", "sup",
            "sure", "sy", "system", "sz", "t", "t1", "t2", "t3", "take", "taken", "taking", "tb", "tc", "td",
            "te", "tell", "ten", "tends", "tf", "th", "than", "thank", "thanks", "thanx", "that", "that'll",
            "thats", "that's", "that've", "the", "their", "theirs", "them", "themselves", "then", "thence",
            "there", "thereafter", "thereby", "thered", "therefore", "therein", "there'll", "thereof",
            "therere", "theres", "there's", "thereto", "thereupon", "there've", "these", "they", "theyd",
            "they'd", "they'll", "theyre", "they're", "they've", "thickv", "thin", "think", "third", "this",
            "thorough", "thoroughly", "those", "thou", "though", "thoughh", "thousand", "three", "throug",
            "through", "throughout", "thru", "thus", "ti", "til", "tip", "tj", "tl", "tm", "tn", "to", "together",
            "too", "took", "top", "toward", "towards", "tp", "tq", "tr", "tried", "tries", "truly", "try",
            "trying", "ts", "t's", "tt", "tv", "twelve", "twenty", "twice", "two", "tx", "u", "u201d",
            "ue", "ui", "uj", "uk", "um", "un", "under", "unfortunately", "unless", "unlike", "unlikely",
            "until", "unto", "uo", "up", "upon", "ups", "ur", "us", "use", "used", "useful", "usefully",
            "usefulness", "uses", "using", "usually", "ut", "v", "va", "value", "various", "vd", "ve",
            "ve", "very", "via", "viz", "vj", "vo", "vol", "vols", "volumtype", "vq", "vs", "vt", "vu",
            "w", "wa", "want", "wants", "was", "wasn", "wasnt", "wasn't", "way", "we", "wed", "we'd",
            "welcome", "well", "we'll", "well-b", "went", "were", "we're", "weren", "werent", "weren't",
            "we've", "what", "whatever", "what'll", "whats", "what's", "when", "whence", "whenever",
            "when's", "where", "whereafter", "whereas", "whereby", "wherein", "wheres", "where's",
            "whereupon", "wherever", "whether", "which", "while", "whim", "whither", "who", "whod",
            "whoever", "whole", "who'll", "whom", "whomever", "whos", "who's", "whose", "why", "why's",
            "wi", "widely", "will", "willing", "wish", "with", "within", "without", "wo", "won",
            "wonder", "wont", "won't", "words", "world", "would", "wouldn", "wouldnt", "wouldn't",
            "www", "x", "x1", "x2", "x3", "xf", "xi", "xj", "xk", "xl", "xn", "xo", "xs", "xt",
            "xv", "xx", "y", "y2", "yes", "yet", "yj", "yl", "you", "youd", "you'd", "you'll", "your",
            "youre", "you're", "yours", "yourself", "yourselves", "you've", "yr", "ys", "yt", "z",
            "zero", "zi", "zz",
            // Chinese stopwords (Simplified) - particles, pronouns, function verbs, conjunctions, prepositions, quantifiers, locations, time, connectives
            "的", "地", "得", "着", "了", "过", "嘛", "呢", "吧", "啊", "哦", "哈", "嗯",
            "我", "你", "他", "她", "它", "谁", "这", "那", "哪",
            "我们", "你们", "他们", "她们", "它们",
            "是", "有", "在", "被", "让", "把", "使", "叫", "会", "要", "能", "说", "做", "来", "去", "到", "看", "用",
            "和", "与", "及", "或", "但", "而", "因", "所", "如", "既", "虽", "若", "则", "就", "才", "也", "还", "都", "又", "再", "不", "没", "很", "最", "更", "只",
            "于", "以", "从", "由", "向", "往", "对", "为", "给", "按", "比", "跟", "同",
            "什么", "怎么", "为什么", "哪里",
            "一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "百", "千", "万", "亿", "个", "些", "点", "多", "少", "几",
            "上", "下", "中", "内", "外", "里", "前", "后", "左", "右", "今", "年", "月", "日", "时", "现在", "以前", "以后",
            "但是", "所以", "因此", "然后", "虽然", "不过", "而且", "另外", "此外", "总之", "如果", "即使",
            // Chinese stopwords (Traditional - additional glyphs not covered above)
            "著", "過", "這", "誰", "什麼", "我們", "你們", "他們", "她們", "它們",
            "讓", "會", "沒", "說",
            "與", "卻", "還", "雖",
            "從", "對", "為", "給", "於",
            "哪裡", "怎麼", "為什麼",
            "萬", "億", "個", "點", "幾",
            "裡", "裏", "後", "時", "現",
            "然後", "雖然", "不過", "總之",
]);

// Minimum word length
const MIN_WORD_LENGTH = 4;

// Default threshold - word must appear this many times to be suggested
const DEFAULT_THRESHOLD = 3;

/**
 * Check if a word is trackable (not a stop word, long enough, etc.)
 * @param {string} word
 * @returns {boolean}
 */
function isTrackableWord(word) {
    if (!word || typeof word !== 'string') return false;
    const normalized = word.toLowerCase().trim();
    // CJK detection: single chars are meaningful (Simplified + Traditional)
    const isCJK = /^[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF]+$/.test(normalized);
    if (!isCJK && normalized.length < MIN_WORD_LENGTH) return false;
    if (STOP_WORDS.has(normalized)) return false;
    if (/\d/.test(normalized)) return false;
    if (!isCJK && !/^[a-z]+$/i.test(normalized)) return false;
    return true;
}

/**
 * Count word frequency in text
 * @param {string} text - Text to analyze
 * @returns {Map<string, number>} Word frequency map
 */
function countWords(text) {
    if (!text || typeof text !== 'string') return new Map();

    // Extract CJK words using Intl.Segmenter (Simplified + Traditional)
    const cjkWords = extractCJKTokens(text);

    // Latin words from text with CJK stripped
    const _cjkStripRe = /[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF]/g;
    const latinWords = text.replace(_cjkStripRe, ' ').split(/[^a-zA-Z]+/);

    const words = [...latinWords, ...cjkWords].filter(isTrackableWord);
    const counts = new Map();

    for (const word of words) {
        const normalized = word.toLowerCase();
        counts.set(normalized, (counts.get(normalized) || 0) + 1);
    }

    return counts;
}

/**
 * Get suggested keywords for a single entry based on word frequency
 * @param {string} text - Entry content
 * @param {number} threshold - Minimum occurrences to suggest (default: 3)
 * @returns {Array<{word: string, count: number}>} Suggested keywords sorted by frequency
 */
export function getSuggestedKeywordsForEntry(text, threshold = DEFAULT_THRESHOLD) {
    const counts = countWords(text);
    const suggestions = [];

    for (const [word, count] of counts) {
        if (count >= threshold) {
            suggestions.push({ word, count });
        }
    }

    // Sort by count descending
    suggestions.sort((a, b) => b.count - a.count);

    return suggestions;
}

/**
 * Get suggested keywords as simple string array
 * @param {string} text - Entry content
 * @param {number} threshold - Minimum occurrences (default: 3)
 * @returns {string[]} Array of suggested keyword strings
 */
export function extractSuggestedKeywords(text, threshold = DEFAULT_THRESHOLD) {
    return getSuggestedKeywordsForEntry(text, threshold).map(s => s.word);
}

/**
 * Analyze an entry and return full word frequency data
 * @param {string} text - Entry content
 * @returns {{total: number, unique: number, frequencies: Array<{word: string, count: number}>}}
 */
export function analyzeEntry(text) {
    const counts = countWords(text);
    const frequencies = [];

    let total = 0;
    for (const [word, count] of counts) {
        frequencies.push({ word, count });
        total += count;
    }

    frequencies.sort((a, b) => b.count - a.count);

    return {
        total,
        unique: counts.size,
        frequencies,
    };
}
