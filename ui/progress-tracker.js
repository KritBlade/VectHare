/**
 * ============================================================================
 * VECTHARE PROGRESS TRACKER
 * ============================================================================
 * Real-time progress panel for vectorization operations
 * Shows detailed status, progress bars, and live updates
 *
 * @author VectHare
 * @version 2.2.0-alpha
 * ============================================================================
 */

/**
 * Progress Tracker - Manages progress panel UI
 */
export class ProgressTracker {
    constructor() {
        this.panel = null;
        this.isVisible = false;
        this.currentOperation = null;
        this.timeIntervalId = null;
        this.isComplete = false;
        this.isCancelling = false;
        this.cancelHandler = null;
        // PERF: Cache DOM element references to avoid repeated getElementById calls
        this.elements = null;
        this.stats = {
            totalItems: 0,
            processedItems: 0,
            currentBatch: 0,
            totalBatches: 0,
            totalChunks: 0,
            embeddedChunks: 0,
            totalChunksToEmbed: 0,
            startTime: null,
            lastBatchTime: null,
            lastBatchSize: 0,
            lastBatchStartTime: null,
            errors: [],
        };
    }

    /**
     * Show progress panel
     * @param {string} operation - Operation name (e.g., "Vectorizing Chat", "Purging Index")
     * @param {number} totalItems - Total number of items to process
     * @param {string} itemLabel - Label for items (e.g., "Messages", "Steps", "Entries")
     */
    show(operation, totalItems = 0, itemLabel = 'Progress') {
        this.currentOperation = operation;
        this.isComplete = false;
        this.isCancelling = false;
        this.stats = {
            totalItems: totalItems,
            processedItems: 0,
            currentBatch: 0,
            totalBatches: 0,
            totalChunks: 0,
            embeddedChunks: 0,
            totalChunksToEmbed: 0,
            startTime: Date.now(),
            lastBatchTime: null,
            lastBatchSize: 0,
            lastBatchStartTime: Date.now(),
            errors: [],
        };

        if (!this.panel) {
            this.createPanel();
        }

        // Set the item label using cached element
        if (this.elements?.statLabel) {
            this.elements.statLabel.textContent = itemLabel;
        }

        // Start/restart time updater
        this.startTimeUpdater();

        this.updateDisplay();
        this.panel.style.display = 'block';
        this.isVisible = true;

        // Reflect current cancel capability whenever panel is shown.
        this.refreshCancelButton();
    }

    /**
     * Hide progress panel
     */
    hide() {
        if (this.panel) {
            this.panel.style.display = 'none';
        }
        this.isVisible = false;
        this.currentOperation = null;
        this.isCancelling = false;
        // Do NOT clear cancelHandler here — an operation may still be running.
        // clearCancelHandler() is called by complete() when the operation finishes.
        this.refreshCancelButton();
    }

    /**
     * Set cancellation callback for the current operation.
     * @param {Function|null} handler - Callback invoked when user clicks Stop
     */
    setCancelHandler(handler) {
        this.cancelHandler = typeof handler === 'function' ? handler : null;
        this.refreshCancelButton();
    }

    /**
     * Clear cancellation callback.
     */
    clearCancelHandler() {
        this.cancelHandler = null;
        this.refreshCancelButton();
    }

    /**
     * Trigger cancellation for the active operation.
     */
    requestCancel() {
        if (!this.cancelHandler || this.isComplete || this.isCancelling) return;
        this.isCancelling = true;
        this.updateDisplay('Stopping...');

        try {
            this.cancelHandler();
        } catch (error) {
            this.addError(`Stop failed: ${error?.message || error}`);
            this.isCancelling = false;
        }

        this.refreshCancelButton();
    }

    /**
     * Show/hide and enable/disable the Stop button based on operation state.
     */
    refreshCancelButton() {
        const stopBtn = this.elements?.stopBtn;
        if (!stopBtn) return;

        const canStop = !!this.cancelHandler && this.isVisible && !this.isComplete;
        stopBtn.style.display = canStop ? 'inline-flex' : 'none';
        stopBtn.disabled = !canStop || this.isCancelling;
        stopBtn.innerHTML = this.isCancelling
            ? '<i class="fa-solid fa-spinner fa-spin"></i> Stopping...'
            : '<i class="fa-solid fa-stop"></i> Stop';
    }

    /**
     * Update progress
     * @param {number} processedItems - Number of items processed so far
     * @param {string} status - Current status message
     */
    updateProgress(processedItems, status = '') {
        this.stats.processedItems = processedItems;
        this.updateDisplay(status);
    }

