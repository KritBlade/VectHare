/**
 * ============================================================================
 * VECTHARE CONDITIONAL ACTIVATION SYSTEM
 * ============================================================================
 * Evaluates conditions to determine if chunks should be activated
 * Ported from legacy VectHare with enhanced structure
 *
 * @author Coneja Chibi
 * @version 2.2.0-alpha
 * ============================================================================
 */

// ============================================================================
// EXPRESSIONS EXTENSION INTEGRATION
// ============================================================================

// Try to import expressions extension for emotion detection
let expressionsExtension = null;
let expressionsExtensionStatus = {
    available: false,
    enabled: false,
    lastCheck: null,
    error: null,
};

/**
 * Initializes the expressions extension integration
 * Called during module load
 */
async function initExpressionsExtension() {
    try {
        // Dynamic import of expressions extension (may not be available)
        const module = await import('../../../expressions/index.js');
        expressionsExtension = module;
        expressionsExtensionStatus.available = true;
        expressionsExtensionStatus.enabled = true;
        expressionsExtensionStatus.lastCheck = Date.now();
        console.log('VectHare Conditions: Character Expressions extension loaded for emotion detection');
    } catch (e) {
        expressionsExtensionStatus.available = false;
        expressionsExtensionStatus.enabled = false;
        expressionsExtensionStatus.error = e.message;
        expressionsExtensionStatus.lastCheck = Date.now();
        console.log('VectHare Conditions: Character Expressions extension not available, using keyword-based emotion detection');
    }
}

// Initialize on module load
initExpressionsExtension();

/**
 * Gets the current status of the Character Expressions extension integration
 * @returns {object} Status object with availability info and user message
 */
export function getExpressionsExtensionStatus() {
    const status = { ...expressionsExtensionStatus };

    if (status.available && status.enabled) {
        status.message = 'Character Expressions extension is active. Emotion detection uses sprite-based detection with keyword fallback.';
        status.level = 'success';
    } else if (status.available && !status.enabled) {
        status.message = 'Character Expressions extension is installed but disabled. Enable it for enhanced emotion detection.';
        status.level = 'warning';
    } else {
        status.message = 'Character Expressions extension not found. Emotion detection uses keyword matching only. Install the extension for sprite-based emotion detection.';
        status.level = 'info';
    }

    return status;
}

/**
 * Re-checks expressions extension availability
 * Call this if user enables/disables the extension
 */
export async function recheckExpressionsExtension() {
    await initExpressionsExtension();
    return getExpressionsExtensionStatus();
}

// ============================================================================
// EMOTION KEYWORDS & PATTERNS
// ============================================================================

/**
 * Enhanced emotion patterns - supports both plain keywords and regex patterns.
 * Maps emotion names to arrays of patterns for fallback detection.
 *
 * Pattern format:
 * - Plain string: 'happy' (case-insensitive contains match)
 * - Regex string: '/laugh(s|ed|ing)?/i' (parsed as RegExp)
 *
 * These patterns are used when Character Expressions extension is unavailable
 * or as a fallback when expressions don't match.
 *
 * NOTE: Future expansion planned for ML-based emotion detection.
 * See collection-metadata.js for roadmap notes.
 */
export const EMOTION_KEYWORDS = {
    // Positive emotions
    joy: ['joy', 'happy', 'smile', 'laugh', 'glad', 'cheerful', 'delighted', 'pleased', 'joyful', 'happiness', '/\\b(grin|beam|radiat)\\w*/i'],
    amusement: ['amusement', 'amused', 'funny', 'humorous', 'entertaining', 'playful', '/\\b(giggl|chuckl|snicker)\\w*/i'],
    love: ['love', 'adore', 'cherish', 'affection', 'beloved', 'loving', 'tender', '/\\b(heart|sweetheart|darling)\\b/i'],
    caring: ['caring', 'care', 'compassion', 'kind', 'gentle', 'nurturing', 'supportive', '/\\b(comfort|sooth|consol)\\w*/i'],
    admiration: ['admiration', 'admire', 'respect', 'impressed', 'awe', 'wonderful', '/\\b(amaz|incredibl|remarkab)\\w*/i'],
    approval: ['approval', 'approve', 'agree', 'accept', 'support', 'endorse', '/\\b(nod|yes|correct)\\b/i'],
    excitement: ['excitement', 'excited', 'thrilled', 'energetic', 'pumped', 'hyped', 'enthusiastic', '/!{2,}/'],
    gratitude: ['gratitude', 'grateful', 'thankful', 'thanks', 'appreciate', 'appreciation', '/\\bthank\\w*/i'],
    optimism: ['optimism', 'optimistic', 'hopeful', 'positive', 'confident', 'upbeat', '/\\b(bright|promis)\\w*/i'],
    pride: ['pride', 'proud', 'accomplished', 'achievement', 'success', 'triumphant'],
    relief: ['relief', 'relieved', 'ease', 'calm', 'relaxed', 'unburdened', '/\\b(phew|sigh|finally)\\b/i'],
    desire: ['desire', 'want', 'wish', 'crave', 'yearn', 'longing', 'passion', '/\\b(need|must have)\\b/i'],

    // Negative emotions
    anger: ['anger', 'angry', 'mad', 'furious', 'rage', 'hostile', 'wrath', 'irate', '/!{3,}/', '/\\b(damn|hell|fury)\\b/i'],
    annoyance: ['annoyance', 'annoyed', 'irritated', 'bothered', 'frustrated', 'vexed', '/\\b(ugh|argh|tsk)\\b/i'],
    disapproval: ['disapproval', 'disapprove', 'disagree', 'reject', 'oppose', 'condemn', '/\\b(no|wrong|bad)\\b/i'],
    disgust: ['disgust', 'disgusted', 'repulsed', 'revolted', 'nauseated', 'repelled', '/\\b(ew+|gross|yuck)\\b/i'],
    sadness: ['sadness', 'sad', 'unhappy', 'miserable', 'sorrowful', 'melancholy', 'down', '/\\b(cry|tear|sob|weep)\\w*/i'],
    grief: ['grief', 'grieving', 'mourn', 'loss', 'bereavement', 'heartbroken', '/\\b(lost|gone|miss)\\w*/i'],
    disappointment: ['disappointment', 'disappointed', 'letdown', 'dissatisfied', 'disheartened'],
    remorse: ['remorse', 'regret', 'guilty', 'ashamed', 'sorry', 'repentant', '/\\b(apolog|forgive)\\w*/i'],
    embarrassment: ['embarrassment', 'embarrassed', 'awkward', 'self-conscious', 'humiliated', 'flustered', '/\\b(blush|flush)\\w*/i'],
    fear: ['fear', 'afraid', 'scared', 'terrified', 'frightened', 'dread', 'alarmed', '/\\b(trembl|shak|shiver)\\w*/i'],
    nervousness: ['nervousness', 'nervous', 'anxious', 'worried', 'uneasy', 'jittery', 'tense', '/\\b(sweat|fidget|pace)\\w*/i'],

    // Mixed/Neutral emotions
    surprise: ['surprise', 'surprised', 'shocked', 'amazed', 'astonished', 'startled', 'stunned', '/\\b(what|wow|oh)\\b/i', '/\\?{2,}/'],
    curiosity: ['curiosity', 'curious', 'interested', 'intrigued', 'inquisitive', 'wondering', '/\\b(hmm+|wonder)\\w*/i'],
    confusion: ['confusion', 'confused', 'puzzled', 'perplexed', 'bewildered', 'uncertain', '/\\b(huh|what|eh)\\?/i'],
    realization: ['realization', 'realize', 'understand', 'comprehend', 'grasp', 'see', 'aha', '/\\b(oh!|aha|eureka)\\b/i'],
    neutral: [] // Neutral has no keywords
};

