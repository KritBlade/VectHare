/**
 * ============================================================================
 * VECTHARE CHUNK VISUALIZER
 * ============================================================================
 * Split-panel master/detail layout for browsing and editing chunks
 * Left panel: scrollable chunk list with search/filter/sort
 * Right panel: full details of selected chunk
 *
 * @author Coneja Chibi
 * @version 2.2.0-alpha
 * ============================================================================
 */

import {
    isChunkTemporallyBlind,
    setChunkTemporallyBlind,
    getChunkMetadata,
    saveChunkMetadata,
    deleteChunkMetadata,
    getCollectionMeta,
    setCollectionMeta,
} from '../core/collection-metadata.js';
import {
    deleteVectorItems,
    insertVectorItems,
    updateChunkText,
    updateChunkMetadata,
} from '../core/core-vector-api.js';
import { getStringHash } from '../../../../utils.js';
import {
    filterSceneChunks,
    filterNonSceneChunks,
    deleteSceneChunk,
    updateSceneChunkMetadata,
    getPendingScene,
} from '../core/scenes.js';
import {
    createGroup,
    validateGroup,
    getGroupStats,
} from '../core/chunk-groups.js';
import { getContext } from '../../../../extensions.js';
import { eventSource } from '../../../../../script.js';

// ============================================================================
// STATE
// ============================================================================

let currentResults = null;
let currentCollectionId = null;
let currentSettings = null;
let allChunks = [];
let filteredChunks = [];
// PERF: Lookup maps for O(1) chunk access instead of O(n) find() operations
let allChunksMap = new Map(); // uniqueId -> chunk
let filteredChunksMap = new Map(); // uniqueId -> index in filteredChunks
let selectedChunkId = null; // Use uniqueId, not hash (hashes can be duplicated)
let displayLimit = 50;
let chunkFetchLimit = 1000;
let onReloadCallback = null;
let sortBy = 'index'; // 'index', 'length-desc', 'length-asc', 'keywords', 'modified'
let filterBy = 'all'; // 'all', 'enabled', 'disabled', 'conditions', 'blind'
let searchQuery = '';
let bulkSelectMode = false;
let selectedHashes = new Set();
let hasUnsavedChanges = false;
let pendingChanges = new Map(); // hash -> {keywords, enabled, conditions, etc.}
let plaintextKeywordMode = false; // Toggle for plaintext keyword editing
let activeTab = 'chunks'; // 'chunks' or 'scenes'

// ============================================================================
// COLLECTION TYPE HELPERS
// ============================================================================

/**
 * Checks if the current collection is a chat collection (supports scenes)
 */
function isChatCollection() {
    return currentResults?.collectionType === 'chat';
}

/**
 * Gets the appropriate icon for the collection type
 */
function getCollectionIcon() {
    const icons = {
        chat: '💬',
        file: '📄',
        lorebook: '📚',
        document: '📝',
    };
    return icons[currentResults?.collectionType] || '📦';
}

// ============================================================================
// CHUNK DATA HELPERS
// ============================================================================

/**
 * Normalize keywords to the new format: { text: string, weight: number }
 * Handles migration from old string[] format
 * Weight is a MULTIPLIER: 1.0 = no boost, 1.5 = 50% boost, 2.0 = double
 */
function normalizeKeywords(keywords) {
    if (!keywords || !Array.isArray(keywords)) return [];
    return keywords.map(k => {
        // Old format: just a string
        if (typeof k === 'string') {
            return { text: k, weight: 1.5 }; // Default boost for legacy keywords
        }
        // New format: { text, weight }
        if (k && typeof k === 'object' && k.text) {
            return { text: k.text, weight: k.weight ?? 1.0 };
        }
        return null;
    }).filter(Boolean);
}

function getChunkData(chunk) {
    const stored = getChunkMetadata(chunk.hash) || {};

    // User overrides take priority, then fall back to DB-stored keywords
    const dbKeywords = chunk.metadata?.keywords || chunk.keywords || [];
    const keywords = stored.keywords !== undefined ? stored.keywords : dbKeywords;

    return {
        hash: chunk.hash,
        index: chunk.index,
        text: chunk.text,
        score: chunk.score || 1,
        similarity: chunk.similarity || 1,
        messageAge: chunk.messageAge,
        enabled: stored.enabled !== false,
        keywords: normalizeKeywords(keywords),
        conditions: stored.conditions || { enabled: false, logic: 'AND', rules: [] },
        chunkLinks: stored.chunkLinks || [],
        summaries: stored.summaries || [],
        temporallyBlind: stored.temporallyBlind || false,
        name: stored.name || null,
        // Prompt context (existing)
        context: stored.context || '',
        xmlTag: stored.xmlTag || '',
        // Injection position/depth (null = use collection/global default)
        position: stored.position ?? null,
        depth: stored.depth ?? null,
    };
}

function updateChunkData(hash, updates) {
    const existing = pendingChanges.get(hash) || {};
    pendingChanges.set(hash, { ...existing, ...updates });
    hasUnsavedChanges = true;
        // refresh the chunk data
        allChunks.forEach(chunk => {
            if (chunk.hash === hash) {
                // merge pending changes into the chunk for fresh data if chunks end up with same hash somehow.
                const stored = getChunkMetadata(hash) || {};
                const pending = pendingChanges.get(hash) || {};
                chunk.data = { ...chunk.data, ...pending };
            }
        });
}

async function saveAllChanges() {
    const count = pendingChanges.size;
    if (count === 0) {
        toastr.info('No changes to save', 'VectHare');
        return;
    }

    try {
        for (const [hash, updates] of pendingChanges) {
            // Check what kind of update is needed
            if (updates.text) {
                // Text changed - requires re-embedding
                await updateChunkText(currentCollectionId, hash, updates.text, currentSettings);
            }

            // Handle new summaries - vectorize them
            if (updates._newSummaries?.length > 0) {
                for (const summaryText of updates._newSummaries) {
                    const summaryHash = getStringHash(summaryText);
                    const summaryItem = {
                        text: summaryText,
                        hash: summaryHash,
                        index: 0,
                        keywords: [],
                        metadata: {
                            isSummary: true,
                            parentHash: hash,
                            contentType: 'summary',
                        },
                    };
                    await insertVectorItems(currentCollectionId, [summaryItem], currentSettings);
                }
            }

            // Handle deleted summaries - remove vectors
            if (updates._deletedSummaries?.length > 0) {
                const hashesToDelete = updates._deletedSummaries.map(text => getStringHash(text));
                await deleteVectorItems(currentCollectionId, hashesToDelete, currentSettings);
            }

            // Save to local settings FIRST (without temp tracking fields)
            const toSave = { ...updates };
            delete toSave._newSummaries;
            delete toSave._deletedSummaries;
            delete toSave.text; // Don't save text to metadata here
            const existing = getChunkMetadata(hash) || {};
            saveChunkMetadata(hash, { ...existing, ...toSave });

            // Only call updateChunkMetadata if there are non-metadata changes
            // (metadata-only updates should skip the API call)
            const metadataUpdates = { ...updates };
            delete metadataUpdates.text;
            delete metadataUpdates._newSummaries;
            delete metadataUpdates._deletedSummaries;

            if (Object.keys(metadataUpdates).length > 0 ) {
                // Send metadata updates (keywords, conditions, etc.) to backend
                try {
                    await updateChunkMetadata(currentCollectionId, hash, metadataUpdates, currentSettings);
                } catch (e) {
                    console.warn('VectHare: Failed to update metadata in backend:', e);
                    // Don't fail - local metadata was already saved
                }
            }
        }

        pendingChanges.clear();
        hasUnsavedChanges = false;
        toastr.success(`Saved changes to ${count} chunk(s)`, 'VectHare');
    } catch (error) {
        console.error('VectHare: Failed to save changes', error);
        toastr.error(`Failed to save changes: ${error.message}`, 'VectHare');
    }
}

function discardAllChanges() {
    pendingChanges.clear();
    hasUnsavedChanges = false;
    // Reload chunk data from stored metadata
    allChunks = allChunks.map(chunk => ({
        ...chunk,
        data: getChunkData(chunk)
    }));
    // PERF: Rebuild lookup map after allChunks modification
    allChunksMap = new Map(allChunks.map(c => [c.uniqueId, c]));
    renderChunkList();
    renderDetailPanel();
}

// ============================================================================
// MAIN API
// ============================================================================

export function openVisualizer(results, collectionId, settings, onReload = null) {
    currentResults = results;
    currentCollectionId = collectionId;
    currentSettings = settings;
    onReloadCallback = onReload;
    selectedChunkId = null;
    displayLimit = 50;
    searchQuery = '';
    bulkSelectMode = false;
    selectedHashes.clear();
    pendingChanges.clear();
    hasUnsavedChanges = false;
    activeTab = 'chunks'; // Reset to chunks tab on open

    // Process chunks - add unique identifier for each chunk
    allChunks = (results?.chunks || []).map((chunk, idx) => ({
        ...chunk,
        uniqueId: `chunk_${idx}_${chunk.hash}`, // Create truly unique ID
        data: getChunkData(chunk)
    }));
    // PERF: Build lookup map for O(1) chunk access
    allChunksMap = new Map(allChunks.map(c => [c.uniqueId, c]));

    applyFilters();
    createModal();
    renderChunkList();
    renderDetailPanel();
    bindEvents();

    $('#vecthare_visualizer_modal').fadeIn(200);
}

export function closeVisualizer() {
    if (hasUnsavedChanges) {
        if (!confirm('You have unsaved text changes. Are you sure you want to close?')) {
            return;
        }
    }
    hasUnsavedChanges = false;
    $('#vecthare_visualizer_modal').fadeOut(200);
    currentResults = null;
    currentCollectionId = null;
    selectedChunkId = null;
}

// ============================================================================
// FILTERING & SORTING
// ============================================================================

