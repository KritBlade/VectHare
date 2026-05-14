/**
 * ============================================================================
 * VECTFOX - ADVANCED RAG SYSTEM
 * ============================================================================
 * Entry point - lean and clean
 * All logic is in separate modules - see project guidelines
 *
 * @author Kritblade
 * @version 3.3.0
 * ============================================================================
 */

import {
    eventSource,
    event_types,
    extension_prompt_types,
} from '../../../../script.js';
import {
    ModuleWorkerWrapper,
    extension_settings,
} from '../../../extensions.js';
import { debounce } from '../../../utils.js';
import { debounce_timeout } from '../../../constants.js';

// VectFox modules - Core
import { synchronizeChat, rearrangeChat, vectorizeAll } from './core/chat-vectorization.js';
import { purgeAllVectorIndexes, purgeVectorIndex } from './core/core-vector-api.js';
import { getChatCollectionId } from './core/chat-vectorization.js';
import { getDefaultDecaySettings } from './core/temporal-decay.js';
import { migrateOldEnabledKeys } from './core/collection-metadata.js';
import { clearCollectionRegistry, discoverExistingCollections, cleanupCorruptedCollections } from './core/collection-loader.js';
import AsyncUtils from './utils/async-utils.js';

// VectFox modules - UI
import { renderSettings, openDiagnosticsModal, loadWebLlmModels, updateWebLlmStatus, refreshAutoSyncCheckbox } from './ui/ui-manager.js';
import { progressTracker } from './ui/progress-tracker.js';
import { initializeVisualizer } from './ui/chunk-visualizer.js';
import { initializeDatabaseBrowser } from './ui/database-browser.js';
import { initializeWorldInfoIntegration } from './core/world-info-integration.js';
import { CJK_TOKENIZER_MODES, setCjkTokenizerMode, ensureJiebaTokenizerLoaded, ensureJiebaTwLoaded } from './core/bm25-scorer.js';

// VectFox modules - Cotton-Tales Integration
import './core/emotion-classifier.js'; // Exposes window.VectFoxEmotionClassifier

// Constants
const MODULE_NAME = 'VectFox';

