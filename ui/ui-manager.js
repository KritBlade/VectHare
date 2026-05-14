/**
 * ============================================================================
 * VectFox UI MANAGER
 * ============================================================================
 * Handles ALL UI rendering and event binding
 * Keeps index.js clean and lean
 *
 * @author Kritblade
 * @version 3.3.1
 * ============================================================================
 */

import { saveSettingsDebounced, getCurrentChatId, eventSource, event_types } from '../../../../../script.js';
import { extension_settings, openThirdPartyExtensionMenu, getContext } from '../../../../extensions.js';
import { writeSecret, SECRET_KEYS, secret_state, readSecretState } from '../../../../secrets.js';
import { getWebLlmProvider as getSharedWebLlmProvider } from '../providers/webllm.js';
import { openVisualizer } from './chunk-visualizer.js';
import { openDatabaseBrowser } from './database-browser.js';
import { openContentVectorizer } from './content-vectorizer.js';
import { openSearchDebugModal, openQueryTestModal, getLastSearchDebug } from './search-debug.js';
import { openTextCleaningManager } from './text-cleaning-manager.js';
import { progressTracker } from './progress-tracker.js';
import { resetBackendHealth } from '../backends/backend-manager.js';
import { getHealthIndicatorHtml, getHealthModalHtml, initializeHealthDashboard } from './health-dashboard.js';
import { doesChatHaveVectors, getCollectionRegistry } from '../core/collection-loader.js';
import { parseRegistryKey } from '../core/collection-ids.js';
import { getModelField } from '../core/providers.js';
import { getChunkingStrategies } from '../core/content-types.js';
import { CJK_TOKENIZER_MODES, setCjkTokenizerMode, ensureJiebaTokenizerLoaded, ensureJiebaTwLoaded } from '../core/bm25-scorer.js';

/**
 * Renders the VectFox settings UI
 * @param {string} containerId - The container element ID to render into
 * @param {object} settings - VectFox settings object
 * @param {object} callbacks - Object containing callback functions
 * @param {Function} callbacks.onVectorizeAll - Called when "Vectorize All" is clicked
 * @param {Function} callbacks.onPurge - Called when "Purge" is clicked
 * @param {Function} callbacks.onCleanupCorrupted - Called when "Cleanup Corrupted" is clicked
 * @param {Function} callbacks.onRunDiagnostics - Called when "Run Diagnostics" is clicked
 */
