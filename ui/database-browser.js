/**
 * ============================================================================
 * VECTHARE DATABASE BROWSER
 * ============================================================================
 * Comprehensive vector database browser UI
 * Main entry point for browsing, managing, and editing all vector collections
 *
 * @author Coneja Chibi
 * @version 2.2.0-alpha
 * ============================================================================
 */

import {
  loadAllCollections,
  setCollectionEnabled,
  registerCollection,
  unregisterCollection,
  clearCollectionRegistry,
  deleteCollection,
} from "../core/collection-loader.js";
import {
  purgeVectorIndex,
  queryMultipleCollections,
} from "../core/core-vector-api.js";
import { getRequestHeaders, getCurrentChatId, eventSource, event_types } from "../../../../../script.js";
import {
  cleanupOrphanedMeta,
  deleteCollectionMeta,
  getCollectionConditions,
  setCollectionConditions,
  getCollectionTriggers,
  setCollectionTriggers,
  getCollectionMeta,
  setCollectionMeta,
  getCollectionActivationSummary,
  getCollectionDecaySummary,
  getCollectionDecaySettings,
  setCollectionDecaySettings,
  hasCustomDecaySettings,
  getDefaultDecayForType,
  isCollectionEnabled,
  // Locking API
  getCollectionLock,
  getCollectionLocks,
  setCollectionLock,
  removeCollectionLock,
  clearCollectionLock,
  isCollectionLockedToChat,
  getCollectionLockCount,
  // Character Locking API
  getCollectionCharacterLocks,
  setCollectionCharacterLock,
  removeCollectionCharacterLock,
  clearCollectionCharacterLocks,
  isCollectionLockedToCharacter,
  getCollectionCharacterLockCount,
} from "../core/collection-metadata.js";
import { getContext } from "../../../../extensions.js";
import {
  VALID_EMOTIONS,
  VALID_GENERATION_TYPES,
  getExpressionsExtensionStatus,
} from "../core/conditional-activation.js";
import { world_names, loadWorldInfo } from "../../../../world-info.js";
import { icons } from "./icons.js";
import { openVisualizer } from "./chunk-visualizer.js";
import { queryCollection } from "../core/core-vector-api.js";
import {
  exportCollection,
  importCollection,
  downloadExport,
  readImportFile,
  validateImportData,
  getExportInfo,
} from "../core/collection-export.js";
import {
  embedDataInPNG,
  extractDataFromPNG,
  downloadPNG,
  readPNGFile,
  convertToPNG,
  isVectHarePNG,
} from "../core/png-export.js";

// Plugin availability cache
let pluginAvailable = null;

/**
 * Check if the Similharity plugin is available
 * @returns {Promise<boolean>}
 */
async function checkPluginAvailable() {
  if (pluginAvailable !== null) return pluginAvailable;

  try {
    const response = await fetch("/api/plugins/similharity/health", {
      method: "GET",
      headers: getRequestHeaders(),
    });
    pluginAvailable = response.ok;
  } catch {
    pluginAvailable = false;
  }
  return pluginAvailable;
}

// Browser state
let browserState = {
  isOpen: false,
  pluginAvailable: null,
  collections: [],
  selectedCollection: null,
  filters: {
    scope: "all", // 'all', 'global', 'character', 'chat'
    collectionType: "all", // 'all', 'chat', 'file', 'lorebook'
    searchQuery: "",
  },
  settings: null,
  // Bulk operations state
  bulkSelected: new Set(),
  bulkFilter: "all", // 'all', 'enabled', 'disabled'
  // Search state
  searchResults: null,
  isSearching: false,
  // Keyword filter state
  keywordFilter: '',
  availableKeywords: [],
  // PNG export state
  pendingPngExport: null,
};

// Event binding flags (module-level for proper reset on modal close)
let searchEventsBound = false;
let bulkEventsBound = false;

/**
 * Initializes the database browser
 * @param {object} settings VectHare settings
 */
export function initializeDatabaseBrowser(settings) {
  browserState.settings = settings;
  console.log("VectHare Database Browser: Initialized");
}

/**
 * Opens the database browser modal
 */
export async function openDatabaseBrowser() {
  if (browserState.isOpen) {
    console.log("VectHare Database Browser: Already open");
    return;
  }

  browserState.isOpen = true;

  // Check plugin availability
  browserState.pluginAvailable = await checkPluginAvailable();

  // Create modal if it doesn't exist
  if ($("#vecthare_database_browser_modal").length === 0) {
    createBrowserModal();
  }

  // Show/hide plugin warning banner
  updatePluginWarningBanner();

  // Load collections
  await refreshCollections();

  // Show modal
  $("#vecthare_database_browser_modal").fadeIn(200);
  console.log("VectHare Database Browser: Opened");
}

/**
 * Updates the plugin warning banner visibility
 */
function updatePluginWarningBanner() {
  const banner = $("#vecthare_plugin_warning_banner");
  if (browserState.pluginAvailable) {
    banner.hide();
  } else {
    banner.show();
  }
}

/**
 * Closes the database browser modal
 */
export function closeDatabaseBrowser() {
  $("#vecthare_database_browser_modal").fadeOut(200);
  browserState.isOpen = false;
  // Reset event bound flags for clean rebind on next open
  resetEventFlags();
  console.log("VectHare Database Browser: Closed");
}

/**
 * Resets event bound flags (called on modal close)
 */
function resetEventFlags() {
  // Reset flags so events rebind properly on next modal open
  bulkEventsBound = false;
  searchEventsBound = false;
}

/**
 * Creates the browser modal HTML structure
 */
function createBrowserModal() {
  const modalHtml = `
        <div id="vecthare_database_browser_modal" class="vecthare-modal">
            <div class="vecthare-modal-content vecthare-database-browser-content">
                <!-- Header -->
                <div class="vecthare-modal-header">
                    <h3>🗃️ VectHare Database Browser</h3>
                    <button class="vecthare-btn-icon" id="vecthare_browser_close">✕</button>
                </div>

                <!-- Plugin Warning Banner (hidden by default, shown when plugin unavailable) -->
                <div id="vecthare_plugin_warning_banner" class="vecthare-warning-banner" style="display: none;">
                    <i class="fa-solid fa-triangle-exclamation" style="color: var(--SmartThemeQuoteColor);"></i>
                    <div class="vecthare-warning-text">
                        <strong>Limited Discovery Mode</strong>
                        <span>Similharity plugin not detected. Only registered collections and current chat can be discovered.
                        Collections created outside VectHare won't appear here.
                        <a href="https://github.com/Coneja-Chibi/VectHare/tree/Similharity-Plugin" target="_blank">Install the plugin</a> for full filesystem scanning.</span>
                    </div>
                </div>

                <!-- Browser Tabs -->
                <div class="vecthare-browser-tabs">
                    <button class="vecthare-tab-btn active" data-tab="collections">
                        ${icons.folder(16)} Collections
                    </button>
                    <button class="vecthare-tab-btn" data-tab="search">
                        ${icons.search(16)} Search
                    </button>
                    <button class="vecthare-tab-btn" data-tab="bulk">
                        ${icons.listChecks(16)} Bulk Operations
                    </button>
                </div>

                <!-- Tab Content -->
                <div class="vecthare-browser-content">
                    <!-- Collections Tab -->
                    <div id="vecthare_tab_collections" class="vecthare-tab-content active">
                        <!-- Scope Filters (V1-style) -->
                        <div class="vecthare-scope-filters">
                            <button class="vecthare-scope-filter active" data-scope="all" title="Show all collections">All</button>
                            <button class="vecthare-scope-filter" data-scope="global" title="Global = collections set to 'Always Active'">Global</button>
                            <button class="vecthare-scope-filter" data-scope="character" title="Character = collections locked to at least one character">Character</button>
                            <button class="vecthare-scope-filter" data-scope="chat" title="Chat = collections locked to at least one chat">Chat</button>

                            <!-- Small badge and hint describing current scope filter -->
                        </div>

                        <!-- Type Filters -->
                        <div class="vecthare-type-filters">
                            <label>
                                <input type="radio" name="vecthare_type_filter" value="all" checked>
                                All Types
                            </label>
                            <label>
                                <input type="radio" name="vecthare_type_filter" value="chat">
                                ${icons.messageSquare(14)} Chats
                            </label>
                            <label>
                                <input type="radio" name="vecthare_type_filter" value="lorebook">
                                ${icons.bookOpen(14)} Lorebooks
                            </label>
                            <label>
                                <input type="radio" name="vecthare_type_filter" value="character">
                                ${icons.user(14)} Characters
                            </label>
                            <label>
                                <input type="radio" name="vecthare_type_filter" value="document">
                                ${icons.fileText(14)} Documents
                            </label>
                            <label>
                                <input type="radio" name="vecthare_type_filter" value="web">
                                ${icons.globe(14)} Web
                            </label>
                        </div>

                        <!-- Search Box -->
                        <div class="vecthare-search-box">
                            <input type="text"
                                   id="vecthare_collection_search"
                                   placeholder="Search collections..."
                                   autocomplete="off">
                        </div>

                        <!-- Collections List -->
                        <div id="vecthare_collections_list" class="vecthare-collections-list">
                            <div class="vecthare-loading">Loading collections...</div>
                        </div>

                        <!-- Stats Footer -->
                        <div class="vecthare-browser-stats">
                            <span id="vecthare_browser_stats_text">No collections</span>
                            <div class="vecthare-browser-actions">
                                <button id="vecthare_import_collection" class="vecthare-btn-sm" title="Import collection from file">
                                    📥 Import
                                </button>
                                <button id="vecthare_reset_registry" class="vecthare-reset-btn" title="Clear registry and rescan from disk">
                                    <i class="fa-solid fa-arrows-rotate"></i> Resync
                                </button>
                            </div>
                        </div>
                        <!-- Hidden file inputs for import -->
                        <input type="file" id="vecthare_import_file" accept=".json,.vecthare.json,.png,image/png" style="display: none;">
                        <input type="file" id="vecthare_png_image_picker" accept="image/*" style="display: none;">
                    </div>

                    <!-- Search Tab -->
                    <div id="vecthare_tab_search" class="vecthare-tab-content">
                        <div class="vecthare-search-panel">
                            <!-- Search Input -->
                            <div class="vecthare-search-input-row">
                                <input type="text"
                                       id="vecthare_semantic_search"
                                       class="vecthare-search-input"
                                       placeholder="Search across all collections..."
                                       autocomplete="off">
                                <button id="vecthare_search_btn" class="vecthare-btn vecthare-btn-primary">
                                    ${icons.search(16)} Search
                                </button>
                            </div>

                            <!-- Search Options -->
                            <div class="vecthare-search-options">
                                <div class="vecthare-search-option">
                                    <label>Results per collection:</label>
                                    <input type="number" id="vecthare_search_topk" value="5" min="1" max="50">
                                </div>
                                <div class="vecthare-search-option">
                                    <label>Min score:</label>
                                    <input type="number" id="vecthare_search_threshold" value="0.3" min="0" max="1" step="0.05">
                                </div>
                                <div class="vecthare-search-option">
                                    <label>
                                        <input type="checkbox" id="vecthare_search_enabled_only" checked>
                                        Enabled collections only
                                    </label>
                                </div>
                            </div>

                            <!-- Keyword Filter -->
                            <div class="vecthare-keyword-filter-section">
                                <div class="vecthare-keyword-filter-header">
                                    ${icons.filter(16)} <span>Keyword Filter</span>
                                    <button id="vecthare_scan_keywords" class="vecthare-btn-sm" title="Scan all collections for keywords">
                                        <i class="fa-solid fa-sync"></i> Scan
                                    </button>
                                </div>
                                <div class="vecthare-keyword-filter-input-row">
                                    <input type="text"
                                           id="vecthare_keyword_filter"
                                           class="vecthare-keyword-filter-input"
                                           placeholder="Filter by keywords (comma-separated)..."
                                           autocomplete="off">
                                    <button id="vecthare_clear_keyword_filter" class="vecthare-btn-sm" title="Clear filter">
                                        ${icons.x(14)}
                                    </button>
                                </div>
                                <div id="vecthare_keyword_tags" class="vecthare-keyword-tags">
                                    <span class="vecthare-keyword-hint">Click "Scan" to discover keywords in your collections</span>
                                </div>
                            </div>

                            <!-- Search Results -->
                            <div id="vecthare_search_results" class="vecthare-search-results">
                                <div class="vecthare-search-empty">
                                    ${icons.search(48)}
                                    <p>Enter a query to search across all collections</p>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- Bulk Operations Tab -->
                    <div id="vecthare_tab_bulk" class="vecthare-tab-content">
                        <div class="vecthare-bulk-panel">
                            <!-- Selection Info -->
                            <div class="vecthare-bulk-header">
                                <div class="vecthare-bulk-select-all">
                                    <label>
                                        <input type="checkbox" id="vecthare_bulk_select_all">
                                        Select All Visible
                                    </label>
                                    <span id="vecthare_bulk_count">0 selected</span>
                                </div>
                                <div class="vecthare-bulk-filter">
                                    <select id="vecthare_bulk_filter">
                                        <option value="all">All Collections</option>
                                        <option value="enabled">Enabled Only</option>
                                        <option value="disabled">Disabled Only</option>
                                    </select>
                                </div>
                            </div>

                            <!-- Bulk Actions -->
                            <div class="vecthare-bulk-actions">
                                <button id="vecthare_bulk_enable" class="vecthare-btn vecthare-btn-sm" disabled>
                                    ${icons.toggleRight(16)} Enable Selected
                                </button>
                                <button id="vecthare_bulk_disable" class="vecthare-btn vecthare-btn-sm" disabled>
                                    ${icons.toggleLeft(16)} Disable Selected
                                </button>
                                <button id="vecthare_bulk_export" class="vecthare-btn vecthare-btn-sm" disabled>
                                    ${icons.download(16)} Export Selected
                                </button>
                                <button id="vecthare_bulk_delete" class="vecthare-btn vecthare-btn-sm vecthare-btn-danger" disabled>
                                    ${icons.trash(16)} Delete Selected
                                </button>
                            </div>

                            <!-- Collection List with Checkboxes -->
                            <div id="vecthare_bulk_list" class="vecthare-bulk-list">
                                <div class="vecthare-loading">Loading collections...</div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;

  $("body").append(modalHtml);

  // Bind events
  bindBrowserEvents();
}

/**
 * Binds event handlers for browser UI
 */
function bindBrowserEvents() {
  // Close button
  $("#vecthare_browser_close").on("click", function (e) {
    e.stopPropagation();
    e.preventDefault();
    closeDatabaseBrowser();
  });

  // Stop propagation on mousedown (ST listens on mousedown to close drawers)
  // This prevents the drawer from closing when clicking inside the modal
  $("#vecthare_database_browser_modal").on("mousedown touchstart", function (e) {
    e.stopPropagation();
  });

  // Close when clicking directly on the modal background (overlay)
  $("#vecthare_database_browser_modal").on("click", function (e) {
    if (e.target === this) {
      e.preventDefault();
      closeDatabaseBrowser();
    }
  });

  // Tab switching
  $("#vecthare_database_browser_modal .vecthare-tab-btn").on("click", function (e) {
    e.stopPropagation();
    e.preventDefault();
    const tab = $(this).data("tab");
    switchTab(tab);
  });

  // Scope filters
  $("#vecthare_database_browser_modal .vecthare-scope-filter").on("click", function (e) {
    e.stopPropagation();
    e.preventDefault();
    $("#vecthare_database_browser_modal .vecthare-scope-filter").removeClass("active");
    $(this).addClass("active");
    browserState.filters.scope = $(this).data("scope");
    renderCollections();
  });

  // Type filters
  $('#vecthare_database_browser_modal input[name="vecthare_type_filter"]').on("change", function (e) {
    e.stopPropagation();
    browserState.filters.collectionType = $(this).val();
    renderCollections();
  });

  // Search input
  $("#vecthare_collection_search").on("input", function (e) {
    e.stopPropagation();
    browserState.filters.searchQuery = $(this).val().toLowerCase();
    renderCollections();
  });

  // Resync button - clears registry and rescans from disk
  $("#vecthare_reset_registry").on("click", async function (e) {
    e.stopPropagation();
    e.preventDefault();

    const confirmed = confirm(
      "This will clear the collection registry and rescan from disk.\n\n" +
        "Any ghost entries (collections that no longer exist on disk) will be removed.\n\n" +
        "Continue?",
    );

    if (!confirmed) return;

    try {
      // Clear the registry
      clearCollectionRegistry();

      // Refresh collections (will rediscover from disk)
      await refreshCollections();

      toastr.success("Registry cleared and resynced from disk", "VectHarePlus");
    } catch (error) {
      console.error("VectHare: Failed to resync", error);
      toastr.error(`Failed to resync: ${error.message}`, "VectHarePlus");
    }
  });

  // Keyboard shortcuts
  $(document).on("keydown.vecthare_browser", function (e) {
    if (!browserState.isOpen) return;

    if (e.key === "Escape") {
      closeDatabaseBrowser();
    }
  });

  // Import button
  $("#vecthare_import_collection").on("click", function (e) {
    e.stopPropagation();
    $("#vecthare_import_file").click();
  });

  // Import file handler (supports JSON and PNG)
  $("#vecthare_import_file").on("change", async function (e) {
    const file = e.target.files[0];
    if (!file) return;

    // Reset input so same file can be selected again
    $(this).val("");

    try {
      toastr.info("Reading import file...", "VectHarePlus");

      let data;

      // Check if it's a PNG file
      if (
        file.type === "image/png" ||
        file.name.toLowerCase().endsWith(".png")
      ) {
        const pngData = await readPNGFile(file);
        data = await extractDataFromPNG(pngData);

        if (!data) {
          toastr.error(
            "This PNG does not contain VectHare data.",
            "VectHare Import",
          );
          return;
        }

        toastr.info("Found VectHare data in PNG!", "VectHarePlus");
      } else {
        // JSON file
        data = await readImportFile(file);
      }

      const info = getExportInfo(data);
      const validation = validateImportData(data, browserState.settings);

      // Show import confirmation dialog
      let message = `Import "${info.collections[0]?.name || "collection"}"?\n\n`;
      message += `• ${info.totalChunks} chunks\n`;
      message += `• ${info.totalChunksWithVectors} with vectors\n`;

      if (info.embedding) {
        message += `\nEmbedding: ${info.embedding.source}/${info.embedding.model || "default"}\n`;
        message += `Dimension: ${info.embedding.dimension || "unknown"}\n`;
      }

      if (validation.warnings.length > 0) {
        message += `\n⚠️ Warnings:\n`;
        validation.warnings.forEach((w) => {
          message += `• ${w}\n`;
        });
      }

      if (!validation.compatible && info.totalChunksWithVectors > 0) {
        message += `\n⚠️ Your embedding settings don't match.\n`;
        message += `To use existing vectors, change your settings to:\n`;
        message += `  Source: ${info.embedding?.source || "unknown"}\n`;
        message += `  Model: ${info.embedding?.model || "default"}\n`;
        message += `\nOr continue to re-embed with current settings.`;
      }

      if (!validation.valid) {
        toastr.error(
          `Invalid export file:\n${validation.errors.join("\n")}`,
          "VectHare Import",
        );
        return;
      }

      const confirmed = confirm(message);
      if (!confirmed) return;

      // Perform import
      const result = await importCollection(data, browserState.settings, {
        overwrite: true, // Overwrite if exists
      });

      if (result.success) {
        const vectorMsg = result.usedVectors
          ? "(used existing vectors)"
          : "(re-embedded)";
        toastr.success(
          `Imported ${result.chunkCount} chunks ${vectorMsg}`,
          "VectHare Import",
        );

        // Refresh collections list
        await refreshCollections();
      }
    } catch (error) {
      console.error("VectHare: Import failed", error);
      toastr.error(`Import failed: ${error.message}`, "VectHarePlus");
    }
  });
}


