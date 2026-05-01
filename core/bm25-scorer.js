/**
 * ============================================================================
 * BM25+ KEYWORD SCORING (ENHANCED)
 * ============================================================================
 * Enhanced implementation of BM25+ algorithm with:
 * - Porter Stemmer with LRU caching
 * - Comprehensive stop word filtering (190+ words)
 * - Sublinear term frequency: log(1 + tf)
 * - Coverage bonus: +10% when all query terms match
 * - Field boosting: Title (4x), Tags (4x), Content (1x)
 * - BM25+ IDF formula with delta smoothing
 *
 * Based on research showing BM25+ outperforms standard BM25 for long documents.
 *
 * @version 2.0.0
 * ============================================================================
 */

/**
 * Default BM25+ parameters
 * k1: Term frequency saturation parameter (1.2-2.0 typical)
 * b: Length normalization parameter (0.75 typical)
 * delta: BM25+ lower bound for term frequency (0.5 typical)
 */
const DEFAULT_K1 = 1.5;
const DEFAULT_B = 0.75;
const DEFAULT_DELTA = 0.5;

/**
 * Comprehensive English stopwords list (190+ words)
 */
const STOP_WORDS = new Set([
    // Articles & determiners
    'the', 'a', 'an', 'this', 'that', 'these', 'those', 'some', 'any', 'each',
    'every', 'both', 'either', 'neither', 'such', 'what', 'which', 'whose',
    // Pronouns
    'i', 'me', 'my', 'mine', 'myself', 'you', 'your', 'yours', 'yourself',
    'he', 'him', 'his', 'himself', 'she', 'her', 'hers', 'herself',
    'it', 'its', 'itself', 'we', 'us', 'our', 'ours', 'ourselves',
    'they', 'them', 'their', 'theirs', 'themselves',
    'who', 'whom', 'whoever', 'someone', 'anyone', 'everyone', 'nobody',
    'something', 'anything', 'everything', 'nothing',
    // Conjunctions
    'and', 'or', 'but', 'nor', 'so', 'yet', 'for', 'because', 'although',
    'while', 'whereas', 'unless', 'until', 'since', 'when', 'whenever',
    'where', 'wherever', 'whether', 'if', 'then', 'than', 'as',
    // Prepositions
    'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'into', 'onto',
    'upon', 'out', 'off', 'over', 'under', 'above', 'below', 'between', 'among',
    'through', 'during', 'before', 'after', 'behind', 'beside', 'beyond',
    'within', 'without', 'about', 'around', 'against', 'along', 'across',
    // Common verbs
    'be', 'am', 'is', 'are', 'was', 'were', 'been', 'being',
    'have', 'has', 'had', 'having', 'do', 'does', 'did', 'doing', 'done',
    'will', 'would', 'shall', 'should', 'may', 'might', 'must', 'can', 'could',
    'get', 'got', 'go', 'went', 'gone', 'come', 'came', 'take', 'took', 'taken',
    'make', 'made', 'say', 'said', 'know', 'knew', 'think', 'thought',
    'see', 'saw', 'seen', 'want', 'use', 'find', 'found', 'give', 'gave',
    // Adverbs
    'very', 'really', 'quite', 'just', 'only', 'even', 'also', 'still', 'already',
    'always', 'never', 'ever', 'often', 'sometimes', 'usually', 'now', 'then',
    'here', 'there', 'today', 'soon', 'again', 'much', 'more', 'most', 'less',
    'well', 'however', 'therefore', 'thus', 'too', 'enough',
    // Common adjectives
    'good', 'great', 'best', 'better', 'bad', 'new', 'old', 'big', 'small',
    'large', 'little', 'long', 'short', 'high', 'low', 'same', 'different',
    'other', 'another', 'next', 'last', 'first', 'many', 'few', 'own',
    // Other common words
    'thing', 'things', 'way', 'ways', 'place', 'part', 'case', 'point', 'fact',
    'like', 'back', 'time', 'year', 'day', 'one', 'two', 'three',

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

    // Chinese stopwords (Traditional - additional glyphs not covered by Simplified set above)
    '著', '過', '這', '誰', '什麼', '我們', '你們', '他們', '她們', '它們',
    '讓', '會', '沒', '說', '將',
    '與', '卻', '還', '雖',
    '其', '此', '已', '正', '便', '即', '仍', '曾', '各', '該',
    '從', '對', '為', '給', '於',
    '哪裡', '怎麼', '為什麼',
    '萬', '億', '個', '點', '幾',
    '裡', '裏', '後', '時', '現',
    '然後', '雖然', '不過', '總之',
]);