function applyFilters() {
    let chunks = [...allChunks];

    // Search
    if (searchQuery) {
        const q = searchQuery.toLowerCase();
        chunks = chunks.filter(c =>
            c.text.toLowerCase().includes(q) ||
            c.data.name?.toLowerCase().includes(q) ||
            c.data.keywords.some(k => k.text.toLowerCase().includes(q))
        );
    }

    // Filter
    switch (filterBy) {
        case 'enabled':
            chunks = chunks.filter(c => c.data.enabled);
            break;
        case 'disabled':
            chunks = chunks.filter(c => !c.data.enabled);
            break;
        case 'conditions':
            chunks = chunks.filter(c => c.data.conditions?.enabled && c.data.conditions?.rules?.length > 0);
            break;
        case 'blind':
            chunks = chunks.filter(c => c.data.temporallyBlind);
            break;
        case 'keywords':
            chunks = chunks.filter(c => c.data.keywords?.length > 0);
            break;
    }

    // Sort
    switch (sortBy) {
        case 'length-desc':
            chunks.sort((a, b) => (b.data.text?.length || 0) - (a.data.text?.length || 0));
            break;
        case 'length-asc':
            chunks.sort((a, b) => (a.data.text?.length || 0) - (b.data.text?.length || 0));
            break;
        case 'keywords':
            chunks.sort((a, b) => (b.data.keywords?.length || 0) - (a.data.keywords?.length || 0));
            break;
        case 'modified':
            // Sort by whether chunk has customizations (keywords, conditions, name, blind)
            chunks.sort((a, b) => {
                const aModified = (a.data.keywords?.length || 0) + (a.data.conditions?.rules?.length || 0) + (a.data.name ? 1 : 0) + (a.data.temporallyBlind ? 1 : 0);
                const bModified = (b.data.keywords?.length || 0) + (b.data.conditions?.rules?.length || 0) + (b.data.name ? 1 : 0) + (b.data.temporallyBlind ? 1 : 0);
                return bModified - aModified;
            });
            break;
        case 'index-r':
            chunks.sort((a, b) => b.index - a.index);
            break;
        default: // 'index'
            chunks.sort((a, b) => a.index - b.index);
    }

    filteredChunks = chunks;
    // PERF: Build lookup map for O(1) position lookup
    filteredChunksMap = new Map(filteredChunks.map((c, idx) => [c.uniqueId, idx]));
}

// ============================================================================
// MODAL CREATION
// ============================================================================

