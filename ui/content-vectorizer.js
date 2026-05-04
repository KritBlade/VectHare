/**
 * ============================================================================
 * VECTHARE CONTENT VECTORIZER UI
 * ============================================================================
 * Modal interface for vectorizing different content types with intelligent
 * settings that adapt based on selected content type.
 *
 * @author Coneja Chibi
 * @version 2.2.0-alpha
 * ============================================================================
 */

import {
    CONTENT_TYPES,
    CHUNKING_STRATEGIES,
    getContentType,
    getAllContentTypes,
    getChunkingStrategies,
    getChunkingStrategy,
    strategyNeedsSize,
    strategyNeedsOverlap,
    getContentTypeDefaults,
    hasFeature,
    SCOPE_OPTIONS,
    CHARACTER_FIELDS,
} from '../core/content-types.js';
import { extension_settings, getContext } from '../../../../extensions.js';
import { saveSettingsDebounced } from '../../../../../script.js';
import { getChatUUID } from '../core/chat-vectorization.js';
import { callGenericPopup, POPUP_TYPE } from '../../../../popup.js';
import { openTextCleaningManager } from './text-cleaning-manager.js';
import { getCleaningSettings } from '../core/text-cleaning.js';
import { progressTracker } from './progress-tracker.js';

// ============================================================================
// STATE
// ============================================================================

let currentContentType = 'lorebook';
let currentSettings = {};
let sourceData = null;
let activeVectorizeAbortController = null;
let isVectorizing = false;

function updateVectorizeButtonState(running) {
    const btn = $('#vecthare_cv_vectorize');
    const cancelBtn = $('#vecthare_cv_cancel');
    const continueBtn = $('#vecthare_cv_continue');

    if (running) {
        btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i> Vectorizing...');
        cancelBtn.html('<i class="fa-solid fa-stop"></i> Stop');
        continueBtn.prop('disabled', true);
    } else {
        btn.prop('disabled', false).html('<i class="fa-solid fa-bolt"></i> Vectorize');
        cancelBtn.text('Cancel');
        continueBtn.prop('disabled', false);
    }
}

function stopActiveVectorization() {
    if (activeVectorizeAbortController && !activeVectorizeAbortController.signal.aborted) {
        activeVectorizeAbortController.abort('user-stop');
    }
}

// ============================================================================
// MODAL CREATION
// ============================================================================

/**
 * Opens the content vectorizer modal
 * @param {string} initialType - Optional initial content type to select
 */
export function openContentVectorizer(initialType = null) {
    currentContentType = initialType;
    currentSettings = initialType ? { ...getContentTypeDefaults(initialType) } : {};
    sourceData = null;

    createModal();
    bindEvents();

    // Only show subsequent sections if type is pre-selected
    if (currentContentType) {
        updateUIForContentType();
        $('.vecthare-cv-subsequent').show();
    } else {
        $('.vecthare-cv-subsequent').hide();
    }

    // Stop mousedown propagation (ST closes drawers on mousedown/touchstart)
    $('#vecthare_content_vectorizer_modal').on('mousedown touchstart', function(e) {
        e.stopPropagation();
    });

    $('#vecthare_content_vectorizer_modal').fadeIn(200);
}

/**
 * Closes the modal
 */
export function closeContentVectorizer() {
    $('#vecthare_content_vectorizer_modal').fadeOut(200, function() {
        $(this).remove();
    });
}

/**
 * Creates the modal HTML
 */
function createModal() {
    // Remove existing
    $('#vecthare_content_vectorizer_modal').remove();

    const contentTypes = getAllContentTypes(); // All types including chat

    const html = `
        <div id="vecthare_content_vectorizer_modal" class="vecthare-modal">
            <div class="vecthare-modal-overlay"></div>
            <div class="vecthare-modal-content vecthare-content-vectorizer">
                <div class="vecthare-modal-header">
                    <h3>
                        <i class="fa-solid fa-database"></i>
                        Vectorize Content
                    </h3>
                    <button class="vecthare-modal-close" id="vecthare_cv_close">
                        <i class="fa-solid fa-times"></i>
                    </button>
                </div>

                <div class="vecthare-cv-body">
                    <!-- Step 1: Content Type Selection - BIG DROPDOWN -->
                    <div class="vecthare-cv-section vecthare-cv-type-section">
                        <div class="vecthare-cv-type-dropdown-wrapper">
                            <label class="vecthare-cv-main-label">What do you want to vectorize?</label>
                            <select id="vecthare_cv_type_select" class="vecthare-cv-type-dropdown">
                                <option value="">-- Choose content type --</option>
                                ${contentTypes.map(type => `
                                    <option value="${type.id}" ${type.id === currentContentType ? 'selected' : ''}>
                                        ${type.name}
                                    </option>
                                `).join('')}
                            </select>
                            <span class="vecthare-cv-type-hint" id="vecthare_cv_type_hint">
                                Select a content type to continue
                            </span>
                        </div>
                    </div>

                    <!-- Step 2: Source Selection (changes based on type) -->
                    <div class="vecthare-cv-section vecthare-cv-source-section vecthare-cv-subsequent">
                        <div class="vecthare-cv-section-header">
                            <span class="vecthare-cv-step-number">2</span>
                            <span class="vecthare-cv-section-title" id="vecthare_cv_source_title">Select Source</span>
                        </div>
                        <div id="vecthare_cv_source_content" class="vecthare-cv-section-body">
                            <!-- Dynamically populated based on content type -->
                        </div>
                    </div>

                    <!-- Step 3: Chunking Settings -->
                    <div class="vecthare-cv-section vecthare-cv-chunking-section vecthare-cv-subsequent">
                        <div class="vecthare-cv-section-header">
                            <span class="vecthare-cv-step-number">3</span>
                            <span class="vecthare-cv-section-title">Chunking Strategy</span>
                            <button class="vecthare-cv-collapse-btn" data-target="chunking">
                                <i class="fa-solid fa-chevron-down"></i>
                            </button>
                        </div>
                        <div class="vecthare-cv-collapsible" id="vecthare_cv_chunking_content">
                            <div class="vecthare-cv-strategy-select">
                                <label>Strategy</label>
                                <select id="vecthare_cv_strategy" class="vecthare-select">
                                    <!-- Populated dynamically -->
                                </select>
                                <span class="vecthare-cv-strategy-desc" id="vecthare_cv_strategy_desc"></span>
                            </div>

                            <!-- Size/Overlap controls - only shown for text-based strategies -->
                            <div class="vecthare-cv-size-controls" id="vecthare_cv_size_controls">
                                <div class="vecthare-cv-slider-row" id="vecthare_cv_chunk_size_row">
                                    <label>
                                        Chunk Size
                                        <span class="vecthare-cv-value" id="vecthare_cv_chunk_size_val">400</span> chars
                                    </label>
                                    <input type="range" id="vecthare_cv_chunk_size"
                                           min="100" max="1000" step="50" value="400">
                                    <div class="vecthare-cv-slider-hints">
                                        <span>Precise</span>
                                        <span>Contextual</span>
                                    </div>
                                </div>
                                <div class="vecthare-cv-slider-row" id="vecthare_cv_overlap_row">
                                    <label>
                                        Chunk Overlap
                                        <span class="vecthare-cv-value" id="vecthare_cv_overlap_val">50</span> chars
                                    </label>
                                    <input type="range" id="vecthare_cv_overlap"
                                           min="0" max="200" step="10" value="50">
                                    <div class="vecthare-cv-slider-hints">
                                        <span>Off</span>
                                        <span>High</span>
                                    </div>
                                </div>
                                <!-- Batch size - only shown for message_batch strategy -->
                                <div class="vecthare-cv-slider-row" id="vecthare_cv_batch_size_row" style="display:none;">
                                    <label>
                                        Messages per Batch
                                        <span class="vecthare-cv-value" id="vecthare_cv_batch_size_val">4</span>
                                    </label>
                                    <input type="range" id="vecthare_cv_batch_size"
                                           min="1" max="20" step="1" value="4">
                                    <div class="vecthare-cv-slider-hints">
                                        <span>1 msg</span>
                                        <span>20 msgs</span>
                                    </div>
                                </div>
                                <!-- Group request size - only shown for message_group_batch strategy -->
                                <div class="vecthare-cv-slider-row" id="vecthare_cv_group_batch_size_row" style="display:none;">
                                    <label>
                                        Messages per AI Request
                                        <span class="vecthare-cv-value" id="vecthare_cv_group_batch_size_val">10</span>
                                    </label>
                                    <input type="range" id="vecthare_cv_group_batch_size"
                                           min="6" max="30" step="1" value="10">
                                    <div class="vecthare-cv-slider-hints">
                                        <span>6 msgs</span>
                                        <span>30 msgs</span>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- Step 4: Type-Specific Options -->
                    <div class="vecthare-cv-section vecthare-cv-options-section vecthare-cv-subsequent">
                        <div class="vecthare-cv-section-header">
                            <span class="vecthare-cv-step-number">4</span>
                            <span class="vecthare-cv-section-title">Options</span>
                            <button class="vecthare-cv-collapse-btn" data-target="options">
                                <i class="fa-solid fa-chevron-down"></i>
                            </button>
                        </div>
                        <div class="vecthare-cv-collapsible" id="vecthare_cv_options_content">
                            <!-- Dynamically populated based on content type -->
                        </div>
                    </div>

                    <!-- Preview Section -->
                    <div class="vecthare-cv-section vecthare-cv-preview-section" style="display: none;">
                        <div class="vecthare-cv-section-header">
                            <span class="vecthare-cv-step-number"><i class="fa-solid fa-eye"></i></span>
                            <span class="vecthare-cv-section-title">Preview</span>
                        </div>
                        <div id="vecthare_cv_preview_content" class="vecthare-cv-preview">
                            <!-- Preview of chunks will appear here -->
                        </div>
                    </div>
                </div>

                <div class="vecthare-cv-footer">
                    <button class="vecthare-btn-secondary" id="vecthare_cv_cancel">Cancel</button>
                    <button class="vecthare-btn-secondary" id="vecthare_cv_preview_btn">
                        <i class="fa-solid fa-eye"></i> Preview Chunks
                    </button>
                    <button class="vecthare-btn-secondary" id="vecthare_cv_continue" style="display: none;">
                        <i class="fa-solid fa-forward"></i> Continue
                    </button>
                    <button class="vecthare-btn-primary" id="vecthare_cv_vectorize">
                        <i class="fa-solid fa-bolt"></i> Vectorize
                    </button>
                </div>
            </div>
        </div>
    `;

    $('body').append(html);
}

// ============================================================================
// UI UPDATES
// ============================================================================

/**
 * Updates the entire UI based on selected content type
 */
function updateUIForContentType() {
    const type = getContentType(currentContentType);
    if (!type) return;

    // Update source section
    updateSourceSection(type);

    // Update chunking strategies
    updateChunkingSection(type);

    // Update options section
    updateOptionsSection(type);

    // Show Continue button only for chat type (backfills missing chunks via hash dedup)
    const isChatType = currentContentType === 'chat';
    $('#vecthare_cv_continue').toggle(isChatType);
}

/**
 * Updates the source selection section
 */
function updateSourceSection(type) {
    const container = $('#vecthare_cv_source_content');
    container.empty();

    let html = '';

    switch (type.sourceType) {
        case 'select':
            html = renderSelectSource(type);
            break;
        case 'input':
            html = renderInputSource(type);
            break;
        case 'url':
            html = renderUrlSource(type);
            break;
        case 'chat':
            html = renderChatSource(type);
            break;
        case 'current':
            html = renderCurrentChatSource(type);
            break;
        case 'wiki':
            html = renderWikiSource(type);
            break;
        case 'youtube':
            html = renderYouTubeSource(type);
            break;
    }

    container.html(html);

    // Bind source-specific events after rendering
    bindSourceEvents(type);
}

/**
 * Renders URL input source
 */