    /**
     * Update batch progress
     * @param {number} currentBatch - Current batch number
     * @param {number} totalBatches - Total number of batches
     */
    updateBatch(currentBatch, totalBatches) {
        this.stats.currentBatch = currentBatch;
        this.stats.totalBatches = totalBatches;
        this.updateDisplay();
    }

    /**
     * Update chunk count (for showing message → chunk splitting)
     * @param {number} totalChunks - Total chunks created from messages
     */
    updateChunks(totalChunks) {
        this.stats.totalChunks = totalChunks;
        this.updateDisplay();
    }

    /**
     * Update embedding progress (for showing embedded/remaining chunks)
     * @param {number} embeddedChunks - Number of chunks embedded so far
     * @param {number} totalChunksToEmbed - Total chunks to embed
     */
    updateEmbeddingProgress(embeddedChunks, totalChunksToEmbed) {
        console.log(`[ProgressTracker] updateEmbeddingProgress: ${embeddedChunks}/${totalChunksToEmbed}`);
        
        // Track batch timing for speed calculation
        const previousEmbedded = this.stats.embeddedChunks || 0;
        const batchSize = embeddedChunks - previousEmbedded;
        
        if (batchSize > 0 && this.stats.lastBatchStartTime) {
            const now = Date.now();
            this.stats.lastBatchTime = now - this.stats.lastBatchStartTime;
            this.stats.lastBatchSize = batchSize;
            this.stats.lastBatchStartTime = now; // Reset for next batch
            console.log(`[ProgressTracker] Batch completed: ${batchSize} chunks in ${this.stats.lastBatchTime}ms`);
        }
        
        this.stats.embeddedChunks = embeddedChunks;
        this.stats.totalChunksToEmbed = totalChunksToEmbed;
        this.updateDisplay();
    }

    /**
     * Update current item being processed (e.g., "Message 3, Chunk 2/5")
        this.stats.embeddedChunks = embeddedChunks;
        this.stats.totalChunksToEmbed = totalChunksToEmbed;
        this.updateDisplay();
    }

    /**
     * Update current item being processed (e.g., "Message 3, Chunk 2/5")
     * @param {string} text - Current item description
     */
    updateCurrentItem(text) {
        // PERF: Use cached element references
        const el = this.elements?.current;
        const textEl = this.elements?.currentText;
        if (el && textEl) {
            if (text) {
                textEl.textContent = text;
                el.style.display = 'block';
            } else {
                el.style.display = 'none';
            }
        }
    }

    /**
     * Add error to tracker
     * @param {string} error - Error message
     */
    addError(error) {
        this.stats.errors.push({
            message: error,
            timestamp: Date.now(),
        });
        this.updateDisplay();
    }

    /**
     * Complete operation
     * @param {boolean} success - Whether operation succeeded
     * @param {string} message - Completion message
     */
    complete(success, message = '') {
        this.isComplete = true;
        this.isCancelling = false;
        this.clearCancelHandler();

        // Stop the time updater
        if (this.timeIntervalId) {
            clearInterval(this.timeIntervalId);
            this.timeIntervalId = null;
        }

        const duration = Date.now() - this.stats.startTime;
        const seconds = (duration / 1000).toFixed(1);

        const completionMessage = success
            ? `✅ ${message || 'Operation completed successfully'} (${seconds}s)`
            : `❌ ${message || 'Operation failed'} (${seconds}s)`;

        this.updateDisplay(completionMessage);

        // Don't auto-hide - let user close manually
    }

    /**
     * Reopen the progress panel if it was previously created.
     * @returns {boolean} true if the panel was reopened
     */
    reopen() {
        if (!this.panel) return false;
        this.panel.style.display = 'block';
        this.isVisible = true;
        this.refreshCancelButton();
        return true;
    }