/**
 * Switches active tab
 * @param {string} tabName Tab identifier
 */
function switchTab(tabName) {
  $("#vecthare_database_browser_modal .vecthare-tab-btn").removeClass("active");
  $(`#vecthare_database_browser_modal .vecthare-tab-btn[data-tab="${tabName}"]`).addClass("active");

  $("#vecthare_database_browser_modal .vecthare-tab-content").removeClass("active");
  $(`#vecthare_tab_${tabName}`).addClass("active");

  // Initialize tab-specific content
  if (tabName === "bulk") {
    renderBulkList();
    bindBulkEvents();
  } else if (tabName === "search") {
    bindSearchEvents();
  }
}

/**
 * Refreshes collections from storage
 */
async function refreshCollections() {
  try {
    browserState.collections = await loadAllCollections(browserState.settings);

    // Clean up orphaned metadata entries (collections that no longer exist)
    const actualIds = browserState.collections.map((c) => c.id);
    const cleanupResult = cleanupOrphanedMeta(actualIds);
    if (cleanupResult.removed > 0) {
      console.log(
        `VectHare: Cleaned up ${cleanupResult.removed} orphaned metadata entries`,
      );
    }

    renderCollections();
  } catch (error) {
    console.error("VectHare: Failed to load collections", error);
    $("#vecthare_collections_list").html(`
            <div class="vecthare-error">
                Failed to load collections. Check console for details.
            </div>
        `);
  }
}

/**
 * Renders collections list based on current filters
 */
function renderCollections() {
  const container = $("#vecthare_collections_list");

    // Apply filters
    let filtered = browserState.collections.filter(c => {
        const scopeFilter = browserState.filters.scope;

        // Scope filter:
        // - 'all' => no filter
        // - 'global' => show collections explicitly set to alwaysActive
        // - 'chat' => show collections locked to at least one chat
        // - 'character' => show collections locked to at least one character
        // - otherwise: preserve legacy behavior (compare c.scope)
        if (scopeFilter !== 'all') {
            if (scopeFilter === 'global') {
                const meta = getCollectionMeta(c.id);
                if (!meta || meta.alwaysActive !== true) return false;
            } else if (scopeFilter === 'chat') {
                if (getCollectionLockCount(c.id) <= 0) return false;
            } else if (scopeFilter === 'character') {
                if (getCollectionCharacterLockCount(c.id) <= 0) return false;
            } else {
                if (c.scope !== scopeFilter) return false;
            }
        }

    // Type filter - map filter categories to actual collection types
    if (browserState.filters.collectionType !== "all") {
      const typeMap = {
        chat: ["chat"],
        lorebook: ["lorebook"],
        character: ["character", "persona"],
        document: ["file", "doc", "paste", "select", "current"],
        web: ["url", "wiki", "youtube"],
      };
      const allowedTypes = typeMap[browserState.filters.collectionType];
      if (allowedTypes && !allowedTypes.includes(c.type)) {
        return false;
      }
    }

    // Search filter
    if (browserState.filters.searchQuery) {
      const searchLower = browserState.filters.searchQuery;
      return (
        c.name.toLowerCase().includes(searchLower) ||
        c.id.toLowerCase().includes(searchLower)
      );
    }

    return true;
  });

  if (filtered.length === 0) {
    container.html(`
            <div class="vecthare-empty-state">
                <p>No collections found.</p>
                <small>Vectorize some chat messages to create collections!</small>
            </div>
        `);
    updateStats(0, 0);
    return;
  }

  // Render collection cards
  const cardsHtml = filtered.map((c) => renderCollectionCard(c)).join("");
  container.html(cardsHtml);

  // Bind card events
  bindCollectionCardEvents();

  // Update stats
  const totalChunks = filtered.reduce((sum, c) => sum + c.chunkCount, 0);
  updateStats(filtered.length, totalChunks);
}

/**
 * Renders a single collection card (V1-inspired layout)
 * @param {object} collection Collection data
 * @returns {string} Card HTML
 */
function renderCollectionCard(collection) {
  // Map collection types to icon functions
  const typeIconMap = {
    chat: icons.messageSquare,
    file: icons.fileText,
    doc: icons.fileText,
    paste: icons.fileText,
    select: icons.fileText,
    current: icons.fileText,
    lorebook: icons.bookOpen,
    character: icons.user,
    persona: icons.user,
    url: icons.globe,
    wiki: icons.globe,
    youtube: icons.globe,
  };
  const iconFn = typeIconMap[collection.type] || icons.box;
  const typeIcon = iconFn(14, "vecthare-type-icon");

  const scopeBadge =
    {
      global:
        '<span class="vecthare-badge vecthare-badge-global">Global</span>',
      character:
        '<span class="vecthare-badge vecthare-badge-character">Character</span>',
      chat: '<span class="vecthare-badge vecthare-badge-chat">Chat</span>',
    }[collection.scope] || "";

  const statusBadge = collection.enabled
    ? '<span class="vecthare-badge vecthare-badge-success">Active</span>'
    : '<span class="vecthare-badge vecthare-badge-muted">Paused</span>';

  // Activation badge (shows triggers or conditions)
  const activationSummary = getCollectionActivationSummary(collection.id);
  let activationBadge = "";
  if (activationSummary.alwaysActive) {
    activationBadge =
      '<span class="vecthare-badge vecthare-badge-always" title="Always active">∞ Always</span>';
  } else if (activationSummary.triggerCount > 0) {
    activationBadge = `<span class="vecthare-badge vecthare-badge-triggers" title="${activationSummary.triggerCount} trigger(s)">🎯 ${activationSummary.triggerCount}</span>`;
  } else if (activationSummary.conditionsEnabled) {
    activationBadge = `<span class="vecthare-badge vecthare-badge-conditions" title="${activationSummary.conditionCount} condition(s)">⚡ ${activationSummary.conditionCount}</span>`;
  }

  // Backend badge - shows vector database (Standard, LanceDB, Qdrant)
  const backendDisplayName =
    {
      standard: "Standard",
      lancedb: "LanceDB",
      qdrant: "Qdrant",
    }[collection.backend] || collection.backend;

  const backendBadge = collection.backend
    ? `<span class="vecthare-badge vecthare-badge-backend" title="Vector backend">${backendDisplayName}</span>`
    : "";

  // Source badge - shows embedding source (transformers, palm, openai, etc.)
  const sourceBadge =
    collection.source && collection.source !== "unknown"
      ? `<span class="vecthare-badge vecthare-badge-source" title="Embedding source">${collection.source}</span>`
      : "";

  // Model info - show current model and count if multiple
  const hasMultipleModels = collection.models && collection.models.length > 1;
  const currentModelName = collection.model || "(default)";
  const modelBadge = hasMultipleModels
    ? `<span class="vecthare-badge vecthare-badge-model" title="Current model: ${currentModelName} (${collection.models.length} available)">📐 ${currentModelName}</span>`
    : "";

  // Temporal decay badge
  const decaySummary = getCollectionDecaySummary(collection.id);
  let decayBadge = "";
  if (decaySummary.enabled) {
    const decayIcon = decaySummary.isCustom ? "⏳" : "⏱️";
    const decayTitle = decaySummary.isCustom
      ? `Custom decay: ${decaySummary.description}`
      : `Default decay: ${decaySummary.description}`;
    decayBadge = `<span class="vecthare-badge vecthare-badge-decay ${decaySummary.isCustom ? "vecthare-badge-decay-custom" : ""}" title="${decayTitle}">${decayIcon}</span>`;
  }

  // Lock badge - shows if collection is locked and to how many chats
  const lockCount = getCollectionLockCount(collection.id);
  let lockBadge = "";
  if (lockCount > 0) {
    const lockTitle = `Locked to ${lockCount} chat${lockCount !== 1 ? "s" : ""}`;
    lockBadge = `<span class="vecthare-badge vecthare-badge-lock" title="${lockTitle}">🔒 ${lockCount}</span>`;
  }

  // Use registryKey for unique identification (source:id format)
  const uniqueKey = collection.registryKey || collection.id;

  return `
        <div class="vecthare-collection-card" data-collection-key="${uniqueKey}" data-status="${collection.enabled ? "active" : "paused"}">
            <div class="vecthare-collection-header">
                <span class="vecthare-collection-title">
                    ${typeIcon} ${collection.name}
                </span>
                <div class="vecthare-collection-badges">
                    ${scopeBadge}
                    ${backendBadge}
                    ${sourceBadge}
                    ${modelBadge}
                    ${decayBadge}
                    ${lockBadge}
                    ${statusBadge}
                </div>
            </div>

            <div class="vecthare-collection-meta">
                <span>${collection.chunkCount} chunks</span>
                <span>ID: ${collection.id}</span>
            </div>

            <div class="vecthare-collection-actions">
                <button class="vecthare-btn-sm vecthare-action-toggle"
                        data-collection-key="${uniqueKey}"
                        data-enabled="${collection.enabled}">
                    ${collection.enabled ? icons.pause(16) + " Pause" : icons.play(16) + " Enable"}
                </button>
                <button class="vecthare-btn-sm vecthare-action-rename"
                        data-collection-key="${uniqueKey}"
                        data-current-name="${collection.name.replace(/"/g, "&quot;")}"
                        title="Rename this collection">
                    ${icons.pencil(16)} Rename
                </button>
                <button class="vecthare-btn-sm vecthare-action-activation ${activationSummary.mode !== "auto" || decaySummary.isCustom ? "vecthare-has-settings" : ""}"
                        data-collection-key="${uniqueKey}"
                        title="Configure activation, triggers, conditions, and temporal decay">
                    ${icons.settings(16)} Settings
                </button>
                ${
                  hasMultipleModels
                    ? `
                <button class="vecthare-btn-sm vecthare-action-switch-model"
                        data-collection-key="${uniqueKey}"
                        title="Switch embedding model (${collection.models.length} available)">
                    <i class="fa-solid fa-code-branch"></i> Model
                </button>
                `
                    : ""
                }
                <button class="vecthare-btn-sm vecthare-action-open-folder"
                        data-collection-key="${uniqueKey}"
                        data-backend="${collection.backend}"
                        data-source="${collection.source || "transformers"}"
                        title="Open in file explorer">
                    ${icons.folderOpen(16)} Open Folder
                </button>
                <button class="vecthare-btn-sm vecthare-action-visualize"
                        data-collection-key="${uniqueKey}"
                        data-backend="${collection.backend}"
                        data-source="${collection.source || "transformers"}"
                        title="View and edit chunks in this collection">
                    ${icons.eye(16)} View Chunks
                </button>
                <div class="vecthare-export-dropdown">
                    <button class="vecthare-btn-sm vecthare-btn-export vecthare-action-export-toggle"
                            title="Export collection">
                        ${icons.download(16)} Export
                    </button>
                    <div class="vecthare-export-options">
                        <button class="vecthare-btn-sm vecthare-btn-json vecthare-action-export"
                                data-collection-key="${uniqueKey}"
                                data-collection-id="${collection.id}"
                                data-backend="${collection.backend}"
                                data-source="${collection.source || "transformers"}"
                                data-model="${collection.model || ""}"
                                title="Export as JSON (includes vectors)">
                            ${icons.fileExport(16)} JSON
                        </button>
                        <button class="vecthare-btn-sm vecthare-btn-png vecthare-action-export-png"
                                data-collection-key="${uniqueKey}"
                                data-collection-id="${collection.id}"
                                data-backend="${collection.backend}"
                                data-source="${collection.source || "transformers"}"
                                data-model="${collection.model || ""}"
                                title="Export as PNG (shareable image)">
                            ${icons.image(16)} PNG
                        </button>
                    </div>
                </div>
                <button class="vecthare-btn-sm vecthare-btn-danger vecthare-action-delete"
                        data-collection-key="${uniqueKey}">
                    ${icons.trash(16)} Delete
                </button>
            </div>
        </div>
    `;
}