/**
 * List of all valid emotion names
 */
export const VALID_EMOTIONS = Object.keys(EMOTION_KEYWORDS);

/**
 * Parses a pattern string into a matcher function
 * @param {string} pattern - Plain string or regex pattern (e.g., '/pattern/flags')
 * @returns {function} Function that takes text and returns boolean
 */
function parseEmotionPattern(pattern) {
    // Check if it's a regex pattern
    if (pattern.startsWith('/')) {
        const match = pattern.match(/^\/(.+)\/([gimsuy]*)$/);
        if (match) {
            try {
                const regex = new RegExp(match[1], match[2]);
                return (text) => regex.test(text);
            } catch (e) {
                console.warn(`VectHare: Invalid regex pattern: ${pattern}`, e);
                return () => false;
            }
        }
    }

    // Plain string - case-insensitive contains
    const lowerPattern = pattern.toLowerCase();
    return (text) => text.toLowerCase().includes(lowerPattern);
}

/**
 * Checks if text matches any pattern for an emotion
 * @param {string} emotionName - Name of the emotion
 * @param {string} text - Text to check
 * @returns {boolean} Whether any pattern matches
 */
export function matchesEmotionPatterns(emotionName, text) {
    const patterns = EMOTION_KEYWORDS[emotionName.toLowerCase()];
    if (!patterns || patterns.length === 0) {
        return false;
    }

    return patterns.some(pattern => {
        const matcher = parseEmotionPattern(pattern);
        return matcher(text);
    });
}

// ============================================================================
// COLLECTION & CHUNK CONDITION EVALUATORS (11 types)
// ============================================================================
// These can be used at both collection-level and chunk-level.
// Collection-level: Determines if a collection should be queried
// Chunk-level: Determines if a specific chunk should be included in results
// ============================================================================

/**
 * Evaluates a pattern condition (advanced version of keyword)
 * Supports regex patterns, custom scan depth, and filtering by message role
 * @param {object} rule Condition rule
 * @param {object} context Search context
 * @returns {boolean} Whether condition is met
 */
function evaluatePatternCondition(rule, context) {
    const settings = rule.settings || {};

    // Support both 'patterns' (new) and 'values' (legacy)
    const patterns = settings.patterns || settings.values || [];
    const matchMode = settings.matchMode || 'any';
    const caseSensitive = settings.caseSensitive === true;
    const scanDepth = settings.scanDepth || 10;
    const searchIn = settings.searchIn || 'all'; // 'all', 'user', 'assistant'

    if (patterns.length === 0) {
        return false;
    }

    // Get messages to search based on scan depth and role filter
    let messagesToSearch = context.recentMessages || [];

    // Apply scan depth
    messagesToSearch = messagesToSearch.slice(0, scanDepth);

    // Filter by role if needed
    if (searchIn !== 'all' && context.messageRoles) {
        const roles = context.messageRoles.slice(0, scanDepth);
        messagesToSearch = messagesToSearch.filter((_, idx) => {
            const role = roles[idx];
            if (searchIn === 'user') return role === 'user';
            if (searchIn === 'assistant') return role === 'assistant' || role === 'char';
            return true;
        });
    }

    const searchText = messagesToSearch.join('\n');
    if (!searchText) {
        return false;
    }

    // Evaluate each pattern
    const results = patterns.map(pattern => {
        // Check if it's a regex pattern (wrapped in /.../)
        if (pattern.startsWith('/') && pattern.lastIndexOf('/') > 0) {
            try {
                const lastSlash = pattern.lastIndexOf('/');
                const regexPattern = pattern.slice(1, lastSlash);
                const flags = pattern.slice(lastSlash + 1) || (caseSensitive ? '' : 'i');
                const regex = new RegExp(regexPattern, flags);
                return regex.test(searchText);
            } catch (e) {
                console.warn(`VectHare: Invalid pattern regex: ${pattern}`, e);
                return false;
            }
        }

        // Plain text matching
        const textToSearch = caseSensitive ? searchText : searchText.toLowerCase();
        const patternToMatch = caseSensitive ? pattern : pattern.toLowerCase();
        return textToSearch.includes(patternToMatch);
    });

    // Apply match mode
    if (matchMode === 'all') {
        return results.every(r => r);
    }
    return results.some(r => r); // 'any' mode
}


