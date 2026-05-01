/**
 * ============================================================================
 * VECTHARE UI MANAGER
 * ============================================================================
 * Handles ALL UI rendering and event binding
 * Keeps index.js clean and lean
 *
 * @author Coneja Chibi
 * @version 2.2.0-alpha
 * ============================================================================
 */

import { saveSettingsDebounced, getCurrentChatId, eventSource, event_types } from '../../../../../script.js';
import { extension_settings, openThirdPartyExtensionMenu } from '../../../../extensions.js';
import { writeSecret, SECRET_KEYS, secret_state, readSecretState } from '../../../../secrets.js';
import { getWebLlmProvider as getSharedWebLlmProvider } from '../providers/webllm.js';
import { openVisualizer } from './chunk-visualizer.js';
import { openDatabaseBrowser } from './database-browser.js';
import { openContentVectorizer } from './content-vectorizer.js';
import { openSearchDebugModal, getLastSearchDebug } from './search-debug.js';
import { openTextCleaningManager } from './text-cleaning-manager.js';
import { resetBackendHealth } from '../backends/backend-manager.js';
import { getHealthIndicatorHtml, getHealthModalHtml, initializeHealthDashboard } from './health-dashboard.js';
import { getChatCollectionId } from '../core/chat-vectorization.js';
import { doesChatHaveVectors } from '../core/collection-loader.js';
import { getModelField } from '../core/providers.js';
import { getChunkingStrategies } from '../core/content-types.js';

/**
 * Renders the VectHare settings UI
 * @param {string} containerId - The container element ID to render into
 * @param {object} settings - VectHare settings object
 * @param {object} callbacks - Object containing callback functions
 * @param {Function} callbacks.onVectorizeAll - Called when "Vectorize All" is clicked
 * @param {Function} callbacks.onPurge - Called when "Purge" is clicked
 * @param {Function} callbacks.onRunDiagnostics - Called when "Run Diagnostics" is clicked
 */