export function renderSettings(containerId, settings, callbacks) {
    console.log('VectFox UI: Rendering settings...');

    // Ensure extension_settings.vectfox exists before any UI event handlers fire
    if (!extension_settings.vectfox) {
        extension_settings.vectfox = {};
    }

    const html = `
        <div id="VectFox_settings">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>VectFox - Advanced RAG</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">

                    <!-- Tab Navigation -->
                    <div class="vectfox-tabs">
                        <div class="vectfox-tab-nav-row">
                            <button class="vectfox-tab-btn active" data-tab="action">Action</button>
                            <button class="vectfox-tab-btn" data-tab="core">Core</button>
                            <button class="vectfox-tab-btn" data-tab="eventbase">EventBase</button>
                            <button class="vectfox-tab-btn" data-tab="weight">ChunkBase</button>
                        </div>
                        <div class="vectfox-tab-nav-row">
                            <button class="vectfox-tab-btn" data-tab="autosync">AutoSync</button>
                            <button class="vectfox-tab-btn" data-tab="worldinfo">WorldInfo</button>
                            <button class="vectfox-tab-btn" data-tab="rag">RAG</button>
                            <button class="vectfox-tab-btn" data-tab="agentmode">AgentMode</button>
                        </div>
                    </div>

                    <!-- Core Settings Card -->
                    <div class="vectfox-card" data-vectfox-tab="core">
                        <div class="vectfox-card-header">
                            <h3 class="vectfox-card-title">
                                <span class="vectfox-icon">
                                    <i class="fa-solid fa-cog"></i>
                                </span>
                                Core Settings
                            </h3>
                            <p class="vectfox-card-subtitle">Shared settings for embedding, retrieval, and EventBase extraction.</p>
                        </div>
                        <div class="vectfox-card-body">

                            <!-- ═══════════════════════════════════════════════════════ -->
                            <!-- GROUP 1: Vector Storage                                -->
                            <!-- ═══════════════════════════════════════════════════════ -->
                            <div class="vectfox-subsection">
                                <div class="vectfox-card-header" style="padding: 0 0 8px 0;">
                                    <h3 class="vectfox-card-title" style="font-size: 0.95em;">
                                        <span class="vectfox-icon"><i class="fa-solid fa-database"></i></span>
                                        Vector Storage
                                    </h3>
                                    <p class="vectfox-card-subtitle">Vector database backend</p>
                                </div>

                                <label for="VectFox_vector_backend">
                                    <small>Vector Backend</small>
                                </label>
                                <select id="VectFox_vector_backend" class="vectfox-select">
                                    <option value="standard">Standard (ST's Vectra - file-based)</option>
                                    <option value="qdrant">Qdrant (production vector search)</option>
                                </select>
                                <small class="vectfox-help-text" style="display: block; margin-top: -8px; margin-bottom: 16px; opacity: 0.7; font-size: 0.85em; line-height: 1.5;">
                                    • Standard: ST's built-in Vectra (best for &lt;100k vectors)<br>
                                    • Qdrant: Production-grade with HNSW, filtering, cloud support
                                </small>

                                <!-- Qdrant Settings (shown only when Qdrant backend is selected) -->
                                <div id="VectFox_qdrant_settings" style="display: none;">
                                    <label class="checkbox_label">
                                        <input type="checkbox" id="VectFox_qdrant_use_cloud" />
                                        <span>Use Qdrant Cloud</span>
                                    </label>

                                    <!-- Local Qdrant Settings -->
                                    <div id="VectFox_qdrant_local_settings">
                                        <label for="VectFox_qdrant_host">
                                            <small>Qdrant Host:</small>
                                        </label>
                                        <input type="text" id="VectFox_qdrant_host" class="vectfox-input" placeholder="localhost" />

                                        <label for="VectFox_qdrant_port">
                                            <small>Qdrant Port:</small>
                                        </label>
                                        <input type="number" id="VectFox_qdrant_port" class="vectfox-input" placeholder="6333" />
                                    </div>

                                    <!-- Cloud Qdrant Settings -->
                                    <div id="VectFox_qdrant_cloud_settings" style="display: none;">
                                        <label for="VectFox_qdrant_url">
                                            <small>Qdrant Cloud URL:</small>
                                        </label>
                                        <input type="text" id="VectFox_qdrant_url" class="vectfox-input" placeholder="https://xxx.cloud.qdrant.io" />

                                        <label for="VectFox_qdrant_api_key">
                                            <small>API Key:</small>
                                        </label>
                                        <input type="password" id="VectFox_qdrant_api_key" class="vectfox-input" placeholder="Your Qdrant Cloud API key" />
                                    </div>

                                    <!-- Qdrant Multitenancy Setting -->
                                    <div style="margin-top: 10px; padding: 8px; background: rgba(0,0,0,0.1); border-radius: 4px;">
                                        <label class="checkbox_label" title="When enabled, uses a single Qdrant collection with content_type filtering (multitenancy). When disabled, creates separate collections for each content type (better isolation).">
                                            <input type="checkbox" id="VectFox_qdrant_multitenancy" />
                                            <span>Use Multitenancy (Single Collection)</span>
                                        </label>
                                        <small class="VectFox_hint" style="display: block; margin-top: 4px;">
                                            <strong>Multitenancy ON:</strong> Single collection with filtering (saves resources)<br>
                                            <strong>Multitenancy OFF:</strong> Separate collections per content type (better isolation)
                                        </small>
                                    </div>
                                </div>
                            </div>

                            <!-- ═══════════════════════════════════════════════════════ -->
                            <!-- GROUP 2: Embedding                                     -->
                            <!-- ═══════════════════════════════════════════════════════ -->
                            <div class="vectfox-subsection" style="margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--grey30);">
                                <div class="vectfox-card-header" style="padding: 0 0 8px 0;">
                                    <h3 class="vectfox-card-title" style="font-size: 0.95em;">
                                        <span class="vectfox-icon"><i class="fa-solid fa-microchip"></i></span>
                                        Embedding
                                    </h3>
                                    <p class="vectfox-card-subtitle">Embedding provider and model</p>
                                </div>

                                <label for="VectFox_source">
                                    <small>Embedding Provider</small>
                                </label>
                                <select id="VectFox_source" class="vectfox-select">
                                    <option value="transformers">Transformers (Local)</option>
                                    <option value="ollama">Ollama</option>
                                    <option value="openrouter">OpenRouter</option>
                                    <option value="vllm">vLLM</option>
                                </select>

                                <!-- Provider-Specific Settings -->
                                <div id="VectFox_provider_settings">

                                    <!-- Ollama Settings -->
                                    <div class="VectFox_provider_setting" data-provider="ollama">
                                        <label class="checkbox_label">
                                            <input type="checkbox" id="VectFox_ollama_use_alt_endpoint" />
                                            <span>Use Alternative Endpoint</span>
                                        </label>
                                        <input type="text" id="VectFox_ollama_alt_endpoint_url" class="vectfox-input" placeholder="http://localhost:11434" />
                                        <small class="VectFox_hint">Override default Ollama API URL</small>
                                        <label for="VectFox_ollama_model" style="margin-top: 8px;">
                                            <small>Ollama Model:</small>
                                        </label>
                                        <input type="text" id="VectFox_ollama_model" class="vectfox-input" placeholder="mxbai-embed-large" />
                                        <label class="checkbox_label" style="margin-top: 6px;">
                                            <input type="checkbox" id="VectFox_ollama_keep" />
                                            <span>Keep Model in Memory</span>
                                        </label>
                                        <small class="VectFox_hint">Enter the model name from your Ollama installation</small>
                                        <label for="VectFox_ollama_api_key" style="margin-top: 8px;">
                                            <small>API Key <span style="opacity:0.6;">(optional — for remote/proxied Ollama endpoints)</span>:</small>
                                        </label>
                                        <input type="password" id="VectFox_ollama_api_key" class="vectfox-input" placeholder="Leave blank for local deployments" autocomplete="off" />
                                    </div>

                                    <!-- vLLM Settings -->
                                    <div class="VectFox_provider_setting" data-provider="vllm">
                                        <label class="checkbox_label">
                                            <input type="checkbox" id="VectFox_vllm_use_alt_endpoint" />
                                            <span>Use Alternative Endpoint</span>
                                        </label>
                                        <input type="text" id="VectFox_vllm_alt_endpoint_url" class="vectfox-input" placeholder="http://localhost:8000" />
                                        <small class="VectFox_hint">Override default vLLM API URL</small>
                                        <label for="VectFox_vllm_model" style="margin-top: 8px;">
                                            <small>vLLM Model:</small>
                                        </label>
                                        <input type="text" id="VectFox_vllm_model" class="vectfox-input" placeholder="Model name" />
                                        <small class="VectFox_hint">Enter the model name from your vLLM deployment</small>
                                        <label for="VectFox_vllm_api_key" style="margin-top: 8px;">
                                            <small>vLLM API Key (optional):</small>
                                        </label>
                                        <input type="password" id="VectFox_vllm_api_key" class="vectfox-input" placeholder="Leave blank for local / no-auth deployments" autocomplete="off" />
                                    </div>

                                    <!-- OpenRouter Model -->
                                    <div class="VectFox_provider_setting" data-provider="openrouter">
                                        <label for="VectFox_openrouter_model">
                                            <small>OpenRouter Model:</small>
                                        </label>
                                        <div style="display: flex; gap: 6px; align-items: stretch;">
                                            <input type="text" id="VectFox_openrouter_model" class="vectfox-input" style="flex: 1;" placeholder="openai/text-embedding-3-large" />
                                            <button id="VectFox_openrouter_model_choose" class="menu_button" type="button" title="Browse OpenRouter's model list (filtered to embedding models)">
                                                <i class="fa-solid fa-list"></i> Choose
                                            </button>
                                        </div>
                                        <select id="VectFox_openrouter_model_list" class="vectfox-select" style="display:none; margin-top:6px;"></select>
                                        <small class="VectFox_hint">Enter OpenRouter-compatible model ID, or click <b>Choose</b> to browse. List defaults to embedding models — toggle <i>Show all</i> if you need to pick a non-embedding one.</small>
                                        <label for="VectFox_openrouter_apikey" style="margin-top: 8px;">
                                            <small>OpenRouter API Key:</small>
                                        </label>
                                        <input type="password" id="VectFox_openrouter_apikey" class="vectfox-input" placeholder="Paste key here to save..." autocomplete="off" />
                                    </div>

                                </div>

                                <!-- API Rate Limiting -->
                                <div style="margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--grey30);">
                                    <label>
                                        <small>API Rate Limiting (0 to disable)</small>
                                    </label>
                                    <div style="display: flex; gap: 10px;">
                                        <div style="flex: 1;">
                                            <label for="VectFox_rate_limit_calls" style="display: block; margin-bottom: 4px;">
                                                <small>Max Calls</small>
                                            </label>
                                            <input type="number" id="VectFox_rate_limit_calls" class="vectfox-input" min="0" placeholder="5" />
                                        </div>
                                        <div style="flex: 1;">
                                            <label for="VectFox_rate_limit_interval" style="display: block; margin-bottom: 4px;">
                                                <small>Interval (sec)</small>
                                            </label>
                                            <input type="number" id="VectFox_rate_limit_interval" class="vectfox-input" min="1" placeholder="60" />
                                        </div>
                                    </div>
                                    <small class="VectFox_hint">Limit the number of API requests per time interval</small>
                                </div>
                            </div>

                            <!-- ═══════════════════════════════════════════════════════ -->
                            <!-- GROUP 3: LLM / EventBase Extraction                   -->
                            <!-- ═══════════════════════════════════════════════════════ -->
                            <div class="vectfox-subsection" style="margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--grey30);">
                                <div class="vectfox-card-header" style="padding: 0 0 8px 0;">
                                    <h3 class="vectfox-card-title" style="font-size: 0.95em;">
                                        <span class="vectfox-icon">
                                            <i class="fa-solid fa-file-lines"></i>
                                        </span>
                                        LLM Summarization &amp; EventBase Extraction
                                    </h3>
                                    <p class="vectfox-card-subtitle">LLM for EventBase event extraction</p>
                                </div>

                                <label for="VectFox_summarize_provider">
                                    <small>Summarization Provider</small>
                                </label>
                                <select id="VectFox_summarize_provider" class="vectfox-select">
                                    <option value="openrouter">OpenRouter</option>
                                    <option value="vllm">vLLM</option>
                                </select>
                                <small class="VectFox_hint">Provider required for summarization / EventBase extraction LLM calls</small>

                                <div id="VectFox_summarize_settings" style="display:none; margin-top:12px;">

                                    <div id="VectFox_summarize_openrouter_row" style="display:none; margin-bottom:10px;">
                                        <label for="VectFox_summarize_openrouter_apikey">
                                            <small>OpenRouter API Key</small>
                                        </label>
                                        <input type="password" id="VectFox_summarize_openrouter_apikey" class="vectfox-input"
                                            placeholder="Paste key here to save..." autocomplete="off" />
                                        <small class="VectFox_hint">Stored in VectFox settings (separate from the embedding key)</small>
                                    </div>

                                    <div id="VectFox_summarize_vllm_url_row" style="display:none; margin-bottom:10px;">
                                        <label for="VectFox_summarize_vllm_url">
                                            <small>vLLM Base URL</small>
                                        </label>
                                        <input type="text" id="VectFox_summarize_vllm_url" class="vectfox-input"
                                            placeholder="http://localhost:8000" />
                                        <small class="VectFox_hint">Base URL of your vLLM server (OpenAI-compatible)</small>
                                        <label for="VectFox_summarize_vllm_apikey" style="margin-top:8px;">
                                            <small>vLLM API Key <span style="opacity:0.6;">(optional — leave blank if not required)</span></small>
                                        </label>
                                        <input type="password" id="VectFox_summarize_vllm_apikey" class="vectfox-input"
                                            placeholder="Paste key here to save..." autocomplete="off" />
                                    </div>

                                    <label for="VectFox_summarize_model">
                                        <small>Summarization / EventBase Model</small>
                                    </label>
                                    <div style="display: flex; gap: 6px; align-items: stretch;">
                                        <input type="text" id="VectFox_summarize_model" class="vectfox-input" style="flex: 1;"
                                            placeholder="e.g. google/gemini-flash-1.5-8b" />
                                        <button id="VectFox_summarize_model_choose" class="menu_button" type="button" title="Fetch available models from the configured provider">
                                            <i class="fa-solid fa-list"></i> Choose
                                        </button>
                                    </div>
                                    <select id="VectFox_summarize_model_list" class="vectfox-select" style="display:none; margin-top:6px;"></select>
                                    <small class="VectFox_hint">Model ID used for EventBase extraction (separate from embedding model). Required. Click <b>Choose</b> to browse the provider's model list.</small>

                                </div>
                            </div>

                            <!-- ═══════════════════════════════════════════════════════ -->
                            <!-- GROUP 4: Retrieval                                     -->
                            <!-- ═══════════════════════════════════════════════════════ -->
                            <div class="vectfox-subsection" style="margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--grey30);">
                                <div class="vectfox-card-header" style="padding: 0 0 8px 0;">
                                    <h3 class="vectfox-card-title" style="font-size: 0.95em;">
                                        <span class="vectfox-icon"><i class="fa-solid fa-magnifying-glass"></i></span>
                                        Retrieval
                                    </h3>
                                    <p class="vectfox-card-subtitle">Shared retrieval settings (EventBase + ChunkBase)</p>
                                </div>

                                <label for="VectFox_query_depth" style="margin-top: 4px;">
                                    <small>Query Depth: <span id="VectFox_query_depth_value">2</span> messages</small>
                                </label>
                                <input type="range" id="VectFox_query_depth" class="vectfox-slider" min="1" max="20" step="1" />
                                <small class="VectFox_hint">How many recent messages to include in the search query</small>

                                <label for="VectFox_min_chat_length" style="margin-top: 12px;">
                                    <small>Minimum Messages Before Injection</small>
                                </label>
                                <input type="number" id="VectFox_min_chat_length" class="vectfox-input" min="0" max="100" step="1" placeholder="0" />
                                <small class="VectFox_hint">Minimum number of messages in chat before RAG injection starts (0 = inject immediately)</small>

                                <label for="VectFox_deduplication_depth" style="margin-top: 12px;">
                                    <small>Skip Already-Visible Events: <span id="VectFox_deduplication_depth_value">0</span> messages</small>
                                </label>
                                <input type="range" id="VectFox_deduplication_depth" class="vectfox-slider" min="0" max="500" step="10" />
                                <small class="VectFox_hint">Drop candidate events whose source window is in the last N messages of the chat (assumption: the LLM can already see them in raw context). <b>0 = OFF (recommended)</b> — never skip on this basis. Real raw-context visibility is usually only ~3-6 messages (depends on context budget), so larger values tend to over-filter. Independent from "Dedup Window Gap" below, which is about removing near-duplicate events from the candidate pool.</small>

                                <label for="VectFox_eventbase_dedup_window_gap" style="margin-top: 12px;">
                                    <small>Dedup Window Gap: <span id="VectFox_eventbase_dedup_window_gap_val">10</span> messages</small>
                                </label>
                                <input type="range" id="VectFox_eventbase_dedup_window_gap" class="vectfox-slider" min="0" max="200" step="1" />
                                <small class="VectFox_hint">EventBase only. Minimum source-window distance at which two same-type/same-cast events are considered <b>distinct</b> (kept). <b>0 = OFF</b> (no temporal-proximity dedup; even same-window duplicates kept). <b>1</b> = only same-window duplicates suppressed. <b>10</b> (default) = events within 9 messages dedup'd; 10+ apart kept. Higher = more aggressive dedup.</small>

                                <label for="VectFox_eventbase_anchor_boost" style="margin-top: 12px;">
                                    <small>Anchor Boost: <span id="VectFox_eventbase_anchor_boost_val">0.20</span></small>
                                </label>
                                <input type="range" id="VectFox_eventbase_anchor_boost" class="vectfox-slider" min="0" max="0.5" step="0.05" />
                                <small class="VectFox_hint">EventBase only. Flat additive bonus when an event's stored keyword appears verbatim in your last message. Rescues historically-distant events the user explicitly asks about. 0 = disabled. Range 0.00-0.50, default 0.20.</small>

                                <div style="margin-top: 12px;">
                                    <label class="checkbox_label" for="VectFox_eventbase_native_rerank">
                                        <input id="VectFox_eventbase_native_rerank" type="checkbox" />
                                        <span>Push EventBase re-rank to Qdrant</span>
                                    </label>
                                    <small class="VectFox_hint">A3 (Qdrant) only. Computes importance/persist/recency weighted scoring inside Qdrant via a formula query, in the same /query call as the dense+sparse hybrid. Anchor boost and pairwise dedup still run locally. Requires Qdrant 1.13+; falls back gracefully when unavailable. Re-tune the cosine weight if recall changes — see plans/qdrant-native-eventbase-rerank-formula.md.</small>
                                </div>

                                <div style="margin-top: 12px;">
                                    <label class="checkbox_label" for="VectFox_retrieval_popup_on_start">
                                        <input id="VectFox_retrieval_popup_on_start" type="checkbox" />
                                        <span>Popup: show when backend retrieval starts</span>
                                    </label>
                                    <label class="checkbox_label" for="VectFox_retrieval_popup_on_result" style="margin-top: 6px; display: flex;">
                                        <input id="VectFox_retrieval_popup_on_result" type="checkbox" />
                                        <span>Popup: show retrieved result count</span>
                                    </label>
                                </div>
                            </div>

                            <!-- ═══════════════════════════════════════════════════════ -->
                            <!-- GROUP 5: Injection                                     -->
                            <!-- ═══════════════════════════════════════════════════════ -->
                            <div class="vectfox-subsection" style="margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--grey30);">
                                <div class="vectfox-card-header" style="padding: 0 0 8px 0;">
                                    <h3 class="vectfox-card-title" style="font-size: 0.95em;">
                                        <span class="vectfox-icon"><i class="fa-solid fa-arrow-right-to-bracket"></i></span>
                                        Injection
                                    </h3>
                                    <p class="vectfox-card-subtitle">Prompt injection position</p>
                                </div>

                                <label style="margin-top: 4px;">
                                    <small>Injection Position</small>
                                </label>
                                <select id="VectFox_injection_position" class="vectfox-select">
                                    <option value="2">Before Main Prompt</option>
                                    <option value="0">After Main Prompt</option>
                                    <option value="1">In-Chat @ Depth</option>
                                </select>
                                <small class="VectFox_hint">Where retrieved chunks appear in the prompt</small>

                                <div id="VectFox_injection_depth_row" style="margin-top: 12px; display: none;">
                                    <label for="VectFox_injection_depth">
                                        <small>Injection Depth: <span id="VectFox_injection_depth_value">2</span></small>
                                    </label>
                                    <input type="range" id="VectFox_injection_depth" class="vectfox-slider" min="0" max="50" step="1" />
                                    <small class="VectFox_hint">Messages from end of chat to insert at</small>
                                </div>
                            </div>

                            <!-- ═══════════════════════════════════════════════════════ -->
                            <!-- GROUP 6: Hybrid Search & BM25                          -->
                            <!-- ═══════════════════════════════════════════════════════ -->
                            <div class="vectfox-subsection" style="margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--grey30);">
                                <div class="vectfox-card-header" style="padding: 0 0 8px 0;">
                                    <h3 class="vectfox-card-title" style="font-size: 0.95em;">
                                        <span class="vectfox-icon"><i class="fa-solid fa-bolt"></i></span>
                                        Hybrid Search &amp; BM25
                                    </h3>
                                    <p class="vectfox-card-subtitle">Keyword scoring and result fusion</p>
                                </div>

                                <!-- Keyword Scoring Method (hidden when native hybrid active) -->
                                <div id="VectFox_keyword_method_section" style="margin-top: 8px;">
                                    <label>
                                        <small>Keyword Scoring Method</small>
                                    </label>
                                    <select id="VectFox_keyword_scoring_method" class="vectfox-select">
                                        <option value="bm25">BM25 (fast re-rank of top-K)</option>
                                        <option value="hybrid">Hybrid (vector candidates + BM25 fusion)</option>
                                    </select>
                                    <small class="VectFox_hint">BM25 re-ranks the vector top-K candidates. Hybrid expands the vector candidate window, scores those candidates with BM25, then fuses both signals. It is broader than BM25 mode, but not a true full-corpus keyword scan.</small>
                                </div>

                                <!-- Shown instead of above when native hybrid (A3) is active -->
                                <div id="VectFox_native_hybrid_info" style="display: none; margin-top: 16px;">
                                    <small class="VectFox_hint"><i class="fa-solid fa-bolt"></i> Native Qdrant hybrid active: dense ANN + sparse BM25 (global IDF) fused server-side via RRF. The CJK Tokenizer Mode below is locked into each collection at upsert.</small>
                                </div>

                                <!-- BM25 Parameters (visible when client-side BM25 logic runs — A1 or A2) -->
                                <div id="VectFox_bm25_params" style="margin-top: 12px; padding: 12px; background: rgba(0,0,0,0.1); border-radius: 8px;">
                                    <label for="VectFox_bm25_k1">
                                        <small>BM25 k1 (TF saturation): <span id="VectFox_bm25_k1_value">1.5</span></small>
                                    </label>
                                    <input type="range" id="VectFox_bm25_k1" class="vectfox-slider" min="0.5" max="3.0" step="0.1" />
                                    <small class="VectFox_hint">Controls term frequency saturation (1.2-2.0 typical)</small>

                                    <label for="VectFox_bm25_b" style="margin-top: 8px;">
                                        <small>BM25 b (Length norm): <span id="VectFox_bm25_b_value">0.75</span></small>
                                    </label>
                                    <input type="range" id="VectFox_bm25_b" class="vectfox-slider" min="0" max="1" step="0.05" />
                                    <small class="VectFox_hint">Controls document length normalization (0.75 typical)</small>
                                </div>

                                <!-- Hybrid Search params (visible in A2 hybrid mode and A3 native) -->
                                <div style="margin-top: 16px; padding: 12px; background: rgba(0,100,200,0.1); border-radius: 8px; border: 1px solid rgba(0,100,200,0.2);">
                                    <div id="VectFox_hybrid_params" style="margin-top: 4px;">
                                        <label style="margin-top: 8px;">
                                            <small>Fusion Method</small>
                                        </label>
                                        <select id="VectFox_hybrid_fusion_method" class="vectfox-select">
                                            <option value="rrf">RRF (Reciprocal Rank Fusion)</option>
                                            <option value="weighted">Weighted Linear Combination</option>
                                        </select>
                                        <small class="VectFox_hint">RRF is parameter-free and robust; Weighted allows fine-tuning</small>

                                        <div id="VectFox_hybrid_weights" style="display: none; margin-top: 12px;">
                                            <label for="VectFox_hybrid_vector_weight">
                                                <small>Vector Weight: <span id="VectFox_hybrid_vector_weight_value">0.5</span></small>
                                            </label>
                                            <input type="range" id="VectFox_hybrid_vector_weight" class="vectfox-slider" min="0" max="1" step="0.1" />

                                            <label for="VectFox_hybrid_text_weight" style="margin-top: 8px;">
                                                <small>Text Weight: <span id="VectFox_hybrid_text_weight_value">0.5</span></small>
                                            </label>
                                            <input type="range" id="VectFox_hybrid_text_weight" class="vectfox-slider" min="0" max="1" step="0.1" />
                                        </div>

                                        <div id="VectFox_hybrid_rrf_settings" style="margin-top: 12px;">
                                            <label for="VectFox_hybrid_rrf_k">
                                                <small>RRF K Constant: <span id="VectFox_hybrid_rrf_k_value">60</span></small>
                                            </label>
                                            <input type="range" id="VectFox_hybrid_rrf_k" class="vectfox-slider" min="1" max="100" step="1" />
                                            <small class="VectFox_hint">Higher K = more weight to top-ranked results (60 is typical)</small>
                                        </div>
                                    </div>
                                </div>

                            </div>

                            <!-- ═══════════════════════════════════════════════════════ -->
                            <!-- GROUP 7: Keyword Extraction                            -->
                            <!-- ═══════════════════════════════════════════════════════ -->
                            <div class="vectfox-subsection" style="margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--grey30);">
                                <div class="vectfox-card-header" style="padding: 0 0 8px 0;">
                                    <h3 class="vectfox-card-title" style="font-size: 0.95em;">
                                        <span class="vectfox-icon"><i class="fa-solid fa-tags"></i></span>
                                        Keyword Extraction
                                    </h3>
                                    <p class="vectfox-card-subtitle">CJK tokenizer and stopwords for BM25</p>
                                </div>

                                <label for="VectFox_cjk_tokenizer_mode">
                                    <small><b>CJK Tokenizer Mode</b></small>
                                </label>
                                <select id="VectFox_cjk_tokenizer_mode" class="vectfox-select" style="margin-top: 4px;">
                                    <option value="intl">Intl.Segmenter (English / Korean / Latin)</option>
                                    <option value="jieba">Simplified Chinese (Jieba WASM)</option>
                                    <option value="jieba_tw">Traditional Chinese (Jieba WASM)</option>
                                    <option value="tiny_segmenter">Japanese (TinySegmenter)</option>
                                    <option value="korean">Korean (Intl.Segmenter)</option>
                                    <option value="others">Others (Intl.Segmenter)</option>
                                </select>
                                <small class="VectFox_hint">Default mode uses Intl.Segmenter — supports Korean, Chinese, and any Latin-script language (English, French, etc.) with no extra downloads. Jieba WASM loads only when selected. Traditional Chinese also downloads a TW dictionary (~2–5 MB, one-time). TinySegmenter is used for kana-containing Japanese text.</small>
                            </div>

                            <div style="margin-top: 12px; padding: 12px; background: rgba(100,100,100,0.1); border-radius: 8px;">
                                <label for="VectFox_custom_stopwords">
                                    <small><b>Custom Stopwords</b></small>
                                </label>
                                <textarea id="VectFox_custom_stopwords" class="vectfox-textarea" rows="2"
                                    placeholder="{{char}}, {{user}}, character, scene, location..."
                                    style="margin-top: 4px;"></textarea>
                                <small class="VectFox_hint">Words to exclude from keyword extraction. Supports ST macros: {{char}}, {{user}}, {{charIfNotGroup}}, etc.</small>
                            </div>

                        </div>
                    </div>

                    <!-- ChunkBase Settings Card -->
                    <div class="vectfox-card" data-vectfox-tab="weight">
                        <div class="vectfox-card-header">
                            <h3 class="vectfox-card-title">
                                <span class="vectfox-icon">
                                    <i class="fa-solid fa-layer-group"></i>
                                </span>
                                ChunkBase Settings
                            </h3>
                            <p class="vectfox-card-subtitle">Settings on this tab apply to chunk-based content: <b>Lorebook / World Info</b>, <b>Character Cards</b>, <b>URLs / web pages</b>, <b>custom documents</b>, <b>wiki pages</b>, and <b>YouTube transcripts</b>. Chat history is handled separately under EventBase.</p>
                        </div>
                        <div class="vectfox-card-body">

                            <!-- Ingestion -->
                            <p class="vectfox-section-label" style="font-weight:600; margin-bottom:8px;">Ingestion</p>
                            <label for="VectFox_insert_batch_size">
                                <small>Insert Batch Size: <span id="VectFox_insert_batch_size_value">50</span></small>
                            </label>
                            <input type="range" id="VectFox_insert_batch_size" class="vectfox-slider" min="10" max="100" step="10" />
                            <small class="VectFox_hint">Chunks per insert batch (50-100 recommended for faster bulk operations)</small>

                            <!-- Query (ChunkBase-only) -->
                            <p class="vectfox-section-label" style="font-weight:600; margin-top:16px; margin-bottom:8px;">Query</p>
                            <div style="margin-top:4px; display:flex; gap:8px; align-items:center;">
                                <label for="VectFox_topk" style="margin:0; white-space:nowrap;"><small>Top K</small></label>
                                <input id="VectFox_topk" type="number" class="vectfox-input" min="1" style="width:90px;" />
                                <small class="VectFox_hint" style="margin-left:8px;">Up to this many results per collection (may be fewer after filtering/dedup)</small>
                            </div>

                            <!-- Retrieval Gating (ChunkBase-only) -->
                            <p class="vectfox-section-label" style="font-weight:600; margin-top:16px; margin-bottom:8px;">Retrieval Gating</p>
                            <label for="VectFox_score_threshold" style="margin-top:12px;">
                                <small>Similarity Threshold: <span id="VectFox_threshold_value">0.25</span></small>
                            </label>
                            <input type="range" id="VectFox_score_threshold" class="vectfox-slider" min="0" max="1" step="0.05" />
                            <small class="VectFox_hint">Minimum relevance score for retrieval</small>

                            <!-- Keyword Budget (chunk-only; visible only in A1 Standard+BM25 mode) -->
                            <p class="vectfox-section-label" style="font-weight:600; margin-top:16px; margin-bottom:8px;">Keyword Budget</p>
                            <small class="VectFox_hint" style="display: block; margin-bottom: 8px;">
                                Chunk-path-only setting. Other hybrid/BM25 knobs live under <b>Core → Hybrid Search &amp; BM25</b>.
                            </small>
                            <div id="VectFox_hybrid_keyword_budget_wrapper" style="margin-top: 8px;">
                                <label>
                                    <small>Query Keyword Budget</small>
                                </label>
                                <select id="VectFox_hybrid_keyword_level" class="vectfox-select">
                                    <option value="minimal">30</option>
                                    <option value="balance">50</option>
                                    <option value="maximum">70</option>
                                </select>
                                <small class="VectFox_hint">Max keywords extracted from your query for BM25 scoring (CJK priority; +10 English overflow when CJK fills budget). Used only when Standard backend + BM25 mode is active.</small>
                            </div>

                        </div>
                    </div>

                    <!-- Global Temporal Weighting Defaults Card -->
                    <div class="vectfox-card" data-vectfox-tab="weight">
                        <div class="vectfox-card-header">
                            <h3 class="vectfox-card-title">
                                <span class="vectfox-icon">
                                    <i class="fa-solid fa-clock"></i>
                                </span>
                                Temporal Weighting Defaults (Non-Chat Collections)
                            </h3>
                            <p class="vectfox-card-subtitle">Default settings for newly created non-chat collections that still use chunk retrieval (can be overridden per-collection)</p>
                        </div>
                        <div class="vectfox-card-body">

                            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 12px;">
                                <input type="checkbox" id="VectFox_default_decay_enabled" />
                                <label for="VectFox_default_decay_enabled" style="margin: 0;">
                                    <small>Enable temporal weighting by default for non-chat collections</small>
                                </label>
                            </div>

                            <div id="VectFox_default_decay_type_section" class="vectfox-subsection-disabled">
                                <label style="margin-bottom: 4px;">
                                    <small>Default Type</small>
                                </label>
                                <div style="display: flex; gap: 12px; margin-bottom: 12px;">
                                    <label style="display: flex; align-items: center; gap: 4px; margin: 0;">
                                        <input type="radio" name="VectFox_default_decay_type" value="decay" />
                                        <small>Decay (favor recent)</small>
                                    </label>
                                    <label style="display: flex; align-items: center; gap: 4px; margin: 0;">
                                        <input type="radio" name="VectFox_default_decay_type" value="nostalgia" />
                                        <small>Nostalgia (favor old)</small>
                                    </label>
                                </div>
                            </div>

                            <small class="VectFox_hint">These defaults apply only to newly created non-chat collections that use the chunk-based retrieval path. Chat history/EventBase retrieval does not use this setting. Existing collections keep their settings.</small>

                        </div>
                    </div>

                    <!-- RAG Context Card -->
                    <div class="vectfox-card" data-vectfox-tab="rag">
                        <div class="vectfox-card-header">
                            <h3 class="vectfox-card-title">
                                <span class="vectfox-icon">
                                    <i class="fa-solid fa-quote-left"></i>
                                </span>
                                RAG Context
                            </h3>
                            <p class="vectfox-card-subtitle">Retrieval-Augmented Generation injection settings — XML tag wrapping, prompt template, injection depth and position. Applies to retrieved results from any path.</p>
                        </div>
                        <div class="vectfox-card-body">

                            <label for="VectFox_rag_context">
                                <small>Global Context Prompt</small>
                            </label>
                            <textarea id="VectFox_rag_context" class="vectfox-textarea" rows="3" placeholder="e.g., The following information may be relevant to your conversation with {{user}}:"></textarea>
                            <small class="VectFox_hint">Shown before all RAG content. Supports {{user}} and {{char}} variables.</small>

                            <label for="VectFox_rag_xml_tag" style="margin-top: 12px;">
                                <small>Global XML Tag (optional)</small>
                            </label>
                            <input type="text" id="VectFox_rag_xml_tag" class="vectfox-input" placeholder="e.g., retrieved_context" />
                            <small class="VectFox_hint">Wraps all RAG content in &lt;tag&gt;...&lt;/tag&gt;. Leave empty for no wrapping.</small>

                            <div class="VectFox_info" style="margin-top: 16px; padding: 8px 12px; border-radius: 4px; background: var(--SmartThemeBlurTintColor); font-size: 0.85em;">
                                <i class="fa-solid fa-info-circle"></i>
                                <span>Collection and chunk-level context can be set in the Database Browser and Chunk Visualizer respectively.</span>
                            </div>

                        </div>
                        </div>

                        <!-- World Info Settings Card -->
                        <div class="vectfox-card" data-vectfox-tab="worldinfo">
                            <div class="vectfox-card-header">
                                <h3 class="vectfox-card-title">
                                    <span class="vectfox-icon">
                                        <i class="fa-solid fa-globe"></i>
                                    </span>
                                    World Info settings
                                </h3>
                                <p class="vectfox-card-subtitle">Semantic World Info / Lorebook activation — uses vector similarity instead of keyword matching to decide which entries to inject. Operates on chunk-based lorebook collections.</p>
                            </div>
                            <div class="vectfox-card-body">
                                <label class="checkbox_label" for="VectFox_enabled_world_info">
                                    <input id="VectFox_enabled_world_info" type="checkbox" class="checkbox">
                                    <span>Enable Semantic WI Activation</span>
                                </label>
                                <small class="VectFox_hint">Activates lorebook entries based on meaning, not just keywords — so relevant lore shows up even when the exact words aren't mentioned.</small>
                                <div id="VectFox_wi_status" style="margin-top: 6px; font-size: 0.82em;"></div>

                                <div id="VectFox_world_info_settings" style="margin-top:10px; display:none;">
                                    <small style="display:block; margin-bottom:8px; opacity:0.85;">
                                        Activates World Info entries from <strong>vectorized lorebooks</strong> based on semantic similarity to recent chat messages. Complements keyword-based activation.
                                    </small>

                                    <div style="display:flex; gap:12px;">
                                        <div style="flex:1;">
                                            <label for="VectFox_world_info_threshold"><small>Score Threshold</small></label>
                                            <input id="VectFox_world_info_threshold" type="number" class="vectfox-input" min="0" max="1" step="0.01" />
                                        </div>
                                        <div style="flex:1;">
                                            <label for="VectFox_world_info_top_k"><small>Top-K per Lorebook</small></label>
                                            <input id="VectFox_world_info_top_k" type="number" class="vectfox-input" min="1" max="20" />
                                        </div>
                                        <div style="flex:1;">
                                            <label for="VectFox_world_info_query_depth"><small>Query Depth</small></label>
                                            <input id="VectFox_world_info_query_depth" type="number" class="vectfox-input" min="1" max="10" />
                                        </div>
                                    </div>

                                    <div style="margin-top:10px;">
                                        <label for="VectFox_wi_test_input"><small>Test Messages (one per line)</small></label>
                                        <textarea id="VectFox_wi_test_input" class="vectfox-textarea" rows="3" placeholder="Enter test messages, one per line..."></textarea>
                                        <div style="display:flex; gap:8px; margin-top:8px;">
                                            <button id="VectFox_wi_test_btn" class="vectfox-btn-secondary">Test Semantic WI</button>
                                            <button id="VectFox_wi_dump_registry" class="vectfox-btn-secondary">Dump Registry</button>
                                            <button id="VectFox_wi_apply_first" class="vectfox-btn-primary">Apply First Semantic Hit</button>
                                        </div>
                                    </div>

                                    <div style="margin-top:10px; display:flex; gap:12px; align-items:center;">
                                        <label class="checkbox_label" for="VectFox_enabled_for_all">
                                            <input id="VectFox_enabled_for_all" type="checkbox" />
                                            <span>Enabled for all entries</span>
                                        </label>
                                        <div style="flex:1"></div>
                                        <div style="width:160px;">
                                            <label for="VectFox_max_entries"><small>Max Entries</small></label>
                                            <input id="VectFox_max_entries" type="number" class="vectfox-input" min="1" max="9999" />
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <!-- Chat Auto-Sync Card -->
                    <div class="vectfox-card" data-vectfox-tab="autosync">
                        <div class="vectfox-card-header">
                            <h3 class="vectfox-card-title">
                                <span class="vectfox-icon">
                                    <i class="fa-solid fa-comments"></i>
                                </span>
                                Chat Auto-Sync
                            </h3>
                            <p class="vectfox-card-subtitle">Configure automatic synchronization between the active chat and its vector collection. Per-chat toggle, behavior on new messages, and conflict resolution.</p>
                        </div>
                        <div class="vectfox-card-body">

                            <label class="checkbox_label" for="VectFox_autosync_enabled">
                                <input type="checkbox" id="VectFox_autosync_enabled" />
                                <span>Enable Auto-Sync</span>
                            </label>
                            <small class="VectFox_hint">Auto-Sync new messages (requires initial vectorization)</small>
                            <div id="VectFox_autosync_status" style="margin-top: 6px; font-size: 0.82em;"></div>

                            <!-- Collection lock moved to Database Browser (per-collection settings) -->

                            <div class="vectfox-form-group" style="margin-top: 12px;">
                                <label class="checkbox_label" for="VectFox_autosync_popup">
                                    <input type="checkbox" id="VectFox_autosync_popup" />
                                    <span>Popup: show when auto-sync is extracting</span>
                                </label>
                                <small class="VectFox_hint">Show a notification toast each time auto-sync triggers a new EventBase extraction window.</small>
                            </div>

                            <small class="VectFox_hint" style="display:block; margin-top: 8px;">
                                Chat Auto-Sync follows the EventBase extraction settings. Legacy chat chunking controls are hidden because chat history no longer uses the old chunk-based retrieval path.
                            </small>

                        </div>
                    </div>

                    <!-- Actions Card -->
                    <div class="vectfox-card vectfox-tab-active" data-vectfox-tab="action">
                        <div class="vectfox-card-header">
                            <h3 class="vectfox-card-title">
                                <span class="vectfox-icon">
                                    <i class="fa-solid fa-bolt"></i>
                                </span>
                                Actions
                            </h3>
                            <p class="vectfox-card-subtitle">Run vectorization, sync chat with collections, browse the database, and run diagnostics. Operates on whatever path is currently active (Chunk or EventBase).</p>
                        </div>
                        <div class="vectfox-card-body">

                            <div class="vectfox-actions-grid">
                                <button id="VectFox_vectorize_content" class="vectfox-action-btn vectfox-btn-primary vectfox-action-featured">
                                    <i class="fa-solid fa-plus-circle"></i>
                                    <span>Vectorize Content</span>
                                </button>
                                <button id="VectFox_vectorize_all" class="vectfox-action-btn vectfox-btn-secondary">
                                    <i class="fa-solid fa-sync"></i>
                                    <span>Sync Chat</span>
                                </button>
                                <button id="VectFox_database_browser" class="vectfox-action-btn vectfox-btn-secondary">
                                    <i class="fa-solid fa-folder-open"></i>
                                    <span>Database Browser</span>
                                </button>
                                <button id="VectFox_run_diagnostics" class="vectfox-action-btn vectfox-btn-secondary">
                                    <i class="fa-solid fa-stethoscope"></i>
                                    <span>Diagnostics</span>
                                </button>
                                <button id="VectFox_view_results" class="vectfox-action-btn vectfox-btn-secondary">
                                    <i class="fa-solid fa-bug"></i>
                                    <span>Debug Query</span>
                                </button>
                                <button id="VectFox_purge" class="vectfox-action-btn vectfox-btn-danger-outline">
                                    <i class="fa-solid fa-trash"></i>
                                    <span>Purge</span>
                                </button>
                                <button id="VectFox_cleanup_corrupted" class="vectfox-action-btn vectfox-btn-danger-outline" title="Delete corrupted prefix-stacked collections and ST-native file_* attachments from disk. Irreversible.">
                                    <i class="fa-solid fa-broom"></i>
                                    <span>Cleanup Corrupted</span>
                                </button>
                                <button id="VectFox_text_cleaning" class="vectfox-action-btn vectfox-btn-secondary">
                                    <i class="fa-solid fa-broom"></i>
                                    <span>Text Cleaning</span>
                                </button>
                                <button id="VectFox_reopen_progress" class="vectfox-action-btn vectfox-btn-secondary">
                                    <i class="fa-solid fa-chart-line"></i>
                                    <span>Progress</span>
                                </button>
                                ${getHealthIndicatorHtml()}
                            </div>

                            <label class="checkbox_label" for="VectFox_injection_debug_logging" style="margin-top: 20px;">
                                <input type="checkbox" id="VectFox_injection_debug_logging" />
                                <span>Debug Injection Logging (Chunk Path)</span>
                            </label>
                            <small class="VectFox_hint">Log [VectFox Injection Control] details to the browser console (useful for diagnosing retrieval/injection issues)</small>

                            <label class="checkbox_label" for="VectFox_debug_vectorizing_log" style="margin-top: 12px;">
                                <input type="checkbox" id="VectFox_debug_vectorizing_log" />
                                <span>Debug Logging</span>
                            </label>
                            <small class="VectFox_hint">Log [EventBase] details and vectorization progress diagnostics (ProgressTracker + batch/parsing logs) to the browser console.</small>

                            <label class="checkbox_label" for="VectFox_eventbase_debug_qdrant_backend" style="margin-top: 12px;">
                                <input type="checkbox" id="VectFox_eventbase_debug_qdrant_backend" />
                                <span>Debug Qdrant backend</span>
                            </label>
                            <small class="VectFox_hint">Log native hybrid backend keyword/fusion diagnostics from the Similharity Qdrant backend. Turn this off when not actively debugging to avoid noisy console output.</small>

                            <label class="checkbox_label" for="VectFox_agentic_debug" style="margin-top: 12px;">
                                <input type="checkbox" id="VectFox_agentic_debug" />
                                <span>Debug Agent Mode</span>
                            </label>
                            <small class="VectFox_hint">Log [VectFox-Agentic] details: mode marker, narrative context preview (~50 words per turn), LLM round-trip ms, planner output JSON, Qdrant fanout ms, total agent overhead ms, per-query hit counts. Only fires when Agent Mode is enabled (AgentMode tab).</small>

                            <label class="checkbox_label" for="VectFox_eventbase_compare_rerank" style="margin-top: 12px;">
                                <input type="checkbox" id="VectFox_eventbase_compare_rerank" />
                                <span>Compare native vs JS re-rank (debug)</span>
                            </label>
                            <small class="VectFox_hint">Requires native re-rank ON and Debug Logging ON. Runs the JS pipeline in parallel for each (collection, queryText) and logs top-K overlap + Spearman ρ + timings. Doubles per-collection cost — debug only.</small>

                            <label class="checkbox_label" for="VectFox_eventbase_compare_rerank_verbose" style="margin-top: 12px;">
                                <input type="checkbox" id="VectFox_eventbase_compare_rerank_verbose" />
                                <span>Verbose compare logs (per-event breakdown)</span>
                            </label>
                            <small class="VectFox_hint">Adds per-event score-component breakdowns for events present in both top-K lists. Verbose — enable only when investigating a specific divergence.</small>

                        </div>
                    </div>

                    <!-- EventBase Card -->
                    <div class="vectfox-card" data-vectfox-tab="eventbase">
                        <div class="vectfox-card-header">
                            <h3 class="vectfox-card-title">
                                <span class="vectfox-icon"><i class="fa-solid fa-database"></i></span>
                                EventBase
                            </h3>
                            <p class="vectfox-card-subtitle">Settings on this tab apply to chat content: <b>Current Chat history</b> and <b>uploaded Archive Chat history (.jsonl)</b>. AI-extracted structured events are stored for semantic retrieval.</p>
                        </div>
                        <div class="vectfox-card-body">

                            <!-- Extraction settings -->
                            <p class="vectfox-section-label"><strong>Extraction</strong></p>

                            <div class="vectfox-form-group">
                                <label class="vectfox-label">Window Size <span id="VectFox_eventbase_window_size_val">2</span> messages</label>
                                <input type="range" id="VectFox_eventbase_window_size" min="2" max="20" step="1" class="vectfox-range" />
                                <small class="VectFox_hint">Number of consecutive messages sent to the AI per extraction call.</small>
                            </div>

                            <div class="vectfox-form-group">
                                <label class="vectfox-label">Window Overlap <span id="VectFox_eventbase_window_overlap_val">0</span></label>
                                <input type="range" id="VectFox_eventbase_window_overlap" min="0" max="5" step="1" class="vectfox-range" />
                                <small class="VectFox_hint">Messages shared between consecutive windows. Higher overlap re-extracts edge messages with more context (more LLM calls). 0 = no overlap, each message extracted once.</small>
                            </div>

                            <div class="vectfox-form-group">
                                <label class="vectfox-label">Min Importance to Store <span id="VectFox_eventbase_min_importance_store_val">3</span></label>
                                <input type="range" id="VectFox_eventbase_min_importance_store" min="1" max="10" step="1" class="vectfox-range" />
                                <small class="VectFox_hint">Events below this importance threshold are discarded before writing to Qdrant.</small>
                            </div>

                            <div class="vectfox-form-group">
                                <label class="vectfox-label">Max Events per Window <span id="VectFox_eventbase_max_events_per_window_val">3</span></label>
                                <input type="range" id="VectFox_eventbase_max_events_per_window" min="1" max="10" step="1" class="vectfox-range" />
                                <small class="VectFox_hint">Hard cap per LLM call. AI is instructed to return fewer (or zero) for filler / 日常 nichijou / non-narrative scenes.</small>
                            </div>

                            <div class="vectfox-form-group">
                                <label class="vectfox-label">Temperature</label>
                                <input type="number" id="VectFox_eventbase_temperature" class="vectfox-input" min="0" max="2" step="0.05" style="width:100px;" />
                            </div>

                            <div class="vectfox-form-group">
                                <label class="vectfox-label">Max Output Tokens</label>
                                <input type="number" id="VectFox_eventbase_max_tokens" class="vectfox-input" min="256" max="8192" step="64" style="width:120px;" />
                            </div>

                            <div class="vectfox-form-group">
                                <label class="vectfox-label">Timeout (ms)</label>
                                <input type="number" id="VectFox_eventbase_timeout_ms" class="vectfox-input" min="5000" max="300000" step="1000" style="width:130px;" />
                            </div>

                            <hr style="margin: 16px 0; opacity:0.2;" />

                            <!-- Retrieval settings -->
                            <p class="vectfox-section-label"><strong>Retrieval</strong></p>

                            <div class="vectfox-form-group">
                                <label class="vectfox-label">Retrieve Top-K <span id="VectFox_eventbase_retrieval_top_k_val">10</span></label>
                                <input type="range" id="VectFox_eventbase_retrieval_top_k" min="1" max="32" step="1" class="vectfox-range" />
                            </div>

                            <div class="vectfox-form-group">
                                <label class="vectfox-label">Min Importance for Retrieval <span id="VectFox_eventbase_retrieval_min_importance_val">1</span></label>
                                <input type="range" id="VectFox_eventbase_retrieval_min_importance" min="1" max="10" step="1" class="vectfox-range" />
                            </div>

                            <div class="vectfox-form-group">
                                <label class="vectfox-label">Injection Format</label>
                                <select id="VectFox_eventbase_injection_format" class="vectfox-select">
                                    <option value="jsonarray">JSONArray</option>
                                    <option value="densetext">DenseText</option>
                                    <option value="summaryonly">Summary Only</option>
                                </select>
                                <small class="VectFox_hint">JSONArray keeps full structured JSON. DenseText uses compact key/value blocks. Summary Only injects only summary + DateTime — minimum prompt footprint.</small>
                            </div>

                            <!-- Re-rank weights -->
                            <p style="margin: 12px 0 4px; font-size:0.85em; font-weight:600;">Re-rank Weights</p>
                            <small class="VectFox_hint">Weights are normalized to sum to 1.0 on save. Defaults are tuned for long-form SillyTavern RP.</small>

                            <div class="vectfox-rerank-weights" style="display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-top:8px;">
                                <div class="vectfox-form-group">
                                    <label class="vectfox-label">Cosine (semantic)</label>
                                    <input type="number" id="VectFox_eventbase_rerank_w_cosine" class="vectfox-input" min="0" max="1" step="0.05" style="width:80px;" />
                                </div>
                                <div class="vectfox-form-group">
                                    <label class="vectfox-label">Importance</label>
                                    <input type="number" id="VectFox_eventbase_rerank_w_importance" class="vectfox-input" min="0" max="1" step="0.05" style="width:80px;" />
                                </div>
                                <div class="vectfox-form-group">
                                    <label class="vectfox-label">Persist bonus</label>
                                    <input type="number" id="VectFox_eventbase_rerank_w_persist" class="vectfox-input" min="0" max="1" step="0.05" style="width:80px;" />
                                </div>
                                <div class="vectfox-form-group">
                                    <label class="vectfox-label">Recency decay</label>
                                    <input type="number" id="VectFox_eventbase_rerank_w_recency" class="vectfox-input" min="0" max="1" step="0.05" style="width:80px;" />
                                </div>
                            </div>
                            <button id="VectFox_eventbase_reset_weights" class="vectfox-btn vectfox-btn-secondary" style="margin-top:6px; font-size:0.8em;">Reset to defaults</button>

                            <hr style="margin: 16px 0; opacity:0.2;" />

                            <hr style="margin: 16px 0; opacity:0.2;" />

                            <!-- Extraction Prompt -->
                            <div class="vectfox-setting-row" style="flex-direction:column; align-items:flex-start; gap:6px;">
                                <label style="font-weight:600;">Extraction Prompt</label>
                                <small class="VectFox_hint">Full prompt sent to the LLM for each window. Use <code>{{text}}</code> where the excerpt goes and <code>{{maxCount}}</code> for the event cap. Leave empty to use the built-in default.</small>
                                <div style="display:flex; gap:6px; width:100%; margin-bottom:4px;">
                                    <button id="VectFox_eventbase_prompt_reset" class="vectfox-action-btn vectfox-btn-secondary" style="font-size:11px; padding:3px 10px;">Reset to Default</button>
                                </div>
                                <textarea id="VectFox_eventbase_custom_prompt"
                                    class="vectfox-input"
                                    rows="12"
                                    style="width:100%; font-family:monospace; font-size:11px; resize:vertical;"
                                    placeholder="Leave empty to use the built-in default prompt…"></textarea>
                            </div>

                            <!-- Browser button -->
                            <div style="margin-top:20px;">
                                <button id="VectFox_eventbase_open_browser" class="vectfox-action-btn vectfox-btn-secondary">
                                    <i class="fa-solid fa-list"></i>
                                    <span>Open Event Browser</span>
                                </button>
                            </div>

                        </div>
                    </div>

                    <!-- AgentMode Card -->
                    <div class="vectfox-card" data-vectfox-tab="agentmode">
                        <div class="vectfox-card-header">
                            <h3 class="vectfox-card-title">
                                <span class="vectfox-icon"><i class="fa-solid fa-robot"></i></span>
                                AgentMode — Agentic Retrieval
                            </h3>
                            <p class="vectfox-card-subtitle">An optional LLM-planner step that runs between pre-search and re-rank. It reads recent chat context plus pre-search candidates, then fans out 1-4 follow-up queries in parallel against Qdrant. Purely additive — never replaces the normal flow.</p>
                        </div>
                        <div class="vectfox-card-body">

                            <!-- Master toggle -->
                            <div class="vectfox-form-group">
                                <label class="checkbox_label" for="VectFox_agentic_retrieval_enabled">
                                    <input id="VectFox_agentic_retrieval_enabled" type="checkbox" />
                                    <span><b>Enable AgentMode</b></span>
                                </label>
                                <small class="VectFox_hint" style="display:block; margin-top:6px;">
                                    Requires Qdrant backend (A3). Adds ~$0.0002 and ~300ms per turn. Always merged with normal search — never replaces it. Falls back gracefully on any failure.
                                </small>
                            </div>

                            <!-- LLM Provider (inheritance from summarizer) -->
                            <p class="vectfox-section-label" style="margin-top:16px;"><strong>LLM Provider</strong></p>
                            <small class="VectFox_hint" style="display:block; margin-bottom:8px;">
                                Leave any field blank to inherit from <b>Summarize Before Store</b> settings. Use a cheaper model here (e.g. <code>anthropic/claude-haiku-4-5</code>) to save cost.
                            </small>

                            <div class="vectfox-form-group">
                                <label for="VectFox_agentic_provider"><small>Provider</small></label>
                                <select id="VectFox_agentic_provider" class="vectfox-select">
                                    <option value="">(Inherit from summarizer)</option>
                                    <option value="openrouter">OpenRouter</option>
                                    <option value="vllm">vLLM</option>
                                </select>
                            </div>

                            <div class="vectfox-form-group">
                                <label for="VectFox_agentic_model"><small>Model</small></label>
                                <input type="text" id="VectFox_agentic_model" class="vectfox-input"
                                    placeholder="(empty → inherit summarizer model)" />
                                <small class="VectFox_hint">e.g. <code>anthropic/claude-haiku-4-5</code> for OpenRouter.</small>
                            </div>

                            <div class="vectfox-form-group" id="VectFox_agentic_openrouter_row">
                                <label for="VectFox_agentic_openrouter_apikey"><small>OpenRouter API Key</small></label>
                                <input type="password" id="VectFox_agentic_openrouter_apikey" class="vectfox-input"
                                    placeholder="(empty → inherit summarize key)" autocomplete="off" />
                            </div>

                            <div class="vectfox-form-group" id="VectFox_agentic_vllm_row" style="display:none;">
                                <label for="VectFox_agentic_vllm_url"><small>vLLM Base URL</small></label>
                                <input type="text" id="VectFox_agentic_vllm_url" class="vectfox-input"
                                    placeholder="(empty → inherit summarize URL)" />
                                <label for="VectFox_agentic_vllm_apikey" style="margin-top:8px;"><small>vLLM API Key</small></label>
                                <input type="password" id="VectFox_agentic_vllm_apikey" class="vectfox-input"
                                    placeholder="(empty → inherit summarize key)" autocomplete="off" />
                            </div>

                            <!-- Retrieval Tuning -->
                            <p class="vectfox-section-label" style="margin-top:16px;"><strong>Retrieval Tuning</strong></p>

                            <div class="vectfox-form-group">
                                <label class="vectfox-label">Past chat turns sent to planner: <span id="VectFox_agentic_chat_depth_val">3</span></label>
                                <input type="range" id="VectFox_agentic_chat_depth" min="1" max="10" step="1" class="vectfox-range" />
                                <small class="VectFox_hint">How many recent non-system chat turns are included as narrative context for the planner. Lower = faster + cheaper LLM call; higher = more story context for the planner to reason about.</small>
                            </div>

                            <div class="vectfox-form-group">
                                <label class="vectfox-label">Candidates shown to planner: <span id="VectFox_agentic_candidates_val">12</span></label>
                                <input type="range" id="VectFox_agentic_candidates" min="5" max="20" step="1" class="vectfox-range" />
                                <small class="VectFox_hint">How many top pre-search events the planner sees when deciding what extra queries to run.</small>
                            </div>

                            <div class="vectfox-form-group">
                                <label class="vectfox-label">Max planner queries: <span id="VectFox_agentic_max_queries_val">4</span></label>
                                <input type="range" id="VectFox_agentic_max_queries" min="1" max="4" step="1" class="vectfox-range" />
                                <small class="VectFox_hint">Hard ceiling on how many follow-up queries the planner can emit. Each query is one Qdrant call per live collection.</small>
                            </div>

                            <div class="vectfox-form-group">
                                <label for="VectFox_agentic_timeout"><small>Planner LLM Timeout (ms)</small></label>
                                <input type="number" id="VectFox_agentic_timeout" class="vectfox-input" min="1000" max="60000" step="1000" />
                                <small class="VectFox_hint">Hard timeout for the planner call. Default <b>30000 ms (30s)</b>. On timeout, agent mode falls back to pre-search only. Increase if your planner model is slow (large models / free-tier providers often take 10-20s on a 1500-token prompt).</small>
                            </div>

                            <!-- Apply planner filters (Phase 1.5) -->
                            <div class="vectfox-form-group">
                                <label class="checkbox_label" for="VectFox_agentic_filters_enabled">
                                    <input id="VectFox_agentic_filters_enabled" type="checkbox" />
                                    <span><b>Apply planner filters</b></span>
                                </label>
                                <small class="VectFox_hint" style="display:block; margin-top:6px;">
                                    When on, the planner's character / location / concept / importance filters narrow each Qdrant query. Turn off to run all queries without filters (useful for A/B comparison). Has no effect on the pre-search. Qdrant only.
                                </small>
                            </div>

                        </div>
                    </div>

                </div>
            </div>
        </div>

        <!-- Diagnostics Modal -->
        <div id="VectFox_diagnostics_modal" class="vectfox-modal" style="display: none;">
            <div class="vectfox-modal-overlay"></div>
            <div class="vectfox-modal-content vectfox-diagnostics-modal">
                <div class="vectfox-modal-header">
                    <h3>
                        <i class="fa-solid fa-stethoscope"></i>
                        <span id="VectFox_diagnostics_title">Run Diagnostics</span>
                    </h3>
                    <button class="vectfox-modal-close" id="VectFox_diagnostics_close">
                        <i class="fa-solid fa-times"></i>
                    </button>
                </div>
                <div class="vectfox-modal-body">
                    <!-- Phase 1: Category Selection -->
                    <div id="VectFox_diagnostics_selection" class="vectfox-diagnostics-phase">
                        <p class="vectfox-diagnostics-intro">Select which diagnostic categories to run:</p>

                        <div class="vectfox-diagnostics-categories">
                            <label class="vectfox-diagnostics-category-option">
                                <input type="checkbox" id="VectFox_diag_infrastructure" checked>
                                <div class="vectfox-diagnostics-category-card">
                                    <i class="fa-solid fa-server"></i>
                                    <div class="vectfox-diagnostics-category-info">
                                        <strong>Infrastructure</strong>
                                        <span>Backend connections, plugins, API endpoints</span>
                                    </div>
                                </div>
                            </label>

                            <label class="vectfox-diagnostics-category-option">
                                <input type="checkbox" id="VectFox_diag_configuration" checked>
                                <div class="vectfox-diagnostics-category-card">
                                    <i class="fa-solid fa-sliders"></i>
                                    <div class="vectfox-diagnostics-category-info">
                                        <strong>Configuration</strong>
                                        <span>Settings validation, chunk size, thresholds</span>
                                    </div>
                                </div>
                            </label>

                            <label class="vectfox-diagnostics-category-option">
                                <input type="checkbox" id="VectFox_diag_visualizer" checked>
                                <div class="vectfox-diagnostics-category-card">
                                    <i class="fa-solid fa-eye"></i>
                                    <div class="vectfox-diagnostics-category-info">
                                        <strong>Visualizer</strong>
                                        <span>Chunk editing, deletion, summary vectors</span>
                                    </div>
                                </div>
                            </label>

                            <label class="vectfox-diagnostics-category-option">
                                <input type="checkbox" id="VectFox_diag_production">
                                <div class="vectfox-diagnostics-category-card">
                                    <i class="fa-solid fa-vial"></i>
                                    <div class="vectfox-diagnostics-category-info">
                                        <strong>Production Tests</strong>
                                        <span>Live embedding, storage, retrieval tests</span>
                                    </div>
                                </div>
                            </label>
                        </div>

                        <div class="vectfox-diagnostics-actions">
                            <button class="vectfox-btn-secondary" id="VectFox_diag_cancel">Cancel</button>
                            <button class="vectfox-btn-primary" id="VectFox_diag_run">
                                <i class="fa-solid fa-play"></i> Run Diagnostics
                            </button>
                        </div>
                    </div>

                    <!-- Phase 2: Running -->
                    <div id="VectFox_diagnostics_running" class="vectfox-diagnostics-phase" style="display: none;">
                        <div class="vectfox-diagnostics-spinner">
                            <i class="fa-solid fa-spinner fa-spin"></i>
                            <span>Running diagnostics...</span>
                        </div>
                    </div>

                    <!-- Phase 3: Results -->
                    <div id="VectFox_diagnostics_results" class="vectfox-diagnostics-phase" style="display: none;">
                        <div id="VectFox_diagnostics_content"></div>
                        <div class="vectfox-diagnostics-footer">
                            <button class="vectfox-btn-secondary" id="VectFox_diag_back">
                                <i class="fa-solid fa-arrow-left"></i> Run Again
                            </button>
                            <button class="vectfox-btn-secondary" id="VectFox_diag_copy">
                                <i class="fa-solid fa-copy"></i> Copy Report
                            </button>
                            <button class="vectfox-btn-danger" id="VectFox_diag_fix_all" style="display: none;">
                                <i class="fa-solid fa-wand-magic-sparkles"></i> Fix All Issues
                            </button>
                            <button class="vectfox-btn-primary" id="VectFox_diag_done">Done</button>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <!-- Chunk Visualizer Modal -->
        <div id="VectFox_visualizer_modal" class="vectfox-modal" style="display: none;">
            <div class="vectfox-modal-overlay"></div>
            <div class="vectfox-modal-content vectfox-visualizer-content">
                <div class="vectfox-modal-header">
                    <h3>
                        <i class="fa-solid fa-cubes"></i>
                        Chunk Visualizer
                    </h3>
                    <button class="vectfox-modal-close" id="VectFox_visualizer_close">
                        <i class="fa-solid fa-times"></i>
                    </button>
                </div>
                <div class="vectfox-visualizer-toolbar">
                    <input type="text" id="VectFox_visualizer_search"
                           class="vectfox-visualizer-search"
                           placeholder="Search chunks by text, keywords, or name...">
                    <div class="vectfox-visualizer-stats">
                        <span id="VectFox_visualizer_count">0 chunks</span>
                        <span id="VectFox_visualizer_tiers"></span>
                    </div>
                </div>
                <div class="vectfox-modal-body">
                    <div id="VectFox_visualizer_content"></div>
                </div>
                <div class="vectfox-modal-footer">
                    <button class="vectfox-btn-secondary" id="VectFox_visualizer_done">Done</button>
                </div>
            </div>
        </div>

        ${getHealthModalHtml()}
    `;

    // Sanity debug: confirm the generated HTML contains the lock button marker
    try {
        console.log(`VectFox: renderSettings built HTML contains lock marker:`, String(html).indexOf('VectFox_lock_collection') >= 0);
        const target = document.getElementById(containerId);
        console.log(`VectFox: renderSettings target container exists:`, !!target, 'containerId=', containerId);
    } catch (e) {
        console.warn('VectFox: renderSettings pre-append debug failed', e);
    }

    $(`#${containerId}`).append(html);

    // Debug: log presence of lock button after rendering and observe for later appearance
    try {
        console.log(`VectFox: renderSettings appended to ${containerId}. lock button present:`, !!document.getElementById('VectFox_lock_collection'));
        if (!document.getElementById('VectFox_lock_collection')) {
            const containerEl = document.getElementById(containerId);
            if (containerEl && window.MutationObserver) {
                const mo = new MutationObserver((mutations, obs) => {
                    if (document.getElementById('VectFox_lock_collection')) {
                        console.log('VectFox: lock button appeared in DOM');
                        obs.disconnect();
                    }
                });
                mo.observe(containerEl, { childList: true, subtree: true });
            }
        }
    } catch (e) {
        console.warn('VectFox: debug check failed', e);
    }

    // Bind all events
    bindSettingsEvents(settings, callbacks);

    // Initialize collapsible cards
    initializeCollapsibleCards();

    // Initialize tab navigation
    initializeTabs();

    // Initialize modal
    initializeDiagnosticsModal();

    // Initialize health dashboard
    initializeHealthDashboard();

    console.log('VectFox UI: Settings rendered');
}