/**
 * Evaluates a speaker condition
 * @param {object} rule Condition rule
 * @param {object} context Search context
 * @returns {boolean} Whether condition is met
 */
function evaluateSpeakerCondition(rule, context) {
    const settings = rule.settings || { values: [rule.value || ''], matchType: 'any' };
    const targetSpeakers = settings.values || [];
    const matchType = settings.matchType || 'any';

    if (matchType === 'all') {
        // All speakers must be in recent messages
        const speakers = context.messageSpeakers || [];
        return targetSpeakers.every(target => speakers.includes(target));
    } else {
        // Any speaker matches (default)
        return targetSpeakers.includes(context.lastSpeaker);
    }
}

/**
 * Evaluates a message count condition
 * @param {object} rule Condition rule
 * @param {object} context Search context
 * @returns {boolean} Whether condition is met
 */
function evaluateMessageCountCondition(rule, context) {
    const settings = rule.settings || { count: parseInt(rule.value) || 0, operator: 'gte' };
    const count = settings.count || 0;
    const operator = settings.operator || 'gte';
    const upperBound = settings.upperBound || 0;

    switch (operator) {
        case 'eq':
            return context.messageCount === count;
        case 'gte':
            return context.messageCount >= count;
        case 'lte':
            return context.messageCount <= count;
        case 'between':
            return context.messageCount >= count && context.messageCount <= upperBound;
        default:
            return context.messageCount >= count;
    }
}

// ============================================================================
// CHUNK-ONLY CONDITION EVALUATORS (4 types)
// ============================================================================
// These only make sense at chunk-level, not collection-level.
// They depend on information about other chunks in the current result set.
//
// Types:
// - links: Hard/soft links to other chunks
// - scoreThreshold: Per-chunk minimum similarity score override
// - recency: Message age filter
// - frequency: Activation limits/cooldown
// ============================================================================

/**
 * Processes chunk links and returns chunks that need to be included/boosted
 *
 * Link types:
 * - hard: Target chunk MUST be included if source chunk is in results
 * - soft: Target chunk gets a score boost if source chunk is in results
 *
 * Each chunk defines its own links independently. For two-way linking,
 * add links on both chunks. For one-way, only add on the source chunk.
 *
 * @param {object[]} chunks Array of chunks from search results
 * @param {object} chunkMetadataMap Map of hash -> chunk metadata (includes links)
 * @param {number} softBoost Score boost for soft links (default 0.15)
 * @returns {object} { chunks: processedChunks, hardLinkedHashes: Set }
 */
export function processChunkLinks(chunks, chunkMetadataMap, softBoost = 0.15) {
    const resultHashes = new Set(chunks.map(c => c.hash));
    const hardLinkedHashes = new Set();
    const softBoosts = new Map(); // hash -> total boost

    // First pass: collect all hard links and soft boosts
    for (const chunk of chunks) {
        const meta = chunkMetadataMap[chunk.hash];
        if (!meta?.links || meta.links.length === 0) continue;

        for (const link of meta.links) {
            const targetHash = parseInt(link.target);

            if (link.type === 'hard') {
                // Hard link: target MUST be included
                hardLinkedHashes.add(targetHash);
            } else if (link.type === 'soft') {
                // Soft link: accumulate boost for target
                const currentBoost = softBoosts.get(targetHash) || 0;
                softBoosts.set(targetHash, currentBoost + softBoost);
            }
        }
    }

    // Second pass: apply soft boosts to existing chunks
    const processedChunks = chunks.map(chunk => {
        const boost = softBoosts.get(chunk.hash) || 0;
        if (boost > 0) {
            return {
                ...chunk,
                score: Math.min(1.0, (chunk.score || 0) + boost),
                softLinked: true,
                linkBoost: boost
            };
        }
        return chunk;
    });

    // Hard-linked chunks that aren't in results need to be fetched separately
    // Return the hashes so caller can fetch them
    const missingHardLinks = [...hardLinkedHashes].filter(h => !resultHashes.has(h));

    return {
        chunks: processedChunks,
        hardLinkedHashes: hardLinkedHashes,
        missingHardLinks: missingHardLinks
    };
}

/**
 * Evaluates a score threshold condition (per-chunk override)
 * Allows individual chunks to require a higher/lower score than global threshold
 * @param {object} rule Condition rule
 * @param {object} context Search context (chunk must have .score)
 * @returns {boolean} Whether condition is met
 */
function evaluateScoreThresholdCondition(rule, context) {
    const settings = rule.settings || { threshold: parseFloat(rule.value) || 0.5 };
    const threshold = settings.threshold || 0.5;
    const chunkScore = context.currentChunkScore || 0;

    const passes = chunkScore >= threshold;

    if (!passes) {
        console.log(`VectHare: Chunk ${context.currentChunkHash} score ${chunkScore.toFixed(3)} below threshold ${threshold}`);
    }

    return passes;
}