    /**
     * Create progress panel HTML
     */
    createPanel() {
        const panelHTML = `
            <div id="vecthare_progress_panel" class="vecthare-progress-panel">
                <div class="vecthare-progress-header">
                    <h3 id="vecthare_progress_title">VectHare Progress</h3>
                    <div class="vecthare-progress-actions">
                        <button id="vecthare_progress_stop" class="vecthare-progress-stop" style="display: none;">
                            <i class="fa-solid fa-stop"></i> Stop
                        </button>
                        <button id="vecthare_progress_close" class="vecthare-progress-close">
                            <i class="fa-solid fa-times"></i>
                        </button>
                    </div>
                </div>
                <div class="vecthare-progress-body">
                    <!-- Main Progress Bar -->
                    <div class="vecthare-progress-section">
                        <div class="vecthare-progress-label">
                            <span id="vecthare_progress_status">Initializing...</span>
                            <span id="vecthare_progress_percent">0%</span>
                        </div>
                        <div class="vecthare-progress-bar-container">
                            <div id="vecthare_progress_bar" class="vecthare-progress-bar" style="width: 0%"></div>
                        </div>
                    </div>

                    <!-- Current Item Progress -->
                    <div id="vecthare_progress_current" class="vecthare-progress-current" style="display: none;">
                        <span id="vecthare_progress_current_text">Processing...</span>
                    </div>

                    <!-- Stats Grid -->
                    <div class="vecthare-progress-stats">
                        <div class="vecthare-progress-stat">
                            <div id="vecthare_progress_stat_label" class="vecthare-progress-stat-label">Progress</div>
                            <div id="vecthare_progress_processed" class="vecthare-progress-stat-value">0 / 0</div>
                        </div>
                        <div class="vecthare-progress-stat">
                            <div class="vecthare-progress-stat-label">Chunks</div>
                            <div id="vecthare_progress_chunks" class="vecthare-progress-stat-value">0</div>
                        </div>
                        <div class="vecthare-progress-stat">
                            <div class="vecthare-progress-stat-label">Time</div>
                            <div id="vecthare_progress_time" class="vecthare-progress-stat-value">0.0s</div>
                        </div>
                        <div class="vecthare-progress-stat">
                            <div class="vecthare-progress-stat-label">Speed</div>
                            <div id="vecthare_progress_speed" class="vecthare-progress-stat-value">0/s</div>
                        </div>
                    </div>

                    <!-- Errors (hidden by default) -->
                    <div id="vecthare_progress_errors" class="vecthare-progress-errors" style="display: none;">
                        <div class="vecthare-progress-errors-header">
                            <i class="fa-solid fa-exclamation-triangle"></i>
                            <span>Errors</span>
                        </div>
                        <div id="vecthare_progress_errors_list" class="vecthare-progress-errors-list"></div>
                    </div>
                </div>
            </div>
        `;

        // Insert panel into DOM
        const container = document.createElement('div');
        container.innerHTML = panelHTML;
        document.body.appendChild(container.firstElementChild);

        this.panel = document.getElementById('vecthare_progress_panel');

        // PERF: Cache all DOM element references to avoid repeated getElementById calls
        this.elements = {
            title: document.getElementById('vecthare_progress_title'),
            status: document.getElementById('vecthare_progress_status'),
            percent: document.getElementById('vecthare_progress_percent'),
            bar: document.getElementById('vecthare_progress_bar'),
            processed: document.getElementById('vecthare_progress_processed'),
            chunks: document.getElementById('vecthare_progress_chunks'),
            time: document.getElementById('vecthare_progress_time'),
            speed: document.getElementById('vecthare_progress_speed'),
            current: document.getElementById('vecthare_progress_current'),
            currentText: document.getElementById('vecthare_progress_current_text'),
            statLabel: document.getElementById('vecthare_progress_stat_label'),
            errors: document.getElementById('vecthare_progress_errors'),
            errorsList: document.getElementById('vecthare_progress_errors_list'),
            stopBtn: document.getElementById('vecthare_progress_stop'),
            closeBtn: document.getElementById('vecthare_progress_close'),
        };

        if (this.elements.stopBtn) {
            this.elements.stopBtn.addEventListener('click', () => this.requestCancel());
        }

        // Bind close button
        this.elements.closeBtn.addEventListener('click', () => {
            this.hide();
        });

        // Start time update interval
        this.startTimeUpdater();
    }