// Default settings
const defaultSettings = {
    // Core vector settings
    source: 'transformers',
    vector_backend: 'qdrant', // Backend: 'standard' (ST Vectra) | 'qdrant'
    qdrant_host: 'localhost',
    qdrant_port: 6333,
    qdrant_url: '',
    qdrant_api_key: '',
    qdrant_use_cloud: false,
    qdrant_multitenancy: false, // Use single collection with content_type field instead of separate collections
    ollama_alt_endpoint_url: '',
    ollama_use_alt_endpoint: false,
    ollama_api_key: '',
    vllm_alt_endpoint_url: '',
    vllm_use_alt_endpoint: false,
    rate_limit_calls: 5,
    rate_limit_interval: 60, // seconds

    // VEC-6: Batch insert optimization
    insert_batch_size: 50, // Chunks per insert batch (50-100 recommended)
    togetherai_model: 'togethercomputer/m2-bert-80M-32k-retrieval',
    openai_model: 'text-embedding-ada-002',
    electronhub_model: 'text-embedding-3-small',
    openrouter_model: 'openai/text-embedding-3-large',
    openrouter_api_key: '', // Stored here so the Choose button can send auth; also written to ST secrets for actual embedding calls
    cohere_model: 'embed-english-v3.0',
    ollama_model: 'mxbai-embed-large',
    ollama_keep: false,
    vllm_model: '',
    vllm_api_key: '', // Stored here since custom keys aren't returned by ST's readSecretState()
    webllm_model: '',
    google_model: 'text-embedding-005',
    bananabread_rerank: false,
    bananabread_api_key: '', // Stored here since custom keys aren't returned by ST's readSecretState()

    // Chat vectorization
    enabled_chats: true,
    chunking_strategy: 'per_message', // per_message, conversation_turns, message_batch, adaptive
    batch_size: 4, // Messages per batch for message_batch strategy
    depth: 2,
    position: extension_prompt_types.IN_PROMPT,
    protect: 5,
    insert: 5,
    min_chat_length: 0, // Minimum number of messages in chat before injection starts (0 = no minimum)
    // Number of top results to retrieve from vector DB (top-K)
    top_k: 10,
    retrieval_popup_on_start: true,    // Show popup when retrieval starts
    retrieval_popup_on_result: true,   // Show popup with number of retrieved results
    query: 2,
    chunk_size: 500, // For adaptive strategy only
    score_threshold: 0.25,

    // Deduplication settings
    // Recent-context skip: drop candidate events whose source_window_end falls within
    // the last N messages of the chat — assumption is that the LLM already sees those
    // messages in raw form. In practice this assumption breaks because actual visible
    // chat context is typically ~3-6 messages (depends on context budget / system prompt /
    // other extensions). Default 0 = filter disabled, never skip. Power users can opt in
    // to a small value (e.g. 3-10) if their setup has predictable raw-context visibility.
    deduplication_depth: 0,

    // Keyword scoring method for retrieval (standard backend only; ignored when native hybrid active)
    keyword_scoring_method: 'bm25', // 'bm25' (fast re-rank of ANN top-K) | 'hybrid' (candidate-limited hybrid fusion over expanded vector results)

    // BM25 parameters
    bm25_k1: 1.5,  // Term frequency saturation (1.2-2.0 typical)
    bm25_b: 0.75,  // Length normalization (0-1, 0.75 typical)

    // Query keyword budget for retrieval (A1 and A2 paths)
    hybrid_keyword_level: 'balance', // 'minimal' (30) | 'balance' (50) | 'maximum' (70)

    // Keyword extraction level for INGESTION (chat history vectorization) — not retrieval
    keyword_extraction_level: 'balanced', // 'off', 'minimal', 'balanced', 'aggressive'

    // Summarization before vectorization
    summarize_provider: 'openrouter', // 'openrouter', 'vllm'
    summarize_openrouter_api_key: '',  // OpenRouter API key for summarization (stored here, not ST secrets)
    summarize_model: '',              // Model ID for summarization (e.g. 'google/gemini-flash-1.5-8b')
    summarize_vllm_url: '',           // vLLM base URL for summarization (e.g. 'http://localhost:8000')
    summarize_vllm_api_key: '',       // vLLM API key (stored in extension settings, not ST secrets)
    summarize_prompt: '',             // Custom prompt template (empty = use built-in default)

    // Hybrid Search fusion settings.
    // A1 (BM25 re-rank, Vectra) reads hybrid_fusion_method/weights when invoked via A2 client-side hybrid.
    // A3 (Qdrant native sparse + RRF) ignores them — fusion is server-side via Qdrant /points/query.
    hybrid_fusion_method: 'rrf',        // 'rrf' (Reciprocal Rank Fusion) or 'weighted' — A2 only
    hybrid_vector_weight: 0.5,          // Weight for vector scores (0-1) — A2 weighted mode only
    hybrid_text_weight: 0.5,            // Weight for text/BM25 scores (0-1) — A2 weighted mode only
    hybrid_rrf_k: 60,                   // RRF constant — A2 only (Qdrant uses its own default)
    hybrid_native_prefer: true,         // KEPT (no UI): A3 vs A2 selector for backends that support both. Default = prefer native.

    // Advanced features
    temporal_decay: getDefaultDecaySettings(),

    // Global defaults for new collections
    default_decay_enabled: false,    // Whether new collections have temporal weighting enabled
    default_decay_type: 'decay',     // 'decay' or 'nostalgia' for new collections

    // RAG Prompt Context (Global level)
    // Wraps ALL injected content with context prompts and/or XML tags
    rag_context: '',      // Natural language context shown before all RAG content
    rag_xml_tag: 'VectFoxMemory',      // XML tag to wrap all RAG content (e.g., "retrieved_context")

    // Collection-level metadata (managed by collection-metadata.js)
    collections: {},

    // Collection registry (list of known collection IDs)
    vectfox_collection_registry: [],

    // World Info Integration
    enabled_world_info: false,          // Enable semantic WI activation
    world_info_threshold: 0.3,          // Score threshold for WI activation
    world_info_top_k: 3,                // Max entries to activate per lorebook
    world_info_query_depth: 3,          // Recent messages to use for query

    // Keyword Extraction
    custom_stopwords: '',               // Custom stopwords (comma-separated)
    cjk_tokenizer_mode: CJK_TOKENIZER_MODES.intl, // intl | jieba | jieba_tw | tiny_segmenter

    // EventBase workflow
    eventbase_provider: 'openrouter',             // 'openrouter' | 'vllm'
    eventbase_model: '',                          // Model ID (e.g. 'google/gemini-flash-1.5-8b')
    eventbase_openrouter_api_key: '',             // API key (falls back to summarize key then ST secrets)
    eventbase_vllm_url: '',                       // vLLM base URL
    eventbase_vllm_api_key: '',                   // vLLM API key
    eventbase_temperature: 0.2,
    eventbase_max_tokens: 2048,
    eventbase_timeout_ms: 60000,
    eventbase_window_size: 2,                     // Chat messages per extraction window
    eventbase_window_overlap: 0,                  // Window overlap to avoid edge cuts
    eventbase_min_importance_store: 3,            // Drop events below this importance before storing
    eventbase_max_events_per_window: 3,           // Hard cap on events returned per LLM call
    eventbase_retrieval_top_k: 10,                // Events to retrieve per generation
    eventbase_retrieval_min_importance: 1,        // Minimum importance for retrieval
    eventbase_injection_format: 'densetext',      // Injection format: 'densetext' or 'jsonarray'
    eventbase_retrieval_filters_enabled: true,
    eventbase_autosync_popup: true,               // Show popup toast when auto-sync extraction runs
    eventbase_debug_logging: false,
    eventbase_debug_qdrant_backend: false,
    debug_vectorizing_log: false,                // Verbose vectorization progress logs in console
    eventbase_custom_prompt: '',                  // Custom extraction prompt (empty = use built-in default)
    // Re-rank weights (sum is normalized to 1.0 at runtime)
    eventbase_rerank_w_cosine: 0.55,
    eventbase_rerank_w_importance: 0.20,
    eventbase_rerank_w_persist: 0.15,
    eventbase_rerank_w_recency: 0.10,

    // Anchor boost: flat additive bonus when an event's keyword appears verbatim
    // in the user's last message. Rescues historically-distant events the user
    // explicitly asks about. Slider 0.00-0.50, default 0.20 (selected from
    // 4-run grid benchmarking — see plans/agentic-retrieval-plan.md notes).
    // 0 = disabled.
    eventbase_anchor_boost: 0.20,
    // Dedup temporal proximity: events N or more messages apart are treated as
    // distinct (kept). Slider 0-200, default 10. 0 = dedup fully disabled;
    // 10 catches same-window duplicates plus near-adjacent extraction artifacts
    // (windows 0-9 apart) while keeping genuinely distinct scenes 10+ msgs away.
    eventbase_dedup_window_gap: 10,

    // Native rerank: push importance filter + dedup-depth filter + weighted-sum
    // scoring into Qdrant via a formula query, in the same /query call as the
    // dense+sparse RRF hybrid. A3 (Qdrant) only — Standard backend ignores this.
    // Default off until eval window passes. Requires Qdrant 1.13+; falls back
    // gracefully to the JS re-rank pipeline when the route returns an error.
    // See plans/qdrant-native-eventbase-rerank-formula.md.
    eventbase_native_rerank: true,
    // Compare mode: when native rerank is on, also run the JS pipeline in
    // parallel and log per-(collection,queryText) rank correlation + overlap.
    // Doubles per-collection cost when on — debug only. Requires
    // eventbase_debug_logging to surface logs.
    eventbase_compare_rerank: false,
    // Verbose compare-mode logging: also print per-event score breakdowns for
    // events present in both top-K lists.
    eventbase_compare_rerank_verbose: false,

    // ─── AgentMode (Agentic Retrieval) ──────────────────────────────────
    // Optional LLM planner step that consumes pre-search candidates plus
    // recent chat context and emits 1-4 follow-up queries which fan out in
    // parallel against Qdrant. Purely additive — never replaces the existing
    // flow. A3 (Qdrant) only. See plans/agentic-retrieval-plan.md.
    agentic_retrieval_enabled: false,                  // Master toggle (default OFF)
    agentic_retrieval_provider: '',                    // '' → inherit summarize_provider
    agentic_retrieval_model: '',                       // '' → inherit summarize_model
    agentic_retrieval_openrouter_api_key: '',          // '' → inherit summarize_openrouter_api_key
    agentic_retrieval_vllm_url: '',                    // '' → inherit summarize_vllm_url
    agentic_retrieval_vllm_api_key: '',                // '' → inherit summarize_vllm_api_key
    agentic_retrieval_chat_depth: 3,                   // # of past chat turns sent to planner (slider 1-10)
    agentic_retrieval_candidates_to_show: 12,          // Pre-search slice shown to planner (slider 5-20)
    agentic_retrieval_max_queries: 4,                  // Hard ceiling on planner output (slider 1-4)
    agentic_retrieval_timeout_ms: 30000,               // Planner LLM call timeout (matches summarize default; some models need >5s)
    agentic_retrieval_debug_logging: false,            // Separate debug toggle from eventbase_debug_logging
    agentic_filters_enabled: true,                     // Apply planner-emitted *_any / importance_gte filters (Phase 1.5)

    // ─── Hidden / Power-User ────────────────────────────────────────────
    // SUPERADMIN MODE — no GUI toggle. Set to true by hand-editing settings.json
    // (the `vectfox` block under SillyTavern's extension_settings) to enable.
    // When true, the Database Browser bypasses ALL persona / handle ID filtering
    // and shows EVERY collection on the server regardless of creatorHandle. Locking
    // a foreign collection then works normally. Intended for dev / debugging /
    // multi-persona admin scenarios. Do not expose in the UI — this is a tripwire,
    // not a feature.
    superadmin: false,
};