function renderUrlSource(type) {
    const options = type.sourceOptions;

    return `
        <div class="vecthare-cv-url-source">
            <label>Enter URL</label>
            <div class="vecthare-cv-url-input-row">
                <input type="text" id="vecthare_cv_url_input"
                       class="vecthare-input"
                       placeholder="${options.placeholder || 'https://example.com'}">
                <button id="vecthare_cv_fetch_url" class="vecthare-btn-primary">
                    <i class="fa-solid fa-download"></i> Fetch
                </button>
            </div>
            <div class="vecthare-cv-url-status" id="vecthare_cv_url_status"></div>
            <div class="vecthare-cv-url-preview" id="vecthare_cv_url_preview" style="display: none;">
                <div class="vecthare-cv-url-preview-header">
                    <i class="fa-solid fa-check-circle"></i>
                    <span id="vecthare_cv_url_title">Page loaded</span>
                </div>
                <div class="vecthare-cv-url-preview-stats">
                    <span><strong id="vecthare_cv_url_chars">0</strong> characters</span>
                </div>
            </div>
        </div>
    `;
}

/**
 * Renders chat source with current chat + upload options
 */
function renderChatSource(type) {
    const context = getContext();
    const hasChat = !!context?.chatId;
    const messageCount = context?.chat?.length || 0;
    const options = type.sourceOptions;

    return `
        <div class="vecthare-cv-chat-source">
            <div class="vecthare-cv-source-tabs">
                <button class="vecthare-cv-source-tab ${hasChat ? 'active' : ''}" data-source="current" ${!hasChat ? 'disabled' : ''}>
                    <i class="fa-solid fa-comment-dots"></i> Current Chat
                </button>
                <button class="vecthare-cv-source-tab ${!hasChat ? 'active' : ''}" data-source="upload">
                    <i class="fa-solid fa-upload"></i> Upload
                </button>
            </div>

            <!-- Current Chat Panel -->
            <div class="vecthare-cv-source-panel" data-panel="current" ${!hasChat ? 'style="display: none;"' : ''}>
                ${hasChat ? `
                    <div class="vecthare-cv-chat-info">
                        <div class="vecthare-cv-chat-stats">
                            <div class="vecthare-cv-stat">
                                <span class="vecthare-cv-stat-value">${messageCount}</span>
                                <span class="vecthare-cv-stat-label">Messages</span>
                            </div>
                            <div class="vecthare-cv-stat">
                                <span class="vecthare-cv-stat-value">${context?.name2 || 'Unknown'}</span>
                                <span class="vecthare-cv-stat-label">Character</span>
                            </div>
                        </div>
                        <div class="vecthare-cv-chat-uuid" style="text-align: center; margin-top: 8px;">
                            <code style="font-size: 0.7em; opacity: 0.6; user-select: all;">${getChatUUID() || 'unknown'}</code>
                        </div>
                        <div class="vecthare-cv-chat-note">
                            <i class="fa-solid fa-info-circle"></i>
                            Will vectorize all messages in the current chat
                        </div>
                    </div>
                ` : `
                    <div class="vecthare-cv-no-chat">
                        <i class="fa-solid fa-comment-slash"></i>
                        <span>No chat is currently open</span>
                    </div>
                `}
            </div>

            <!-- Upload Panel -->
            <div class="vecthare-cv-source-panel" data-panel="upload" ${hasChat ? 'style="display: none;"' : ''}>
                <div class="vecthare-cv-upload-zone" id="vecthare_cv_chat_upload_zone">
                    <i class="fa-solid fa-cloud-arrow-up"></i>
                    <span>Drop chat file here or click to browse</span>
                    <span class="vecthare-cv-upload-formats">
                        Formats: ${options.uploadFormats.join(', ')}
                    </span>
                    <input type="file" id="vecthare_cv_chat_file_input"
                           accept="${options.uploadFormats.join(',')}" hidden>
                </div>
                <div class="vecthare-cv-upload-info" id="vecthare_cv_chat_upload_info" style="display: none;">
                    <i class="fa-solid fa-file"></i>
                    <span id="vecthare_cv_chat_upload_filename"></span>
                    <button class="vecthare-cv-upload-clear" id="vecthare_cv_chat_upload_clear">
                        <i class="fa-solid fa-times"></i>
                    </button>
                </div>
                <div class="vecthare-cv-chat-upload-stats" id="vecthare_cv_chat_upload_stats" style="display: none;">
                    <!-- Populated after file upload -->
                </div>
                <div class="vecthare-cv-upload-hint">
                    <strong>Supported formats:</strong><br>
                    • <code>.jsonl</code> - JSON Lines (one message per line)<br>
                    • <code>.json</code> - SillyTavern chat export<br>
                    • <code>.txt</code> - Plain text (will be chunked as-is)
                </div>
            </div>
        </div>
    `;
}

/**
 * Renders current chat source (for chat type) - legacy, kept for compatibility
 */
function renderCurrentChatSource(type) {
    const context = getContext();
    const hasChat = !!context?.chatId;
    const messageCount = context?.chat?.length || 0;

    if (!hasChat) {
        return `
            <div class="vecthare-cv-no-chat">
                <i class="fa-solid fa-comment-slash"></i>
                <span>No chat is currently open</span>
                <span class="vecthare-cv-hint">Open a chat to vectorize its messages</span>
            </div>
        `;
    }

    return `
        <div class="vecthare-cv-chat-info">
            <div class="vecthare-cv-chat-stats">
                <div class="vecthare-cv-stat">
                    <span class="vecthare-cv-stat-value">${messageCount}</span>
                    <span class="vecthare-cv-stat-label">Messages</span>
                </div>
                <div class="vecthare-cv-stat">
                    <span class="vecthare-cv-stat-value">${context?.name2 || 'Unknown'}</span>
                    <span class="vecthare-cv-stat-label">Character</span>
                </div>
            </div>
            <div class="vecthare-cv-chat-uuid" style="text-align: center; margin-top: 8px;">
                <code style="font-size: 0.7em; opacity: 0.6; user-select: all;">${getChatUUID() || 'unknown'}</code>
            </div>
            <div class="vecthare-cv-chat-note">
                <i class="fa-solid fa-info-circle"></i>
                Will vectorize all messages in the current chat
            </div>
        </div>
    `;
}

/**
 * Renders select-based source (lorebook, character)
 */
function renderSelectSource(type) {
    const options = type.sourceOptions;

    return `
        <div class="vecthare-cv-source-select">
            <div class="vecthare-cv-source-tabs">
                <button class="vecthare-cv-source-tab active" data-source="existing">
                    <i class="fa-solid fa-list"></i> Existing
                </button>
                ${options.allowUpload ? `
                    <button class="vecthare-cv-source-tab" data-source="upload">
                        <i class="fa-solid fa-upload"></i> Upload
                    </button>
                ` : ''}
            </div>

            <div class="vecthare-cv-source-panel" data-panel="existing">
                <label>${options.selectLabel || 'Select'}</label>
                <select id="vecthare_cv_source_select" class="vecthare-select">
                    <option value="">-- Select --</option>
                    <!-- Populated dynamically -->
                </select>
                <!-- Stats display (shown after selection) -->
                <div class="vecthare-cv-source-stats" id="vecthare_cv_source_stats" style="display: none;">
                    <div class="vecthare-cv-stats-loading">
                        <i class="fa-solid fa-spinner fa-spin"></i> Loading info...
                    </div>
                </div>
            </div>

            ${options.allowUpload ? `
                <div class="vecthare-cv-source-panel" data-panel="upload" style="display: none;">
                    <div class="vecthare-cv-upload-zone" id="vecthare_cv_upload_zone">
                        <i class="fa-solid fa-cloud-arrow-up"></i>
                        <span>Drop file here or click to browse</span>
                        <span class="vecthare-cv-upload-formats">
                            Formats: ${options.uploadFormats.join(', ')}
                        </span>
                        <input type="file" id="vecthare_cv_file_input"
                               accept="${options.uploadFormats.join(',')}" hidden>
                    </div>
                    <div class="vecthare-cv-upload-info" id="vecthare_cv_upload_info" style="display: none;">
                        <i class="fa-solid fa-file"></i>
                        <span id="vecthare_cv_upload_filename"></span>
                        <button class="vecthare-cv-upload-clear" id="vecthare_cv_upload_clear">
                            <i class="fa-solid fa-times"></i>
                        </button>
                    </div>
                </div>
            ` : ''}
        </div>
    `;
}

/**
 * Renders input-based source (document)
 */
function renderInputSource(type) {
    const methods = type.sourceOptions.methods;

    return `
        <div class="vecthare-cv-input-source">
            <div class="vecthare-cv-input-tabs">
                ${methods.map((m, i) => `
                    <button class="vecthare-cv-input-tab ${i === 0 ? 'active' : ''}" data-method="${m.id}">
                        <i class="fa-solid ${m.icon}"></i>
                        <span>${m.name}</span>
                    </button>
                `).join('')}
            </div>

            <!-- Paste Text Panel -->
            <div class="vecthare-cv-input-panel" data-panel="paste">
                <textarea id="vecthare_cv_paste_text"
                          placeholder="Paste or type your text here..."
                          rows="8"></textarea>
            </div>

            <!-- Upload File Panel -->
            <div class="vecthare-cv-input-panel" data-panel="upload" style="display: none;">
                <div class="vecthare-cv-upload-zone" id="vecthare_cv_doc_upload_zone">
                    <i class="fa-solid fa-cloud-arrow-up"></i>
                    <span>Drop file here or click to browse</span>
                    <span class="vecthare-cv-upload-formats">
                        Formats: ${methods.find(m => m.id === 'upload')?.formats?.join(', ') || '.txt, .md'}
                    </span>
                    <input type="file" id="vecthare_cv_doc_file_input"
                           accept="${methods.find(m => m.id === 'upload')?.formats?.join(',') || '.txt,.md'}" hidden>
                </div>
            </div>

            <!-- URL Fetch Panel -->
            <div class="vecthare-cv-input-panel" data-panel="url" style="display: none;">
                <div class="vecthare-cv-url-input">
                    <input type="text" id="vecthare_cv_url_input"
                           placeholder="https://example.com/article">
                    <button id="vecthare_cv_fetch_url" class="vecthare-btn-secondary">
                        <i class="fa-solid fa-download"></i> Fetch
                    </button>
                </div>
                <div class="vecthare-cv-url-status" id="vecthare_cv_url_status"></div>
            </div>

            <!-- Document Name -->
            <div class="vecthare-cv-doc-name">
                <label>Collection Name</label>
                <input type="text" id="vecthare_cv_doc_name"
                       placeholder="My Document">
            </div>
        </div>
    `;
}

/**
 * Renders Wiki source (Fandom / MediaWiki)
 */
function renderWikiSource(type) {
    const options = type.sourceOptions;

    return `
        <div class="vecthare-cv-wiki-source">
            <!-- Plugin Status -->
            <div class="vecthare-cv-wiki-plugin-status" id="vecthare_cv_wiki_plugin_status">
                <i class="fa-solid fa-spinner fa-spin"></i> Checking plugin availability...
            </div>

            <!-- Wiki Type Selection -->
            <div class="vecthare-cv-wiki-type">
                <label>Wiki Type</label>
                <select id="vecthare_cv_wiki_type" class="vecthare-select">
                    ${options.types.map(t => `
                        <option value="${t.id}">${t.name}</option>
                    `).join('')}
                </select>
            </div>

            <!-- Wiki URL/ID Input -->
            <div class="vecthare-cv-wiki-url">
                <label>Wiki URL or ID</label>
                <input type="text" id="vecthare_cv_wiki_url"
                       class="vecthare-input"
                       placeholder="${options.types[0].placeholder}">
            </div>

            <!-- Page Filter (for bulk scraping) -->
            <div class="vecthare-cv-wiki-filter">
                <label>
                    Page Filter
                    <span class="vecthare-cv-optional">(optional)</span>
                </label>
                <input type="text" id="vecthare_cv_wiki_filter"
                       class="vecthare-input"
                       placeholder="${options.filterPlaceholder}">
                <div class="vecthare-cv-hint">
                    Leave empty to scrape single page, or enter comma-separated page names for bulk scrape
                </div>
            </div>

            <!-- Scrape Button -->
            <div class="vecthare-cv-wiki-actions">
                <button id="vecthare_cv_scrape_wiki" class="vecthare-btn-primary">
                    <i class="fa-solid fa-download"></i> Scrape Wiki
                </button>
            </div>

            <!-- Status/Preview -->
            <div class="vecthare-cv-wiki-status" id="vecthare_cv_wiki_status"></div>
            <div class="vecthare-cv-wiki-preview" id="vecthare_cv_wiki_preview" style="display: none;">
                <div class="vecthare-cv-wiki-preview-header">
                    <i class="fa-solid fa-check-circle"></i>
                    <span id="vecthare_cv_wiki_title">Wiki content loaded</span>
                </div>
                <div class="vecthare-cv-wiki-preview-stats">
                    <span><strong id="vecthare_cv_wiki_pages">0</strong> pages</span>
                    <span><strong id="vecthare_cv_wiki_chars">0</strong> characters</span>
                </div>
            </div>
        </div>
    `;
}