/**
 * Evaluates a recency condition
 * Activates chunk based on how old the source message is
 * @param {object} rule Condition rule
 * @param {object} context Search context (chunk must have messageIndex or timestamp)
 * @returns {boolean} Whether condition is met
 */
function evaluateRecencyCondition(rule, context) {
    const settings = rule.settings || {
        messagesAgo: parseInt(rule.value) || 50,
        operator: 'gte' // 'gte' = older than X messages ago, 'lte' = newer than X
    };
    const targetAge = settings.messagesAgo || 50;
    const operator = settings.operator || 'gte';

    // Calculate how many messages ago this chunk's source is
    const chunkMessageIndex = context.currentChunkMessageIndex || 0;
    const currentMessageCount = context.messageCount || 0;
    const messagesAgo = currentMessageCount - chunkMessageIndex;

    switch (operator) {
        case 'eq':
            return messagesAgo === targetAge;
        case 'gte':
            // Chunk is at least X messages old
            return messagesAgo >= targetAge;
        case 'lte':
            // Chunk is at most X messages old (recent)
            return messagesAgo <= targetAge;
        case 'between':
            const upperBound = settings.upperBound || 100;
            return messagesAgo >= targetAge && messagesAgo <= upperBound;
        default:
            return messagesAgo >= targetAge;
    }
}

/**
 * Evaluates a frequency/cooldown condition
 * Limits how often a chunk can activate
 * @param {object} rule Condition rule
 * @param {object} context Search context (must include activationHistory)
 * @returns {boolean} Whether condition is met
 */
function evaluateFrequencyCondition(rule, context) {
    const settings = rule.settings || {
        maxActivations: parseInt(rule.value) || 1,
        cooldownMessages: 0,
        scope: 'conversation' // 'conversation' or 'session'
    };

    const maxActivations = settings.maxActivations || 1;
    const cooldownMessages = settings.cooldownMessages || 0;
    const scope = settings.scope || 'conversation';

    // Get activation history for this chunk
    const chunkHash = context.currentChunkHash;
    const history = context.activationHistory || {};
    const chunkHistory = history[chunkHash] || { count: 0, lastActivation: null };

    // Check max activations
    if (chunkHistory.count >= maxActivations) {
        console.log(`VectHare Conditions: Chunk ${chunkHash} reached max activations (${maxActivations})`);
        return false;
    }

    // Check cooldown
    if (cooldownMessages > 0 && chunkHistory.lastActivation !== null) {
        const messagesSinceLastActivation = context.messageCount - chunkHistory.lastActivation;
        if (messagesSinceLastActivation < cooldownMessages) {
            console.log(`VectHare Conditions: Chunk ${chunkHash} on cooldown (${messagesSinceLastActivation}/${cooldownMessages} messages)`);
            return false;
        }
    }

    return true;
}

/**
 * Evaluates a time of day condition
 * @param {object} rule Condition rule
 * @param {object} context Search context
 * @returns {boolean} Whether condition is met
 */
function evaluateTimeOfDayCondition(rule, context) {
    try {
        const settings = rule.settings || {};
        const startTime = settings.startTime || '00:00';
        const endTime = settings.endTime || '23:59';

        const now = new Date();
        const currentTime = now.getHours() * 60 + now.getMinutes();
        const [startH, startM] = startTime.split(':').map(n => parseInt(n));
        const [endH, endM] = endTime.split(':').map(n => parseInt(n));
        const start = startH * 60 + startM;
        const end = endH * 60 + endM;

        if (start <= end) {
            // Normal range (e.g., 09:00-17:00)
            return currentTime >= start && currentTime <= end;
        } else {
            // Midnight crossing (e.g., 22:00-02:00)
            return currentTime >= start || currentTime <= end;
        }
    } catch (error) {
        console.warn('VectHare Conditions: Invalid timeOfDay format');
        return false;
    }
}

/**
 * Evaluates an emotion condition
 * Uses hybrid detection: Character Expressions extension + Enhanced pattern matching
 *
 * Detection methods:
 * - 'auto': Try expressions first, fall back to patterns (RECOMMENDED)
 * - 'expressions': Only use Character Expressions extension
 * - 'patterns': Only use keyword/regex pattern matching
 * - 'both': Must match BOTH expressions AND patterns (strict mode)
 *
 * @param {object} rule Condition rule
 * @param {object} context Search context
 * @returns {boolean} Whether condition is met
 */