function createModal() {
    // Remove existing
    $('#vecthare_visualizer_modal').remove();

    const collectionName = currentCollectionId || 'Collection';
    const isChat = isChatCollection();
    const icon = getCollectionIcon();
    const dbChunkCount = Number(currentResults?.dbChunkCount);
    const dbChunkText = Number.isFinite(dbChunkCount) && dbChunkCount >= 0
        ? dbChunkCount.toLocaleString()
        : 'Unknown';

    const html = `
        <div id="vecthare_visualizer_modal" class="vecthare-visualizer-modal">
            <div class="vecthare-visualizer-container">
                <!-- Header -->
                <div class="vecthare-visualizer-header">
                    <div class="vecthare-visualizer-title">
                        <span class="vecthare-visualizer-title-icon">${icon}</span>
                        <span>${escapeHtml(collectionName)}</span>
                    </div>
                    <div class="vecthare-visualizer-header-actions">
                        <button class="vecthare-visualizer-save" id="vecthare_visualizer_save" title="Save changes">
                            <i class="fa-solid fa-floppy-disk"></i> Save
                        </button>
                        <button class="vecthare-visualizer-close" id="vecthare_visualizer_close">✕</button>
                    </div>
                </div>

                <!-- Tab Bar (only for chat collections) -->
                <div class="vecthare-visualizer-tabs">
                    <button class="vecthare-visualizer-tab active" data-tab="chunks">
                        <i class="fa-solid fa-puzzle-piece"></i> Chunks
                    </button>
                    ${isChat ? `
                    <button class="vecthare-visualizer-tab" data-tab="scenes">
                        <i class="fa-solid fa-bookmark"></i> Scenes
                    </button>
                    ` : ''}
                    <button class="vecthare-visualizer-tab" data-tab="groups">
                        <i class="fa-solid fa-layer-group"></i> Groups
                    </button>
                </div>

                <!-- Body: Split Panel (Chunks Tab) -->
                <div class="vecthare-visualizer-body vecthare-vis-tab-content active" data-tab="chunks">
                    <!-- Left: Chunk List -->
                    <div class="vecthare-chunk-list-panel">
                        <div class="vecthare-list-toolbar">
                            <input type="text" class="vecthare-list-search" id="vecthare_chunk_search" placeholder="🔍 Search...">
                            <div class="vecthare-list-controls">
                                <select class="vecthare-list-sort" id="vecthare_chunk_sort">
                                    <option value="index">Sort: Message Order</option>
                                    <option value="length-desc">Sort: Longest First</option>
                                    <option value="length-asc">Sort: Shortest First</option>
                                    <option value="keywords">Sort: Most Keywords</option>
                                    <option value="modified">Sort: Recently Modified</option>
                                    <option value="index-r">Sort: Message order Reversed</option>

                                </select>
                                <select class="vecthare-list-filter" id="vecthare_chunk_filter">
                                    <option value="all">Filter: All</option>
                                    <option value="enabled">Enabled</option>
                                    <option value="disabled">Disabled</option>
                                    <option value="keywords">Has Keywords</option>
                                    <option value="conditions">Has Conditions</option>
                                    <option value="blind">Decay Immune</option>
                                </select>
                            </div>
                                <div class="vecthare-fetch-limit-control">
                                    <label>Fetch limit:</label>
                                    <input type="number" id="vecthare_fetch_limit" min="100" max="99999" step="100" value="${chunkFetchLimit}" title="Max chunks loaded from server">
                                    <button id="vecthare_reload_chunks" title="Reload chunks from server with new limit">↺ Reload</button>
                                </div>
                                <div class="vecthare-db-total" id="vecthare_db_chunk_total">DB max chunks: ${dbChunkText}</div>
                        </div>
                        <div class="vecthare-chunk-list" id="vecthare_chunk_list"></div>
                        <div class="vecthare-bulk-actions">
                            <label class="vecthare-bulk-toggle">
                                <input type="checkbox" id="vecthare_bulk_mode">
                                <span>Bulk Select Mode</span>
                            </label>
                            <div class="vecthare-bulk-buttons" id="vecthare_bulk_buttons" style="display: none;">
                                <button class="vecthare-bulk-btn" id="vecthare_bulk_enable">Enable All</button>
                                <button class="vecthare-bulk-btn" id="vecthare_bulk_disable">Disable All</button>
                            </div>
                        </div>
                        <div class="vecthare-list-status" id="vecthare_list_status"></div>
                    </div>

                    <!-- Right: Detail Panel -->
                    <div class="vecthare-chunk-detail-panel" id="vecthare_detail_panel">
                        <div class="vecthare-detail-empty">Select a chunk to view details</div>
                    </div>
                </div>

                <!-- Scenes Tab Content (only for chat collections) -->
                ${isChat ? `
                <div class="vecthare-visualizer-body vecthare-vis-tab-content vecthare-scenes-tab" data-tab="scenes">
                    <div class="vecthare-scenes-container" id="vecthare_scenes_container"></div>
                </div>
                ` : ''}

                <!-- Groups Tab Content -->
                <div class="vecthare-visualizer-body vecthare-vis-tab-content vecthare-groups-tab" data-tab="groups">
                    <div class="vecthare-groups-toolbar">
                        <button class="vecthare-btn-primary" id="vecthare_create_group">
                            <i class="fa-solid fa-plus"></i> New Group
                        </button>
                        <div class="vecthare-groups-stats" id="vecthare_groups_stats"></div>
                    </div>
                    <div class="vecthare-groups-container" id="vecthare_groups_container">
                        <div class="vecthare-groups-empty">
                            <i class="fa-solid fa-layer-group"></i>
                            <p>No groups defined</p>
                            <span>Groups let you bundle chunks together for collective activation or mutual exclusion</span>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;

    $('body').append(html);
}

// ============================================================================
// SCENES TAB STATE & RENDERING
// ============================================================================
// Scenes are chunks with metadata.isScene === true
// We filter them from allChunks to display in the Scenes tab

let selectedSceneHash = null;

/**
 * Gets scene chunks from the loaded collection
 * @returns {object[]} Chunks where metadata.isScene === true
 */
function getSceneChunks() {
    return filterSceneChunks(allChunks);
}

/**
 * Renders the scenes tab content - split-panel like chunks tab
 */
function renderScenesTab() {
    const container = $('#vecthare_scenes_container');
    if (!container.length) return;

    const sceneChunks = getSceneChunks();
    const pendingScene = getPendingScene();

    if (sceneChunks.length === 0 && !pendingScene) {
        container.html(`
            <div class="vecthare-scenes-empty-full">
                <i class="fa-solid fa-bookmark"></i>
                <p><strong>No scenes in this collection</strong></p>
                <p>Mark scene starts and ends on chat messages using the bookmark buttons</p>
            </div>
        `);
        return;
    }

    // Split-panel layout matching chunks tab
    container.html(`
        <!-- Left: Scene List -->
        <div class="vecthare-scene-list-panel">
            <div class="vecthare-scene-list-status">
                <span>${sceneChunks.length} scene${sceneChunks.length !== 1 ? 's' : ''}</span>
                ${pendingScene ? '<span class="vecthare-badge-open">1 pending</span>' : ''}
            </div>
            <div class="vecthare-scene-list" id="vecthare_scene_list"></div>
        </div>
        <!-- Right: Scene Detail -->
        <div class="vecthare-scene-detail-panel" id="vecthare_scene_detail">
            <div class="vecthare-detail-empty">Select a scene to view details</div>
        </div>
    `);

    renderSceneList();
    bindScenesTabEvents();
}

/**
 * Renders the scene list (left panel)
 */
function renderSceneList() {
    const container = $('#vecthare_scene_list');
    const sceneChunks = getSceneChunks();

    let html = '';

    // Sort scenes by start index
    const sortedScenes = [...sceneChunks].sort((a, b) =>
        (a.metadata?.sceneStart || 0) - (b.metadata?.sceneStart || 0)
    );

    sortedScenes.forEach((scene, index) => {
        const meta = scene.metadata || {};
        const start = meta.sceneStart ?? 0;
        const end = meta.sceneEnd ?? start;
        const msgCount = end - start + 1;
        const isSelected = selectedSceneHash === scene.hash;
        const title = meta.title || `Scene ${index + 1}`;
        const containedCount = meta.containedHashes?.length || 0;

        // Get preview from scene text
        let preview = '';
        if (scene.text) {
            preview = scene.text.substring(0, 60).replace(/\s+/g, ' ');
            if (scene.text.length > 60) preview += '...';
        } else if (meta.summary) {
            preview = meta.summary.substring(0, 60);
            if (meta.summary.length > 60) preview += '...';
        }

        html += `
            <div class="vecthare-scene-item ${isSelected ? 'selected' : ''}" data-scene-hash="${scene.hash}">
                <div class="vecthare-scene-item-header">
                    <span class="vecthare-scene-item-num">${index + 1}.</span>
                    <span class="vecthare-scene-item-title">${escapeHtml(title)}</span>
                </div>
                <div class="vecthare-scene-item-meta">
                    <span class="vecthare-scene-item-range">#${start} - #${end}</span>
                    <span class="vecthare-scene-item-badge closed">${msgCount} msgs</span>
                    <span class="vecthare-scene-item-badge vectorized">${containedCount} chunks</span>
                </div>
                ${preview ? `<div class="vecthare-scene-item-preview">${escapeHtml(preview)}</div>` : ''}
            </div>
        `;
    });

    container.html(html);
}

/**
 * Gets the currently selected scene chunk
 * @returns {object|null}
 */
function getSelectedScene() {
    if (!selectedSceneHash) return null;
    return allChunks.find(c => c.hash === selectedSceneHash && c.metadata?.isScene);
}

/**
 * Renders the scene detail panel (right panel)
 */
function renderSceneDetailPanel() {
    const panel = $('#vecthare_scene_detail');
    const scene = getSelectedScene();

    if (!scene) {
        panel.html('<div class="vecthare-detail-empty">Select a scene to view details</div>');
        return;
    }

    // Read fresh metadata from persistent storage, not from scene object
    const stored = getChunkMetadata(scene.hash) || {};
    const meta = { ...scene.metadata, ...stored } || {};
    const start = meta.sceneStart ?? 0;
    const end = meta.sceneEnd ?? start;
    const msgCount = end - start + 1;
    const containedCount = meta.containedHashes?.length || 0;
    const title = meta.title || `Scene ${start}-${end}`;
    const summary = meta.summary || '';
    const keywords = meta.keywords || [];

    // Scene text preview (first 500 chars)
    const textPreview = scene.text
        ? (scene.text.length > 500 ? scene.text.substring(0, 500) + '...' : scene.text)
        : '';

    panel.html(`
        <!-- Header -->
        <div class="vecthare-detail-header">
            <div class="vecthare-detail-name-section">
                <input type="text" class="vecthare-chunk-name-input" id="vecthare_scene_title"
                       placeholder="Scene title..."
                       value="${escapeHtml(title)}">
            </div>
            <button class="vecthare-detail-delete" id="vecthare_delete_scene">
                <i class="fa-solid fa-trash"></i> Delete
            </button>
        </div>

        <!-- Info Bar -->
        <div class="vecthare-detail-info-bar">
            <span class="vecthare-info-item">
                <span class="vecthare-info-label">Messages</span>
                <span class="vecthare-info-value">#${start} - #${end}</span>
            </span>
            <span class="vecthare-info-divider">•</span>
            <span class="vecthare-info-item">
                <span class="vecthare-info-value">${msgCount} messages</span>
            </span>
            <span class="vecthare-info-divider">•</span>
            <span class="vecthare-info-item">
                <span class="vecthare-info-value">${containedCount} chunks disabled</span>
            </span>
        </div>

        <!-- Content -->
        <div class="vecthare-detail-content">
            <!-- Hash Info -->
            <div class="vecthare-detail-section">
                <div class="vecthare-detail-section-title">Scene Hash</div>
                <div class="vecthare-scene-vector-row">
                    <span class="vecthare-scene-vector-value vecthare-hash-display" title="Click to copy">${scene.hash}</span>
                </div>
            </div>

            <!-- Preview Block -->
            <div class="vecthare-detail-text-block">
                <div class="vecthare-detail-section-title">Content Preview</div>
                <div class="vecthare-scene-preview-text">${escapeHtml(textPreview)}</div>
            </div>

            <!-- Summary Section -->
            <div class="vecthare-detail-section">
                <div class="vecthare-detail-section-title">Summary <span class="vecthare-section-hint">(for search)</span></div>
                <textarea class="vecthare-scene-summary-textarea" id="vecthare_scene_summary"
                          placeholder="Brief summary of what happens in this scene...">${escapeHtml(summary)}</textarea>
            </div>

            <!-- Keywords Section -->
            <div class="vecthare-detail-section">
                <div class="vecthare-detail-section-header">
                    <span class="vecthare-detail-section-title">Keywords <span class="vecthare-section-hint">(boost when query matches)</span></span>
                </div>
                <div class="vecthare-scene-keywords-field-wrapper">
                    <input type="text" class="vecthare-scene-keywords-field" id="vecthare_scene_keywords"
                           placeholder="keyword1, keyword2, ..."
                           value="${escapeHtml(keywords.join(', '))}">
                    <small class="vecthare-keywords-hint">Comma-separated keywords to improve search relevance</small>
                </div>
            </div>

            <!-- Actions Section -->
            <div class="vecthare-detail-section">
                <div class="vecthare-detail-section-title">Actions</div>
                <div class="vecthare-scene-actions">
                    <button class="vecthare-scene-action-btn" id="vecthare_scene_jump">
                        <i class="fa-solid fa-arrow-up-right-from-square"></i> Jump to Scene
                    </button>
                </div>
            </div>
        </div>
    `);

    bindSceneDetailEvents();
}

/**
 * Binds events for scenes tab (list interactions)
 */
function bindScenesTabEvents() {
    // Scene item click - select scene by hash
    // Bind to modal container (not document) since modal stops propagation
    $('#vecthare_visualizer_modal').off('click', '.vecthare-scene-item').on('click', '.vecthare-scene-item', function(e) {
        e.preventDefault();
        e.stopPropagation();
        const hash = $(this).data('scene-hash');
        console.log('VectHare: Clicked scene with hash:', hash);
        if (!hash) {
            console.error('VectHare: No scene-hash found on clicked element');
            return;
        }
        selectedSceneHash = hash;
        renderSceneList();
        renderSceneDetailPanel();
    });
}

function bindSceneDetailEvents() {
    const scene = getSelectedScene();
    if (!scene) return;

    const meta = scene.metadata || {};

    // Title input - saves to chunk metadata
    $('#vecthare_scene_title').off('blur').on('blur', async function() {
        const title = $(this).val().trim();
        try {
            await updateSceneChunkMetadata(scene.hash, { title }, currentSettings);
            // Update local chunk data
            if (scene.metadata) scene.metadata.title = title;
            renderSceneList();
            toastr.success('Title saved', 'VectHare');
        } catch (error) {
            console.error('VectHare: Failed to save scene title', error);
            toastr.error('Failed to save title', 'VectHare');
        }
    });

    // Summary input
    $('#vecthare_scene_summary').off('blur').on('blur', async function() {
        const summary = $(this).val().trim();
        try {
            await updateSceneChunkMetadata(scene.hash, { summary }, currentSettings);
            if (scene.metadata) scene.metadata.summary = summary;
            toastr.success('Summary saved', 'VectHare');
        } catch (error) {
            console.error('VectHare: Failed to save scene summary', error);
            toastr.error('Failed to save summary', 'VectHare');
        }
    });

    // Keywords input - save on blur with feedback
    $('#vecthare_scene_keywords').off('blur').on('blur', async function() {
        const keywordsStr = $(this).val().trim();
        const keywords = keywordsStr ? keywordsStr.split(',').map(k => k.trim()).filter(Boolean) : [];
        try {
            await updateSceneChunkMetadata(scene.hash, { keywords }, currentSettings);
            // Update local metadata to reflect saved changes
            if (scene.metadata) {
                scene.metadata.keywords = keywords;
            }
            toastr.success('Keywords saved', 'VectHare');
        } catch (error) {
            console.error('VectHare: Failed to save scene keywords', error);
            toastr.error('Failed to save keywords', 'VectHare');
        }
    });

    // Jump to scene
    $('#vecthare_scene_jump').off('click').on('click', function() {
        const start = meta.sceneStart ?? 0;
        closeVisualizer();
        setTimeout(() => {
            const messageElement = document.querySelector(`.mes[mesid="${start}"]`);
            if (messageElement) {
                messageElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
                messageElement.classList.add('flash');
                setTimeout(() => messageElement.classList.remove('flash'), 1000);
            } else {
                toastr.warning('Scene message not found. Is the chat open?');
            }
        }, 300);
    });

    // Copy hash to clipboard
    $('.vecthare-hash-display').off('click').on('click', function() {
        const hash = $(this).text();
        navigator.clipboard.writeText(hash).then(() => {
            toastr.info('Hash copied to clipboard');
        });
    });

    // Delete scene - removes chunk from vector DB and re-enables contained chunks
    $('#vecthare_delete_scene').off('click').on('click', async function() {
        const containedHashes = meta.containedHashes || [];
        const warningText = `Delete this scene? ${containedHashes.length} individual chunks will be re-enabled. This cannot be undone.`;

        if (!confirm(warningText)) return;

        const result = await deleteSceneChunk(scene.hash, containedHashes, currentSettings);
        if (result.success) {
            // Remove from local allChunks array
            const idx = allChunks.findIndex(c => c.hash === scene.hash);
            if (idx !== -1) allChunks.splice(idx, 1);

            toastr.success('Scene deleted');
            selectedSceneHash = null;
            renderScenesTab();
            eventSource.emit('vecthare_scenes_changed');
        } else {
            toastr.error(result.error || 'Failed to delete scene');
        }
    });
}

// ============================================================================
// GROUPS TAB STATE & RENDERING
// ============================================================================

let selectedGroupId = null;

/**
 * Gets groups from collection metadata
 * @returns {object[]} Array of group definitions
 */
function getGroups() {
    if (!currentCollectionId) return [];
    const meta = getCollectionMeta(currentCollectionId);
    return meta.groups || [];
}

/**
 * Saves groups to collection metadata
 * @param {object[]} groups - Array of group definitions
 */
function saveGroups(groups) {
    if (!currentCollectionId) return;
    setCollectionMeta(currentCollectionId, { groups });
}

/**
 * Renders the groups tab content
 */
function renderGroupsTab() {
    const container = $('#vecthare_groups_container');
    if (!container.length) return;

    const groups = getGroups();
    const stats = getGroupStats(groups);

    // Update stats display
    $('#vecthare_groups_stats').html(
        groups.length > 0
            ? `<span>${stats.totalGroups} group${stats.totalGroups !== 1 ? 's' : ''}</span>
               <span class="vecthare-stat-divider">|</span>
               <span>${stats.inclusiveGroups} inclusive</span>
               <span class="vecthare-stat-divider">|</span>
               <span>${stats.exclusiveGroups} exclusive</span>`
            : ''
    );
    bindGroupsTabEvents();
    if (groups.length === 0) {
        container.html(`
            <div class="vecthare-groups-empty">
                <i class="fa-solid fa-layer-group"></i>
                <p>No groups defined</p>
                <span>Groups let you bundle chunks together for collective activation or mutual exclusion</span>
            </div>
        `);
        return;
    }

    // Split-panel layout
    container.html(`
        <div class="vecthare-group-list-panel">
            <div class="vecthare-group-list" id="vecthare_group_list"></div>
        </div>
        <div class="vecthare-group-detail-panel" id="vecthare_group_detail">
            <div class="vecthare-detail-empty">Select a group to view details</div>
        </div>
    `);
    renderGroupList();    
}

/**
 * Renders the group list (left panel)
 */
function renderGroupList() {
    const container = $('#vecthare_group_list');
    const groups = getGroups();

    const html = groups.map(group => {
        const memberCount = group.members?.length || 0;
        const isSelected = group.id === selectedGroupId;
        const modeIcon = group.mode === 'inclusive' ? 'fa-link' : 'fa-code-branch';
        const modeLabel = group.mode === 'inclusive'
            ? (group.linkType === 'hard' ? 'Hard Link' : 'Soft Link')
            : (group.mandatory ? 'Exclusive (Mandatory)' : 'Exclusive');

        return `
            <div class="vecthare-group-item ${isSelected ? 'selected' : ''}" data-group-id="${group.id}">
                <div class="vecthare-group-item-header">
                    <i class="fa-solid ${modeIcon}"></i>
                    <span class="vecthare-group-name">${escapeHtml(group.name)}</span>
                </div>
                <div class="vecthare-group-item-meta">
                    <span class="vecthare-group-mode">${modeLabel}</span>
                    <span class="vecthare-group-count">${memberCount} chunk${memberCount !== 1 ? 's' : ''}</span>
                </div>
            </div>
        `;
    }).join('');

    container.html(html);
}

/**
 * Renders the group detail panel (right panel)
 */
function renderGroupDetailPanel() {
    const container = $('#vecthare_group_detail');
    const groups = getGroups();
    const group = groups.find(g => g.id === selectedGroupId);

    if (!group) {
        container.html('<div class="vecthare-detail-empty">Select a group to view details</div>');
        return;
    }

    const memberChunks = (group.members || []).map(hash => {
        const chunk = allChunks.find(c => String(c.hash) === String(hash));
        return chunk ? { hash, chunk } : { hash, chunk: null };
    });

    const modeOptions = `
        <option value="inclusive" ${group.mode === 'inclusive' ? 'selected' : ''}>Inclusive</option>
        <option value="exclusive" ${group.mode === 'exclusive' ? 'selected' : ''}>Exclusive</option>
    `;

    const linkTypeOptions = `
        <option value="soft" ${group.linkType === 'soft' ? 'selected' : ''}>Soft Link (Score Boost)</option>
        <option value="hard" ${group.linkType === 'hard' ? 'selected' : ''}>Hard Link (Force Include)</option>
    `;

    container.html(`
        <div class="vecthare-group-detail-content">
            <div class="vecthare-group-detail-header">
                <input type="text" class="vecthare-group-name-input" id="vecthare_group_name"
                       value="${escapeHtml(group.name)}" placeholder="Group name">
                <button class="vecthare-btn-danger" id="vecthare_delete_group" title="Delete group">
                    <i class="fa-solid fa-trash"></i>
                </button>
            </div>

            <div class="vecthare-group-settings">
                <div class="vecthare-group-setting-row">
                    <label>Mode</label>
                    <select id="vecthare_group_mode" class="vecthare-group-select">
                        ${modeOptions}
                    </select>
                </div>

                <div class="vecthare-group-setting-row vecthare-inclusive-settings" style="${group.mode !== 'inclusive' ? 'display:none' : ''}">
                    <label>Link Type</label>
                    <select id="vecthare_group_link_type" class="vecthare-group-select">
                        ${linkTypeOptions}
                    </select>
                </div>

                <div class="vecthare-group-setting-row vecthare-inclusive-settings vecthare-soft-settings"
                     style="${group.mode !== 'inclusive' || group.linkType !== 'soft' ? 'display:none' : ''}">
                    <label>Score Boost</label>
                    <input type="number" id="vecthare_group_boost" class="vecthare-group-input"
                           value="${group.boost || 0.15}" min="0" max="1" step="0.05">
                </div>

                <div class="vecthare-group-setting-row vecthare-exclusive-settings" style="${group.mode !== 'exclusive' ? 'display:none' : ''}">
                    <label>
                        <input type="checkbox" id="vecthare_group_mandatory" ${group.mandatory ? 'checked' : ''}>
                        Mandatory (at least one must be included)
                    </label>
                </div>
            </div>

            <div class="vecthare-group-members-section">
                <div class="vecthare-group-members-header">
                    <h4><i class="fa-solid fa-puzzle-piece"></i> Members (${memberChunks.length})</h4>
                    <button class="vecthare-btn-small" id="vecthare_add_group_member">
                        <i class="fa-solid fa-plus"></i> Add
                    </button>
                </div>
                <div class="vecthare-group-members-list" id="vecthare_group_members">
                    ${memberChunks.length === 0 ? '<div class="vecthare-empty-hint">No members yet. Click "Add" to add chunks.</div>' : ''}
                    ${memberChunks.map(({ hash, chunk }) => `
                        <div class="vecthare-group-member" data-hash="${hash}">
                            <div class="vecthare-group-member-info">
                                ${chunk
                                    ? `<span class="vecthare-member-preview">${escapeHtml((chunk.data?.text || '').substring(0, 60))}...</span>
                                       <span class="vecthare-member-hash">#${String(hash).substring(0, 8)}</span>`
                                    : `<span class="vecthare-member-missing">Chunk not found</span>
                                       <span class="vecthare-member-hash">#${String(hash).substring(0, 8)}</span>`
                                }
                            </div>
                            <button class="vecthare-member-remove" data-hash="${hash}" title="Remove from group">
                                <i class="fa-solid fa-times"></i>
                            </button>
                        </div>
                    `).join('')}
                </div>
            </div>
        </div>
    `);

    bindGroupDetailEvents();
}