/**
 * Renders YouTube source
 */
function renderYouTubeSource(type) {
    const options = type.sourceOptions;

    return `
        <div class="vecthare-cv-youtube-source">
            <!-- URL Input -->
            <div class="vecthare-cv-youtube-url">
                <label>YouTube URL or Video ID</label>
                <div class="vecthare-cv-youtube-input-row">
                    <input type="text" id="vecthare_cv_youtube_url"
                           class="vecthare-input"
                           placeholder="${options.placeholder}">
                    <button id="vecthare_cv_fetch_youtube" class="vecthare-btn-primary">
                        <i class="fa-brands fa-youtube"></i> Fetch
                    </button>
                </div>
            </div>

            <!-- Language (optional) -->
            <div class="vecthare-cv-youtube-lang">
                <label>
                    Language Code
                    <span class="vecthare-cv-optional">(optional)</span>
                </label>
                <input type="text" id="vecthare_cv_youtube_lang"
                       class="vecthare-input vecthare-input-sm"
                       placeholder="${options.langPlaceholder}"
                       maxlength="5"
                       style="width: 100px;">
                <div class="vecthare-cv-hint">
                    ISO 639-1 code (e.g., "en", "es", "ja"). Leave blank for auto-detect.
                </div>
            </div>

            <!-- Status/Preview -->
            <div class="vecthare-cv-youtube-status" id="vecthare_cv_youtube_status"></div>
            <div class="vecthare-cv-youtube-preview" id="vecthare_cv_youtube_preview" style="display: none;">
                <div class="vecthare-cv-youtube-preview-header">
                    <i class="fa-solid fa-check-circle"></i>
                    <span id="vecthare_cv_youtube_title">Transcript loaded</span>
                </div>
                <div class="vecthare-cv-youtube-preview-stats">
                    <span><strong id="vecthare_cv_youtube_chars">0</strong> characters</span>
                    <span><strong id="vecthare_cv_youtube_duration">~0</strong> min estimated</span>
                </div>
            </div>
        </div>
    `;
}

/**
 * Updates chunking strategy section
 */
function updateChunkingSection(type) {
    const strategies = getChunkingStrategies(type.id);
    const defaults = getContentTypeDefaults(type.id);
    const selectedStrategyId = currentSettings.strategy || type.defaultStrategy;

    const strategySelect = $('#vecthare_cv_strategy');
    strategySelect.empty();

    strategies.forEach(s => {
        const selected = s.id === selectedStrategyId;
        strategySelect.append(`<option value="${s.id}" ${selected ? 'selected' : ''}>${s.name}</option>`);
    });

    // Update description
    const currentStrategy = getChunkingStrategy(strategySelect.val());
    $('#vecthare_cv_strategy_desc').text(currentStrategy?.description || '');

    // Get strategy-specific defaults if available
    const strategyDefaults = currentStrategy || {};
    const chunkSize = currentSettings.chunkSize || strategyDefaults.defaultSize || defaults.chunkSize;
    const chunkOverlap = currentSettings.chunkOverlap || strategyDefaults.defaultOverlap || defaults.chunkOverlap;

    // Update size controls values
    $('#vecthare_cv_chunk_size').val(chunkSize);
    $('#vecthare_cv_chunk_size_val').text(chunkSize);
    $('#vecthare_cv_overlap').val(chunkOverlap);
    $('#vecthare_cv_overlap_val').text(chunkOverlap === 0 ? 'Off' : chunkOverlap);

    const batchSize = currentSettings.batchSize || defaults.batchSize || 4;
    const groupBatchSize = Math.min(30, Math.max(6, Number(currentSettings.groupBatchSize || defaults.groupBatchSize || 10)));
    currentSettings.groupBatchSize = groupBatchSize;

    $('#vecthare_cv_batch_size').val(batchSize);
    $('#vecthare_cv_batch_size_val').text(batchSize);
    $('#vecthare_cv_group_batch_size').val(groupBatchSize);
    $('#vecthare_cv_group_batch_size_val').text(groupBatchSize);

    // Show/hide size controls based on strategy type
    updateSizeControlsVisibility();
}

/**
 * Show/hide size controls based on strategy requirements
 * Unit-based strategies (per_message, per_entry, etc.) don't need size/overlap
 * Text-based strategies (recursive, paragraph, sliding) need them
 */
function updateSizeControlsVisibility() {
    const strategyId = $('#vecthare_cv_strategy').val();
    const strategy = getChunkingStrategy(strategyId);

    const needsSize = strategy?.needsSize ?? false;
    const needsOverlap = strategy?.needsOverlap ?? false;

    const needsMessageBatchControl = strategyId === 'message_batch' || strategyId === 'message_group_batch';
    const needsGroupBatchControl = strategyId === 'message_group_batch';

    // Show/hide size controls based on strategy requirements
    const hasAnyControls = needsSize || needsOverlap;
    $('#vecthare_cv_size_controls').toggle(hasAnyControls || needsMessageBatchControl || needsGroupBatchControl);

    // Show/hide individual controls
    $('#vecthare_cv_chunk_size_row').toggle(needsSize);
    $('#vecthare_cv_overlap_row').toggle(needsOverlap);
    $('#vecthare_cv_batch_size_row').toggle(needsMessageBatchControl);
    $('#vecthare_cv_group_batch_size_row').toggle(needsGroupBatchControl);

    // Update description when strategy changes
    $('#vecthare_cv_strategy_desc').text(strategy?.description || '');
}

/**
 * Updates options section based on content type
 */
function updateOptionsSection(type) {
    const container = $('#vecthare_cv_options_content');
    container.empty();

    let html = '';

    // Scope control (for types that support it)
    if (hasFeature(type.id, 'scopeControl')) {
        html += renderScopeOptions(type);
    }

    // Field selection (for character type)
    if (hasFeature(type.id, 'fieldSelection')) {
        html += renderFieldSelection();
    }

    // Text Cleaning settings
    html += renderTextCleaningOptions();

    // Keyword extraction settings
    html += `
        <div class="vecthare-cv-option-row vecthare-cv-keyword-settings">
            <div class="vecthare-cv-keyword-header">
                <span>Keyword Extraction</span>
            </div>
            <div class="vecthare-cv-keyword-controls">
                <div class="vecthare-cv-keyword-level">
                    <label for="vecthare_cv_keyword_level">Level:</label>
                    <select id="vecthare_cv_keyword_level" class="vecthare-select">
                        <option value="off" ${currentSettings.keywordLevel === 'off' ? 'selected' : ''}>
                            Off - Manual only
                        </option>
                        <option value="minimal" ${currentSettings.keywordLevel === 'minimal' ? 'selected' : ''}>
                            Minimal - Title only (3 max)
                        </option>
                        <option value="balanced" ${currentSettings.keywordLevel === 'balanced' || !currentSettings.keywordLevel ? 'selected' : ''}>
                            Balanced - Header area (8 max)
                        </option>
                        <option value="aggressive" ${currentSettings.keywordLevel === 'aggressive' ? 'selected' : ''}>
                            Aggressive - Full text (15 max)
                        </option>
                    </select>
                </div>
                <div class="vecthare-cv-keyword-weight">
                    <label for="vecthare_cv_keyword_weight">Base Weight:</label>
                    <input type="number" id="vecthare_cv_keyword_weight"
                           min="0.01" max="3.0" step="0.01"
                           value="${currentSettings.keywordBaseWeight || 1.5}"
                           class="vecthare-input-number">
                    <span class="vecthare-cv-weight-hint">×</span>
                </div>
            </div>
            <span class="vecthare-cv-option-hint">
                ${type.id === 'lorebook'
                    ? 'WI trigger keys always included. Auto-extraction adds more based on text frequency.'
                    : 'Higher frequency words get higher weights. Base weight applies to all extracted keywords.'}
            </span>
        </div>
    `;

    // Temporal decay (only for types that support it)
    if (hasFeature(type.id, 'temporalDecay')) {
        html += renderTemporalDecayOptions();
    }

    // Lorebook-specific: respect disabled entries
    if (hasFeature(type.id, 'respectDisabled')) {
        html += `
            <div class="vecthare-cv-option-row">
                <label class="vecthare-cv-toggle-label">
                    <span>Include Disabled Entries</span>
                    <label class="vecthare-toggle-switch">
                        <input type="checkbox" id="vecthare_cv_include_disabled">
                        <span class="vecthare-toggle-slider"></span>
                    </label>
                </label>
                <span class="vecthare-cv-option-hint">
                    Vectorize entries even if disabled in World Info
                </span>
            </div>
        `;
    }

    container.html(html);
}

/**
 * Renders scope selection options with actual character/chat names
 */
function renderScopeOptions(type) {
    const defaultScope = type.defaults?.scope || 'global';
    const context = getContext();

    // Get current character name (if any)
    const hasCharacter = !!context?.characterId;
    const characterName = context?.name2 || 'No character';

    // Get current chat name (if any)
    const hasChat = !!context?.chatId;
    let chatName = 'No chat';
    if (hasChat) {
        // Try to get a meaningful chat name
        if (typeof chat_metadata !== 'undefined' && chat_metadata?.chat_name) {
            chatName = chat_metadata.chat_name;
        } else {
            chatName = `Chat #${context.chatId}`;
        }
    }

    const scopeData = [
        {
            id: 'global',
            name: 'Global',
            desc: 'Available in all chats',
            icon: 'fa-globe',
            enabled: true,
        },
        {
            id: 'character',
            name: hasCharacter ? characterName : 'Character',
            desc: hasCharacter ? `Only with ${characterName}` : 'No character selected',
            icon: 'fa-user',
            enabled: hasCharacter,
        },
        {
            id: 'chat',
            name: hasChat ? 'This Chat' : 'Chat',
            desc: hasChat ? chatName : 'No chat open',
            icon: 'fa-comment',
            enabled: hasChat,
        },
    ];

    return `
        <div class="vecthare-cv-scope-select">
            <label>Scope</label>
            <div class="vecthare-cv-scope-options">
                ${scopeData.map(scope => `
                    <label class="vecthare-cv-scope-option ${scope.id === defaultScope ? 'selected' : ''} ${!scope.enabled ? 'disabled' : ''}">
                        <input type="radio" name="vecthare_cv_scope" value="${scope.id}"
                               ${scope.id === defaultScope ? 'checked' : ''}
                               ${!scope.enabled ? 'disabled' : ''}>
                        <div class="vecthare-cv-scope-card">
                            <i class="fa-solid ${scope.icon}"></i>
                            <span class="vecthare-cv-scope-name">${scope.name}</span>
                            <span class="vecthare-cv-scope-desc">${scope.desc}</span>
                        </div>
                    </label>
                `).join('')}
            </div>
        </div>
    `;
}

/**
 * Renders character field selection
 */
function renderFieldSelection() {
    const defaults = getContentTypeDefaults('character');

    return `
        <div class="vecthare-cv-field-select">
            <label>Fields to Vectorize</label>
            <div class="vecthare-cv-field-grid">
                ${CHARACTER_FIELDS.map(field => `
                    <label class="vecthare-cv-field-option">
                        <input type="checkbox" name="vecthare_cv_field"
                               value="${field.id}"
                               ${defaults.fields?.[field.id] ? 'checked' : ''}>
                        <span class="vecthare-cv-field-name">${field.name}</span>
                    </label>
                `).join('')}
            </div>
        </div>
    `;
}

/**
 * Renders temporal weighting options with toggle cards
 */