/**
 * Helper to find collection by its unique key (registryKey or id)
 */
function findCollectionByKey(key) {
  return browserState.collections.find((c) => (c.registryKey || c.id) === key);
}

/**
 * Performs PNG export with optional custom image
 * @param {File|null} imageFile - Custom image file or null for default
 */
async function performPngExport(imageFile) {
  const pending = browserState.pendingPngExport;
  if (!pending) {
    toastr.error("No export pending", "VectHarePlus");
    return;
  }

  browserState.pendingPngExport = null;

  try {
    toastr.info("Preparing PNG export...", "VectHarePlus");

    // Get export data
    const exportData = await exportCollection(
      pending.collectionId,
      browserState.settings,
      {
        backend: pending.backend,
        source: pending.source,
        model: pending.model,
      },
    );

    // Convert custom image to PNG if provided
    let pngData = null;
    if (imageFile) {
      toastr.info("Converting image...", "VectHarePlus");
      pngData = await convertToPNG(imageFile);
    }

    // Embed data in PNG
    toastr.info("Embedding data in PNG...", "VectHarePlus");
    const pngWithData = await embedDataInPNG(exportData, pngData);

    // Download
    const filename = `${pending.collection.name || pending.collectionId}.vecthare`;
    downloadPNG(pngWithData, filename);

    // Show compression stats
    const jsonSize = JSON.stringify(exportData).length;
    const pngSize = pngWithData.length;
    const ratio = Math.round((pngSize / jsonSize) * 100);

    toastr.success(
      `PNG export complete!\n${exportData.stats.chunkCount} chunks\n` +
        `Original: ${formatBytes(jsonSize)}\n` +
        `PNG: ${formatBytes(pngSize)} (${ratio}%)`,
      "VectHare Export",
    );
  } catch (error) {
    console.error("VectHare: PNG export failed", error);
    toastr.error(`PNG export failed: ${error.message}`, "VectHarePlus");
  }
}

/**
 * Formats bytes to human readable string
 * @param {number} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

/**
 * Escapes HTML special characters to prevent XSS
 * @param {string} text Text to escape
 * @returns {string} Escaped text
 */