export function renderSettings(containerId, settings, callbacks) {
    console.log('VectHare UI: Rendering settings...');

    const html = `
        <div id="vecthare_settings">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>VectHare - Advanced RAG</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">

                    <!-- Core Settings Card -->
                    <div class="vecthare-card">
                        <div class="vecthare-card-header">
                            <h3 class="vecthare-card-title">
                                <span class="vecthare-icon">
                                    <i class="fa-solid fa-cog"></i>
                                </span>
                                Core Settings
                            </h3>
                            <p class="vecthare-card-subtitle">Configure embedding provider and vectorization parameters</p>
                        </div>
                        <div class="vecthare-card-body">

                            <label for="vecthare_vector_backend">
                                <small>Vector Backend</small>
                            </label>
                            <select id="vecthare_vector_backend" class="vecthare-select">
                                <option value="standard">Standard (ST's Vectra - file-based)</option>
                                <option value="lancedb">LanceDB (disk-based, scalable)</option>
                                <option value="qdrant">Qdrant (production vector search)</option>
                                <option value="milvus">Milvus (popular open source engine)</option>
                            </select>
                            <small class="vecthare-help-text" style="display: block; margin-top: -8px; margin-bottom: 16px; opacity: 0.7; font-size: 0.85em; line-height: 1.5;">
                                • Standard: ST's built-in Vectra (best for <100k vectors)<br>
                                • LanceDB: Disk-based, handles millions of vectors (requires plugin)<br>
                                • Qdrant: Production-grade with HNSW, filtering, cloud support<br>
                                • Milvus: High-performance, scalable vector database
                            </small>

                            <!-- Qdrant Settings (shown only when Qdrant backend is selected) -->
                            <div id="vecthare_qdrant_settings" style="display: none;">
                                <label class="checkbox_label">
                                    <input type="checkbox" id="vecthare_qdrant_use_cloud" />
                                    <span>Use Qdrant Cloud</span>
                                </label>

                                <!-- Local Qdrant Settings -->
                                <div id="vecthare_qdrant_local_settings">
                                    <label for="vecthare_qdrant_host">
                                        <small>Qdrant Host:</small>
                                    </label>
                                    <input type="text" id="vecthare_qdrant_host" class="vecthare-input" placeholder="localhost" />

                                    <label for="vecthare_qdrant_port">
                                        <small>Qdrant Port:</small>
                                    </label>
                                    <input type="number" id="vecthare_qdrant_port" class="vecthare-input" placeholder="6333" />
                                </div>

                                <!-- Cloud Qdrant Settings -->
                                <div id="vecthare_qdrant_cloud_settings" style="display: none;">
                                    <label for="vecthare_qdrant_url">
                                        <small>Qdrant Cloud URL:</small>
                                    </label>
                                    <input type="text" id="vecthare_qdrant_url" class="vecthare-input" placeholder="https://xxx.cloud.qdrant.io" />

                                    <label for="vecthare_qdrant_api_key">
                                        <small>API Key:</small>
                                    </label>
                                    <input type="password" id="vecthare_qdrant_api_key" class="vecthare-input" placeholder="Your Qdrant Cloud API key" />
                                </div>

                                <!-- Qdrant Multitenancy Setting -->
                                <div style="margin-top: 10px; padding: 8px; background: rgba(0,0,0,0.1); border-radius: 4px;">
                                    <label class="checkbox_label" title="When enabled, uses a single Qdrant collection with content_type filtering (multitenancy). When disabled, creates separate collections for each content type (better isolation).">
                                        <input type="checkbox" id="vecthare_qdrant_multitenancy" />
                                        <span>Use Multitenancy (Single Collection)</span>
                                    </label>
                                    <small class="vecthare_hint" style="display: block; margin-top: 4px;">
                                        <strong>Multitenancy ON:</strong> Single collection with filtering (saves resources)<br>
                                        <strong>Multitenancy OFF:</strong> Separate collections per content type (better isolation)
                                    </small>
                                </div>
                            </div>

                            <!-- Milvus Settings (shown only when Milvus backend is selected) -->
                            <div id="vecthare_milvus_settings" style="display: none;">
                                <label for="vecthare_milvus_host">
                                    <small>Milvus Host:</small>
                                </label>
                                <input type="text" id="vecthare_milvus_host" class="vecthare-input" placeholder="localhost" />

                                <label for="vecthare_milvus_port">
                                    <small>Milvus Port:</small>
                                </label>
                                <input type="number" id="vecthare_milvus_port" class="vecthare-input" placeholder="19530" />

                                <label for="vecthare_milvus_address">
                                    <small>Full Address (Optional):</small>
                                </label>
                                <input type="text" id="vecthare_milvus_address" class="vecthare-input" placeholder="http://localhost:19530" />
                                <small class="vecthare_hint">Overrides Host/Port if set (e.g. for cloud instances)</small>

                                <label for="vecthare_milvus_username">
                                    <small>Username (Optional):</small>
                                </label>
                                <input type="text" id="vecthare_milvus_username" class="vecthare-input" />

                                <label for="vecthare_milvus_password">
                                    <small>Password (Optional):</small>
                                </label>
                                <input type="password" id="vecthare_milvus_password" class="vecthare-input" />

                                <label for="vecthare_milvus_token">
                                    <small>API Token (Optional):</small>
                                </label>
                                <input type="password" id="vecthare_milvus_token" class="vecthare-input" placeholder="For cloud instances" />

                                <label for="vecthare_milvus_dimensions">
                                    <small>Embedding Dimensions:</small>
                                </label>
                                <input type="number" id="vecthare_milvus_dimensions" class="vecthare-input" placeholder="Auto (768)" min="1" />
                                <small class="vecthare_hint">Manually set dimension size if auto-detection fails (e.g. 1536, 4096). Required for some models on first run.</small>
                            </div>

                            <label for="vecthare_source">
                                <small>Embedding Provider</small>
                            </label>
                            <select id="vecthare_source" class="vecthare-select">
                            <option value="transformers">Transformers (Local)</option>
                            <option value="bananabread">BananaBread</option>
                            <option value="openai">OpenAI</option>
                            <option value="ollama">Ollama</option>
                            <option value="cohere">Cohere</option>
                            <option value="togetherai">Together AI</option>
                            <option value="extras">Extras API</option>
                            <option value="electronhub">ElectronHub</option>
                            <option value="openrouter">OpenRouter</option>
                            <option value="llamacpp">LlamaCPP</option>
                            <option value="vllm">vLLM</option>
                            <option value="koboldcpp">KoboldCPP</option>
                            <option value="webllm">WebLLM</option>
                            <option value="palm">Google PaLM</option>
                            <option value="vertexai">Google VertexAI</option>
                            <option value="mistral">Mistral AI</option>
                            <option value="nomicai">Nomic AI</option>
                        </select>

                        <!-- Provider-Specific Settings -->
                        <div id="vecthare_provider_settings">

                            <!-- ElectronHub Model -->
                            <div class="vecthare_provider_setting" data-provider="electronhub">
                                <label for="vecthare_electronhub_model">
                                    <small>ElectronHub Model:</small>
                                </label>
                                <input type="text" id="vecthare_electronhub_model" class="vecthare-input" placeholder="text-embedding-3-small" />
                                <small class="vecthare_hint">Enter ElectronHub-compatible model ID (e.g., text-embedding-3-small, text-embedding-3-large)</small>
                            </div>

                            <!-- Alternative Endpoint (for local providers) -->
                            <div class="vecthare_provider_setting" data-provider="ollama,vllm,llamacpp,koboldcpp,bananabread">
                                <label class="checkbox_label">
                                    <input type="checkbox" id="vecthare_use_alt_endpoint" />
                                    <span>Use Alternative Endpoint</span>
                                </label>
                                <input type="text" id="vecthare_alt_endpoint_url" class="vecthare-input" placeholder="http://localhost:11434" />
                                <small class="vecthare_hint">Override default API URL for this provider</small>
                            </div>

                            <!-- BananaBread Info & Reranking -->
                            <div class="vecthare_provider_setting" data-provider="bananabread">
                                <small class="vecthare_info">
                                    <i class="fa-solid fa-info-circle"></i>
                                    BananaBread default: http://localhost:8008. Supports MixedBread AI and Qwen3 embedding models.
                                </small>
                                <label class="checkbox_label" style="margin-top: 8px;">
                                    <input type="checkbox" id="vecthare_bananabread_rerank" />
                                    <span>Enable Reranking</span>
                                </label>
                                <small class="vecthare_hint">Re-score results using BananaBread's reranker for better relevance</small>
                                <label for="vecthare_bananabread_apikey" style="margin-top: 8px;">
                                    <small>BananaBread API Key:</small>
                                </label>
                                <input type="password" id="vecthare_bananabread_apikey" class="vecthare-input" placeholder="Paste key here to save..." autocomplete="off" />
                            </div>

                            <!-- WebLLM Model -->
                            <div class="vecthare_provider_setting" data-provider="webllm">
                                <small class="vecthare_info" id="vecthare_webllm_status">
                                    <i class="fa-solid fa-spinner fa-spin"></i>
                                    Checking WebLLM availability...
                                </small>
                                <label for="vecthare_webllm_model">
                                    <small>WebLLM Model:</small>
                                </label>
                                <select id="vecthare_webllm_model" class="vecthare-select"></select>
                                <div style="display: flex; gap: 8px; margin-top: 8px;">
                                    <button id="vecthare_webllm_load" class="menu_button">
                                        <i class="fa-solid fa-download"></i> Load Model
                                    </button>
                                    <button id="vecthare_webllm_install" class="menu_button menu_button_icon">
                                        <i class="fa-solid fa-puzzle-piece"></i> Install Extension
                                    </button>
                                </div>
                                <small class="vecthare_hint">WebLLM requires the WebLLM extension and a WebGPU-compatible browser (Chrome 113+, Edge 113+)</small>
                            </div>

                            <!-- Ollama Model -->
                            <div class="vecthare_provider_setting" data-provider="ollama">
                                <label for="vecthare_ollama_model">
                                    <small>Ollama Model:</small>
                                </label>
                                <input type="text" id="vecthare_ollama_model" class="vecthare-input" placeholder="mxbai-embed-large" />
                                <label class="checkbox_label">
                                    <input type="checkbox" id="vecthare_ollama_keep" />
                                    <span>Keep Model in Memory</span>
                                </label>
                                <small class="vecthare_hint">Enter the model name from your local Ollama installation</small>
                            </div>

                            <!-- KoboldCPP Info -->
                            <div class="vecthare_provider_setting" data-provider="koboldcpp">
                                <small class="vecthare_info">
                                    <i class="fa-solid fa-info-circle"></i>
                                    KoboldCPP uses the currently loaded model for embeddings. Ensure your model supports embeddings.
                                </small>
                            </div>

                            <!-- LlamaCPP Info -->
                            <div class="vecthare_provider_setting" data-provider="llamacpp">
                                <small class="vecthare_info">
                                    <i class="fa-solid fa-info-circle"></i>
                                    LlamaCPP requires the --embedding flag to be enabled. Restart your server with this flag if not already set.
                                </small>
                            </div>

                            <!-- OpenAI Model -->
                            <div class="vecthare_provider_setting" data-provider="openai">
                                <label for="vecthare_openai_model">
                                    <small>OpenAI Model:</small>
                                </label>
                                <select id="vecthare_openai_model" class="vecthare-select">
                                    <option value="text-embedding-ada-002">text-embedding-ada-002</option>
                                    <option value="text-embedding-3-small">text-embedding-3-small</option>
                                    <option value="text-embedding-3-large">text-embedding-3-large</option>
                                </select>
                            </div>

                            <!-- Cohere Model -->
                            <div class="vecthare_provider_setting" data-provider="cohere">
                                <label for="vecthare_cohere_model">
                                    <small>Cohere Model:</small>
                                </label>
                                <select id="vecthare_cohere_model" class="vecthare-select">
                                    <option value="embed-english-v3.0">embed-english-v3.0</option>
                                    <option value="embed-multilingual-v3.0">embed-multilingual-v3.0</option>
                                    <option value="embed-english-light-v3.0">embed-english-light-v3.0</option>
                                    <option value="embed-multilingual-light-v3.0">embed-multilingual-light-v3.0</option>
                                    <option value="embed-english-v2.0">embed-english-v2.0</option>
                                    <option value="embed-english-light-v2.0">embed-english-light-v2.0</option>
                                    <option value="embed-multilingual-v2.0">embed-multilingual-v2.0</option>
                                    <option value="embed-multilingual-light-v2.0">embed-multilingual-light-v2.0</option>
                                </select>
                            </div>

                            <!-- TogetherAI Model -->
                            <div class="vecthare_provider_setting" data-provider="togetherai">
                                <label for="vecthare_togetherai_model">
                                    <small>Together AI Model:</small>
                                </label>
                                <select id="vecthare_togetherai_model" class="vecthare-select">
                                    <option value="togethercomputer/m2-bert-80M-32k-retrieval">togethercomputer/m2-bert-80M-32k-retrieval</option>
                                    <option value="togethercomputer/m2-bert-80M-8k-retrieval">togethercomputer/m2-bert-80M-8k-retrieval</option>
                                    <option value="togethercomputer/m2-bert-80M-2k-retrieval">togethercomputer/m2-bert-80M-2k-retrieval</option>
                                    <option value="WhereIsAI/UAE-Large-V1">WhereIsAI/UAE-Large-V1</option>
                                    <option value="BAAI/bge-large-en-v1.5">BAAI/bge-large-en-v1.5</option>
                                    <option value="BAAI/bge-base-en-v1.5">BAAI/bge-base-en-v1.5</option>
                                    <option value="sentence-transformers/msmarco-bert-base-dot-v5">sentence-transformers/msmarco-bert-base-dot-v5</option>
                                    <option value="bert-base-uncased">bert-base-uncased</option>
                                </select>
                            </div>

                            <!-- vLLM Model -->
                            <div class="vecthare_provider_setting" data-provider="vllm">
                                <label for="vecthare_vllm_model">
                                    <small>vLLM Model:</small>
                                </label>
                                <input type="text" id="vecthare_vllm_model" class="vecthare-input" placeholder="Model name" />
                                <small class="vecthare_hint">Enter the model name from your vLLM deployment</small>
                            </div>

                            <!-- Google Model (PaLM/VertexAI) -->
                            <div class="vecthare_provider_setting" data-provider="palm,vertexai">
                                <label for="vecthare_google_model">
                                    <small>Google Model:</small>
                                </label>
                                <select id="vecthare_google_model" class="vecthare-select">
                                    <option value="text-embedding-005">text-embedding-005</option>
                                    <option value="text-embedding-004">text-embedding-004</option>
                                    <option value="text-multilingual-embedding-002">text-multilingual-embedding-002</option>
                                    <option value="textembedding-gecko">textembedding-gecko</option>
                                    <option value="textembedding-gecko-multilingual">textembedding-gecko-multilingual</option>
                                </select>
                            </div>

                            <!-- NomicAI API Key -->
                            <div class="vecthare_provider_setting" data-provider="nomicai">
                                <button id="vecthare_nomicai_api_key" class="menu_button">
                                    <i class="fa-solid fa-key"></i> Set Nomic API Key
                                </button>
                                <small class="vecthare_hint">Configure your Nomic API key in SillyTavern settings</small>
                            </div>

                            <!-- OpenRouter Model -->
                            <div class="vecthare_provider_setting" data-provider="openrouter">
                                <label for="vecthare_openrouter_model">
                                    <small>OpenRouter Model:</small>
                                </label>
                                <input type="text" id="vecthare_openrouter_model" class="vecthare-input" placeholder="openai/text-embedding-3-large" />
                                <small class="vecthare_hint">Enter OpenRouter-compatible model ID</small>
                                <label for="vecthare_openrouter_apikey" style="margin-top: 8px;">
                                    <small>OpenRouter API Key:</small>
                                </label>
                                <input type="password" id="vecthare_openrouter_apikey" class="vecthare-input" placeholder="Paste key here to save..." autocomplete="off" />
                            </div>

                        </div>

                            <!-- API Rate Limiting -->
                            <div class="vecthare-setting-group" style="margin-top: 16px; margin-bottom: 16px; padding-top: 16px; border-top: 1px solid var(--grey30);">
                                <label>
                                    <small>API Rate Limiting (0 to disable)</small>
                                </label>
                                <div style="display: flex; gap: 10px;">
                                    <div style="flex: 1;">
                                        <label for="vecthare_rate_limit_calls" style="display: block; margin-bottom: 4px;">
                                            <small>Max Calls</small>
                                        </label>
                                        <input type="number" id="vecthare_rate_limit_calls" class="vecthare-input" min="0" placeholder="5" />
                                    </div>
                                    <div style="flex: 1;">
                                        <label for="vecthare_rate_limit_interval" style="display: block; margin-bottom: 4px;">
                                            <small>Interval (sec)</small>
                                        </label>
                                        <input type="number" id="vecthare_rate_limit_interval" class="vecthare-input" min="1" placeholder="60" />
                                    </div>
                                </div>
                                <small class="vecthare_hint">Limit the number of API requests per time interval</small>
                            </div>

                            <label for="vecthare_insert_batch_size">
                                <small>Insert Batch Size: <span id="vecthare_insert_batch_size_value">50</span></small>
                            </label>
                            <input type="range" id="vecthare_insert_batch_size" class="vecthare-slider" min="10" max="100" step="10" />
                            <small class="vecthare_hint">Chunks per insert batch (50-100 recommended for faster bulk operations)</small>

                            <label for="vecthare_min_chat_length" style="margin-top: 16px;">
                                <small>Minimum Messages Before Injection</small>
                            </label>
                            <input type="number" id="vecthare_min_chat_length" class="vecthare-input" min="0" max="100" step="1" placeholder="0" />
                            <small class="vecthare_hint">Minimum number of messages in chat before RAG injection starts (0 = inject immediately)</small>

                            <label for="vecthare_score_threshold">
                                <small>Similarity Threshold: <span id="vecthare_threshold_value">0.25</span></small>
                            </label>
                            <input type="range" id="vecthare_score_threshold" class="vecthare-slider" min="0" max="1" step="0.05" />
                            <small class="vecthare_hint">Minimum relevance score for retrieval</small>

                            <!-- Keyword Scoring Method -->
                            <label style="margin-top: 16px;">
                                <small>Keyword Scoring Method</small>
                            </label>
                            <select id="vecthare_keyword_scoring_method" class="vecthare-select">
                                <option value="keyword">Keyword Boost</option>
                                <option value="bm25">BM25 (Langchain)</option>
                                <option value="hybrid">Hybrid (Both)</option>
                            </select>
                            <small class="vecthare_hint">Algorithm for keyword-based relevance scoring</small>

                            <!-- BM25 Parameters (shown when BM25 or Hybrid is selected) -->
                            <div id="vecthare_bm25_params" style="display: none; margin-top: 12px; padding: 12px; background: rgba(0,0,0,0.1); border-radius: 8px;">
                                <label for="vecthare_bm25_k1">
                                    <small>BM25 k1 (TF saturation): <span id="vecthare_bm25_k1_value">1.5</span></small>
                                </label>
                                <input type="range" id="vecthare_bm25_k1" class="vecthare-slider" min="0.5" max="3.0" step="0.1" />
                                <small class="vecthare_hint">Controls term frequency saturation (1.2-2.0 typical)</small>

                                <label for="vecthare_bm25_b" style="margin-top: 8px;">
                                    <small>BM25 b (Length norm): <span id="vecthare_bm25_b_value">0.75</span></small>
                                </label>
                                <input type="range" id="vecthare_bm25_b" class="vecthare-slider" min="0" max="1" step="0.05" />
                                <small class="vecthare_hint">Controls document length normalization (0.75 typical)</small>
                            </div>

                            <!-- Hybrid Search (Vector + Full-Text) -->
                            <div style="margin-top: 16px; padding: 12px; background: rgba(0,100,200,0.1); border-radius: 8px; border: 1px solid rgba(0,100,200,0.2);">
                                <label class="checkbox_label" for="vecthare_hybrid_search_enabled" style="margin-bottom: 8px;">
                                    <input id="vecthare_hybrid_search_enabled" type="checkbox" />
                                    <span><small><b>Enable Hybrid Search</b></small></span>
                                </label>
                                <small class="vecthare_hint">Combines vector similarity with full-text (BM25) search using rank fusion</small>

                                <div id="vecthare_hybrid_params" style="display: none; margin-top: 12px;">
                                    <label style="margin-top: 8px;">
                                        <small>Fusion Method</small>
                                    </label>
                                    <select id="vecthare_hybrid_fusion_method" class="vecthare-select">
                                        <option value="rrf">RRF (Reciprocal Rank Fusion)</option>
                                        <option value="weighted">Weighted Linear Combination</option>
                                    </select>
                                    <small class="vecthare_hint">RRF is parameter-free and robust; Weighted allows fine-tuning</small>

                                    <div id="vecthare_hybrid_weights" style="display: none; margin-top: 12px;">
                                        <label for="vecthare_hybrid_vector_weight">
                                            <small>Vector Weight: <span id="vecthare_hybrid_vector_weight_value">0.5</span></small>
                                        </label>
                                        <input type="range" id="vecthare_hybrid_vector_weight" class="vecthare-slider" min="0" max="1" step="0.1" />

                                        <label for="vecthare_hybrid_text_weight" style="margin-top: 8px;">
                                            <small>Text Weight: <span id="vecthare_hybrid_text_weight_value">0.5</span></small>
                                        </label>
                                        <input type="range" id="vecthare_hybrid_text_weight" class="vecthare-slider" min="0" max="1" step="0.1" />
                                    </div>

                                    <div id="vecthare_hybrid_rrf_settings" style="margin-top: 12px;">
                                        <label for="vecthare_hybrid_rrf_k">
                                            <small>RRF K Constant: <span id="vecthare_hybrid_rrf_k_value">60</span></small>
                                        </label>
                                        <input type="range" id="vecthare_hybrid_rrf_k" class="vecthare-slider" min="1" max="100" step="1" />
                                        <small class="vecthare_hint">Higher K = more weight to top-ranked results (60 is typical)</small>
                                    </div>

                                    <label class="checkbox_label" for="vecthare_hybrid_native_prefer" style="margin-top: 12px;">
                                        <input id="vecthare_hybrid_native_prefer" type="checkbox" checked />
                                        <span><small>Prefer Native Backend Hybrid</small></span>
                                    </label>
                                    <small class="vecthare_hint">Use Qdrant/Milvus native hybrid if available (faster)</small>
                                </div>
                            </div>

                            <!-- Custom Stopwords -->
                            <div style="margin-top: 16px; padding: 12px; background: rgba(100,100,100,0.1); border-radius: 8px;">
                                <label for="vecthare_custom_stopwords">
                                    <small><b>Custom Stopwords</b></small>
                                </label>
                                <textarea id="vecthare_custom_stopwords" class="vecthare-textarea" rows="2"
                                    placeholder="{{char}}, {{user}}, character, scene, location..."
                                    style="margin-top: 4px;"></textarea>
                                <small class="vecthare_hint">Words to exclude from keyword extraction. Supports ST macros: {{char}}, {{user}}, {{charIfNotGroup}}, etc.</small>
                            </div>

                            <label for="vecthare_query_depth" style="margin-top: 12px;">
                                <small>Query Depth: <span id="vecthare_query_depth_value">2</span> messages</small>
                            </label>
                            <input type="range" id="vecthare_query_depth" class="vecthare-slider" min="1" max="20" step="1" />
                            <small class="vecthare_hint">How many recent messages to include in search query</small>

                            <label for="vecthare_deduplication_depth" style="margin-top: 12px;">
                                <small>Dedup Depth: <span id="vecthare_deduplication_depth_value">50</span> messages</small>
                            </label>
                            <input type="range" id="vecthare_deduplication_depth" class="vecthare-slider" min="0" max="500" step="10" />
                            <small class="vecthare_hint">Recent messages to check for duplicates (0 = check all, lower = allow older content to resurface)</small>

                            <div style="margin-top:8px; display:flex; gap:8px; align-items:center;">
                                <label for="vecthare_topk" style="margin:0; white-space:nowrap;"><small>Top K</small></label>
                                <input id="vecthare_topk" type="number" class="vecthare-input" min="1" style="width:90px;" />
                                <small class="vecthare_hint" style="margin-left:8px;">Number of results to retrieve per collection</small>
                            </div>

                            <label style="margin-top: 16px;">
                                <small>Injection Position</small>
                            </label>
                            <select id="vecthare_injection_position" class="vecthare-select">
                                <option value="2">Before Main Prompt</option>
                                <option value="0">After Main Prompt</option>
                                <option value="1">In-Chat @ Depth</option>
                            </select>
                            <small class="vecthare_hint">Where retrieved chunks appear in the prompt</small>

                            <div id="vecthare_injection_depth_row" style="margin-top: 12px; display: none;">
                                <label for="vecthare_injection_depth">
                                    <small>Injection Depth: <span id="vecthare_injection_depth_value">2</span></small>
                                </label>
                                <input type="range" id="vecthare_injection_depth" class="vecthare-slider" min="0" max="50" step="1" />
                                <small class="vecthare_hint">Messages from end of chat to insert at</small>
                            </div>

                        </div>
                    </div>

                    <!-- Global Temporal Weighting Defaults Card -->
                    <div class="vecthare-card">
                        <div class="vecthare-card-header">
                            <h3 class="vecthare-card-title">
                                <span class="vecthare-icon">
                                    <i class="fa-solid fa-clock"></i>
                                </span>
                                Temporal Weighting Defaults
                            </h3>
                            <p class="vecthare-card-subtitle">Default settings for new collections (can be overridden per-collection)</p>
                        </div>
                        <div class="vecthare-card-body">

                            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 12px;">
                                <input type="checkbox" id="vecthare_default_decay_enabled" />
                                <label for="vecthare_default_decay_enabled" style="margin: 0;">
                                    <small>Enable temporal weighting by default</small>
                                </label>
                            </div>

                            <div id="vecthare_default_decay_type_section" class="vecthare-subsection-disabled">
                                <label style="margin-bottom: 4px;">
                                    <small>Default Type</small>
                                </label>
                                <div style="display: flex; gap: 12px; margin-bottom: 12px;">
                                    <label style="display: flex; align-items: center; gap: 4px; margin: 0;">
                                        <input type="radio" name="vecthare_default_decay_type" value="decay" />
                                        <small>Decay (favor recent)</small>
                                    </label>
                                    <label style="display: flex; align-items: center; gap: 4px; margin: 0;">
                                        <input type="radio" name="vecthare_default_decay_type" value="nostalgia" />
                                        <small>Nostalgia (favor old)</small>
                                    </label>
                                </div>
                            </div>

                            <small class="vecthare_hint">These defaults apply to newly created collections. Existing collections keep their settings.</small>

                        </div>
                    </div>

                    <!-- RAG Context Card -->
                    <div class="vecthare-card">
                        <div class="vecthare-card-header">
                            <h3 class="vecthare-card-title">
                                <span class="vecthare-icon">
                                    <i class="fa-solid fa-quote-left"></i>
                                </span>
                                RAG Context
                            </h3>
                            <p class="vecthare-card-subtitle">Add context prompts to help the AI understand retrieved content</p>
                        </div>
                        <div class="vecthare-card-body">

                            <label for="vecthare_rag_context">
                                <small>Global Context Prompt</small>
                            </label>
                            <textarea id="vecthare_rag_context" class="vecthare-textarea" rows="3" placeholder="e.g., The following information may be relevant to your conversation with {{user}}:"></textarea>
                            <small class="vecthare_hint">Shown before all RAG content. Supports {{user}} and {{char}} variables.</small>

                            <label for="vecthare_rag_xml_tag" style="margin-top: 12px;">
                                <small>Global XML Tag (optional)</small>
                            </label>
                            <input type="text" id="vecthare_rag_xml_tag" class="vecthare-input" placeholder="e.g., retrieved_context" />
                            <small class="vecthare_hint">Wraps all RAG content in &lt;tag&gt;...&lt;/tag&gt;. Leave empty for no wrapping.</small>

                            <div class="vecthare_info" style="margin-top: 16px; padding: 8px 12px; border-radius: 4px; background: var(--SmartThemeBlurTintColor); font-size: 0.85em;">
                                <i class="fa-solid fa-info-circle"></i>
                                <span>Collection and chunk-level context can be set in the Database Browser and Chunk Visualizer respectively.</span>
                            </div>

                        </div>
                        </div>

                        <!-- World Info Settings Card -->
                        <div class="vecthare-card">
                            <div class="vecthare-card-header">
                                <h3 class="vecthare-card-title">
                                    <span class="vecthare-icon">
                                        <i class="fa-solid fa-globe"></i>
                                    </span>
                                    World Info settings
                                </h3>
                                <p class="vecthare-card-subtitle">Semantic activation of World Info entries from vectorized lorebooks</p>
                            </div>
                            <div class="vecthare-card-body">
                                <label class="checkbox_label" for="vecthare_enabled_world_info" title="Enable semantic activation of World Info entries from vectorized lorebooks based on chat context similarity.">
                                    <input id="vecthare_enabled_world_info" type="checkbox" class="checkbox">
                                    <span>Enable Semantic WI Activation</span>
                                </label>

                                <div id="vecthare_world_info_settings" style="margin-top:10px; display:none;">
                                    <small style="display:block; margin-bottom:8px; opacity:0.85;">
                                        Activates World Info entries from <strong>vectorized lorebooks</strong> based on semantic similarity to recent chat messages. Complements keyword-based activation.
                                    </small>

                                    <div style="display:flex; gap:12px;">
                                        <div style="flex:1;">
                                            <label for="vecthare_world_info_threshold"><small>Score Threshold</small></label>
                                            <input id="vecthare_world_info_threshold" type="number" class="vecthare-input" min="0" max="1" step="0.01" />
                                        </div>
                                        <div style="flex:1;">
                                            <label for="vecthare_world_info_top_k"><small>Top-K per Lorebook</small></label>
                                            <input id="vecthare_world_info_top_k" type="number" class="vecthare-input" min="1" max="20" />
                                        </div>
                                        <div style="flex:1;">
                                            <label for="vecthare_world_info_query_depth"><small>Query Depth</small></label>
                                            <input id="vecthare_world_info_query_depth" type="number" class="vecthare-input" min="1" max="10" />
                                        </div>
                                    </div>

                                    <div style="margin-top:10px;">
                                        <label for="vecthare_wi_test_input"><small>Test Messages (one per line)</small></label>
                                        <textarea id="vecthare_wi_test_input" class="vecthare-textarea" rows="3" placeholder="Enter test messages, one per line..."></textarea>
                                        <div style="display:flex; gap:8px; margin-top:8px;">
                                            <button id="vecthare_wi_test_btn" class="vecthare-btn-secondary">Test Semantic WI</button>
                                            <button id="vecthare_wi_dump_registry" class="vecthare-btn-secondary">Dump Registry</button>
                                            <button id="vecthare_wi_apply_first" class="vecthare-btn-primary">Apply First Semantic Hit</button>
                                        </div>
                                    </div>

                                    <div style="margin-top:10px; display:flex; gap:12px; align-items:center;">
                                        <label class="checkbox_label" for="vecthare_enabled_for_all">
                                            <input id="vecthare_enabled_for_all" type="checkbox" />
                                            <span>Enabled for all entries</span>
                                        </label>
                                        <div style="flex:1"></div>
                                        <div style="width:160px;">
                                            <label for="vecthare_max_entries"><small>Max Entries</small></label>
                                            <input id="vecthare_max_entries" type="number" class="vecthare-input" min="1" max="9999" />
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <!-- Chat Auto-Sync Card -->
                    <div class="vecthare-card">
                        <div class="vecthare-card-header">
                            <h3 class="vecthare-card-title">
                                <span class="vecthare-icon">
                                    <i class="fa-solid fa-comments"></i>
                                </span>
                                Chat Auto-Sync
                            </h3>
                            <p class="vecthare-card-subtitle">Configure how chat messages are vectorized</p>
                        </div>
                        <div class="vecthare-card-body">

                            <label class="checkbox_label" for="vecthare_autosync_enabled">
                                <input type="checkbox" id="vecthare_autosync_enabled" />
                                <span>Enable Auto-Sync</span>
                            </label>
                            <small class="vecthare_hint">Automatically vectorize new chat messages</small>

                            <!-- Collection lock moved to Database Browser (per-collection settings) -->

                            <label for="vecthare_chunking_strategy" style="margin-top: 12px;">
                                <small>Chunking Strategy</small>
                            </label>
                            <select id="vecthare_chunking_strategy" class="vecthare-select">
                                <!-- Populated dynamically from content-types.js -->
                            </select>

                            <!-- Strategy description (populated dynamically) -->
                            <div id="vecthare_strategy_info" class="vecthare_hint" style="margin-top: 4px; margin-bottom: 12px;">
                                <span id="vecthare_strategy_description"></span>
                            </div>

                            <!-- Message Batch settings (only shown for message_batch strategy) -->
                            <div id="vecthare_batch_settings" style="display: none;">
                                <label for="vecthare_batch_size">
                                    <small>Messages per Batch: <span id="vecthare_batch_size_value">4</span></small>
                                </label>
                                <input type="range" id="vecthare_batch_size" class="vecthare-slider" min="2" max="10" step="1" />
                                <small class="vecthare_hint">How many messages to group together</small>
                            </div>

                        </div>
                    </div>

                    <!-- Summarization Card -->
                    <div class="vecthare-card">
                        <div class="vecthare-card-header">
                            <h3 class="vecthare-card-title">
                                <span class="vecthare-icon">
                                    <i class="fa-solid fa-file-lines"></i>
                                </span>
                                Summarize Before Store
                            </h3>
                            <p class="vecthare-card-subtitle">Condense each message to a 3-5 sentence summary before embedding</p>
                        </div>
                        <div class="vecthare-card-body">

                            <label for="vecthare_summarize_provider">
                                <small>Summarization Provider</small>
                            </label>
                            <select id="vecthare_summarize_provider" class="vecthare-select">
                                <option value="off">Off</option>
                                <option value="openrouter">OpenRouter</option>
                                <option value="vllm">vLLM</option>
                            </select>
                            <small class="vecthare_hint">Provider used for summarization LLM calls</small>

                            <div id="vecthare_summarize_settings" style="display:none; margin-top:12px;">

                                <div id="vecthare_summarize_vllm_url_row" style="display:none; margin-bottom:10px;">
                                    <label for="vecthare_summarize_vllm_url">
                                        <small>vLLM Base URL</small>
                                    </label>
                                    <input type="text" id="vecthare_summarize_vllm_url" class="vecthare-input"
                                        placeholder="http://localhost:8000" />
                                    <small class="vecthare_hint">Base URL of your vLLM server (OpenAI-compatible)</small>
                                </div>

                                <label for="vecthare_summarize_model">
                                    <small>Summarization Model</small>
                                </label>
                                <input type="text" id="vecthare_summarize_model" class="vecthare-input"
                                    placeholder="e.g. google/gemini-flash-1.5-8b" />
                                <small class="vecthare_hint">Model ID for summarization (separate from embedding model)</small>

                                <label for="vecthare_summarize_prompt" style="margin-top:12px;">
                                    <small>Summarization Prompt</small>
                                </label>
                                <textarea id="vecthare_summarize_prompt" class="vecthare-textarea" rows="8"
                                    placeholder="Leave empty to use built-in default prompt"
                                    style="margin-top:4px; font-size:11px;"></textarea>
                                <small class="vecthare_hint">Use <code>{{text}}</code> as placeholder for the story text. Leave empty for built-in default.</small>

                                <div style="margin-top:10px; padding:8px; background:rgba(255,200,0,0.08); border-left:3px solid rgba(255,200,0,0.4); border-radius:4px;">
                                    <small>⚠ Each new message stored will make one additional LLM call. Use a fast, cheap model.</small>
                                </div>

                            </div>

                        </div>
                    </div>

                    <!-- Actions Card -->
                    <div class="vecthare-card">
                        <div class="vecthare-card-header">
                            <h3 class="vecthare-card-title">
                                <span class="vecthare-icon">
                                    <i class="fa-solid fa-bolt"></i>
                                </span>
                                Actions
                            </h3>
                            <p class="vecthare-card-subtitle">Manage your vector database</p>
                        </div>
                        <div class="vecthare-card-body">

                            <div class="vecthare-actions-grid">
                                <button id="vecthare_vectorize_content" class="vecthare-action-btn vecthare-btn-primary vecthare-action-featured">
                                    <i class="fa-solid fa-plus-circle"></i>
                                    <span>Vectorize Content</span>
                                </button>
                                <button id="vecthare_vectorize_all" class="vecthare-action-btn vecthare-btn-secondary">
                                    <i class="fa-solid fa-sync"></i>
                                    <span>Sync Chat</span>
                                </button>
                                <button id="vecthare_database_browser" class="vecthare-action-btn vecthare-btn-secondary">
                                    <i class="fa-solid fa-folder-open"></i>
                                    <span>Database Browser</span>
                                </button>
                                <button id="vecthare_run_diagnostics" class="vecthare-action-btn vecthare-btn-secondary">
                                    <i class="fa-solid fa-stethoscope"></i>
                                    <span>Diagnostics</span>
                                </button>
                                <button id="vecthare_view_results" class="vecthare-action-btn vecthare-btn-secondary">
                                    <i class="fa-solid fa-bug"></i>
                                    <span>Debug Query</span>
                                </button>
                                <button id="vecthare_purge" class="vecthare-action-btn vecthare-btn-danger-outline">
                                    <i class="fa-solid fa-trash"></i>
                                    <span>Purge</span>
                                </button>
                                <button id="vecthare_text_cleaning" class="vecthare-action-btn vecthare-btn-secondary">
                                    <i class="fa-solid fa-broom"></i>
                                    <span>Text Cleaning</span>
                                </button>
                                ${getHealthIndicatorHtml()}
                            </div>

                            <label class="checkbox_label" for="vecthare_include_production_tests" style="margin-top: 20px;">
                                <input type="checkbox" id="vecthare_include_production_tests" />
                                <span>Include Production Tests</span>
                            </label>
                            <small class="vecthare_hint">Tests actual embedding generation, storage, and retrieval (slower but thorough)</small>

                        </div>
                    </div>

                </div>
            </div>
        </div>

        <!-- Diagnostics Modal -->
        <div id="vecthare_diagnostics_modal" class="vecthare-modal" style="display: none;">
            <div class="vecthare-modal-overlay"></div>
            <div class="vecthare-modal-content vecthare-diagnostics-modal">
                <div class="vecthare-modal-header">
                    <h3>
                        <i class="fa-solid fa-stethoscope"></i>
                        <span id="vecthare_diagnostics_title">Run Diagnostics</span>
                    </h3>
                    <button class="vecthare-modal-close" id="vecthare_diagnostics_close">
                        <i class="fa-solid fa-times"></i>
                    </button>
                </div>
                <div class="vecthare-modal-body">
                    <!-- Phase 1: Category Selection -->
                    <div id="vecthare_diagnostics_selection" class="vecthare-diagnostics-phase">
                        <p class="vecthare-diagnostics-intro">Select which diagnostic categories to run:</p>

                        <div class="vecthare-diagnostics-categories">
                            <label class="vecthare-diagnostics-category-option">
                                <input type="checkbox" id="vecthare_diag_infrastructure" checked>
                                <div class="vecthare-diagnostics-category-card">
                                    <i class="fa-solid fa-server"></i>
                                    <div class="vecthare-diagnostics-category-info">
                                        <strong>Infrastructure</strong>
                                        <span>Backend connections, plugins, API endpoints</span>
                                    </div>
                                </div>
                            </label>

                            <label class="vecthare-diagnostics-category-option">
                                <input type="checkbox" id="vecthare_diag_configuration" checked>
                                <div class="vecthare-diagnostics-category-card">
                                    <i class="fa-solid fa-sliders"></i>
                                    <div class="vecthare-diagnostics-category-info">
                                        <strong>Configuration</strong>
                                        <span>Settings validation, chunk size, thresholds</span>
                                    </div>
                                </div>
                            </label>

                            <label class="vecthare-diagnostics-category-option">
                                <input type="checkbox" id="vecthare_diag_visualizer" checked>
                                <div class="vecthare-diagnostics-category-card">
                                    <i class="fa-solid fa-eye"></i>
                                    <div class="vecthare-diagnostics-category-info">
                                        <strong>Visualizer</strong>
                                        <span>Chunk editing, deletion, summary vectors</span>
                                    </div>
                                </div>
                            </label>

                            <label class="vecthare-diagnostics-category-option">
                                <input type="checkbox" id="vecthare_diag_production">
                                <div class="vecthare-diagnostics-category-card">
                                    <i class="fa-solid fa-vial"></i>
                                    <div class="vecthare-diagnostics-category-info">
                                        <strong>Production Tests</strong>
                                        <span>Live embedding, storage, retrieval tests</span>
                                    </div>
                                </div>
                            </label>
                        </div>

                        <div class="vecthare-diagnostics-actions">
                            <button class="vecthare-btn-secondary" id="vecthare_diag_cancel">Cancel</button>
                            <button class="vecthare-btn-primary" id="vecthare_diag_run">
                                <i class="fa-solid fa-play"></i> Run Diagnostics
                            </button>
                        </div>
                    </div>

                    <!-- Phase 2: Running -->
                    <div id="vecthare_diagnostics_running" class="vecthare-diagnostics-phase" style="display: none;">
                        <div class="vecthare-diagnostics-spinner">
                            <i class="fa-solid fa-spinner fa-spin"></i>
                            <span>Running diagnostics...</span>
                        </div>
                    </div>

                    <!-- Phase 3: Results -->
                    <div id="vecthare_diagnostics_results" class="vecthare-diagnostics-phase" style="display: none;">
                        <div id="vecthare_diagnostics_content"></div>
                        <div class="vecthare-diagnostics-footer">
                            <button class="vecthare-btn-secondary" id="vecthare_diag_back">
                                <i class="fa-solid fa-arrow-left"></i> Run Again
                            </button>
                            <button class="vecthare-btn-secondary" id="vecthare_diag_copy">
                                <i class="fa-solid fa-copy"></i> Copy Report
                            </button>
                            <button class="vecthare-btn-danger" id="vecthare_diag_fix_all" style="display: none;">
                                <i class="fa-solid fa-wand-magic-sparkles"></i> Fix All Issues
                            </button>
                            <button class="vecthare-btn-primary" id="vecthare_diag_done">Done</button>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <!-- Chunk Visualizer Modal -->
        <div id="vecthare_visualizer_modal" class="vecthare-modal" style="display: none;">
            <div class="vecthare-modal-overlay"></div>
            <div class="vecthare-modal-content vecthare-visualizer-content">
                <div class="vecthare-modal-header">
                    <h3>
                        <i class="fa-solid fa-cubes"></i>
                        Chunk Visualizer
                    </h3>
                    <button class="vecthare-modal-close" id="vecthare_visualizer_close">
                        <i class="fa-solid fa-times"></i>
                    </button>
                </div>
                <div class="vecthare-visualizer-toolbar">
                    <input type="text" id="vecthare_visualizer_search"
                           class="vecthare-visualizer-search"
                           placeholder="Search chunks by text, keywords, or name...">
                    <div class="vecthare-visualizer-stats">
                        <span id="vecthare_visualizer_count">0 chunks</span>
                        <span id="vecthare_visualizer_tiers"></span>
                    </div>
                </div>
                <div class="vecthare-modal-body">
                    <div id="vecthare_visualizer_content"></div>
                </div>
                <div class="vecthare-modal-footer">
                    <button class="vecthare-btn-secondary" id="vecthare_visualizer_done">Done</button>
                </div>
            </div>
        </div>

        ${getHealthModalHtml()}
    `;

    // Sanity debug: confirm the generated HTML contains the lock button marker
    try {
        console.log(`VectHare: renderSettings built HTML contains lock marker:`, String(html).indexOf('vecthare_lock_collection') >= 0);
        const target = document.getElementById(containerId);
        console.log(`VectHare: renderSettings target container exists:`, !!target, 'containerId=', containerId);
    } catch (e) {
        console.warn('VectHare: renderSettings pre-append debug failed', e);
    }

    $(`#${containerId}`).append(html);

    // Debug: log presence of lock button after rendering and observe for later appearance
    try {
        console.log(`VectHare: renderSettings appended to ${containerId}. lock button present:`, !!document.getElementById('vecthare_lock_collection'));
        if (!document.getElementById('vecthare_lock_collection')) {
            const containerEl = document.getElementById(containerId);
            if (containerEl && window.MutationObserver) {
                const mo = new MutationObserver((mutations, obs) => {
                    if (document.getElementById('vecthare_lock_collection')) {
                        console.log('VectHare: lock button appeared in DOM');
                        obs.disconnect();
                    }
                });
                mo.observe(containerEl, { childList: true, subtree: true });
            }
        }
    } catch (e) {
        console.warn('VectHare: debug check failed', e);
    }

    // Bind all events
    bindSettingsEvents(settings, callbacks);

    // Initialize collapsible cards
    initializeCollapsibleCards();

    // Initialize modal
    initializeDiagnosticsModal();

    // Initialize health dashboard
    initializeHealthDashboard();

    console.log('VectHare UI: Settings rendered');
}