/**
 * Opens the add member dialog
 */
function openAddMemberDialog() {
    const groups = getGroups();
    const group = groups.find(g => g.id === selectedGroupId);
    if (!group) return;

    const existingMembers = new Set(group.members || []);
    const availableChunks = allChunks.filter(c => !existingMembers.has(String(c.hash)));

    if (availableChunks.length === 0) {
        toastr.info('All chunks are already in this group');
        return;
    }

    const overlay = $(`
        <div class="vecthare-editor-overlay">
            <div class="vecthare-editor-dialog vecthare-add-member-dialog">
                <div class="vecthare-editor-header">
                    <h3><i class="fa-solid fa-plus"></i> Add Chunk to Group</h3>
                    <button class="vecthare-editor-close" id="vecthare_member_close">
                        <i class="fa-solid fa-times"></i>
                    </button>
                </div>
                <div class="vecthare-editor-body">
                    <div class="vecthare-member-search">
                        <input type="text" id="vecthare_member_search" placeholder="Search chunks...">
                    </div>
                    <div class="vecthare-member-list" id="vecthare_available_members">
                        ${availableChunks.slice(0, 50).map(c => `
                            <div class="vecthare-member-option" data-hash="${c.hash}">
                                <span class="vecthare-member-preview">${escapeHtml((c.data?.text || '').substring(0, 80))}...</span>
                                <span class="vecthare-member-hash">#${String(c.hash).substring(0, 8)}</span>
                            </div>
                        `).join('')}
                        ${availableChunks.length > 50 ? `<div class="vecthare-member-more">${availableChunks.length - 50} more chunks (use search)</div>` : ''}
                    </div>
                </div>
            </div>
        </div>
    `);

    $('.vecthare-visualizer-container').append(overlay);

    // Stop propagation to prevent extension panel close
    overlay.on('click', function(e) {
        e.stopPropagation();
        if (e.target === this) overlay.remove();
    });

    $('#vecthare_member_close').on('click', () => overlay.remove());

    // Search filtering
    $('#vecthare_member_search').on('input', function() {
        const query = $(this).val().toLowerCase();
        const filtered = availableChunks.filter(c =>
            (c.data?.text || '').toLowerCase().includes(query) ||
            String(c.hash).includes(query)
        );

        $('#vecthare_available_members').html(
            filtered.slice(0, 50).map(c => `
                <div class="vecthare-member-option" data-hash="${c.hash}">
                    <span class="vecthare-member-preview">${escapeHtml((c.data?.text || '').substring(0, 80))}...</span>
                    <span class="vecthare-member-hash">#${String(c.hash).substring(0, 8)}</span>
                </div>
            `).join('') +
            (filtered.length > 50 ? `<div class="vecthare-member-more">${filtered.length - 50} more results</div>` : '') +
            (filtered.length === 0 ? '<div class="vecthare-empty-hint">No matching chunks</div>' : '')
        );
    });

    // Click to add
    overlay.on('click', '.vecthare-member-option', function (e) {
        e.stopPropagation(); // Prevent overlay close
        const hash = $(this).data('hash');
        addMemberToGroup(String(hash));
        overlay.remove();
    });
}

/**
 * Adds a chunk to the current group
 */
function addMemberToGroup(hash) {
    const groups = getGroups();
    const groupIdx = groups.findIndex(g => g.id === selectedGroupId);
    if (groupIdx === -1) return;

    if (!groups[groupIdx].members) groups[groupIdx].members = [];
    if (!groups[groupIdx].members.includes(hash)) {
        groups[groupIdx].members.push(hash);
        saveGroups(groups);
        renderGroupDetailPanel();
        toastr.success('Chunk added to group');
    }
}

/**
 * Removes a chunk from the current group
 */
function removeMemberFromGroup(hash) {
    const groups = getGroups();
    const groupIdx = groups.findIndex(g => g.id === selectedGroupId);
    if (groupIdx === -1) return;

    groups[groupIdx].members = (groups[groupIdx].members || []).filter(h => String(h) !== String(hash));
    saveGroups(groups);
    renderGroupDetailPanel();
    toastr.info('Chunk removed from group');
}

/**
 * Creates a new group
 */
function createNewGroup() {
    const groups = getGroups();
    const newGroup = createGroup(`Group ${groups.length + 1}`, 'inclusive');
    groups.push(newGroup);
    saveGroups(groups);
    selectedGroupId = newGroup.id;
    renderGroupsTab();
    toastr.success('Group created');
}

/**
 * Deletes the current group
 */
function deleteCurrentGroup() {
    if (!confirm('Delete this group? Chunks will not be affected.')) return;

    const groups = getGroups().filter(g => g.id !== selectedGroupId);
    saveGroups(groups);
    selectedGroupId = null;
    renderGroupsTab();
    toastr.info('Group deleted');
}

/**
 * Updates current group settings
 */
function updateGroupSetting(key, value) {
    const groups = getGroups();
    const groupIdx = groups.findIndex(g => g.id === selectedGroupId);
    if (groupIdx === -1) return;

    groups[groupIdx][key] = value;

    // Clear mode-specific settings when switching modes
    if (key === 'mode') {
        if (value === 'inclusive') {
            groups[groupIdx].linkType = groups[groupIdx].linkType || 'soft';
            groups[groupIdx].boost = groups[groupIdx].boost ?? 0.15;
            delete groups[groupIdx].mandatory;
        } else {
            groups[groupIdx].mandatory = groups[groupIdx].mandatory ?? false;
            delete groups[groupIdx].linkType;
            delete groups[groupIdx].boost;
        }
    }

    saveGroups(groups);
}