function escapeHtml(text) {
  if (!text) return "";
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Binds events for collection card actions
 */
function bindCollectionCardEvents() {
  // Toggle enabled/disabled
  $(".vecthare-action-toggle")
    .off("click")
    .on("click", async function (e) {
      e.stopPropagation();
      const collectionKey = $(this).data("collection-key");
      const currentEnabled = $(this).data("enabled");
      const newEnabled = !currentEnabled;

      setCollectionEnabled(collectionKey, newEnabled);

      // Update UI
      const collection = findCollectionByKey(collectionKey);
      if (collection) {
        collection.enabled = newEnabled;
      }

      renderCollections();

      toastr.success(
        `Collection ${newEnabled ? "enabled" : "paused"}`,
        "VectHarePlus",
      );
    });

  // Delete collection - uses unified deleteCollection() to handle all 3 stores
  $(".vecthare-action-delete")
    .off("click")
    .on("click", async function (e) {
      e.stopPropagation();
      const collectionKey = $(this).data("collection-key");
      const collection = findCollectionByKey(collectionKey);

      if (!collection) return;

      const confirmed = confirm(
        `Delete collection "${collection.name}"?\n\n` +
          `This will remove ${collection.chunkCount} chunks from the vector index.\n` +
          `This action cannot be undone.`,
      );

      if (!confirmed) return;

      try {
        // Use unified delete function - handles vectors, registry, AND metadata
        const collectionSettings = {
          ...browserState.settings,
          vector_backend: collection.backend,
          source: collection.source,
        };

        const result = await deleteCollection(
          collection.id,
          collectionSettings,
          collection.registryKey,
        );

        // Remove from state
        browserState.collections = browserState.collections.filter(
          (c) => (c.registryKey || c.id) !== collectionKey,
        );

        // Re-render
        renderCollections();

        if (result.success) {
          toastr.success(`Deleted collection "${collection.name}"`, "VectHarePlus");
        } else {
          toastr.warning(
            `Partial deletion: ${result.errors.join(", ")}`,
            "VectHarePlus",
          );
        }
      } catch (error) {
        console.error("VectHare: Failed to delete collection", error);
        toastr.error(`Failed to delete collection: ${error.message}`, "VectHarePlus");
      }
    });

  // Open folder
  $(".vecthare-action-open-folder")
    .off("click")
    .on("click", async function (e) {
      e.stopPropagation();
      const collectionKey = $(this).data("collection-key");
      const collection = findCollectionByKey(collectionKey);

      if (!collection) return;

      try {
        const response = await fetch("/api/plugins/similharity/open-folder", {
          method: "POST",
          headers: getRequestHeaders(),
          body: JSON.stringify({
            collectionId: collection.id,
            backend: collection.backend,
            source: collection.source,
          }),
        });

        if (!response.ok) {
          throw new Error(`Failed to open folder: ${response.statusText}`);
        }

        toastr.success("Opened collection folder", "VectHarePlus");
      } catch (error) {
        console.error("VectHare: Failed to open folder", error);
        toastr.error(`Failed to open folder: ${error.message}`, "VectHarePlus");
      }
    });

  // Visualize chunks
  $(".vecthare-action-visualize")
    .off("click")
    .on("click", async function (e) {
      console.log("test");
      e.stopPropagation();
      const collectionKey = $(this).data("collection-key");
      const collection = findCollectionByKey(collectionKey);

      if (!collection) return;

      try {
        toastr.info("Loading chunks...", "VectHarePlus");

        // Use the collection's actual backend, not the global setting
        // This ensures we query Standard collections with Standard backend, etc.
        if (!collection.backend) {
          toastr.error(
            "Collection has no backend defined - this is a bug",
            "VectHarePlus",
          );
          console.error("VectHare: Collection missing backend:", collection);
          return;
        }

        const collectionSettings = {
          ...browserState.settings,
          vector_backend: collection.backend,
        };

        // Use unified plugin endpoint
        const requestBody = {
          backend: collection.backend || "vectra",
          collectionId: collection.id,
          source: collection.source || "transformers",
          model: collection.model || "",
          limit: 1000, // Get first 1000 chunks
        };

        console.log("VectHare DB Browser: Requesting chunks with:", requestBody);

        const response = await fetch("/api/plugins/similharity/chunks/list", {
          method: "POST",
          headers: getRequestHeaders(),
          body: JSON.stringify(requestBody),
        });

        if (!response.ok) {
          throw new Error(`Failed to list chunks: ${response.statusText}`);
        }

        const data = await response.json();
        // Support all plugin response shapes: items (new), chunks/results (older/backends)
        const results = data.items || data.chunks || data.results || [];

        if (!results || results.length === 0) {
          toastr.warning("No chunks found in this collection", "VectHarePlus");
          return;
        }

        // Format chunks for visualizer
        const chunks = results.map((item, idx) => ({
          hash: item.hash,
          index: item.index ?? idx,
          text: item.text || item.metadata?.text || "No text available",
          score: 1.0,
          similarity: 1.0,
          messageAge: item.metadata?.messageAge,
          decayApplied: false,
          decayMultiplier: 1.0,
          metadata: item.metadata, // Pass through all metadata including keywords
        }));

        // Pass collection-specific settings so visualizer uses correct backend for edits/deletes
        // Include collection type so visualizer knows if this is a chat (for Scenes tab)
        openVisualizer(
          { chunks, collectionType: collection.type },
          collection.id,
          collectionSettings,
        );
      } catch (error) {
        console.error("VectHare: Failed to load chunks", error);
        toastr.error(`Failed to load chunks: ${error.message}`, "VectHarePlus");
      }
    });

  // Export toggle - show/hide export options
  $(".vecthare-action-export-toggle")
    .off("click")
    .on("click", function (e) {
      e.stopPropagation();
      const $dropdown = $(this).closest(".vecthare-export-dropdown");
      const isExpanded = $dropdown.hasClass("expanded");

      // Close any other open dropdowns
      $(".vecthare-export-dropdown.expanded")
        .not($dropdown)
        .removeClass("expanded");

      // Toggle this one
      $dropdown.toggleClass("expanded", !isExpanded);
    });

  // Close export dropdown when clicking elsewhere
  $(document)
    .off("click.vecthare-export")
    .on("click.vecthare-export", function (e) {
      if (!$(e.target).closest(".vecthare-export-dropdown").length) {
        $(".vecthare-export-dropdown.expanded").removeClass("expanded");
      }
    });

  // Export collection (JSON)
  $(".vecthare-action-export")
    .off("click")
    .on("click", async function (e) {
      e.stopPropagation();
      const collectionKey = $(this).data("collection-key");
      const collectionId = $(this).data("collection-id");
      const backend = $(this).data("backend");
      const source = $(this).data("source");
      const model = $(this).data("model");

      const collection = findCollectionByKey(collectionKey);
      if (!collection) return;

      try {
        toastr.info("Exporting collection...", "VectHarePlus");

        const exportData = await exportCollection(
          collectionId,
          browserState.settings,
          {
            backend,
            source,
            model,
          },
        );

        downloadExport(exportData, collection.name || collectionId);

        toastr.success(
          `Exported ${exportData.stats.chunkCount} chunks (${exportData.stats.chunksWithVectors} with vectors)`,
          "VectHare Export",
        );
      } catch (error) {
        console.error("VectHare: Export failed", error);
        toastr.error(`Export failed: ${error.message}`, "VectHarePlus");
      }
    });

  // Export collection (PNG)
  $(".vecthare-action-export-png")
    .off("click")
    .on("click", async function (e) {
      e.stopPropagation();
      const collectionKey = $(this).data("collection-key");
      const collectionId = $(this).data("collection-id");
      const backend = $(this).data("backend");
      const source = $(this).data("source");
      const model = $(this).data("model");

      const collection = findCollectionByKey(collectionKey);
      if (!collection) return;

      // Store export context for image picker callback
      browserState.pendingPngExport = {
        collectionKey,
        collectionId,
        backend,
        source,
        model,
        collection,
      };

      // Ask if they want to use a custom image
      const useCustomImage = confirm(
        "Export as PNG\n\n" +
          "Would you like to use a custom image?\n\n" +
          "• Click OK to choose an image file\n" +
          "• Click Cancel to use default VectHare image",
      );

      if (useCustomImage) {
        $("#vecthare_png_image_picker").click();
      } else {
        // Export with default image
        await performPngExport(null);
      }
    });

  // PNG image picker handler
  $("#vecthare_png_image_picker")
    .off("change")
    .on("change", async function (e) {
      const file = e.target.files[0];
      $(this).val(""); // Reset for next use

      if (!file) {
        browserState.pendingPngExport = null;
        return;
      }

      await performPngExport(file);
    });

  // Activation editor (triggers + conditions)
  $(".vecthare-action-activation")
    .off("click")
    .on("click", function (e) {
      e.stopPropagation();
      const collectionKey = $(this).data("collection-key");
      const collection = findCollectionByKey(collectionKey);
      if (collection) {
        openActivationEditor(collection.id, collection.name);
      }
    });

  // Rename collection
  $(".vecthare-action-rename")
    .off("click")
    .on("click", function (e) {
      e.stopPropagation();
      const collectionKey = $(this).data("collection-key");
      const collection = findCollectionByKey(collectionKey);
      if (collection) {
        openRenameDialog(collection.id, collection.name);
      }
    });

  // Switch model (for collections with multiple embedding models)
  $(".vecthare-action-switch-model")
    .off("click")
    .on("click", async function (e) {
      e.stopPropagation();
      const collectionKey = $(this).data("collection-key");
      const collection = findCollectionByKey(collectionKey);

      if (!collection || !collection.models || collection.models.length < 2) {
        return;
      }

      openModelSwitcher(collection);
    });
}

/**
 * Updates stats footer
 * @param {number} collectionCount Number of collections shown
 * @param {number} chunkCount Total chunks
 */
function updateStats(collectionCount, chunkCount) {
  const statsText =
    collectionCount === 0
      ? "No collections"
      : `${collectionCount} collection${collectionCount === 1 ? "" : "s"}, ${chunkCount} total chunks`;

  $("#vecthare_browser_stats_text").text(statsText);
}

// ============================================================================
// RENAME DIALOG
// ============================================================================

/**
 * Opens a rename dialog for a collection
 * @param {string} collectionId Collection ID
 * @param {string} currentName Current display name
 */
function openRenameDialog(collectionId, currentName) {
  // Create modal if needed
  if ($("#vecthare_rename_modal").length === 0) {
    const modalHtml = `
            <div id="vecthare_rename_modal" class="vecthare-modal">
                <div class="vecthare-modal-content vecthare-rename-dialog popup">
                    <div class="vecthare-modal-header">
                        <h3>✏️ Rename Collection</h3>
                        <button class="vecthare-btn-icon" id="vecthare_rename_close">✕</button>
                    </div>
                    <div class="vecthare-rename-body">
                        <label for="vecthare_rename_input">New name:</label>
                        <input type="text" id="vecthare_rename_input" placeholder="Enter new name..." autocomplete="off">
                        <small class="vecthare-rename-hint">Leave empty to reset to auto-generated name</small>
                    </div>
                    <div class="vecthare-modal-footer">
                        <button class="vecthare-btn" id="vecthare_rename_cancel">Cancel</button>
                        <button class="vecthare-btn vecthare-btn-primary" id="vecthare_rename_save">Save</button>
                    </div>
                </div>
            </div>
        `;
    $("body").append(modalHtml);

    // Bind events
    $("#vecthare_rename_close, #vecthare_rename_cancel").on(
      "click",
      closeRenameDialog,
    );
    // Stop mousedown propagation (ST closes drawers on mousedown/touchstart)
    $("#vecthare_rename_modal").on("mousedown touchstart", function (e) {
      e.stopPropagation();
    });
    // Close on background click
    $("#vecthare_rename_modal").on("click", function (e) {
      if (e.target === this) closeRenameDialog();
    });
    $("#vecthare_rename_input").on("keydown", function (e) {
      if (e.key === "Enter") {
        e.preventDefault();
        $("#vecthare_rename_save").click();
      } else if (e.key === "Escape") {
        closeRenameDialog();
      }
    });
  }

  // Store collection ID for save handler
  $("#vecthare_rename_modal").data("collection-id", collectionId);

  // Set current name
  $("#vecthare_rename_input").val(currentName);

  // Bind save handler (rebind each time to get fresh collectionId)
  $("#vecthare_rename_save")
    .off("click")
    .on("click", function () {
      const newName = $("#vecthare_rename_input").val().trim();
      const id = $("#vecthare_rename_modal").data("collection-id");

      // Save the new name (or null to reset)
      setCollectionMeta(id, { displayName: newName || null });

      // Update local state
      const collection = browserState.collections.find((c) => c.id === id);
      if (collection) {
        collection.name = newName || collection.name; // Will refresh properly on next load
      }

      closeRenameDialog();
      refreshCollections(); // Reload to get updated names

      if (newName) {
        toastr.success(`Renamed to "${newName}"`, "VectHarePlus");
      } else {
        toastr.success("Reset to auto-generated name", "VectHarePlus");
      }
    });

  // Show modal and focus input
  $("#vecthare_rename_modal").fadeIn(200, function () {
    $("#vecthare_rename_input").focus().select();
  });
}

/**
 * Closes the rename dialog
 */
function closeRenameDialog() {
  $("#vecthare_rename_modal").fadeOut(200);
}

// ============================================================================
// MODEL SWITCHER
// ============================================================================

/**
 * Opens the model switcher modal
 * @param {object} collection Collection object with models array
 */
function openModelSwitcher(collection) {
  // Create modal if it doesn't exist
  if ($("#vecthare_model_switcher_modal").length === 0) {
    const modalHtml = `
            <div id="vecthare_model_switcher_modal" class="vecthare-modal">
                <div class="vecthare-modal-content vecthare-model-switcher-content popup">
                    <div class="vecthare-modal-header">
                        <h3><i class="fa-solid fa-code-branch"></i> Switch Embedding Model</h3>
                        <button class="vecthare-btn-icon" id="vecthare_model_switcher_close">✕</button>
                    </div>
                    <div class="vecthare-modal-body">
                        <p class="vecthare-model-switcher-desc">
                            Select which embedding model to use for this collection.
                            Each model may have different vectors from different embedding providers.
                        </p>
                        <div id="vecthare_model_list" class="vecthare-model-list"></div>
                    </div>
                </div>
            </div>
        `;
    $("body").append(modalHtml);

    // Bind close
    $("#vecthare_model_switcher_close").on("click", closeModelSwitcher);
    // Stop mousedown propagation (ST closes drawers on mousedown/touchstart)
    $("#vecthare_model_switcher_modal").on("mousedown touchstart", function (e) {
      e.stopPropagation();
    });
    // Close on background click
    $("#vecthare_model_switcher_modal").on("click", function (e) {
      if (e.target === this) closeModelSwitcher();
    });
  }

  // Store collection reference
  $("#vecthare_model_switcher_modal").data("collection", collection);

  // Build model list
  const modelListHtml = collection.models
    .map((model) => {
      const isActive = model.path === collection.model;
      const modelName = model.name || "(default)";
      const chunkLabel = model.chunkCount === 1 ? "chunk" : "chunks";

      return `
            <div class="vecthare-model-item ${isActive ? "vecthare-model-active" : ""}"
                 data-model-path="${model.path}">
                <div class="vecthare-model-item-info">
                    <span class="vecthare-model-name">
                        ${isActive ? '<i class="fa-solid fa-check"></i>' : '<i class="fa-solid fa-cube"></i>'}
                        ${modelName}
                    </span>
                    <span class="vecthare-model-chunks">${model.chunkCount} ${chunkLabel}</span>
                </div>
                ${
                  isActive
                    ? '<span class="vecthare-model-badge-current">Current</span>'
                    : '<button class="vecthare-btn-sm vecthare-model-select-btn">Set as Primary</button>'
                }
            </div>
        `;
    })
    .join("");

  $("#vecthare_model_list").html(modelListHtml);

  // Bind selection
  $(".vecthare-model-select-btn")
    .off("click")
    .on("click", function (e) {
      e.stopPropagation();
      const modelPath = $(this)
        .closest(".vecthare-model-item")
        .data("model-path");
      const coll = $("#vecthare_model_switcher_modal").data("collection");

      // Update collection
      coll.model = modelPath;
      const modelInfo = coll.models.find((m) => m.path === modelPath);
      if (modelInfo) {
        coll.chunkCount = modelInfo.chunkCount;
      }

      // Persist
      setCollectionMeta(coll.registryKey || coll.id, {
        preferredModel: modelPath,
      });

      toastr.success(
        `Set primary model: ${modelPath || "(default)"}`,
        "VectHarePlus",
      );
      closeModelSwitcher();
      renderCollections();
    });

  // Show
  $("#vecthare_model_switcher_modal").fadeIn(200);
}

/**
 * Closes the model switcher modal
 */
function closeModelSwitcher() {
  $("#vecthare_model_switcher_modal").fadeOut(200);
}

// ============================================================================
// CONDITIONS EDITOR
// ============================================================================

// Collection-level condition types (11 types)
// Note: "keyword" renamed to "pattern" - triggers handle simple keywords,
// this is for advanced regex/pattern matching with custom scan depth
const CONDITION_TYPES = [
  {
    value: "pattern",
    label: "🔍 Pattern Match",
    desc: "Advanced regex/pattern in messages",
  },
  { value: "speaker", label: "🗣️ Speaker", desc: "Match by who spoke last" },
  {
    value: "characterPresent",
    label: "👥 Character Present",
    desc: "Check if character spoke recently",
  },
  {
    value: "messageCount",
    label: "#️⃣ Message Count",
    desc: "Conversation length check",
  },
  { value: "emotion", label: "😊 Emotion", desc: "Detect emotional tone" },
  { value: "isGroupChat", label: "👪 Group Chat", desc: "Group vs 1-on-1" },
  {
    value: "generationType",
    label: "⚙️ Gen Type",
    desc: "Normal, swipe, continue, etc.",
  },
  {
    value: "lorebookActive",
    label: "📖 Lorebook",
    desc: "Check if lorebook entry active",
  },
  {
    value: "swipeCount",
    label: "👆 Swipe Count",
    desc: "Swipes on last message",
  },
  {
    value: "timeOfDay",
    label: "🕐 Time of Day",
    desc: "Real-world time window",
  },
  {
    value: "randomChance",
    label: "🎲 Random",
    desc: "Probabilistic activation",
  },
];

// ============================================================================
// COLLECTION SETTINGS EDITOR (Activation + Triggers + Conditions + Decay)
// ============================================================================

let activationEditorState = {
  collectionId: null,
  collectionName: null,
  collectionType: "unknown",
  alwaysActive: false,
  triggers: [],
  triggerMatchMode: "any",
  triggerCaseSensitive: false,
  triggerScanDepth: 5,
  conditions: null,
  // Temporal Weighting (decay or nostalgia)
  temporalDecay: {
    enabled: false,
    type: "decay", // 'decay' or 'nostalgia'
    mode: "exponential",
    halfLife: 50,
    linearRate: 0.01,
    minRelevance: 0.3,
    maxBoost: 1.2,
    sceneAware: false,
  },
  // Injection settings (position/depth)
  position: null, // null = use global default
  depth: null, // null = use global default
};

/**
 * Opens the collection settings editor
 * @param {string} collectionId Collection ID
 * @param {string} collectionName Display name
 */
function openActivationEditor(collectionId, collectionName) {
  const meta = getCollectionMeta(collectionId);
  const triggerSettings = getCollectionTriggers(collectionId);
  const conditions = getCollectionConditions(collectionId);

  // Get decay settings - use type-aware defaults if not explicitly set
  const collectionType =
    meta.scope === "chat" ? "chat" : meta.type || "unknown";
  const decaySettings = getCollectionDecaySettings(collectionId);

  const currentChatId = getCurrentChatId();
  const hasChatLockMatch = currentChatId && isCollectionLockedToChat(collectionId, currentChatId);
  const chatScopedActive = Boolean(hasChatLockMatch);
  const resolvedAlwaysActive = chatScopedActive;
  console.log(
    `[VectHare DB Browser] Active-for-current-chat resolution for ${collectionId}: ` +
    `resolved=${resolvedAlwaysActive}, ` +
    `chatScopedActive=${chatScopedActive}, currentChatId=${currentChatId || 'none'}`
  );

  activationEditorState = {
    collectionId,
    collectionName,
    collectionType,
    alwaysActive: resolvedAlwaysActive,
    triggers: triggerSettings.triggers || [],
    triggerMatchMode: triggerSettings.matchMode || "any",
    triggerCaseSensitive: triggerSettings.caseSensitive || false,
    triggerScanDepth: triggerSettings.scanDepth || 5,
    conditions,
    temporalDecay: {
      enabled: decaySettings.enabled,
      type: decaySettings.type || "decay",
      mode: decaySettings.mode,
      halfLife: decaySettings.halfLife,
      linearRate: decaySettings.linearRate,
      minRelevance: decaySettings.minRelevance,
      maxBoost: decaySettings.maxBoost || 1.2,
      sceneAware: decaySettings.sceneAware,
    },
    // Prompt context
    context: meta.context || "",
    xmlTag: meta.xmlTag || "",
    // Injection position/depth (null = use global default)
    position: meta.position ?? null,
    depth: meta.depth ?? null,
  };

  // Create modal if needed
  if ($("#vecthare_activation_editor_modal").length === 0) {
    createActivationEditorModal();
  }

  // Populate with current settings
  renderActivationEditor();

  $("#vecthare_activation_editor_modal").fadeIn(200);
}

/**
 * Closes the activation editor
 */
function closeActivationEditor() {
  $("#vecthare_activation_editor_modal").fadeOut(200);
  activationEditorState.collectionId = null;
}

/**
 * Creates the activation editor modal
 * Primary: Triggers (like lorebook)
 * Secondary: Advanced conditions
 */
function createActivationEditorModal() {
  const modalHtml = `
        <div id="vecthare_activation_editor_modal" class="vecthare-modal">
            <div class="vecthare-activation-editor">
                <div class="vecthare-modal-header">
                                    <h3>⚙️ Collection Settings</h3>
                                    <div style="display:flex; gap:8px; align-items:center;">
                                        <button id="vecthare_activation_lock_collection" class="vecthare-btn-sm" title="Lock this collection to the current chat">🔒 Lock to Chat</button>
                                        <button class="vecthare-btn-icon" id="vecthare_activation_close">✕</button>
                                    </div>
                                </div>

                <div class="vecthare-activation-body">
                    <div class="vecthare-activation-collection-name">
                        Collection: <strong id="vecthare_activation_collection_name"></strong>
                    </div>

                    <!-- Always Active Toggle -->
                    <div class="vecthare-activation-section vecthare-always-active">
                        <label class="vecthare-checkbox-label">
                            <input type="checkbox" id="vecthare_always_active">
                        <strong id="vecthare_always_active_label">Active for current chat</strong>
                        </label>
                      <small id="vecthare_always_active_hint">When enabled, this collection is active for the current chat</small>
                    </div>

                    <!-- ========================================== -->
                    <!-- PRIMARY: ACTIVATION TRIGGERS (Like Lorebook) -->
                    <!-- ========================================== -->
                    <div class="vecthare-activation-section vecthare-triggers-section">
                        <div class="vecthare-section-header">
                            <h4>🎯 Activation Triggers <span class="vecthare-badge-primary">Primary</span></h4>
                            <small>Simple keyword-based activation, like lorebook entries</small>
                        </div>

                        <div class="vecthare-triggers-input">
                            <label>Trigger keywords:</label>
                            <textarea id="vecthare_triggers_input"
                                      placeholder="Enter keywords, one per line or comma-separated.&#10;Supports regex: /pattern/i"
                                      rows="4"></textarea>
                        </div>

                        <div class="vecthare-triggers-options">
                            <div class="vecthare-option-row">
                                <label>Match mode:</label>
                                <select id="vecthare_trigger_match_mode">
                                    <option value="any">ANY trigger matches (OR)</option>
                                    <option value="all">ALL triggers must match (AND)</option>
                                </select>
                            </div>
                            <div class="vecthare-option-row">
                                <label>Scan depth:</label>
                                <input type="number" id="vecthare_trigger_scan_depth" min="1" max="20" value="5">
                                <small>recent messages</small>
                            </div>
                            <div class="vecthare-option-row">
                                <label class="vecthare-checkbox-label">
                                    <input type="checkbox" id="vecthare_trigger_case_sensitive">
                                    Case sensitive
                                </label>
                            </div>
                        </div>
                    </div>

                    <!-- ========================================== -->
                    <!-- SECONDARY: ADVANCED CONDITIONS -->
                    <!-- ========================================== -->
                    <div class="vecthare-activation-section vecthare-conditions-section">
                        <div class="vecthare-section-header">
                            <h4>⚡ Advanced Conditions <span class="vecthare-badge-secondary">Secondary</span></h4>
                            <small>Complex rule-based activation (evaluated if triggers don't match or are empty)</small>
                        </div>

                        <!-- Enable toggle -->
                        <div class="vecthare-conditions-toggle">
                            <label class="vecthare-checkbox-label">
                                <input type="checkbox" id="vecthare_conditions_enabled">
                                Enable advanced conditions
                            </label>
                        </div>

                        <!-- Logic selector -->
                        <div class="vecthare-conditions-logic">
                            <label>Condition logic:</label>
                            <select id="vecthare_conditions_logic">
                                <option value="AND">ALL conditions must match (AND)</option>
                                <option value="OR">ANY condition can match (OR)</option>
                            </select>
                        </div>

                        <!-- Rules list -->
                        <div class="vecthare-conditions-rules">
                            <div class="vecthare-conditions-rules-header">
                                <span>Conditions</span>
                                <button class="vecthare-btn-sm" id="vecthare_add_condition">+ Add</button>
                            </div>
                            <div id="vecthare_conditions_list"></div>
                        </div>
                    </div>

                    <!-- ========================================== -->
                    <!-- TEMPORAL DECAY (Per-Collection) -->
                    <!-- ========================================== -->
                    <div class="vecthare-activation-section vecthare-decay-section">
                        <div class="vecthare-section-header">
                            <h4>⏳ Temporal Weighting</h4>
                            <small>Adjust chunk relevance based on message age</small>
                        </div>

                        <div class="vecthare-decay-settings">
                            <div class="vecthare-option-row">
                                <label class="vecthare-checkbox-label">
                                    <input type="checkbox" id="vecthare_decay_enabled">
                                    <strong>Enable temporal weighting</strong>
                                </label>
                            </div>

                            <div class="vecthare-decay-advanced" id="vecthare_decay_advanced">
                                <div class="vecthare-type-toggle">
                                    <label class="vecthare-type-option" data-type="decay">
                                        <input type="radio" name="vecthare_decay_type" value="decay" checked>
                                        <div class="vecthare-type-card">
                                            <div class="vecthare-type-header">
                                                <span class="vecthare-type-icon">📉</span>
                                                <strong>Decay</strong>
                                            </div>
                                            <small>Recent messages score higher. Older memories fade over time.</small>
                                        </div>
                                    </label>
                                    <label class="vecthare-type-option" data-type="nostalgia">
                                        <input type="radio" name="vecthare_decay_type" value="nostalgia">
                                        <div class="vecthare-type-card">
                                            <div class="vecthare-type-header">
                                                <span class="vecthare-type-icon">📈</span>
                                                <strong>Nostalgia</strong>
                                            </div>
                                            <small>Older messages score higher. Ancient history becomes more relevant.</small>
                                        </div>
                                    </label>
                                </div>

                                <div class="vecthare-curve-label">Curve</div>
                                <div class="vecthare-type-toggle vecthare-curve-toggle">
                                    <label class="vecthare-type-option" data-mode="exponential">
                                        <input type="radio" name="vecthare_decay_mode" value="exponential" checked>
                                        <div class="vecthare-type-card">
                                            <div class="vecthare-type-header">
                                                <span class="vecthare-type-icon">📐</span>
                                                <strong>Exponential</strong>
                                            </div>
                                            <small>Smooth half-life curve. Effect halves every N messages. Natural decay pattern.</small>
                                        </div>
                                    </label>
                                    <label class="vecthare-type-option" data-mode="linear">
                                        <input type="radio" name="vecthare_decay_mode" value="linear">
                                        <div class="vecthare-type-card">
                                            <div class="vecthare-type-header">
                                                <span class="vecthare-type-icon">📏</span>
                                                <strong>Linear</strong>
                                            </div>
                                            <small>Fixed rate per message. Predictable, steady change. Hits limits faster.</small>
                                        </div>
                                    </label>
                                </div>

                                <div class="vecthare-option-row vecthare-decay-exponential">
                                    <label>Half-life:</label>
                                    <input type="number" id="vecthare_decay_halflife" min="1" max="500" value="50">
                                    <small id="vecthare_halflife_hint">messages until 50% effect</small>
                                </div>

                                <div class="vecthare-option-row vecthare-decay-linear" style="display: none;">
                                    <label>Rate:</label>
                                    <input type="number" id="vecthare_decay_rate" min="0.001" max="0.5" step="0.001" value="0.01">
                                    <small>per message (0.01 = 1%)</small>
                                </div>

                                <div class="vecthare-option-row vecthare-decay-floor">
                                    <label id="vecthare_limit_label">Min relevance:</label>
                                    <input type="number" id="vecthare_decay_min" min="0" max="2" step="0.05" value="0.3">
                                    <small id="vecthare_limit_hint">floor for decay (0-1)</small>
                                </div>

                                <div class="vecthare-option-row vecthare-nostalgia-ceiling" style="display: none;">
                                    <label>Max boost:</label>
                                    <input type="number" id="vecthare_decay_max_boost" min="1" max="3" step="0.1" value="1.2">
                                    <small>ceiling for nostalgia (1.2 = 20% max boost)</small>
                                </div>

                                <div class="vecthare-option-row">
                                    <label class="vecthare-checkbox-label">
                                        <input type="checkbox" id="vecthare_decay_scene_aware">
                                        Scene-aware
                                    </label>
                                    <small>Reset weighting at scene boundaries</small>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- ========================================== -->
                    <!-- PROMPT CONTEXT -->
                    <!-- ========================================== -->
                    <div class="vecthare-activation-section vecthare-context-section">
                        <div class="vecthare-section-header">
                            <h4>💬 Prompt Context</h4>
                            <small>Add context prompts to help the AI understand chunks from this collection</small>
                        </div>

                        <div class="vecthare-context-settings">
                            <div class="vecthare-option-row">
                                <label>Context prompt:</label>
                                <textarea id="vecthare_collection_context"
                                          placeholder="e.g., Things {{char}} remembers about {{user}}:"
                                          rows="2"></textarea>
                                <small>Shown before this collection's chunks. Supports {{user}} and {{char}}.</small>
                            </div>

                            <div class="vecthare-option-row">
                                <label>XML tag (optional):</label>
                                <input type="text" id="vecthare_collection_xml_tag" placeholder="e.g., memories">
                                <small>Wraps this collection's chunks in &lt;tag&gt;...&lt;/tag&gt;</small>
                            </div>

                            <div class="vecthare-option-row vecthare-injection-row">
                                <label>Injection position:</label>
                                <select id="vecthare_collection_position">
                                    <option value="">Use global default</option>
                                    <option value="2">Before Main Prompt</option>
                                    <option value="0">After Main Prompt</option>
                                    <option value="1">In-Chat @ Depth</option>
                                </select>
                                <small>Where this collection's chunks appear in the prompt</small>
                            </div>

                            <div class="vecthare-option-row vecthare-depth-row" id="vecthare_collection_depth_row" style="display: none;">
                                <label>Injection depth: <span id="vecthare_collection_depth_value">2</span></label>
                                <input type="range" id="vecthare_collection_depth" min="0" max="50" step="1" value="2">
                                <small>Messages from end of chat to insert at</small>
                            </div>
                        </div>
                    </div>

                    <!-- Activation Priority Info -->
                    <div class="vecthare-activation-info">
                        <strong>Activation Priority:</strong>
                        <ol>
                            <li><strong>Always Active</strong> → Collection always queries</li>
                            <li><strong>Triggers</strong> → Match keywords in recent messages</li>
                            <li><strong>Advanced Conditions</strong> → Evaluated if triggers empty/don't match</li>
                            <li><strong>No config</strong> → Auto-activates (backwards compatible)</li>
                        </ol>
                    </div>
                </div>

                <div class="vecthare-modal-footer">
                    <button class="vecthare-btn" id="vecthare_activation_cancel">Cancel</button>
                    <button class="vecthare-btn vecthare-btn-primary" id="vecthare_activation_save">Save</button>
                </div>
            </div>
        </div>
    `;

  $("body").append(modalHtml);
  bindActivationEditorEvents();
}

/**
 * Updates hint text based on decay vs nostalgia mode
 * @param {boolean} isNostalgia True if nostalgia mode
 */
function updateTemporalWeightingHints(isNostalgia) {
  if (isNostalgia) {
    $("#vecthare_decay_type_hint").text("Older messages score higher");
    $("#vecthare_halflife_hint").text("messages until 50% of max boost");
  } else {
    $("#vecthare_decay_type_hint").text("Newer messages score higher");
    $("#vecthare_halflife_hint").text("messages until 50% relevance");
  }
}

/**
 * Binds event handlers for activation editor
 */
function bindActivationEditorEvents() {
  $("#vecthare_activation_close, #vecthare_activation_cancel").on(
    "click",
    function (e) {
      e.preventDefault();
      e.stopPropagation();
      closeActivationEditor();
    },
  );

  $("#vecthare_activation_save").on("click", function (e) {
    e.preventDefault();
    e.stopPropagation();
    saveActivation();
  });

  $("#vecthare_add_condition").on("click", function (e) {
    e.preventDefault();
    e.stopPropagation();
    addConditionRule();
  });

  // Stop mousedown propagation (ST closes drawers on mousedown/touchstart)
  $("#vecthare_activation_editor_modal").on("mousedown touchstart", function (e) {
    e.stopPropagation();
  });

  // Close on background click
  $("#vecthare_activation_editor_modal").on("click", function (e) {
    if (e.target === this) closeActivationEditor();
  });

  // Active-for-current-chat toggle (status only, does not disable other settings)
  $("#vecthare_always_active").on("change", function (e) {
    e.stopPropagation();
  });

  // Decay enabled toggle shows/hides advanced settings
  $("#vecthare_decay_enabled").on("change", function (e) {
    e.stopPropagation();
    const enabled = $(this).prop("checked");
    $("#vecthare_decay_advanced").toggle(enabled);
  });

  // Decay mode toggle shows/hides exponential vs linear settings
  $('input[name="vecthare_decay_mode"]').on("change", function (e) {
    e.stopPropagation();
    const mode = $(this).val();
    $(".vecthare-decay-exponential").toggle(mode === "exponential");
    $(".vecthare-decay-linear").toggle(mode === "linear");
    // Update visual selection state
    $(".vecthare-curve-toggle .vecthare-type-option").removeClass("selected");
    $(this).closest(".vecthare-type-option").addClass("selected");
  });

  // Decay type toggle shows/hides decay-specific vs nostalgia-specific fields
  $('input[name="vecthare_decay_type"]').on("change", function (e) {
    e.stopPropagation();
    const isNostalgia = $(this).val() === "nostalgia";
    $(".vecthare-decay-floor").toggle(!isNostalgia);
    $(".vecthare-nostalgia-ceiling").toggle(isNostalgia);
    updateTemporalWeightingHints(isNostalgia);
    // Update visual selection state
    $(".vecthare-type-option").removeClass("selected");
    $(this).closest(".vecthare-type-option").addClass("selected");
  });

  // Activation editor: Lock-to-chat button - opens dialog to manage multiple locks
  $("#vecthare_activation_lock_collection").off("click").on("click", async function (e) {
    e.stopPropagation();
    const collId = activationEditorState.collectionId;

    if (!collId) {
      toastr.warning("No collection selected");
      return;
    }

    try {
      openCollectionLockDialog(collId);
    } catch (err) {
      console.error("VectHare: Failed to open lock dialog", err);
      toastr.error("Failed to open lock dialog");
    }
  });

  // Refresh lock button when chat changes
  eventSource.on(event_types.CHAT_CHANGED, () => {
    refreshActivationLockButton();
  });

  // Injection position toggle shows/hides depth row
  $("#vecthare_collection_position").on("change", function (e) {
    e.stopPropagation();
    const position = $(this).val();
    // Show depth row only if "In-Chat @ Depth" (value 1) is selected
    $("#vecthare_collection_depth_row").toggle(position === "1");
  });

  // Injection depth slider updates label
  $("#vecthare_collection_depth").on("input", function (e) {
    e.stopPropagation();
    $("#vecthare_collection_depth_value").text($(this).val());
  });
}

/**
 * Renders the activation editor content
 */
function renderActivationEditor() {
  const state = activationEditorState;

  $("#vecthare_activation_collection_name").text(state.collectionName);
  $("#vecthare_always_active").prop("checked", state.alwaysActive);
  $("#vecthare_always_active").prop("disabled", false);
  $("#vecthare_always_active_label").text("Active for current chat");
  $("#vecthare_always_active_hint").text("When enabled, this collection is active for the current chat");

  // Triggers
  const triggersText = state.triggers.join("\n");
  $("#vecthare_triggers_input").val(triggersText);
  $("#vecthare_trigger_match_mode").val(state.triggerMatchMode);
  $("#vecthare_trigger_scan_depth").val(state.triggerScanDepth);
  $("#vecthare_trigger_case_sensitive").prop(
    "checked",
    state.triggerCaseSensitive,
  );

  // Conditions
  $("#vecthare_conditions_enabled").prop("checked", state.conditions.enabled);
  $("#vecthare_conditions_logic").val(state.conditions.logic || "AND");

  // Temporal Weighting (decay or nostalgia)
  const decay = state.temporalDecay;
  $("#vecthare_decay_enabled").prop("checked", decay.enabled);
  const decayType = decay.type || "decay";
  $(`input[name="vecthare_decay_type"][value="${decayType}"]`).prop(
    "checked",
    true,
  );
  $(".vecthare-type-option").removeClass("selected");
  $(`.vecthare-type-option[data-type="${decayType}"]`).addClass("selected");
  const decayMode = decay.mode || "exponential";
  $(`input[name="vecthare_decay_mode"][value="${decayMode}"]`).prop(
    "checked",
    true,
  );
  $(`.vecthare-type-option[data-mode="${decayMode}"]`).addClass("selected");
  $("#vecthare_decay_halflife").val(decay.halfLife);
  $("#vecthare_decay_rate").val(decay.linearRate);
  $("#vecthare_decay_min").val(decay.minRelevance);
  $("#vecthare_decay_max_boost").val(decay.maxBoost || 1.2);
  $("#vecthare_decay_scene_aware").prop("checked", decay.sceneAware);

  // Show/hide advanced decay settings based on enabled
  $("#vecthare_decay_advanced").toggle(decay.enabled);

  // Show correct decay mode fields
  $(".vecthare-decay-exponential").toggle(decay.mode === "exponential");
  $(".vecthare-decay-linear").toggle(decay.mode === "linear");

  // Show/hide type-specific fields and update hints
  const isNostalgia = decayType === "nostalgia";
  $(".vecthare-decay-floor").toggle(!isNostalgia);
  $(".vecthare-nostalgia-ceiling").toggle(isNostalgia);
  updateTemporalWeightingHints(isNostalgia);

  // Prompt Context
  $("#vecthare_collection_context").val(state.context || "");
  $("#vecthare_collection_xml_tag").val(state.xmlTag || "");

  // Injection position/depth
  const posValue = state.position !== null ? String(state.position) : "";
  $("#vecthare_collection_position").val(posValue);
  $("#vecthare_collection_depth").val(state.depth ?? 2);
  $("#vecthare_collection_depth_value").text(state.depth ?? 2);
  // Show depth row only if position is "In-Chat @ Depth" (value 1)
  $("#vecthare_collection_depth_row").toggle(state.position === 1);

  // Keep trigger/condition sections enabled regardless of chat activation toggle.
  $(".vecthare-triggers-section, .vecthare-conditions-section").removeClass("vecthare-disabled");

  // Refresh lock button state for this collection
  refreshActivationLockButton();

  renderConditionRules();
}

/**
 * Refresh the lock button in the activation editor based on current collection and chat
 */
function refreshActivationLockButton() {
  try {
    const collId = activationEditorState.collectionId;
    const $btn = $("#vecthare_activation_lock_collection");
    const chatId = getCurrentChatId();
    const context = getContext();
    const charId = context?.characterId || null;

    if (!$btn || $btn.length === 0) return;

    if (!collId) {
      $btn.prop("disabled", true).text("🔒 Lock to Chat");
      $btn.attr("title", "No collection selected");
      return;
    }

    const chatLockCount = getCollectionLockCount(collId);
    const charLockCount = getCollectionCharacterLockCount(collId);
    const isLockedToCurrentChat = chatId && isCollectionLockedToChat(collId, chatId);
    const isLockedToCurrentChar = charId && isCollectionLockedToCharacter(collId, charId);
    const totalLocks = chatLockCount + charLockCount;

    if (totalLocks === 0) {
      $btn.prop("disabled", false).text("🔒 Manage Locks");
      $btn.attr("title", "No locks set. Click to add locks");
    } else {
      const hasCurrentChatLock = Boolean(isLockedToCurrentChat);
      const lockedStatus = hasCurrentChatLock ? "🔓" : "🔒";
      const lockLabel = `${totalLocks} lock${totalLocks !== 1 ? "s" : ""}`;
      const scopeLabel = hasCurrentChatLock ? "(this chat)" : "(other chat)";
      $btn.prop("disabled", false).text(`${lockedStatus} ${lockLabel} ${scopeLabel}`);

      let tooltip = `Collection has ${totalLocks} lock${totalLocks !== 1 ? "s" : ""}`;
      if (chatLockCount > 0) tooltip += ` (${chatLockCount} chat${chatLockCount !== 1 ? "s" : ""})`;
      if (charLockCount > 0) tooltip += ` (${charLockCount} character${charLockCount !== 1 ? "s" : ""})`;
      if (isLockedToCurrentChat || isLockedToCurrentChar) tooltip += " - ACTIVE for current context";

      $btn.attr("title", tooltip);
    }
  } catch (err) {
    console.error("VectHare: Failed to refresh activation lock button", err);
  }
}

/**
 * Saves collection settings (activation + triggers + conditions + decay)
 */
function saveActivation() {
  const state = activationEditorState;

  // Parse triggers from textarea
  const triggersRaw = $("#vecthare_triggers_input").val();
  const triggers = triggersRaw
    .split(/[\n,]/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  // Build temporal weighting settings (decay or nostalgia)
  const temporalDecay = {
    enabled: $("#vecthare_decay_enabled").prop("checked"),
    type: $('input[name="vecthare_decay_type"]:checked').val() || "decay",
    mode: $('input[name="vecthare_decay_mode"]:checked').val() || "exponential",
    halfLife: parseInt($("#vecthare_decay_halflife").val()) || 50,
    linearRate: parseFloat($("#vecthare_decay_rate").val()) || 0.01,
    minRelevance: parseFloat($("#vecthare_decay_min").val()) || 0.3,
    maxBoost: parseFloat($("#vecthare_decay_max_boost").val()) || 1.2,
    sceneAware: $("#vecthare_decay_scene_aware").prop("checked"),
  };

  // Get prompt context values (sanitize xml tag)
  const contextPrompt = $("#vecthare_collection_context").val() || "";
  const xmlTagRaw = $("#vecthare_collection_xml_tag").val() || "";
  const xmlTag = xmlTagRaw.replace(/[^a-zA-Z0-9_-]/g, "");

  // Get injection position/depth (empty string = use global default = null)
  const positionRaw = $("#vecthare_collection_position").val();
  const position = positionRaw === "" ? null : parseInt(positionRaw);
  const depth =
    position === 1
      ? parseInt($("#vecthare_collection_depth").val()) || 2
      : null;

  const isChecked = $("#vecthare_always_active").prop("checked");
  const currentChatId = getCurrentChatId();
  if (currentChatId) {
    if (isChecked) {
      setCollectionLock(state.collectionId, currentChatId);
    } else {
      removeCollectionLock(state.collectionId, currentChatId);
    }
  } else {
    toastr.info('No active chat context; "Active for current chat" was not changed');
  }

  const alwaysActiveValue = false;

  // Update metadata (all in one call)
  setCollectionMeta(state.collectionId, {
    alwaysActive: alwaysActiveValue,
    triggers: triggers,
    triggerMatchMode: $("#vecthare_trigger_match_mode").val(),
    triggerScanDepth: parseInt($("#vecthare_trigger_scan_depth").val()) || 5,
    triggerCaseSensitive: $("#vecthare_trigger_case_sensitive").prop("checked"),
    temporalDecay: temporalDecay,
    context: contextPrompt,
    xmlTag: xmlTag,
    position: position,
    depth: depth,
  });

  // Save conditions
  const conditions = {
    enabled: $("#vecthare_conditions_enabled").prop("checked"),
    logic: $("#vecthare_conditions_logic").val(),
    rules: state.conditions.rules || [],
  };
  setCollectionConditions(state.collectionId, conditions);

  closeActivationEditor();
  refreshCollections();
  toastr.success("Collection settings saved", "VectHarePlus");
}

/**
 * Renders the list of condition rules
 */
function renderConditionRules() {
  const rules = activationEditorState.conditions.rules || [];
  const container = $("#vecthare_conditions_list");

  if (rules.length === 0) {
    container.html(
      '<div class="vecthare-empty-rules">No conditions yet. Click "+ Add Condition" to add one.</div>',
    );
    return;
  }

  const rulesHtml = rules
    .map((rule, idx) => renderConditionRule(rule, idx))
    .join("");
  container.html(rulesHtml);

  // Bind rule events
  bindConditionRuleEvents();
}

/**
 * Renders a single condition rule
 */
function renderConditionRule(rule, index) {
  const typeOptions = CONDITION_TYPES.map(
    (t) =>
      `<option value="${t.value}" ${rule.type === t.value ? "selected" : ""}>${t.label}</option>`,
  ).join("");

  return `
        <div class="vecthare-condition-rule" data-rule-index="${index}">
            <div class="vecthare-condition-row">
                <select class="vecthare-condition-type" data-rule-index="${index}">
                    ${typeOptions}
                </select>
                <label class="vecthare-condition-negate">
                    <input type="checkbox" ${rule.negate ? "checked" : ""} data-rule-index="${index}">
                    NOT
                </label>
                <button class="vecthare-btn-icon vecthare-condition-remove" data-rule-index="${index}">🗑️</button>
            </div>
            <div class="vecthare-condition-settings" data-rule-index="${index}">
                ${renderConditionSettings(rule, index)}
            </div>
        </div>
    `;
}

/**
 * Renders settings for a specific condition type
 */
function renderConditionSettings(rule, index) {
  const settings = rule.settings || {};

  switch (rule.type) {
    case "keyword": // Legacy support
    case "pattern":
      return `
                <div class="vecthare-pattern-condition-wrapper">
                    <div class="vecthare-pattern-row">
                        <textarea class="vecthare-pattern-input" placeholder="Patterns (one per line)&#10;Plain text or regex: /pattern/i"
                                  data-field="patterns" data-rule-index="${index}"
                                  rows="3">${(settings.patterns || settings.values || []).join("\n")}</textarea>
                    </div>
                    <div class="vecthare-pattern-options">
                        <div class="vecthare-option-row">
                            <label>Match mode:</label>
                            <select data-field="matchMode" data-rule-index="${index}">
                                <option value="any" ${settings.matchMode === "any" ? "selected" : ""}>ANY pattern matches</option>
                                <option value="all" ${settings.matchMode === "all" ? "selected" : ""}>ALL patterns must match</option>
                            </select>
                        </div>
                        <div class="vecthare-option-row">
                            <label>Scan depth:</label>
                            <input type="number" data-field="scanDepth" data-rule-index="${index}"
                                   min="1" max="100" value="${settings.scanDepth || 10}">
                            <small>messages</small>
                        </div>
                        <div class="vecthare-option-row">
                            <label>Search in:</label>
                            <select data-field="searchIn" data-rule-index="${index}">
                                <option value="all" ${settings.searchIn === "all" ? "selected" : ""}>All messages</option>
                                <option value="user" ${settings.searchIn === "user" ? "selected" : ""}>User only</option>
                                <option value="assistant" ${settings.searchIn === "assistant" ? "selected" : ""}>Assistant only</option>
                            </select>
                        </div>
                        <div class="vecthare-option-row">
                            <label class="vecthare-checkbox-label">
                                <input type="checkbox" data-field="caseSensitive" data-rule-index="${index}"
                                       ${settings.caseSensitive ? "checked" : ""}>
                                Case sensitive
                            </label>
                        </div>
                    </div>
                </div>
            `;

    case "speaker":
    case "characterPresent":
      return `
                <input type="text" placeholder="Character names (comma-separated)"
                       value="${(settings.values || []).join(", ")}"
                       data-field="values" data-rule-index="${index}">
                <select data-field="matchType" data-rule-index="${index}">
                    <option value="any" ${settings.matchType === "any" ? "selected" : ""}>Any matches</option>
                    <option value="all" ${settings.matchType === "all" ? "selected" : ""}>All must match</option>
                </select>
            `;

    case "messageCount":
    case "swipeCount":
      return `
                <input type="number" placeholder="Count" min="0"
                       value="${settings.count || 0}"
                       data-field="count" data-rule-index="${index}">
                <select data-field="operator" data-rule-index="${index}">
                    <option value="eq" ${settings.operator === "eq" ? "selected" : ""}>Exactly</option>
                    <option value="gte" ${settings.operator === "gte" ? "selected" : ""}>At least</option>
                    <option value="lte" ${settings.operator === "lte" ? "selected" : ""}>At most</option>
                </select>
            `;

    case "emotion":
      const emotionOptions = VALID_EMOTIONS.map(
        (e) =>
          `<option value="${e}" ${(settings.values || []).includes(e) ? "selected" : ""}>${e}</option>`,
      ).join("");
      const expressionsStatus = getExpressionsExtensionStatus();
      return `
                <div class="vecthare-emotion-condition-wrapper">
                    <div class="vecthare-conditions-notice vecthare-notice-${expressionsStatus.level} vecthare-emotion-notice">
                        ${expressionsStatus.message}
                    </div>
                    <div class="vecthare-emotion-controls">
                        <select multiple data-field="values" data-rule-index="${index}" class="vecthare-multi-select">
                            ${emotionOptions}
                        </select>
                        <select data-field="detectionMethod" data-rule-index="${index}">
                            <option value="auto" ${settings.detectionMethod === "auto" ? "selected" : ""}>Auto (recommended)</option>
                            <option value="expressions" ${settings.detectionMethod === "expressions" ? "selected" : ""}>Expressions only</option>
                            <option value="patterns" ${settings.detectionMethod === "patterns" ? "selected" : ""}>Patterns only</option>
                            <option value="both" ${settings.detectionMethod === "both" ? "selected" : ""}>Both must match</option>
                        </select>
                    </div>
                </div>
            `;

    case "isGroupChat":
      return `
                <select data-field="isGroup" data-rule-index="${index}">
                    <option value="true" ${settings.isGroup === true ? "selected" : ""}>Is group chat</option>
                    <option value="false" ${settings.isGroup === false ? "selected" : ""}>Is 1-on-1 chat</option>
                </select>
            `;

    case "generationType":
      const genOptions = VALID_GENERATION_TYPES.map(
        (g) =>
          `<option value="${g}" ${(settings.values || []).includes(g) ? "selected" : ""}>${g}</option>`,
      ).join("");
      return `
                <select multiple data-field="values" data-rule-index="${index}" class="vecthare-multi-select">
                    ${genOptions}
                </select>
            `;

    case "lorebookActive":
      // Get available world names for the picker
      const availableWorlds = world_names || [];
      const worldOptions = availableWorlds
        .map((w) => `<option value="${w}">${w}</option>`)
        .join("");
      const selectedValues = settings.values || [];
      return `
                <div class="vecthare-lorebook-picker-wrapper">
                    <div class="vecthare-lorebook-picker-row">
                        <select class="vecthare-lorebook-select" data-rule-index="${index}">
                            <option value="">-- Select Lorebook --</option>
                            ${worldOptions}
                        </select>
                        <select class="vecthare-lorebook-entry-select" data-rule-index="${index}" disabled>
                            <option value="">-- Select Entry (optional) --</option>
                        </select>
                        <button class="vecthare-btn-sm vecthare-lorebook-add" data-rule-index="${index}" type="button">+ Add</button>
                    </div>
                    <div class="vecthare-lorebook-selected" data-rule-index="${index}">
                        ${selectedValues
                          .map(
                            (v) => `
                            <span class="vecthare-lorebook-tag" data-value="${v}">
                                ${v} <button class="vecthare-lorebook-remove" data-value="${v}" data-rule-index="${index}">×</button>
                            </span>
                        `,
                          )
                          .join("")}
                    </div>
                    <input type="hidden" data-field="values" data-rule-index="${index}" value="${selectedValues.join(",")}">
                </div>
            `;

    case "timeOfDay":
      return `
                <input type="time" value="${settings.startTime || "00:00"}"
                       data-field="startTime" data-rule-index="${index}">
                <span>to</span>
                <input type="time" value="${settings.endTime || "23:59"}"
                       data-field="endTime" data-rule-index="${index}">
            `;

    case "randomChance":
      return `
                <input type="number" placeholder="Probability %" min="0" max="100"
                       value="${settings.probability || 50}"
                       data-field="probability" data-rule-index="${index}">
                <span>%</span>
            `;

    default:
      return '<span class="vecthare-unknown-type">Unknown condition type</span>';
  }
}

/**
 * Binds events for individual condition rules
 */
function bindConditionRuleEvents() {
  // Type change
  $(".vecthare-condition-type")
    .off("change")
    .on("change", function (e) {
      e.stopPropagation();
      const idx = $(this).data("rule-index");
      activationEditorState.conditions.rules[idx].type = $(this).val();
      activationEditorState.conditions.rules[idx].settings = {};
      renderConditionRules();
    });

  // Negate toggle
  $(".vecthare-condition-negate input")
    .off("change")
    .on("change", function (e) {
      e.stopPropagation();
      const idx = $(this).data("rule-index");
      activationEditorState.conditions.rules[idx].negate =
        $(this).prop("checked");
    });

  // Remove rule
  $(".vecthare-condition-remove")
    .off("click")
    .on("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      const idx = $(this).data("rule-index");
      activationEditorState.conditions.rules.splice(idx, 1);
      renderConditionRules();
    });

  // Settings fields (inputs, selects, and textareas)
  $(
    ".vecthare-condition-settings input, .vecthare-condition-settings select, .vecthare-condition-settings textarea",
  )
    .off("change")
    .on("change", function (e) {
      e.stopPropagation();
      const idx = $(this).data("rule-index");
      const field = $(this).data("field");
      let value = $(this).val();

      // Handle patterns (textarea, newline-separated)
      if (field === "patterns" && typeof value === "string") {
        value = value
          .split("\n")
          .map((v) => v.trim())
          .filter((v) => v);
      }

      // Handle comma-separated values
      if (field === "values" && typeof value === "string") {
        value = value
          .split(",")
          .map((v) => v.trim())
          .filter((v) => v);
      }

      // Handle multi-select
      if ($(this).prop("multiple")) {
        value = $(this).val() || [];
      }

      // Handle checkboxes
      if ($(this).attr("type") === "checkbox") {
        value = $(this).prop("checked");
      }

      // Handle booleans from select
      if (field === "isGroup") {
        value = value === "true";
      }

      // Handle numbers
      if (["count", "probability", "scanDepth"].includes(field)) {
        value = parseInt(value) || 0;
      }

      if (!activationEditorState.conditions.rules[idx].settings) {
        activationEditorState.conditions.rules[idx].settings = {};
      }
      activationEditorState.conditions.rules[idx].settings[field] = value;
    });

  // Lorebook picker: world select change - load entries
  $(".vecthare-lorebook-select")
    .off("change")
    .on("change", async function (e) {
      e.stopPropagation();
      const idx = $(this).data("rule-index");
      const worldName = $(this).val();
      const entrySelect = $(
        `.vecthare-lorebook-entry-select[data-rule-index="${idx}"]`,
      );

      if (!worldName) {
        entrySelect
          .prop("disabled", true)
          .html('<option value="">-- Select Entry (optional) --</option>');
        return;
      }

      // Load world info entries
      entrySelect
        .prop("disabled", true)
        .html('<option value="">Loading...</option>');
      try {
        const worldData = await loadWorldInfo(worldName);
        if (worldData && worldData.entries) {
          const entries = Object.values(worldData.entries);
          const entryOptions = entries
            .map((entry) => {
              const displayName =
                entry.comment || entry.key?.join(", ") || `Entry ${entry.uid}`;
              return `<option value="${entry.uid}" data-key="${entry.key?.join(",") || ""}">${displayName}</option>`;
            })
            .join("");
          entrySelect.html(
            `<option value="">-- Entire Lorebook --</option>${entryOptions}`,
          );
          entrySelect.prop("disabled", false);
        }
      } catch (error) {
        console.error("VectHare: Failed to load world info", error);
        entrySelect.html(
          '<option value="">-- Error loading entries --</option>',
        );
      }
    });

  // Lorebook picker: add button
  $(".vecthare-lorebook-add")
    .off("click")
    .on("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      const idx = $(this).data("rule-index");
      const worldSelect = $(
        `.vecthare-lorebook-select[data-rule-index="${idx}"]`,
      );
      const entrySelect = $(
        `.vecthare-lorebook-entry-select[data-rule-index="${idx}"]`,
      );
      const selectedContainer = $(
        `.vecthare-lorebook-selected[data-rule-index="${idx}"]`,
      );
      const hiddenInput = $(
        `input[data-field="values"][data-rule-index="${idx}"]`,
      );

      const worldName = worldSelect.val();
      if (!worldName) {
        toastr.warning("Please select a lorebook first", "VectHarePlus");
        return;
      }

      const entryUid = entrySelect.val();
      let valueToAdd;

      if (entryUid) {
        // Specific entry: use "worldName:uid" format
        valueToAdd = `${worldName}:${entryUid}`;
      } else {
        // Entire lorebook
        valueToAdd = worldName;
      }

      // Get current values
      const currentValues = hiddenInput.val()
        ? hiddenInput
            .val()
            .split(",")
            .filter((v) => v)
        : [];
      if (currentValues.includes(valueToAdd)) {
        toastr.info("Already added", "VectHarePlus");
        return;
      }

      currentValues.push(valueToAdd);
      hiddenInput.val(currentValues.join(","));

      // Update the visual tags
      const displayName = entryUid
        ? `${worldName}:${entrySelect.find(":selected").text()}`
        : worldName;
      selectedContainer.append(`
            <span class="vecthare-lorebook-tag" data-value="${valueToAdd}">
                ${displayName} <button class="vecthare-lorebook-remove" data-value="${valueToAdd}" data-rule-index="${idx}">×</button>
            </span>
        `);

      // Update state
      if (!activationEditorState.conditions.rules[idx].settings) {
        activationEditorState.conditions.rules[idx].settings = {};
      }
      activationEditorState.conditions.rules[idx].settings.values =
        currentValues;

      // Rebind remove buttons
      bindLorebookRemoveButtons();

      // Reset selects
      worldSelect.val("");
      entrySelect
        .prop("disabled", true)
        .html('<option value="">-- Select Entry (optional) --</option>');
    });

  // Bind remove buttons
  bindLorebookRemoveButtons();
}