function renderTemporalDecayOptions() {
    const decay = currentSettings.temporalDecay || {};
    const isEnabled = decay.enabled || false;
    const decayType = decay.type || 'decay';
    const decayMode = decay.mode || 'exponential';
    const halfLife = decay.halfLife || 50;
    const linearRate = decay.linearRate || 0.01;
    const minRelevance = decay.minRelevance || 0.3;
    const maxBoost = decay.maxBoost || 1.2;

    return `
        <div class="vecthare-cv-option-row vecthare-cv-temporal-settings ${isEnabled ? 'enabled' : ''}">
            <div class="vecthare-cv-temporal-header">
                <span>Temporal Weighting</span>
                <label class="vecthare-toggle-switch">
                    <input type="checkbox" id="vecthare_cv_temporal_decay"
                           ${isEnabled ? 'checked' : ''}>
                    <span class="vecthare-toggle-slider"></span>
                </label>
            </div>
            <span class="vecthare-cv-option-hint">
                Adjust relevance based on message age
            </span>

            <div class="vecthare-cv-decay-type-section" style="display: ${isEnabled ? 'block' : 'none'};">
                <!-- Type: Decay vs Nostalgia -->
                <div class="vecthare-type-toggle">
                    <label class="vecthare-type-option ${decayType === 'decay' ? 'selected' : ''}" data-type="decay">
                        <input type="radio" name="vecthare_cv_decay_type" value="decay" ${decayType === 'decay' ? 'checked' : ''}>
                        <div class="vecthare-type-card">
                            <div class="vecthare-type-header">
                                <span class="vecthare-type-icon">📉</span>
                                <strong>Decay</strong>
                            </div>
                            <small>Recent messages score higher. Older memories fade over time.</small>
                        </div>
                    </label>
                    <label class="vecthare-type-option ${decayType === 'nostalgia' ? 'selected' : ''}" data-type="nostalgia">
                        <input type="radio" name="vecthare_cv_decay_type" value="nostalgia" ${decayType === 'nostalgia' ? 'checked' : ''}>
                        <div class="vecthare-type-card">
                            <div class="vecthare-type-header">
                                <span class="vecthare-type-icon">📈</span>
                                <strong>Nostalgia</strong>
                            </div>
                            <small>Older messages score higher. Ancient history becomes more relevant.</small>
                        </div>
                    </label>
                </div>

                <!-- Curve: Exponential vs Linear -->
                <div class="vecthare-curve-label">Curve</div>
                <div class="vecthare-type-toggle vecthare-curve-toggle">
                    <label class="vecthare-type-option ${decayMode === 'exponential' ? 'selected' : ''}" data-mode="exponential">
                        <input type="radio" name="vecthare_cv_decay_mode" value="exponential" ${decayMode === 'exponential' ? 'checked' : ''}>
                        <div class="vecthare-type-card">
                            <div class="vecthare-type-header">
                                <span class="vecthare-type-icon">📐</span>
                                <strong>Exponential</strong>
                            </div>
                            <small>Smooth half-life curve. Effect halves every N messages. Natural decay pattern.</small>
                        </div>
                    </label>
                    <label class="vecthare-type-option ${decayMode === 'linear' ? 'selected' : ''}" data-mode="linear">
                        <input type="radio" name="vecthare_cv_decay_mode" value="linear" ${decayMode === 'linear' ? 'checked' : ''}>
                        <div class="vecthare-type-card">
                            <div class="vecthare-type-header">
                                <span class="vecthare-type-icon">📏</span>
                                <strong>Linear</strong>
                            </div>
                            <small>Fixed rate per message. Predictable, steady change. Hits limits faster.</small>
                        </div>
                    </label>
                </div>

                <!-- Exponential settings -->
                <div class="vecthare-cv-decay-exponential" style="display: ${decayMode === 'exponential' ? 'block' : 'none'};">
                    <div class="vecthare-cv-inline-setting">
                        <label>Half-life:</label>
                        <input type="number" id="vecthare_cv_decay_halflife" min="1" max="500" value="${halfLife}" class="vecthare-input-number">
                        <small>messages until 50% effect</small>
                    </div>
                </div>

                <!-- Linear settings -->
                <div class="vecthare-cv-decay-linear" style="display: ${decayMode === 'linear' ? 'block' : 'none'};">
                    <div class="vecthare-cv-inline-setting">
                        <label>Rate:</label>
                        <input type="number" id="vecthare_cv_decay_rate" min="0.001" max="0.5" step="0.001" value="${linearRate}" class="vecthare-input-number">
                        <small>per message (0.01 = 1%)</small>
                    </div>
                </div>

                <!-- Decay floor (for decay mode) -->
                <div class="vecthare-cv-decay-floor" style="display: ${decayType === 'decay' ? 'block' : 'none'};">
                    <div class="vecthare-cv-inline-setting">
                        <label>Min relevance:</label>
                        <input type="number" id="vecthare_cv_decay_min" min="0" max="1" step="0.05" value="${minRelevance}" class="vecthare-input-number">
                        <small>floor (0-1)</small>
                    </div>
                </div>

                <!-- Nostalgia ceiling (for nostalgia mode) -->
                <div class="vecthare-cv-nostalgia-ceiling" style="display: ${decayType === 'nostalgia' ? 'block' : 'none'};">
                    <div class="vecthare-cv-inline-setting">
                        <label>Max boost:</label>
                        <input type="number" id="vecthare_cv_decay_max_boost" min="1" max="3" step="0.1" value="${maxBoost}" class="vecthare-input-number">
                        <small>ceiling (1.2 = 20% boost)</small>
                    </div>
                </div>
            </div>
        </div>
    `;
}

/**
 * Renders text cleaning options with preset dropdown and manage button
 */
function renderTextCleaningOptions() {
    // Import dynamically to get current settings
    const presets = [
        { id: 'none', name: 'None', desc: 'No cleaning applied' },
        { id: 'html_formatting', name: 'Strip HTML Formatting', desc: 'Removes font, color, bold/italic tags' },
        { id: 'metadata_blocks', name: 'Strip Metadata Blocks', desc: 'Removes hidden divs, details sections' },
        { id: 'ai_reasoning', name: 'Strip AI Reasoning Tags', desc: 'Removes thinking, tucao tags' },
        { id: 'comprehensive', name: 'Comprehensive Clean', desc: 'All formatting + metadata + reasoning' },
        { id: 'nuclear', name: 'Strip All HTML', desc: 'Plain text only' },
        { id: 'mvu_game_maker', name: 'MVU Game Maker', desc: 'Strips MVU engine tags + standard formatting' },
        { id: 'custom', name: 'Custom', desc: 'Your own pattern selection' },
    ];

    const currentPreset = currentSettings.cleaningPreset || getCleaningSettings().selectedPreset || 'custom';

    return `
        <div class="vecthare-cv-option-row vecthare-cv-cleaning-settings">
            <div class="vecthare-cv-cleaning-header">
                <span>Text Cleaning</span>
                <button class="vecthare-btn-icon" id="vecthare_cv_manage_cleaning" title="Manage Cleaning Patterns">
                    <i class="fa-solid fa-gear"></i>
                </button>
            </div>
            <div class="vecthare-cv-cleaning-controls">
                <div class="vecthare-cv-cleaning-preset">
                    <label for="vecthare_cv_cleaning_preset">Preset:</label>
                    <select id="vecthare_cv_cleaning_preset" class="vecthare-select">
                        ${presets.map(p => `
                            <option value="${p.id}" ${p.id === currentPreset ? 'selected' : ''}>
                                ${p.name}
                            </option>
                        `).join('')}
                    </select>
                </div>
            </div>
            <span class="vecthare-cv-option-hint" id="vecthare_cv_cleaning_hint">
                ${presets.find(p => p.id === currentPreset)?.desc || ''}
            </span>
        </div>
    `;
}

// ============================================================================
// EVENT BINDING
// ============================================================================

/**
 * Binds all event handlers
 */
function bindEvents() {
    // Close handlers
    $('#vecthare_cv_close').on('click', closeContentVectorizer);
    $('#vecthare_cv_cancel').on('click', function() {
        if (isVectorizing) {
            stopActiveVectorization();
            return;
        }
        closeContentVectorizer();
    });
    $('#vecthare_content_vectorizer_modal .vecthare-modal-overlay').on('click', function() {
        if (!isVectorizing) closeContentVectorizer();
    });

    // Content type dropdown selection
    $('#vecthare_cv_type_select').on('change', function() {
        const type = $(this).val();

        if (!type) {
            // No selection - hide subsequent sections
            currentContentType = null;
            currentSettings = {};
            $('.vecthare-cv-subsequent').slideUp(200);
            $('#vecthare_cv_type_hint').text('Select a content type to continue');
            return;
        }

        currentContentType = type;
        currentSettings = { ...getContentTypeDefaults(type) };

        // Show type-specific hint
        const typeInfo = getContentType(type);
        $('#vecthare_cv_type_hint').text(typeInfo?.description || '');

        // Show subsequent sections and update UI
        $('.vecthare-cv-subsequent').slideDown(200);
        updateUIForContentType();
    });

    // Collapse toggles
    $('.vecthare-cv-collapse-btn').on('click', function() {
        const target = $(this).data('target');
        const content = $(`#vecthare_cv_${target}_content`);
        const icon = $(this).find('i');

        content.slideToggle(200);
        icon.toggleClass('fa-chevron-down fa-chevron-up');
    });

    // Strategy change
    $('#vecthare_cv_strategy').on('change', function() {
        const strategy = $(this).val();
        const type = getContentType(currentContentType);
        const strategies = getChunkingStrategies(currentContentType);
        const selected = strategies.find(s => s.id === strategy);

        $('#vecthare_cv_strategy_desc').text(selected?.description || '');
        currentSettings.strategy = strategy;
        updateSizeControlsVisibility();
    });

    // Size sliders
    $('#vecthare_cv_chunk_size').on('input', function() {
        const val = $(this).val();
        $('#vecthare_cv_chunk_size_val').text(val);
        currentSettings.chunkSize = parseInt(val);
    });

    $('#vecthare_cv_overlap').on('input', function() {
        const val = parseInt($(this).val());
        $('#vecthare_cv_overlap_val').text(val === 0 ? 'Off' : val);
        currentSettings.chunkOverlap = val;
    });

    $('#vecthare_cv_batch_size').on('input', function() {
        const val = parseInt($(this).val());
        $('#vecthare_cv_batch_size_val').text(val);
        currentSettings.batchSize = val;
    });

    $('#vecthare_cv_group_batch_size').on('input', function() {
        const raw = parseInt($(this).val());
        const val = Math.min(30, Math.max(6, raw));
        $(this).val(val);
        $('#vecthare_cv_group_batch_size_val').text(val);
        currentSettings.groupBatchSize = val;
    });

    // Scope selection
    $(document).on('change', 'input[name="vecthare_cv_scope"]', function() {
        currentSettings.scope = $(this).val();
        $('.vecthare-cv-scope-option').removeClass('selected');
        $(this).closest('.vecthare-cv-scope-option').addClass('selected');
    });

    // Keyword level dropdown
    $(document).on('change', '#vecthare_cv_keyword_level', function() {
        currentSettings.keywordLevel = $(this).val();
    });

    // Keyword base weight
    $(document).on('change', '#vecthare_cv_keyword_weight', function() {
        const value = parseFloat($(this).val());
        currentSettings.keywordBaseWeight = isNaN(value) ? 1.5 : Math.min(3.0, Math.max(0.01, value));
        $(this).val(currentSettings.keywordBaseWeight);
    });

    // Temporal weighting enable/disable
    $(document).on('change', '#vecthare_cv_temporal_decay', function() {
        const isEnabled = $(this).prop('checked');
        if (!currentSettings.temporalDecay) {
            currentSettings.temporalDecay = { enabled: false, type: 'decay', mode: 'exponential' };
        }
        currentSettings.temporalDecay.enabled = isEnabled;
        $('.vecthare-cv-decay-type-section').toggle(isEnabled);
        // Toggle the enabled class for purple styling
        $('.vecthare-cv-temporal-settings').toggleClass('enabled', isEnabled);
    });

    // Temporal weighting type toggle (decay vs nostalgia)
    $(document).on('change', 'input[name="vecthare_cv_decay_type"]', function() {
        const type = $(this).val();
        if (!currentSettings.temporalDecay) {
            currentSettings.temporalDecay = { enabled: true, type: 'decay', mode: 'exponential' };
        }
        currentSettings.temporalDecay.type = type;
        // Update visual selection state for type cards only
        $('.vecthare-cv-decay-options .vecthare-type-toggle:not(.vecthare-curve-toggle) .vecthare-type-option').removeClass('selected');
        $(this).closest('.vecthare-type-option').addClass('selected');
        // Show/hide floor vs ceiling based on type
        $('.vecthare-cv-decay-floor').toggle(type === 'decay');
        $('.vecthare-cv-nostalgia-ceiling').toggle(type === 'nostalgia');
    });

    // Temporal weighting curve toggle (exponential vs linear)
    $(document).on('change', 'input[name="vecthare_cv_decay_mode"]', function() {
        const mode = $(this).val();
        if (!currentSettings.temporalDecay) {
            currentSettings.temporalDecay = { enabled: true, type: 'decay', mode: 'exponential' };
        }
        currentSettings.temporalDecay.mode = mode;
        // Update visual selection state for curve cards only
        $('.vecthare-curve-toggle .vecthare-type-option').removeClass('selected');
        $(this).closest('.vecthare-type-option').addClass('selected');
        // Show/hide exponential vs linear settings
        $('.vecthare-cv-decay-exponential').toggle(mode === 'exponential');
        $('.vecthare-cv-decay-linear').toggle(mode === 'linear');
    });

    // Temporal weighting numeric inputs
    $(document).on('change', '#vecthare_cv_decay_halflife', function() {
        if (!currentSettings.temporalDecay) currentSettings.temporalDecay = {};
        currentSettings.temporalDecay.halfLife = parseInt($(this).val()) || 50;
    });
    $(document).on('change', '#vecthare_cv_decay_rate', function() {
        if (!currentSettings.temporalDecay) currentSettings.temporalDecay = {};
        currentSettings.temporalDecay.linearRate = parseFloat($(this).val()) || 0.01;
    });
    $(document).on('change', '#vecthare_cv_decay_min', function() {
        if (!currentSettings.temporalDecay) currentSettings.temporalDecay = {};
        currentSettings.temporalDecay.minRelevance = parseFloat($(this).val()) || 0.3;
    });
    $(document).on('change', '#vecthare_cv_decay_max_boost', function() {
        if (!currentSettings.temporalDecay) currentSettings.temporalDecay = {};
        currentSettings.temporalDecay.maxBoost = parseFloat($(this).val()) || 1.2;
    });

    // Cleaning preset dropdown
    $(document).on('change', '#vecthare_cv_cleaning_preset', function() {
        const presetId = $(this).val();
        currentSettings.cleaningPreset = presetId;

        // Update hint text
        const hints = {
            none: 'No cleaning applied',
            html_formatting: 'Removes font, color, bold/italic tags',
            metadata_blocks: 'Removes hidden divs, details sections',
            ai_reasoning: 'Removes thinking, tucao tags',
            comprehensive: 'All formatting + metadata + reasoning',
            nuclear: 'Plain text only',
            mvu_game_maker: 'Strips MVU engine tags (UpdateVariable, combat_calculation, StoryAnalysis, combat_log) + standard formatting',
            custom: 'Your own pattern selection',
        };
        $('#vecthare_cv_cleaning_hint').text(hints[presetId] || '');

        // Save to extension settings
        saveCleaningPresetToSettings(presetId);
    });

    // Manage cleaning patterns button - opens the standalone Text Cleaning Manager
    // Uses modal-scoped delegation since modal has stopPropagation on all clicks
    $('#vecthare_content_vectorizer_modal').on('click', '#vecthare_cv_manage_cleaning', function(e) {
        e.preventDefault();
        openTextCleaningManager();
    });

    // Preview button
    $('#vecthare_cv_preview_btn').on('click', previewChunks);

    // Continue button (backfill - skips purge, DB dedup handles already-inserted chunks)
    $('#vecthare_cv_continue').on('click', startContinueVectorization);

    // Vectorize button
    $('#vecthare_cv_vectorize').on('click', startVectorization);
}