/**
 * Binds events for the groups tab (list panel)
 */
function bindGroupsTabEvents() {
    // Create new group
    $('#vecthare_create_group').off('click').on('click', createNewGroup);

    // Select group
    $(document).off('click', '.vecthare-group-item').on('click', '.vecthare-group-item', function() {
        selectedGroupId = $(this).data('group-id');
        renderGroupList();
        renderGroupDetailPanel();
    });
}

/**
 * Binds events for the group detail panel
 */
function bindGroupDetailEvents() {
    // Name change
    $('#vecthare_group_name').off('input').on('input', function() {
        updateGroupSetting('name', $(this).val());
        renderGroupList(); // Update name in list
    });

    // Delete group
    $('#vecthare_delete_group').off('click').on('click', deleteCurrentGroup);

    // Mode change
    $('#vecthare_group_mode').off('change').on('change', function() {
        updateGroupSetting('mode', $(this).val());
        renderGroupDetailPanel();
    });

    // Link type change
    $('#vecthare_group_link_type').off('change').on('change', function() {
        updateGroupSetting('linkType', $(this).val());
        renderGroupDetailPanel();
    });

    // Boost change
    $('#vecthare_group_boost').off('input').on('input', function() {
        updateGroupSetting('boost', parseFloat($(this).val()) || 0.15);
    });

    // Mandatory toggle
    $('#vecthare_group_mandatory').off('change').on('change', function() {
        updateGroupSetting('mandatory', $(this).prop('checked'));
    });

    // Add member
    $('#vecthare_add_group_member').off('click').on('click', openAddMemberDialog);

    // Remove member
    $('.vecthare-member-remove').off('click').on('click', function(e) {
        e.stopPropagation();
        const hash = $(this).data('hash');
        removeMemberFromGroup(String(hash));
    });
}

// ============================================================================
// CHUNK LIST RENDERING
// ============================================================================

function renderChunkList() {
    const container = $('#vecthare_chunk_list');
    const displayChunks = filteredChunks.slice(0, displayLimit);

    let html = displayChunks.map((chunk, idx) => renderChunkItem(chunk, idx)).join('');

    if (filteredChunks.length > displayLimit) {
        html += `<div class="vecthare-load-more" id="vecthare_load_more">[Load ${Math.min(50, filteredChunks.length - displayLimit)} more...]</div>`;
    }

    container.html(html);
    updateStatusBar();
}

function renderChunkItem(chunk, listIndex) {
    const data = chunk.data;
    const isSelected = chunk.uniqueId === selectedChunkId;
    const hasConditions = data.conditions?.enabled && data.conditions?.rules?.length > 0;
    const hasKeywords = data.keywords?.length > 0;

    // Use the display position in the filtered/sorted list (1-based)
    const displayNumber = listIndex + 1;

    // Create a text preview (first ~60 chars, clean it up)
    const textPreview = data.text
        .replace(/\s+/g, ' ')
        .trim()
        .substring(0, 60) + (data.text.length > 60 ? '...' : '');

    // Use custom name if set, otherwise show text preview
    const displayName = data.name || textPreview;

    // Calculate text length for display
    const textLength = data.text?.length || 0;
    const textLengthDisplay = textLength > 1000 ? `${(textLength / 1000).toFixed(1)}k` : textLength;

    // Message info from metadata
    const msgId = chunk.metadata?.messageId ?? chunk.index ?? '?';
    const chunkIdx = chunk.metadata?.chunkIndex ?? 0;
    const totalChunks = chunk.metadata?.totalChunks ?? 1;

    // Build info badges
    const infoBadges = [];
    infoBadges.push(`<span class="vecthare-chunk-item-badge msg">Msg ${msgId}</span>`);
    if (totalChunks > 1) {
        infoBadges.push(`<span class="vecthare-chunk-item-badge chunk-part">${chunkIdx + 1}/${totalChunks}</span>`);
    }
    infoBadges.push(`<span class="vecthare-chunk-item-badge chars">${textLengthDisplay} chars</span>`);

    // Build feature badges
    const featureBadges = [];
    if (hasConditions) featureBadges.push(`<span class="vecthare-chunk-item-badge conditions" title="Has ${data.conditions.rules.length} condition(s)">⚡${data.conditions.rules.length}</span>`);
    if (hasKeywords) featureBadges.push(`<span class="vecthare-chunk-item-badge keywords" title="Has ${data.keywords.length} keyword(s)">🏷️${data.keywords.length}</span>`);
    if (data.temporallyBlind) featureBadges.push(`<span class="vecthare-chunk-item-badge blind" title="Immune to temporal decay">🛡️</span>`);

    return `
        <div class="vecthare-chunk-item ${isSelected ? 'selected' : ''} ${!data.enabled ? 'disabled' : ''}"
             data-uid="${chunk.uniqueId}" data-list-index="${listIndex}">
            <div class="vecthare-chunk-item-content">
                <div class="vecthare-chunk-item-header">
                    <span class="vecthare-chunk-item-index">${displayNumber}.</span>
                    <span class="vecthare-chunk-item-name">${escapeHtml(displayName)}</span>
                </div>
                <div class="vecthare-chunk-item-stats">
                    <div class="vecthare-chunk-item-badges info-badges">${infoBadges.join('')}</div>
                    ${featureBadges.length > 0 ? `<div class="vecthare-chunk-item-badges feature-badges">${featureBadges.join('')}</div>` : ''}
                </div>
            </div>
        </div>
    `;
}

function updateStatusBar() {
    const shown = filteredChunks.length;
    // PERF: Count all stats in a single pass instead of 3 separate filter operations
    let withConditions = 0;
    let withKeywords = 0;
    let blind = 0;
    for (const c of allChunks) {
        if (c.data.conditions?.enabled && c.data.conditions?.rules?.length > 0) withConditions++;
        if (c.data.keywords?.length > 0) withKeywords++;
        if (c.data.temporallyBlind) blind++;
    }

    $('#vecthare_list_status').html(`
        <span>${shown} chunks</span>
        ${withKeywords > 0 ? `<span>• 🏷️${withKeywords}</span>` : ''}
        ${withConditions > 0 ? `<span>• ⚡${withConditions}</span>` : ''}
        ${blind > 0 ? `<span>• 🛡️${blind}</span>` : ''}
    `);
}

// ============================================================================
// DETAIL PANEL RENDERING
// ============================================================================

