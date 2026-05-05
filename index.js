/**
 * ============================================================================
 * VECTHARE - ADVANCED RAG SYSTEM
 * ============================================================================
 * Entry point - lean and clean
 * All logic is in separate modules - see project guidelines
 *
 * @author Coneja Chibi
 * @version 2.2.0-alpha
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

// VectHare modules - Core
import { synchronizeChat, rearrangeChat, vectorizeAll } from './core/chat-vectorization.js';
import { purgeAllVectorIndexes, purgeVectorIndex } from './core/core-vector-api.js';
import { getChatCollectionId } from './core/chat-vectorization.js';
import { getDefaultDecaySettings } from './core/temporal-decay.js';
import { migrateOldEnabledKeys } from './core/collection-metadata.js';
import { clearCollectionRegistry, discoverExistingCollections } from './core/collection-loader.js';
import AsyncUtils from './utils/async-utils.js';

// VectHare modules - UI
import { renderSettings, openDiagnosticsModal, loadWebLlmModels, updateWebLlmStatus, refreshAutoSyncCheckbox } from './ui/ui-manager.js';
import { progressTracker } from './ui/progress-tracker.js';
import { initializeVisualizer } from './ui/chunk-visualizer.js';
import { initializeDatabaseBrowser } from './ui/database-browser.js';
import { initializeSceneMarkers, updateAllMarkerStates, setSceneSettings } from './ui/scene-markers.js';
import { initializeWorldInfoIntegration } from './core/world-info-integration.js';
import { CJK_TOKENIZER_MODES, setCjkTokenizerMode, ensureJiebaTokenizerLoaded, ensureJiebaTwLoaded } from './core/bm25-scorer.js';

// VectHare modules - Cotton-Tales Integration
import './core/emotion-classifier.js'; // Exposes window.VectHareEmotionClassifier

// Constants
const MODULE_NAME = 'VectHarePlus';

// Default settings
const defaultSettings = {
    // Core vector settings
    source: 'transformers',
    vector_backend: 'qdrant', // Backend: 'standard' (ST Vectra), 'lancedb', 'qdrant'
    qdrant_host: 'localhost',
    qdrant_port: 6333,
    qdrant_url: '',
    qdrant_api_key: '',
    qdrant_use_cloud: false,
    qdrant_multitenancy: false, // Use single collection with content_type field instead of separate collections
    milvus_host: 'localhost',
    milvus_port: 19530,
    milvus_username: '',
    milvus_password: '',
    milvus_token: '',
    milvus_address: '',
    alt_endpoint_url: '',
    use_alt_endpoint: false,
    rate_limit_calls: 5,
    rate_limit_interval: 60, // seconds

    // VEC-6: Batch insert optimization
    insert_batch_size: 50, // Chunks per insert batch (50-100 recommended)
    togetherai_model: 'togethercomputer/m2-bert-80M-32k-retrieval',
    openai_model: 'text-embedding-ada-002',
    electronhub_model: 'text-embedding-3-small',
    openrouter_model: 'openai/text-embedding-3-large',
    cohere_model: 'embed-english-v3.0',
    ollama_model: 'mxbai-embed-large',
    ollama_keep: false,
    vllm_model: '',
    webllm_model: '',
    google_model: 'text-embedding-005',
    bananabread_rerank: false,
    bananabread_api_key: '', // Stored here since custom keys aren't returned by ST's readSecretState()

    // Chat vectorization
    enabled_chats: true,
    chunking_strategy: 'per_message', // per_message, conversation_turns, message_batch, message_group_batch, adaptive
    batch_size: 4, // Messages per batch for message_batch strategy
    group_batch_size: 10, // Messages per summarize request for message_group_batch (6-30)
    depth: 2,
    position: extension_prompt_types.IN_PROMPT,
    protect: 5,
    insert: 5,
    min_chat_length: 0, // Minimum number of messages in chat before injection starts (0 = no minimum)
    // Number of top results to retrieve from vector DB (top-K)
    top_k: 7,
    retrieval_popup_on_start: false,   // Show popup when retrieval starts
    retrieval_popup_on_result: false,  // Show popup with number of retrieved results
    query: 2,
    chunk_size: 500, // For adaptive strategy only
    score_threshold: 0.25,

    // Deduplication settings
    deduplication_depth: 50, // Number of recent messages to check for duplicates (0 = check all)

    // Keyword scoring method
    keyword_scoring_method: 'bm25', // 'keyword', 'bm25', or 'hybrid'

    // BM25 parameters
    bm25_k1: 1.5,  // Term frequency saturation (1.2-2.0 typical)
    bm25_b: 0.75,  // Length normalization (0-1, 0.75 typical)

    // Keyword extraction level for chat messages
    keyword_extraction_level: 'balanced', // 'off', 'minimal', 'balanced', 'aggressive'

    // Summarization before vectorization
    summarize_provider: 'off',        // 'off', 'openrouter', 'vllm'
    summarize_openrouter_api_key: '',  // OpenRouter API key for summarization (stored here, not ST secrets)
    summarize_model: '',              // Model ID for summarization (e.g. 'google/gemini-flash-1.5-8b')
    summarize_vllm_url: '',           // vLLM base URL for summarization (e.g. 'http://localhost:8000')
    summarize_vllm_api_key: '',       // vLLM API key (stored in extension settings, not ST secrets)
    summarize_prompt: '',             // Custom prompt template (empty = use built-in default)

    // Hybrid Search settings (combines vector + full-text search)
    hybrid_search_enabled: true,        // Enable hybrid search mode
    hybrid_fusion_method: 'rrf',        // 'rrf' (Reciprocal Rank Fusion) or 'weighted'
    hybrid_vector_weight: 0.5,          // Weight for vector scores (0-1) - used in weighted mode
    hybrid_text_weight: 0.5,            // Weight for text/BM25 scores (0-1) - used in weighted mode
    hybrid_rrf_k: 60,                   // RRF constant (higher = more weight to top results)
    hybrid_native_prefer: true,         // Prefer native backend hybrid if available (Qdrant/Milvus)

    // Advanced features
    temporal_decay: getDefaultDecaySettings(),

    // Global defaults for new collections
    default_decay_enabled: false,    // Whether new collections have temporal weighting enabled
    default_decay_type: 'decay',     // 'decay' or 'nostalgia' for new collections

    // RAG Prompt Context (Global level)
    // Wraps ALL injected content with context prompts and/or XML tags
    rag_context: '',      // Natural language context shown before all RAG content
    rag_xml_tag: 'VectHareMemory',      // XML tag to wrap all RAG content (e.g., "retrieved_context")

    // Collection-level metadata (managed by collection-metadata.js)
    collections: {},

    // Collection registry (list of known collection IDs)
    vecthare_collection_registry: [],

    // World Info Integration
    enabled_world_info: false,          // Enable semantic WI activation
    world_info_threshold: 0.3,          // Score threshold for WI activation
    world_info_top_k: 3,                // Max entries to activate per lorebook
    world_info_query_depth: 3,          // Recent messages to use for query

    // Keyword Extraction
    custom_stopwords: '',               // Custom stopwords (comma-separated)
    cjk_tokenizer_mode: CJK_TOKENIZER_MODES.intl, // intl | jieba | jieba_tw | tiny_segmenter

    // EventBase workflow
    eventbase_enabled: false,                     // Enable EventBase extraction + retrieval path
    eventbase_provider: 'openrouter',             // 'openrouter' | 'vllm'
    eventbase_model: '',                          // Model ID (e.g. 'google/gemini-flash-1.5-8b')
    eventbase_openrouter_api_key: '',             // API key (falls back to summarize key then ST secrets)
    eventbase_vllm_url: '',                       // vLLM base URL
    eventbase_vllm_api_key: '',                   // vLLM API key
    eventbase_temperature: 0.2,
    eventbase_max_tokens: 2048,
    eventbase_timeout_ms: 60000,
    eventbase_window_size: 6,                     // Chat messages per extraction window
    eventbase_window_overlap: 1,                  // Window overlap to avoid edge cuts
    eventbase_min_importance_store: 3,            // Drop events below this importance before storing
    eventbase_max_events_per_window: 5,           // Hard cap on events returned per LLM call
    eventbase_retrieval_top_k: 8,                 // Events to retrieve per generation
    eventbase_retrieval_min_importance: 1,        // Minimum importance for retrieval
    eventbase_retrieval_filters_enabled: true,
    eventbase_debug_logging: false,
    debug_vectorizing_log: false,                // Verbose vectorization progress logs in console
    eventbase_custom_prompt: '',                  // Custom extraction prompt (empty = use built-in default)
    // Re-rank weights (sum is normalized to 1.0 at runtime)
    eventbase_rerank_w_cosine: 0.55,
    eventbase_rerank_w_importance: 0.20,
    eventbase_rerank_w_persist: 0.15,
    eventbase_rerank_w_recency: 0.10,
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
async function vecthare_rearrangeChat(chat, _contextSize, _abort, type) {
    await rearrangeChat(chat, settings, type);
}

// Export to window for ST to call
window['vecthare_rearrangeChat'] = vecthare_rearrangeChat;

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
        'WARNING: This will delete ALL vector data and reset VectHare settings.\n\n' +
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

        // 2. Clear extension_settings.vecthareplus
        for (const key in extension_settings.vecthareplus) {
            if (key !== 'enabled') {
                delete extension_settings.vecthareplus[key];
            }
        }

        // 3. Save settings
        const { saveSettingsDebounced } = await import('../../../../script.js');
        saveSettingsDebounced();

        toastr.success('All vector data purged', 'Purge Complete');

    } catch (error) {
        console.error('VectHare: Purge failed:', error);
        toastr.error('Purge failed: ' + error.message);
    }
}

/**
 * Action: Run diagnostics - opens the diagnostics modal
 */