/**
 * Binds source-specific events
 */
function bindSourceEvents(type) {
    // Source tabs (skip disabled tabs)
    $('.vecthare-cv-source-tab:not([disabled])').on('click', function() {
        if ($(this).prop('disabled')) return;
        const source = $(this).data('source');
        $('.vecthare-cv-source-tab').removeClass('active');
        $(this).addClass('active');
        $('.vecthare-cv-source-panel').hide();
        $(`.vecthare-cv-source-panel[data-panel="${source}"]`).show();

        // Clear sourceData when switching tabs
        sourceData = null;
    });

    // Input method tabs (for document type)
    $('.vecthare-cv-input-tab').on('click', function() {
        const method = $(this).data('method');
        $('.vecthare-cv-input-tab').removeClass('active');
        $(this).addClass('active');
        $('.vecthare-cv-input-panel').hide();
        $(`.vecthare-cv-input-panel[data-panel="${method}"]`).show();
    });

    // Upload zone click (all upload zones)
    $('#vecthare_cv_upload_zone, #vecthare_cv_doc_upload_zone, #vecthare_cv_chat_upload_zone').on('click', function(e) {
        // Don't trigger if clicking the input itself
        if (e.target.tagName === 'INPUT') return;
        $(this).find('input[type="file"]').trigger('click');
    });

    // Upload zone drag and drop
    $('#vecthare_cv_upload_zone, #vecthare_cv_doc_upload_zone, #vecthare_cv_chat_upload_zone')
        .on('dragover', function(e) {
            e.preventDefault();
            e.stopPropagation();
            $(this).addClass('dragover');
        })
        .on('dragleave', function(e) {
            e.preventDefault();
            e.stopPropagation();
            $(this).removeClass('dragover');
        })
        .on('drop', function(e) {
            e.preventDefault();
            e.stopPropagation();
            $(this).removeClass('dragover');

            const files = e.originalEvent.dataTransfer.files;
            if (files.length > 0) {
                // Get the file input and set the files
                const input = $(this).find('input[type="file"]')[0];
                // Create a new DataTransfer to set files on the input
                const dataTransfer = new DataTransfer();
                dataTransfer.items.add(files[0]);
                input.files = dataTransfer.files;
                // Trigger change event to process the file
                $(input).trigger('change');
            }
        });

    // File input change
    $('#vecthare_cv_file_input, #vecthare_cv_doc_file_input').on('change', handleFileUpload);

    // Chat file input change (special handler for chat files)
    $('#vecthare_cv_chat_file_input').on('change', handleChatFileUpload);

    // Clear upload
    $('#vecthare_cv_upload_clear').on('click', clearUpload);
    $('#vecthare_cv_chat_upload_clear').on('click', clearChatUpload);

    // Fetch URL
    $('#vecthare_cv_fetch_url').on('click', fetchUrl);

    // Wiki scraping
    $('#vecthare_cv_scrape_wiki').on('click', scrapeWiki);
    $('#vecthare_cv_wiki_type').on('change', function() {
        const wikiType = $(this).val();
        const type = getContentType('wiki');
        const typeInfo = type.sourceOptions.types.find(t => t.id === wikiType);
        if (typeInfo) {
            $('#vecthare_cv_wiki_url').attr('placeholder', typeInfo.placeholder);
        }
        // Re-check plugin availability
        checkWikiPluginStatus();
    });

    // YouTube fetch
    $('#vecthare_cv_fetch_youtube').on('click', fetchYouTubeTranscript);

    // Source select change - show stats
    $('#vecthare_cv_source_select').on('change', function() {
        const value = $(this).val();
        if (value) {
            loadSourceStats(type.id, value);
        } else {
            $('#vecthare_cv_source_stats').hide();
        }
    });

    // Populate select if needed
    if (type.sourceType === 'select') {
        populateSourceSelect(type);
    }

    // Check wiki plugin availability when wiki type is selected
    if (type.sourceType === 'wiki') {
        checkWikiPluginStatus();
    }
}

/**
 * Loads and displays stats for the selected source
 */
async function loadSourceStats(contentType, sourceId) {
    const statsContainer = $('#vecthare_cv_source_stats');
    statsContainer.show().html('<div class="vecthare-cv-stats-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading info...</div>');

    try {
        if (contentType === 'lorebook') {
            // Load lorebook info
            const worldInfoModule = await import('../../../../world-info.js');
            const loadWorldInfo = worldInfoModule.loadWorldInfo;

            if (loadWorldInfo) {
                const data = await loadWorldInfo(sourceId);
                const entries = data?.entries ? Object.values(data.entries) : [];
                const enabledEntries = entries.filter(e => !e.disable);
                const totalChars = entries.reduce((sum, e) => sum + (e.content?.length || 0), 0);

                statsContainer.html(`
                    <div class="vecthare-cv-stats-grid">
                        <div class="vecthare-cv-stat">
                            <span class="vecthare-cv-stat-value">${entries.length}</span>
                            <span class="vecthare-cv-stat-label">Total Entries</span>
                        </div>
                        <div class="vecthare-cv-stat">
                            <span class="vecthare-cv-stat-value">${enabledEntries.length}</span>
                            <span class="vecthare-cv-stat-label">Enabled</span>
                        </div>
                        <div class="vecthare-cv-stat">
                            <span class="vecthare-cv-stat-value">${(totalChars / 1000).toFixed(1)}k</span>
                            <span class="vecthare-cv-stat-label">Characters</span>
                        </div>
                    </div>
                `);
            } else {
                statsContainer.html('<div class="vecthare-cv-stats-info">Lorebook selected</div>');
            }

        } else if (contentType === 'character') {
            // Load character info
            const context = getContext();
            const character = context?.characters?.find(c => c.avatar === sourceId);

            if (character) {
                const fields = ['description', 'personality', 'scenario', 'first_mes', 'mes_example'];
                const filledFields = fields.filter(f => character[f]?.trim());
                const totalChars = fields.reduce((sum, f) => sum + (character[f]?.length || 0), 0);

                statsContainer.html(`
                    <div class="vecthare-cv-stats-grid">
                        <div class="vecthare-cv-stat">
                            <span class="vecthare-cv-stat-value">${filledFields.length}/${fields.length}</span>
                            <span class="vecthare-cv-stat-label">Fields Used</span>
                        </div>
                        <div class="vecthare-cv-stat">
                            <span class="vecthare-cv-stat-value">${(totalChars / 1000).toFixed(1)}k</span>
                            <span class="vecthare-cv-stat-label">Characters</span>
                        </div>
                    </div>
                `);
            } else {
                statsContainer.html('<div class="vecthare-cv-stats-info">Character selected</div>');
            }
        }
    } catch (e) {
        console.error('VectHare: Failed to load source stats:', e);
        statsContainer.html('<div class="vecthare-cv-stats-info">Selected</div>');
    }
}

/**
 * Populates the source dropdown based on type
 */
async function populateSourceSelect(type) {
    const select = $('#vecthare_cv_source_select');
    select.empty().append('<option value="">-- Select --</option>');

    try {
        if (type.id === 'lorebook') {
            // Import world_names from ST's world-info module (same as legacy)
            try {
                const worldInfoModule = await import('../../../../world-info.js');
                const worldNames = worldInfoModule.world_names || [];

                if (worldNames && worldNames.length > 0) {
                    worldNames.forEach(name => {
                        select.append(`<option value="${name}">${name}</option>`);
                    });
                } else {
                    select.append('<option value="" disabled>No lorebooks found</option>');
                }
            } catch (importError) {
                console.warn('VectHare: Could not import world-info module:', importError);
                select.append('<option value="" disabled>Could not load lorebooks</option>');
            }

        } else if (type.id === 'character') {
            // Get available characters from context
            const context = getContext();
            const characters = context?.characters || [];

            if (characters.length > 0) {
                // Add current character at top if available
                if (context?.characterId) {
                    const currentChar = characters.find(c => c.avatar === context.characterId);
                    if (currentChar) {
                        select.append(`<option value="${currentChar.avatar}" selected>📌 ${currentChar.name} (current)</option>`);
                    }
                }

                // Add all other characters
                characters.forEach(char => {
                    // Skip if already added as current
                    if (char.avatar === context?.characterId) return;
                    select.append(`<option value="${char.avatar}">${char.name}</option>`);
                });
            } else {
                select.append('<option value="" disabled>No characters found</option>');
            }
        }
    } catch (e) {
        console.error('VectHare: Failed to populate source select:', e);
        select.append('<option value="" disabled>Error loading sources</option>');
    }
}

// ============================================================================
// FILE HANDLING
// ============================================================================

/**
 * Handles file upload (lorebook JSON, character PNG/JSON)
 */