/**
 * Initializes diagnostics modal functionality
 */
function initializeDiagnosticsModal() {
    // Close button
    $('#VectFox_diagnostics_close').on('click', function() {
        closeDiagnosticsModal();
    });

    // Click overlay to close
    $('#VectFox_diagnostics_modal .vectfox-modal-overlay').on('click', function() {
        closeDiagnosticsModal();
    });

    // Stop mousedown propagation (ST closes drawers on mousedown/touchstart)
    // Note: This modal is inside the drawer so it doesn't strictly need this,
    // but we include it for consistency with other modals
    $('#VectFox_diagnostics_modal').on('mousedown touchstart', function(e) {
        e.stopPropagation();
    });

    // ESC key to close
    $(document).on('keydown', function(e) {
        if (e.key === 'Escape' && $('#VectFox_diagnostics_modal').is(':visible')) {
            closeDiagnosticsModal();
        }
    });

    // Cancel button
    $('#VectFox_diag_cancel').on('click', function() {
        closeDiagnosticsModal();
    });

    // Done button
    $('#VectFox_diag_done').on('click', function() {
        closeDiagnosticsModal();
    });

    // Back button - go back to selection
    $('#VectFox_diag_back').on('click', function() {
        showDiagnosticsPhase('selection');
        $('#VectFox_diagnostics_title').text('Run Diagnostics');
    });

    // Run button - execute diagnostics
    $('#VectFox_diag_run').on('click', async function() {
        await executeDiagnostics();
    });
}

/**
 * Closes the diagnostics modal and resets to selection phase
 */
function closeDiagnosticsModal() {
    $('#VectFox_diagnostics_modal').fadeOut(200, function() {
        // Reset to selection phase for next open
        showDiagnosticsPhase('selection');
        $('#VectFox_diagnostics_title').text('Run Diagnostics');
    });
}

/**
 * Shows a specific phase of the diagnostics modal
 * @param {string} phase - 'selection', 'running', or 'results'
 */
function showDiagnosticsPhase(phase) {
    $('#VectFox_diagnostics_selection').hide();
    $('#VectFox_diagnostics_running').hide();
    $('#VectFox_diagnostics_results').hide();
    $(`#VectFox_diagnostics_${phase}`).show();
}

// Console error capture for diagnostics
let capturedConsoleLogs = [];
let originalConsoleError = null;
let originalConsoleWarn = null;

/**
 * Starts capturing console errors and warnings
 */