function evaluateEmotionCondition(rule, context) {
    const settings = rule.settings || { values: [], detectionMethod: 'auto' };
    const targetEmotions = settings.values || [];

    if (targetEmotions.length === 0) {
        console.warn('VectHare Conditions: No target emotions selected. Condition fails.');
        return false;
    }

    const detectionMethod = settings.detectionMethod || 'auto';
    let expressionsResult = null; // null = not checked, true/false = result
    let patternsResult = null;

    // =========================================================================
    // CHARACTER EXPRESSIONS EXTENSION CHECK
    // =========================================================================
    if (detectionMethod !== 'patterns' && expressionsExtension && context.currentCharacter) {
        try {
            const detectedEmotion = expressionsExtension.lastExpression?.[context.currentCharacter];
            if (detectedEmotion) {
                const matchedEmotion = detectedEmotion.toLowerCase();

                // Check if detected emotion matches any target emotions
                expressionsResult = targetEmotions.some(target =>
                    target.toLowerCase() === matchedEmotion
                );

                if (expressionsResult) {
                    console.log(`VectHare Conditions: Expressions match: "${detectedEmotion}" matches target [${targetEmotions.join(', ')}]`);
                } else {
                    console.log(`VectHare Conditions: Expressions detected "${detectedEmotion}" but not in targets [${targetEmotions.join(', ')}]`);
                }
            }
        } catch (error) {
            console.warn('VectHare Conditions: Failed to get expression:', error);
        }
    }

    // =========================================================================
    // PATTERN MATCHING (keywords + regex)
    // =========================================================================
    if (detectionMethod !== 'expressions') {
        const emotionText = context.recentMessages.join(' ');

        // Check each target emotion's patterns
        patternsResult = targetEmotions.some(targetEmotion => {
            const found = matchesEmotionPatterns(targetEmotion, emotionText);

            if (found) {
                console.log(`VectHare Conditions: Pattern match: "${targetEmotion}" found in recent messages`);
            }

            return found;
        });

        if (!patternsResult) {
            console.log(`VectHare Conditions: No pattern match for [${targetEmotions.join(', ')}]`);
        }
    }

    // =========================================================================
    // COMBINE RESULTS BASED ON DETECTION METHOD
    // =========================================================================
    let result = false;

    switch (detectionMethod) {
        case 'expressions':
            // Expressions only - fail if not available
            if (expressionsResult === null) {
                console.warn('VectHare Conditions: Expressions-only mode but extension not available');
                result = false;
            } else {
                result = expressionsResult;
            }
            break;

        case 'patterns':
            // Patterns only
            result = patternsResult === true;
            break;

        case 'both':
            // Both must match (strict mode)
            if (expressionsResult === null) {
                console.warn('VectHare Conditions: Both-mode requires expressions extension');
                result = false;
            } else {
                result = expressionsResult === true && patternsResult === true;
            }
            break;

        case 'auto':
        default:
            // Auto: expressions OR patterns (whichever succeeds)
            result = expressionsResult === true || patternsResult === true;
            break;
    }

    return result;
}

/**
 * Evaluates a character present condition
 * @param {object} rule Condition rule
 * @param {object} context Search context
 * @returns {boolean} Whether condition is met
 */
function evaluateCharacterPresentCondition(rule, context) {
    const settings = rule.settings || { values: [rule.value || ''], matchType: 'any', lookback: 10 };
    const targetCharacters = settings.values || [];
    const matchType = settings.matchType || 'any';
    const speakers = context.messageSpeakers || [];

    if (matchType === 'all') {
        // All characters must be present
        return targetCharacters.every(char =>
            speakers.some(speaker => (speaker || '').toLowerCase().includes(char.toLowerCase()))
        );
    } else {
        // Any character present (default)
        return targetCharacters.some(char =>
            speakers.some(speaker => (speaker || '').toLowerCase().includes(char.toLowerCase()))
        );
    }
}

/**
 * Evaluates a random chance condition
 * @param {object} rule Condition rule
 * @param {object} context Search context
 * @returns {boolean} Whether condition is met
 */
function evaluateRandomChanceCondition(rule, context) {
    const settings = rule.settings || { probability: parseInt(rule.value) || 50 };
    const chance = settings.probability || 50;
    const roll = Math.random() * 100;
    return roll <= chance;
}

/**
 * Evaluates a generation type condition
 * @param {object} rule Condition rule
 * @param {object} context Search context
 * @returns {boolean} Whether condition is met
 */
function evaluateGenerationTypeCondition(rule, context) {
    const settings = rule.settings || { values: [rule.value || 'normal'], matchType: 'any' };
    const targetGenTypes = settings.values || ['normal'];
    const matchType = settings.matchType || 'any';
    const currentGenType = (context.generationType || 'normal').toLowerCase();

    if (matchType === 'all') {
        // All types must match (doesn't make sense for single context, but kept for consistency)
        return targetGenTypes.every(type => type.toLowerCase() === currentGenType);
    } else {
        // Any type matches (default)
        return targetGenTypes.some(type => type.toLowerCase() === currentGenType);
    }
}

/**
 * Evaluates a swipe count condition
 * @param {object} rule Condition rule
 * @param {object} context Search context
 * @returns {boolean} Whether condition is met
 */
function evaluateSwipeCountCondition(rule, context) {
    const settings = rule.settings || { count: parseInt(rule.value) || 0, operator: 'gte' };
    const swipeCount = settings.count || 0;
    const operator = settings.operator || 'gte';
    const upperBound = settings.upperBound || 0;
    const currentSwipeCount = context.swipeCount || 0;

    switch (operator) {
        case 'eq':
            return currentSwipeCount === swipeCount;
        case 'gte':
            return currentSwipeCount >= swipeCount;
        case 'lte':
            return currentSwipeCount <= swipeCount;
        case 'between':
            return currentSwipeCount >= swipeCount && currentSwipeCount <= upperBound;
        default:
            return currentSwipeCount >= swipeCount;
    }
}

/**
 * Evaluates a lorebook active condition
 * @param {object} rule Condition rule
 * @param {object} context Search context
 * @returns {boolean} Whether condition is met
 */