// Runtime settings (merged with saved settings)
let settings = { ...defaultSettings };

// Module worker for automatic syncing
const moduleWorker = new ModuleWorkerWrapper(() => synchronizeChat(settings, getBatchSize()));

// Batch size based on provider
const getBatchSize = () => ['transformers', 'ollama'].includes(settings.source) ? 1 : 5;

// Chat event handler (debounced)
const onChatEvent = debounce(async () => await moduleWorker.update(), debounce_timeout.relaxed);

/**
 * Generation interceptor - searches and injects relevant messages
 */
async function vectfox_rearrangeChat(chat, _contextSize, _abort, type) {
    await rearrangeChat(chat, settings, type);
}

// Export to window for ST to call
window['vectfox_rearrangeChat'] = vectfox_rearrangeChat;

/**
 * Action: Vectorize all messages in current chat
 */
async function onVectorizeAllClick() {
    const controller = new AbortController();
    progressTracker.setCancelHandler(() => controller.abort('user-stop'));
    try {
        await vectorizeAll(settings, getBatchSize(), controller.signal);
    } finally {
        progressTracker.clearCancelHandler();
    }
}

/**
 * Action: Full purge - wipes ALL vector data and settings
 */
async function onPurgeClick() {
    const confirmed = confirm(
        'WARNING: This will delete ALL vector data and reset VectFox settings.\n\n' +
        'This cannot be undone. Continue?'
    );

    if (!confirmed) {
        toastr.info('Purge cancelled');
        return;
    }

    try {
        const { getRequestHeaders } = await import('../../../../script.js');

        // 1. Delete entire vectors folder
        await fetch('/api/plugins/similharity/purge-all', {
            method: 'POST',
            headers: getRequestHeaders(),
        });

        // 2. Clear extension_settings.vectfox
        for (const key in extension_settings.vectfox) {
            if (key !== 'enabled') {
                delete extension_settings.vectfox[key];
            }
        }

        // 3. Save settings
        const { saveSettingsDebounced } = await import('../../../../script.js');
        saveSettingsDebounced();

        toastr.success('All vector data purged', 'Purge Complete');

    } catch (error) {
        console.error('VectFox: Purge failed:', error);
        toastr.error('Purge failed: ' + error.message);
    }
}