function handleFileUpload(e) {
    const file = e.target.files[0];
    if (!file) return;

    const ext = file.name.split('.').pop().toLowerCase();

    // PNG character cards need special handling (embedded JSON in tEXt chunk)
    if (ext === 'png') {
        handleCharacterPngUpload(file);
        return;
    }

    const reader = new FileReader();
    reader.onload = function(event) {
        const content = event.target.result;

        // For lorebook JSON, parse and validate
        if (currentContentType === 'lorebook' && ext === 'json') {
            try {
                const data = JSON.parse(content);
                // ST lorebook format has entries object
                if (data.entries) {
                    const entries = Object.values(data.entries).filter(e => e.content);
                    sourceData = {
                        type: 'file',
                        filename: file.name,
                        content: entries,
                        entries: entries,
                        name: file.name.replace(/\.[^/.]+$/, ''),
                    };

                    // Show stats
                    const enabledCount = entries.filter(e => !e.disable).length;
                    const totalChars = entries.reduce((sum, e) => sum + (e.content?.length || 0), 0);

                    $('#vecthare_cv_upload_zone').hide();
                    $('#vecthare_cv_upload_info').show();
                    $('#vecthare_cv_upload_filename').text(file.name);

                    toastr.success(`Loaded lorebook: ${entries.length} entries (${enabledCount} enabled)`, 'VectHare');
                } else {
                    throw new Error('Invalid lorebook format - missing entries');
                }
            } catch (err) {
                toastr.error(`Failed to parse lorebook: ${err.message}`);
                return;
            }
        } else if (currentContentType === 'character' && ext === 'json') {
            // Character JSON file
            try {
                const data = JSON.parse(content);
                // Look for character data fields
                if (data.name || data.description || data.personality) {
                    sourceData = {
                        type: 'file',
                        filename: file.name,
                        content: data,
                        character: data,
                        name: data.name || file.name.replace(/\.[^/.]+$/, ''),
                    };

                    $('#vecthare_cv_upload_zone').hide();
                    $('#vecthare_cv_upload_info').show();
                    $('#vecthare_cv_upload_filename').text(`${data.name || file.name}`);

                    toastr.success(`Loaded character: ${data.name || 'Unknown'}`, 'VectHare');
                } else {
                    throw new Error('Invalid character format - missing name/description');
                }
            } catch (err) {
                toastr.error(`Failed to parse character: ${err.message}`);
                return;
            }
        } else {
            // Generic file upload
            sourceData = {
                type: 'file',
                filename: file.name,
                content: content,
            };

            $('#vecthare_cv_upload_zone').hide();
            $('#vecthare_cv_upload_info').show();
            $('#vecthare_cv_upload_filename').text(file.name);

            // Auto-fill document name
            if (currentContentType === 'document') {
                $('#vecthare_cv_doc_name').val(file.name.replace(/\.[^/.]+$/, ''));
            }

            toastr.success(`Loaded: ${file.name}`, 'VectHare');
        }
    };

    reader.readAsText(file);
}

/**
 * Handles PNG character card upload
 * PNG character cards have JSON data embedded in the tEXt chunk with keyword "chara"
 */
async function handleCharacterPngUpload(file) {
    try {
        // Read PNG as ArrayBuffer
        const arrayBuffer = await file.arrayBuffer();
        const bytes = new Uint8Array(arrayBuffer);

        // Extract character data from PNG tEXt chunk
        const characterData = extractCharaFromPng(bytes);

        if (!characterData) {
            throw new Error('No character data found in PNG');
        }

        sourceData = {
            type: 'file',
            filename: file.name,
            content: characterData,
            character: characterData,
            name: characterData.name || file.name.replace(/\.[^/.]+$/, ''),
        };

        $('#vecthare_cv_upload_zone').hide();
        $('#vecthare_cv_upload_info').show();
        $('#vecthare_cv_upload_filename').text(`${characterData.name || file.name}`);

        // Show character stats
        const fields = ['description', 'personality', 'scenario', 'first_mes', 'mes_example'];
        const filledFields = fields.filter(f => characterData[f]?.trim());
        const totalChars = fields.reduce((sum, f) => sum + (characterData[f]?.length || 0), 0);

        toastr.success(`Loaded character: ${characterData.name} (${filledFields.length} fields, ${(totalChars/1000).toFixed(1)}k chars)`, 'VectHare');

    } catch (err) {
        console.error('VectHare: PNG parse error:', err);
        toastr.error(`Failed to parse character PNG: ${err.message}`);
    }
}

/**
 * Extracts character data from PNG tEXt chunk
 * Character cards store JSON data base64-encoded in a tEXt chunk with keyword "chara"
 * @param {Uint8Array} bytes - PNG file bytes
 * @returns {object|null} Parsed character data or null
 */
function extractCharaFromPng(bytes) {
    // PNG signature: 89 50 4E 47 0D 0A 1A 0A
    const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
    for (let i = 0; i < 8; i++) {
        if (bytes[i] !== pngSignature[i]) {
            throw new Error('Not a valid PNG file');
        }
    }

    // Read chunks
    let offset = 8; // Skip signature

    while (offset < bytes.length) {
        // Read chunk length (4 bytes, big endian)
        const length = (bytes[offset] << 24) | (bytes[offset + 1] << 16) |
                       (bytes[offset + 2] << 8) | bytes[offset + 3];
        offset += 4;

        // Read chunk type (4 bytes ASCII)
        const type = String.fromCharCode(bytes[offset], bytes[offset + 1],
                                         bytes[offset + 2], bytes[offset + 3]);
        offset += 4;

        if (type === 'tEXt') {
            // tEXt chunk: keyword (null-terminated) + text data
            const dataStart = offset;
            const dataEnd = offset + length;

            // Find null terminator for keyword
            let nullPos = dataStart;
            while (nullPos < dataEnd && bytes[nullPos] !== 0) {
                nullPos++;
            }

            const keyword = new TextDecoder().decode(bytes.slice(dataStart, nullPos));

            if (keyword === 'chara') {
                // Get the base64 data after the null terminator
                const base64Data = new TextDecoder().decode(bytes.slice(nullPos + 1, dataEnd));

                // Decode base64 to JSON
                try {
                    const jsonStr = atob(base64Data);
                    const charData = JSON.parse(jsonStr);

                    // Handle V2 format (data wrapped in 'data' object)
                    if (charData.spec === 'chara_card_v2' && charData.data) {
                        return charData.data;
                    }

                    return charData;
                } catch (e) {
                    console.error('VectHare: Failed to decode character data:', e);
                    throw new Error('Invalid character data in PNG');
                }
            }
        }

        // Skip chunk data and CRC (4 bytes)
        offset += length + 4;

        // Safety check for IEND
        if (type === 'IEND') break;
    }

    return null;
}

/**
 * Clears uploaded file
 */
function clearUpload() {
    sourceData = null;
    $('#vecthare_cv_upload_zone').show();
    $('#vecthare_cv_upload_info').hide();
    $('#vecthare_cv_file_input, #vecthare_cv_doc_file_input').val('');
}

/**
 * Fetches content from URL
 */
async function fetchUrl() {
    const url = $('#vecthare_cv_url_input').val().trim();
    if (!url) {
        toastr.warning('Please enter a URL');
        return;
    }

    // Validate URL format
    try {
        new URL(url);
    } catch {
        toastr.warning('Please enter a valid URL (including http:// or https://)');
        return;
    }

    const status = $('#vecthare_cv_url_status');
    const preview = $('#vecthare_cv_url_preview');
    status.html('<i class="fa-solid fa-spinner fa-spin"></i> Fetching...');
    preview.hide();

    try {
        // Use ST's readability endpoint if available
        const response = await fetch('/api/serpapi/visit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url }),
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();
        const content = data.content || data.text || '';

        if (!content || content.length < 50) {
            throw new Error('No meaningful content found on page');
        }

        sourceData = {
            type: 'url',
            url: url,
            content: content,
            title: data.title || url,
        };

        status.html('');

        // Show preview
        $('#vecthare_cv_url_title').text(sourceData.title);
        $('#vecthare_cv_url_chars').text(content.length.toLocaleString());
        preview.show();

        toastr.success(`Fetched ${content.length.toLocaleString()} characters`, 'VectHare');

    } catch (e) {
        console.error('VectHare: URL fetch failed:', e);
        status.html(`<i class="fa-solid fa-times" style="color: var(--vecthare-danger);"></i> ${e.message}`);
        toastr.error('Failed to fetch URL: ' + e.message);
    }
}

// ============================================================================
// WIKI SCRAPING
// ============================================================================

/**
 * Checks if the wiki scraper plugin is available
 */
async function checkWikiPluginStatus() {
    const statusEl = $('#vecthare_cv_wiki_plugin_status');
    const wikiType = $('#vecthare_cv_wiki_type').val() || 'fandom';
    const scrapeBtn = $('#vecthare_cv_scrape_wiki');

    statusEl.html('<i class="fa-solid fa-spinner fa-spin"></i> Checking plugin...');

    const isAvailable = await isWikiPluginAvailable(wikiType);

    if (isAvailable) {
        statusEl.html(`
            <i class="fa-solid fa-check-circle" style="color: var(--vecthare-success);"></i>
            <span>${wikiType === 'fandom' ? 'Fandom' : 'MediaWiki'} scraper ready</span>
        `);
        scrapeBtn.prop('disabled', false);
    } else {
        const type = getContentType('wiki');
        statusEl.html(`
            <div class="vecthare-cv-wiki-plugin-warning">
                <i class="fa-solid fa-exclamation-triangle" style="color: var(--vecthare-warning);"></i>
                <span>Wiki scraping requires the Fandom Scraper plugin</span>
                <a href="${type.sourceOptions.pluginUrl}" target="_blank" rel="noopener" class="vecthare-cv-plugin-link">
                    <i class="fa-solid fa-external-link"></i> Install Plugin
                </a>
            </div>
        `);
        scrapeBtn.prop('disabled', true);
    }
}

/**
 * Checks if the wiki plugin is available via probe endpoint
 */
async function isWikiPluginAvailable(wikiType) {
    try {
        const endpoint = wikiType === 'fandom'
            ? '/api/plugins/fandom/probe'
            : '/api/plugins/fandom/probe-mediawiki';

        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
        });

        return response.ok;
    } catch (error) {
        console.debug('VectHare: Wiki plugin probe failed:', error);
        return false;
    }
}

/**
 * Scrapes wiki content using ST's fandom scraper plugin
 */
async function scrapeWiki() {
    const wikiType = $('#vecthare_cv_wiki_type').val();
    const url = $('#vecthare_cv_wiki_url').val().trim();
    const filter = $('#vecthare_cv_wiki_filter').val().trim();

    if (!url) {
        toastr.warning('Please enter a wiki URL or ID');
        return;
    }

    const status = $('#vecthare_cv_wiki_status');
    const preview = $('#vecthare_cv_wiki_preview');
    const scrapeBtn = $('#vecthare_cv_scrape_wiki');

    status.html('<i class="fa-solid fa-spinner fa-spin"></i> Scraping wiki...');
    preview.hide();
    scrapeBtn.prop('disabled', true);

    try {
        const endpoint = wikiType === 'fandom'
            ? '/api/plugins/fandom/scrape'
            : '/api/plugins/fandom/scrape-mediawiki';

        // Build request body based on wiki type
        let requestBody;
        if (wikiType === 'fandom') {
            // Extract fandom ID from URL
            const fandomId = extractFandomId(url);
            requestBody = { fandom: fandomId, filter: filter };
        } else {
            requestBody = { url: url, filter: filter };
        }

        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody),
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(error || `HTTP ${response.status}`);
        }

        const pages = await response.json();

        if (!pages || pages.length === 0) {
            throw new Error('No content found');
        }

        // Combine pages into content
        const combinedContent = pages.map(page =>
            `# ${String(page.title).trim()}\n\n${String(page.content).trim()}`
        ).join('\n\n---\n\n');

        sourceData = {
            type: 'wiki',
            wikiType: wikiType,
            url: url,
            content: combinedContent,
            pages: pages,
            pageCount: pages.length,
            name: extractWikiName(url, wikiType),
        };

        status.html('');
        scrapeBtn.prop('disabled', false);

        // Show preview
        $('#vecthare_cv_wiki_title').text(`${pages.length} page(s) scraped`);
        $('#vecthare_cv_wiki_pages').text(pages.length);
        $('#vecthare_cv_wiki_chars').text(combinedContent.length.toLocaleString());
        preview.show();

        toastr.success(`Scraped ${pages.length} page(s), ${combinedContent.length.toLocaleString()} chars`, 'VectHare');

    } catch (e) {
        console.error('VectHare: Wiki scrape failed:', e);
        status.html(`<i class="fa-solid fa-times" style="color: var(--vecthare-danger);"></i> ${e.message}`);
        scrapeBtn.prop('disabled', false);
        toastr.error('Failed to scrape wiki: ' + e.message);
    }
}