/**
 * Binds lorebook tag remove buttons
 */
function bindLorebookRemoveButtons() {
  $(".vecthare-lorebook-remove")
    .off("click")
    .on("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      const idx = $(this).data("rule-index");
      const valueToRemove = $(this).data("value");
      const hiddenInput = $(
        `input[data-field="values"][data-rule-index="${idx}"]`,
      );

      // Remove from values
      const currentValues = hiddenInput.val()
        ? hiddenInput
            .val()
            .split(",")
            .filter((v) => v && v !== valueToRemove)
        : [];
      hiddenInput.val(currentValues.join(","));

      // Update state
      if (activationEditorState.conditions.rules[idx]?.settings) {
        activationEditorState.conditions.rules[idx].settings.values =
          currentValues;
      }

      // Remove the tag
      $(this).closest(".vecthare-lorebook-tag").remove();
    });
}

/**
 * Adds a new condition rule
 */
function addConditionRule() {
  if (!activationEditorState.conditions.rules) {
    activationEditorState.conditions.rules = [];
  }

  activationEditorState.conditions.rules.push({
    type: "pattern",
    negate: false,
    settings: {},
  });

  renderConditionRules();
}

// ============================================================================
// SEARCH TAB FUNCTIONS
// ============================================================================

/**
 * Binds search tab events
 */