function startConsoleCapture() {
    capturedConsoleLogs = [];

    // Store originals
    originalConsoleError = console.error;
    originalConsoleWarn = console.warn;

    // Override console.error
    console.error = function(...args) {
        capturedConsoleLogs.push({
            type: 'error',
            message: args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '),
            timestamp: new Date().toISOString(),
            stack: new Error().stack
        });
        originalConsoleError.apply(console, args);
    };

    // Override console.warn
    console.warn = function(...args) {
        capturedConsoleLogs.push({
            type: 'warning',
            message: args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '),
            timestamp: new Date().toISOString()
        });
        originalConsoleWarn.apply(console, args);
    };
}

/**
 * Stops capturing console errors and returns captured logs
 * @returns {Array} Captured console logs
 */
function stopConsoleCapture() {
    // Restore originals
    if (originalConsoleError) {
        console.error = originalConsoleError;
        originalConsoleError = null;
    }
    if (originalConsoleWarn) {
        console.warn = originalConsoleWarn;
        originalConsoleWarn = null;
    }

    return capturedConsoleLogs;
}

/**
 * Executes diagnostics based on selected categories
 */
async function executeDiagnostics() {
    const settings = extension_settings.vectfox;

    // Get selected categories
    const runInfrastructure = $('#VectFox_diag_infrastructure').prop('checked');
    const runConfiguration = $('#VectFox_diag_configuration').prop('checked');
    const runVisualizer = $('#VectFox_diag_visualizer').prop('checked');
    const runProduction = $('#VectFox_diag_production').prop('checked');

    if (!runInfrastructure && !runConfiguration && !runVisualizer && !runProduction) {
        toastr.warning('Please select at least one category to run');
        return;
    }

    // Show running phase
    showDiagnosticsPhase('running');
    $('#VectFox_diagnostics_title').text('Running Diagnostics...');

    // Start capturing console errors
    startConsoleCapture();

    try {
        // Import and run diagnostics
        const { runDiagnostics } = await import('../diagnostics/index.js');
        const results = await runDiagnostics(settings, runProduction);

        // Stop capturing and get logs
        const consoleLogs = stopConsoleCapture();

        // Filter results based on selected categories
        const filteredResults = {
            version: results.version,
            categories: {},
            checks: [],
            overall: results.overall,
            timestamp: results.timestamp,
            consoleErrors: consoleLogs
        };

        if (runInfrastructure && results.categories.infrastructure) {
            filteredResults.categories.infrastructure = results.categories.infrastructure;
            filteredResults.checks.push(...results.categories.infrastructure);
        }
        if (runConfiguration && results.categories.configuration) {
            filteredResults.categories.configuration = results.categories.configuration;
            filteredResults.checks.push(...results.categories.configuration);
        }
        if (runVisualizer && results.categories.visualizer) {
            filteredResults.categories.visualizer = results.categories.visualizer;
            filteredResults.checks.push(...results.categories.visualizer);
        }
        if (runProduction && results.categories.production) {
            filteredResults.categories.production = results.categories.production;
            filteredResults.checks.push(...results.categories.production);
        }

        // Add console errors as a category if any were captured
        if (consoleLogs.length > 0) {
            filteredResults.categories.console = consoleLogs.map(log => ({
                name: `Console ${log.type}`,
                status: log.type === 'error' ? 'fail' : 'warning',
                message: log.message.substring(0, 200) + (log.message.length > 200 ? '...' : ''),
                category: 'console'
            }));
            filteredResults.checks.push(...filteredResults.categories.console);
        }

        // Recalculate overall status based on filtered results
        const failCount = filteredResults.checks.filter(c => c.status === 'fail').length;
        const warnCount = filteredResults.checks.filter(c => c.status === 'warning').length;
        filteredResults.overall = failCount > 0 ? 'issues' : warnCount > 0 ? 'warnings' : 'healthy';

        // Show results
        showDiagnosticsResults(filteredResults);

    } catch (error) {
        stopConsoleCapture();
        console.error('VectFox Diagnostics error:', error);
        toastr.error('Failed to run diagnostics: ' + error.message);
        showDiagnosticsPhase('selection');
        $('#VectFox_diagnostics_title').text('Run Diagnostics');
    }
}

/**
 * Initializes collapsible functionality
 */
function initializeCollapsibleCards() {
    $('.vectfox-collapsible-header').on('click', function() {
        const content = $(this).next('.vectfox-collapsible-content');
        const icon = $(this).find('.vectfox-collapsible-icon');

        content.slideToggle(200);
        icon.toggleClass('rotated');
    });
}

    /**
     * Initializes two-row tab navigation for settings panels.
     * Each .vectfox-card[data-vectfox-tab] is a panel; only the active one is shown.
     */
    function initializeTabs() {
        $('#VectFox_settings').on('click', '.vectfox-tab-btn', function() {
            const tab = $(this).data('tab');
            // Update button active state
            $('.vectfox-tab-btn', '#VectFox_settings').removeClass('active');
            $(this).addClass('active');
            // Show only the matching tab panel
            $('[data-vectfox-tab]', '#VectFox_settings').removeClass('vectfox-tab-active');
            $(`[data-vectfox-tab="${tab}"]`, '#VectFox_settings').addClass('vectfox-tab-active');
            if (tab === 'worldinfo') refreshWIStatus();
        });
    }

// Use shared WebLLM provider singleton from providers/webllm.js
// This ensures the same engine instance is shared with core-vector-api.js
const getWebLlmProvider = getSharedWebLlmProvider;

/**
 * Checks if WebLLM is supported (browser + extension)
 * Shows user-friendly toast notifications with actionable guidance
 * @returns {boolean} True if WebLLM is available
 */
function isWebLlmSupported() {
    // Check 1: Browser supports WebGPU API
    if (!('gpu' in navigator)) {
        const warningKey = 'VectFox_webllm_browser_warning_shown';
        if (!sessionStorage.getItem(warningKey)) {
            toastr.error(
                'Your browser does not support the WebGPU API. Please use Chrome 113+, Edge 113+, or another WebGPU-compatible browser.',
                'WebLLM - Browser Not Supported',
                { preventDuplicates: true, timeOut: 0, extendedTimeOut: 0 }
            );
            sessionStorage.setItem(warningKey, '1');
        }
        return false;
    }

    // Check 2: WebLLM extension is installed
    if (!Object.hasOwn(SillyTavern, 'llm')) {
        const warningKey = 'VectFox_webllm_extension_warning_shown';
        if (!sessionStorage.getItem(warningKey)) {
            toastr.error(
                'WebLLM extension is not installed. Click here to install it.',
                'WebLLM - Extension Required',
                {
                    timeOut: 0,
                    extendedTimeOut: 0,
                    preventDuplicates: true,
                    onclick: () => openThirdPartyExtensionMenu('https://github.com/SillyTavern/Extension-WebLLM'),
                }
            );
            sessionStorage.setItem(warningKey, '1');
        }
        return false;
    }

    // Check 3: WebLLM extension supports embeddings
    if (typeof SillyTavern.llm.generateEmbedding !== 'function') {
        const warningKey = 'VectFox_webllm_update_warning_shown';
        if (!sessionStorage.getItem(warningKey)) {
            toastr.error(
                'Your WebLLM extension is outdated and does not support embeddings. Please update the extension.',
                'WebLLM - Update Required',
                { preventDuplicates: true, timeOut: 0, extendedTimeOut: 0 }
            );
            sessionStorage.setItem(warningKey, '1');
        }
        return false;
    }

    return true;
}

/**
 * Executes a function with WebLLM error handling
 * @param {Function} func - Function to execute
 * @returns {Promise<any>} Result of function or undefined on error
 */
async function executeWithWebLlmErrorHandling(func) {
    try {
        return await func();
    } catch (error) {
        console.error('VectFox: WebLLM operation failed', error);
        if (!(error instanceof Error)) {
            return;
        }
        switch (error.cause) {
            case 'webllm-not-available':
                toastr.error(
                    'WebLLM extension is not installed. Click here to install it.',
                    'WebLLM Error',
                    {
                        timeOut: 0,
                        extendedTimeOut: 0,
                        preventDuplicates: true,
                        onclick: () => openThirdPartyExtensionMenu('https://github.com/SillyTavern/Extension-WebLLM'),
                    }
                );
                break;
            case 'webllm-not-updated':
                toastr.error(
                    'Your WebLLM extension needs updating. It does not support embeddings.',
                    'WebLLM Update Required',
                    { timeOut: 0, extendedTimeOut: 0, preventDuplicates: true }
                );
                break;
            default:
                toastr.error(
                    `WebLLM error: ${error.message}`,
                    'WebLLM Error',
                    { preventDuplicates: true }
                );
        }
    }
}

/**
 * Loads available WebLLM models into the dropdown
 * @param {object} settings - VectFox settings object
 */
export async function loadWebLlmModels(settings) {
    return executeWithWebLlmErrorHandling(async () => {
        const provider = getWebLlmProvider();
        const models = provider.getModels();
        const $select = $('#VectFox_webllm_model');

        $select.empty();

        if (!models || models.length === 0) {
            $select.append($('<option>', { value: '', text: 'No embedding models available' }));
            return;
        }

        for (const model of models) {
            $select.append($('<option>', {
                value: model.id,
                text: model.toString ? model.toString() : model.id,
            }));
        }

        // Auto-select saved model or first available
        if (settings.webllm_model && models.some(m => m.id === settings.webllm_model)) {
            $select.val(settings.webllm_model);
        } else if (models.length > 0) {
            settings.webllm_model = models[0].id;
            $select.val(settings.webllm_model);
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        }
    });
}

/**
 * Updates the WebLLM status display based on availability
 * @returns {boolean} True if WebLLM is available
 */
/**
 * Refreshes the auto-sync checkbox state from current chat's collection
 * Call this when chat changes to keep UI in sync
 * @param {object} settings - VectFox settings object (unused, kept for API compatibility)
 */
export function refreshWIStatus() {
    const $status = $('#VectFox_wi_status');
    if (!$status.length) return;
    const registry = getCollectionRegistry();
    const lorebookIds = Array.isArray(registry)
        ? registry
            .map(key => parseRegistryKey(key).collectionId)
            .filter(id => id.startsWith('vf_lorebook_'))
        : [];
    if (lorebookIds.length === 0) {
        $status.html('<i class="fa-solid fa-circle-exclamation" style="color: var(--warning-color, #f39c12);"></i> No lorebooks vectorized — vectorize one first');
        return;
    }
    import('../core/collection-metadata.js').then(({ getCollectionMeta, isCollectionLockedToChat }) => {
        const chatId = getCurrentChatId();
        const lockedIds = chatId ? lorebookIds.filter(id => isCollectionLockedToChat(id, chatId)) : [];
        if (lockedIds.length === 0) {
            const names = lorebookIds.map(id => getCollectionMeta(id)?.sourceName || id);
            const nameList = names.map(n => `<span style="font-style:italic;">${n}</span>`).join(', ');
            $status.html(
                `<i class="fa-solid fa-circle-exclamation" style="color: var(--warning-color, #f39c12);"></i> ` +
                `Vectorized (${nameList}) but not locked to this chat — open Database Browser → Collection Settings to lock it`
            );
            return;
        }
        const names = lockedIds.map(id => getCollectionMeta(id)?.sourceName || id);
        const nameList = names.map(n => `<span style="font-style:italic;">${n}</span>`).join(', ');
        $status.html(
            `<i class="fa-solid fa-circle-check" style="color: var(--success-color, #27ae60);"></i> ` +
            `Active for this chat: ${nameList}`
        );
        // Auto-enable the feature when a lorebook is confirmed active for this chat
        const $wiCheckbox = $('#VectFox_enabled_world_info');
        if ($wiCheckbox.length && !$wiCheckbox.prop('checked')) {
            $wiCheckbox.prop('checked', true).trigger('change');
        }
    });
}

export function refreshAutoSyncCheckbox(settings) {
    const $checkbox = $('#VectFox_autosync_enabled');
    const $status = $('#VectFox_autosync_status');

    $checkbox.prop('checked', false);
    $status.html('<i class="fa-solid fa-spinner fa-spin" style="opacity:0.5;"></i> Checking...');

    doesChatHaveVectors(settings).then(async ({ hasVectors, allMatches }) => {
        if (!hasVectors) {
            $status.html('<i class="fa-solid fa-circle-exclamation" style="color: var(--warning-color, #f39c12);"></i> Not initialized — vectorize chat first');
            return;
        }

        const { isChatFullyVectorized } = await import('../core/eventbase-workflow.js');
        const { getChatUUID } = await import('../core/collection-ids.js');
        const messages = (getContext().chat || []).filter(m => m.mes && m.mes.trim().length > 0);
        const fullyVectorized = isChatFullyVectorized(messages, settings, getChatUUID());

        const totalChunks = allMatches.reduce((sum, m) => sum + (m.chunkCount || 0), 0);

        if (fullyVectorized) {
            $status.html(`<i class="fa-solid fa-circle-check" style="color: var(--success-color, #27ae60);"></i> Ready (${totalChunks} chunks)`);
            const { isCollectionAutoSyncEnabled } = await import('../core/collection-metadata.js');
            $checkbox.prop('checked', isCollectionAutoSyncEnabled(allMatches[0].collectionId));
        } else {
            $status.html(`<i class="fa-solid fa-circle-exclamation" style="color: var(--warning-color, #f39c12);"></i> Partially vectorized (${totalChunks} chunks) — finish vectorization first`);
        }
    }).catch(() => {
        $status.html('');
    });
}

export function updateWebLlmStatus() {
    const $status = $('#VectFox_webllm_status');
    const $installBtn = $('#VectFox_webllm_install');
    const $loadBtn = $('#VectFox_webllm_load');
    const $modelSelect = $('#VectFox_webllm_model');

    // Check browser support
    if (!('gpu' in navigator)) {
        $status.html('<i class="fa-solid fa-exclamation-triangle" style="color: var(--warning-color, #f39c12);"></i> Your browser does not support WebGPU. Use Chrome 113+ or Edge 113+.');
        $installBtn.hide();
        $loadBtn.prop('disabled', true);
        $modelSelect.prop('disabled', true);
        return false;
    }

    // Check extension installed
    if (!Object.hasOwn(SillyTavern, 'llm')) {
        $status.html('<i class="fa-solid fa-exclamation-circle" style="color: var(--error-color, #e74c3c);"></i> WebLLM extension not installed. Click "Install Extension" below.');
        $installBtn.show();
        $loadBtn.prop('disabled', true);
        $modelSelect.prop('disabled', true);
        return false;
    }

    // Check extension supports embeddings
    if (typeof SillyTavern.llm.generateEmbedding !== 'function') {
        $status.html('<i class="fa-solid fa-exclamation-triangle" style="color: var(--warning-color, #f39c12);"></i> WebLLM extension is outdated. Please update it to support embeddings.');
        $installBtn.show().find('i').removeClass('fa-puzzle-piece').addClass('fa-rotate');
        $installBtn.find('span, text').text(' Update Extension');
        $loadBtn.prop('disabled', true);
        $modelSelect.prop('disabled', true);
        return false;
    }

    // All good!
    $status.html('<i class="fa-solid fa-check-circle" style="color: var(--success-color, #2ecc71);"></i> WebLLM extension is installed and ready.');
    $installBtn.hide();
    $loadBtn.prop('disabled', false);
    $modelSelect.prop('disabled', false);
    return true;
}

/**
 * Toggles provider-specific settings visibility
 * @param {string} selectedProvider - Currently selected provider
 * @param {object} settings - VectFox settings object
 */
function toggleProviderSettings(selectedProvider, settings) {
    // Hide all provider-specific settings
    $('.VectFox_provider_setting').hide();

    // Show settings for selected provider
    $(`.VectFox_provider_setting`).each(function() {
        const providers = $(this).attr('data-provider').split(',');
        if (providers.includes(selectedProvider)) {
            $(this).show();
        }
    });

    // Handle WebLLM-specific initialization
    if (selectedProvider === 'webllm') {
        const isSupported = updateWebLlmStatus();
        if (isSupported) {
            loadWebLlmModels(settings);
        }
    }
}

/**
 * Shows a confirmation modal when enabling auto-sync on a chat with existing vectors
 * If multiple collections match, lets user pick which one to use
 * @param {Array} allMatches - Array of matching collections [{collectionId, registryKey, chunkCount, source, backend}]
 * @param {object} settings - VectFox settings for purge operations
 * @returns {Promise<{action: string, selectedCollection?: object}>} User's choice
 */
async function showAutoSyncConfirmModal(allMatches, settings) {
    // Import unified delete function for ghost cleanup
    const { deleteCollection } = await import('../core/collection-loader.js');

    return new Promise((resolve) => {
        const hasMultiple = allMatches.length > 1;
        const hasGhosts = allMatches.some(m => m.chunkCount === 0);

        // Build collection list HTML
        const collectionListHtml = allMatches.map((match, index) => {
            const displayId = match.collectionId.length > 35
                ? match.collectionId.substring(0, 18) + '...' + match.collectionId.substring(match.collectionId.length - 12)
                : match.collectionId;
            const isGhost = match.chunkCount === 0;
            const isRecommended = index === 0 && !isGhost;

            return `
                <div class="vectfox-collection-option ${isGhost ? 'ghost' : ''}" data-index="${index}" style="
                    background: var(--SmartThemeBlurTintColor);
                    padding: 12px;
                    border-radius: 8px;
                    margin-bottom: 10px;
                    cursor: pointer;
                    border: 2px solid ${isRecommended ? 'var(--SmartThemeQuoteColor)' : 'transparent'};
                    opacity: ${isGhost ? '0.6' : '1'};
                    position: relative;
                ">
                    ${isRecommended ? '<span style="position: absolute; top: -8px; right: 10px; background: var(--SmartThemeQuoteColor); color: var(--SmartThemeBodyColor); font-size: 0.7em; padding: 2px 6px; border-radius: 4px;">RECOMMENDED</span>' : ''}
                    ${isGhost ? '<span style="position: absolute; top: -8px; right: 10px; background: var(--SmartThemeFontColorOverrideWarning, #f0ad4e); color: #000; font-size: 0.7em; padding: 2px 6px; border-radius: 4px;">GHOST</span>' : ''}
                    <div style="display: flex; justify-content: space-between; align-items: start;">
                        <div style="flex: 1; min-width: 0;">
                            <div style="font-family: monospace; word-break: break-all; font-size: 0.85em; margin-bottom: 6px;">
                                ${displayId}
                            </div>
                            <div style="font-size: 0.8em; color: var(--SmartThemeQuoteColor);">
                                <i class="fa-solid fa-cube"></i> <strong>${match.chunkCount}</strong> chunks
                                ${match.source ? `<span style="margin-left: 10px;"><i class="fa-solid fa-database"></i> ${match.source}</span>` : ''}
                            </div>
                        </div>
                        ${isGhost ? `
                            <button class="menu_button menu_button_icon vectfox-delete-ghost" data-index="${index}" style="margin-left: 10px; color: var(--SmartThemeFontColorOverrideWarning, #f0ad4e);" title="Delete this ghost collection">
                                <i class="fa-solid fa-trash"></i>
                            </button>
                        ` : ''}
                    </div>
                </div>
            `;
        }).join('');

        const modalHtml = `
            <div id="VectFox_autosync_confirm_modal" class="vectfox-modal" style="display: flex;">
                <div class="vectfox-modal-content" style="max-width: 500px;">
                    <div class="vectfox-modal-header">
                        <h3><i class="fa-solid fa-link"></i> ${hasMultiple ? 'Multiple Collections Found' : 'Existing Collection Found'}</h3>
                        <button class="vectfox-modal-close" data-action="cancel">
                            <i class="fa-solid fa-times"></i>
                        </button>
                    </div>
                    <div class="vectfox-modal-body" style="padding: 20px;">
                        <p style="margin-bottom: 15px;">
                            ${hasMultiple
                                ? `Found <strong>${allMatches.length}</strong> collections matching this chat.${hasGhosts ? ' <span style="color: var(--SmartThemeFontColorOverrideWarning, #f0ad4e);">Ghost collections (0 chunks) can be deleted.</span>' : ''}`
                                : 'This chat already has a vectorized collection:'}
                        </p>
                        <div style="max-height: 300px; overflow-y: auto; margin-bottom: 15px;">
                            ${collectionListHtml}
                        </div>
                        <p style="margin-bottom: 10px; font-size: 0.9em; color: var(--SmartThemeQuoteColor);">
                            ${hasMultiple ? 'Click a collection to select it, then choose an action.' : 'What would you like to do?'}
                        </p>
                    </div>
                    <div class="vectfox-modal-footer" style="display: flex; gap: 10px; padding: 15px 20px; border-top: 1px solid var(--SmartThemeBorderColor);">
                        <button class="menu_button" data-action="reconnect" style="flex: 1;">
                            <i class="fa-solid fa-plug"></i> Connect
                        </button>
                        <button class="menu_button" data-action="revectorize" style="flex: 1;">
                            <i class="fa-solid fa-rotate"></i> Re-vectorize
                        </button>
                        <button class="menu_button menu_button_icon" data-action="cancel">
                            <i class="fa-solid fa-times"></i>
                        </button>
                    </div>
                </div>
            </div>
        `;

        const $modal = $(modalHtml);
        $('body').append($modal);

        // Track selected collection (default to first/best)
        let selectedIndex = 0;
        $modal.find('.vectfox-collection-option').first().css('border-color', 'var(--SmartThemeQuoteColor)');

        // Handle collection selection
        $modal.find('.vectfox-collection-option').on('click', function(e) {
            if ($(e.target).closest('.vectfox-delete-ghost').length) return; // Don't select when clicking delete

            selectedIndex = parseInt($(this).data('index'));
            $modal.find('.vectfox-collection-option').css('border-color', 'transparent');
            $(this).css('border-color', 'var(--SmartThemeQuoteColor)');
        });

        // Handle ghost deletion - uses unified deleteCollection()
        $modal.find('.vectfox-delete-ghost').on('click', async function(e) {
            e.stopPropagation();
            const index = parseInt($(this).data('index'));
            const ghost = allMatches[index];

            if (!confirm(`Delete ghost collection?\n\n${ghost.collectionId}\n\nThis will remove it from disk.`)) return;

            try {
                // Use unified delete function - handles vectors, registry, AND metadata
                const deleteSettings = {
                    ...settings,
                    source: ghost.source || settings.source,
                };
                const result = await deleteCollection(ghost.collectionId, deleteSettings, ghost.registryKey);

                // Remove from UI
                allMatches.splice(index, 1);
                $(this).closest('.vectfox-collection-option').fadeOut(200, function() {
                    $(this).remove();
                    // Re-index remaining items
                    $modal.find('.vectfox-collection-option').each((i, el) => {
                        $(el).attr('data-index', i);
                        $(el).find('.vectfox-delete-ghost').attr('data-index', i);
                    });
                });

                if (result.success) {
                    toastr.success('Ghost collection deleted', 'VectFox');
                } else {
                    toastr.warning(`Partial deletion: ${result.errors.join(', ')}`, 'VectFox');
                }

                // If no collections left, close modal
                if (allMatches.length === 0) {
                    $modal.remove();
                    resolve({ action: 'revectorize' });
                } else if (selectedIndex >= allMatches.length) {
                    selectedIndex = 0;
                    $modal.find('.vectfox-collection-option').first().css('border-color', 'var(--SmartThemeQuoteColor)');
                }
            } catch (error) {
                console.error('VectFox: Failed to delete ghost', error);
                toastr.error('Failed to delete ghost collection', 'VectFox');
            }
        });

        // Handle action buttons
        $modal.find('[data-action]').on('click', function() {
            const action = $(this).data('action');
            $modal.remove();
            resolve({
                action,
                selectedCollection: action === 'reconnect' ? allMatches[selectedIndex] : null
            });
        });

        // Stop mousedown propagation (ST closes drawers on mousedown/touchstart)
        $modal.on('mousedown touchstart', function(e) {
            e.stopPropagation();
        });

        // Close on background click
        $modal.on('click', function(e) {
            if (e.target === this) {
                $modal.remove();
                resolve({ action: 'cancel' });
            }
        });

        // Handle escape key
        $(document).one('keydown.autosync_modal', function(e) {
            if (e.key === 'Escape') {
                $modal.remove();
                resolve({ action: 'cancel' });
            }
        });
    });
}