/**
 * Porter Stemmer cache (LRU-style with max size)
 */
const stemmerCache = new Map();
const STEMMER_CACHE_MAX = 10000;

/**
 * Porter Stemmer Algorithm
 * Reduces words to their root form for better matching
 * Examples: "running" → "run", "adventurers" → "adventur"
 *
 * @param {string} word - Word to stem
 * @returns {string} Stemmed word
 */
function porterStemmer(word) {
    if (!word || word.length <= 2) return word;

    // CJK characters: Porter stemming doesn't apply (no English morphology)
    if (/[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF]/.test(word)) return word;

    // Check cache first
    if (stemmerCache.has(word)) {
        return stemmerCache.get(word);
    }

    let stem = word.toLowerCase();
    let preserveE = false; // Track if we added 'e' via suffix rules

    // Step 1a: Remove plurals
    if (stem.endsWith('sses')) {
        stem = stem.slice(0, -2);
    } else if (stem.endsWith('ies')) {
        stem = stem.slice(0, -2);
    } else if (stem.endsWith('ss')) {
        // Keep as is
    } else if (stem.endsWith('s')) {
        stem = stem.slice(0, -1);
    }

    // Step 1b: Handle -ed and -ing
    const hasVowel = (s) => /[aeiou]/.test(s);

    if (stem.endsWith('eed')) {
        // Rule: EED → EE (simplified for better stemming)
        // Apply if there's any base remaining after removing 'eed'
        const base = stem.slice(0, -3); // Remove 'eed'
        if (base.length > 0) {
            stem = base + 'ee'; // agreed → agree, freed → free
            preserveE = true; // Preserve the double 'e'
        }
    } else if (stem.endsWith('ed')) {
        const base = stem.slice(0, -2);
        if (hasVowel(base)) {
            stem = base;
            // Handle double consonants
            if (stem.endsWith('at') || stem.endsWith('bl') || stem.endsWith('iz')) {
                stem += 'e';
                preserveE = true;
            } else if (/([^aeiouslz])\1$/.test(stem)) {
                stem = stem.slice(0, -1);
            }
        }
    } else if (stem.endsWith('ing')) {
        const base = stem.slice(0, -3);
        if (hasVowel(base)) {
            stem = base;
            if (stem.endsWith('at') || stem.endsWith('bl') || stem.endsWith('iz')) {
                stem += 'e';
                preserveE = true;
            } else if (/([^aeiouslz])\1$/.test(stem)) {
                stem = stem.slice(0, -1);
            }
        }
    }

    // Step 2: Common suffix replacements
    const step2Mappings = [
        ['ational', 'ate'], ['tional', 'tion'], ['enci', 'ence'], ['anci', 'ance'],
        ['izer', 'ize'], ['abli', 'able'], ['alli', 'al'], ['entli', 'ent'],
        ['eli', 'e'], ['ousli', 'ous'], ['ization', 'ize'], ['ation', 'ate'],
        ['ator', 'ate'], ['alism', 'al'], ['iveness', 'ive'], ['fulness', 'ful'],
        ['ousness', 'ous'], ['aliti', 'al'], ['iviti', 'ive'], ['biliti', 'ble'],
    ];

    for (const [suffix, replacement] of step2Mappings) {
        if (stem.endsWith(suffix) && stem.length > suffix.length + 2) {
            stem = stem.slice(0, -suffix.length) + replacement;
            if (replacement.endsWith('e')) preserveE = true;
            break;
        }
    }

    // Step 3: More suffix handling
    const step3Mappings = [
        ['icate', 'ic'], ['ative', ''], ['alize', 'al'],
        ['iciti', 'ic'], ['ical', 'ic'], ['ful', ''], ['ness', ''],
    ];

    for (const [suffix, replacement] of step3Mappings) {
        if (stem.endsWith(suffix) && stem.length > suffix.length + 2) {
            stem = stem.slice(0, -suffix.length) + replacement;
            break;
        }
    }

    // Step 4: Remove final 'e' in certain cases
    // Skip if 'e' was intentionally added by suffix replacement rules
    if (stem.endsWith('e') && stem.length > 3 && !preserveE) {
        const base = stem.slice(0, -1);
        // Count vowel-consonant sequences (m)
        const vcCount = (base.match(/[aeiou]+[^aeiou]+/g) || []).length;
        // Remove 'e' only if m > 1, OR if m = 1 and it doesn't end with CVC pattern
        const isCVC = /[^aeiou][aeiou][^aeiouxwy]$/.test(base);
        if (vcCount > 1 || (vcCount === 1 && !isCVC)) {
            stem = base;
        }
    }

    // Cache the result (with LRU eviction)
    if (stemmerCache.size >= STEMMER_CACHE_MAX) {
        const firstKey = stemmerCache.keys().next().value;
        stemmerCache.delete(firstKey);
    }
    stemmerCache.set(word, stem);

    return stem;
}