function bindSearchEvents() {
  if (searchEventsBound) return;
  searchEventsBound = true;

  // Search button click
  $("#vecthare_search_btn").off("click").on("click", performSearch);

  // Enter key in search input
  $("#vecthare_semantic_search")
    .off("keydown")
    .on("keydown", function (e) {
      if (e.key === "Enter") {
        e.preventDefault();
        performSearch();
      }
    });

  // Keyword filter events
  $("#vecthare_scan_keywords").off("click").on("click", scanKeywords);
  $("#vecthare_clear_keyword_filter").off("click").on("click", clearKeywordFilter);
  $("#vecthare_keyword_filter").off("input").on("input", updateKeywordFilterFromInput);
}

/**
 * Scans all collections for keywords
 */
async function scanKeywords() {
  const $btn = $("#vecthare_scan_keywords");
  const $tags = $("#vecthare_keyword_tags");

  $btn.prop("disabled", true).html('<i class="fa-solid fa-spinner fa-spin"></i> Scanning...');
  $tags.html('<span class="vecthare-keyword-hint">Scanning collections...</span>');

  try {
    const enabledOnly = $("#vecthare_search_enabled_only").is(":checked");
    let collectionsToScan = browserState.collections;

    if (enabledOnly) {
      collectionsToScan = collectionsToScan.filter(c => c.enabled);
    }

    const keywordCounts = new Map();

    for (const collection of collectionsToScan) {
      try {
        const response = await fetch("/api/plugins/similharity/chunks/list", {
          method: "POST",
          headers: getRequestHeaders(),
          body: JSON.stringify({
            backend: collection.backend || "vectra",
            collectionId: collection.id,
            source: collection.source || "transformers",
            model: collection.model || "",
            limit: 500,
          }),
        });

        if (!response.ok) continue;

        const data = await response.json();
        const items = data.items || [];

        for (const item of items) {
          const keywords = item.metadata?.keywords || item.keywords || [];
          for (const kw of keywords) {
            const text = (typeof kw === 'object' ? kw.text : kw)?.toLowerCase();
            if (text) {
              keywordCounts.set(text, (keywordCounts.get(text) || 0) + 1);
            }
          }
        }
      } catch (err) {
        console.warn(`VectHare: Failed to scan keywords from ${collection.id}:`, err);
      }
    }

    // Sort by count and store
    browserState.availableKeywords = Array.from(keywordCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([text, count]) => ({ text, count }));

    renderKeywordTags();

    if (browserState.availableKeywords.length === 0) {
      $tags.html('<span class="vecthare-keyword-hint">No keywords found in scanned collections</span>');
    } else {
      toastr.success(`Found ${browserState.availableKeywords.length} unique keywords`, "VectHarePlus");
    }
  } catch (error) {
    console.error("VectHare: Keyword scan failed", error);
    $tags.html('<span class="vecthare-keyword-hint vecthare-error">Scan failed</span>');
    toastr.error("Failed to scan keywords", "VectHarePlus");
  } finally {
    $btn.prop("disabled", false).html('<i class="fa-solid fa-sync"></i> Scan');
  }
}