/**
 * Action: Cleanup corrupted/ST-native collections from disk
 */
async function onCleanupCorruptedClick() {
    const confirmed = confirm(
        'This deletes corrupted prefix-stacked collections and ST-native file_* attachments\n' +
        'from disk. Useful when reply latency is dominated by ghost collections.\n\n' +
        'Cannot be undone. Continue?'
    );
    if (!confirmed) {
        toastr.info('Cleanup cancelled');
        return;
    }

    try {
        const result = await cleanupCorruptedCollections();
        if (result.total === 0) {
            toastr.info('No corrupted or ST-native file collections found');
            return;
        }

        const { saveSettingsDebounced } = await import('../../../../script.js');
        saveSettingsDebounced();

        const failed = result.purged.filter(p => !p.ok).length;
        const succeeded = result.purged.length - failed;
        const summary = `Purged ${succeeded}/${result.total} (${result.corruption} corrupted, ${result.stFile} ST-native file). ${failed > 0 ? failed + ' failed.' : ''}`;
        if (failed === 0) {
            toastr.success(summary, 'Cleanup Complete');
        } else {
            toastr.warning(summary, 'Cleanup Partial');
        }
    } catch (error) {
        console.error('VectFox: Cleanup failed:', error);
        toastr.error('Cleanup failed: ' + error.message);
    }
}

/**
 * Action: Run diagnostics - opens the diagnostics modal
 */
function onRunDiagnosticsClick() {
    openDiagnosticsModal();
}