function evaluateLorebookActiveCondition(rule, context) {
    const settings = rule.settings || { values: [rule.value || ''], matchType: 'any' };
    const targetEntries = settings.values || [];
    const matchType = settings.matchType || 'any';
    const activeEntries = context.activeLorebookEntries || [];

    if (matchType === 'all') {
        // All entries must be active
        return targetEntries.every(target => {
            const targetLower = target.toLowerCase();
            return activeEntries.some(entry => {
                const entryKey = (entry.key || '').toLowerCase();
                const entryUid = String(entry.uid || '').toLowerCase();
                return entryKey.includes(targetLower) || entryUid === targetLower;
            });
        });
    } else {
        // Any entry active (default)
        return targetEntries.some(target => {
            const targetLower = target.toLowerCase();
            return activeEntries.some(entry => {
                const entryKey = (entry.key || '').toLowerCase();
                const entryUid = String(entry.uid || '').toLowerCase();
                return entryKey.includes(targetLower) || entryUid === targetLower;
            });
        });
    }
}

/**
 * Evaluates an is group chat condition
 * @param {object} rule Condition rule
 * @param {object} context Search context
 * @returns {boolean} Whether condition is met
 */
function evaluateIsGroupChatCondition(rule, context) {
    const settings = rule.settings || { isGroup: rule.value === 'true' || rule.value === true };
    const expectGroupChat = settings.isGroup !== false;
    const isGroup = context.isGroupChat || false;
    return isGroup === expectGroupChat;
}

// ============================================================================
// MAIN EVALUATION FUNCTIONS
// ============================================================================

/**
 * Evaluates a single condition rule
 * @param {object} rule Condition rule
 * @param {object} context Search context
 * @returns {boolean} Whether condition is met
 */
export function evaluateConditionRule(rule, context) {
    let result = false;

    switch (rule.type) {
        // =================================================================
        // COLLECTION & CHUNK CONDITIONS (11 types)
        // =================================================================
        case 'pattern':
            result = evaluatePatternCondition(rule, context);
            break;

        case 'keyword': // Legacy - aliases to pattern
            result = evaluatePatternCondition(rule, context);
            break;

        case 'speaker':
            result = evaluateSpeakerCondition(rule, context);
            break;

        case 'messageCount':
            result = evaluateMessageCountCondition(rule, context);
            break;

        case 'timeOfDay':
            result = evaluateTimeOfDayCondition(rule, context);
            break;

        case 'emotion':
            result = evaluateEmotionCondition(rule, context);
            break;

        case 'characterPresent':
            result = evaluateCharacterPresentCondition(rule, context);
            break;

        case 'randomChance':
            result = evaluateRandomChanceCondition(rule, context);
            break;

        case 'generationType':
            result = evaluateGenerationTypeCondition(rule, context);
            break;

        case 'swipeCount':
            result = evaluateSwipeCountCondition(rule, context);
            break;

        case 'lorebookActive':
            result = evaluateLorebookActiveCondition(rule, context);
            break;

        case 'isGroupChat':
            result = evaluateIsGroupChatCondition(rule, context);
            break;

        // =================================================================
        // CHUNK-ONLY CONDITIONS (4 types)
        // Note: Links are processed separately via processChunkLinks()
        // =================================================================
        case 'scoreThreshold':
            result = evaluateScoreThresholdCondition(rule, context);
            break;

        case 'recency':
            result = evaluateRecencyCondition(rule, context);
            break;

        case 'frequency':
            result = evaluateFrequencyCondition(rule, context);
            break;


        default:
            console.warn(`VectHare Conditions: Unknown condition type: ${rule.type}`);
            result = false;
    }

    // Apply negation if specified
    return rule.negate ? !result : result;
}

/**
 * Evaluates all conditions for a chunk
 * @param {object} chunk Chunk with conditions
 * @param {object} context Search context
 * @returns {boolean} Whether all conditions are satisfied
 */
export function evaluateConditions(chunk, context) {
    // If no conditions or conditions disabled, always activate
    if (!chunk.conditions || !chunk.conditions.enabled) {
        return true;
    }

    const rules = chunk.conditions.rules || [];
    if (rules.length === 0) {
        return true; // Enabled but no rules = active
    }

    // Evaluate each rule
    const results = rules.map(rule => evaluateConditionRule(rule, context));

    // Apply AND/OR logic (use 'logic' field, fallback to 'mode' for compatibility)
    const logic = chunk.conditions.logic || chunk.conditions.mode || 'AND';
    if (logic === 'AND') {
        return results.every(r => r);
    } else {
        return results.some(r => r);
    }
}

/**
 * Filters chunks based on their conditions
 * Uses chunk-specific context for chunk-only conditions (similarity, recency, frequency)
 * @param {Array} chunks Array of chunks
 * @param {object} baseContext Base search context
 * @returns {Array} Chunks that meet their conditions
 */
export function filterChunksByConditions(chunks, baseContext) {
    const filtered = chunks.filter(chunk => {
        // Build chunk-specific context for chunk-only conditions
        const chunkContext = {
            ...baseContext,
            currentChunkScore: chunk.score || chunk.similarity || 0,
            currentChunkMessageIndex: chunk.metadata?.messageIndex || chunk.index || 0,
            currentChunkHash: chunk.hash,
            activeChunks: chunks // Pass all chunks for dependency checking
        };
        return evaluateConditions(chunk, chunkContext);
    });

    console.log(`VectHare Conditions: Filtered ${chunks.length} chunks to ${filtered.length} based on conditions`);

    return filtered;
}

/**
 * Builds search context from current chat state
 * @param {Array} chat Chat messages
 * @param {number} contextWindow How many recent messages to consider
 * @param {Array} activeChunks Chunks currently in results (for chunkActive conditions)
 * @param {object} metadata Additional metadata
 * @returns {object} Search context
 */