/**
 * Renders clickable keyword tags
 */
function renderKeywordTags() {
  const $tags = $("#vecthare_keyword_tags");
  const keywords = browserState.availableKeywords;

  if (keywords.length === 0) {
    $tags.html('<span class="vecthare-keyword-hint">No keywords available</span>');
    return;
  }

  // Show top 30 keywords with counts
  const displayKeywords = keywords.slice(0, 30);
  const currentFilter = browserState.keywordFilter.toLowerCase().split(',').map(k => k.trim()).filter(Boolean);

  let html = displayKeywords.map(kw => {
    const isActive = currentFilter.includes(kw.text);
    return `<span class="vecthare-keyword-tag ${isActive ? 'active' : ''}"
                  data-keyword="${escapeHtml(kw.text)}"
                  title="${kw.count} occurrence(s)">
              ${escapeHtml(kw.text)} <small>(${kw.count})</small>
            </span>`;
  }).join('');

  if (keywords.length > 30) {
    html += `<span class="vecthare-keyword-more">+${keywords.length - 30} more</span>`;
  }

  $tags.html(html);

  // Bind click events on tags
  $tags.find(".vecthare-keyword-tag").off("click").on("click", function() {
    const keyword = $(this).data("keyword");
    toggleKeywordFilter(keyword);
  });
}

/**
 * Toggles a keyword in the filter
 */
function toggleKeywordFilter(keyword) {
  const currentFilter = browserState.keywordFilter.toLowerCase().split(',').map(k => k.trim()).filter(Boolean);
  const idx = currentFilter.indexOf(keyword.toLowerCase());

  if (idx >= 0) {
    currentFilter.splice(idx, 1);
  } else {
    currentFilter.push(keyword.toLowerCase());
  }

  browserState.keywordFilter = currentFilter.join(', ');
  $("#vecthare_keyword_filter").val(browserState.keywordFilter);
  renderKeywordTags();
}

/**
 * Clears the keyword filter
 */
function clearKeywordFilter() {
  browserState.keywordFilter = '';
  $("#vecthare_keyword_filter").val('');
  renderKeywordTags();
}

/**
 * Updates keyword filter from input field
 */
function updateKeywordFilterFromInput() {
  browserState.keywordFilter = $("#vecthare_keyword_filter").val();
  renderKeywordTags();
}

/**
 * Filters search results by keywords
 * @param {object} results Search results by collection
 * @returns {object} Filtered results
 */
function filterResultsByKeywords(results) {
  const filterKeywords = browserState.keywordFilter.toLowerCase()
    .split(',')
    .map(k => k.trim())
    .filter(Boolean);

  if (filterKeywords.length === 0) {
    return results;
  }

  const filtered = {};

  for (const [collectionId, collectionResults] of Object.entries(results)) {
    if (!collectionResults?.hashes?.length) continue;

    const filteredHashes = [];
    const filteredMetadata = [];

    for (let i = 0; i < collectionResults.hashes.length; i++) {
      const metadata = collectionResults.metadata?.[i] || {};
      const chunkKeywords = (metadata.keywords || []).map(kw =>
        (typeof kw === 'object' ? kw.text : kw)?.toLowerCase()
      ).filter(Boolean);

      // Check if chunk has ANY of the filter keywords
      const hasMatch = filterKeywords.some(fk => chunkKeywords.includes(fk));

      if (hasMatch) {
        filteredHashes.push(collectionResults.hashes[i]);
        filteredMetadata.push(metadata);
      }
    }

    if (filteredHashes.length > 0) {
      filtered[collectionId] = {
        hashes: filteredHashes,
        metadata: filteredMetadata
      };
    }
  }

  return filtered;
}

/**
 * Performs semantic search across collections
 */
async function performSearch() {
  const query = $("#vecthare_semantic_search").val().trim();
  if (!query) {
    toastr.warning("Please enter a search query", "VectHarePlus");
    return;
  }

  const topK = parseInt($("#vecthare_search_topk").val()) || 5;
  const threshold = parseFloat($("#vecthare_search_threshold").val()) || 0.3;
  const enabledOnly = $("#vecthare_search_enabled_only").is(":checked");

  // Get collection IDs to search
  let collectionIds = browserState.collections.map((c) => c.id);

  if (enabledOnly) {
    collectionIds = collectionIds.filter((id) => {
      const collection = browserState.collections.find((c) => c.id === id);
      return collection && collection.enabled;
    });
  }

  if (collectionIds.length === 0) {
    $("#vecthare_search_results").html(`
            <div class="vecthare-search-empty">
                ${icons.search(48)}
                <p>No collections available to search</p>
            </div>
        `);
    return;
  }

  // Show loading state
  browserState.isSearching = true;
  $("#vecthare_search_btn")
    .prop("disabled", true)
    .html(`${icons.search(16)} Searching...`);
  $("#vecthare_search_results").html(`
        <div class="vecthare-search-loading">
            <i class="fa-solid fa-spinner fa-spin"></i> Searching ${collectionIds.length} collections...
        </div>
    `);

  try {
    const results = await queryMultipleCollections(
      collectionIds,
      query,
      topK,
      threshold,
      browserState.settings,
    );

    browserState.searchResults = results;

    // Apply keyword filter if set
    const filteredResults = filterResultsByKeywords(results);
    renderSearchResults(filteredResults, query, results);
  } catch (error) {
    console.error("VectHare: Search failed", error);
    $("#vecthare_search_results").html(`
            <div class="vecthare-search-error">
                ${icons.x(24)} Search failed: ${error.message}
            </div>
        `);
  } finally {
    browserState.isSearching = false;
    $("#vecthare_search_btn")
      .prop("disabled", false)
      .html(`${icons.search(16)} Search`);
  }
}

/**
 * Renders search results
 * @param {object} results Results from queryMultipleCollections (possibly filtered)
 * @param {string} query Original search query
 * @param {object} originalResults Original unfiltered results (for showing filter info)
 */
function renderSearchResults(results, query, originalResults = null) {
  const collectionIds = Object.keys(results);
  const totalResults = collectionIds.reduce(
    (sum, id) => sum + (results[id]?.hashes?.length || 0),
    0,
  );

  // Calculate original counts if keyword filter was applied
  const wasFiltered = originalResults && browserState.keywordFilter.trim();
  const originalTotal = originalResults
    ? Object.keys(originalResults).reduce((sum, id) => sum + (originalResults[id]?.hashes?.length || 0), 0)
    : totalResults;

  if (totalResults === 0) {
    const filterMsg = wasFiltered
      ? `<p>No results match keyword filter: "${escapeHtml(browserState.keywordFilter)}"</p><small>${originalTotal} result(s) found before filtering</small>`
      : `<p>No results found for "${escapeHtml(query)}"</p><small>Try adjusting the score threshold or search in more collections</small>`;

    $("#vecthare_search_results").html(`
            <div class="vecthare-search-empty">
                ${icons.search(48)}
                ${filterMsg}
            </div>
        `);
    return;
  }

  let summaryHtml = `<div class="vecthare-search-summary">Found ${totalResults} result(s) in ${collectionIds.length} collection(s)`;
  if (wasFiltered) {
    summaryHtml += ` <span class="vecthare-filter-badge" title="Keyword filter active">🏷️ filtered from ${originalTotal}</span>`;
  }
  summaryHtml += `</div>`;

  let html = summaryHtml;

  for (const collectionId of collectionIds) {
    const collectionResults = results[collectionId];
    if (!collectionResults?.hashes?.length) continue;

    const collection = browserState.collections.find(
      (c) => c.id === collectionId,
    );
    const collectionName = collection?.name || collectionId;
    // Use registryKey for unique identification (source:id format)
    const uniqueKey = collection.registryKey || collection.id;

    html += `
            <div class="vecthare-search-collection">
                <div class="vecthare-search-collection-header">
                    ${icons.folder(16)} ${escapeHtml(collectionName)}
                    <span class="vecthare-search-count">${collectionResults.hashes.length} result(s)</span>
                </div>
                <div class="vecthare-search-collection-results">
        `;

    for (let i = 0; i < collectionResults.hashes.length; i++) {
      const metadata = collectionResults.metadata?.[i] || {};
      const score =
        metadata.score !== undefined ? (metadata.score * 100).toFixed(1) : "?";
      const text = metadata.text || `[Hash: ${collectionResults.hashes[i]}]`;
      const preview = text.length > 200 ? text.substring(0, 200) + "..." : text;

      // Build score breakdown for hybrid search results
      const vectorScore = metadata.vectorScore !== undefined ? (metadata.vectorScore * 100).toFixed(0) : null;
      const textScore = metadata.textScore !== undefined ? (metadata.textScore * 100).toFixed(0) : null;
      const isHybrid = metadata.hybridSearch || (vectorScore !== null && textScore !== null);

      let scoreDisplay = `<div class="vecthare-search-result-score">${score}%</div>`;
      if (isHybrid) {
        scoreDisplay = `
          <div class="vecthare-search-result-score-hybrid">
            <div class="vecthare-score-main">${score}%</div>
            <div class="vecthare-score-breakdown">
              <span class="vecthare-score-vector" title="Semantic similarity">🔷${vectorScore || '?'}%</span>
              <span class="vecthare-score-text" title="Keyword match">📝${textScore || '0'}%</span>
            </div>
          </div>`;
      }

      // Build keywords display
      const chunkKeywords = metadata.keywords || [];
      let keywordsHtml = '';
      if (chunkKeywords.length > 0) {
        const keywordTags = chunkKeywords.slice(0, 5).map(kw => {
          const text = typeof kw === 'object' ? kw.text : kw;
          return `<span class="vecthare-result-keyword">${escapeHtml(text)}</span>`;
        }).join('');
        const moreCount = chunkKeywords.length > 5 ? `<span class="vecthare-result-keyword-more">+${chunkKeywords.length - 5}</span>` : '';
        keywordsHtml = `<div class="vecthare-result-keywords">${keywordTags}${moreCount}</div>`;
      }

      html += `
                <div class="vecthare-search-result" data-collection="${collectionId}" data-hash="${collectionResults.hashes[i]}">
                    ${scoreDisplay}
                    <div class="vecthare-search-result-content">
                        <div class="vecthare-search-result-text">${escapeHtml(preview)}</div>
                        ${keywordsHtml}
                    </div>
                </div>

                <button class="vecthare-btn-sm vecthare-action-visualize"
                        data-collection-key="${uniqueKey}"
                        data-backend="${collection.backend}"
                        data-source="${collection.source || "transformers"}"
                        title="View and edit chunks in this collection">
                    ${icons.eye(16)} View Chunks
                </button>
            `;
    }

    html += `</div></div>`;
  }

  $("#vecthare_search_results").html(html);
  // sloppy, temporary fix to replicate OG chunk link functionality (1091)
  $(".vecthare-action-visualize")
    .off("click")
    .on("click", async function (e) {
      console.log("test");
      e.stopPropagation();
      const collectionKey = $(this).data("collection-key");
      const collection = findCollectionByKey(collectionKey);

      if (!collection) return;

      try {
        toastr.info("Loading chunks...", "VectHarePlus");

        // Use the collection's actual backend, not the global setting
        // This ensures we query Standard collections with Standard backend, etc.
        if (!collection.backend) {
          toastr.error(
            "Collection has no backend defined - this is a bug",
            "VectHarePlus",
          );
          console.error("VectHare: Collection missing backend:", collection);
          return;
        }

        const collectionSettings = {
          ...browserState.settings,
          vector_backend: collection.backend,
        };

        // Use unified plugin endpoint
        const response = await fetch("/api/plugins/similharity/chunks/list", {
          method: "POST",
          headers: getRequestHeaders(),
          body: JSON.stringify({
            backend: collection.backend || "vectra",
            collectionId: collection.id,
            source: collection.source || "transformers",
            model: collection.model || "",
            limit: 1000, // Get first 1000 chunks
          }),
        });

        if (!response.ok) {
          throw new Error(`Failed to list chunks: ${response.statusText}`);
        }

        const data = await response.json();
        const results = data.items || [];

        if (!results || results.length === 0) {
          toastr.warning("No chunks found in this collection", "VectHarePlus");
          return;
        }

        // Format chunks for visualizer
        const chunks = results.map((item, idx) => ({
          hash: item.hash,
          index: item.index ?? idx,
          text: item.text || item.metadata?.text || "No text available",
          score: 1.0,
          similarity: 1.0,
          messageAge: item.metadata?.messageAge,
          decayApplied: false,
          decayMultiplier: 1.0,
          metadata: item.metadata, // Pass through all metadata including keywords
        }));

        // Pass collection-specific settings so visualizer uses correct backend for edits/deletes
        // Include collection type so visualizer knows if this is a chat (for Scenes tab)
        openVisualizer(
          { chunks, collectionType: collection.type },
          collection.id,
          collectionSettings,
        );
      } catch (error) {
        console.error("VectHare: Failed to load chunks", error);
        toastr.error(`Failed to load chunks: ${error.message}`, "VectHarePlus");
      }
    });
}