/**
 * Initialize VectFox extension
 */
jQuery(async () => {
    console.log('VectFox: Initializing...');

    // Load saved settings
    if (!extension_settings.vectfox) {
        extension_settings.vectfox = defaultSettings;
    }

    // Merge saved settings with defaults
    settings = {
        ...defaultSettings,
        ...extension_settings.vectfox,
        temporal_decay: {
            ...defaultSettings.temporal_decay,
            ...extension_settings.vectfox.temporal_decay
        },
        collections: {
            ...defaultSettings.collections,
            ...extension_settings.vectfox.collections
        }
    };

    // Migrate old scattered enabled keys to new collections structure
    const migrationResult = migrateOldEnabledKeys();
    if (migrationResult.migrated > 0) {
        console.log(`VectFox: Migrated ${migrationResult.migrated} old collection enabled keys`);
    }

    // Migrate legacy EventBase LLM overrides → unified Core summarize settings
    const _ebs = extension_settings.vectfox;
    if (!_ebs.summarize_model && _ebs.eventbase_model) _ebs.summarize_model = _ebs.eventbase_model;
    if (!_ebs.summarize_provider && _ebs.eventbase_provider) _ebs.summarize_provider = _ebs.eventbase_provider;
    if (!_ebs.summarize_openrouter_api_key && _ebs.eventbase_openrouter_api_key) {
        _ebs.summarize_openrouter_api_key = _ebs.eventbase_openrouter_api_key;
    }
    if (!_ebs.summarize_vllm_url && _ebs.eventbase_vllm_url) _ebs.summarize_vllm_url = _ebs.eventbase_vllm_url;
    if (!_ebs.summarize_vllm_api_key && _ebs.eventbase_vllm_api_key) _ebs.summarize_vllm_api_key = _ebs.eventbase_vllm_api_key;

    // Migrate empty rag_xml_tag to default value
    if (!settings.rag_xml_tag) {
        settings.rag_xml_tag = 'VectFoxMemory';
        extension_settings.vectfox.rag_xml_tag = 'VectFoxMemory';
    }

    // Initialize CJK tokenizer mode before any extraction happens.
    setCjkTokenizerMode(settings.cjk_tokenizer_mode || CJK_TOKENIZER_MODES.intl);
    if (settings.cjk_tokenizer_mode === CJK_TOKENIZER_MODES.jieba) {
        ensureJiebaTokenizerLoaded().then((ok) => {
            if (ok) {
                console.log('VectFox CJK: Jieba tokenizer initialized');
            } else {
                console.warn('VectFox CJK: Jieba tokenizer unavailable, using Intl.Segmenter fallback');
            }
        });
    }
    if (settings.cjk_tokenizer_mode === CJK_TOKENIZER_MODES.jieba_tw) {
        ensureJiebaTwLoaded().then((ok) => {
            if (ok) {
                console.log('VectFox CJK: Jieba TW tokenizer initialized');
            } else {
                console.warn('VectFox CJK: Jieba TW tokenizer unavailable, using Intl.Segmenter fallback');
            }
        });
    }

    // Render UI
    renderSettings('extensions_settings2', settings, {
        onVectorizeAll: onVectorizeAllClick,
        onPurge: onPurgeClick,
        onCleanupCorrupted: onCleanupCorruptedClick,
        onRunDiagnostics: onRunDiagnosticsClick,
    });

    // Initialize auto-sync checkbox state for current chat (if any)
    refreshAutoSyncCheckbox(settings);

    // Initialize visualizer
    initializeVisualizer();

    // Initialize database browser
    initializeDatabaseBrowser(settings);

    // Initialize world info integration hooks
    initializeWorldInfoIntegration();

    // VEC-34: Discover existing collections with retry mechanism
    // Uses exponential backoff to handle temporary backend unavailability
    (async () => {
        try {
            const collections = await AsyncUtils.retry(
                () => discoverExistingCollections(settings),
                {
                    maxAttempts: 3,
                    delay: 2000,
                    maxDelay: 10000,
                    backoffFactor: 2,
                    onRetry: (attempt, error) => {
                        console.warn(`VectFox: Collection discovery attempt ${attempt} failed: ${error.message}. Retrying...`);
                    }
                }
            );
            if (collections.length > 0) {
                console.log(`VectFox: Discovered ${collections.length} existing collections`);
            }
        } catch (err) {
            console.error('VectFox: Collection discovery failed after retries:', err.message);
            toastr.warning(
                'Could not discover existing collections. Open Database Browser to refresh manually.',
                'VectFox: Collection Discovery Failed',
                { timeOut: 10000 }
            );
        }
    })();

    // Phase 1.5: backfill EventBase payload indexes on pre-existing Qdrant collections.
    if (settings.vector_backend === 'qdrant') {
        import('./core/eventbase-store.js').then(({ ensureEventBaseIndexes }) => {
            ensureEventBaseIndexes(settings).catch(err => {
                console.warn('[VectFox] EventBase index backfill failed:', err);
            });
        }).catch(() => {});
    }

    // D5: Cross-repo version check — warn loud if similharity is behind.
    const SIMILHARITY_EXPECTED_VERSION = '3.3.1';
    (async () => {
        try {
            const resp = await fetch('/api/plugins/similharity/version');
            if (resp.ok) {
                const { pluginVersion } = await resp.json();
                if (pluginVersion !== SIMILHARITY_EXPECTED_VERSION) {
                    console.warn(`[VectFox] VERSION MISMATCH: expected similharity v${SIMILHARITY_EXPECTED_VERSION}, got v${pluginVersion}. Pull matching versions.`);
                    toastr.warning(
                        `similharity version mismatch (expected ${SIMILHARITY_EXPECTED_VERSION}, got ${pluginVersion}) — see console`,
                        'VectFox',
                        { timeOut: 10000 }
                    );
                }
            }
        } catch (_err) {
            // similharity not installed — separate problem, not our warning to raise
        }
    })();

    // Register event handlers
    eventSource.on(event_types.MESSAGE_DELETED, onChatEvent);
    eventSource.on(event_types.MESSAGE_EDITED, onChatEvent);
    // Run vector sync tasks on message events
    // Note: Semantic WI injection happens in the generate_interceptor (rearrangeChat), not here
    eventSource.on(event_types.MESSAGE_SENT, onChatEvent);
    eventSource.on(event_types.MESSAGE_RECEIVED, onChatEvent);
    eventSource.on(event_types.MESSAGE_SWIPED, onChatEvent);
    // DEAD-CHUNK-CHAT — disabled for good.
    // These handlers used to purge `vf_chat_*` collections on chat deletion.
    // Chat history now lives in `vf_eventbase_*` collections, which use a
    // UUID-based ID that survives the chat-file deletion (and the chat UUID isn't
    // recoverable once the chat is gone). EventBase collections need to be cleaned
    // up via the Database Browser, not auto-purged on chat delete.
    //
    // TODO: implement EventBase-aware chat-delete cleanup if/when we want it back.
    // The hard part is mapping the deleted chatId → chatUUID → eventbase collection
    // ID, since chat_metadata.integrity is gone after deletion.
    /* DEAD-CHUNK-CHAT — original handlers:
    eventSource.on(event_types.CHAT_DELETED, async (chatId) => {
        if (chatId) {
            const collectionId = getChatCollectionId(chatId);
            if (collectionId) {
                await purgeVectorIndex(collectionId, settings);
                console.log(`VectFox: Purged vectors for deleted chat: ${chatId}`);
            }
        }
    });
    eventSource.on(event_types.GROUP_CHAT_DELETED, async (chatId) => {
        if (chatId) {
            const collectionId = getChatCollectionId(chatId);
            if (collectionId) {
                await purgeVectorIndex(collectionId, settings);
                console.log(`VectFox: Purged vectors for deleted group chat: ${chatId}`);
            }
        }
    });
    */

    // When WebLLM extension is loaded, refresh the model list
    eventSource.on(event_types.EXTENSION_SETTINGS_LOADED, async (manifest) => {
        if (settings.source === 'webllm' && manifest?.display_name === 'WebLLM') {
            console.log('VectFox: WebLLM extension loaded, refreshing models...');
            updateWebLlmStatus();
            await loadWebLlmModels(settings);
        }
    });

    // When chat changes, refresh UI state to match settings
    eventSource.on(event_types.CHAT_CHANGED, () => {
        console.log('VectFox: Chat changed, refreshing UI state');
        refreshAutoSyncCheckbox(settings);
    });

    console.log('VectFox: ✅ Initialized successfully');
});

/**
 * Lifecycle hook: called by SillyTavern after a successful extension update.
 * Forces a full page reload so the browser fetches the new JS/CSS files
 * instead of serving stale cached versions.
 */
export async function onUpdate() {
    console.log('VectFox: Update detected — reloading page to clear module cache');
    location.reload();
}