    /**
     * Update display with current stats
     * @param {string} statusOverride - Override status message
     */
    updateDisplay(statusOverride = '') {
        if (!this.panel || !this.isVisible || !this.elements) return;

        // Calculate progress percentage
        // Prioritize embedding progress if available, otherwise use processed items
        let percent = 0;
        if (this.stats.totalChunksToEmbed > 0 && this.stats.embeddedChunks >= 0) {
            percent = Math.round((this.stats.embeddedChunks / this.stats.totalChunksToEmbed) * 100);
            console.log(`[ProgressTracker] Progress bar: ${this.stats.embeddedChunks}/${this.stats.totalChunksToEmbed} = ${percent}%`);
        } else if (this.stats.totalItems > 0) {
            percent = Math.round((this.stats.processedItems / this.stats.totalItems) * 100);
        }

        // PERF: Use cached element references instead of repeated getElementById calls
        const els = this.elements;

        // Update title
        if (els.title) els.title.textContent = this.currentOperation || 'VectHare Progress';

        // Update status
        const status = statusOverride || this.generateStatusMessage();
        if (els.status) els.status.textContent = status;

        // Update progress bar
        if (els.percent) els.percent.textContent = `${percent}%`;
        if (els.bar) els.bar.style.width = `${percent}%`;

        // Update stats
        if (els.processed) {
            els.processed.textContent = `${this.stats.processedItems} / ${this.stats.totalItems}`;
        }

        // Show chunks - with embedding progress if available
        if (els.chunks) {
            if (this.stats.totalChunksToEmbed > 0) {
                // Show embedding progress: "45/100 (55 left)"
                const remaining = this.stats.totalChunksToEmbed - this.stats.embeddedChunks;
                const displayText = `${this.stats.embeddedChunks}/${this.stats.totalChunksToEmbed} (${remaining} left)`;
                console.log(`[ProgressTracker] Updating chunks display with embedding progress: "${displayText}"`);
                els.chunks.textContent = displayText;
            } else if (this.stats.totalChunks > this.stats.processedItems && this.stats.processedItems > 0) {
                // Messages are being split into multiple chunks
                const avgChunks = (this.stats.totalChunks / this.stats.processedItems).toFixed(1);
                els.chunks.textContent = `${this.stats.totalChunks} (~${avgChunks}/msg)`;
            } else {
                els.chunks.textContent = `${this.stats.totalChunks}`;
            }
        }

        // Calculate speed based on last batch timing (more accurate for streaming)
        let speed = '0.0';
        if (this.stats.lastBatchTime && this.stats.lastBatchSize > 0) {
            // Use last batch performance for real-time speed
            const batchSpeed = (this.stats.lastBatchSize / (this.stats.lastBatchTime / 1000)).toFixed(1);
            speed = batchSpeed;
        } else if (this.stats.embeddedChunks > 0 && this.stats.startTime) {
            // Fallback to average speed
            const elapsed = (Date.now() - this.stats.startTime) / 1000;
            speed = elapsed > 0 ? (this.stats.embeddedChunks / elapsed).toFixed(1) : '0.0';
        }
        if (els.speed) els.speed.textContent = `${speed}/s`;

        // Show/hide errors
        if (this.stats.errors.length > 0) {
            this.updateErrorsList();
            if (els.errors) els.errors.style.display = 'block';
        }
    }

    /**
     * Generate status message based on current state
     */
    generateStatusMessage() {
        if (this.stats.processedItems === 0) {
            return 'Starting...';
        } else if (this.stats.totalChunksToEmbed > 0 && this.stats.embeddedChunks >= 0) {
            // Streaming approach: embedding and writing happen together
            const progressPercent = (this.stats.embeddedChunks / this.stats.totalChunksToEmbed) * 100;
            if (this.isCancelling) {
                return 'Stopping...';
            }
            if (progressPercent < 100) {
                return 'Processing chunks...';
            } else {
                return 'Finalizing...';
            }
        } else if (this.stats.processedItems >= this.stats.totalItems) {
            return 'Finalizing...';
        } else if (this.stats.totalBatches > 0) {
            return `Processing batch ${this.stats.currentBatch}/${this.stats.totalBatches}`;
        } else {
            return `Processing items...`;
        }
    }

    /**
     * Update errors list display
     */
    updateErrorsList() {
        // PERF: Use cached element reference
        const errorsList = this.elements?.errorsList;
        if (errorsList) {
            errorsList.innerHTML = this.stats.errors
                .map(err => `<div class="vecthare-progress-error-item">${err.message}</div>`)
                .join('');
        }
    }

    /**
     * Start interval to update elapsed time
     */
    startTimeUpdater() {
        // Clear any existing interval first
        if (this.timeIntervalId) {
            clearInterval(this.timeIntervalId);
        }

        this.timeIntervalId = setInterval(() => {
            // Only update if visible, not complete, and has start time
            if (this.isVisible && !this.isComplete && this.stats.startTime) {
                const elapsed = ((Date.now() - this.stats.startTime) / 1000).toFixed(1);
                // PERF: Use cached element reference
                if (this.elements?.time) {
                    this.elements.time.textContent = `${elapsed}s`;
                }
            }
        }, 100);
    }
}

// Export singleton instance
export const progressTracker = new ProgressTracker();