function renderDetailPanel() {
    const panel = $('#vecthare_detail_panel');

    if (!selectedChunkId) {
        panel.html('<div class="vecthare-detail-empty">Select a chunk to view details</div>');
        return;
    }

    // PERF: Use Map for O(1) lookup instead of O(n) find()
    const chunk = allChunksMap.get(selectedChunkId);
    if (!chunk) {
        console.error('VectHare: Chunk not found for uniqueId:', selectedChunkId);
        panel.html('<div class="vecthare-detail-empty">Chunk not found</div>');
        return;
    }

    const data = chunk.data;
    const wordCount = data.text.split(/\s+/).filter(Boolean).length;
    const tokenEstimate = Math.round(wordCount * 1.3);

    // PERF: Use Map for O(1) lookup instead of O(n) findIndex()
    const listPosition = filteredChunksMap.get(selectedChunkId);
    const displayNumber = listPosition !== undefined ? listPosition + 1 : '?';

    const hasConditions = data.conditions?.enabled && data.conditions?.rules?.length > 0;
    const hasSummaries = data.summaries?.length > 0;

    panel.html(`
        <!-- Header -->
        <div class="vecthare-detail-header">
            <!-- Chunk Name - Primary/Biggest -->
            <div class="vecthare-detail-name-section">
                <input type="text" class="vecthare-chunk-name-input" id="vecthare_chunk_name"
                       placeholder="Name this chunk..."
                       value="${escapeHtml(data.name || '')}">
            </div>
            <button class="vecthare-detail-delete" id="vecthare_delete_chunk">
                <i class="fa-solid fa-trash"></i> Delete
            </button>
        </div>

        <!-- Chunk Info Bar - Secondary -->
        <div class="vecthare-detail-info-bar">
            <span class="vecthare-info-item">
                <span class="vecthare-info-label">Chunk</span>
                <span class="vecthare-info-value">#${displayNumber}</span>
            </span>
            <span class="vecthare-info-divider">•</span>
            <span class="vecthare-info-item">
                <span class="vecthare-info-label">from Message</span>
                <span class="vecthare-info-value">#${chunk.index}</span>
            </span>
            <span class="vecthare-info-divider">•</span>
            <span class="vecthare-info-item vecthare-info-hash" title="Click to copy hash" id="vecthare_copy_hash">
                <span class="vecthare-info-value">${chunk.hash}</span>
            </span>
        </div>

        <!-- Content -->
        <div class="vecthare-detail-content">
            <!-- Text Block - Inline Editable -->
            <div class="vecthare-detail-text-block">
                <div class="vecthare-detail-text" id="vecthare_chunk_text" contenteditable="true">${escapeHtml(data.text)}</div>
                <div class="vecthare-detail-text-meta">
                    <span>${wordCount} words • ~${tokenEstimate} tokens</span>
                    <button class="vecthare-detail-save-btn vecthare-hidden" id="vecthare_save_text">
                        <i class="fa-solid fa-save"></i> Save & Re-embed
                    </button>
                </div>
            </div>

            <!-- Status Section -->
            <div class="vecthare-detail-section">
                <div class="vecthare-detail-section-title">Status</div>
                <div class="vecthare-detail-status-row">
                    <div class="vecthare-detail-toggle-item">
                        <span class="vecthare-toggle-label">Enabled</span>
                        <label class="vecthare-toggle-switch">
                            <input type="checkbox" id="vecthare_detail_enabled" ${data.enabled ? 'checked' : ''}>
                            <span class="vecthare-toggle-slider"></span>
                        </label>
                    </div>
                    <div class="vecthare-detail-toggle-item">
                        <span class="vecthare-toggle-label">Decay Immune</span>
                        <label class="vecthare-toggle-switch">
                            <input type="checkbox" id="vecthare_detail_blind" ${data.temporallyBlind ? 'checked' : ''}>
                            <span class="vecthare-toggle-slider"></span>
                        </label>
                    </div>
                </div>
            </div>

            <!-- Prompt Context Section -->
            <div class="vecthare-detail-section">
                <div class="vecthare-detail-section-title">
                    <i class="fa-solid fa-quote-left"></i> Prompt Context
                    <span class="vecthare-section-hint">(help AI understand this chunk)</span>
                </div>
                <div class="vecthare-detail-context">
                    <textarea class="vecthare-chunk-context-input" id="vecthare_chunk_context"
                              placeholder="e.g., A secret {{char}} keeps hidden from {{user}}"
                              rows="2">${escapeHtml(data.context || '')}</textarea>
                    <div class="vecthare-context-xmltag-row">
                        <label>XML tag:</label>
                        <input type="text" class="vecthare-chunk-xmltag-input" id="vecthare_chunk_xmltag"
                               placeholder="e.g., secret" value="${escapeHtml(data.xmlTag || '')}">
                    </div>
                    <div class="vecthare-context-injection-row">
                        <label>Injection position:</label>
                        <select id="vecthare_chunk_position" class="vecthare-chunk-position-select">
                            <option value="" ${data.position == null ? 'selected' : ''}>Use default</option>
                            <option value="2" ${data.position === 2 ? 'selected' : ''}>Before Main Prompt</option>
                            <option value="0" ${data.position === 0 ? 'selected' : ''}>After Main Prompt</option>
                            <option value="1" ${data.position === 1 ? 'selected' : ''}>In-Chat @ Depth</option>
                        </select>
                    </div>
                    <div class="vecthare-context-depth-row" id="vecthare_chunk_depth_row" style="display: ${data.position === 1 ? 'flex' : 'none'};">
                        <label>Depth: <span id="vecthare_chunk_depth_value">${data.depth ?? 2}</span></label>
                        <input type="range" id="vecthare_chunk_depth" class="vecthare-chunk-depth-slider"
                               min="0" max="50" step="1" value="${data.depth ?? 2}">
                    </div>
                    <div class="vecthare-context-hint">Supports {{user}} and {{char}}. XML tag wraps just this chunk.</div>
                </div>
            </div>

            <!-- Keywords Section -->
            <div class="vecthare-detail-section">
                <div class="vecthare-detail-section-header">
                    <span class="vecthare-detail-section-title">Keywords <span class="vecthare-section-hint">(boost when query matches)</span></span>
                    <button class="vecthare-keyword-mode-toggle" id="vecthare_keyword_mode" title="Toggle plaintext mode">
                        <i class="fa-solid ${plaintextKeywordMode ? 'fa-tag' : 'fa-code'}"></i>
                    </button>
                </div>
                <div class="vecthare-detail-keywords" id="vecthare_keywords_container">
                    ${plaintextKeywordMode ? `
                        <textarea class="vecthare-keyword-plaintext" id="vecthare_keywords_plaintext" placeholder="keyword:1.5x, another:2x, plain">${data.keywords.map(k => k.weight !== 1.0 ? `${k.text}:${k.weight}x` : k.text).join(', ')}</textarea>
                        <div class="vecthare-keyword-plaintext-hint">Format: keyword:2x for boost, or just keyword (defaults to 1.5x)</div>
                    ` : `
                        <div class="vecthare-keywords-list">
                            ${data.keywords.map((k, idx) => `
                                <span class="vecthare-keyword-tag" data-index="${idx}">
                                    <span class="vecthare-keyword-tag-text">${escapeHtml(k.text || 'unnamed')}</span>
                                    <span class="vecthare-keyword-tag-weight">${k.weight}x</span>
                                    <i class="fa-solid fa-xmark vecthare-keyword-remove" data-index="${idx}"></i>
                                </span>
                            `).join('')}
                        </div>
                        <button class="vecthare-keyword-add" id="vecthare_add_keyword">+ Add keyword...</button>
                    `}
                </div>
            </div>

            <!-- Conditions Section -->
            <div class="vecthare-detail-section">
                <div class="vecthare-detail-section-title">Conditions</div>
                <div class="vecthare-detail-conditions">
                    <div class="vecthare-conditions-header">
                        <label class="vecthare-conditions-toggle">
                            <input type="checkbox" id="vecthare_conditions_enabled" ${data.conditions?.enabled ? 'checked' : ''}>
                            <span>Enable conditional activation</span>
                        </label>
                        <div class="vecthare-conditions-logic">
                            <button class="vecthare-logic-btn ${data.conditions?.logic === 'AND' ? 'active' : ''}" data-logic="AND">AND</button>
                            <button class="vecthare-logic-btn ${data.conditions?.logic === 'OR' ? 'active' : ''}" data-logic="OR">OR</button>
                        </div>
                    </div>
                    <div class="vecthare-conditions-list" id="vecthare_conditions_list">
                        ${(data.conditions?.rules || []).map((rule, i) => `
                            <div class="vecthare-condition-item" data-index="${i}">
                                <span class="vecthare-condition-item-num">${i + 1}.</span>
                                <span class="vecthare-condition-item-text">${escapeHtml(formatConditionRule(rule))}</span>
                                <i class="fa-solid fa-xmark vecthare-condition-item-remove"></i>
                            </div>
                        `).join('')}
                    </div>
                    <button class="vecthare-add-condition-btn" id="vecthare_add_condition">+ Add Condition Rule</button>
                </div>
            </div>

            <!-- Chunk Links Section -->
            <div class="vecthare-detail-section">
                <div class="vecthare-detail-section-title">
                    <i class="fa-solid fa-link"></i> Chunk Links
                    <span class="vecthare-section-hint">(pull related chunks into results)</span>
                </div>
                <div class="vecthare-detail-links">
                    <div class="vecthare-links-list" id="vecthare_links_list">
                        ${(data.chunkLinks || []).map((link, i) => `
                            <div class="vecthare-link-item ${link.mode}" data-index="${i}">
                                <span class="vecthare-link-mode-badge ${link.mode}">${link.mode === 'force' ? '🔗 Force' : '〰️ Soft'}</span>
                                <span class="vecthare-link-target" title="Target hash: ${link.targetHash}">${link.targetHash.toString().substring(0, 12)}...</span>
                                <i class="fa-solid fa-xmark vecthare-link-item-remove"></i>
                            </div>
                        `).join('')}
                    </div>
                    <div class="vecthare-links-help">
                        <span class="vecthare-help-badge force">Force</span> = Target chunk MUST appear if this chunk appears<br>
                        <span class="vecthare-help-badge soft">Soft</span> = Target chunk gets score boost if this chunk appears
                    </div>
                    <button class="vecthare-add-link-btn" id="vecthare_add_link">+ Add Link</button>
                </div>
            </div>

            <!-- Summaries Section -->
            <div class="vecthare-detail-section">
                <div class="vecthare-detail-section-title">Dual-Vector Summaries</div>
                <div class="vecthare-detail-summaries">
                    <div class="vecthare-summaries-header">
                        <span>Alternative search vectors for this chunk</span>
                    </div>
                    <div class="vecthare-summaries-list" id="vecthare_summaries_list">
                        ${(data.summaries || []).map((summary, i) => {
                            const summaryHash = getStringHash(summary);
                            return `
                            <div class="vecthare-summary-item" data-index="${i}">
                                <div class="vecthare-summary-item-content">
                                    <span class="vecthare-summary-item-text">${escapeHtml(summary)}</span>
                                    <span class="vecthare-summary-item-hash" title="Summary vector hash">#${summaryHash}</span>
                                </div>
                                <i class="fa-solid fa-xmark vecthare-summary-item-remove"></i>
                            </div>
                        `}).join('')}
                    </div>
                    <button class="vecthare-add-summary-btn" id="vecthare_add_summary">+ Add Summary</button>
                </div>
            </div>
        </div>
    `);

    bindDetailEvents();
}

function formatConditionRule(rule) {
    if (!rule || !rule.type) return 'Unknown condition';

    const negation = rule.negated ? 'NOT ' : '';
    const value = rule.settings?.value || rule.value || '';  // Support both formats

    switch (rule.type) {
        case 'pattern':
            return `${negation}Pattern: "${value}"`;
        case 'speaker':
            return `${negation}Speaker: ${value || 'undefined'}`;
        case 'messageCount':
            // Extract operator and number if value is like ">=100" or just "100"
            const match = value.match(/^([><=!]+)?(\d+)$/);
            if (match) {
                const operator = match[1] || '>=';
                const count = match[2];
                return `${negation}Message Count ${operator} ${count}`;
            }
            return `${negation}Message Count: ${value}`;
        case 'emotion':
            return `${negation}Emotion: ${value}`;
        case 'isGroupChat':
            return `${negation}Is Group Chat`;
        case 'timeOfDay':
            // Handle different time formats
            if (!value) return `${negation}Time of Day: (no time set)`;
            return `${negation}Time of Day: ${value}`;
        case 'randomChance':
            // Value should be a percentage
            const percent = value || rule.settings?.percent || '50';
            return `${negation}Random Chance: ${percent}%`;
        default:
            return `${negation}${rule.type}: ${value || '(empty)'}`;
    }
}

// ============================================================================
// EVENT BINDING
// ============================================================================

function bindEvents() {
    // Save
    $('#vecthare_visualizer_save').on('click', saveAllChanges);

    // Close
    $('#vecthare_visualizer_close').on('click', closeVisualizer);
    // Stop mousedown propagation (ST closes drawers on mousedown/touchstart)
    $('#vecthare_visualizer_modal').on('mousedown touchstart', function(e) {
        e.stopPropagation();
    });
    // Close on background click
    $('#vecthare_visualizer_modal').on('click', function(e) {
        if (e.target === this) closeVisualizer();
    });

    // Tab switching
    $('.vecthare-visualizer-tab').on('click', function() {
        const tab = $(this).data('tab');
        if (tab === activeTab) return;

        activeTab = tab;

        // Update tab button states
        $('.vecthare-visualizer-tab').removeClass('active');
        $(this).addClass('active');

        // Show/hide tab content
        $('.vecthare-vis-tab-content').removeClass('active');
        $(`.vecthare-vis-tab-content[data-tab="${tab}"]`).addClass('active');

        // Render tab content when switching
        if (tab === 'scenes') {
            renderScenesTab();
        } else if (tab === 'groups') {
            renderGroupsTab();
        }
    });

    // Search
    $('#vecthare_chunk_search').on('input', debounce(function() {
        searchQuery = $(this).val();
        applyFilters();
        renderChunkList();
    }, 200));

    // Sort
    $('#vecthare_chunk_sort').on('change', function() {
        sortBy = $(this).val();
        applyFilters();
        renderChunkList();
    });

    // Filter
    $('#vecthare_chunk_filter').on('change', function() {
        filterBy = $(this).val();
        applyFilters();
        renderChunkList();
    });

    // Fetch limit
    $('#vecthare_fetch_limit').on('change', function() {
        const val = parseInt($(this).val());
        chunkFetchLimit = isNaN(val) || val < 100 ? 1000 : val;
        $(this).val(chunkFetchLimit);
    });

    // Reload button
    $('#vecthare_reload_chunks').off('click').on('click', function() {
        if (onReloadCallback) onReloadCallback(chunkFetchLimit);
    });

    // Chunk selection - bind to container, not document (because modal stops propagation)
    $('#vecthare_visualizer_modal').on('click', '.vecthare-chunk-item', function(e) {
        e.preventDefault();
        e.stopPropagation();
        const uid = $(this).attr('data-uid');
        console.log('VectHare: Clicked chunk with uniqueId:', uid);
        if (!uid) {
            console.error('VectHare: No uniqueId found on clicked element');
            return;
        }
        // Warn if switching chunks with unsaved changes
        if (hasUnsavedChanges && uid !== selectedChunkId) {
            if (!confirm('You have unsaved text changes. Switch chunks anyway?')) {
                return;
            }
            hasUnsavedChanges = false;
        }
        selectedChunkId = uid;
        renderChunkList();
        renderDetailPanel();
    });

    // Load more
    $('#vecthare_visualizer_modal').on('click', '#vecthare_load_more', function() {
        displayLimit += 50;
        renderChunkList();
    });

    // Bulk mode
    $('#vecthare_bulk_mode').on('change', function() {
        bulkSelectMode = $(this).is(':checked');
        $('#vecthare_bulk_buttons').toggle(bulkSelectMode);
    });

    $('#vecthare_bulk_enable').on('click', () => bulkSetEnabled(true));
    $('#vecthare_bulk_disable').on('click', () => bulkSetEnabled(false));
}