export function buildSearchContext(chat, contextWindow = 10, activeChunks = [], metadata = {}) {
    const recentMessages = chat.slice(-contextWindow).map(m => m.mes || '');
    const lastMessage = chat[chat.length - 1] || {};

    // Extract speakers from recent messages
    const messageSpeakers = chat.slice(-contextWindow).map(m => {
        if (m.name) return m.name;
        return m.is_user ? 'User' : 'Character';
    });

    // Count swipes on last message
    const swipeCount = (lastMessage.swipes && lastMessage.swipes.length > 0)
        ? lastMessage.swipes.length - 1
        : 0;

    return {
        recentMessages,
        lastSpeaker: lastMessage.name || (lastMessage.is_user ? 'User' : 'Character'),
        messageCount: chat.length,
        activeChunks,
        messageSpeakers,           // Array of speaker names for characterPresent
        timestamp: new Date(),     // Current timestamp for timeOfDay

        // Context for collection & general conditionals
        generationType: metadata.generationType || 'normal',         // Generation type (normal, swipe, regenerate, continue, impersonate)
        swipeCount: swipeCount,                                      // Number of swipes on last message
        activeLorebookEntries: metadata.activeLorebookEntries || [], // Active lorebook entries
        isGroupChat: metadata.isGroupChat || false,                  // Whether this is a group chat
        currentCharacter: metadata.currentCharacter || null,         // Current character name (for expressions extension)
        currentChatId: metadata.currentChatId || null,               // Current chat ID (for lock checks)
        currentChatCollectionId: metadata.currentChatCollectionId || null, // Current chat collection ID
        currentCharacterId: metadata.currentCharacterId || null,     // Current character ID (for character locks)

        // Context for chunk-only conditionals (set per-chunk during evaluation)
        currentChunkScore: metadata.currentChunkScore || 0,          // For similarity condition
        currentChunkMessageIndex: metadata.currentChunkMessageIndex || 0, // For recency condition
        currentChunkHash: metadata.currentChunkHash || null,         // For frequency condition
        activationHistory: metadata.activationHistory || {}          // Chunk activation history for frequency
    };
}

/**
 * Creates a chunk-specific context by extending base context
 * @param {object} baseContext Base search context
 * @param {object} chunk Chunk being evaluated
 * @returns {object} Context with chunk-specific fields
 */
export function buildChunkContext(baseContext, chunk) {
    return {
        ...baseContext,
        currentChunkScore: chunk.score || chunk.similarity || 0,
        currentChunkMessageIndex: chunk.metadata?.messageIndex || chunk.index || 0,
        currentChunkHash: chunk.hash
    };
}

/**
 * Gets chunks grouped by their condition status
 * @param {Array} chunks Array of chunks
 * @param {object} context Search context
 * @returns {object} Chunks grouped by status
 */
export function groupChunksByConditionStatus(chunks, context) {
    const groups = {
        noConditions: [],
        conditionsMet: [],
        conditionsNotMet: []
    };

    chunks.forEach(chunk => {
        if (!chunk.conditions || !chunk.conditions.enabled) {
            groups.noConditions.push(chunk);
        } else if (evaluateConditions(chunk, context)) {
            groups.conditionsMet.push(chunk);
        } else {
            groups.conditionsNotMet.push(chunk);
        }
    });

    return groups;
}

// ============================================================================
// VALIDATION FUNCTIONS
// ============================================================================

/**
 * Valid generation types
 */
export const VALID_GENERATION_TYPES = ['normal', 'swipe', 'regenerate', 'continue', 'impersonate'];

/**
 * Validates a condition rule
 * @param {object} rule Condition rule to validate
 * @returns {object} Validation result { valid: boolean, errors: string[] }
 */