/**
 * Initializes diagnostics modal functionality
 */
function initializeDiagnosticsModal() {
    // Close button
    $('#vecthare_diagnostics_close').on('click', function() {
        closeDiagnosticsModal();
    });

    // Click overlay to close
    $('#vecthare_diagnostics_modal .vecthare-modal-overlay').on('click', function() {
        closeDiagnosticsModal();
    });

    // Stop mousedown propagation (ST closes drawers on mousedown/touchstart)
    // Note: This modal is inside the drawer so it doesn't strictly need this,
    // but we include it for consistency with other modals
    $('#vecthare_diagnostics_modal').on('mousedown touchstart', function(e) {
        e.stopPropagation();
    });

    // ESC key to close
    $(document).on('keydown', function(e) {
        if (e.key === 'Escape' && $('#vecthare_diagnostics_modal').is(':visible')) {
            closeDiagnosticsModal();
        }
    });

    // Cancel button
    $('#vecthare_diag_cancel').on('click', function() {
        closeDiagnosticsModal();
    });

    // Done button
    $('#vecthare_diag_done').on('click', function() {
        closeDiagnosticsModal();
    });

    // Back button - go back to selection
    $('#vecthare_diag_back').on('click', function() {
        showDiagnosticsPhase('selection');
        $('#vecthare_diagnostics_title').text('Run Diagnostics');
    });

    // Run button - execute diagnostics
    $('#vecthare_diag_run').on('click', async function() {
        await executeDiagnostics();
    });
}