function bindDetailEvents() {
    // PERF: Use Map for O(1) lookup instead of O(n) find()
    const chunk = allChunksMap.get(selectedChunkId);
    if (!chunk) return;

    const originalText = chunk.data.text;

    // Chunk name input
    $('#vecthare_chunk_name').on('input', debounce(function() {
        const name = $(this).val().trim();
        chunk.data.name = name || null;
        updateChunkData(chunk.hash, { name: chunk.data.name });
        renderChunkList();
    }, 300));

    // Inline text editing - track changes
    $('#vecthare_chunk_text').on('input', function() {
        const newText = $(this).text().trim();
        if (newText !== originalText) {
            hasUnsavedChanges = true;
            $('#vecthare_save_text').removeClass('vecthare-hidden');
        } else {
            hasUnsavedChanges = false;
            $('#vecthare_save_text').addClass('vecthare-hidden');
        }
    });

    // Save text changes
    $('#vecthare_save_text').on('click', async function() {
        const newText = $('#vecthare_chunk_text').text().trim();
        if (!newText) return;

        $(this).prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i> Saving...');

        try {
            // Delete old
            await deleteVectorItems(currentCollectionId, [chunk.hash], currentSettings);

            // Insert new with new hash (keep as number for Qdrant compatibility)
            const newHash = getStringHash(newText);
            await insertVectorItems(currentCollectionId, [{
                hash: newHash,
                text: newText,
                index: chunk.index
            }], currentSettings);

            // Update metadata (use string keys for metadata storage)
            const oldMeta = getChunkMetadata(String(chunk.hash));
            if (oldMeta) {
                deleteChunkMetadata(String(chunk.hash));
                saveChunkMetadata(String(newHash), { ...oldMeta });
            }

            // Update local state
            chunk.hash = newHash;
            chunk.text = newText;
            chunk.data.text = newText;
            hasUnsavedChanges = false;

            renderChunkList();
            renderDetailPanel();
            toastr.success('Chunk updated successfully', 'VectHare');
        } catch (error) {
            console.error('Failed to update chunk:', error);
            toastr.error('Failed to update chunk', 'VectHare');
            $(this).prop('disabled', false).html('<i class="fa-solid fa-save"></i> Save & Re-embed');
        }
    });

    // Enabled toggle
    $('#vecthare_detail_enabled').on('change', function() {
        const enabled = $(this).is(':checked');
        updateChunkData(chunk.hash, { enabled });
        chunk.data.enabled = enabled;
        renderChunkList();
    });

    // Blind toggle
    $('#vecthare_detail_blind').on('change', function() {
        const blind = $(this).is(':checked');
        setChunkTemporallyBlind(chunk.hash, blind);
        chunk.data.temporallyBlind = blind;
        renderChunkList();
    });

    // Prompt context input
    $('#vecthare_chunk_context').on('input', debounce(function() {
        const context = $(this).val();
        chunk.data.context = context || '';
        updateChunkData(chunk.hash, { context: chunk.data.context });
    }, 300));

    // XML tag input (sanitize to alphanumeric + underscore/hyphen)
    $('#vecthare_chunk_xmltag').on('input', debounce(function() {
        const sanitized = $(this).val().replace(/[^a-zA-Z0-9_-]/g, '');
        $(this).val(sanitized);
        chunk.data.xmlTag = sanitized || '';
        updateChunkData(chunk.hash, { xmlTag: chunk.data.xmlTag });
    }, 300));

    // Injection position select
    $('#vecthare_chunk_position').on('change', function() {
        const val = $(this).val();
        const position = val === '' ? null : parseInt(val);
        chunk.data.position = position;
        updateChunkData(chunk.hash, { position: chunk.data.position });
        // Show/hide depth row
        $('#vecthare_chunk_depth_row').toggle(position === 1);
    });

    // Injection depth slider
    $('#vecthare_chunk_depth').on('input', function() {
        const depth = parseInt($(this).val()) || 2;
        $('#vecthare_chunk_depth_value').text(depth);
        chunk.data.depth = depth;
        updateChunkData(chunk.hash, { depth: chunk.data.depth });
    });

    // Delete chunk
    $('#vecthare_delete_chunk').on('click', () => deleteChunk(chunk));

    // Keyword mode toggle (plaintext vs badge)
    $('#vecthare_keyword_mode').on('click', function() {
        // If in plaintext mode, parse and save before switching
        if (plaintextKeywordMode) {
            const plaintext = $('#vecthare_keywords_plaintext').val();
            chunk.data.keywords = parsePlaintextKeywords(plaintext);
            updateChunkData(chunk.hash, { keywords: chunk.data.keywords });
        }
        plaintextKeywordMode = !plaintextKeywordMode;
        renderDetailPanel();
    });

    // Plaintext keywords - save on blur
    $('#vecthare_keywords_plaintext').on('blur', function() {
        const plaintext = $(this).val();
        chunk.data.keywords = parsePlaintextKeywords(plaintext);
        updateChunkData(chunk.hash, { keywords: chunk.data.keywords });
    });

    // Keywords - add new
    $('#vecthare_add_keyword').on('click', function() {
        $(this).replaceWith('<input type="text" class="vecthare-keyword-input" id="vecthare_keyword_input" placeholder="Enter keyword...">');
        $('#vecthare_keyword_input').focus().on('keydown', function(e) {
            if (e.key === 'Enter') {
                const keyword = $(this).val().trim();
                if (keyword && !chunk.data.keywords.some(k => k.text === keyword)) {
                    chunk.data.keywords.push({ text: keyword, weight: 1.5 }); // Default 1.5x boost
                    updateChunkData(chunk.hash, { keywords: chunk.data.keywords });
                }
                renderDetailPanel();
            } else if (e.key === 'Escape') {
                renderDetailPanel();
            }
        }).on('blur', function() {
            renderDetailPanel();
        });
    });

    // Keyword remove button
    $('.vecthare-keyword-remove').on('click', function() {
        const index = $(this).data('index');
        chunk.data.keywords.splice(index, 1);
        updateChunkData(chunk.hash, { keywords: chunk.data.keywords });
        renderDetailPanel();
    });

    // Conditions
    $('#vecthare_conditions_enabled').on('change', function() {
        chunk.data.conditions.enabled = $(this).is(':checked');
        updateChunkData(chunk.hash, { conditions: chunk.data.conditions });
    });

    $('.vecthare-logic-btn').on('click', function() {
        const logic = $(this).data('logic');
        chunk.data.conditions.logic = logic;
        updateChunkData(chunk.hash, { conditions: chunk.data.conditions });
        $('.vecthare-logic-btn').removeClass('active');
        $(this).addClass('active');
    });

    $('.vecthare-condition-item-remove').on('click', function() {
        const index = $(this).closest('.vecthare-condition-item').data('index');
        chunk.data.conditions.rules.splice(index, 1);
        updateChunkData(chunk.hash, { conditions: chunk.data.conditions });
        renderDetailPanel();
        renderChunkList();
    });

    // Add condition rule
    $('#vecthare_add_condition').on('click', function() {
        openConditionEditor(chunk);
    });

    // Chunk links
    $('#vecthare_add_link').on('click', function() {
        openLinkEditor(chunk);
    });

    $('.vecthare-link-item-remove').on('click', function() {
        const index = $(this).closest('.vecthare-link-item').data('index');
        chunk.data.chunkLinks.splice(index, 1);
        updateChunkData(chunk.hash, { chunkLinks: chunk.data.chunkLinks });
        renderDetailPanel();
    });

    // Summaries
    $('.vecthare-summary-item-remove').on('click', function() {
        const index = $(this).closest('.vecthare-summary-item').data('index');
        const summaryText = chunk.data.summaries[index];

        // Track for deletion on save
        if (!chunk.data._deletedSummaries) chunk.data._deletedSummaries = [];
        chunk.data._deletedSummaries.push(summaryText);

        // Remove from local data
        chunk.data.summaries.splice(index, 1);
        updateChunkData(chunk.hash, { summaries: chunk.data.summaries, _deletedSummaries: chunk.data._deletedSummaries });
        renderDetailPanel();
    });

    $('#vecthare_add_summary').on('click', function() {
        const summary = prompt('Enter summary text:');
        if (summary && summary.trim()) {
            const summaryText = summary.trim();

            // Track for vectorization on save
            if (!chunk.data._newSummaries) chunk.data._newSummaries = [];
            chunk.data._newSummaries.push(summaryText);

            // Add to local data
            chunk.data.summaries.push(summaryText);
            updateChunkData(chunk.hash, { summaries: chunk.data.summaries, _newSummaries: chunk.data._newSummaries });
            renderDetailPanel();
        }
    });
}

/**
 * Parse plaintext keywords format: "keyword:2x, another:1.5x, plain"
 */
function parsePlaintextKeywords(text) {
    if (!text || !text.trim()) return [];

    return text.split(',').map(item => {
        const trimmed = item.trim();
        if (!trimmed) return null;

        // Check for weight suffix like :2x or :1.5x
        const match = trimmed.match(/^(.+?):(\d+\.?\d*)x?$/i);
        if (match) {
            return { text: match[1].trim(), weight: parseFloat(match[2]) };
        }
        // No weight specified, default to 1.5x
        return { text: trimmed, weight: 1.5 };
    }).filter(Boolean);
}