/**
 * Extracts fandom ID from URL
 */
function extractFandomId(url) {
    try {
        const urlObj = new URL(url);
        return urlObj.hostname.split('.')[0] || url;
    } catch {
        return url;
    }
}

/**
 * Extracts wiki name from URL for collection naming
 */
function extractWikiName(url, wikiType) {
    try {
        if (wikiType === 'fandom') {
            return extractFandomId(url);
        }
        const urlObj = new URL(url);
        // Try to get article name from path
        const pathParts = urlObj.pathname.split('/').filter(p => p);
        return pathParts[pathParts.length - 1] || urlObj.hostname;
    } catch {
        return url.substring(0, 50);
    }
}

// ============================================================================
// YOUTUBE TRANSCRIPT
// ============================================================================

/**
 * Fetches YouTube transcript
 */
async function fetchYouTubeTranscript() {
    const url = $('#vecthare_cv_youtube_url').val().trim();
    const lang = $('#vecthare_cv_youtube_lang').val().trim();

    if (!url) {
        toastr.warning('Please enter a YouTube URL or video ID');
        return;
    }

    const videoId = parseYouTubeId(url);
    if (!videoId) {
        toastr.warning('Could not parse YouTube video ID');
        return;
    }

    const status = $('#vecthare_cv_youtube_status');
    const preview = $('#vecthare_cv_youtube_preview');
    const fetchBtn = $('#vecthare_cv_fetch_youtube');

    status.html('<i class="fa-solid fa-spinner fa-spin"></i> Fetching transcript...');
    preview.hide();
    fetchBtn.prop('disabled', true);

    try {
        const response = await fetch('/api/search/transcript', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: videoId, lang: lang || undefined }),
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(error || `HTTP ${response.status}`);
        }

        const transcript = await response.text();

        if (!transcript || transcript.length < 50) {
            throw new Error('No transcript available for this video');
        }

        sourceData = {
            type: 'youtube',
            videoId: videoId,
            url: `https://youtube.com/watch?v=${videoId}`,
            content: transcript,
            lang: lang || 'auto',
            name: `YouTube-${videoId}`,
        };

        status.html('');
        fetchBtn.prop('disabled', false);

        // Show preview with estimated duration (assuming ~150 words/min speaking rate, ~5 chars/word)
        const estimatedMinutes = Math.round(transcript.length / 750);
        $('#vecthare_cv_youtube_title').text(`Transcript loaded (${videoId})`);
        $('#vecthare_cv_youtube_chars').text(transcript.length.toLocaleString());
        $('#vecthare_cv_youtube_duration').text(`~${estimatedMinutes}`);
        preview.show();

        toastr.success(`Fetched transcript: ${transcript.length.toLocaleString()} characters`, 'VectHare');

    } catch (e) {
        console.error('VectHare: YouTube fetch failed:', e);
        status.html(`<i class="fa-solid fa-times" style="color: var(--vecthare-danger);"></i> ${e.message}`);
        fetchBtn.prop('disabled', false);
        toastr.error('Failed to fetch transcript: ' + e.message);
    }
}

/**
 * Parses YouTube video ID from URL or ID string
 */
