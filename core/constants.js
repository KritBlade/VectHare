/**
 * ============================================================================
 * VECTHARE CONSTANTS
 * ============================================================================
 * Centralized configuration values used across the extension.
 * Change these values here instead of hunting through the codebase.
 *
 * @author Coneja Chibi
 * @version 2.2.0-alpha
 * ============================================================================
 */

// =============================================================================
// EXTENSION IDENTITY
// =============================================================================

/** Extension prompt tag for SillyTavern's prompt system */
export const EXTENSION_PROMPT_TAG = '3_vecthare';

/** Extension name for logging and UI */
export const EXTENSION_NAME = 'VectHarePlus';

// =============================================================================
// PERFORMANCE & RATE LIMITING
// =============================================================================

/** LRU cache size for hash computations */
export const HASH_CACHE_SIZE = 10000;

/** Maximum items to fetch when listing vectors (for hash comparison) */
export const VECTOR_LIST_LIMIT = 10000;

/** Rate limiter: max calls per window */
export const RATE_LIMIT_CALLS = 50;

/** Rate limiter: window duration in ms (1 minute) */
export const RATE_LIMIT_WINDOW_MS = 60000;

/** API request timeout in ms (30 seconds) */
export const API_TIMEOUT_MS = 30000;

// =============================================================================
// RETRY CONFIGURATION
// =============================================================================

/** Maximum retry attempts for failed API calls */
export const RETRY_MAX_ATTEMPTS = 3;

/** Initial delay between retries in ms */
export const RETRY_INITIAL_DELAY_MS = 1000;

/** Maximum delay between retries in ms */
export const RETRY_MAX_DELAY_MS = 10000;

/** Backoff multiplier for exponential retry */
export const RETRY_BACKOFF_MULTIPLIER = 2;

// =============================================================================
// CHUNKING DEFAULTS
// =============================================================================

/** Default chunk size in characters */
export const DEFAULT_CHUNK_SIZE = 500;

/** Default overlap between chunks in characters */
export const DEFAULT_CHUNK_OVERLAP = 50;

/** Characters to search back when finding sentence boundaries */
export const SENTENCE_SEARCH_WINDOW = 50;

// =============================================================================
// TEMPORAL WEIGHTING DEFAULTS
// =============================================================================

/** Default half-life for temporal effects (messages until 50% effect) */
export const DEFAULT_DECAY_HALF_LIFE = 50;

/** Default floor for temporal decay (minimum score multiplier) */
export const DEFAULT_DECAY_FLOOR = 0.3;

/** Default decay strength/rate */
export const DEFAULT_DECAY_STRENGTH = 0.5;

/** Default max boost for nostalgia mode (1.2 = 20% boost for old chunks) */
export const DEFAULT_NOSTALGIA_MAX_BOOST = 1.2;

// =============================================================================
// CONDITIONAL ACTIVATION DEFAULTS
// =============================================================================

/** Default recency threshold for activation rules (messages ago) */
export const DEFAULT_RECENCY_THRESHOLD = 50;

// =============================================================================
// UI DEFAULTS
// =============================================================================

/** Default score threshold for vector search results */
export const DEFAULT_SCORE_THRESHOLD = 0.25;

/** Default number of chunks to insert into prompt */
export const DEFAULT_INSERT_COUNT = 5;

/** Default number of recent messages to use for query */
export const DEFAULT_QUERY_COUNT = 5;

/** Default number of messages to protect from vectorization */
export const DEFAULT_PROTECT_COUNT = 5;