// ============================================================================
// TEXT EDITOR
// ============================================================================

function openTextEditor(chunk) {
    const overlay = $(`
        <div class="vecthare-text-editor-overlay" id="vecthare_text_editor_overlay">
            <div class="vecthare-text-editor-modal">
                <div class="vecthare-text-editor-header">
                    <h4>Edit Chunk Text</h4>
                </div>
                <div class="vecthare-text-editor-body">
                    <textarea class="vecthare-text-editor-textarea" id="vecthare_text_editor_textarea">${escapeHtml(chunk.data.text)}</textarea>
                </div>
                <div class="vecthare-text-editor-footer">
                    <button class="vecthare-text-editor-btn vecthare-text-editor-cancel" id="vecthare_text_cancel">Cancel</button>
                    <button class="vecthare-text-editor-btn vecthare-text-editor-save" id="vecthare_text_save">Save & Re-embed</button>
                </div>
            </div>
        </div>
    `);

    $('.vecthare-visualizer-container').append(overlay);

    $('#vecthare_text_cancel').on('click', () => overlay.remove());
    overlay.on('click', function(e) {
        if (e.target === this) overlay.remove();
    });

    $('#vecthare_text_save').on('click', async function() {
        const newText = $('#vecthare_text_editor_textarea').val().trim();
        if (!newText) return;

        $(this).prop('disabled', true).text('Saving...');

        try {
            // Delete old
            await deleteVectorItems(currentCollectionId, [chunk.hash], currentSettings);

            // Insert new with new hash (keep as number for Qdrant compatibility)
            const newHash = getStringHash(newText);
            await insertVectorItems(currentCollectionId, [{
                hash: newHash,
                text: newText,
                index: chunk.index
            }], currentSettings);

            // Update metadata (use string keys for metadata storage)
            const oldMeta = getChunkMetadata(String(chunk.hash));
            if (oldMeta) {
                deleteChunkMetadata(String(chunk.hash));
                saveChunkMetadata(String(newHash), { ...oldMeta });
            }

            // Update local state - update hash but keep same uniqueId for selection
            chunk.hash = newHash;
            chunk.text = newText;
            chunk.data.text = newText;
            // selectedChunkId stays the same since uniqueId doesn't change

            overlay.remove();
            renderChunkList();
            renderDetailPanel();
            toastr.success('Chunk updated successfully', 'VectHare');
        } catch (error) {
            console.error('Failed to update chunk:', error);
            toastr.error('Failed to update chunk', 'VectHare');
            $(this).prop('disabled', false).text('Save & Re-embed');
        }
    });
}

// ============================================================================
// CONDITION EDITOR
// ============================================================================

const CONDITION_TYPES = [
    { value: 'pattern', label: 'Pattern Match', icon: '🔍' },
    { value: 'speaker', label: 'Speaker', icon: '💬' },
    { value: 'messageCount', label: 'Message Count', icon: '📊' },
    { value: 'emotion', label: 'Emotion', icon: '😊' },
    { value: 'isGroupChat', label: 'Group Chat', icon: '👥' },
    { value: 'timeOfDay', label: 'Time of Day', icon: '🕐' },
    { value: 'randomChance', label: 'Random Chance', icon: '🎲' },
];

function openConditionEditor(chunk) {
    const overlay = $(`
        <div class="vecthare-editor-overlay" id="vecthare_condition_editor">
            <div class="vecthare-editor-modal">
                <div class="vecthare-editor-header">
                    <h4><i class="fa-solid fa-bolt"></i> Add Condition Rule</h4>
                    <button class="vecthare-editor-close" id="vecthare_condition_close">×</button>
                </div>
                <div class="vecthare-editor-body">
                    <div class="vecthare-editor-field">
                        <label>Condition Type</label>
                        <select id="vecthare_condition_type" class="vecthare-editor-select">
                            ${CONDITION_TYPES.map(t => `<option value="${t.value}">${t.icon} ${t.label}</option>`).join('')}
                        </select>
                    </div>
                    <div class="vecthare-editor-field" id="vecthare_condition_settings">
                        <label>Pattern</label>
                        <input type="text" id="vecthare_condition_value" class="vecthare-editor-input" placeholder="Enter pattern or value...">
                    </div>
                    <div class="vecthare-editor-field">
                        <label class="vecthare-editor-checkbox">
                            <input type="checkbox" id="vecthare_condition_negate">
                            <span>Negate (NOT)</span>
                        </label>
                    </div>
                </div>
                <div class="vecthare-editor-footer">
                    <button class="vecthare-editor-btn cancel" id="vecthare_condition_cancel">Cancel</button>
                    <button class="vecthare-editor-btn primary" id="vecthare_condition_add">Add Condition</button>
                </div>
            </div>
        </div>
    `);

    $('.vecthare-visualizer-container').append(overlay);

    $('#vecthare_condition_close, #vecthare_condition_cancel').on('click', () => overlay.remove());
    overlay.on('click', function(e) {
        if (e.target === this) overlay.remove();
    });

    $('#vecthare_condition_add').on('click', function() {
        const type = $('#vecthare_condition_type').val();
        const value = $('#vecthare_condition_value').val().trim();
        const negated = $('#vecthare_condition_negate').is(':checked');

        if (!value && type !== 'isGroupChat' && type !== 'randomChance') {
            toastr.warning('Please enter a value', 'VectHare');
            return;
        }

        const rule = {
            type,
            negated,
            settings: { value }
        };

        if (!chunk.data.conditions.rules) {
            chunk.data.conditions.rules = [];
        }
        chunk.data.conditions.rules.push(rule);
        updateChunkData(chunk.hash, { conditions: chunk.data.conditions });

        overlay.remove();
        renderDetailPanel();
        renderChunkList();
        toastr.success('Condition added', 'VectHare');
    });
}

// ============================================================================
// LINK EDITOR
// ============================================================================

function openLinkEditor(chunk) {
    // Get available chunks to link to (excluding self)
    const availableChunks = allChunks.filter(c => c.hash !== chunk.hash);

    const overlay = $(`
        <div class="vecthare-editor-overlay" id="vecthare_link_editor">
            <div class="vecthare-editor-modal">
                <div class="vecthare-editor-header">
                    <h4><i class="fa-solid fa-link"></i> Add Chunk Link</h4>
                    <button class="vecthare-editor-close" id="vecthare_link_close">×</button>
                </div>
                <div class="vecthare-editor-body">
                    <div class="vecthare-editor-field">
                        <label>Link Mode</label>
                        <div class="vecthare-link-mode-selector">
                            <label class="vecthare-link-mode-option">
                                <input type="radio" name="link_mode" value="force" checked>
                                <span class="vecthare-link-mode-card force">
                                    <span class="icon">🔗</span>
                                    <span class="title">Force Link</span>
                                    <span class="desc">Target MUST appear when this chunk appears</span>
                                </span>
                            </label>
                            <label class="vecthare-link-mode-option">
                                <input type="radio" name="link_mode" value="soft">
                                <span class="vecthare-link-mode-card soft">
                                    <span class="icon">〰️</span>
                                    <span class="title">Soft Link</span>
                                    <span class="desc">Target gets score boost when this chunk appears</span>
                                </span>
                            </label>
                        </div>
                    </div>
                    <div class="vecthare-editor-field">
                        <label>Target Chunk</label>
                        <select id="vecthare_link_target" class="vecthare-editor-select">
                            ${availableChunks.map(c => {
                                const preview = c.data.text.substring(0, 40).replace(/\s+/g, ' ') + '...';
                                const name = c.data.name || preview;
                                return `<option value="${c.hash}">[Msg #${c.index}] ${escapeHtml(name)}</option>`;
                            }).join('')}
                        </select>
                    </div>
                </div>
                <div class="vecthare-editor-footer">
                    <button class="vecthare-editor-btn cancel" id="vecthare_link_cancel">Cancel</button>
                    <button class="vecthare-editor-btn primary" id="vecthare_link_add">Add Link</button>
                </div>
            </div>
        </div>
    `);

    $('.vecthare-visualizer-container').append(overlay);

    $('#vecthare_link_close, #vecthare_link_cancel').on('click', () => overlay.remove());
    overlay.on('click', function(e) {
        if (e.target === this) overlay.remove();
    });

    $('#vecthare_link_add').on('click', function() {
        const mode = $('input[name="link_mode"]:checked').val();
        const targetHash = $('#vecthare_link_target').val();

        if (!targetHash) {
            toastr.warning('Please select a target chunk', 'VectHare');
            return;
        }

        // Check for duplicate
        if (chunk.data.chunkLinks.some(l => l.targetHash === targetHash)) {
            toastr.warning('Link to this chunk already exists', 'VectHare');
            return;
        }

        chunk.data.chunkLinks.push({ targetHash, mode });
        updateChunkData(chunk.hash, { chunkLinks: chunk.data.chunkLinks });

        overlay.remove();
        renderDetailPanel();
        toastr.success('Link added', 'VectHare');
    });
}

// ============================================================================
// DELETE CHUNK
// ============================================================================

async function deleteChunk(chunk) {
    if (!confirm(`Delete chunk #${chunk.index}?`)) return;

    try {
        await deleteVectorItems(currentCollectionId, [chunk.hash], currentSettings);
        deleteChunkMetadata(chunk.hash);

        // Remove from local state by uniqueId
        const idx = allChunks.findIndex(c => c.uniqueId === chunk.uniqueId);
        if (idx !== -1) allChunks.splice(idx, 1);

        selectedChunkId = null;
        applyFilters();
        renderChunkList();
        renderDetailPanel();
        toastr.success('Chunk deleted', 'VectHare');
    } catch (error) {
        console.error('Failed to delete chunk:', error);
        toastr.error('Failed to delete chunk', 'VectHare');
    }
}

// ============================================================================
// BULK OPERATIONS
// ============================================================================

function bulkSetEnabled(enabled) {
    for (const chunk of filteredChunks) {
        chunk.data.enabled = enabled;
        updateChunkData(chunk.hash, { enabled });
    }
    renderChunkList();
    if (selectedChunkId) renderDetailPanel();
    toastr.success(`${enabled ? 'Enabled' : 'Disabled'} ${filteredChunks.length} chunks`, 'VectHare');
}

// ============================================================================
// UTILITIES
// ============================================================================

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function debounce(func, wait) {
    let timeout;
    return function(...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), wait);
    };
}

// ============================================================================
// INITIALIZATION
// ============================================================================

/**
 * Initialize the chunk visualizer module
 * Called from index.js on extension load
 */
export function initializeVisualizer() {
    console.log('VectHare: Chunk visualizer initialized');
    // No DOM setup needed - modal is created dynamically when opened
}

// ============================================================================
// EXPORTS
// ============================================================================

export { openVisualizer as default };