/**
 * Closes the diagnostics modal and resets to selection phase
 */
function closeDiagnosticsModal() {
    $('#vecthare_diagnostics_modal').fadeOut(200, function() {
        // Reset to selection phase for next open
        showDiagnosticsPhase('selection');
        $('#vecthare_diagnostics_title').text('Run Diagnostics');
    });
}

/**
 * Shows a specific phase of the diagnostics modal
 * @param {string} phase - 'selection', 'running', or 'results'
 */
function showDiagnosticsPhase(phase) {
    $('#vecthare_diagnostics_selection').hide();
    $('#vecthare_diagnostics_running').hide();
    $('#vecthare_diagnostics_results').hide();
    $(`#vecthare_diagnostics_${phase}`).show();
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
    const settings = extension_settings.vecthare;

    // Get selected categories
    const runInfrastructure = $('#vecthare_diag_infrastructure').prop('checked');
    const runConfiguration = $('#vecthare_diag_configuration').prop('checked');
    const runVisualizer = $('#vecthare_diag_visualizer').prop('checked');
    const runProduction = $('#vecthare_diag_production').prop('checked');

    if (!runInfrastructure && !runConfiguration && !runVisualizer && !runProduction) {
        toastr.warning('Please select at least one category to run');
        return;
    }

    // Show running phase
    showDiagnosticsPhase('running');
    $('#vecthare_diagnostics_title').text('Running Diagnostics...');

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
        console.error('VectHare Diagnostics error:', error);
        toastr.error('Failed to run diagnostics: ' + error.message);
        showDiagnosticsPhase('selection');
        $('#vecthare_diagnostics_title').text('Run Diagnostics');
    }
}

/**
 * Initializes collapsible functionality
 */