function parseYouTubeId(url) {
    // If already looks like an ID (11 chars, alphanumeric + _ -)
    if (/^[a-zA-Z0-9_-]{11}$/.test(url)) {
        return url;
    }

    // Parse from various YouTube URL formats
    const regex = /^.*(?:(?:youtu\.be\/|v\/|vi\/|u\/\w\/|embed\/|shorts\/)|(?:(?:watch)?\?v(?:i)?=|&v(?:i)?=))([^#&?]*).*/;
    const match = url.match(regex);
    return (match?.length && match[1]) ? match[1] : null;
}

// ============================================================================
// CHAT FILE HANDLING
// ============================================================================

/**
 * Handles chat file upload (.txt, .jsonl, .json)
 * Supports SillyTavern JSONL backup format (first line = metadata, rest = messages)
 */
function handleChatFileUpload(e) {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(event) {
        const content = event.target.result;
        const ext = file.name.split('.').pop().toLowerCase();

        let messages = [];
        let metadata = null;
        let parseError = null;

        try {
            if (ext === 'jsonl') {
                // SillyTavern JSONL format:
                // Line 1: metadata object with user_name, character_name, create_date, chat_metadata
                // Lines 2+: message objects with name, is_user, is_system, send_date, mes, extra
                const lines = content.split('\n').filter(l => l.trim());

                for (let i = 0; i < lines.length; i++) {
                    const parsed = JSON.parse(lines[i]);

                    // First line is usually metadata (has chat_metadata or user_name fields)
                    if (i === 0 && (parsed.chat_metadata || parsed.user_name || parsed.character_name)) {
                        metadata = parsed;
                        continue;
                    }

                    // Skip system messages and lines without content
                    if (parsed.is_system) continue;
                    if (!parsed.mes && !parsed.text && !parsed.content) continue;

                    // Normalize message format
                    messages.push({
                        name: parsed.name || (parsed.is_user ? 'User' : 'Assistant'),
                        mes: parsed.mes || parsed.text || parsed.content || '',
                        is_user: parsed.is_user || false,
                        send_date: parsed.send_date,
                    });
                }

            } else if (ext === 'json') {
                // Could be ST chat export or array of messages
                const data = JSON.parse(content);

                if (Array.isArray(data)) {
                    // Array of messages
                    messages = data.filter(m => m.mes || m.text || m.content).map(m => ({
                        name: m.name || (m.is_user ? 'User' : 'Assistant'),
                        mes: m.mes || m.text || m.content || '',
                        is_user: m.is_user || false,
                        send_date: m.send_date,
                    }));
                } else if (data.chat || data.messages) {
                    // Object with chat/messages array
                    const arr = data.chat || data.messages;
                    metadata = { user_name: data.user_name, character_name: data.character_name };
                    messages = arr.filter(m => m.mes || m.text || m.content).map(m => ({
                        name: m.name || (m.is_user ? 'User' : 'Assistant'),
                        mes: m.mes || m.text || m.content || '',
                        is_user: m.is_user || false,
                        send_date: m.send_date,
                    }));
                } else if (data.mes || data.text || data.content) {
                    // Single message object
                    messages = [{
                        name: data.name || 'Message',
                        mes: data.mes || data.text || data.content || '',
                        is_user: data.is_user || false,
                    }];
                }

            } else if (ext === 'txt') {
                // Plain text - try to detect chat format
                // Check for "Name: message" format (common in chat logs)
                const chatPattern = /^(.+?):\s*(.+)$/gm;
                const matches = [...content.matchAll(chatPattern)];

                if (matches.length > 2) {
                    // Looks like a chat log
                    messages = matches.map(m => ({
                        name: m[1].trim(),
                        mes: m[2].trim(),
                        is_user: /^(you|user|me|myself)$/i.test(m[1].trim()),
                    }));
                } else {
                    // Plain text, treat as single content block
                    messages = [{ mes: content, name: 'Document', is_user: false }];
                }
            }
        } catch (err) {
            parseError = err;
            console.error('VectHare: Chat file parse error:', err);
        }

        if (parseError || messages.length === 0) {
            toastr.error(`Failed to parse chat file: ${parseError?.message || 'No messages found'}`);
            return;
        }

        // Determine character name from metadata or first non-user message
        let characterName = metadata?.character_name || 'Unknown';
        if (characterName === 'Unknown') {
            const firstCharMessage = messages.find(m => !m.is_user);
            if (firstCharMessage?.name) characterName = firstCharMessage.name;
        }

        // Store as sourceData
        sourceData = {
            type: 'file',
            filename: file.name,
            content: messages,
            messages: messages,
            metadata: metadata,
            characterName: characterName,
        };

        // Show upload info
        $('#vecthare_cv_chat_upload_zone').hide();
        $('#vecthare_cv_chat_upload_info').show();
        $('#vecthare_cv_chat_upload_filename').text(file.name);

        // Show stats
        const totalChars = messages.reduce((sum, m) => sum + (m.mes?.length || 0), 0);
        const userCount = messages.filter(m => m.is_user).length;
        const charCount = messages.filter(m => !m.is_user).length;

        $('#vecthare_cv_chat_upload_stats').show().html(`
            <div class="vecthare-cv-stats-grid">
                <div class="vecthare-cv-stat">
                    <span class="vecthare-cv-stat-value">${messages.length}</span>
                    <span class="vecthare-cv-stat-label">Messages</span>
                </div>
                <div class="vecthare-cv-stat">
                    <span class="vecthare-cv-stat-value">${characterName}</span>
                    <span class="vecthare-cv-stat-label">Character</span>
                </div>
                <div class="vecthare-cv-stat">
                    <span class="vecthare-cv-stat-value">${(totalChars / 1000).toFixed(1)}k</span>
                    <span class="vecthare-cv-stat-label">Characters</span>
                </div>
            </div>
        `);

        toastr.success(`Loaded ${messages.length} messages from ${file.name}`, 'VectHare');
    };

    reader.readAsText(file);
}

/**
 * Clears chat upload
 */
function clearChatUpload() {
    sourceData = null;
    $('#vecthare_cv_chat_upload_zone').show();
    $('#vecthare_cv_chat_upload_info').hide();
    $('#vecthare_cv_chat_upload_stats').hide();
    $('#vecthare_cv_chat_file_input').val('');
}

// ============================================================================
// PREVIEW & VECTORIZATION
// ============================================================================

/**
 * Previews how content will be chunked
 */
async function previewChunks() {
    const type = getContentType(currentContentType);
    const source = getSourceData();

    if (!source) {
        toastr.warning('Please select or enter content first');
        return;
    }

    // Show preview section
    $('.vecthare-cv-preview-section').show();
    const container = $('#vecthare_cv_preview_content');
    container.html('<div class="vecthare-cv-loading"><i class="fa-solid fa-spinner fa-spin"></i> Generating preview...</div>');

    try {
        // Import modules for content resolution and chunking
        const { chunkText } = await import('../core/chunking.js');
        const { resolveAndPrepareContent } = await import('../core/content-vectorization.js');

        // Resolve and prepare content (handles 'select' type sources like lorebooks)
        const prepared = await resolveAndPrepareContent(currentContentType, source, currentSettings);
        const contentText = prepared.text;

        if (!contentText || (Array.isArray(contentText) && contentText.length === 0)) {
            container.html('<div class="vecthare-cv-error">Could not load content. Please check your selection.</div>');
            return;
        }

        const chunks = await chunkText(contentText, {
            strategy: currentSettings.strategy || type.defaultStrategy,
            chunkSize: currentSettings.chunkSize || type.defaults.chunkSize,
            chunkOverlap: currentSettings.chunkOverlap || type.defaults.chunkOverlap,
            batchSize: currentSettings.batchSize || 4,
            groupBatchSize: currentSettings.groupBatchSize || 10,
        });

        // Handle empty or undefined chunks
        if (!chunks || chunks.length === 0) {
            container.html('<div class="vecthare-cv-error">No chunks generated. Content may be too short or empty.</div>');
            return;
        }

        // Calculate total chars for average
        const totalChars = Array.isArray(contentText)
            ? contentText.reduce((sum, t) => sum + (t?.length || 0), 0)
            : contentText.length;
        const avgChars = Math.round(totalChars / chunks.length);

        container.html(`
            <div class="vecthare-cv-preview-stats">
                <span><strong>${chunks.length}</strong> chunks</span>
                <span>~<strong>${avgChars}</strong> chars avg</span>
            </div>
            <div class="vecthare-cv-preview-list">
                ${chunks.slice(0, 10).map((chunk, i) => {
                    const chunkText = chunk.text || chunk;
                    return `
                    <div class="vecthare-cv-preview-chunk">
                        <span class="vecthare-cv-preview-num">#${i + 1}</span>
                        <span class="vecthare-cv-preview-text">${escapeHtml(chunkText.substring(0, 150))}${chunkText.length > 150 ? '...' : ''}</span>
                        <span class="vecthare-cv-preview-size">${chunkText.length} chars</span>
                    </div>
                `}).join('')}
                ${chunks.length > 10 ? `<div class="vecthare-cv-preview-more">...and ${chunks.length - 10} more</div>` : ''}
            </div>
        `);

    } catch (e) {
        console.error('VectHare: Preview failed:', e);
        container.html(`<div class="vecthare-cv-error">Preview failed: ${e.message}</div>`);
    }
}

/**
 * Gets the source data based on current selections
 */
function getSourceData() {
    const type = getContentType(currentContentType);

    // If we already have sourceData from file upload or URL fetch, use it
    if (sourceData) {
        return sourceData;
    }

    switch (type.id) {
        case 'document': {
            // Check for paste content
            const pasteContent = $('#vecthare_cv_paste_text').val()?.trim();
            if (pasteContent) {
                return {
                    type: 'paste',
                    content: pasteContent,
                    name: $('#vecthare_cv_doc_name').val() || 'Pasted Document',
                };
            }
            break;
        }

        case 'lorebook': {
            const selectVal = $('#vecthare_cv_source_select').val();
            if (selectVal) {
                return {
                    type: 'select',
                    id: selectVal,
                    name: selectVal,
                };
            }
            break;
        }

        case 'character': {
            const selectVal = $('#vecthare_cv_source_select').val();
            if (selectVal) {
                const context = getContext();
                const char = context?.characters?.find(c => c.avatar === selectVal);
                return {
                    type: 'select',
                    id: selectVal,
                    name: char?.name || selectVal,
                };
            }
            break;
        }

        case 'chat': {
            // Check which tab is active
            const activeTab = $('.vecthare-cv-chat-source .vecthare-cv-source-tab.active').data('source');

            if (activeTab === 'current') {
                // Use current chat
                const context = getContext();
                if (context?.chatId && context?.chat?.length > 0) {
                    return {
                        type: 'current',
                        id: context.chatId,
                        name: context.name2 || 'Chat',
                        content: context.chat,
                    };
                }
            }
            // If upload tab is active but no file loaded, sourceData will be null
            // and we'll fall through to return null
            break;
        }

        case 'url': {
            // URL type should have sourceData set by fetchUrl()
            // If not, check if URL input has a value (user hasn't clicked fetch yet)
            const urlInput = $('#vecthare_cv_url_input').val()?.trim();
            if (urlInput) {
                toastr.warning('Please click "Fetch" to load the URL content first');
            }
            break;
        }

        case 'wiki': {
            // Wiki type should have sourceData set by scrapeWiki()
            const wikiUrl = $('#vecthare_cv_wiki_url').val()?.trim();
            if (wikiUrl) {
                toastr.warning('Please click "Scrape Wiki" to load the content first');
            }
            break;
        }

        case 'youtube': {
            // YouTube type should have sourceData set by fetchYouTubeTranscript()
            const ytUrl = $('#vecthare_cv_youtube_url').val()?.trim();
            if (ytUrl) {
                toastr.warning('Please click "Fetch" to load the transcript first');
            }
            break;
        }
    }

    return null;
}

/**
 * Runs vectorization without purging existing vectors (continue/backfill mode).
 * The DB's hash-based deduplication automatically skips already-inserted chunks.
 * If no vectors exist yet, delegates to the normal startVectorization flow.
 */
async function startContinueVectorization() {
    if (isVectorizing) return;

    const source = getSourceData();
    if (!source) {
        toastr.warning('Please select or enter content first');
        return;
    }

    // If no vectors exist yet, just run the normal vectorization
    if (currentContentType === 'chat' && source.type === 'current') {
        const globalSettings = extension_settings.vecthareplus || {};
        if (globalSettings.eventbase_enabled) {
            return _runEventBaseBackfill();
        }
        try {
            const { doesChatHaveVectors } = await import('../core/collection-loader.js');
            const existing = await doesChatHaveVectors(currentSettings);
            if (!existing.hasVectors || existing.chunkCount === 0) {
                return startVectorization();
            }
        } catch (e) {
            // If check fails, fall through to backfill path
        }
    }

    isVectorizing = true;
    activeVectorizeAbortController = new AbortController();
    updateVectorizeButtonState(true);
    progressTracker.setCancelHandler(() => stopActiveVectorization());

    try {
        const { vectorizeContent } = await import('../core/content-vectorization.js');
        const result = await vectorizeContent({
            contentType: currentContentType,
            source: source,
            settings: currentSettings,
            abortSignal: activeVectorizeAbortController.signal,
            continueMode: true,
        });
        if (result.chunkCount === 0) {
            // Already up to date — message shown by vectorizeContent
        } else {
            toastr.success(`Inserted ${result.chunkCount} new chunks`, 'VectHare');
        }
        closeContentVectorizer();
    } catch (e) {
        const isStopped = e?.name === 'AbortError' || String(e?.message || '').toLowerCase().includes('stopped by user');
        if (isStopped) {
            toastr.info('Vectorization stopped', 'VectHare');
            return;
        }
        console.error('VectHare: Continue vectorization failed:', e);
        toastr.error('Vectorization failed: ' + e.message, 'VectHare');
    } finally {
        progressTracker.clearCancelHandler();
        isVectorizing = false;
        activeVectorizeAbortController = null;
        updateVectorizeButtonState(false);
    }
}

/**
 * Runs EventBase ingestion as a backfill for the current chat.
 * Called by startVectorization / continueVectorization when eventbase_enabled.
 */
async function _runEventBaseBackfill() {
    if (isVectorizing) return;

    console.log('[EventBase] _runEventBaseBackfill: starting...');

    isVectorizing = true;
    activeVectorizeAbortController = new AbortController();
    updateVectorizeButtonState(true);
    progressTracker.setCancelHandler(() => stopActiveVectorization());

    try {
        console.log('[EventBase] Importing runEventBaseIngestion...');
        const { runEventBaseIngestion } = await import('../core/eventbase-workflow.js');
        const { getChatUUID } = await import('../core/chat-vectorization.js');
        const { chunkText } = await import('../core/chunking.js');
        const context = getContext();
        const settings = extension_settings.vecthareplus || {};

        console.log('[EventBase] Context chat length:', context.chat?.length, 'EventBase enabled:', settings.eventbase_enabled);

        if (!Array.isArray(context.chat) || context.chat.length === 0) {
            toastr.warning('No chat messages to process', 'EventBase');
            console.warn('[EventBase] No chat messages available');
            return;
        }

        const messages = context.chat.filter(m => !m.is_system);
        const legacyStrategy = currentSettings.strategy || 'per_message';
        const legacyBatchSize = Number(currentSettings.batchSize) || 4;
        const legacyGroupBatchSize = Number(currentSettings.groupBatchSize) || 10;

        // Reuse legacy chunk math so progress aligns with the Vectorize Content modal.
        const legacyChunks = await chunkText(messages, {
            strategy: legacyStrategy,
            chunkSize: currentSettings.chunkSize || 1000,
            chunkOverlap: currentSettings.chunkOverlap || 200,
            batchSize: legacyBatchSize,
            groupBatchSize: legacyGroupBatchSize,
        });
        const legacyTotalChunks = Array.isArray(legacyChunks) ? legacyChunks.length : 0;

        console.log('[EventBase] Filtered messages (non-system):', messages.length);
        console.log('[EventBase] Starting ingestion with settings:', { 
            eventbase_enabled: settings.eventbase_enabled,
            eventbase_window_size: settings.eventbase_window_size,
            eventbase_window_overlap: settings.eventbase_window_overlap,
            eventbase_debug_logging: settings.eventbase_debug_logging,
            legacy_progress_strategy: legacyStrategy,
            legacy_total_chunks: legacyTotalChunks,
        });

        const result = await runEventBaseIngestion({
            messages,
            chatUUID: getChatUUID(),
            settings,
            abortSignal: activeVectorizeAbortController.signal,
            progressPlan: {
                strategy: legacyStrategy,
                batchSize: legacyBatchSize,
                totalChunks: legacyTotalChunks,
            },
        });

        console.log('[EventBase] Ingestion result:', result);
        toastr.success(
            `EventBase: extracted ${result.eventsExtracted} events across ${result.windowsProcessed} windows`,
            'VectHare'
        );
        closeContentVectorizer();
    } catch (e) {
        const isStopped = e?.name === 'AbortError' || String(e?.message || '').toLowerCase().includes('stopped by user');
        if (isStopped) {
            toastr.info('EventBase ingestion stopped', 'VectHare');
            console.log('[EventBase] Ingestion stopped by user');
            return;
        }
        console.error('[EventBase] Backfill failed:', e);
        toastr.error('EventBase ingestion failed: ' + e.message, 'VectHare');
    } finally {
        progressTracker.clearCancelHandler();
        isVectorizing = false;
        activeVectorizeAbortController = null;
        updateVectorizeButtonState(false);
    }
}

/**
 * Starts the vectorization process
 */
async function startVectorization() {
    if (isVectorizing) return;

    const type = getContentType(currentContentType);
    const source = getSourceData();

    if (!source) {
        toastr.warning('Please select or enter content first');
        return;
    }

    // EventBase mode: redirect chat backfill through EventBase ingestion pipeline
    if (currentContentType === 'chat' && source.type === 'current') {
        const globalSettings = extension_settings.vecthareplus || {};
        if (globalSettings.eventbase_enabled) {
            return _runEventBaseBackfill();
        }
    }

    // Check if vectors already exist for this content (chat specifically)
    if (currentContentType === 'chat' && source.type === 'current') {
        try {
            const { doesChatHaveVectors } = await import('../core/collection-loader.js');
            const existing = await doesChatHaveVectors(currentSettings);

            if (existing.hasVectors && existing.chunkCount > 0) {
                const confirmed = await callGenericPopup(
                    `<div style="text-align: center;">
                        <p>This chat already has <strong>${existing.chunkCount} chunks</strong> vectorized.</p>
                        <p style="margin-top: 10px;">What would you like to do?</p>
                    </div>`,
                    POPUP_TYPE.CONFIRM,
                    '',
                    {
                        okButton: 'Replace All',
                        cancelButton: 'Cancel',
                    }
                );

                if (!confirmed) {
                    return;
                }

                // User wants to replace - purge existing first
                const { purgeVectorIndex } = await import('../core/core-vector-api.js');
                const { unregisterCollection } = await import('../core/collection-loader.js');
                await purgeVectorIndex(existing.collectionId, currentSettings);
                unregisterCollection(existing.collectionId);
                toastr.info('Cleared existing vectors', 'VectHare');
            }
        } catch (e) {
            console.warn('VectHare: Could not check for existing vectors:', e);
            // Continue anyway
        }
    }

    isVectorizing = true;
    activeVectorizeAbortController = new AbortController();
    updateVectorizeButtonState(true);
    progressTracker.setCancelHandler(() => stopActiveVectorization());

    try {
        // Import the appropriate handler
        const { vectorizeContent } = await import('../core/content-vectorization.js');

        const result = await vectorizeContent({
            contentType: currentContentType,
            source: source,
            settings: currentSettings,
            abortSignal: activeVectorizeAbortController.signal,
        });

        toastr.success(`Vectorized ${result.chunkCount} chunks`, 'VectHare');
        closeContentVectorizer();

    } catch (e) {
        const isStopped = e?.name === 'AbortError' || String(e?.message || '').toLowerCase().includes('stopped by user');

        if (isStopped) {
            toastr.info('Vectorization stopped', 'VectHare');
            return;
        }

        console.error('VectHare: Vectorization failed:', e);

        // Check for dimension mismatch error and provide helpful guidance
        if (e.message.includes('dimension mismatch') || e.message.includes('Vector dimension error')) {
            toastr.error(
                'Vector dimension mismatch detected. You likely switched embedding models. ' +
                'Please delete this collection in Database Browser and try again.',
                'VectHare - Dimension Mismatch',
                { timeOut: 10000 }
            );
        } else {
            toastr.error('Vectorization failed: ' + e.message, 'VectHare');
        }

    } finally {
        progressTracker.clearCancelHandler();
        isVectorizing = false;
        activeVectorizeAbortController = null;
        updateVectorizeButtonState(false);
    }
}

/**
 * Escapes HTML entities
 */
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ============================================================================
// TEXT CLEANING MANAGEMENT
// ============================================================================

/**
 * Saves the cleaning preset to extension settings
 */
async function saveCleaningPresetToSettings(presetId) {
    const { saveCleaningSettings, getCleaningSettings } = await import('../core/text-cleaning.js');
    const settings = getCleaningSettings();
    settings.selectedPreset = presetId;
    saveCleaningSettings(settings);
    saveSettingsDebounced();
}

// Note: Text cleaning management is now handled by the standalone Text Cleaning Manager
// accessible from the Actions panel. The openTextCleaningManager() function is imported
// from './text-cleaning-manager.js' and used by the gear button in the Content Vectorizer.