/**
 * Enhanced tokenizer with stemming and stop word removal
 * @param {string} text - Text to tokenize
 * @param {object} options - Tokenization options
 * @param {boolean} options.stem - Apply Porter stemming (default: true)
 * @param {boolean} options.removeStopWords - Remove stop words (default: true)
 * @param {number} options.minLength - Minimum token length (default: 2)
 * @returns {string[]} Array of processed tokens
 */
function tokenize(text, options = {}) {
    if (!text || typeof text !== 'string') return [];

    const {
        stem = true,
        removeStopWords = true,
        minLength = 2
    } = options;

    // Extract CJK word tokens using Intl.Segmenter (falls back to character-level)
    const cjkTokens = extractCJKTokens(text);

    // Strip CJK chars before Latin tokenization to avoid mixed clumps
    const _cjkCharRe = /[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF]/g;
    const latinText = text.replace(_cjkCharRe, ' ');

    // Normalize and split Latin
    let tokens = latinText
        .toLowerCase()
        .replace(/[^\w\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .split(/\s+/)
        .filter(token => token.length >= minLength);

    // Combine: CJK single chars are valid tokens (skip minLength filter)
    tokens = tokens.concat(cjkTokens);

    // Remove stop words
    if (removeStopWords) {
        tokens = tokens.filter(token => !STOP_WORDS.has(token));
    }

    // Apply Porter stemming (CJK tokens are returned unchanged by porterStemmer)
    if (stem) {
        tokens = tokens.map(token => {
            // Don't stem very short words or numbers
            if (token.length <= 3 || /^\d+$/.test(token)) return token;
            return porterStemmer(token);
        });
    }

    // Deduplicate (preserve order)
    return [...new Set(tokens)];
}

/**
 * Simple tokenizer (no stemming, no stop word removal)
 * For backwards compatibility
 */
function tokenizeSimple(text) {
    if (!text || typeof text !== 'string') return [];
    return text
        .toLowerCase()
        .replace(/[^\w\s]/g, ' ')
        .split(/\s+/)
        .filter(token => token.length > 0);
}

/**
 * Calculate term frequency (TF) for a document
 * @param {string[]} tokens - Document tokens
 * @returns {Map<string, number>} Map of term -> frequency
 */
function calculateTermFrequency(tokens) {
    const tf = new Map();
    for (const token of tokens) {
        tf.set(token, (tf.get(token) || 0) + 1);
    }
    return tf;
}

/**
 * Calculate inverse document frequency (IDF) for all terms
 * BM25+ IDF formula: max(0, log((N - df + 0.5) / (df + 0.5))) + delta
 * where N = total documents, df = documents containing term, delta = 0.5
 *
 * @param {Array<Map<string, number>>} documentTermFreqs - TF maps for all documents
 * @param {number} totalDocs - Total number of documents
 * @param {number} delta - BM25+ delta smoothing (default: 0.5)
 * @returns {Map<string, number>} Map of term -> IDF score
 */
function calculateIDF(documentTermFreqs, totalDocs, delta = DEFAULT_DELTA) {
    const documentFrequency = new Map();

    // Count how many documents contain each term
    for (const tfMap of documentTermFreqs) {
        const uniqueTerms = new Set(tfMap.keys());
        for (const term of uniqueTerms) {
            documentFrequency.set(term, (documentFrequency.get(term) || 0) + 1);
        }
    }

    // Calculate IDF for each term using BM25+ formula
    const idf = new Map();
    for (const [term, df] of documentFrequency.entries()) {
        // BM25+ IDF: max(0, log(...)) + delta to prevent negative values
        const rawIdf = Math.log((totalDocs - df + 0.5) / (df + 0.5));
        const idfScore = Math.max(0, rawIdf) + delta;
        idf.set(term, idfScore);
    }

    return idf;
}

/**
 * BM25+ Scorer class (Enhanced)
 * Maintains corpus statistics for efficient scoring
 *
 * Enhancements over standard BM25:
 * - Sublinear TF: log(1 + tf) prevents frequent terms from dominating
 * - Coverage bonus: +10% when all query terms match
 * - Field boosting: Title (4x), Tags (4x), Content (1x)
 * - BM25+ IDF with delta smoothing
 */
export class BM25Scorer {
    /**
     * @param {object} options - BM25+ parameters
     * @param {number} options.k1 - Term frequency saturation (default: 1.5)
     * @param {number} options.b - Length normalization (default: 0.75)
     * @param {number} options.delta - BM25+ IDF smoothing (default: 0.5)
     * @param {boolean} options.sublinearTf - Use sublinear TF: log(1+tf) (default: true)
     * @param {boolean} options.coverageBonus - Apply coverage bonus (default: true)
     * @param {boolean} options.fieldBoosting - Enable field boosting (default: false)
     */
    constructor(options = {}) {
        this.k1 = options.k1 ?? DEFAULT_K1;
        this.b = options.b ?? DEFAULT_B;
        this.delta = options.delta ?? DEFAULT_DELTA;
        this.sublinearTf = options.sublinearTf ?? true;
        this.coverageBonus = options.coverageBonus ?? true;
        this.fieldBoosting = options.fieldBoosting ?? false;

        // Corpus statistics
        this.documents = [];
        this.documentTermFreqs = [];
        this.documentLengths = [];
        this.avgDocLength = 0;
        this.idf = new Map();
        this.totalDocs = 0;
    }

    /**
     * Index a corpus of documents
     * @param {Array<{text: string, title?: string, tags?: string[], id?: any}>} documents - Documents to index
     */
    indexDocuments(documents) {
        this.documents = documents;
        this.totalDocs = documents.length;
        this.documentTermFreqs = [];
        this.documentLengths = [];

        // Tokenize and calculate TF for each document
        let totalLength = 0;
        for (const doc of documents) {
            let allTokens = [];
            let contentLength = 0; // Track only content tokens for length normalization

            // Field boosting: duplicate title/tag tokens for higher weight
            // Note: Boosted tokens count for TF but NOT for document length
            // This prevents length normalization from penalizing field-boosted docs
            if (this.fieldBoosting) {
                // Title tokens (4x weight)
                if (doc.title) {
                    const titleTokens = tokenize(doc.title);
                    for (let i = 0; i < 4; i++) {
                        allTokens.push(...titleTokens);
                    }
                }
                // Tag tokens (4x weight) - high weight since tags are curated keywords
                if (doc.tags && Array.isArray(doc.tags)) {
                    const tagTokens = doc.tags.flatMap(tag => tokenize(tag));
                    for (let i = 0; i < 4; i++) {
                        allTokens.push(...tagTokens);
                    }
                }
            }

            // Content tokens (1x weight)
            const contentTokens = tokenize(doc.text);
            allTokens.push(...contentTokens);
            contentLength = contentTokens.length;

            const tf = calculateTermFrequency(allTokens);

            this.documentTermFreqs.push(tf);
            // Use content length for normalization, not total tokens
            this.documentLengths.push(contentLength);
            totalLength += contentLength;
        }

        // Calculate average document length
        this.avgDocLength = this.totalDocs > 0 ? totalLength / this.totalDocs : 0;

        // Calculate IDF for all terms in corpus
        this.idf = calculateIDF(this.documentTermFreqs, this.totalDocs, this.delta);

        console.log(`[BM25+] Indexed ${this.totalDocs} documents, avg length: ${this.avgDocLength.toFixed(1)} tokens, sublinearTf=${this.sublinearTf}, fieldBoosting=${this.fieldBoosting}`);
    }

    /**
     * Score a single document against a query
     * BM25+ formula with sublinear TF:
     * tf_smart = log(1 + raw_tf)
     * score = Σ(IDF(qi) * (tf_smart(qi, D) * (k1 + 1)) / (tf_smart(qi, D) + k1 * lengthNorm))
     *
     * @param {string[]} queryTokens - Query tokens
     * @param {number} docIndex - Document index in corpus
     * @returns {number} BM25+ score
     */
    scoreDocument(queryTokens, docIndex) {
        if (this.avgDocLength === 0) return 0; // Avoid division by zero
        if (!queryTokens || queryTokens.length === 0) return 0;
        if (docIndex < 0 || docIndex >= this.totalDocs) return 0;

        const docTF = this.documentTermFreqs[docIndex];
        const docLength = this.documentLengths[docIndex];

        // Critical null checks to prevent crash with empty/invalid data
        if (!docTF || docLength === undefined || docLength === null) return 0;

        let score = 0;
        let matchedTerms = 0;

        for (const token of queryTokens) {
            const rawTf = docTF.get(token) || 0;
            if (rawTf === 0) continue; // Term not in document

            matchedTerms++;

            // Sublinear TF: log(1 + tf) prevents frequent terms from dominating
            const tf = this.sublinearTf ? Math.log(1 + rawTf) : rawTf;

            const idf = this.idf.get(token) || 0;

            // Length normalization factor
            const lengthNorm = 1 - this.b + this.b * (docLength / this.avgDocLength);

            // BM25+ term score
            const termScore = idf * (tf * (this.k1 + 1)) / (tf + this.k1 * lengthNorm);

            score += termScore;
        }

        // Coverage bonus: +10% when all query terms match
        if (this.coverageBonus && queryTokens.length > 0) {
            const coverage = matchedTerms / queryTokens.length;
            const bonus = coverage * 0.1; // Up to 10% bonus
            score *= (1 + bonus);
        }

        return score;
    }

    /**
     * Score all documents against a query and return ranked results
     * @param {string} query - Search query
     * @param {number} topK - Number of top results to return
     * @returns {Array<{index: number, score: number, document: object}>} Ranked results
     */
    search(query, topK = 10) {
        const queryTokens = tokenize(query);

        if (queryTokens.length === 0) {
            console.warn('[BM25] Empty query, returning empty results');
            return [];
        }

        // Score all documents
        const scores = [];
        for (let i = 0; i < this.totalDocs; i++) {
            const score = this.scoreDocument(queryTokens, i);
            scores.push({
                index: i,
                score: score,
                document: this.documents[i]
            });
        }

        // Sort by score descending and take topK
        scores.sort((a, b) => b.score - a.score);
        return scores.slice(0, topK);
    }

    /**
     * Score specific documents (by indices) against a query
     * Useful when you already have candidates from vector search
     *
     * @param {string} query - Search query
     * @param {Array<number>} indices - Document indices to score
     * @returns {Map<number, number>} Map of index -> BM25 score
     */
    scoreDocumentSubset(query, indices) {
        const queryTokens = tokenize(query);
        const scores = new Map();

        if (queryTokens.length === 0) {
            return scores;
        }

        for (const idx of indices) {
            if (idx >= 0 && idx < this.totalDocs) {
                const score = this.scoreDocument(queryTokens, idx);
                scores.set(idx, score);
            }
        }

        return scores;
    }
}

/**
 * Create a BM25 scorer from search results
 * Helper function for quick BM25 scoring without pre-indexing
 *
 * @param {Array<{text: string, hash?: number}>} results - Search results
 * @param {object} options - BM25 parameters
 * @returns {BM25Scorer} Initialized BM25 scorer
 */
export function createBM25Scorer(results, options = {}) {
    const scorer = new BM25Scorer(options);
    scorer.indexDocuments(results);
    return scorer;
}

/**
 * Apply BM25 scores to search results and re-rank
 * Combines vector similarity with BM25 keyword relevance
 *
 * @param {Array} results - Vector search results [{text, score, hash, ...}]
 * @param {string} query - Search query
 * @param {object} options - Scoring options
 * @param {number} options.k1 - BM25 k1 parameter
 * @param {number} options.b - BM25 b parameter
 * @param {number} options.alpha - Weight for vector score (default: 0.5)
 * @param {number} options.beta - Weight for BM25 score (default: 0.5)
 * @returns {Array} Re-ranked results with BM25 scores
 */
export function applyBM25Scoring(results, query, options = {}) {
    if (!results || results.length === 0) return [];
    if (!query || typeof query !== 'string') return results;

    const {
        k1 = DEFAULT_K1,
        b = DEFAULT_B,
        alpha = 0.5,  // Weight for vector similarity
        beta = 0.5    // Weight for BM25 score
    } = options;

    console.log(`[BM25] Applying BM25 scoring to ${results.length} results (k1=${k1}, b=${b}, α=${alpha}, β=${beta})`);

    // Create BM25 scorer
    const scorer = createBM25Scorer(results, { k1, b });

    // Score all results
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) {
        console.warn('[BM25] Empty query after tokenization, returning original results');
        return results;
    }
    
    const bm25Scores = results.map((_, idx) => scorer.scoreDocument(queryTokens, idx));
    const maxBM25Score = bm25Scores.length > 0 ? Math.max(...bm25Scores, 0.0001) : 0.0001;

    // Combine scores
    const scoredResults = results.map((result, idx) => {
        const bm25Score = scorer.scoreDocument(queryTokens, idx);
        const normalizedBM25 = maxBM25Score > 0 ? bm25Score / maxBM25Score : 0;

        // Normalize vector score to [0, 1] range (assuming it's already in [0, 1])
        const normalizedVector = result.originalScore ?? result.score;

        // Combined score: weighted sum of vector and BM25 scores
        const combinedScore = alpha * normalizedVector + beta * normalizedBM25;

        return {
            ...result,
            score: combinedScore,
            vectorScore: normalizedVector,
            bm25Score: bm25Score,
            normalizedBM25: normalizedBM25,
            originalScore: result.originalScore ?? result.score
        };
    });

    // Sort by combined score
    scoredResults.sort((a, b) => b.score - a.score);

    console.log(`[BM25] Top result: vector=${scoredResults[0].vectorScore.toFixed(4)}, bm25=${scoredResults[0].bm25Score.toFixed(4)}, combined=${scoredResults[0].score.toFixed(4)}`);

    return scoredResults;
}

// ---------------------------------------------------------------------------
// CJK word segmentation via Intl.Segmenter (browser-native, zero dependencies)
// Falls back to bigram tokenization if the API is unavailable.
//
// LANGUAGE SUPPORT:
//   Currently active:  Chinese (zh) — CJK Unified Ideographs
//   Prepared for:      Japanese (ja) — add Hiragana/Katakana to _CJK_SPAN_RE and
//                        call _getSegmenter(span) which already auto-detects kana
//   Future:            Korean (ko) — add Hangul to _CJK_SPAN_RE, detected via _KANA_RE
// ---------------------------------------------------------------------------

/** Matches CJK Unified Ideograph spans (Chinese).
 *  To add Japanese: append \u3040-\u309F\u30A0-\u30FF inside the character class. */
const _CJK_SPAN_RE = /[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF]+/g;

/** Kana presence → Japanese locale. Extend when adding Korean (\uAC00-\uD7AF). */
const _KANA_RE = /[\u3040-\u309F\u30A0-\u30FF]/;

let _zhSegmenter;
function _getZhSegmenter() {
    if (_zhSegmenter === undefined) {
        try { _zhSegmenter = new Intl.Segmenter('zh', { granularity: 'word' }); }
        catch (e) { _zhSegmenter = null; }
    }
    return _zhSegmenter;
}

// Placeholder for future Japanese support — wired into _getSegmenter() already.
let _jaSegmenter;
function _getJaSegmenter() {
    if (_jaSegmenter === undefined) {
        try { _jaSegmenter = new Intl.Segmenter('ja', { granularity: 'word' }); }
        catch (e) { _jaSegmenter = null; }
    }
    return _jaSegmenter;
}

/**
 * Return the best available Intl.Segmenter for the given span.
 * Kana characters signal Japanese; otherwise assume Chinese.
 * Add new locale branches here as languages are enabled.
 * @param {string} span
 * @returns {Intl.Segmenter|null}
 */
function _getSegmenter(span) {
    // Japanese detection: span contains Hiragana or Katakana
    // (Currently _CJK_SPAN_RE never produces kana spans, so this branch is
    //  a no-op until _CJK_SPAN_RE is extended to include kana ranges.)
    if (_KANA_RE.test(span)) return _getJaSegmenter();
    return _getZhSegmenter();
}

/**
 * Tokenize a single segmented span using the run-merging strategy.
 *
 * The segmenter often returns ALL single-char segments for unknown proper names
 * (e.g. character names like 偲雅伶绪). But when a name appears adjacent to a
 * known word in the same span (e.g. 向偲雅伶绪问候), the "all single" check
 * used previously failed and fragmented the name.
 *
 * Run-merging fix: accumulate consecutive single-char word-like segments into a
 * "run". Flush the run as one compound token when a multi-char word interrupts it
 * or the span ends. This preserves known words (聚餐, 问候) as individual tokens
 * while keeping unknown proper names intact.
 *
 * @param {Intl.Segmenter} segmenter
 * @param {string} span
 * @returns {string[]}
 */
function _segmentSpan(segmenter, span) {
    const wordSegs = [...segmenter.segment(span)].filter(s => s.isWordLike);
    if (wordSegs.length === 0) return span.length >= 2 ? [span] : [];

    const tokens = [];
    let singleRun = '';

    for (const seg of wordSegs) {
        if (seg.segment.length === 1) {
            // Accumulate single-char segments into a run (potential proper name)
            singleRun += seg.segment;
        } else {
            // Multi-char known word encountered — flush accumulated run first
            if (singleRun.length >= 2) tokens.push(singleRun);
            else if (singleRun.length === 1) tokens.push(singleRun); // keep solo chars
            singleRun = '';
            tokens.push(seg.segment);
        }
    }
    // Flush any remaining run
    if (singleRun.length > 0) tokens.push(singleRun);

    // Safety: if nothing produced (e.g. all filtered), emit whole span
    return tokens.length > 0 ? tokens : (span.length >= 2 ? [span] : []);
}

/**
 * Fallback tokenizer used when Intl.Segmenter is unavailable.
 * Produces overlapping bigrams from each CJK span — a standard degraded-mode
 * approach for CJK BM25 that performs far better than single characters and
 * works equally well for Chinese and Japanese.
 *
 * Example: "聚餐问候" → ["聚餐", "餐问", "问候"]
 * @param {string} span
 * @returns {string[]}
 */
function _bigramFallback(span) {
    if (span.length < 2) return span.length === 1 ? [span] : [];
    const bigrams = [];
    for (let i = 0; i < span.length - 1; i++) {
        bigrams.push(span[i] + span[i + 1]);
    }
    return bigrams;
}

/**
 * Extract CJK word tokens from text.
 *
 * Uses Intl.Segmenter with run-merging to preserve proper names while still
 * splitting known compound words. Falls back to overlapping bigrams when the
 * Segmenter API is unavailable (older environments / SillyTavern).
 *
 * Currently handles Chinese. To add Japanese support:
 *   1. Extend _CJK_SPAN_RE to include \u3040-\u309F (Hiragana) and \u30A0-\u30FF (Katakana)
 *   2. _getSegmenter() already routes kana-containing spans to _getJaSegmenter()
 *   That's it — no other changes needed.
 *
 * @param {string} text
 * @returns {string[]}
 */
function extractCJKTokens(text) {
    const spans = text.match(_CJK_SPAN_RE);
    if (!spans) return [];

    const tokens = [];
    for (const span of spans) {
        const segmenter = _getSegmenter(span);
        if (segmenter) {
            for (const tok of _segmentSpan(segmenter, span)) tokens.push(tok);
        } else {
            for (const tok of _bigramFallback(span)) tokens.push(tok);
        }
    }
    return tokens;
}

/**
 * Export Porter Stemmer for use by other modules
 */
export { porterStemmer, tokenize, tokenizeSimple, STOP_WORDS, extractCJKTokens };