function onRunDiagnosticsClick() {
    openDiagnosticsModal();
}

/**
 * Initialize VectHare extension
 */
jQuery(async () => {
    console.log('VectHare: Initializing...');

    // Prevent ST from persisting a stale "vecthare" key derived from the folder name.
    // ST auto-creates extension_settings[folderName] on every load, which would write a
    // duplicate "vecthare" entry to settings.json alongside our canonical "vecthareplus" key.
    // Making the property non-enumerable hides it from JSON.stringify so it never saves.
    if (extension_settings.vecthare !== undefined) {
        delete extension_settings.vecthare;
    }
    Object.defineProperty(extension_settings, 'vecthare', {
        get: () => undefined,
        set: () => {},
        enumerable: false,
        configurable: true,
    });

    // Load saved settings
    if (!extension_settings.vecthareplus) {
        extension_settings.vecthareplus = defaultSettings;
    }

    // Merge saved settings with defaults
    settings = {
        ...defaultSettings,
        ...extension_settings.vecthareplus,
        temporal_decay: {
            ...defaultSettings.temporal_decay,
            ...extension_settings.vecthareplus.temporal_decay
        },
        collections: {
            ...defaultSettings.collections,
            ...extension_settings.vecthareplus.collections
        }
    };

    // Migrate old scattered enabled keys to new collections structure
    const migrationResult = migrateOldEnabledKeys();
    if (migrationResult.migrated > 0) {
        console.log(`VectHare: Migrated ${migrationResult.migrated} old collection enabled keys`);
    }

    // Migrate empty rag_xml_tag to default value
    if (!settings.rag_xml_tag) {
        settings.rag_xml_tag = 'VectHareMemory';
        extension_settings.vecthareplus.rag_xml_tag = 'VectHareMemory';
    }

    // Initialize CJK tokenizer mode before any extraction happens.
    setCjkTokenizerMode(settings.cjk_tokenizer_mode || CJK_TOKENIZER_MODES.intl);
    if (settings.cjk_tokenizer_mode === CJK_TOKENIZER_MODES.jieba) {
        ensureJiebaTokenizerLoaded().then((ok) => {
            if (ok) {
                console.log('VectHare CJK: Jieba tokenizer initialized');
            } else {
                console.warn('VectHare CJK: Jieba tokenizer unavailable, using Intl.Segmenter fallback');
            }
        });
    }
    if (settings.cjk_tokenizer_mode === CJK_TOKENIZER_MODES.jieba_tw) {
        ensureJiebaTwLoaded().then((ok) => {
            if (ok) {
                console.log('VectHare CJK: Jieba TW tokenizer initialized');
            } else {
                console.warn('VectHare CJK: Jieba TW tokenizer unavailable, using Intl.Segmenter fallback');
            }
        });
    }

    // Render UI
    renderSettings('extensions_settings2', settings, {
        onVectorizeAll: onVectorizeAllClick,
        onPurge: onPurgeClick,
        onRunDiagnostics: onRunDiagnosticsClick
    });

    // Initialize auto-sync checkbox state for current chat (if any)
    refreshAutoSyncCheckbox(settings);

    // Initialize visualizer
    initializeVisualizer();

    // Initialize database browser
    initializeDatabaseBrowser(settings);

    // Initialize scene markers on chat messages (settings needed for DB operations)
    setSceneSettings(settings);
    initializeSceneMarkers();

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
                        console.warn(`VectHare: Collection discovery attempt ${attempt} failed: ${error.message}. Retrying...`);
                    }
                }
            );
            if (collections.length > 0) {
                console.log(`VectHare: Discovered ${collections.length} existing collections`);
            }
        } catch (err) {
            console.error('VectHare: Collection discovery failed after retries:', err.message);
            toastr.warning(
                'Could not discover existing collections. Open Database Browser to refresh manually.',
                'VectHare: Collection Discovery Failed',
                { timeOut: 10000 }
            );
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
    // When a chat is deleted, purge its vectors (not full purge, just that chat)
    eventSource.on(event_types.CHAT_DELETED, async (chatId) => {
        if (chatId) {
            const collectionId = getChatCollectionId(chatId);
            if (collectionId) {
                await purgeVectorIndex(collectionId, settings);
                console.log(`VectHare: Purged vectors for deleted chat: ${chatId}`);
            }
        }
    });
    eventSource.on(event_types.GROUP_CHAT_DELETED, async (chatId) => {
        if (chatId) {
            const collectionId = getChatCollectionId(chatId);
            if (collectionId) {
                await purgeVectorIndex(collectionId, settings);
                console.log(`VectHare: Purged vectors for deleted group chat: ${chatId}`);
            }
        }
    });

    // When WebLLM extension is loaded, refresh the model list
    eventSource.on(event_types.EXTENSION_SETTINGS_LOADED, async (manifest) => {
        if (settings.source === 'webllm' && manifest?.display_name === 'WebLLM') {
            console.log('VectHare: WebLLM extension loaded, refreshing models...');
            updateWebLlmStatus();
            await loadWebLlmModels(settings);
        }
    });

    // When chat changes, refresh UI state to match settings
    eventSource.on(event_types.CHAT_CHANGED, () => {
        console.log('VectHare: Chat changed, refreshing UI state');
        refreshAutoSyncCheckbox(settings);
    });

    console.log('VectHare: ✅ Initialized successfully');
});

/**
 * Lifecycle hook: called by SillyTavern after a successful extension update.
 * Forces a full page reload so the browser fetches the new JS/CSS files
 * instead of serving stale cached versions.
 */
export async function onUpdate() {
    console.log('VectHare: Update detected — reloading page to clear module cache');
    location.reload();
}