/**
 * Binds event handlers to UI elements
 * @param {object} settings - VectFox settings object
 * @param {object} callbacks - Callback functions
 */
function bindSettingsEvents(settings, callbacks) {
    // Auto-sync enable/disable - now per-collection instead of global
    // Initial state is set by refreshAutoSyncCheckbox() after chat loads
    $('#VectFox_autosync_enabled')
        .on('input', async function() {
            const enabling = $(this).prop('checked');
            const $checkbox = $(this);

            const chatId = getCurrentChatId();
            if (!chatId) {
                // No chat open - warn and don't enable
                toastr.warning('Open a chat first before enabling auto-sync');
                $checkbox.prop('checked', false);
                return;
            }

            // Import the metadata functions
            const { setCollectionAutoSync } = await import('../core/collection-metadata.js');

            let resolvedCollectionId = null;

            if (enabling) {
                const { hasVectors, allMatches } = await doesChatHaveVectors(settings);

                if (!hasVectors) {
                    $checkbox.prop('checked', false);
                    toastr.info('Vectorize your chat history first');
                    openContentVectorizer('chat');
                    return;
                }

                // Check that all messages are already vectorized before allowing auto-sync
                const { isChatFullyVectorized } = await import('../core/eventbase-workflow.js');
                const { getChatUUID } = await import('../core/collection-ids.js');
                const messages = (getContext().chat || []).filter(m => m.mes && m.mes.trim().length > 0);
                const fullyVectorized = isChatFullyVectorized(messages, settings, getChatUUID());

                if (!fullyVectorized) {
                    $checkbox.prop('checked', false);
                    toastr.info('Finish vectorizing your full chat history first, then enable auto-sync');
                    openContentVectorizer('chat');
                    return;
                }

                // All messages vectorized — connect to collection
                if (allMatches.length === 1) {
                    // Single collection: auto-connect without a modal
                    resolvedCollectionId = allMatches[0].collectionId;
                    console.log(`VectFox: Auto-sync enabled - connected to ${resolvedCollectionId} (${allMatches[0].chunkCount} chunks)`);
                } else {
                    // Multiple collections: let user pick
                    const result = await showAutoSyncConfirmModal(allMatches, settings);

                    if (result.action === 'cancel') {
                        $checkbox.prop('checked', false);
                        return;
                    }

                    if (result.action === 'reconnect' && result.selectedCollection) {
                        const selected = result.selectedCollection;
                        resolvedCollectionId = selected.collectionId;
                        console.log(`VectFox: Auto-sync enabled - connected to ${selected.collectionId} (${selected.chunkCount} chunks)`);
                    } else if (result.action === 'revectorize') {
                        $checkbox.prop('checked', false);
                        openContentVectorizer('chat');
                        return;
                    }
                }
            } else {
                // Disabling - find the current collection to clear its auto-sync flag
                const { hasVectors, allMatches } = await doesChatHaveVectors(settings);
                if (hasVectors && allMatches.length > 0) {
                    resolvedCollectionId = allMatches[0].collectionId;
                }
            }

            // Save to per-collection metadata
            setCollectionAutoSync(resolvedCollectionId, enabling);

            if (!enabling) {
                toastr.info('Auto-sync disabled for this chat');
            } else {
                toastr.success('Auto-sync enabled for this chat');
            }
            console.log(`VectFox: Chat auto-sync for ${resolvedCollectionId}: ${enabling ? 'enabled' : 'disabled'}`);
        });

        // Collection lock handled inside Database Browser per-collection settings

    // LEGACY CHAT CHUNKING STRATEGIES NOTE:
    // *** will be remove in future version because no longer used by eventbased path ***
    // The old chat chunking strategy selector and related batch/group-batch sliders were
    // removed from the GUI because chat auto-sync now follows EventBase extraction settings.
    // Keep the underlying settings fields for backward compatibility / migration only.

    // Summarization provider
    const updateSummarizeUI = (provider) => {
        $('#VectFox_summarize_settings').show();
        $('#VectFox_summarize_openrouter_row').toggle(provider === 'openrouter');
        $('#VectFox_summarize_vllm_url_row').toggle(provider === 'vllm');
    };
    $('#VectFox_summarize_provider')
        .val(settings.summarize_provider || 'openrouter')
        .on('change', function() {
            settings.summarize_provider = String($(this).val());
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
            updateSummarizeUI(settings.summarize_provider);
        });
    updateSummarizeUI(settings.summarize_provider || 'openrouter');

    $('#VectFox_summarize_model')
        .val(settings.summarize_model || '')
        .on('input change', function() {
            // Bind 'input' too — 'change' alone only fires on blur, so clicking Vectorize
            // immediately after typing would skip the save.
            settings.summarize_model = String($(this).val()).trim();
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    // "Choose" button — fetches model list from the configured provider and populates a dropdown
    $('#VectFox_summarize_model_choose').on('click', async function() {
        const $btn = $(this);
        const $list = $('#VectFox_summarize_model_list');
        const $input = $('#VectFox_summarize_model');
        const provider = settings.summarize_provider || 'openrouter';

        const originalHtml = $btn.html();
        $btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i> Loading…');

        try {
            let models = [];

            if (provider === 'openrouter') {
                // OpenRouter /models is a public endpoint — no auth required for listing
                const resp = await fetch('https://openrouter.ai/api/v1/models', { method: 'GET' });
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const data = await resp.json();
                models = (data?.data || []).map(m => ({ id: m.id, label: m.name ? `${m.id} — ${m.name}` : m.id }));
            } else if (provider === 'vllm') {
                const baseUrl = (settings.summarize_vllm_url || '').replace(/\/$/, '').replace(/\/v1$/, '');
                if (!baseUrl) {
                    toastr.error('Set the vLLM Base URL first.', 'vLLM not configured');
                    return;
                }
                const headers = {};
                const apiKey = settings.summarize_vllm_api_key;
                if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
                const resp = await fetch(`${baseUrl}/v1/models`, { method: 'GET', headers });
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const data = await resp.json();
                models = (data?.data || []).map(m => ({ id: m.id, label: m.id }));
            } else {
                toastr.warning(`Choose is not supported for provider "${provider}".`);
                return;
            }

            if (!models.length) {
                toastr.warning('Provider returned no models.');
                return;
            }

            models.sort((a, b) => a.id.localeCompare(b.id));

            const currentValue = String($input.val() || '').trim();
            const options = ['<option value="">— Select a model —</option>']
                .concat(models.map(m => {
                    const selected = m.id === currentValue ? ' selected' : '';
                    return `<option value="${$('<div>').text(m.id).html()}"${selected}>${$('<div>').text(m.label).html()}</option>`;
                }));

            $list.html(options.join('')).show();
            toastr.success(`Loaded ${models.length} models from ${provider}.`);
        } catch (err) {
            console.error('[VectFox] Model list fetch failed:', err);
            toastr.error(`Could not fetch model list: ${err?.message || err}`);
        } finally {
            $btn.prop('disabled', false).html(originalHtml);
        }
    });

    $('#VectFox_summarize_model_list').on('change', function() {
        const value = String($(this).val() || '').trim();
        if (!value) return;
        $('#VectFox_summarize_model').val(value).trigger('change');
        $(this).hide();
    });

    $('#VectFox_summarize_vllm_url')
        .val(settings.summarize_vllm_url || '')
        .on('change', function() {
            settings.summarize_vllm_url = String($(this).val()).trim();
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    // vLLM summarization API key — stored directly in extension settings (same as bananabread pattern)
    const updateSummarizeVllmKeyDisplay = () => {
        const savedKey = settings.summarize_vllm_api_key;
        if (savedKey) {
            const masked = savedKey.length > 4
                ? '*'.repeat(Math.min(savedKey.length - 4, 8)) + savedKey.slice(-4)
                : '*'.repeat(savedKey.length);
            $('#VectFox_summarize_vllm_apikey').attr('placeholder', `Key saved: ${masked}`);
        } else {
            $('#VectFox_summarize_vllm_apikey').attr('placeholder', 'Paste key here to save...');
        }
    };
    updateSummarizeVllmKeyDisplay();
    $('#VectFox_summarize_vllm_apikey').on('change', function() {
        const value = String($(this).val()).trim();
        if (value) {
            settings.summarize_vllm_api_key = value;
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
            toastr.success('vLLM summarization API key saved');
            $(this).val('');
            updateSummarizeVllmKeyDisplay();
        }
    });

    // OpenRouter summarization API key — stored directly in extension settings
    const updateSummarizeORKeyDisplay = () => {
        const savedKey = settings.summarize_openrouter_api_key;
        if (savedKey) {
            const masked = savedKey.length > 4
                ? '*'.repeat(Math.min(savedKey.length - 4, 8)) + savedKey.slice(-4)
                : '*'.repeat(savedKey.length);
            $('#VectFox_summarize_openrouter_apikey').attr('placeholder', `Key saved: ${masked}`);
        } else {
            $('#VectFox_summarize_openrouter_apikey').attr('placeholder', 'Paste key here to save...');
        }
    };
    updateSummarizeORKeyDisplay();
    $('#VectFox_summarize_openrouter_apikey').on('change', function() {
        const value = String($(this).val()).trim();
        if (value) {
            settings.summarize_openrouter_api_key = value;
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
            toastr.success('OpenRouter summarization API key saved');
            $(this).val('');
            updateSummarizeORKeyDisplay();
        }
    });

    // ─── AgentMode (Agentic Retrieval) ─────────────────────────────────────
    // Toggle provider-specific rows in the AgentMode tab. Treats empty provider
    // as "inherit from summarizer" — both row blocks hide in that case so the
    // user is reminded inheritance is in effect.
    const updateAgenticUI = (provider) => {
        const resolved = String(provider || '').trim();
        $('#VectFox_agentic_openrouter_row').toggle(resolved === 'openrouter');
        $('#VectFox_agentic_vllm_row').toggle(resolved === 'vllm');
    };

    $('#VectFox_agentic_retrieval_enabled')
        .prop('checked', !!settings.agentic_retrieval_enabled)
        .on('change', function() {
            settings.agentic_retrieval_enabled = $(this).prop('checked');
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    $('#VectFox_agentic_provider')
        .val(settings.agentic_retrieval_provider || '')
        .on('change', function() {
            settings.agentic_retrieval_provider = String($(this).val());
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
            updateAgenticUI(settings.agentic_retrieval_provider);
        });
    updateAgenticUI(settings.agentic_retrieval_provider || '');

    $('#VectFox_agentic_model')
        .val(settings.agentic_retrieval_model || '')
        .on('input change', function() {
            settings.agentic_retrieval_model = String($(this).val()).trim();
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    // AgentMode OpenRouter API key — same masked-paste pattern as summarize key
    const updateAgenticORKeyDisplay = () => {
        const savedKey = settings.agentic_retrieval_openrouter_api_key;
        if (savedKey) {
            const masked = savedKey.length > 4
                ? '*'.repeat(Math.min(savedKey.length - 4, 8)) + savedKey.slice(-4)
                : '*'.repeat(savedKey.length);
            $('#VectFox_agentic_openrouter_apikey').attr('placeholder', `Key saved: ${masked}`);
        } else {
            $('#VectFox_agentic_openrouter_apikey').attr('placeholder', '(empty → inherit summarize key)');
        }
    };
    updateAgenticORKeyDisplay();
    $('#VectFox_agentic_openrouter_apikey').on('change', function() {
        const value = String($(this).val()).trim();
        if (value) {
            settings.agentic_retrieval_openrouter_api_key = value;
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
            toastr.success('AgentMode OpenRouter key saved');
            $(this).val('');
            updateAgenticORKeyDisplay();
        }
    });

    $('#VectFox_agentic_vllm_url')
        .val(settings.agentic_retrieval_vllm_url || '')
        .on('change', function() {
            settings.agentic_retrieval_vllm_url = String($(this).val()).trim();
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    const updateAgenticVllmKeyDisplay = () => {
        const savedKey = settings.agentic_retrieval_vllm_api_key;
        if (savedKey) {
            const masked = savedKey.length > 4
                ? '*'.repeat(Math.min(savedKey.length - 4, 8)) + savedKey.slice(-4)
                : '*'.repeat(savedKey.length);
            $('#VectFox_agentic_vllm_apikey').attr('placeholder', `Key saved: ${masked}`);
        } else {
            $('#VectFox_agentic_vllm_apikey').attr('placeholder', '(empty → inherit summarize key)');
        }
    };
    updateAgenticVllmKeyDisplay();
    $('#VectFox_agentic_vllm_apikey').on('change', function() {
        const value = String($(this).val()).trim();
        if (value) {
            settings.agentic_retrieval_vllm_api_key = value;
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
            toastr.success('AgentMode vLLM key saved');
            $(this).val('');
            updateAgenticVllmKeyDisplay();
        }
    });

    // Sliders — chat depth, candidates, max queries
    const bindAgenticSlider = (inputId, valSpanId, settingKey, defaultVal) => {
        const startVal = Number(settings[settingKey] ?? defaultVal);
        $(inputId).val(startVal);
        $(valSpanId).text(startVal);
        $(inputId).on('input', function() {
            const v = Number($(this).val());
            settings[settingKey] = v;
            $(valSpanId).text(v);
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });
    };
    bindAgenticSlider('#VectFox_agentic_chat_depth', '#VectFox_agentic_chat_depth_val', 'agentic_retrieval_chat_depth', 3);
    bindAgenticSlider('#VectFox_agentic_candidates', '#VectFox_agentic_candidates_val', 'agentic_retrieval_candidates_to_show', 12);
    bindAgenticSlider('#VectFox_agentic_max_queries', '#VectFox_agentic_max_queries_val', 'agentic_retrieval_max_queries', 4);

    $('#VectFox_agentic_timeout')
        .val(Number(settings.agentic_retrieval_timeout_ms ?? 30000))
        .on('change input', function() {
            const v = Number($(this).val());
            settings.agentic_retrieval_timeout_ms = Math.max(1000, Math.min(60000, v || 30000));
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    $('#VectFox_agentic_debug')
        .prop('checked', !!settings.agentic_retrieval_debug_logging)
        .on('change', function() {
            settings.agentic_retrieval_debug_logging = $(this).prop('checked');
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    $('#VectFox_agentic_filters_enabled')
        .prop('checked', settings.agentic_filters_enabled !== false)
        .on('change', function() {
            settings.agentic_filters_enabled = $(this).prop('checked');
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    // Chunk size (for adaptive strategy)
    $('#VectFox_chunk_size')
        .val(settings.chunk_size || 500)
        .on('input', function() {
            const value = Number($(this).val());
            settings.chunk_size = value;
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    // Helper: update visibility of native-hybrid-dependent UI elements
    function updateNativeHybridUI() {
        const backend       = settings.vector_backend || 'standard';
        const method        = settings.keyword_scoring_method || 'bm25';
        const supportsNative = backend === 'qdrant';
        const preferNative  = settings.hybrid_native_prefer !== false;
        const nativeActive  = supportsNative && preferNative;        // A3
        const isHybridMode  = !nativeActive && method === 'hybrid';  // A2 (or Qdrant+prefer=false fallback)
        const isBM25Mode    = !nativeActive && method === 'bm25';    // A1

        // Keyword scoring method dropdown vs static "native active" notice
        $('#VectFox_keyword_method_section').toggle(!nativeActive);
        $('#VectFox_native_hybrid_info').toggle(nativeActive);

        // BM25 k1/b: visible whenever client-side BM25 logic runs (A1 or A2)
        $('#VectFox_bm25_params').toggle(!nativeActive);

        // Fusion Method + RRF K: visible only for A2 (Standard + Hybrid). A3 (Qdrant) ignores
        // these — Qdrant always runs server-side RRF with its own internal k constant — so the
        // controls would just confuse Qdrant users.
        $('#VectFox_hybrid_params').toggle(isHybridMode);

        // Query Keyword Budget (lives in ChunkBase tab): visible only in A1
        $('#VectFox_hybrid_keyword_budget_wrapper').toggle(isBM25Mode);
    }

    // Apply backend-specific hybrid defaults when backend changes or on first load.
    // Only rewrites settings that make sense for the new backend — does not touch user-tuned values
    // like rrf_k, vector/text weights, or BM25 k1/b.
    function applyBackendHybridDefaults(backend) {
        const isNative = backend === 'qdrant';
        if (isNative) {
            // Qdrant: prefer native hybrid, RRF fusion
            settings.hybrid_native_prefer = true;
            settings.hybrid_fusion_method = settings.hybrid_fusion_method || 'rrf';
        } else {
            // Standard: no native hybrid, BM25 fast re-rank, RRF fusion
            settings.hybrid_native_prefer = false;
            settings.keyword_scoring_method = settings.keyword_scoring_method || 'bm25';
            settings.hybrid_fusion_method = settings.hybrid_fusion_method || 'rrf';
        }
        // Sync UI controls
        $('#VectFox_keyword_scoring_method').val(settings.keyword_scoring_method || 'bm25');
        $('#VectFox_hybrid_fusion_method').val(settings.hybrid_fusion_method || 'rrf');
        Object.assign(extension_settings.vectfox, settings);
        saveSettingsDebounced();
    }

    // Vector backend selection
    $('#VectFox_vector_backend')
        .val(settings.vector_backend || 'qdrant')
        .on('change', function() {
            settings.vector_backend = String($(this).val());

            // Show/hide Qdrant settings
            if (settings.vector_backend === 'qdrant') {
                $('#VectFox_qdrant_settings').show();
            } else {
                $('#VectFox_qdrant_settings').hide();
            }

            applyBackendHybridDefaults(settings.vector_backend);
            updateNativeHybridUI();
            console.log(`VectFox: Vector backend changed to ${settings.vector_backend}`);
            // Reset health cache so new backend gets properly initialized
            resetBackendHealth();
        });

    // Qdrant cloud toggle
    $('#VectFox_qdrant_use_cloud')
        .prop('checked', settings.qdrant_use_cloud || false)
        .on('change', async function() {
            settings.qdrant_use_cloud = $(this).prop('checked');
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();

            // Toggle between local and cloud settings
            if (settings.qdrant_use_cloud) {
                $('#VectFox_qdrant_local_settings').hide();
                $('#VectFox_qdrant_cloud_settings').show();
            } else {
                $('#VectFox_qdrant_local_settings').show();
                $('#VectFox_qdrant_cloud_settings').hide();
            }

            // Reset backend health to force re-initialization with new config
            console.log('VectFox: Qdrant mode changed, forcing re-initialization...');
            resetBackendHealth('qdrant');

            // Proactively reinitialize if Qdrant is the current backend
            if (settings.vector_backend === 'qdrant') {
                try {
                    const { initializeBackend } = await import('../backends/backend-manager.js');
                    await initializeBackend('qdrant', settings, false);
                    toastr.success(
                        `Qdrant re-initialized in ${settings.qdrant_use_cloud ? 'cloud' : 'local'} mode`,
                        'VectFox'
                    );
                } catch (e) {
                    console.error('VectFox: Failed to reinitialize Qdrant:', e);
                    toastr.warning('Failed to reinitialize Qdrant: ' + e.message, 'VectFox');
                }
            }
        })
        .trigger('change');

    // Qdrant settings
    $('#VectFox_qdrant_host')
        .val(settings.qdrant_host || 'localhost')
        .on('input', function() {
            settings.qdrant_host = String($(this).val());
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    $('#VectFox_qdrant_port')
        .val(settings.qdrant_port || 6333)
        .on('input', function() {
            const value = parseInt($(this).val());
            settings.qdrant_port = isNaN(value) ? 6333 : value;
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    $('#VectFox_qdrant_url')
        .val(settings.qdrant_url || '')
        .on('input', function() {
            settings.qdrant_url = String($(this).val());
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    $('#VectFox_qdrant_api_key')
        .val(settings.qdrant_api_key || '')
        .on('input', function() {
            settings.qdrant_api_key = String($(this).val());
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    // Qdrant multitenancy toggle
    $('#VectFox_qdrant_multitenancy')
        .prop('checked', settings.qdrant_multitenancy || false)
        .on('change', function() {
            settings.qdrant_multitenancy = $(this).prop('checked');
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    // Show Qdrant settings if backend is qdrant
    if (settings.vector_backend === 'qdrant') {
        $('#VectFox_qdrant_settings').show();
    }

    // Embedding provider
    $('#VectFox_source')
        .val(settings.source)
        .on('change', function() {
            settings.source = String($(this).val());
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
            toggleProviderSettings(settings.source, settings);
            console.log(`VectFox: Embedding provider changed to ${settings.source}`);
            // Reset health cache since provider change may affect backend connectivity
            resetBackendHealth();
        });

    // Score threshold
    $('#VectFox_score_threshold')
        .val(settings.score_threshold)
        .on('input', function() {
            const value = parseFloat($(this).val());
            const safeValue = isNaN(value) ? 0.3 : value;
            $('#VectFox_threshold_value').text(safeValue.toFixed(2));
            settings.score_threshold = safeValue;
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });
    $('#VectFox_threshold_value').text(settings.score_threshold.toFixed(2));

    // "Skip Already-Visible Events" (legacy key name: deduplication_depth).
    // Default 0 = filter disabled. See settings comment in index.js — the assumption
    // that the LLM sees the last N messages in raw form is usually wrong (~3-6 in
    // practice), so this is opt-in only.
    $('#VectFox_deduplication_depth')
        .val(settings.deduplication_depth ?? 0)
        .on('input', function() {
            const value = parseInt($(this).val());
            const safeValue = isNaN(value) ? 0 : Math.max(0, value);
            $('#VectFox_deduplication_depth_value').text(safeValue);
            settings.deduplication_depth = safeValue;
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });
    $('#VectFox_deduplication_depth_value').text(settings.deduplication_depth ?? 0);

    // EventBase Dedup Window Gap — temporal proximity threshold for the
    // dedup gate in eventbase-retrieval.js. See settings comment in index.js.
    // 0 = temporal dedup fully disabled.
    $('#VectFox_eventbase_dedup_window_gap')
        .val(settings.eventbase_dedup_window_gap ?? 10)
        .on('input', function() {
            const value = parseInt($(this).val());
            const safeValue = isNaN(value) ? 10 : Math.max(0, Math.min(200, value));
            $('#VectFox_eventbase_dedup_window_gap_val').text(safeValue);
            settings.eventbase_dedup_window_gap = safeValue;
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });
    $('#VectFox_eventbase_dedup_window_gap_val').text(settings.eventbase_dedup_window_gap ?? 10);

    // EventBase Anchor Boost — flat additive bonus on keyword-anchored events.
    // See settings comment in index.js and the boost code in
    // eventbase-retrieval.js (around the `_finalScore` formula).
    $('#VectFox_eventbase_anchor_boost')
        .val(settings.eventbase_anchor_boost ?? 0.20)
        .on('input', function() {
            const value = parseFloat($(this).val());
            const safeValue = isNaN(value) ? 0.20 : Math.max(0, Math.min(0.5, value));
            $('#VectFox_eventbase_anchor_boost_val').text(safeValue.toFixed(2));
            settings.eventbase_anchor_boost = safeValue;
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });
    $('#VectFox_eventbase_anchor_boost_val').text(
        (typeof settings.eventbase_anchor_boost === 'number' ? settings.eventbase_anchor_boost : 0.20).toFixed(2)
    );

    // Keyword scoring method (bm25 = A1 fast re-rank; hybrid = A2 client-side hybrid fusion, ANN-bound ≤100)
    $('#VectFox_keyword_scoring_method')
        .val(settings.keyword_scoring_method || 'bm25')
        .on('change', function() {
            settings.keyword_scoring_method = String($(this).val());
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
            console.log(`VectFox: Keyword scoring method changed to ${settings.keyword_scoring_method}`);
            updateNativeHybridUI();
        });

    // Hybrid keyword level
    $('#VectFox_hybrid_keyword_level')
        .val(settings.hybrid_keyword_level || 'balance')
        .on('change', function() {
            settings.hybrid_keyword_level = String($(this).val());
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
            console.log(`VectFox: Hybrid keyword level changed to ${settings.hybrid_keyword_level}`);
        });

    // BM25 k1 parameter
    $('#VectFox_bm25_k1')
        .val(settings.bm25_k1 || 1.5)
        .on('input', function() {
            const value = parseFloat($(this).val());
            const safeValue = isNaN(value) ? 1.5 : value;
            $('#VectFox_bm25_k1_value').text(safeValue.toFixed(1));
            settings.bm25_k1 = safeValue;
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });
    $('#VectFox_bm25_k1_value').text((settings.bm25_k1 || 1.5).toFixed(1));

    // BM25 b parameter
    $('#VectFox_bm25_b')
        .val(settings.bm25_b || 0.75)
        .on('input', function() {
            const value = parseFloat($(this).val());
            const safeValue = isNaN(value) ? 0.75 : value;
            $('#VectFox_bm25_b_value').text(safeValue.toFixed(2));
            settings.bm25_b = safeValue;
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });
    $('#VectFox_bm25_b_value').text((settings.bm25_b || 0.75).toFixed(2));

    // ========== Hybrid Search Settings ==========

    // Fusion method selector
    $('#VectFox_hybrid_fusion_method')
        .val(settings.hybrid_fusion_method || 'rrf')
        .on('change', function() {
            settings.hybrid_fusion_method = String($(this).val());
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
            // Show weights only for weighted method, RRF settings for RRF
            const isWeighted = settings.hybrid_fusion_method === 'weighted';
            $('#VectFox_hybrid_weights').toggle(isWeighted);
            $('#VectFox_hybrid_rrf_settings').toggle(!isWeighted);
            console.log(`VectFox: Hybrid fusion method changed to ${settings.hybrid_fusion_method}`);
        });
    // Initialize visibility based on current method
    const isWeightedMethod = (settings.hybrid_fusion_method || 'rrf') === 'weighted';
    $('#VectFox_hybrid_weights').toggle(isWeightedMethod);
    $('#VectFox_hybrid_rrf_settings').toggle(!isWeightedMethod);

    // Vector weight slider
    $('#VectFox_hybrid_vector_weight')
        .val(settings.hybrid_vector_weight ?? 0.5)
        .on('input', function() {
            const value = parseFloat($(this).val());
            const safeValue = isNaN(value) ? 0.5 : value;
            $('#VectFox_hybrid_vector_weight_value').text(safeValue.toFixed(1));
            settings.hybrid_vector_weight = safeValue;
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });
    $('#VectFox_hybrid_vector_weight_value').text((settings.hybrid_vector_weight ?? 0.5).toFixed(1));

    // Text weight slider
    $('#VectFox_hybrid_text_weight')
        .val(settings.hybrid_text_weight ?? 0.5)
        .on('input', function() {
            const value = parseFloat($(this).val());
            const safeValue = isNaN(value) ? 0.5 : value;
            $('#VectFox_hybrid_text_weight_value').text(safeValue.toFixed(1));
            settings.hybrid_text_weight = safeValue;
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });
    $('#VectFox_hybrid_text_weight_value').text((settings.hybrid_text_weight ?? 0.5).toFixed(1));

    // RRF K constant slider
    $('#VectFox_hybrid_rrf_k')
        .val(settings.hybrid_rrf_k || 60)
        .on('input', function() {
            const value = parseInt($(this).val());
            const safeValue = isNaN(value) ? 60 : value;
            $('#VectFox_hybrid_rrf_k_value').text(safeValue);
            settings.hybrid_rrf_k = safeValue;
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });
    $('#VectFox_hybrid_rrf_k_value').text(settings.hybrid_rrf_k || 60);

    // Initialize native-hybrid-dependent visibility
    updateNativeHybridUI();

    // Query depth (how many recent messages to include in search query)
    $('#VectFox_query_depth')
        .val(settings.query || 2)
        .on('input', function() {
            const value = parseInt($(this).val());
            const safeValue = isNaN(value) ? 2 : value;
            $('#VectFox_query_depth_value').text(safeValue);
            settings.query = safeValue;
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });
    $('#VectFox_query_depth_value').text(settings.query || 2);

    // Top K - number of results retrieved per collection (top-K)
    $('#VectFox_topk')
        .val((settings.top_k ?? settings.insert) || 3)
        .on('input', function() {
            const value = parseInt($(this).val());
            const safeValue = isNaN(value) ? (settings.insert || 3) : value;
            settings.top_k = safeValue;
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    // Auto-sync popup toggle
    $('#VectFox_autosync_popup')
        .prop('checked', settings.eventbase_autosync_popup !== false)
        .on('change', function() {
            settings.eventbase_autosync_popup = $(this).prop('checked');
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    // Retrieval popups
    $('#VectFox_retrieval_popup_on_start')
        .prop('checked', settings.retrieval_popup_on_start || false)
        .on('change', function() {
            settings.retrieval_popup_on_start = $(this).prop('checked');
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    $('#VectFox_retrieval_popup_on_result')
        .prop('checked', settings.retrieval_popup_on_result || false)
        .on('change', function() {
            settings.retrieval_popup_on_result = $(this).prop('checked');
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    // World Info Integration settings
    $('#VectFox_enabled_world_info')
        .prop('checked', settings.enabled_world_info || false)
        .on('change', async function() {
            const enabled = $(this).prop('checked');
            const $checkbox = $(this);

            if (enabled) {
                // Check if any lorebook collections have been vectorized
                const registry = getCollectionRegistry();
                const hasLorebookVectors = Array.isArray(registry) && registry.some(key => parseRegistryKey(key).collectionId.startsWith('vf_lorebook_'));

                if (!hasLorebookVectors) {
                    $checkbox.prop('checked', false);
                    toastr.info('Vectorize a lorebook first to use Semantic WI Activation');
                    openContentVectorizer('lorebook');
                    return;
                }
            }

            settings.enabled_world_info = enabled;
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
            // Show/hide the detailed world info settings panel
            $('#VectFox_world_info_settings').toggle(enabled);
        });

    $('#VectFox_world_info_threshold')
        .val(settings.world_info_threshold ?? 0.3)
        .on('input', function() {
            const value = parseFloat($(this).val());
            const safeValue = isNaN(value) ? 0.3 : Math.max(0, Math.min(1, value));
            settings.world_info_threshold = safeValue;
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    $('#VectFox_world_info_top_k')
        .val(settings.world_info_top_k ?? 3)
        .on('input', function() {
            const value = parseInt($(this).val());
            const safeValue = isNaN(value) ? 3 : Math.max(1, Math.min(20, value));
            settings.world_info_top_k = safeValue;
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    $('#VectFox_world_info_query_depth')
        .val(settings.world_info_query_depth ?? 3)
        .on('input', function() {
            const value = parseInt($(this).val());
            const safeValue = isNaN(value) ? 3 : Math.max(1, Math.min(10, value));
            settings.world_info_query_depth = safeValue;
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    // Custom stopwords
    $('#VectFox_custom_stopwords')
        .val(settings.custom_stopwords || '')
        .on('input', function() {
            settings.custom_stopwords = $(this).val();
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    // CJK tokenizer mode selector
    $('#VectFox_cjk_tokenizer_mode')
        .val(settings.cjk_tokenizer_mode || CJK_TOKENIZER_MODES.intl)
        .on('change', async function() {
            const mode = String($(this).val());
            settings.cjk_tokenizer_mode = mode;
            setCjkTokenizerMode(mode);
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();

            if (mode === CJK_TOKENIZER_MODES.jieba) {
                const ok = await ensureJiebaTokenizerLoaded();
                if (!ok) {
                    toastr.warning('Simplified Chinese Jieba tokenizer failed to load. Falling back to Intl.Segmenter.', 'VectFox CJK');
                }
            }

            if (mode === CJK_TOKENIZER_MODES.jieba_tw) {
                toastr.info('Loading Traditional Chinese dictionary (~2–5 MB)...', 'VectFox CJK');
                const ok = await ensureJiebaTwLoaded();
                if (ok) {
                    toastr.success('Traditional Chinese Jieba tokenizer ready.', 'VectFox CJK');
                } else {
                    toastr.warning('Traditional Chinese Jieba tokenizer failed to load. Falling back to Intl.Segmenter.', 'VectFox CJK');
                }
            }
        });

    // Initialize world info settings visibility based on current setting
    $('#VectFox_world_info_settings').toggle(settings.enabled_world_info || false);
    refreshWIStatus();
    document.addEventListener('vectfox:collections-updated', refreshWIStatus);
    eventSource.on(event_types.CHAT_CHANGED, refreshWIStatus);

    // Debug buttons: Test semantic WI and dump registry
    $('#VectFox_wi_test_btn').on('click', async function() {
        try {
            const raw = $('#VectFox_wi_test_input').val() || '';
            const recentMessages = raw.split('\n').map(s => s.trim()).filter(Boolean);
            const activeEntries = [];
            const cfg = window.extension_settings?.VectFox || settings;

            console.log('VectFox: Running semantic WI test with messages:', recentMessages);

            // Primary: use initialized hooks if available
            if (window.VectFox_WorldInfo && typeof window.VectFox_WorldInfo.getSemanticEntries === 'function') {
                const entries = await window.VectFox_WorldInfo.getSemanticEntries(recentMessages, activeEntries, cfg);
                console.log('VectFox: Semantic WI test results (via window hooks):', entries);
                toastr.info(`Semantic WI test completed - ${entries.length} entries (see console)`);

                // If no entries found, provide extended diagnostics to help debug
                if (!entries || entries.length === 0) {
                    try {
                        console.log('VectFox: No semantic entries — dumping registry and per-collection query info...');
                        const registry = window.extension_settings?.VectFox?.VectFox_collection_registry || settings.VectFox_collection_registry || [];
                        console.log('VectFox: Collection registry:', registry);

                        const coreApi = await import('../core/core-vector-api.js');
                        const metaMod = await import('../core/collection-metadata.js');

                        for (const collKey of registry) {
                            try {
                                if (!collKey.includes('lorebook')) continue; // focus on lorebooks
                                const meta = metaMod.getCollectionMeta(collKey);
                                console.log(`VectFox: Collection meta for ${collKey}:`, meta);

                                // Check saved hashes (true=include metadata)
                                if (coreApi.getSavedHashes) {
                                    try {
                                        const saved = await coreApi.getSavedHashes(collKey, cfg, true);
                                        console.log(`VectFox: getSavedHashes for ${collKey}:`, saved && saved.hashes ? saved.hashes.length + ' hashes' : saved);
                                    } catch (hErr) {
                                        console.warn(`VectFox: getSavedHashes failed for ${collKey}:`, hErr.message);
                                    }
                                }

                                // Run a direct vector query against this collection
                                try {
                                    const qres = await coreApi.queryCollection(collKey, recentMessages.join('\n'), cfg.world_info_top_k || 3, cfg);
                                    console.log(`VectFox: queryCollection result for ${collKey}:`, qres);
                                } catch (qErr) {
                                    console.warn(`VectFox: queryCollection failed for ${collKey}:`, qErr.message);
                                }
                            } catch (inner) {
                                console.warn('VectFox: Error inspecting collection', collKey, inner.message);
                            }
                        }

                        toastr.info('Extended WI diagnostics written to console (registry + per-collection queries)');
                    } catch (diagErr) {
                        console.error('VectFox: Failed to run extended WI diagnostics', diagErr);
                        toastr.error('Failed to run WI diagnostics: ' + (diagErr.message || diagErr));
                    }
                }

                return;
            }

            // Fallback: try dynamic import of module (in case initialization order differed)
            try {
                const mod = await import('../core/world-info-integration.js');
                const fn = mod.getSemanticWorldInfoEntries || mod.getSemanticEntries || mod.default;
                if (!fn || typeof fn !== 'function') {
                    throw new Error('WorldInfo module does not export a usable function');
                }
                const entries = await fn(recentMessages, activeEntries, cfg);
                console.log('VectFox: Semantic WI test results (via dynamic import):', entries);
                toastr.info(`Semantic WI test completed - ${entries.length} entries (see console)`);
                return;
            } catch (impErr) {
                console.warn('VectFox: Dynamic import fallback failed:', impErr.message);
                toastr.error('VectFox: WorldInfo hooks not initialized and dynamic import failed: ' + impErr.message);
                return;
            }

        } catch (e) {
            console.error('VectFox: Semantic WI test failed', e);
            try { toastr.error('Semantic WI test failed: ' + (e.message || String(e))); } catch (_) {}
        }
    });

    $('#VectFox_wi_dump_registry').on('click', function() {
        try {
            const registry = window.extension_settings?.VectFox?.VectFox_collection_registry || settings.VectFox_collection_registry || [];
            console.log('VectFox: Collection registry dump:', registry);
            toastr.info(`Collection registry dumped to console (${registry.length} items)`);
        } catch (e) {
            console.error('VectFox: Failed to dump registry', e);
            toastr.error('Failed to dump registry: ' + e.message);
        }
    });

    // Apply first semantic hit to ST World Info (best-effort)
    $('#VectFox_wi_apply_first').on('click', async function() {
        try {
            const raw = $('#VectFox_wi_test_input').val() || '';
            const recentMessages = raw.split('\n').map(s => s.trim()).filter(Boolean);
            const cfg = window.extension_settings?.VectFox || settings;

            if (!window.VectFox_WorldInfo || !window.VectFox_WorldInfo.getSemanticEntries) {
                toastr.error('VectFox: WorldInfo hooks not initialized');
                return;
            }

            const entries = await window.VectFox_WorldInfo.getSemanticEntries(recentMessages, [], cfg);
            if (!entries || entries.length === 0) {
                toastr.info('No semantic entries found');
                return;
            }

            const first = entries[0];
            console.log('VectFox: Applying semantic WI entry:', first);

            // Best-effort: try importing ST's world-info module and invoking common APIs
            let applied = false;
            try {
                const worldInfo = await import('../../../../world-info.js');
                // Try common function names
                const candidates = ['applyWorldInfoEntries', 'activateEntries', 'setActiveEntries', 'activateWorldInfoEntries'];
                for (const name of candidates) {
                    if (worldInfo[name] && typeof worldInfo[name] === 'function') {
                        await worldInfo[name]([first]);
                        applied = true;
                        console.log(`VectFox: Applied via world-info.${name}`);
                        break;
                    }
                }
            } catch (e) {
                console.debug('VectFox: world-info import failed or method not found', e);
            }

            // Try global window API fallbacks
            if (!applied) {
                const fallbackCandidates = [
                    window.applyWorldInfoEntries,
                    window.activateWorldInfoEntries,
                    window.setActiveWorldInfoEntries
                ];
                for (const fn of fallbackCandidates) {
                    if (fn && typeof fn === 'function') {
                        try {
                            await fn([first]);
                            applied = true;
                            console.log('VectFox: Applied via global fallback function');
                            break;
                        } catch (e) {
                            console.debug('VectFox: fallback apply failed', e);
                        }
                    }
                }
            }

            if (applied) {
                toastr.success('Semantic WI entry applied (best-effort)');
                return;
            }

            // Final fallback: copy content to clipboard and instruct user
            const text = first.content || (Array.isArray(first.key) ? first.key.join(', ') : String(first.key));
            try {
                await navigator.clipboard.writeText(text);
                toastr.info('Semantic entry copied to clipboard. Paste into World Info editor to activate.');
            } catch (e) {
                console.log('VectFox: Clipboard write failed, showing content in console');
                console.log('Semantic entry content:', text);
                toastr.info('Semantic entry logged to console. Paste into World Info editor to activate.');
            }

        } catch (e) {
            console.error('VectFox: Apply semantic WI failed', e);
            toastr.error('Failed to apply semantic WI entry: ' + e.message);
        }
    });

    // Injection position (where chunks appear in prompt)
    $('#VectFox_injection_position')
        .val(settings.position ?? 0)
        .on('change', function() {
            const value = parseInt($(this).val());
            settings.position = value;
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
            // Show/hide depth slider based on position
            $('#VectFox_injection_depth_row').toggle(value === 1);
        });
    // Initialize depth row visibility
    $('#VectFox_injection_depth_row').toggle((settings.position ?? 0) === 1);

    // Injection depth (for in-chat position)
    $('#VectFox_injection_depth')
        .val(settings.depth ?? 2)
        .on('input', function() {
            const value = parseInt($(this).val());
            const safeValue = isNaN(value) ? 2 : value;
            $('#VectFox_injection_depth_value').text(safeValue);
            settings.depth = safeValue;
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });
    $('#VectFox_injection_depth_value').text(settings.depth ?? 2);

    // RAG Context settings
    $('#VectFox_rag_context')
        .val(settings.rag_context || '')
        .on('input', function() {
            settings.rag_context = $(this).val();
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    $('#VectFox_rag_xml_tag')
        .val(settings.rag_xml_tag || '')
        .on('input', function() {
            // Sanitize: only allow alphanumeric, underscore, hyphen
            const sanitized = $(this).val().replace(/[^a-zA-Z0-9_-]/g, '');
            $(this).val(sanitized);
            settings.rag_xml_tag = sanitized;
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    // Global temporal weighting defaults
    const updateDecayTypeSection = (enabled) => {
        const $section = $('#VectFox_default_decay_type_section');
        const $radios = $section.find('input[type="radio"]');

        if (enabled) {
            $section.removeClass('vectfox-subsection-disabled');
            $radios.prop('disabled', false);
            // Select the saved type (or default to 'decay') when enabling
            const savedType = settings.default_decay_type || 'decay';
            $(`input[name="VectFox_default_decay_type"][value="${savedType}"]`).prop('checked', true);
        } else {
            $section.addClass('vectfox-subsection-disabled');
            $radios.prop('disabled', true).prop('checked', false);
        }
    };

    $('#VectFox_default_decay_enabled')
        .prop('checked', settings.default_decay_enabled || false)
        .on('change', function() {
            const enabled = $(this).prop('checked');
            settings.default_decay_enabled = enabled;
            updateDecayTypeSection(enabled);
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    // Initialize the section state
    updateDecayTypeSection(settings.default_decay_enabled || false);

    $('input[name="VectFox_default_decay_type"]').on('change', function() {
        settings.default_decay_type = $(this).val();
        Object.assign(extension_settings.vectfox, settings);
        saveSettingsDebounced();
    });

    // Provider-specific settings

    // ElectronHub model
    $('#VectFox_electronhub_model')
        .val(settings.electronhub_model)
        .on('change', function() {
            settings.electronhub_model = String($(this).val());
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    // Ollama alternative endpoint
    $('#VectFox_ollama_use_alt_endpoint')
        .prop('checked', settings.ollama_use_alt_endpoint)
        .on('input', function() {
            settings.ollama_use_alt_endpoint = $(this).prop('checked');
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
            $('#VectFox_ollama_alt_endpoint_url').toggle(settings.ollama_use_alt_endpoint);
        });

    $('#VectFox_ollama_alt_endpoint_url')
        .val(settings.ollama_alt_endpoint_url)
        .toggle(settings.ollama_use_alt_endpoint)
        .on('input', function() {
            settings.ollama_alt_endpoint_url = String($(this).val());
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    // Ollama API key
    $('#VectFox_ollama_api_key')
        .val(settings.ollama_api_key ? '••••••••' : '')
        .attr('placeholder', settings.ollama_api_key ? '••••••••' : 'Leave blank for local deployments')
        .on('change', function() {
            const value = String($(this).val()).trim();
            if (value && value !== '••••••••') {
                settings.ollama_api_key = value;
                Object.assign(extension_settings.vectfox, settings);
                saveSettingsDebounced();
                $(this).val('••••••••').attr('placeholder', '••••••••');
                toastr.success('Ollama API key saved');
            }
        });

    // vLLM alternative endpoint
    $('#VectFox_vllm_use_alt_endpoint')
        .prop('checked', settings.vllm_use_alt_endpoint)
        .on('input', function() {
            settings.vllm_use_alt_endpoint = $(this).prop('checked');
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
            $('#VectFox_vllm_alt_endpoint_url').toggle(settings.vllm_use_alt_endpoint);
        });

    $('#VectFox_vllm_alt_endpoint_url')
        .val(settings.vllm_alt_endpoint_url)
        .toggle(settings.vllm_use_alt_endpoint)
        .on('input', function() {
            settings.vllm_alt_endpoint_url = String($(this).val());
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    // WebLLM model
    $('#VectFox_webllm_model')
        .val(settings.webllm_model)
        .on('change', function() {
            settings.webllm_model = String($(this).val());
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    // WebLLM Load Model button
    $('#VectFox_webllm_load').on('click', async function() {
        const modelId = settings.webllm_model;

        if (!modelId) {
            toastr.warning('Please select a WebLLM model first', 'No Model Selected');
            return;
        }

        if (!isWebLlmSupported()) {
            return; // isWebLlmSupported already shows appropriate error
        }

        const $button = $(this);
        const originalHtml = $button.html();
        $button.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i> Loading...');

        await executeWithWebLlmErrorHandling(async () => {
            const provider = getWebLlmProvider();
            await provider.loadModel(modelId);
            toastr.success(`WebLLM model "${modelId}" loaded successfully`, 'Model Loaded');
        });

        $button.prop('disabled', false).html(originalHtml);
    });

    // WebLLM Install Extension button
    $('#VectFox_webllm_install').on('click', function(e) {
        e.preventDefault();
        e.stopPropagation();

        if (Object.hasOwn(SillyTavern, 'llm')) {
            toastr.info('WebLLM extension is already installed. Try refreshing the page.', 'Already Installed');
            return;
        }

        openThirdPartyExtensionMenu('https://github.com/SillyTavern/Extension-WebLLM');
    });

    // Ollama model
    $('#VectFox_ollama_model')
        .val(settings.ollama_model)
        .on('input', function() {
            settings.ollama_model = String($(this).val());
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    $('#VectFox_ollama_keep')
        .prop('checked', settings.ollama_keep)
        .on('input', function() {
            settings.ollama_keep = $(this).prop('checked');
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    // BananaBread reranking
    $('#VectFox_bananabread_rerank')
        .prop('checked', settings.bananabread_rerank)
        .on('input', function() {
            settings.bananabread_rerank = $(this).prop('checked');
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    // Debug injection logging toggle
    $('#VectFox_injection_debug_logging')
        .prop('checked', settings.injection_debug_logging || false)
        .on('change', function() {
            settings.injection_debug_logging = $(this).prop('checked');
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    // Debug vectorizing log toggle
    $('#VectFox_debug_vectorizing_log')
        .prop('checked', (settings.debug_vectorizing_log || settings.eventbase_debug_logging) || false)
        .on('change', function() {
            const enabled = $(this).prop('checked');
            // Merged control: one checkbox drives both EventBase and vectorizing logs.
            settings.debug_vectorizing_log = enabled;
            settings.eventbase_debug_logging = enabled;
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    // EventBase native rerank toggle (A3 / Qdrant only).
    $('#VectFox_eventbase_native_rerank')
        .prop('checked', !!settings.eventbase_native_rerank)
        .on('change', function() {
            settings.eventbase_native_rerank = $(this).prop('checked');
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    // Compare-mode toggle (debug-only observability for native rerank).
    $('#VectFox_eventbase_compare_rerank')
        .prop('checked', !!settings.eventbase_compare_rerank)
        .on('change', function() {
            settings.eventbase_compare_rerank = $(this).prop('checked');
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    // Compare-mode verbose toggle.
    $('#VectFox_eventbase_compare_rerank_verbose')
        .prop('checked', !!settings.eventbase_compare_rerank_verbose)
        .on('change', function() {
            settings.eventbase_compare_rerank_verbose = $(this).prop('checked');
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    // ── EventBase settings ──────────────────────────────────────────────────

    // Helper: normalize re-rank weights to sum = 1.0
    const _normalizeRerankWeights = () => {
        const keys = ['rerank_w_cosine', 'rerank_w_importance', 'rerank_w_persist', 'rerank_w_recency'];
        const values = keys.map(k => parseFloat(settings[`eventbase_${k}`]) || 0);
        const total = values.reduce((a, b) => a + b, 0);
        if (total === 0) return;
        keys.forEach((k, i) => {
            settings[`eventbase_${k}`] = Math.round((values[i] / total) * 1000) / 1000;
            $(`#VectFox_eventbase_${k}`).val(settings[`eventbase_${k}`]);
        });
    };

    // Range inputs with live label update
    const _bindEventBaseRange = (id, settingKey, labelId) => {
        const $el = $(`#VectFox_eventbase_${id}`);
        $el.val(settings[settingKey] ?? $el.attr('min') ?? 0)
            .on('input', function() {
                const v = parseInt($(this).val(), 10);
                settings[settingKey] = v;
                if (labelId) $(`#VectFox_eventbase_${labelId}_val`).text(v);
                Object.assign(extension_settings.vectfox, settings);
                saveSettingsDebounced();
            });
        if (labelId) $(`#VectFox_eventbase_${labelId}_val`).text(settings[settingKey] ?? $el.val());
    };

    _bindEventBaseRange('window_size', 'eventbase_window_size', 'window_size');
    _bindEventBaseRange('window_overlap', 'eventbase_window_overlap', 'window_overlap');
    _bindEventBaseRange('min_importance_store', 'eventbase_min_importance_store', 'min_importance_store');
    _bindEventBaseRange('max_events_per_window', 'eventbase_max_events_per_window', 'max_events_per_window');
    _bindEventBaseRange('retrieval_top_k', 'eventbase_retrieval_top_k', 'retrieval_top_k');
    _bindEventBaseRange('retrieval_min_importance', 'eventbase_retrieval_min_importance', 'retrieval_min_importance');

    $('#VectFox_eventbase_injection_format')
        .val(settings.eventbase_injection_format || 'densetext')
        .on('change', function() {
            settings.eventbase_injection_format = String($(this).val() || 'densetext').toLowerCase();
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    // Number inputs (temperature, max_tokens, timeout_ms)
    const _bindEventBaseNumber = (id, settingKey) => {
        $(`#VectFox_eventbase_${id}`)
            .val(settings[settingKey] ?? '')
            .on('change', function() {
                const v = parseFloat($(this).val());
                if (!isNaN(v)) {
                    settings[settingKey] = v;
                    Object.assign(extension_settings.vectfox, settings);
                    saveSettingsDebounced();
                }
            });
    };

    _bindEventBaseNumber('temperature', 'eventbase_temperature');
    _bindEventBaseNumber('max_tokens', 'eventbase_max_tokens');
    _bindEventBaseNumber('timeout_ms', 'eventbase_timeout_ms');

    // Re-rank weight inputs
    ['rerank_w_cosine', 'rerank_w_importance', 'rerank_w_persist', 'rerank_w_recency'].forEach(k => {
        $(`#VectFox_eventbase_${k}`)
            .val(settings[`eventbase_${k}`] ?? '')
            .on('change', function() {
                const v = parseFloat($(this).val());
                if (!isNaN(v) && v >= 0) {
                    settings[`eventbase_${k}`] = v;
                    _normalizeRerankWeights();
                    Object.assign(extension_settings.vectfox, settings);
                    saveSettingsDebounced();
                }
            });
    });

    $('#VectFox_eventbase_reset_weights').on('click', function() {
        settings.eventbase_rerank_w_cosine    = 0.55;
        settings.eventbase_rerank_w_importance = 0.20;
        settings.eventbase_rerank_w_persist   = 0.15;
        settings.eventbase_rerank_w_recency   = 0.10;
        ['rerank_w_cosine', 'rerank_w_importance', 'rerank_w_persist', 'rerank_w_recency'].forEach(k => {
            $(`#VectFox_eventbase_${k}`).val(settings[`eventbase_${k}`]);
        });
        Object.assign(extension_settings.vectfox, settings);
        saveSettingsDebounced();
        toastr.success('Re-rank weights reset to defaults');
    });

    // Custom extraction prompt textarea — pre-fill with default if nothing saved
    (async () => {
        const { DEFAULT_EXTRACTION_PROMPT } = await import('../core/eventbase-schema.js');
        const saved = settings.eventbase_custom_prompt || '';
        $('#VectFox_eventbase_custom_prompt').val(saved || DEFAULT_EXTRACTION_PROMPT);
    })();

    $('#VectFox_eventbase_custom_prompt').on('input', function() {
        settings.eventbase_custom_prompt = $(this).val();
        Object.assign(extension_settings.vectfox, settings);
        saveSettingsDebounced();
    });

    // Reset prompt to built-in default
    $('#VectFox_eventbase_prompt_reset').on('click', async function() {
        const { DEFAULT_EXTRACTION_PROMPT } = await import('../core/eventbase-schema.js');
        settings.eventbase_custom_prompt = '';
        $('#VectFox_eventbase_custom_prompt').val(DEFAULT_EXTRACTION_PROMPT);
        Object.assign(extension_settings.vectfox, settings);
        saveSettingsDebounced();
        toastr.success('Extraction prompt reset to default', 'EventBase');
    });

    $('#VectFox_eventbase_open_browser').on('click', function() {
        toastr.info('Event Browser coming in a future update.', 'EventBase');
    });

    // ── End EventBase settings ───────────────────────────────────────────────

    // BananaBread API key
    // Note: We store in extension settings because custom keys aren't returned by ST's readSecretState()
    const updateBananaBreadKeyDisplay = () => {
        const savedKey = settings.bananabread_api_key;
        if (savedKey) {
            // Mask the key for display (show last 4 chars)
            const masked = savedKey.length > 4
                ? '*'.repeat(Math.min(savedKey.length - 4, 8)) + savedKey.slice(-4)
                : '*'.repeat(savedKey.length);
            $('#VectFox_bananabread_apikey').attr('placeholder', `Key saved: ${masked}`);
        } else {
            $('#VectFox_bananabread_apikey').attr('placeholder', 'Paste key here to save...');
        }
    };
    updateBananaBreadKeyDisplay();

    $('#VectFox_bananabread_apikey')
        .on('change', async function() {
            const value = String($(this).val()).trim();
            if (value) {
                // Store in extension settings (primary storage for this key)
                settings.bananabread_api_key = value;
                Object.assign(extension_settings.vectfox, settings);
                saveSettingsDebounced();

                // Also write to ST secrets for potential future compatibility
                await writeSecret('bananabread_api_key', value);

                toastr.success('BananaBread API key saved');
                $(this).val('');
                updateBananaBreadKeyDisplay();
            }
        });

    // OpenAI model
    $('#VectFox_openai_model')
        .val(settings.openai_model)
        .on('change', function() {
            settings.openai_model = String($(this).val());
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    // Cohere model
    $('#VectFox_cohere_model')
        .val(settings.cohere_model)
        .on('change', function() {
            settings.cohere_model = String($(this).val());
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    // TogetherAI model
    $('#VectFox_togetherai_model')
        .val(settings.togetherai_model)
        .on('change', function() {
            settings.togetherai_model = String($(this).val());
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    // vLLM model
    $('#VectFox_vllm_model')
        .val(settings.vllm_model)
        .on('input', function() {
            settings.vllm_model = String($(this).val());
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    // vLLM API key (stored in extension settings, not ST secrets)
    $('#VectFox_vllm_api_key')
        .val(settings.vllm_api_key ? '••••••••' : '')
        .attr('placeholder', settings.vllm_api_key ? '••••••••' : 'Leave blank for local / no-auth deployments')
        .on('change', function() {
            const value = String($(this).val()).trim();
            if (value && value !== '••••••••') {
                settings.vllm_api_key = value;
                Object.assign(extension_settings.vectfox, settings);
                saveSettingsDebounced();
                $(this).val('••••••••').attr('placeholder', '••••••••');
                toastr.success('vLLM API key saved');
            }
        });

    // Google model
    $('#VectFox_google_model')
        .val(settings.google_model)
        .on('change', function() {
            settings.google_model = String($(this).val());
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    // OpenRouter model
    $('#VectFox_openrouter_model')
        .val(settings.openrouter_model)
        .on('input', function() {
            settings.openrouter_model = String($(this).val());
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    // "Choose" button — fetches OpenRouter model list, filters to embedding-likely models
    // Cached for the session to avoid re-fetching 600+ entries each click
    let _openrouterModelCache = null;
    $('#VectFox_openrouter_model_choose').on('click', async function() {
        const $btn = $(this);
        const $list = $('#VectFox_openrouter_model_list');
        const $input = $('#VectFox_openrouter_model');

        const originalHtml = $btn.html();
        $btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i> Loading…');

        try {
            if (!_openrouterModelCache) {
                const headers = { 'Content-Type': 'application/json' };
                const apiKey = settings.openrouter_api_key;
                if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
                // Embedding models use output_modalities=embeddings — not in the standard list
                const [embResp, allResp] = await Promise.all([
                    fetch('https://openrouter.ai/api/v1/models?output_modalities=embeddings', { method: 'GET', headers }),
                    fetch('https://openrouter.ai/api/v1/models', { method: 'GET', headers }),
                ]);
                const toEntry = m => ({ id: m.id, label: m.name ? `${m.id} — ${m.name}` : m.id });
                const embModels = embResp.ok ? (await embResp.json()).data?.map(toEntry) || [] : [];
                const allModels = allResp.ok ? (await allResp.json()).data?.map(toEntry) || [] : [];
                _openrouterModelCache = { embeddings: embModels, all: [...embModels, ...allModels] };
            }

            const { embeddings, all } = _openrouterModelCache;

            const renderList = (items, showingAll) => {
                if (!items.length) {
                    toastr.warning('No models matched the filter.');
                    return;
                }
                items.sort((a, b) => a.id.localeCompare(b.id));
                const currentValue = String($input.val() || '').trim();
                const toggleLabel = showingAll ? '— Showing all models · click to filter to embedding-only —' : '— Showing embedding models · click to show all —';
                const options = [`<option value="__toggle__">${toggleLabel}</option>`, '<option value="">— Select a model —</option>']
                    .concat(items.map(m => {
                        const selected = m.id === currentValue ? ' selected' : '';
                        const safeId = $('<div>').text(m.id).html();
                        const safeLabel = $('<div>').text(m.label).html();
                        return `<option value="${safeId}"${selected}>${safeLabel}</option>`;
                    }));
                $list.html(options.join('')).data('showing-all', showingAll).show();
            };

            // Default to embedding-only; if zero matches, fall back to all
            if (embeddings.length > 0) {
                renderList(embeddings, false);
                toastr.success(`Loaded ${embeddings.length} embedding models (${all.length} total available).`);
            } else {
                renderList(all, true);
                toastr.info(`No embedding-tagged models found — showing all ${all.length} models.`);
            }
        } catch (err) {
            console.error('[VectFox] OpenRouter model list fetch failed:', err);
            toastr.error(`Could not fetch model list: ${err?.message || err}`);
        } finally {
            $btn.prop('disabled', false).html(originalHtml);
        }
    });

    $('#VectFox_openrouter_model_list').on('change', function() {
        const $list = $(this);
        const value = String($list.val() || '').trim();

        // "__toggle__" pseudo-option toggles between embedding-only and all
        if (value === '__toggle__') {
            const showingAll = !!$list.data('showing-all');
            const cache = _openrouterModelCache || { embeddings: [], all: [] };
            const items = showingAll ? cache.embeddings : cache.all;
            items.sort((a, b) => a.id.localeCompare(b.id));
            const currentValue = String($('#VectFox_openrouter_model').val() || '').trim();
            const nextShowingAll = !showingAll;
            const toggleLabel = nextShowingAll ? '— Showing all models · click to filter to embedding-only —' : '— Showing embedding models · click to show all —';
            const options = [`<option value="__toggle__">${toggleLabel}</option>`, '<option value="">— Select a model —</option>']
                .concat(items.map(m => {
                    const selected = m.id === currentValue ? ' selected' : '';
                    const safeId = $('<div>').text(m.id).html();
                    const safeLabel = $('<div>').text(m.label).html();
                    return `<option value="${safeId}"${selected}>${safeLabel}</option>`;
                }));
            $list.html(options.join('')).data('showing-all', nextShowingAll);
            return;
        }

        if (!value) return;
        $('#VectFox_openrouter_model').val(value).trigger('input');
        $list.hide();
    });

    // OpenRouter API key - saves directly to ST secrets
    // Show existing key if set
    const updateOpenRouterKeyDisplay = () => {
        const secrets = secret_state[SECRET_KEYS.OPENROUTER];
        if (Array.isArray(secrets) && secrets.length > 0) {
            const activeSecret = secrets.find(s => s.active) || secrets[0];
            if (activeSecret?.value) {
                $('#VectFox_openrouter_apikey').attr('placeholder', activeSecret.value);
            }
        }
    };
    updateOpenRouterKeyDisplay();

    $('#VectFox_openrouter_apikey')
        .on('change', async function() {
            const value = String($(this).val()).trim();
            if (value) {
                await writeSecret(SECRET_KEYS.OPENROUTER, value);
                await readSecretState(); // Refresh state to get masked value
                settings.openrouter_api_key = value;
                Object.assign(extension_settings.vectfox, settings);
                saveSettingsDebounced();
                _openrouterModelCache = null; // Invalidate cache so next fetch uses new key
                toastr.success('OpenRouter API key saved');
                $(this).val(''); // Clear input
                updateOpenRouterKeyDisplay(); // Show masked key in placeholder
            }
        });

    // Rate Limiting
    $('#VectFox_rate_limit_calls')
        .val(settings.rate_limit_calls || 0)
        .on('input', function() {
            const value = parseInt($(this).val());
            settings.rate_limit_calls = isNaN(value) ? 0 : value;
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    $('#VectFox_rate_limit_interval')
        .val(settings.rate_limit_interval || 60)
        .on('input', function() {
            const value = parseInt($(this).val());
            settings.rate_limit_interval = isNaN(value) ? 60 : value;
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    $('#VectFox_eventbase_debug_qdrant_backend')
        .prop('checked', !!settings.eventbase_debug_qdrant_backend)
        .on('change', function() {
            settings.eventbase_debug_qdrant_backend = !!$(this).prop('checked');
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    // VEC-6: Insert Batch Size
    $('#VectFox_insert_batch_size')
        .val(settings.insert_batch_size || 50)
        .on('input', function() {
            const value = parseInt($(this).val());
            $('#VectFox_insert_batch_size_value').text(value);
            settings.insert_batch_size = value;
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });
    $('#VectFox_insert_batch_size_value').text(settings.insert_batch_size || 50);

    // Minimum chat length before injection starts
    $('#VectFox_min_chat_length')
        .val(settings.min_chat_length ?? 0)
        .on('input', function() {
            const value = parseInt($(this).val());
            settings.min_chat_length = isNaN(value) ? 0 : Math.max(0, value);
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        });

    // Action buttons
    $('#VectFox_vectorize_content').on('click', () => {
        openContentVectorizer();
    });
    $('#VectFox_vectorize_all').on('click', callbacks.onVectorizeAll);
    $('#VectFox_purge').on('click', callbacks.onPurge);
    $('#VectFox_cleanup_corrupted').on('click', callbacks.onCleanupCorrupted);
    $('#VectFox_run_diagnostics').on('click', callbacks.onRunDiagnostics);
    $('#VectFox_database_browser').on('click', () => {
        openDatabaseBrowser();
    });
    $('#VectFox_view_results').on('click', () => {
        openQueryTestModal();
    });
    $('#VectFox_text_cleaning').on('click', () => {
        openTextCleaningManager();
    });
    $('#VectFox_reopen_progress').on('click', () => {
        if (!progressTracker.reopen()) {
            toastr.info('No active progress to show', 'VectFox');
        }
    });

    // Initialize provider-specific settings visibility
    toggleProviderSettings(settings.source, settings);

    // =========================================================================
    // COTTON-TALES EMOTION CLASSIFIER INTEGRATION
    // =========================================================================
    initializeCottonTalesIntegration(settings);
}

/**
 * Initialize Cotton-Tales emotion classifier integration
 * Shows the section only if Cotton-Tales is installed
 */
async function initializeCottonTalesIntegration(settings) {
    // Check if Cotton-Tales is installed
    const cottonTalesInstalled = !!extension_settings?.cotton_tales;

    if (cottonTalesInstalled) {
        $('#VectFox_cottontales_section').show();
        console.log('VectFox: Cotton-Tales detected, showing emotion classification options');
    } else {
        $('#VectFox_cottontales_section').hide();
        return;
    }

    // Import emotion classifier module
    let emotionClassifier;
    try {
        emotionClassifier = await import('../core/emotion-classifier.js');
    } catch (error) {
        console.error('VectFox: Failed to load emotion classifier module:', error);
        return;
    }

    // Helper to update UI based on method selection
    function updateMethodUI(method) {
        $('#VectFox_classifier_settings').toggle(method === 'classifier');
        $('#VectFox_similarity_settings').toggle(method === 'similarity');

        // Update the display of current embedding source for similarity mode
        if (method === 'similarity') {
            $('#VectFox_similarity_source_display').text(settings.source || 'transformers');
        }
    }

    // Determine initial method from settings
    function getCurrentMethod() {
        if (settings.emotion_classifier_enabled && !settings.emotion_use_similarity) {
            return 'classifier';
        } else if (settings.emotion_use_similarity) {
            return 'similarity';
        }
        return 'disabled';
    }

    // Classification method dropdown
    $('#VectFox_emotion_method')
        .val(getCurrentMethod())
        .on('change', function() {
            const method = $(this).val();

            // Update settings based on method
            if (method === 'disabled') {
                settings.emotion_classifier_enabled = false;
                settings.emotion_use_similarity = false;
                emotionClassifier.updateClassifierSetting('enabled', false);
                emotionClassifier.updateClassifierSetting('useEmbeddingSimilarity', false);
            } else if (method === 'classifier') {
                settings.emotion_classifier_enabled = true;
                settings.emotion_use_similarity = false;
                emotionClassifier.updateClassifierSetting('enabled', true);
                emotionClassifier.updateClassifierSetting('useEmbeddingSimilarity', false);
            } else if (method === 'similarity') {
                settings.emotion_classifier_enabled = true; // Still enabled, but uses similarity
                settings.emotion_use_similarity = true;
                emotionClassifier.updateClassifierSetting('enabled', true);
                emotionClassifier.updateClassifierSetting('useEmbeddingSimilarity', true);
            }

            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
            updateMethodUI(method);
        });

    // Initialize UI for current method
    updateMethodUI(getCurrentMethod());

    // Classifier model selection
    $('#VectFox_emotion_classifier_model')
        .val(settings.emotion_classifier_model || 'SamLowe/roberta-base-go_emotions')
        .on('change', function() {
            const value = $(this).val();

            if (value === 'custom') {
                $('#VectFox_custom_classifier_model').show();
            } else {
                $('#VectFox_custom_classifier_model').hide();
                settings.emotion_classifier_model = value;
                Object.assign(extension_settings.vectfox, settings);
                saveSettingsDebounced();
                emotionClassifier.updateClassifierSetting('model', value);
            }
        });

    // Show custom model input if currently set to custom
    if (settings.emotion_classifier_model &&
        !['SamLowe/roberta-base-go_emotions', 'j-hartmann/emotion-english-distilroberta-base', 'bhadresh-savani/distilbert-base-uncased-emotion'].includes(settings.emotion_classifier_model)) {
        $('#VectFox_emotion_classifier_model').val('custom');
        $('#VectFox_custom_classifier_model').show();
    }

    // Custom model input
    $('#VectFox_emotion_classifier_custom')
        .val(settings.emotion_classifier_custom || '')
        .on('input', function() {
            settings.emotion_classifier_custom = $(this).val();
            settings.emotion_classifier_model = $(this).val();
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
            emotionClassifier.updateClassifierSetting('model', $(this).val());
        });

    // Test classifier button
    $('#VectFox_test_classifier').on('click', async function() {
        const $btn = $(this);
        const $result = $('#VectFox_classifier_test_result');

        $btn.addClass('disabled').find('i').removeClass('fa-flask').addClass('fa-spinner fa-spin');
        $result.hide();

        try {
            const model = settings.emotion_classifier_model || 'SamLowe/roberta-base-go_emotions';
            const testResult = await emotionClassifier.testClassifierModel(model);

            $result.show();

            if (testResult.error) {
                $result.css('background', 'rgba(239,68,68,0.2)').html(`
                    <div style="color: #ef4444;">
                        <i class="fa-solid fa-times-circle"></i>
                        <b>Error:</b> ${testResult.error}
                    </div>
                `);
            } else if (testResult.isEmotionClassifier) {
                const confidenceColor = testResult.confidence === 'high' ? '#22c55e' : '#eab308';
                $result.css('background', 'rgba(34,197,94,0.2)').html(`
                    <div style="color: #22c55e;">
                        <i class="fa-solid fa-check-circle"></i>
                        <b>Looks like an emotion classifier!</b>
                    </div>
                    <div style="margin-top: 4px; font-size: 0.9em;">
                        <b>Confidence:</b> <span style="color: ${confidenceColor}">${testResult.confidence}</span><br>
                        <b>Sample labels:</b> ${testResult.sampleLabels.join(', ')}
                    </div>
                `);
            } else {
                $result.css('background', 'rgba(234,179,8,0.2)').html(`
                    <div style="color: #eab308;">
                        <i class="fa-solid fa-exclamation-triangle"></i>
                        <b>May not be an emotion classifier</b>
                    </div>
                    <div style="margin-top: 4px; font-size: 0.9em;">
                        Labels don't look like emotions: ${testResult.sampleLabels.join(', ')}<br>
                        Consider using a different model.
                    </div>
                `);
            }
        } catch (error) {
            $result.show().css('background', 'rgba(239,68,68,0.2)').html(`
                <div style="color: #ef4444;">
                    <i class="fa-solid fa-times-circle"></i>
                    <b>Test failed:</b> ${error.message}
                </div>
            `);
        } finally {
            $btn.removeClass('disabled').find('i').removeClass('fa-spinner fa-spin').addClass('fa-flask');
        }
    });
}

// Store current diagnostic results for copy/filter functionality
let currentDiagnosticResults = null;
let currentDiagnosticFilter = 'all'; // 'all', 'pass', 'warning', 'fail'

/**
 * Shows diagnostics results in the results phase
 * @param {object} results - Diagnostics results object
 */
export function showDiagnosticsResults(results) {
    // Store results globally for copy/filter functionality
    currentDiagnosticResults = results;
    currentDiagnosticFilter = 'all';

    renderDiagnosticsContent(results, 'all');

    // Show results phase
    showDiagnosticsPhase('results');
}

/**
 * Renders diagnostic content with optional status filter
 * @param {object} results - Diagnostics results object
 * @param {string} filter - Filter: 'all', 'pass', 'warning', 'fail'
 */
function renderDiagnosticsContent(results, filter = 'all') {
    const output = $('#VectFox_diagnostics_content');
    output.empty();

    console.log('VectFox UI: Rendering diagnostics with results:', results);
    console.log('VectFox UI: Version data received:', results.version);
    console.log('VectFox UI: Extension version:', results.version?.extension);
    console.log('VectFox UI: Plugin version:', results.version?.plugin);

    const statusIcons = {
        'pass': '<i class="fa-solid fa-circle-check" style="color: var(--vectfox-success);"></i>',
        'warning': '<i class="fa-solid fa-triangle-exclamation" style="color: var(--vectfox-warning);"></i>',
        'fail': '<i class="fa-solid fa-circle-xmark" style="color: var(--vectfox-danger);"></i>',
        'skipped': '<i class="fa-solid fa-circle-minus" style="color: var(--grey70);"></i>'
    };

    const categoryTitles = {
        infrastructure: '<i class="fa-solid fa-server"></i> Infrastructure',
        configuration: '<i class="fa-solid fa-sliders"></i> Configuration',
        visualizer: '<i class="fa-solid fa-eye"></i> Visualizer',
        production: '<i class="fa-solid fa-vial"></i> Production Tests',
        console: '<i class="fa-solid fa-terminal"></i> Console Logs'
    };

    // Count stats
    const passCount = results.checks.filter(c => c.status === 'pass').length;
    const warnCount = results.checks.filter(c => c.status === 'warning').length;
    const failCount = results.checks.filter(c => c.status === 'fail').length;
    const fixableCount = results.checks.filter(c => c.fixable && (c.status === 'fail' || c.status === 'warning')).length;

    // Filter checks if needed
    const filterCheck = (check) => {
        if (filter === 'all') return true;
        return check.status === filter;
    };

    const renderChecks = (checks) => {
        const filteredChecks = checks.filter(filterCheck);
        if (filteredChecks.length === 0) {
            return '<div class="diagnostic-item-empty">No items match current filter</div>';
        }
        return filteredChecks.map(check => `
            <div class="diagnostic-item ${check.status}" data-fix-action="${check.fixAction || ''}" data-status="${check.status}">
                <div class="diagnostic-main">
                    <span class="diagnostic-icon">${statusIcons[check.status]}</span>
                    <span class="diagnostic-label">${check.name}</span>
                    <span class="diagnostic-message">${check.message}</span>
                </div>
                ${check.fixable ? `
                    <button class="diagnostic-fix-btn" data-fix-action="${check.fixAction}">
                        <i class="fa-solid fa-wrench"></i>
                        Fix
                    </button>
                ` : ''}
            </div>
        `).join('');
    };

    const html = `
        <!-- Version Info -->
        <div class="vectfox-diagnostics-version" style="padding: 10px 15px; background: var(--black30alpha); border-radius: 8px; margin-bottom: 15px; font-size: 0.9em; color: var(--grey70);">
            <i class="fa-solid fa-info-circle"></i>
            <strong>Extension:</strong> v${results.version?.extension || 'Unknown'}
            <span style="margin: 0 10px;">•</span>
            <strong>Plugin:</strong> v${results.version?.plugin || 'Not installed'}
        </div>

        <!-- Summary Stats Bar (Clickable Filters) -->
        <div class="vectfox-diagnostics-stats">
            <div class="vectfox-diag-stat pass ${filter === 'pass' ? 'active' : ''}" data-filter="pass" title="Click to filter by passed">
                ${statusIcons.pass}
                <span class="vectfox-diag-stat-count">${passCount}</span>
                <span class="vectfox-diag-stat-label">Passed</span>
            </div>
            <div class="vectfox-diag-stat warning ${filter === 'warning' ? 'active' : ''}" data-filter="warning" title="Click to filter by warnings">
                ${statusIcons.warning}
                <span class="vectfox-diag-stat-count">${warnCount}</span>
                <span class="vectfox-diag-stat-label">Warnings</span>
            </div>
            <div class="vectfox-diag-stat fail ${filter === 'fail' ? 'active' : ''}" data-filter="fail" title="Click to filter by failed">
                ${statusIcons.fail}
                <span class="vectfox-diag-stat-count">${failCount}</span>
                <span class="vectfox-diag-stat-label">Failed</span>
            </div>
        </div>

        ${filter !== 'all' ? `
            <div class="vectfox-diag-filter-notice">
                <span>Showing only: <strong>${filter}</strong></span>
                <button class="vectfox-diag-clear-filter" data-filter="all">
                    <i class="fa-solid fa-times"></i> Show All
                </button>
            </div>
        ` : ''}

        ${Object.entries(results.categories).map(([category, checks]) => {
            if (checks.length === 0) return '';

            // Category-level stats
            const catPass = checks.filter(c => c.status === 'pass').length;
            const catWarn = checks.filter(c => c.status === 'warning').length;
            const catFail = checks.filter(c => c.status === 'fail').length;
            const catTotal = checks.length;
            const filteredCount = checks.filter(filterCheck).length;

            // Don't show category if all items filtered out
            if (filter !== 'all' && filteredCount === 0) return '';

            return `
                <div class="diagnostic-category" data-category="${category}">
                    <div class="diagnostic-category-header" data-collapsed="false">
                        <h4 class="diagnostic-category-title">
                            <span class="diagnostic-category-collapse-icon">
                                <i class="fa-solid fa-chevron-down"></i>
                            </span>
                            ${categoryTitles[category] || `<i class="fa-solid fa-folder"></i> ${category}`}
                        </h4>
                        <div class="diagnostic-category-stats">
                            <span class="diag-cat-stat pass" title="Passed">${catPass}</span>
                            <span class="diag-cat-stat warning" title="Warnings">${catWarn}</span>
                            <span class="diag-cat-stat fail" title="Failed">${catFail}</span>
                        </div>
                    </div>
                    <div class="diagnostic-category-content">
                        <div class="vectfox-diagnostics">
                            ${renderChecks(checks)}
                        </div>
                    </div>
                </div>
            `;
        }).join('')}
    `;

    output.html(html);

    // Update title based on results
    const titleText = results.overall === 'healthy'
        ? 'All Checks Passed!'
        : results.overall === 'warnings'
            ? 'Completed with Warnings'
            : 'Issues Found';
    $('#VectFox_diagnostics_title').text(titleText);

    // Show/hide Fix All button based on fixable issues
    if (fixableCount > 0) {
        $('#VectFox_diag_fix_all')
            .show()
            .html(`<i class="fa-solid fa-wand-magic-sparkles"></i> Fix All (${fixableCount})`)
            .off('click')
            .on('click', function() {
                handleFixAll(results.checks);
            });
    } else {
        $('#VectFox_diag_fix_all').hide();
    }

    // Bind filter click handlers on stat boxes
    $('.vectfox-diag-stat').off('click').on('click', function() {
        const clickedFilter = $(this).data('filter');
        // Toggle: if already active, show all; otherwise apply filter
        if (currentDiagnosticFilter === clickedFilter) {
            currentDiagnosticFilter = 'all';
        } else {
            currentDiagnosticFilter = clickedFilter;
        }
        renderDiagnosticsContent(currentDiagnosticResults, currentDiagnosticFilter);
    });

    // Bind clear filter button
    $('.vectfox-diag-clear-filter').off('click').on('click', function() {
        currentDiagnosticFilter = 'all';
        renderDiagnosticsContent(currentDiagnosticResults, 'all');
    });

    // Bind category collapse handlers
    $('.diagnostic-category-header').off('click').on('click', function() {
        const $header = $(this);
        const $content = $header.next('.diagnostic-category-content');
        const isCollapsed = $header.attr('data-collapsed') === 'true';

        if (isCollapsed) {
            $content.slideDown(200);
            $header.attr('data-collapsed', 'false');
            $header.find('.diagnostic-category-collapse-icon i').removeClass('fa-chevron-right').addClass('fa-chevron-down');
        } else {
            $content.slideUp(200);
            $header.attr('data-collapsed', 'true');
            $header.find('.diagnostic-category-collapse-icon i').removeClass('fa-chevron-down').addClass('fa-chevron-right');
        }
    });

    // Bind individual fix button click handlers
    $('.diagnostic-fix-btn').off('click').on('click', function(e) {
        e.stopPropagation();
        const action = $(this).data('fix-action');
        handleDiagnosticFix(action);
        // Mark this item as fixed visually
        $(this).closest('.diagnostic-item')
            .removeClass('fail warning')
            .addClass('pass')
            .find('.diagnostic-icon').html(statusIcons.pass);
        $(this).fadeOut(200);
    });

    // Bind copy button
    $('#VectFox_diag_copy').off('click').on('click', function() {
        copyDiagnosticsReport(currentDiagnosticResults);
    });
}

/**
 * Generates and copies a nicely formatted diagnostics report
 * Respects the current filter selection
 * @param {object} results - Diagnostics results object
 */
function copyDiagnosticsReport(results) {
    if (!results) {
        toastr.warning('No diagnostic results to copy');
        return;
    }

    const filter = currentDiagnosticFilter;
    const isFiltered = filter !== 'all';

    // Filter checks if a specific filter is active
    const filterCheck = (check) => {
        if (!isFiltered) return true;
        return check.status === filter;
    };

    const timestamp = new Date(results.timestamp).toLocaleString();

    // Total counts (always show these for context)
    const totalPass = results.checks.filter(c => c.status === 'pass').length;
    const totalWarn = results.checks.filter(c => c.status === 'warning').length;
    const totalFail = results.checks.filter(c => c.status === 'fail').length;
    const totalCount = totalPass + totalWarn + totalFail;

    // Filtered counts
    const filteredChecks = results.checks.filter(filterCheck);
    const filteredCount = filteredChecks.length;

    const statusSymbols = {
        'pass': '✓',
        'warning': '⚠',
        'fail': '✗',
        'skipped': '○'
    };

    const filterNames = {
        'pass': 'PASSED ONLY',
        'warning': 'WARNINGS ONLY',
        'fail': 'FAILURES ONLY'
    };

    // Get current settings for the report
    const settings = extension_settings.vectfox;
    const backend = settings.vector_backend || 'qdrant';
    const source = settings.source || 'none';
    const modelField = getModelField(source);
    const model = modelField ? (settings[modelField] || 'not set') : 'n/a (provider handles it)';
    const qdrantMode = settings.qdrant_mode || 'local';
    const qdrantUrl = backend === 'qdrant'
        ? (qdrantMode === 'cloud' ? settings.qdrant_cloud_url : settings.qdrant_url)
        : null;

    // Build provider URL info
    let providerUrl = 'n/a';
    if (source === 'ollama') {
        providerUrl = settings.ollama_use_alt_endpoint && settings.ollama_alt_endpoint_url
            ? settings.ollama_alt_endpoint_url
            : (textgenerationwebui_settings?.server_urls?.[textgen_types?.OLLAMA] || 'http://localhost:11434');
    } else if (source === 'vllm') {
        providerUrl = settings.vllm_use_alt_endpoint && settings.vllm_alt_endpoint_url
            ? settings.vllm_alt_endpoint_url
            : (textgenerationwebui_settings?.server_urls?.[textgen_types?.VLLM] || 'http://localhost:8000');
    }

    let report = `╔══════════════════════════════════════════════════════════════╗
║              VectFox DIAGNOSTICS REPORT                      ║
╚══════════════════════════════════════════════════════════════╝

📅 Generated: ${timestamp}
📦 Extension Version: ${results.version?.extension || 'Unknown'}
🔌 Plugin Version: ${results.version?.plugin || 'Not installed'}
${isFiltered ? `🔍 Filter: ${filterNames[filter]} (${filteredCount} of ${totalCount} checks)\n` : ''}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
                      CURRENT SETTINGS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Backend:           ${backend}${backend === 'qdrant' ? ` (${qdrantMode})` : ''}
  Embedding Source:  ${source}
  Model:             ${model}${providerUrl !== 'n/a' ? `\n  Provider URL:      ${providerUrl}` : ''}${qdrantUrl ? `\n  Qdrant URL:        ${qdrantUrl}` : ''}
  Chunk Size:        ${settings.chunk_size || 500} chars (adaptive only)
  Score Threshold:   ${settings.score_threshold || 0.5}
  Query Depth:       ${settings.query || 3}
  Chat Auto-Sync:    ${settings.enabled_chats ? 'enabled' : 'disabled'}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
                         SUMMARY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  ✓ Passed:   ${String(totalPass).padStart(3)}${filter === 'pass' ? ' ◀ showing' : ''}
  ⚠ Warnings: ${String(totalWarn).padStart(3)}${filter === 'warning' ? ' ◀ showing' : ''}
  ✗ Failed:   ${String(totalFail).padStart(3)}${filter === 'fail' ? ' ◀ showing' : ''}
  ─────────────────
  Total:      ${String(totalCount).padStart(3)}

`;

    const categoryNames = {
        infrastructure: '🔧 INFRASTRUCTURE',
        configuration: '⚙️  CONFIGURATION',
        visualizer: '👁️  VISUALIZER',
        production: '🧪 PRODUCTION TESTS',
        console: '💻 CONSOLE LOGS'
    };

    for (const [category, checks] of Object.entries(results.categories)) {
        // Filter checks for this category
        const filteredCatChecks = checks.filter(filterCheck);
        if (filteredCatChecks.length === 0) continue;

        // Show filtered counts vs total for this category
        const catTotal = checks.length;
        const catFiltered = filteredCatChecks.length;
        const catStats = isFiltered
            ? `(${catFiltered} of ${catTotal})`
            : `(✓${checks.filter(c => c.status === 'pass').length} ⚠${checks.filter(c => c.status === 'warning').length} ✗${checks.filter(c => c.status === 'fail').length})`;

        report += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${categoryNames[category] || category.toUpperCase()}  ${catStats}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

`;

        for (const check of filteredCatChecks) {
            const symbol = statusSymbols[check.status] || '?';
            const name = check.name.padEnd(28);
            report += `  ${symbol} ${name} ${check.message}\n`;
        }

        report += '\n';
    }

    // Add console errors if present (only when showing all or failures)
    if (results.consoleErrors && results.consoleErrors.length > 0 && (!isFiltered || filter === 'fail')) {
        report += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💻 CONSOLE ERRORS CAPTURED
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

`;
        for (const error of results.consoleErrors) {
            report += `  [${error.type.toUpperCase()}] ${error.message}\n`;
            if (error.stack) {
                report += `           ${error.stack.split('\n')[0]}\n`;
            }
        }
        report += '\n';
    }

    report += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
                      END OF REPORT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`;

    // Copy to clipboard
    const filterMsg = isFiltered ? ` (${filterNames[filter]})` : '';
    navigator.clipboard.writeText(report).then(() => {
        toastr.success(`Diagnostics report${filterMsg} copied to clipboard`, 'VectFox');
    }).catch(err => {
        console.error('Failed to copy:', err);
        toastr.error('Failed to copy report');
    });
}

/**
 * Opens the diagnostics modal (starts at selection phase)
 */
export function openDiagnosticsModal() {
    showDiagnosticsPhase('selection');
    $('#VectFox_diagnostics_title').text('Run Diagnostics');
    $('#VectFox_diagnostics_modal').fadeIn(200);
}

/**
 * Handles fixing all fixable issues
 * @param {Array} checks - Array of diagnostic checks
 */
function handleFixAll(checks) {
    const fixableChecks = checks.filter(c => c.fixable && (c.status === 'fail' || c.status === 'warning'));

    if (fixableChecks.length === 0) {
        toastr.info('No fixable issues found');
        return;
    }

    let fixedCount = 0;
    const statusIcons = {
        'pass': '<i class="fa-solid fa-circle-check" style="color: var(--vectfox-success);"></i>'
    };

    fixableChecks.forEach(check => {
        try {
            handleDiagnosticFix(check.fixAction, true); // silent mode
            fixedCount++;

            // Update UI for this item
            $(`.diagnostic-item[data-fix-action="${check.fixAction}"]`)
                .removeClass('fail warning')
                .addClass('pass')
                .find('.diagnostic-icon').html(statusIcons.pass);
            $(`.diagnostic-item[data-fix-action="${check.fixAction}"] .diagnostic-fix-btn`).fadeOut(200);
        } catch (e) {
            console.warn(`Failed to fix: ${check.fixAction}`, e);
        }
    });

    // Hide Fix All button after use
    $('#VectFox_diag_fix_all').fadeOut(200);

    toastr.success(`Fixed ${fixedCount} issue${fixedCount !== 1 ? 's' : ''}`);
}

/**
 * Handles diagnostic fix actions
 * @param {string} action - The fix action to perform
 * @param {boolean} silent - If true, suppress toast notifications and don't close modal
 */
function handleDiagnosticFix(action, silent = false) {
    const settings = extension_settings.vectfox;

    switch (action) {
        case 'enable_chats':
            $('#VectFox_autosync_enabled').prop('checked', true).trigger('change');
            if (!silent) toastr.success('Chat auto-sync enabled');
            break;

        case 'vectorize_all':
            $('#VectFox_vectorize_all').click();
            break;

        case 'configure_provider':
            // Scroll to provider settings
            $('#VectFox_provider_settings')[0]?.scrollIntoView({ behavior: 'smooth' });
            if (!silent) toastr.info('Please select an embedding provider');
            break;

        case 'configure_api_key':
            if (!silent) toastr.info('Go to Settings > API Connections to add your API key');
            break;

        case 'configure_url':
            // Scroll to provider settings
            $('#VectFox_provider_settings')[0]?.scrollIntoView({ behavior: 'smooth' });
            if (!silent) toastr.info('Please configure your API URL in the provider settings');
            break;

        case 'fix_threshold':
            $('#VectFox_score_threshold').val(0.25).trigger('change');
            if (!silent) toastr.success('Score threshold reset to 0.25');
            break;

        case 'fix_counts':
            if (settings.insert < 1) {
                $('#VectFox_insert').val(3).trigger('change');
            }
            if ((settings.top_k ?? settings.insert) < 1) {
                $('#VectFox_topk').val(3).trigger('change');
            }
            if (settings.query < 1) {
                $('#VectFox_query').val(2).trigger('change');
            }
            if (!silent) toastr.success('Insert/Query counts fixed');
            break;

        case 'fix_chunk_size':
            $('#VectFox_chunk_size').val(500).trigger('input');
            if (!silent) toastr.success('Chunk size reset to 500');
            break;

        case 'fix_qdrant_dimension':
            // This needs a dialog - don't auto-fix, show options
            if (!silent) {
                showQdrantDimensionFixDialog();
            }
            return; // Don't close modal

        default:
            if (!silent) toastr.error(`Unknown fix action: ${action}`);
    }

    // Only close modal for individual fixes (not batch Fix All)
    if (!silent) {
        setTimeout(() => {
            closeDiagnosticsModal();
        }, 500);
    }
}

/**
 * Shows a dialog with options to fix Qdrant dimension mismatch
 */
async function showQdrantDimensionFixDialog() {
    // Get the check data from the current diagnostics results
    const check = currentDiagnosticResults?.checks?.find(c => c.fixAction === 'fix_qdrant_dimension');
    const data = check?.data || {};

    const collectionDim = data.collectionDimension || '?';
    const currentDim = data.currentDimension || '?';
    const sources = data.collectionSources?.join(', ') || 'unknown';
    const models = data.collectionModels?.length > 0 ? data.collectionModels.join(', ') : '(not recorded)';
    const pointsCount = data.pointsCount || 0;

    const dialogHtml = `
        <div class="vectfox-dimension-fix-dialog">
            <h3 style="margin-top: 0; color: var(--vectfox-danger);">
                <i class="fa-solid fa-triangle-exclamation"></i> Vector Dimension Mismatch
            </h3>

            <div class="vectfox-dimension-info" style="background: var(--SmartThemeBlurTintColor); padding: 12px; border-radius: 8px; margin-bottom: 16px;">
                <p style="margin: 0 0 8px 0;"><strong>Your Qdrant collection:</strong></p>
                <ul style="margin: 0; padding-left: 20px;">
                    <li><strong>${collectionDim}</strong> dimensions</li>
                    <li>Source: <strong>${sources}</strong></li>
                    <li>Model: <strong>${models}</strong></li>
                    <li><strong>${pointsCount.toLocaleString()}</strong> vectors stored</li>
                </ul>

                <p style="margin: 12px 0 8px 0;"><strong>Your current embedding model:</strong></p>
                <ul style="margin: 0; padding-left: 20px;">
                    <li><strong>${currentDim}</strong> dimensions</li>
                </ul>
            </div>

            <p style="margin-bottom: 16px;">These dimensions don't match. You have two options:</p>

            <div class="vectfox-dimension-options" style="display: flex; flex-direction: column; gap: 12px;">
                <button id="VectFox_dim_fix_purge" class="vectfox-btn-danger" style="padding: 12px; text-align: left;">
                    <i class="fa-solid fa-trash"></i>
                    <strong>Purge collection and start fresh</strong>
                    <br><small style="opacity: 0.8;">Delete all ${pointsCount.toLocaleString()} vectors and re-vectorize with your current model</small>
                </button>

                <button id="VectFox_dim_fix_switch" class="vectfox-btn-secondary" style="padding: 12px; text-align: left;">
                    <i class="fa-solid fa-rotate-left"></i>
                    <strong>I'll switch my embedding model back</strong>
                    <br><small style="opacity: 0.8;">Keep your vectors; change your embedding settings to match (${sources}${models !== '(not recorded)' ? ': ' + models : ''})</small>
                </button>

                <button id="VectFox_dim_fix_cancel" class="vectfox-btn-secondary" style="padding: 12px; text-align: left;">
                    <i class="fa-solid fa-clock"></i>
                    <strong>Hold off for now</strong>
                    <br><small style="opacity: 0.8;">I'll figure it out later</small>
                </button>
            </div>
        </div>
    `;

    // Use callGenericPopup for the dialog
    const { callGenericPopup, POPUP_TYPE } = await import('../../../../popup.js');

    callGenericPopup(dialogHtml, POPUP_TYPE.TEXT, '', {
        okButton: false,
        cancelButton: false,
        wide: false,
        allowVerticalScrolling: true,
    });

    // Bind button handlers
    $('#VectFox_dim_fix_purge').off('click').on('click', async () => {
        // Close popup
        $('.popup-button-close').click();

        // Show confirmation
        const confirmHtml = `
            <p><strong>Are you sure you want to purge the Qdrant collection?</strong></p>
            <p>This will delete all <strong>${pointsCount.toLocaleString()}</strong> vectors permanently.</p>
            <p>You'll need to re-vectorize all your chats, lorebooks, and documents.</p>
        `;

        const confirmed = await callGenericPopup(confirmHtml, POPUP_TYPE.CONFIRM, '', {
            okButton: 'Yes, purge it',
            cancelButton: 'Cancel',
        });

        if (confirmed) {
            toastr.info('Purging Qdrant collection...');
            try {
                const { getRequestHeaders } = await import('../../../../../script.js');
                const response = await fetch('/api/plugins/similharity/backend/qdrant/purge-collection', {
                    method: 'POST',
                    headers: getRequestHeaders(),
                    body: JSON.stringify({ collectionName: 'VectFox_main' })
                });

                if (response.ok) {
                    toastr.success('Qdrant collection purged! You can now re-vectorize your content.');
                    closeDiagnosticsModal();
                } else {
                    const error = await response.text();
                    toastr.error(`Failed to purge: ${error}`);
                }
            } catch (e) {
                toastr.error(`Purge failed: ${e.message}`);
            }
        }
    });

    $('#VectFox_dim_fix_switch').off('click').on('click', () => {
        $('.popup-button-close').click();
        toastr.info(`Switch your embedding provider to "${sources}"${models !== '(not recorded)' ? ` with model "${models}"` : ''} to match your stored vectors.`);
        closeDiagnosticsModal();
        // Scroll to provider settings
        $('#VectFox_provider_settings')[0]?.scrollIntoView({ behavior: 'smooth' });
    });

    $('#VectFox_dim_fix_cancel').off('click').on('click', () => {
        $('.popup-button-close').click();
    });
}

/**
 * Hides diagnostics output
 */
export function hideDiagnosticsResults() {
    $('#VectFox_diagnostics_output').hide();
}