// ============================================================================
// BULK OPERATIONS TAB FUNCTIONS
// ============================================================================

/**
 * Renders bulk operations list
 */
function renderBulkList() {
  const filter = browserState.bulkFilter;
  let collections = [...browserState.collections];

  // Apply filter
  if (filter === "enabled") {
    collections = collections.filter((c) => c.enabled);
  } else if (filter === "disabled") {
    collections = collections.filter((c) => !c.enabled);
  }

  if (collections.length === 0) {
    $("#vecthare_bulk_list").html(`
            <div class="vecthare-bulk-empty">
                ${icons.folder(48)}
                <p>No collections match the current filter</p>
            </div>
        `);
    return;
  }

  let html = "";
  for (const collection of collections) {
    const uniqueKey = collection.registryKey || collection.id;
    const isSelected = browserState.bulkSelected.has(uniqueKey);

    html += `
            <div class="vecthare-bulk-item ${isSelected ? "selected" : ""}" data-key="${uniqueKey}">
                <label class="vecthare-bulk-checkbox">
                    <input type="checkbox" ${isSelected ? "checked" : ""} data-key="${uniqueKey}">
                </label>
                <div class="vecthare-bulk-item-info">
                    <span class="vecthare-bulk-item-name">${escapeHtml(collection.name || collection.id)}</span>
                    <span class="vecthare-bulk-item-meta">
                        ${collection.chunkCount || 0} chunks •
                        ${collection.enabled ? `${icons.toggleRight(12)} Enabled` : `${icons.toggleLeft(12)} Disabled`}
                    </span>
                </div>
            </div>
        `;
  }

  $("#vecthare_bulk_list").html(html);
  updateBulkCount();
}

/**
 * Binds bulk operations events
 */
function bindBulkEvents() {
  if (bulkEventsBound) return;
  bulkEventsBound = true;

  // Filter change
  $("#vecthare_bulk_filter")
    .off("change")
    .on("change", function () {
      browserState.bulkFilter = $(this).val();
      browserState.bulkSelected.clear();
      renderBulkList();
    });

  // Select all checkbox
  $("#vecthare_bulk_select_all")
    .off("change")
    .on("change", function () {
      const isChecked = $(this).is(":checked");
      const filter = browserState.bulkFilter;
      let collections = [...browserState.collections];

      if (filter === "enabled") {
        collections = collections.filter((c) => c.enabled);
      } else if (filter === "disabled") {
        collections = collections.filter((c) => !c.enabled);
      }

      browserState.bulkSelected.clear();
      if (isChecked) {
        collections.forEach((c) =>
          browserState.bulkSelected.add(c.registryKey || c.id),
        );
      }

      renderBulkList();
    });

  // Individual checkbox clicks (delegated)
  $("#vecthare_bulk_list")
    .off("change", 'input[type="checkbox"]')
    .on("change", 'input[type="checkbox"]', function () {
      const key = $(this).data("key");
      if ($(this).is(":checked")) {
        browserState.bulkSelected.add(key);
      } else {
        browserState.bulkSelected.delete(key);
      }
      updateBulkCount();
      $(this)
        .closest(".vecthare-bulk-item")
        .toggleClass("selected", $(this).is(":checked"));
    });

  // Bulk enable
  $("#vecthare_bulk_enable")
    .off("click")
    .on("click", async function () {
      if (browserState.bulkSelected.size === 0) return;

      for (const key of browserState.bulkSelected) {
        setCollectionEnabled(key, true);
        const collection = browserState.collections.find(
          (c) => (c.registryKey || c.id) === key,
        );
        if (collection) collection.enabled = true;
      }

      toastr.success(
        `Enabled ${browserState.bulkSelected.size} collection(s)`,
        "VectHarePlus",
      );
      renderBulkList();
      renderCollections();
    });

  // Bulk disable
  $("#vecthare_bulk_disable")
    .off("click")
    .on("click", async function () {
      if (browserState.bulkSelected.size === 0) return;

      for (const key of browserState.bulkSelected) {
        setCollectionEnabled(key, false);
        const collection = browserState.collections.find(
          (c) => (c.registryKey || c.id) === key,
        );
        if (collection) collection.enabled = false;
      }

      toastr.success(
        `Disabled ${browserState.bulkSelected.size} collection(s)`,
        "VectHarePlus",
      );
      renderBulkList();
      renderCollections();
    });

  // Bulk export
  $("#vecthare_bulk_export")
    .off("click")
    .on("click", async function () {
      if (browserState.bulkSelected.size === 0) return;

      const confirmed = confirm(
        `Export ${browserState.bulkSelected.size} collection(s)?\n\nEach collection will be downloaded as a separate file.`,
      );
      if (!confirmed) return;

      toastr.info(
        `Exporting ${browserState.bulkSelected.size} collection(s)...`,
        "VectHarePlus",
      );

      let successCount = 0;
      for (const key of browserState.bulkSelected) {
        const collection = browserState.collections.find(
          (c) => (c.registryKey || c.id) === key,
        );
        if (!collection) continue;

        try {
          const exportData = await exportCollection(
            collection.id,
            browserState.settings,
            {
              backend: collection.backend,
              source: collection.source || "transformers",
              model: collection.model || "",
            },
          );

          downloadExport(exportData, collection.name || collection.id);
          successCount++;
        } catch (error) {
          console.error(`VectHare: Failed to export ${collection.id}`, error);
        }
      }

      toastr.success(`Exported ${successCount} collection(s)`, "VectHarePlus");
    });

  // Bulk delete - uses unified deleteCollection()
  $("#vecthare_bulk_delete")
    .off("click")
    .on("click", async function () {
      if (browserState.bulkSelected.size === 0) return;

      const confirmed = confirm(
        `⚠️ DELETE ${browserState.bulkSelected.size} COLLECTION(S)?\n\n` +
          `This will permanently delete all vectors in these collections.\n` +
          `This action CANNOT be undone!\n\n` +
          `Type "DELETE" to confirm.`,
      );

      if (!confirmed) return;

      const confirmText = prompt("Type DELETE to confirm:");
      if (confirmText !== "DELETE") {
        toastr.info("Deletion cancelled", "VectHarePlus");
        return;
      }

      toastr.info(
        `Deleting ${browserState.bulkSelected.size} collection(s)...`,
        "VectHarePlus",
      );

      let successCount = 0;
      let partialCount = 0;
      for (const key of browserState.bulkSelected) {
        const collection = browserState.collections.find(
          (c) => (c.registryKey || c.id) === key,
        );
        if (!collection) continue;

        try {
          const collectionSettings = {
            ...browserState.settings,
            vector_backend: collection.backend,
            source: collection.source,
          };
          const result = await deleteCollection(
            collection.id,
            collectionSettings,
            collection.registryKey,
          );
          if (result.success) {
            successCount++;
          } else {
            partialCount++;
          }
        } catch (error) {
          console.error(`VectHare: Failed to delete ${collection.id}`, error);
        }
      }

      browserState.bulkSelected.clear();
      await refreshCollections();
      renderBulkList();

      if (partialCount > 0) {
        toastr.warning(
          `Deleted ${successCount}, partial: ${partialCount}`,
          "VectHarePlus",
        );
      } else {
        toastr.success(`Deleted ${successCount} collection(s)`, "VectHarePlus");
      }
    });
}

/**
 * Updates bulk selection count and button states
 */
function updateBulkCount() {
  const count = browserState.bulkSelected.size;
  $("#vecthare_bulk_count").text(`${count} selected`);

  // Enable/disable buttons based on selection
  const hasSelection = count > 0;
  $(
    "#vecthare_bulk_enable, #vecthare_bulk_disable, #vecthare_bulk_export, #vecthare_bulk_delete",
  ).prop("disabled", !hasSelection);
}

// ============================================================================
// COLLECTION LOCK MANAGEMENT DIALOG
// ============================================================================

/**
 * Opens a dialog to manage locks for a collection (add/remove multiple chats)
 * @param {string} collectionId
 */
function openCollectionLockDialog(collectionId) {
    const locks = getCollectionLocks(collectionId);
    const characterLocks = getCollectionCharacterLocks(collectionId);
    const currentChatId = getCurrentChatId();
    const context = getContext();
    const currentCharacterId = context?.characterId || null;
    const characters = context?.characters || [];

    // Build HTML for locked chats
    const locksHtml = locks.length === 0
        ? '<div class="vecthare-lock-list-empty">No chats locked yet</div>'
        : locks.map((chatId) => `
            <div class="vecthare-lock-item" data-chat-id="${chatId}">
                <span class="vecthare-lock-chat-id" title="${chatId}">${chatId}</span>
                <div class="vecthare-lock-item-actions">
                    ${String(chatId) === String(currentChatId) ? '<span class="vecthare-lock-badge-current">Current</span>' : ''}
                    <button class="vecthare-lock-remove-btn" data-chat-id="${chatId}" title="Remove lock">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>
            </div>
        `).join('');

    // Build HTML for locked characters
    const charLocksHtml = characterLocks.length === 0
        ? '<div class="vecthare-lock-list-empty">No characters locked yet</div>'
        : characterLocks.map((charId) => {
            const charName = characters[charId]?.data?.name || `Character ${charId}`;
            return `
                <div class="vecthare-lock-item" data-character-id="${charId}">
                    <span class="vecthare-lock-character-name">
                        <i class="fa-solid fa-user"></i>
                        ${charName}
                    </span>
                    <div class="vecthare-lock-item-actions">
                        ${String(charId) === String(currentCharacterId) ? '<span class="vecthare-lock-badge-current">Active</span>' : ''}
                        <button class="vecthare-lock-remove-char-btn" data-character-id="${charId}" title="Remove lock">
                            <i class="fa-solid fa-trash"></i>
                        </button>
                    </div>
                </div>
            `;
        }).join('');

    // Generate hint text for chat section
    const chatHintClass = currentChatId && locks.includes(currentChatId) ? 'vecthare-lock-hint vecthare-lock-hint-success' : 'vecthare-lock-hint';
    const chatHintText = currentChatId
        ? locks.includes(currentChatId)
            ? '✓ Already locked to this chat'
            : 'Lock this collection to the current chat'
        : 'Open a chat first to lock this collection';

    // Generate hint text for character section
    const charHintClass = currentCharacterId && characterLocks.includes(currentCharacterId) ? 'vecthare-lock-hint vecthare-lock-hint-success' : 'vecthare-lock-hint';
    const charHintText = currentCharacterId
        ? characterLocks.includes(currentCharacterId)
            ? '✓ Already locked to this character'
            : 'Lock this collection to the current character'
        : 'No character currently active';

    const dialogHtml = `
        <div id="vecthare_lock_dialog" class="vecthare-modal" style="display: flex;">
            <div class="vecthare-modal-content vecthare-lock-dialog">
                <div class="vecthare-modal-header">
                    <h3><i class="fa-solid fa-lock"></i> Manage Collection Locks</h3>
                    <button class="vecthare-modal-close" data-action="close">
                        <i class="fa-solid fa-times"></i>
                    </button>
                </div>
                <div class="vecthare-modal-body">
                    <!-- Chat Locks Section -->
                    <div class="vecthare-lock-section">
                        <h4><i class="fa-solid fa-comments"></i> Chat Locks <span class="vecthare-badge vecthare-badge-muted">${locks.length}</span></h4>
                        <div class="vecthare-lock-list">
                            ${locksHtml}
                        </div>
                        <p class="${chatHintClass}">${chatHintText}</p>
                        <button id="vecthare_lock_add_current" class="vecthare-btn-sm vecthare-btn-primary" ${!currentChatId || locks.includes(currentChatId) ? 'disabled' : ''}>
                            <i class="fa-solid fa-plus"></i> Lock to Current Chat
                        </button>
                    </div>

                    <hr class="vecthare-lock-divider">

                    <!-- Character Locks Section -->
                    <div class="vecthare-lock-section">
                        <h4><i class="fa-solid fa-user"></i> Character Locks <span class="vecthare-badge vecthare-badge-muted">${characterLocks.length}</span></h4>
                        <div class="vecthare-lock-list">
                            ${charLocksHtml}
                        </div>
                        <p class="${charHintClass}">${charHintText}</p>
                        <button id="vecthare_lock_add_character" class="vecthare-btn-sm vecthare-btn-primary" ${!currentCharacterId || characterLocks.includes(currentCharacterId) ? 'disabled' : ''}>
                            <i class="fa-solid fa-plus"></i> Lock to Current Character
                        </button>
                    </div>
                </div>
                <div class="vecthare-modal-footer">
                    <button class="vecthare-btn" data-action="close">
                        <i class="fa-solid fa-check"></i> Done
                    </button>
                </div>
            </div>
        </div>
    `;

    const $dialog = $(dialogHtml);
    $('body').append($dialog);

    // Handle add lock button (chat)
    $('#vecthare_lock_add_current').on('click', function() {
        const chatId = getCurrentChatId();
        if (!chatId) {
            toastr.warning('Open a chat first');
            return;
        }

        setCollectionLock(collectionId, chatId);
        toastr.success('Collection locked to current chat', 'VectHare');

        // Re-open dialog with updated state
        $dialog.remove();
        refreshActivationLockButton();
        openCollectionLockDialog(collectionId);
    });

    // Handle add lock button (character)
    $('#vecthare_lock_add_character').on('click', function() {
        const context = getContext();
        const charId = context?.characterId;
        if (!charId) {
            toastr.warning('No character currently active');
            return;
        }

        setCollectionCharacterLock(collectionId, charId);
        toastr.success('Collection locked to current character', 'VectHare');

        // Re-open dialog with updated state
        $dialog.remove();
        refreshActivationLockButton();
        openCollectionLockDialog(collectionId);
    });

    // Handle remove lock buttons (chat)
    $dialog.find('.vecthare-lock-remove-btn').on('click', function(e) {
        e.stopPropagation();
        const chatId = $(this).data('chat-id');

        removeCollectionLock(collectionId, chatId);
        toastr.info('Removed lock from chat', 'VectHare');

        // Re-open dialog with updated state
        $dialog.remove();
        refreshActivationLockButton();
        openCollectionLockDialog(collectionId);
    });

    // Handle remove lock buttons (character)
    $dialog.find('.vecthare-lock-remove-char-btn').on('click', function(e) {
        e.stopPropagation();
        const charId = $(this).data('character-id');

        removeCollectionCharacterLock(collectionId, charId);
        toastr.info('Removed lock from character', 'VectHare');

        // Re-open dialog with updated state
        $dialog.remove();
        refreshActivationLockButton();
        openCollectionLockDialog(collectionId);
    });

    // Handle close button
    $dialog.find('[data-action="close"]').on('click', function(e) {
        e.preventDefault();
        $dialog.remove();
    });

    // Stop mousedown propagation (ST closes drawers on mousedown/touchstart)
    $dialog.on('mousedown touchstart', function(e) {
        e.stopPropagation();
    });

    // Close on background click
    $dialog.on('click', function(e) {
        if (e.target === this) {
            $dialog.remove();
        }
    });

    // Handle escape key
    $(document).one('keydown.lock_dialog', function(e) {
        if (e.key === 'Escape') {
            $dialog.remove();
        }
    });
}