function initializeCollapsibleCards() {
    $('.vecthare-collapsible-header').on('click', function() {
        const content = $(this).next('.vecthare-collapsible-content');
        const icon = $(this).find('.vecthare-collapsible-icon');

        content.slideToggle(200);
        icon.toggleClass('rotated');
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
        const warningKey = 'vecthare_webllm_browser_warning_shown';
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
        const warningKey = 'vecthare_webllm_extension_warning_shown';
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
        const warningKey = 'vecthare_webllm_update_warning_shown';
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
        console.error('VectHare: WebLLM operation failed', error);
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
 * @param {object} settings - VectHare settings object
 */
export async function loadWebLlmModels(settings) {
    return executeWithWebLlmErrorHandling(async () => {
        const provider = getWebLlmProvider();
        const models = provider.getModels();
        const $select = $('#vecthare_webllm_model');

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
            Object.assign(extension_settings.vecthare, settings);
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
 * @param {object} settings - VectHare settings object (unused, kept for API compatibility)
 */
export function refreshAutoSyncCheckbox(settings) {
    const collectionId = getChatCollectionId();
    if (!collectionId) {
        $('#vecthare_autosync_enabled').prop('checked', false);
        return;
    }
    // Dynamically import to avoid circular dependency
    import('../core/collection-metadata.js').then(({ isCollectionAutoSyncEnabled }) => {
        const isEnabled = isCollectionAutoSyncEnabled(collectionId);
        $('#vecthare_autosync_enabled').prop('checked', isEnabled);
    });
}

export function updateWebLlmStatus() {
    const $status = $('#vecthare_webllm_status');
    const $installBtn = $('#vecthare_webllm_install');
    const $loadBtn = $('#vecthare_webllm_load');
    const $modelSelect = $('#vecthare_webllm_model');

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
 * @param {object} settings - VectHare settings object
 */
function toggleProviderSettings(selectedProvider, settings) {
    // Hide all provider-specific settings
    $('.vecthare_provider_setting').hide();

    // Show settings for selected provider
    $(`.vecthare_provider_setting`).each(function() {
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
 * @param {object} settings - VectHare settings for purge operations
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
                <div class="vecthare-collection-option ${isGhost ? 'ghost' : ''}" data-index="${index}" style="
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
                            <button class="menu_button menu_button_icon vecthare-delete-ghost" data-index="${index}" style="margin-left: 10px; color: var(--SmartThemeFontColorOverrideWarning, #f0ad4e);" title="Delete this ghost collection">
                                <i class="fa-solid fa-trash"></i>
                            </button>
                        ` : ''}
                    </div>
                </div>
            `;
        }).join('');

        const modalHtml = `
            <div id="vecthare_autosync_confirm_modal" class="vecthare-modal" style="display: flex;">
                <div class="vecthare-modal-content" style="max-width: 500px;">
                    <div class="vecthare-modal-header">
                        <h3><i class="fa-solid fa-link"></i> ${hasMultiple ? 'Multiple Collections Found' : 'Existing Collection Found'}</h3>
                        <button class="vecthare-modal-close" data-action="cancel">
                            <i class="fa-solid fa-times"></i>
                        </button>
                    </div>
                    <div class="vecthare-modal-body" style="padding: 20px;">
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
                    <div class="vecthare-modal-footer" style="display: flex; gap: 10px; padding: 15px 20px; border-top: 1px solid var(--SmartThemeBorderColor);">
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
        $modal.find('.vecthare-collection-option').first().css('border-color', 'var(--SmartThemeQuoteColor)');

        // Handle collection selection
        $modal.find('.vecthare-collection-option').on('click', function(e) {
            if ($(e.target).closest('.vecthare-delete-ghost').length) return; // Don't select when clicking delete

            selectedIndex = parseInt($(this).data('index'));
            $modal.find('.vecthare-collection-option').css('border-color', 'transparent');
            $(this).css('border-color', 'var(--SmartThemeQuoteColor)');
        });

        // Handle ghost deletion - uses unified deleteCollection()
        $modal.find('.vecthare-delete-ghost').on('click', async function(e) {
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
                $(this).closest('.vecthare-collection-option').fadeOut(200, function() {
                    $(this).remove();
                    // Re-index remaining items
                    $modal.find('.vecthare-collection-option').each((i, el) => {
                        $(el).attr('data-index', i);
                        $(el).find('.vecthare-delete-ghost').attr('data-index', i);
                    });
                });

                if (result.success) {
                    toastr.success('Ghost collection deleted', 'VectHare');
                } else {
                    toastr.warning(`Partial deletion: ${result.errors.join(', ')}`, 'VectHare');
                }

                // If no collections left, close modal
                if (allMatches.length === 0) {
                    $modal.remove();
                    resolve({ action: 'revectorize' });
                } else if (selectedIndex >= allMatches.length) {
                    selectedIndex = 0;
                    $modal.find('.vecthare-collection-option').first().css('border-color', 'var(--SmartThemeQuoteColor)');
                }
            } catch (error) {
                console.error('VectHare: Failed to delete ghost', error);
                toastr.error('Failed to delete ghost collection', 'VectHare');
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
 * @param {object} settings - VectHare settings object
 * @param {object} callbacks - Callback functions
 */
function bindSettingsEvents(settings, callbacks) {
    // Auto-sync enable/disable - now per-collection instead of global
    // Initial state is set by refreshAutoSyncCheckbox() after chat loads
    $('#vecthare_autosync_enabled')
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

            const collectionId = getChatCollectionId();
            if (!collectionId) {
                toastr.warning('Could not get collection ID for this chat');
                $checkbox.prop('checked', false);
                return;
            }

            // Import the metadata functions
            const { setCollectionAutoSync } = await import('../core/collection-metadata.js');

            // If enabling, check if we need to set up the collection first
            if (enabling) {
                // SINGLE SOURCE OF TRUTH: Use doesChatHaveVectors which runs discovery
                const { hasVectors, allMatches } = await doesChatHaveVectors(settings);

                if (!hasVectors) {
                    // No vectors found anywhere - open vectorizer panel
                    $checkbox.prop('checked', false);
                    toastr.info('Set up your chat vectorization first');
                    openContentVectorizer('chat');
                    return;
                }

                // Found existing vectors - show confirmation modal with all matches
                const result = await showAutoSyncConfirmModal(allMatches, settings);

                if (result.action === 'cancel') {
                    // User cancelled - don't enable
                    $checkbox.prop('checked', false);
                    return;
                }

                if (result.action === 'reconnect' && result.selectedCollection) {
                    // Connect to selected collection
                    const selected = result.selectedCollection;
                    toastr.success(`Connected to collection with ${selected.chunkCount} chunks`, 'Auto-Sync Enabled');
                    console.log(`VectHare: Auto-sync enabled - connected to ${selected.collectionId} (${selected.chunkCount} chunks)`);
                } else if (result.action === 'revectorize') {
                    // User wants to start fresh - open vectorizer
                    $checkbox.prop('checked', false);
                    openContentVectorizer('chat');
                    return;
                }
            }

            // Save to per-collection metadata instead of global setting
            setCollectionAutoSync(collectionId, enabling);

            if (!enabling) {
                toastr.info('Auto-sync disabled for this chat');
            } else {
                toastr.success('Auto-sync enabled for this chat');
            }
            console.log(`VectHare: Chat auto-sync for ${collectionId}: ${enabling ? 'enabled' : 'disabled'}`);
        });

        // Collection lock handled inside Database Browser per-collection settings

    // Chunking strategy - populate from content-types.js (single source of truth)
    const chatStrategies = getChunkingStrategies('chat');
    const strategySelect = $('#vecthare_chunking_strategy');
    strategySelect.empty();
    for (const strategy of chatStrategies) {
        const selected = strategy.id === (settings.chunking_strategy || 'per_message');
        strategySelect.append(`<option value="${strategy.id}" ${selected ? 'selected' : ''}>${strategy.name}</option>`);
    }

    function updateStrategyUI(strategyId) {
        // Update description from content-types.js
        const strategy = chatStrategies.find(s => s.id === strategyId);
        $('#vecthare_strategy_description').text(strategy?.description || '');
        // Show/hide batch settings
        $('#vecthare_batch_settings').toggle(strategyId === 'message_batch');
    }

    strategySelect.on('change', function() {
        settings.chunking_strategy = String($(this).val());
        Object.assign(extension_settings.vecthare, settings);
        saveSettingsDebounced();
        updateStrategyUI(settings.chunking_strategy);
    });
    updateStrategyUI(settings.chunking_strategy || 'per_message');

    // Batch size (for message_batch strategy)
    $('#vecthare_batch_size')
        .val(settings.batch_size || 4)
        .on('input', function() {
            const value = Number($(this).val());
            $('#vecthare_batch_size_value').text(value);
            settings.batch_size = value;
            Object.assign(extension_settings.vecthare, settings);
            saveSettingsDebounced();
        });
    $('#vecthare_batch_size_value').text(settings.batch_size || 4);

    // Summarization provider
    const updateSummarizeUI = (provider) => {
        if (provider === 'off') {
            $('#vecthare_summarize_settings').hide();
        } else {
            $('#vecthare_summarize_settings').show();
            if (provider === 'vllm') {
                $('#vecthare_summarize_vllm_url_row').show();
            } else {
                $('#vecthare_summarize_vllm_url_row').hide();
            }
        }
    };
    $('#vecthare_summarize_provider')
        .val(settings.summarize_provider || 'off')
        .on('change', function() {
            settings.summarize_provider = String($(this).val());
            Object.assign(extension_settings.vecthare, settings);
            saveSettingsDebounced();
            updateSummarizeUI(settings.summarize_provider);
        });
    updateSummarizeUI(settings.summarize_provider || 'off');

    $('#vecthare_summarize_model')
        .val(settings.summarize_model || '')
        .on('change', function() {
            settings.summarize_model = String($(this).val()).trim();
            Object.assign(extension_settings.vecthare, settings);
            saveSettingsDebounced();
        });

    $('#vecthare_summarize_vllm_url')
        .val(settings.summarize_vllm_url || '')
        .on('change', function() {
            settings.summarize_vllm_url = String($(this).val()).trim();
            Object.assign(extension_settings.vecthare, settings);
            saveSettingsDebounced();
        });

    $('#vecthare_summarize_prompt')
        .val(settings.summarize_prompt || '')
        .on('change', function() {
            settings.summarize_prompt = String($(this).val());
            Object.assign(extension_settings.vecthare, settings);
            saveSettingsDebounced();
        });

    // Chunk size (for adaptive strategy)
    $('#vecthare_chunk_size')
        .val(settings.chunk_size || 500)
        .on('input', function() {
            const value = Number($(this).val());
            settings.chunk_size = value;
            Object.assign(extension_settings.vecthare, settings);
            saveSettingsDebounced();
        });

    // Vector backend selection
    $('#vecthare_vector_backend')
        .val(settings.vector_backend || 'standard')
        .on('change', function() {
            settings.vector_backend = String($(this).val());
            Object.assign(extension_settings.vecthare, settings);
            saveSettingsDebounced();

            // Show/hide Qdrant settings
            if (settings.vector_backend === 'qdrant') {
                $('#vecthare_qdrant_settings').show();
            } else {
                $('#vecthare_qdrant_settings').hide();
            }
            if (settings.vector_backend === 'milvus') {
                $('#vecthare_milvus_settings').show();
            } else {
                $('#vecthare_milvus_settings').hide();
            }

            console.log(`VectHare: Vector backend changed to ${settings.vector_backend}`);
            // Reset health cache so new backend gets properly initialized
            resetBackendHealth();
        });

    // Qdrant cloud toggle
    $('#vecthare_qdrant_use_cloud')
        .prop('checked', settings.qdrant_use_cloud || false)
        .on('change', async function() {
            settings.qdrant_use_cloud = $(this).prop('checked');
            Object.assign(extension_settings.vecthare, settings);
            saveSettingsDebounced();

            // Toggle between local and cloud settings
            if (settings.qdrant_use_cloud) {
                $('#vecthare_qdrant_local_settings').hide();
                $('#vecthare_qdrant_cloud_settings').show();
            } else {
                $('#vecthare_qdrant_local_settings').show();
                $('#vecthare_qdrant_cloud_settings').hide();
            }

            // Reset backend health to force re-initialization with new config
            console.log('VectHare: Qdrant mode changed, forcing re-initialization...');
            resetBackendHealth('qdrant');

            // Proactively reinitialize if Qdrant is the current backend
            if (settings.vector_backend === 'qdrant') {
                try {
                    const { initializeBackend } = await import('../backends/backend-manager.js');
                    await initializeBackend('qdrant', settings, false);
                    toastr.success(
                        `Qdrant re-initialized in ${settings.qdrant_use_cloud ? 'cloud' : 'local'} mode`,
                        'VectHare'
                    );
                } catch (e) {
                    console.error('VectHare: Failed to reinitialize Qdrant:', e);
                    toastr.warning('Failed to reinitialize Qdrant: ' + e.message, 'VectHare');
                }
            }
        })
        .trigger('change');

    // Qdrant settings
    $('#vecthare_qdrant_host')
        .val(settings.qdrant_host || 'localhost')
        .on('input', function() {
            settings.qdrant_host = String($(this).val());
            Object.assign(extension_settings.vecthare, settings);
            saveSettingsDebounced();
        });

    $('#vecthare_qdrant_port')
        .val(settings.qdrant_port || 6333)
        .on('input', function() {
            const value = parseInt($(this).val());
            settings.qdrant_port = isNaN(value) ? 6333 : value;
            Object.assign(extension_settings.vecthare, settings);
            saveSettingsDebounced();
        });

    $('#vecthare_qdrant_url')
        .val(settings.qdrant_url || '')
        .on('input', function() {
            settings.qdrant_url = String($(this).val());
            Object.assign(extension_settings.vecthare, settings);
            saveSettingsDebounced();
        });

    $('#vecthare_qdrant_api_key')
        .val(settings.qdrant_api_key || '')
        .on('input', function() {
            settings.qdrant_api_key = String($(this).val());
            Object.assign(extension_settings.vecthare, settings);
            saveSettingsDebounced();
        });

    // Qdrant multitenancy toggle
    $('#vecthare_qdrant_multitenancy')
        .prop('checked', settings.qdrant_multitenancy || false)
        .on('change', function() {
            settings.qdrant_multitenancy = $(this).prop('checked');
            Object.assign(extension_settings.vecthare, settings);
            saveSettingsDebounced();
        });

    // Show Qdrant settings if backend is qdrant
    if (settings.vector_backend === 'qdrant') {
        $('#vecthare_qdrant_settings').show();
    }

    // Milvus settings
    $('#vecthare_milvus_host')
        .val(settings.milvus_host || 'localhost')
        .on('input', function() {
            settings.milvus_host = String($(this).val());
            Object.assign(extension_settings.vecthare, settings);
            saveSettingsDebounced();
        });

    $('#vecthare_milvus_port')
        .val(settings.milvus_port || 19530)
        .on('input', function() {
            const value = parseInt($(this).val());
            settings.milvus_port = isNaN(value) ? 19530 : value;
            Object.assign(extension_settings.vecthare, settings);
            saveSettingsDebounced();
        });

    $('#vecthare_milvus_username')
        .val(settings.milvus_username || '')
        .on('input', function() {
            settings.milvus_username = String($(this).val());
            Object.assign(extension_settings.vecthare, settings);
            saveSettingsDebounced();
        });

    $('#vecthare_milvus_password')
        .val(settings.milvus_password || '')
        .on('input', function() {
            settings.milvus_password = String($(this).val());
            Object.assign(extension_settings.vecthare, settings);
            saveSettingsDebounced();
        });

    $('#vecthare_milvus_token')
        .val(settings.milvus_token || '')
        .on('input', function() {
            settings.milvus_token = String($(this).val());
            Object.assign(extension_settings.vecthare, settings);
            saveSettingsDebounced();
        });

    $('#vecthare_milvus_dimensions')
        .val(settings.milvus_dimensions || '')
        .on('input', function() {
            const value = parseInt($(this).val());
            settings.milvus_dimensions = isNaN(value) ? '' : value;
            Object.assign(extension_settings.vecthare, settings);
            saveSettingsDebounced();
        });

    $('#vecthare_milvus_address')
        .val(settings.milvus_address || '')
        .on('input', function() {
            settings.milvus_address = String($(this).val());
            Object.assign(extension_settings.vecthare, settings);
            saveSettingsDebounced();
        });

    // Show Milvus settings if backend is milvus
    if (settings.vector_backend === 'milvus') {
        $('#vecthare_milvus_settings').show();
    }

    // Embedding provider
    $('#vecthare_source')
        .val(settings.source)
        .on('change', function() {
            settings.source = String($(this).val());
            Object.assign(extension_settings.vecthare, settings);
            saveSettingsDebounced();
            toggleProviderSettings(settings.source, settings);
            console.log(`VectHare: Embedding provider changed to ${settings.source}`);
            // Reset health cache since provider change may affect backend connectivity
            resetBackendHealth();
        });

    // Score threshold
    $('#vecthare_score_threshold')
        .val(settings.score_threshold)
        .on('input', function() {
            const value = parseFloat($(this).val());
            const safeValue = isNaN(value) ? 0.3 : value;
            $('#vecthare_threshold_value').text(safeValue.toFixed(2));
            settings.score_threshold = safeValue;
            Object.assign(extension_settings.vecthare, settings);
            saveSettingsDebounced();
        });
    $('#vecthare_threshold_value').text(settings.score_threshold.toFixed(2));

    // Deduplication depth
    $('#vecthare_deduplication_depth')
        .val(settings.deduplication_depth ?? 50)
        .on('input', function() {
            const value = parseInt($(this).val());
            const safeValue = isNaN(value) ? 50 : Math.max(0, value);
            $('#vecthare_deduplication_depth_value').text(safeValue);
            settings.deduplication_depth = safeValue;
            Object.assign(extension_settings.vecthare, settings);
            saveSettingsDebounced();
        });
    $('#vecthare_deduplication_depth_value').text(settings.deduplication_depth ?? 50);

    // Keyword scoring method
    $('#vecthare_keyword_scoring_method')
        .val(settings.keyword_scoring_method || 'keyword')
        .on('change', function() {
            settings.keyword_scoring_method = String($(this).val());
            Object.assign(extension_settings.vecthare, settings);
            saveSettingsDebounced();

            // Show/hide BM25 parameters
            if (settings.keyword_scoring_method === 'bm25' || settings.keyword_scoring_method === 'hybrid') {
                $('#vecthare_bm25_params').show();
            } else {
                $('#vecthare_bm25_params').hide();
            }
            console.log(`VectHare: Keyword scoring method changed to ${settings.keyword_scoring_method}`);
        });

    // Show/hide BM25 params based on initial setting
    if (settings.keyword_scoring_method === 'bm25' || settings.keyword_scoring_method === 'hybrid') {
        $('#vecthare_bm25_params').show();
    }

    // BM25 k1 parameter
    $('#vecthare_bm25_k1')
        .val(settings.bm25_k1 || 1.5)
        .on('input', function() {
            const value = parseFloat($(this).val());
            const safeValue = isNaN(value) ? 1.5 : value;
            $('#vecthare_bm25_k1_value').text(safeValue.toFixed(1));
            settings.bm25_k1 = safeValue;
            Object.assign(extension_settings.vecthare, settings);
            saveSettingsDebounced();
        });
    $('#vecthare_bm25_k1_value').text((settings.bm25_k1 || 1.5).toFixed(1));

    // BM25 b parameter
    $('#vecthare_bm25_b')
        .val(settings.bm25_b || 0.75)
        .on('input', function() {
            const value = parseFloat($(this).val());
            const safeValue = isNaN(value) ? 0.75 : value;
            $('#vecthare_bm25_b_value').text(safeValue.toFixed(2));
            settings.bm25_b = safeValue;
            Object.assign(extension_settings.vecthare, settings);
            saveSettingsDebounced();
        });
    $('#vecthare_bm25_b_value').text((settings.bm25_b || 0.75).toFixed(2));

    // ========== Hybrid Search Settings ==========

    // Enable Hybrid Search checkbox
    $('#vecthare_hybrid_search_enabled')
        .prop('checked', settings.hybrid_search_enabled || false)
        .on('change', function() {
            const enabled = $(this).prop('checked');
            settings.hybrid_search_enabled = enabled;
            Object.assign(extension_settings.vecthare, settings);
            saveSettingsDebounced();
            $('#vecthare_hybrid_params').toggle(enabled);
            console.log(`VectHare: Hybrid search ${enabled ? 'enabled' : 'disabled'}`);
        });
    // Initialize visibility
    $('#vecthare_hybrid_params').toggle(settings.hybrid_search_enabled || false);

    // Fusion method selector
    $('#vecthare_hybrid_fusion_method')
        .val(settings.hybrid_fusion_method || 'rrf')
        .on('change', function() {
            settings.hybrid_fusion_method = String($(this).val());
            Object.assign(extension_settings.vecthare, settings);
            saveSettingsDebounced();
            // Show weights only for weighted method, RRF settings for RRF
            const isWeighted = settings.hybrid_fusion_method === 'weighted';
            $('#vecthare_hybrid_weights').toggle(isWeighted);
            $('#vecthare_hybrid_rrf_settings').toggle(!isWeighted);
            console.log(`VectHare: Hybrid fusion method changed to ${settings.hybrid_fusion_method}`);
        });
    // Initialize visibility based on current method
    const isWeightedMethod = (settings.hybrid_fusion_method || 'rrf') === 'weighted';
    $('#vecthare_hybrid_weights').toggle(isWeightedMethod);
    $('#vecthare_hybrid_rrf_settings').toggle(!isWeightedMethod);

    // Vector weight slider
    $('#vecthare_hybrid_vector_weight')
        .val(settings.hybrid_vector_weight ?? 0.5)
        .on('input', function() {
            const value = parseFloat($(this).val());
            const safeValue = isNaN(value) ? 0.5 : value;
            $('#vecthare_hybrid_vector_weight_value').text(safeValue.toFixed(1));
            settings.hybrid_vector_weight = safeValue;
            Object.assign(extension_settings.vecthare, settings);
            saveSettingsDebounced();
        });
    $('#vecthare_hybrid_vector_weight_value').text((settings.hybrid_vector_weight ?? 0.5).toFixed(1));

    // Text weight slider
    $('#vecthare_hybrid_text_weight')
        .val(settings.hybrid_text_weight ?? 0.5)
        .on('input', function() {
            const value = parseFloat($(this).val());
            const safeValue = isNaN(value) ? 0.5 : value;
            $('#vecthare_hybrid_text_weight_value').text(safeValue.toFixed(1));
            settings.hybrid_text_weight = safeValue;
            Object.assign(extension_settings.vecthare, settings);
            saveSettingsDebounced();
        });
    $('#vecthare_hybrid_text_weight_value').text((settings.hybrid_text_weight ?? 0.5).toFixed(1));

    // RRF K constant slider
    $('#vecthare_hybrid_rrf_k')
        .val(settings.hybrid_rrf_k || 60)
        .on('input', function() {
            const value = parseInt($(this).val());
            const safeValue = isNaN(value) ? 60 : value;
            $('#vecthare_hybrid_rrf_k_value').text(safeValue);
            settings.hybrid_rrf_k = safeValue;
            Object.assign(extension_settings.vecthare, settings);
            saveSettingsDebounced();
        });
    $('#vecthare_hybrid_rrf_k_value').text(settings.hybrid_rrf_k || 60);

    // Prefer native backend hybrid checkbox
    $('#vecthare_hybrid_native_prefer')
        .prop('checked', settings.hybrid_native_prefer !== false)
        .on('change', function() {
            settings.hybrid_native_prefer = $(this).prop('checked');
            Object.assign(extension_settings.vecthare, settings);
            saveSettingsDebounced();
        });

    // Query depth (how many recent messages to include in search query)
    $('#vecthare_query_depth')
        .val(settings.query || 2)
        .on('input', function() {
            const value = parseInt($(this).val());
            const safeValue = isNaN(value) ? 2 : value;
            $('#vecthare_query_depth_value').text(safeValue);
            settings.query = safeValue;
            Object.assign(extension_settings.vecthare, settings);
            saveSettingsDebounced();
        });
    $('#vecthare_query_depth_value').text(settings.query || 2);

    // Top K - number of results retrieved per collection (top-K)
    $('#vecthare_topk')
        .val((settings.top_k ?? settings.insert) || 3)
        .on('input', function() {
            const value = parseInt($(this).val());
            const safeValue = isNaN(value) ? (settings.insert || 3) : value;
            settings.top_k = safeValue;
            Object.assign(extension_settings.vecthare, settings);
            saveSettingsDebounced();
        });

    // World Info Integration settings
    $('#vecthare_enabled_world_info')
        .prop('checked', settings.enabled_world_info || false)
        .on('change', function() {
            const enabled = $(this).prop('checked');
            settings.enabled_world_info = enabled;
            Object.assign(extension_settings.vecthare, settings);
            saveSettingsDebounced();
            // Show/hide the detailed world info settings panel
            $('#vecthare_world_info_settings').toggle(enabled);
        });

    $('#vecthare_world_info_threshold')
        .val(settings.world_info_threshold ?? 0.3)
        .on('input', function() {
            const value = parseFloat($(this).val());
            const safeValue = isNaN(value) ? 0.3 : Math.max(0, Math.min(1, value));
            settings.world_info_threshold = safeValue;
            Object.assign(extension_settings.vecthare, settings);
            saveSettingsDebounced();
        });

    $('#vecthare_world_info_top_k')
        .val(settings.world_info_top_k ?? 3)
        .on('input', function() {
            const value = parseInt($(this).val());
            const safeValue = isNaN(value) ? 3 : Math.max(1, Math.min(20, value));
            settings.world_info_top_k = safeValue;
            Object.assign(extension_settings.vecthare, settings);
            saveSettingsDebounced();
        });

    $('#vecthare_world_info_query_depth')
        .val(settings.world_info_query_depth ?? 3)
        .on('input', function() {
            const value = parseInt($(this).val());
            const safeValue = isNaN(value) ? 3 : Math.max(1, Math.min(10, value));
            settings.world_info_query_depth = safeValue;
            Object.assign(extension_settings.vecthare, settings);
            saveSettingsDebounced();
        });

    // Custom stopwords
    $('#vecthare_custom_stopwords')
        .val(settings.custom_stopwords || '')
        .on('input', function() {
            settings.custom_stopwords = $(this).val();
            Object.assign(extension_settings.vecthare, settings);
            saveSettingsDebounced();
        });

    // Initialize world info settings visibility based on current setting
    $('#vecthare_world_info_settings').toggle(settings.enabled_world_info || false);

    // Debug buttons: Test semantic WI and dump registry
    $('#vecthare_wi_test_btn').on('click', async function() {
        try {
            const raw = $('#vecthare_wi_test_input').val() || '';
            const recentMessages = raw.split('\n').map(s => s.trim()).filter(Boolean);
            const activeEntries = [];
            const cfg = window.extension_settings?.vecthare || settings;

            console.log('VectHare: Running semantic WI test with messages:', recentMessages);

            // Primary: use initialized hooks if available
            if (window.VectHare_WorldInfo && typeof window.VectHare_WorldInfo.getSemanticEntries === 'function') {
                const entries = await window.VectHare_WorldInfo.getSemanticEntries(recentMessages, activeEntries, cfg);
                console.log('VectHare: Semantic WI test results (via window hooks):', entries);
                toastr.info(`Semantic WI test completed - ${entries.length} entries (see console)`);

                // If no entries found, provide extended diagnostics to help debug
                if (!entries || entries.length === 0) {
                    try {
                        console.log('VectHare: No semantic entries — dumping registry and per-collection query info...');
                        const registry = window.extension_settings?.vecthare?.vecthare_collection_registry || settings.vecthare_collection_registry || [];
                        console.log('VectHare: Collection registry:', registry);

                        const coreApi = await import('../core/core-vector-api.js');
                        const metaMod = await import('../core/collection-metadata.js');

                        for (const collKey of registry) {
                            try {
                                if (!collKey.includes('lorebook')) continue; // focus on lorebooks
                                const meta = metaMod.getCollectionMeta(collKey);
                                console.log(`VectHare: Collection meta for ${collKey}:`, meta);

                                // Check saved hashes (true=include metadata)
                                if (coreApi.getSavedHashes) {
                                    try {
                                        const saved = await coreApi.getSavedHashes(collKey, cfg, true);
                                        console.log(`VectHare: getSavedHashes for ${collKey}:`, saved && saved.hashes ? saved.hashes.length + ' hashes' : saved);
                                    } catch (hErr) {
                                        console.warn(`VectHare: getSavedHashes failed for ${collKey}:`, hErr.message);
                                    }
                                }

                                // Run a direct vector query against this collection
                                try {
                                    const qres = await coreApi.queryCollection(collKey, recentMessages.join('\n'), cfg.world_info_top_k || 3, cfg);
                                    console.log(`VectHare: queryCollection result for ${collKey}:`, qres);
                                } catch (qErr) {
                                    console.warn(`VectHare: queryCollection failed for ${collKey}:`, qErr.message);
                                }
                            } catch (inner) {
                                console.warn('VectHare: Error inspecting collection', collKey, inner.message);
                            }
                        }

                        toastr.info('Extended WI diagnostics written to console (registry + per-collection queries)');
                    } catch (diagErr) {
                        console.error('VectHare: Failed to run extended WI diagnostics', diagErr);
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
                console.log('VectHare: Semantic WI test results (via dynamic import):', entries);
                toastr.info(`Semantic WI test completed - ${entries.length} entries (see console)`);
                return;
            } catch (impErr) {
                console.warn('VectHare: Dynamic import fallback failed:', impErr.message);
                toastr.error('VectHare: WorldInfo hooks not initialized and dynamic import failed: ' + impErr.message);
                return;
            }

        } catch (e) {
            console.error('VectHare: Semantic WI test failed', e);
            try { toastr.error('Semantic WI test failed: ' + (e.message || String(e))); } catch (_) {}
        }
    });

    $('#vecthare_wi_dump_registry').on('click', function() {
        try {
            const registry = window.extension_settings?.vecthare?.vecthare_collection_registry || settings.vecthare_collection_registry || [];
            console.log('VectHare: Collection registry dump:', registry);
            toastr.info(`Collection registry dumped to console (${registry.length} items)`);
        } catch (e) {
            console.error('VectHare: Failed to dump registry', e);
            toastr.error('Failed to dump registry: ' + e.message);
        }
    });

    // Apply first semantic hit to ST World Info (best-effort)
    $('#vecthare_wi_apply_first').on('click', async function() {
        try {
            const raw = $('#vecthare_wi_test_input').val() || '';
            const recentMessages = raw.split('\n').map(s => s.trim()).filter(Boolean);
            const cfg = window.extension_settings?.vecthare || settings;

            if (!window.VectHare_WorldInfo || !window.VectHare_WorldInfo.getSemanticEntries) {
                toastr.error('VectHare: WorldInfo hooks not initialized');
                return;
            }

            const entries = await window.VectHare_WorldInfo.getSemanticEntries(recentMessages, [], cfg);
            if (!entries || entries.length === 0) {
                toastr.info('No semantic entries found');
                return;
            }

            const first = entries[0];
            console.log('VectHare: Applying semantic WI entry:', first);

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
                        console.log(`VectHare: Applied via world-info.${name}`);
                        break;
                    }
                }
            } catch (e) {
                console.debug('VectHare: world-info import failed or method not found', e);
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
                            console.log('VectHare: Applied via global fallback function');
                            break;
                        } catch (e) {
                            console.debug('VectHare: fallback apply failed', e);
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
                console.log('VectHare: Clipboard write failed, showing content in console');
                console.log('Semantic entry content:', text);
                toastr.info('Semantic entry logged to console. Paste into World Info editor to activate.');
            }

        } catch (e) {
            console.error('VectHare: Apply semantic WI failed', e);
            toastr.error('Failed to apply semantic WI entry: ' + e.message);
        }
    });

    // Injection position (where chunks appear in prompt)
    $('#vecthare_injection_position')
        .val(settings.position ?? 0)
        .on('change', function() {
            const value = parseInt($(this).val());
            settings.position = value;
            Object.assign(extension_settings.vecthare, settings);
            saveSettingsDebounced();
            // Show/hide depth slider based on position
            $('#vecthare_injection_depth_row').toggle(value === 1);
        });
    // Initialize depth row visibility
    $('#vecthare_injection_depth_row').toggle((settings.position ?? 0) === 1);

    // Injection depth (for in-chat position)
    $('#vecthare_injection_depth')
        .val(settings.depth ?? 2)
        .on('input', function() {
            const value = parseInt($(this).val());
            const safeValue = isNaN(value) ? 2 : value;
            $('#vecthare_injection_depth_value').text(safeValue);
            settings.depth = safeValue;
            Object.assign(extension_settings.vecthare, settings);
            saveSettingsDebounced();
        });
    $('#vecthare_injection_depth_value').text(settings.depth ?? 2);

    // RAG Context settings
    $('#vecthare_rag_context')
        .val(settings.rag_context || '')
        .on('input', function() {
            settings.rag_context = $(this).val();
            Object.assign(extension_settings.vecthare, settings);
            saveSettingsDebounced();
        });

    $('#vecthare_rag_xml_tag')
        .val(settings.rag_xml_tag || '')
        .on('input', function() {
            // Sanitize: only allow alphanumeric, underscore, hyphen
            const sanitized = $(this).val().replace(/[^a-zA-Z0-9_-]/g, '');
            $(this).val(sanitized);
            settings.rag_xml_tag = sanitized;
            Object.assign(extension_settings.vecthare, settings);
            saveSettingsDebounced();
        });

    // Global temporal weighting defaults
    const updateDecayTypeSection = (enabled) => {
        const $section = $('#vecthare_default_decay_type_section');
        const $radios = $section.find('input[type="radio"]');

        if (enabled) {
            $section.removeClass('vecthare-subsection-disabled');
            $radios.prop('disabled', false);
            // Select the saved type (or default to 'decay') when enabling
            const savedType = settings.default_decay_type || 'decay';
            $(`input[name="vecthare_default_decay_type"][value="${savedType}"]`).prop('checked', true);
        } else {
            $section.addClass('vecthare-subsection-disabled');
            $radios.prop('disabled', true).prop('checked', false);
        }
    };

    $('#vecthare_default_decay_enabled')
        .prop('checked', settings.default_decay_enabled || false)
        .on('change', function() {
            const enabled = $(this).prop('checked');
            settings.default_decay_enabled = enabled;
            updateDecayTypeSection(enabled);
            Object.assign(extension_settings.vecthare, settings);
            saveSettingsDebounced();
        });

    // Initialize the section state
    updateDecayTypeSection(settings.default_decay_enabled || false);

    $('input[name="vecthare_default_decay_type"]').on('change', function() {
        settings.default_decay_type = $(this).val();
        Object.assign(extension_settings.vecthare, settings);
        saveSettingsDebounced();
    });

    // Provider-specific settings

    // ElectronHub model
    $('#vecthare_electronhub_model')
        .val(settings.electronhub_model)
        .on('change', function() {
            settings.electronhub_model = String($(this).val());
            Object.assign(extension_settings.vecthare, settings);
            saveSettingsDebounced();
        });

    // Alternative endpoint
    $('#vecthare_use_alt_endpoint')
        .prop('checked', settings.use_alt_endpoint)
        .on('input', function() {
            settings.use_alt_endpoint = $(this).prop('checked');
            Object.assign(extension_settings.vecthare, settings);
            saveSettingsDebounced();
            $('#vecthare_alt_endpoint_url').toggle(settings.use_alt_endpoint);
        });

    $('#vecthare_alt_endpoint_url')
        .val(settings.alt_endpoint_url)
        .toggle(settings.use_alt_endpoint)
        .on('input', function() {
            settings.alt_endpoint_url = String($(this).val());
            Object.assign(extension_settings.vecthare, settings);
            saveSettingsDebounced();
        });

    // WebLLM model
    $('#vecthare_webllm_model')
        .val(settings.webllm_model)
        .on('change', function() {
            settings.webllm_model = String($(this).val());
            Object.assign(extension_settings.vecthare, settings);
            saveSettingsDebounced();
        });

    // WebLLM Load Model button
    $('#vecthare_webllm_load').on('click', async function() {
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
    $('#vecthare_webllm_install').on('click', function(e) {
        e.preventDefault();
        e.stopPropagation();

        if (Object.hasOwn(SillyTavern, 'llm')) {
            toastr.info('WebLLM extension is already installed. Try refreshing the page.', 'Already Installed');
            return;
        }

        openThirdPartyExtensionMenu('https://github.com/SillyTavern/Extension-WebLLM');
    });

    // Ollama model
    $('#vecthare_ollama_model')
        .val(settings.ollama_model)
        .on('input', function() {
            settings.ollama_model = String($(this).val());
            Object.assign(extension_settings.vecthare, settings);
            saveSettingsDebounced();
        });

    $('#vecthare_ollama_keep')
        .prop('checked', settings.ollama_keep)
        .on('input', function() {
            settings.ollama_keep = $(this).prop('checked');
            Object.assign(extension_settings.vecthare, settings);
            saveSettingsDebounced();
        });

    // BananaBread reranking
    $('#vecthare_bananabread_rerank')
        .prop('checked', settings.bananabread_rerank)
        .on('input', function() {
            settings.bananabread_rerank = $(this).prop('checked');
            Object.assign(extension_settings.vecthare, settings);
            saveSettingsDebounced();
        });

    // BananaBread API key
    // Note: We store in extension settings because custom keys aren't returned by ST's readSecretState()
    const updateBananaBreadKeyDisplay = () => {
        const savedKey = settings.bananabread_api_key;
        if (savedKey) {
            // Mask the key for display (show last 4 chars)
            const masked = savedKey.length > 4
                ? '*'.repeat(Math.min(savedKey.length - 4, 8)) + savedKey.slice(-4)
                : '*'.repeat(savedKey.length);
            $('#vecthare_bananabread_apikey').attr('placeholder', `Key saved: ${masked}`);
        } else {
            $('#vecthare_bananabread_apikey').attr('placeholder', 'Paste key here to save...');
        }
    };
    updateBananaBreadKeyDisplay();

    $('#vecthare_bananabread_apikey')
        .on('change', async function() {
            const value = String($(this).val()).trim();
            if (value) {
                // Store in extension settings (primary storage for this key)
                settings.bananabread_api_key = value;
                Object.assign(extension_settings.vecthare, settings);
                saveSettingsDebounced();

                // Also write to ST secrets for potential future compatibility
                await writeSecret('bananabread_api_key', value);

                toastr.success('BananaBread API key saved');
                $(this).val('');
                updateBananaBreadKeyDisplay();
            }
        });

    // OpenAI model
    $('#vecthare_openai_model')
        .val(settings.openai_model)
        .on('change', function() {
            settings.openai_model = String($(this).val());
            Object.assign(extension_settings.vecthare, settings);
            saveSettingsDebounced();
        });

    // Cohere model
    $('#vecthare_cohere_model')
        .val(settings.cohere_model)
        .on('change', function() {
            settings.cohere_model = String($(this).val());
            Object.assign(extension_settings.vecthare, settings);
            saveSettingsDebounced();
        });

    // TogetherAI model
    $('#vecthare_togetherai_model')
        .val(settings.togetherai_model)
        .on('change', function() {
            settings.togetherai_model = String($(this).val());
            Object.assign(extension_settings.vecthare, settings);
            saveSettingsDebounced();
        });

    // vLLM model
    $('#vecthare_vllm_model')
        .val(settings.vllm_model)
        .on('input', function() {
            settings.vllm_model = String($(this).val());
            Object.assign(extension_settings.vecthare, settings);
            saveSettingsDebounced();
        });

    // Google model
    $('#vecthare_google_model')
        .val(settings.google_model)
        .on('change', function() {
            settings.google_model = String($(this).val());
            Object.assign(extension_settings.vecthare, settings);
            saveSettingsDebounced();
        });

    // OpenRouter model
    $('#vecthare_openrouter_model')
        .val(settings.openrouter_model)
        .on('input', function() {
            settings.openrouter_model = String($(this).val());
            Object.assign(extension_settings.vecthare, settings);
            saveSettingsDebounced();
        });

    // OpenRouter API key - saves directly to ST secrets
    // Show existing key if set
    const updateOpenRouterKeyDisplay = () => {
        const secrets = secret_state[SECRET_KEYS.OPENROUTER];
        if (Array.isArray(secrets) && secrets.length > 0) {
            const activeSecret = secrets.find(s => s.active) || secrets[0];
            if (activeSecret?.value) {
                $('#vecthare_openrouter_apikey').attr('placeholder', activeSecret.value);
            }
        }
    };
    updateOpenRouterKeyDisplay();

    $('#vecthare_openrouter_apikey')
        .on('change', async function() {
            const value = String($(this).val()).trim();
            if (value) {
                await writeSecret(SECRET_KEYS.OPENROUTER, value);
                await readSecretState(); // Refresh state to get masked value
                toastr.success('OpenRouter API key saved');
                $(this).val(''); // Clear input
                updateOpenRouterKeyDisplay(); // Show masked key in placeholder
            }
        });

    // Rate Limiting
    $('#vecthare_rate_limit_calls')
        .val(settings.rate_limit_calls || 0)
        .on('input', function() {
            const value = parseInt($(this).val());
            settings.rate_limit_calls = isNaN(value) ? 0 : value;
            Object.assign(extension_settings.vecthare, settings);
            saveSettingsDebounced();
        });

    $('#vecthare_rate_limit_interval')
        .val(settings.rate_limit_interval || 60)
        .on('input', function() {
            const value = parseInt($(this).val());
            settings.rate_limit_interval = isNaN(value) ? 60 : value;
            Object.assign(extension_settings.vecthare, settings);
            saveSettingsDebounced();
        });

    // VEC-6: Insert Batch Size
    $('#vecthare_insert_batch_size')
        .val(settings.insert_batch_size || 50)
        .on('input', function() {
            const value = parseInt($(this).val());
            $('#vecthare_insert_batch_size_value').text(value);
            settings.insert_batch_size = value;
            Object.assign(extension_settings.vecthare, settings);
            saveSettingsDebounced();
        });
    $('#vecthare_insert_batch_size_value').text(settings.insert_batch_size || 50);

    // Minimum chat length before injection starts
    $('#vecthare_min_chat_length')
        .val(settings.min_chat_length ?? 0)
        .on('input', function() {
            const value = parseInt($(this).val());
            settings.min_chat_length = isNaN(value) ? 0 : Math.max(0, value);
            Object.assign(extension_settings.vecthare, settings);
            saveSettingsDebounced();
        });

    // Action buttons
    $('#vecthare_vectorize_content').on('click', () => {
        openContentVectorizer();
    });
    $('#vecthare_vectorize_all').on('click', callbacks.onVectorizeAll);
    $('#vecthare_purge').on('click', callbacks.onPurge);
    $('#vecthare_run_diagnostics').on('click', callbacks.onRunDiagnostics);
    $('#vecthare_database_browser').on('click', () => {
        openDatabaseBrowser();
    });
    $('#vecthare_view_results').on('click', () => {
        openSearchDebugModal();
    });
    $('#vecthare_text_cleaning').on('click', () => {
        openTextCleaningManager();
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
        $('#vecthare_cottontales_section').show();
        console.log('VectHare: Cotton-Tales detected, showing emotion classification options');
    } else {
        $('#vecthare_cottontales_section').hide();
        return;
    }

    // Import emotion classifier module
    let emotionClassifier;
    try {
        emotionClassifier = await import('../core/emotion-classifier.js');
    } catch (error) {
        console.error('VectHare: Failed to load emotion classifier module:', error);
        return;
    }

    // Helper to update UI based on method selection
    function updateMethodUI(method) {
        $('#vecthare_classifier_settings').toggle(method === 'classifier');
        $('#vecthare_similarity_settings').toggle(method === 'similarity');

        // Update the display of current embedding source for similarity mode
        if (method === 'similarity') {
            $('#vecthare_similarity_source_display').text(settings.source || 'transformers');
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
    $('#vecthare_emotion_method')
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

            Object.assign(extension_settings.vecthare, settings);
            saveSettingsDebounced();
            updateMethodUI(method);
        });

    // Initialize UI for current method
    updateMethodUI(getCurrentMethod());

    // Classifier model selection
    $('#vecthare_emotion_classifier_model')
        .val(settings.emotion_classifier_model || 'SamLowe/roberta-base-go_emotions')
        .on('change', function() {
            const value = $(this).val();

            if (value === 'custom') {
                $('#vecthare_custom_classifier_model').show();
            } else {
                $('#vecthare_custom_classifier_model').hide();
                settings.emotion_classifier_model = value;
                Object.assign(extension_settings.vecthare, settings);
                saveSettingsDebounced();
                emotionClassifier.updateClassifierSetting('model', value);
            }
        });

    // Show custom model input if currently set to custom
    if (settings.emotion_classifier_model &&
        !['SamLowe/roberta-base-go_emotions', 'j-hartmann/emotion-english-distilroberta-base', 'bhadresh-savani/distilbert-base-uncased-emotion'].includes(settings.emotion_classifier_model)) {
        $('#vecthare_emotion_classifier_model').val('custom');
        $('#vecthare_custom_classifier_model').show();
    }

    // Custom model input
    $('#vecthare_emotion_classifier_custom')
        .val(settings.emotion_classifier_custom || '')
        .on('input', function() {
            settings.emotion_classifier_custom = $(this).val();
            settings.emotion_classifier_model = $(this).val();
            Object.assign(extension_settings.vecthare, settings);
            saveSettingsDebounced();
            emotionClassifier.updateClassifierSetting('model', $(this).val());
        });

    // Test classifier button
    $('#vecthare_test_classifier').on('click', async function() {
        const $btn = $(this);
        const $result = $('#vecthare_classifier_test_result');

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
    const output = $('#vecthare_diagnostics_content');
    output.empty();

    console.log('VectHare UI: Rendering diagnostics with results:', results);
    console.log('VectHare UI: Version data received:', results.version);
    console.log('VectHare UI: Extension version:', results.version?.extension);
    console.log('VectHare UI: Plugin version:', results.version?.plugin);

    const statusIcons = {
        'pass': '<i class="fa-solid fa-circle-check" style="color: var(--vecthare-success);"></i>',
        'warning': '<i class="fa-solid fa-triangle-exclamation" style="color: var(--vecthare-warning);"></i>',
        'fail': '<i class="fa-solid fa-circle-xmark" style="color: var(--vecthare-danger);"></i>',
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
        <div class="vecthare-diagnostics-version" style="padding: 10px 15px; background: var(--black30alpha); border-radius: 8px; margin-bottom: 15px; font-size: 0.9em; color: var(--grey70);">
            <i class="fa-solid fa-info-circle"></i>
            <strong>Extension:</strong> v${results.version?.extension || 'Unknown'}
            <span style="margin: 0 10px;">•</span>
            <strong>Plugin:</strong> v${results.version?.plugin || 'Not installed'}
        </div>

        <!-- Summary Stats Bar (Clickable Filters) -->
        <div class="vecthare-diagnostics-stats">
            <div class="vecthare-diag-stat pass ${filter === 'pass' ? 'active' : ''}" data-filter="pass" title="Click to filter by passed">
                ${statusIcons.pass}
                <span class="vecthare-diag-stat-count">${passCount}</span>
                <span class="vecthare-diag-stat-label">Passed</span>
            </div>
            <div class="vecthare-diag-stat warning ${filter === 'warning' ? 'active' : ''}" data-filter="warning" title="Click to filter by warnings">
                ${statusIcons.warning}
                <span class="vecthare-diag-stat-count">${warnCount}</span>
                <span class="vecthare-diag-stat-label">Warnings</span>
            </div>
            <div class="vecthare-diag-stat fail ${filter === 'fail' ? 'active' : ''}" data-filter="fail" title="Click to filter by failed">
                ${statusIcons.fail}
                <span class="vecthare-diag-stat-count">${failCount}</span>
                <span class="vecthare-diag-stat-label">Failed</span>
            </div>
        </div>

        ${filter !== 'all' ? `
            <div class="vecthare-diag-filter-notice">
                <span>Showing only: <strong>${filter}</strong></span>
                <button class="vecthare-diag-clear-filter" data-filter="all">
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
                        <div class="vecthare-diagnostics">
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
    $('#vecthare_diagnostics_title').text(titleText);

    // Show/hide Fix All button based on fixable issues
    if (fixableCount > 0) {
        $('#vecthare_diag_fix_all')
            .show()
            .html(`<i class="fa-solid fa-wand-magic-sparkles"></i> Fix All (${fixableCount})`)
            .off('click')
            .on('click', function() {
                handleFixAll(results.checks);
            });
    } else {
        $('#vecthare_diag_fix_all').hide();
    }

    // Bind filter click handlers on stat boxes
    $('.vecthare-diag-stat').off('click').on('click', function() {
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
    $('.vecthare-diag-clear-filter').off('click').on('click', function() {
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
    $('#vecthare_diag_copy').off('click').on('click', function() {
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
    const settings = extension_settings.vecthare;
    const backend = settings.vector_backend || 'standard';
    const source = settings.source || 'none';
    const modelField = getModelField(source);
    const model = modelField ? (settings[modelField] || 'not set') : 'n/a (provider handles it)';
    const qdrantMode = settings.qdrant_mode || 'local';
    const qdrantUrl = backend === 'qdrant'
        ? (qdrantMode === 'cloud' ? settings.qdrant_cloud_url : settings.qdrant_url)
        : null;

    // Build provider URL info
    let providerUrl = 'n/a';
    if (settings.use_alt_endpoint && settings.alt_endpoint_url) {
        providerUrl = settings.alt_endpoint_url;
    } else if (['bananabread', 'ollama', 'llamacpp', 'koboldcpp', 'vllm'].includes(source)) {
        // Local server providers - show their configured URL
        providerUrl = settings.alt_endpoint_url || 'http://localhost:8008';
    }

    let report = `╔══════════════════════════════════════════════════════════════╗
║              VECTHARE DIAGNOSTICS REPORT                      ║
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
        toastr.success(`Diagnostics report${filterMsg} copied to clipboard`, 'VectHare');
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
    $('#vecthare_diagnostics_title').text('Run Diagnostics');
    $('#vecthare_diagnostics_modal').fadeIn(200);
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
        'pass': '<i class="fa-solid fa-circle-check" style="color: var(--vecthare-success);"></i>'
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
    $('#vecthare_diag_fix_all').fadeOut(200);

    toastr.success(`Fixed ${fixedCount} issue${fixedCount !== 1 ? 's' : ''}`);
}

/**
 * Handles diagnostic fix actions
 * @param {string} action - The fix action to perform
 * @param {boolean} silent - If true, suppress toast notifications and don't close modal
 */
function handleDiagnosticFix(action, silent = false) {
    const settings = extension_settings.vecthare;

    switch (action) {
        case 'enable_chats':
            $('#vecthare_autosync_enabled').prop('checked', true).trigger('change');
            if (!silent) toastr.success('Chat auto-sync enabled');
            break;

        case 'vectorize_all':
            $('#vecthare_vectorize_all').click();
            break;

        case 'configure_provider':
            // Scroll to provider settings
            $('#vecthare_provider_settings')[0]?.scrollIntoView({ behavior: 'smooth' });
            if (!silent) toastr.info('Please select an embedding provider');
            break;

        case 'configure_api_key':
            if (!silent) toastr.info('Go to Settings > API Connections to add your API key');
            break;

        case 'configure_url':
            // Scroll to provider settings
            $('#vecthare_provider_settings')[0]?.scrollIntoView({ behavior: 'smooth' });
            if (!silent) toastr.info('Please configure your API URL in the provider settings');
            break;

        case 'fix_threshold':
            $('#vecthare_score_threshold').val(0.25).trigger('change');
            if (!silent) toastr.success('Score threshold reset to 0.25');
            break;

        case 'fix_counts':
            if (settings.insert < 1) {
                $('#vecthare_insert').val(3).trigger('change');
            }
            if ((settings.top_k ?? settings.insert) < 1) {
                $('#vecthare_topk').val(3).trigger('change');
            }
            if (settings.query < 1) {
                $('#vecthare_query').val(2).trigger('change');
            }
            if (!silent) toastr.success('Insert/Query counts fixed');
            break;

        case 'fix_chunk_size':
            $('#vecthare_chunk_size').val(500).trigger('input');
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
        <div class="vecthare-dimension-fix-dialog">
            <h3 style="margin-top: 0; color: var(--vecthare-danger);">
                <i class="fa-solid fa-triangle-exclamation"></i> Vector Dimension Mismatch
            </h3>

            <div class="vecthare-dimension-info" style="background: var(--SmartThemeBlurTintColor); padding: 12px; border-radius: 8px; margin-bottom: 16px;">
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

            <div class="vecthare-dimension-options" style="display: flex; flex-direction: column; gap: 12px;">
                <button id="vecthare_dim_fix_purge" class="vecthare-btn-danger" style="padding: 12px; text-align: left;">
                    <i class="fa-solid fa-trash"></i>
                    <strong>Purge collection and start fresh</strong>
                    <br><small style="opacity: 0.8;">Delete all ${pointsCount.toLocaleString()} vectors and re-vectorize with your current model</small>
                </button>

                <button id="vecthare_dim_fix_switch" class="vecthare-btn-secondary" style="padding: 12px; text-align: left;">
                    <i class="fa-solid fa-rotate-left"></i>
                    <strong>I'll switch my embedding model back</strong>
                    <br><small style="opacity: 0.8;">Keep your vectors; change your embedding settings to match (${sources}${models !== '(not recorded)' ? ': ' + models : ''})</small>
                </button>

                <button id="vecthare_dim_fix_cancel" class="vecthare-btn-secondary" style="padding: 12px; text-align: left;">
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
    $('#vecthare_dim_fix_purge').off('click').on('click', async () => {
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
                    body: JSON.stringify({ collectionName: 'vecthare_main' })
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

    $('#vecthare_dim_fix_switch').off('click').on('click', () => {
        $('.popup-button-close').click();
        toastr.info(`Switch your embedding provider to "${sources}"${models !== '(not recorded)' ? ` with model "${models}"` : ''} to match your stored vectors.`);
        closeDiagnosticsModal();
        // Scroll to provider settings
        $('#vecthare_provider_settings')[0]?.scrollIntoView({ behavior: 'smooth' });
    });

    $('#vecthare_dim_fix_cancel').off('click').on('click', () => {
        $('.popup-button-close').click();
    });
}

/**
 * Hides diagnostics output
 */
export function hideDiagnosticsResults() {
    $('#vecthare_diagnostics_output').hide();
}