export function validateConditionRule(rule) {
    const errors = [];

    if (!rule.type) {
        errors.push('Condition type is required');
    }

    // Value validation depends on whether settings are used
    const hasSettings = rule.settings && Object.keys(rule.settings).length > 0;
    if (!hasSettings && (!rule.value || String(rule.value).trim() === '')) {
        errors.push('Condition value is required');
    }

    switch (rule.type) {
        case 'messageCount':
            const mcCount = rule.settings?.count ?? parseInt(rule.value);
            if (isNaN(mcCount) || mcCount < 0) {
                errors.push('Message count must be a positive number');
            }
            break;

        case 'chunkActive':
            if (rule.settings?.matchBy === 'hash' || !rule.settings) {
                const hash = parseInt(rule.settings?.values?.[0] ?? rule.value);
                if (isNaN(hash)) {
                    errors.push('Chunk hash must be a number');
                }
            }
            break;

        case 'timeOfDay':
            const todSettings = rule.settings || {};
            if (todSettings.startTime || todSettings.endTime) {
                const timeRegex = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;
                if (todSettings.startTime && !timeRegex.test(todSettings.startTime)) {
                    errors.push('Invalid start time format. Use HH:MM (e.g., 09:00)');
                }
                if (todSettings.endTime && !timeRegex.test(todSettings.endTime)) {
                    errors.push('Invalid end time format. Use HH:MM (e.g., 17:00)');
                }
            } else if (rule.value) {
                // Legacy format: HH:MM-HH:MM
                const timeParts = rule.value.split('-');
                if (timeParts.length !== 2) {
                    errors.push('Time range must be in format HH:MM-HH:MM (e.g., 09:00-17:00)');
                } else {
                    const timeRegex = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;
                    if (!timeRegex.test(timeParts[0]) || !timeRegex.test(timeParts[1])) {
                        errors.push('Invalid time format. Use HH:MM (e.g., 09:00, 17:30)');
                    }
                }
            }
            break;

        case 'emotion':
            const emotionValues = rule.settings?.values || [rule.value];
            for (const emotion of emotionValues) {
                if (emotion && !VALID_EMOTIONS.includes(emotion.toLowerCase())) {
                    errors.push(`Unknown emotion: "${emotion}". Valid emotions: ${VALID_EMOTIONS.join(', ')}`);
                }
            }
            break;

        case 'randomChance':
            const chance = rule.settings?.probability ?? parseInt(rule.value);
            if (isNaN(chance) || chance < 0 || chance > 100) {
                errors.push('Random chance must be between 0 and 100');
            }
            break;

        case 'characterPresent':
            const cpValues = rule.settings?.values || [rule.value];
            if (cpValues.length === 0 || cpValues.every(v => !v || v.trim() === '')) {
                errors.push('Character name cannot be empty');
            }
            break;

        case 'generationType':
            const gtValues = rule.settings?.values || [rule.value];
            for (const genType of gtValues) {
                if (genType && !VALID_GENERATION_TYPES.includes(genType.toLowerCase())) {
                    errors.push(`Invalid generation type: "${genType}". Valid types: ${VALID_GENERATION_TYPES.join(', ')}`);
                }
            }
            break;

        case 'swipeCount':
            const scCount = rule.settings?.count ?? parseInt(rule.value);
            if (isNaN(scCount) || scCount < 0) {
                errors.push('Swipe count must be a positive number');
            }
            break;

        case 'lorebookActive':
            const lbValues = rule.settings?.values || [rule.value];
            if (lbValues.length === 0 || lbValues.every(v => !v || v.trim() === '')) {
                errors.push('Lorebook entry key or UID cannot be empty');
            }
            break;

        case 'isGroupChat':
            const gcValue = rule.settings?.isGroup ?? rule.value;
            if (gcValue !== 'true' && gcValue !== 'false' && gcValue !== true && gcValue !== false) {
                errors.push('isGroupChat value must be true or false');
            }
            break;

        // =================================================================
        // CHUNK-ONLY CONDITIONS VALIDATION
        // =================================================================
        case 'dependency':
            const depValues = rule.settings?.values || [rule.value];
            if (depValues.length === 0 || depValues.every(v => !v || String(v).trim() === '')) {
                errors.push('Dependency target (hash, section, or tag) cannot be empty');
            }
            break;

        case 'similarity':
            const simThreshold = rule.settings?.threshold ?? parseFloat(rule.value);
            if (isNaN(simThreshold) || simThreshold < 0 || simThreshold > 1) {
                errors.push('Similarity threshold must be between 0 and 1');
            }
            break;

        case 'recency':
            const recAge = rule.settings?.messagesAgo ?? parseInt(rule.value);
            if (isNaN(recAge) || recAge < 0) {
                errors.push('Recency (messages ago) must be a positive number');
            }
            break;

        case 'frequency':
            const freqMax = rule.settings?.maxActivations ?? parseInt(rule.value);
            if (isNaN(freqMax) || freqMax < 1) {
                errors.push('Max activations must be at least 1');
            }
            const freqCooldown = rule.settings?.cooldownMessages ?? 0;
            if (isNaN(freqCooldown) || freqCooldown < 0) {
                errors.push('Cooldown messages must be 0 or positive');
            }
            break;
    }

    return {
        valid: errors.length === 0,
        errors
    };
}

/**
 * Validates all conditions for a chunk
 * @param {object} conditions Chunk conditions object
 * @returns {object} Validation result { valid: boolean, errors: string[] }
 */
export function validateConditions(conditions) {
    const errors = [];

    if (!conditions) {
        return { valid: true, errors: [] };
    }

    if (conditions.enabled) {
        const rules = conditions.rules || [];

        if (rules.length === 0) {
            errors.push('At least one condition rule is required when conditions are enabled');
        }

        rules.forEach((rule, idx) => {
            const validation = validateConditionRule(rule);
            if (!validation.valid) {
                errors.push(`Rule ${idx + 1}: ${validation.errors.join(', ')}`);
            }
        });
    }

    return {
        valid: errors.length === 0,
        errors
    };
}

// ============================================================================
// STATISTICS FUNCTIONS
// ============================================================================

/**
 * Gets statistics about condition usage in a chunk collection
 * @param {Array} chunks Array of chunks
 * @returns {object} Statistics
 */
export function getConditionStats(chunks) {
    const stats = {
        total: chunks.length,
        withConditions: 0,
        conditionsEnabled: 0,
        byType: {},
        byMode: { AND: 0, OR: 0 }
    };

    chunks.forEach(chunk => {
        if (chunk.conditions && chunk.conditions.rules && chunk.conditions.rules.length > 0) {
            stats.withConditions++;

            if (chunk.conditions.enabled) {
                stats.conditionsEnabled++;

                const mode = chunk.conditions.logic || chunk.conditions.mode || 'AND';
                stats.byMode[mode] = (stats.byMode[mode] || 0) + 1;

                chunk.conditions.rules.forEach(rule => {
                    stats.byType[rule.type] = (stats.byType[rule.type] || 0) + 1;
                });
            }
        }
    });

    return stats;
}

// ============================================================================
// DEFAULT EXPORT
// ============================================================================

export default {
    // Core evaluation
    evaluateConditionRule,
    evaluateConditions,
    filterChunksByConditions,
    buildSearchContext,
    buildChunkContext,
    groupChunksByConditionStatus,

    // Validation
    validateConditionRule,
    validateConditions,

    // Statistics
    getConditionStats,

    // Emotion detection
    getExpressionsExtensionStatus,
    recheckExpressionsExtension,
    matchesEmotionPatterns,

    // Constants
    EMOTION_KEYWORDS,
    VALID_EMOTIONS,
    VALID_GENERATION_TYPES
};
