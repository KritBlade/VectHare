/**
 * ============================================================================
 * VectFox SEARCH DEBUG MODAL
 * ============================================================================
 * Shows detailed breakdown of the last RAG query pipeline:
 * - Query text used
 * - Initial vector search results
 * - Temporal decay effects
 * - Condition filtering
 * - Final injection results
 *
 * @author Kritblade
 * @version 3.3.1
 * ============================================================================
 */

// ============================================================================
// STATE
// ============================================================================

let lastDebugData = null;
const queryHistory = []; // Store last N queries
const MAX_QUERY_HISTORY = 13;

// ============================================================================
// DATA STRUCTURE
// ============================================================================

/**
 * Structure for debug data - populated during RAG pipeline
 * @typedef {Object} SearchDebugData
 * @property {string} query - The query text used
 * @property {number} timestamp - When the search was performed
 * @property {string} collectionId - Collection that was searched
 * @property {Object} settings - Settings used for the search
 * @property {Object} stages - Data from each pipeline stage
 * @property {Array} stages.initial - Chunks from initial vector query
 * @property {Array} stages.afterDecay - Chunks after temporal decay
 * @property {Array} stages.afterConditions - Chunks after condition filtering
 * @property {Array} stages.injected - Chunks that were actually injected
 * @property {Object} stats - Summary statistics
 */

/**
 * Creates empty debug data structure with full tracing support
 * @returns {SearchDebugData}
 */
export function createDebugData() {
    return {
        query: '',
        timestamp: Date.now(),
        collectionId: null,
        settings: {},
        stages: {
            initial: [],
            afterThreshold: [],
            afterDecay: [],
            afterConditions: [],
            injected: []
        },
        // Detailed trace log - every operation recorded
        trace: [],
        // Per-chunk tracking - what happened to each chunk
        chunkFates: {},
        stats: {
            totalInCollection: 0,
            retrievedFromVector: 0,
            passedThreshold: 0,
            afterDecay: 0,
            afterConditions: 0,
            actuallyInjected: 0,
            skippedDuplicates: 0,
            tokensBudget: 0,
            tokensUsed: 0
        }
    };
}

/**
 * Adds a trace entry to debug data
 * @param {SearchDebugData} debugData
 * @param {string} stage - Pipeline stage name
 * @param {string} action - What happened
 * @param {Object} details - Additional details
 */
export function addTrace(debugData, stage, action, details = {}) {
    if (!debugData.trace) debugData.trace = [];
    debugData.trace.push({
        time: Date.now(),
        stage,
        action,
        ...details
    });
}

/**
 * Records the fate of a specific chunk
 * @param {SearchDebugData} debugData
 * @param {string} hash - Chunk hash
 * @param {string} stage - Where it was dropped/passed
 * @param {string} fate - 'passed' | 'dropped'
 * @param {string} reason - Why it was dropped (if dropped)
 * @param {Object} data - Additional data (scores, etc)
 */
export function recordChunkFate(debugData, hash, stage, fate, reason = null, data = {}) {
    if (!debugData.chunkFates) debugData.chunkFates = {};
    if (!debugData.chunkFates[hash]) {
        debugData.chunkFates[hash] = {
            hash,
            stages: [],
            finalFate: null,
            finalReason: null
        };
    }

    debugData.chunkFates[hash].stages.push({
        stage,
        fate,
        reason,
        ...data
    });

    // Update final fate if dropped
    if (fate === 'dropped') {
        debugData.chunkFates[hash].finalFate = 'dropped';
        debugData.chunkFates[hash].finalReason = reason;
        debugData.chunkFates[hash].droppedAt = stage;
    } else if (fate === 'injected') {
        debugData.chunkFates[hash].finalFate = 'injected';
    }
}

/**
 * Stores debug data for the last search
 * @param {SearchDebugData} data
 */
export function setLastSearchDebug(data) {
    lastDebugData = data;

    // Add to history (most recent first)
    queryHistory.unshift(data);

    // Keep only last N queries
    if (queryHistory.length > MAX_QUERY_HISTORY) {
        queryHistory.pop();
    }

    console.log('VectFox Debug: Stored search debug data', {
        query: data.query?.substring(0, 50) + '...',
        stages: {
            initial: data.stages.initial.length,
            afterDecay: data.stages.afterDecay.length,
            afterConditions: data.stages.afterConditions.length,
            injected: data.stages.injected.length
        },
        historyCount: queryHistory.length
    });
}

/**
 * Gets the query history
 * @returns {Array<SearchDebugData>}
 */
export function getQueryHistory() {
    return queryHistory;
}

/**
 * Gets the last search debug data
 * @returns {SearchDebugData|null}
 */
export function getLastSearchDebug() {
    return lastDebugData;
}

// ============================================================================
// MODAL UI
// ============================================================================

/**
 * Opens the search debug modal
 */
export function openSearchDebugModal() {
    if (!lastDebugData) {
        toastr.info('No search has been performed yet. Send a message to trigger a RAG query.', 'VectFox');
        return;
    }

    // Remove existing modal
    $('#VectFox_search_debug_modal').remove();

    const html = createModalHtml(lastDebugData);
    $('body').append(html);

    bindEvents();
    $('#VectFox_search_debug_modal').fadeIn(200);
}

/**
 * Closes the search debug modal
 */
export function closeSearchDebugModal() {
    $('#VectFox_search_debug_modal').fadeOut(200, function() {
        $(this).remove();
    });
}

/**
 * Creates the modal HTML
 * @param {SearchDebugData} data
 * @param {number} historyIndex - Which history entry to show (0 = most recent)
 * @returns {string}
 */
function createModalHtml(data, historyIndex = 0) {
    const timeAgo = getTimeAgo(data.timestamp);
    const queryPreview = data.query.length > 100
        ? data.query.substring(0, 100) + '...'
        : data.query;

    // Build history tabs
    const historyTabs = queryHistory.length > 1 ? `
        <div class="vectfox-debug-history-tabs">
            ${queryHistory.map((q, idx) => {
                const isActive = idx === historyIndex;
                const tabTime = getTimeAgo(q.timestamp);
                const tabQuery = q.query.substring(0, 20) + (q.query.length > 20 ? '...' : '');
                const injectedCount = q.stages.injected?.length || 0;
                const statusClass = injectedCount > 0 ? 'tab-success' : 'tab-empty';
                return `
                    <button class="vectfox-debug-history-tab ${isActive ? 'active' : ''} ${statusClass}"
                            data-history-index="${idx}"
                            title="${escapeHtml(q.query.substring(0, 100))}">
                        <span class="tab-num">#${idx + 1}</span>
                        <span class="tab-injected">${injectedCount}</span>
                    </button>
                `;
            }).join('')}
        </div>
    ` : '';

    return `
        <div id="VectFox_search_debug_modal" class="vectfox-modal" style="display: none;">
            <div class="vectfox-modal-overlay"></div>
            <div class="vectfox-modal-content vectfox-search-debug-content">
                <!-- Header -->
                <div class="vectfox-modal-header">
                    <h3><i class="fa-solid fa-bug"></i> Search Debug</h3>
                    <button class="vectfox-debug-copy-btn" id="VectFox_copy_diagnostic" title="Copy diagnostic dump">
                        <i class="fa-solid fa-copy"></i> Copy Debug
                    </button>
                    <button class="vectfox-modal-close" id="VectFox_search_debug_close">✕</button>
                </div>

                <!-- History Tabs -->
                ${historyTabs}

                <!-- Body -->
                <div class="vectfox-modal-body vectfox-search-debug-body">

                    <!-- Query Info Card (Clickable to expand) -->
                    <div class="vectfox-debug-card vectfox-debug-query-card" id="VectFox_query_card">
                        <div class="vectfox-debug-card-header vectfox-debug-clickable" id="VectFox_query_header">
                            <i class="fa-solid fa-magnifying-glass"></i>
                            <span>Query</span>
                            <span class="vectfox-debug-timestamp">${timeAgo}</span>
                            <i class="fa-solid fa-chevron-down vectfox-debug-expand-icon"></i>
                        </div>
                        <div class="vectfox-debug-card-body">
                            <div class="vectfox-debug-query-preview">${escapeHtml(queryPreview)}</div>
                            <div class="vectfox-debug-query-full" style="display: none;">
                                <pre>${escapeHtml(data.query)}</pre>
                            </div>
                        </div>
                    </div>

                    <!-- Pipeline Overview -->
                    <div class="vectfox-debug-pipeline">
                        <div class="vectfox-debug-pipeline-title">
                            <i class="fa-solid fa-diagram-project"></i>
                            RAG Pipeline
                        </div>
                        <div class="vectfox-debug-pipeline-stages">
                            ${createPipelineStage('Vector Search', data.stages.initial.length, data.stages.initial.length, 'fa-database', 'primary', false)}
                            <div class="vectfox-debug-pipeline-arrow">→</div>
                            ${createKeywordBoostStage(data)}
                            <div class="vectfox-debug-pipeline-arrow">→</div>
                            ${createPipelineStage('Threshold', data.stages.afterThreshold?.length ?? data.stages.initial.filter(c => c.score >= (data.settings.threshold || 0)).length, data.stages.initial.length, 'fa-filter', 'info', false)}
                            <div class="vectfox-debug-pipeline-arrow">→</div>
                            ${createPipelineStage('Decay', data.stages.afterDecay.length, data.stages.afterThreshold?.length ?? 0, 'fa-clock', 'warning', !data.settings.temporal_decay?.enabled)}
                            <div class="vectfox-debug-pipeline-arrow">→</div>
                            ${createPipelineStage('Conditions', data.stages.afterConditions.length, data.stages.afterDecay.length, 'fa-code-branch', 'secondary', false)}
                            <div class="vectfox-debug-pipeline-arrow">→</div>
                            ${createPipelineStage('Injected', data.stages.injected.length, data.stages.afterConditions.length, 'fa-syringe', 'success', false)}
                        </div>
                    </div>

                    <!-- Settings Used -->
                    <div class="vectfox-debug-card vectfox-debug-settings">
                        <div class="vectfox-debug-card-header">
                            <i class="fa-solid fa-gear"></i>
                            <span>Settings Used</span>
                        </div>
                        <div class="vectfox-debug-card-body">
                            <div class="vectfox-debug-settings-grid">
                                <div class="vectfox-debug-setting">
                                    <span class="vectfox-debug-setting-label">Threshold</span>
                                    <span class="vectfox-debug-setting-value">${data.settings.threshold || 'N/A'}</span>
                                </div>
                                <div class="vectfox-debug-setting">
                                    <span class="vectfox-debug-setting-label">Top K</span>
                                    <span class="vectfox-debug-setting-value">${data.settings.topK || 'N/A'}</span>
                                </div>
                                <div class="vectfox-debug-setting">
                                    <span class="vectfox-debug-setting-label">Temporal Decay</span>
                                    <span class="vectfox-debug-setting-value">${data.settings.temporal_decay?.enabled ? 'On' : 'Off'}</span>
                                </div>
                                <div class="vectfox-debug-setting">
                                    <span class="vectfox-debug-setting-label">Collection</span>
                                    <span class="vectfox-debug-setting-value vectfox-debug-setting-mono">${data.collectionId || 'Unknown'}</span>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- Chunks by Stage -->
                    <div class="vectfox-debug-card">
                        <div class="vectfox-debug-card-header">
                            <i class="fa-solid fa-layer-group"></i>
                            <span>Chunks by Stage</span>
                        </div>
                        <div class="vectfox-debug-card-body">
                            <!-- Stage Tabs -->
                            <div class="vectfox-debug-stage-tabs">
                                <button class="vectfox-debug-stage-tab active" data-stage="initial">
                                    Initial (${data.stages.initial.length})
                                </button>
                                <button class="vectfox-debug-stage-tab" data-stage="afterDecay">
                                    After Decay (${data.stages.afterDecay.length})
                                </button>
                                <button class="vectfox-debug-stage-tab" data-stage="afterConditions">
                                    After Conditions (${data.stages.afterConditions.length})
                                </button>
                                <button class="vectfox-debug-stage-tab" data-stage="injected">
                                    Injected (${data.stages.injected.length})
                                </button>
                            </div>

                            <!-- Stage Content -->
                            <div class="vectfox-debug-stage-content" id="VectFox_debug_stage_content">
                                ${renderStageChunks(data.stages.initial, 'initial', data)}
                            </div>
                        </div>
                    </div>

                    <!-- Critical Failure Alert (0 injected) -->
                    ${renderCriticalFailure(data)}

                    <!-- Injection Verification (proof it actually happened) -->
                    ${renderInjectionVerification(data)}

                    <!-- Excluded Chunks Analysis -->
                    ${renderExcludedAnalysis(data)}

                    <!-- Developer Trace Log -->
                    ${renderTraceLog(data)}

                    <!-- Per-Chunk Fate Tracking -->
                    ${renderChunkFates(data)}

                </div>
            </div>
        </div>
    `;
}

/**
 * Creates a pipeline stage box
 * @param {string} label - Stage name
 * @param {number} count - Chunks remaining after this stage
 * @param {number} fromCount - Chunks that entered this stage
 * @param {string} icon - FontAwesome icon class
 * @param {string} colorClass - CSS color class
 * @param {boolean} disabled - Whether this stage is disabled/inactive
 */
function createPipelineStage(label, count, fromCount, icon, colorClass, disabled = false) {
    // Only show loss if this stage actually received chunks AND lost some
    const lost = (fromCount > 0 && count < fromCount) ? fromCount - count : 0;
    const disabledClass = disabled ? 'vectfox-debug-stage-disabled' : '';

    return `
        <div class="vectfox-debug-pipeline-stage vectfox-debug-stage-${colorClass} ${disabledClass}">
            <div class="vectfox-debug-stage-icon">
                <i class="fa-solid ${icon}"></i>
            </div>
            <div class="vectfox-debug-stage-count">${count}</div>
            <div class="vectfox-debug-stage-label">${label}${disabled ? ' (off)' : ''}</div>
            ${lost > 0 ? `<div class="vectfox-debug-stage-lost">-${lost}</div>` : ''}
        </div>
    `;
}

/**
 * Creates the keyword boost pipeline stage
 * Shows how many chunks had keywords matched
 */
function createKeywordBoostStage(data) {
    const chunks = data.stages.initial || [];
    const boostedCount = chunks.filter(c => c.keywordMatched || c.keywordBoosted || (c.keywordBoost && c.keywordBoost > 1)).length;

    // Count total matched query keywords across all chunks
    const totalMatchedQueryKeywords = chunks.reduce((sum, c) => {
        return sum + (c.matchedQueryKeywords?.length || 0);
    }, 0);

    // Show total matched keywords as the badge
    const badge = totalMatchedQueryKeywords > 0
        ? `<div class="vectfox-debug-stage-boost">🔑${totalMatchedQueryKeywords}</div>`
        : '';

    return `
        <div class="vectfox-debug-pipeline-stage vectfox-debug-stage-keyword">
            <div class="vectfox-debug-stage-icon">
                <i class="fa-solid fa-tags"></i>
            </div>
            <div class="vectfox-debug-stage-count">${boostedCount}</div>
            <div class="vectfox-debug-stage-label">Keywords</div>
            ${badge}
        </div>
    `;
}

/**
 * Renders chunks for a specific stage
 */
function renderStageChunks(chunks, stageName, data) {
    if (!chunks || chunks.length === 0) {
        return `
            <div class="vectfox-debug-empty">
                <i class="fa-solid fa-inbox"></i>
                <p>No chunks at this stage</p>
            </div>
        `;
    }

    let html = '<div class="vectfox-debug-chunks-list">';

    chunks.forEach((chunk, idx) => {
        const textPreview = chunk.text
            ? (chunk.text.length > 80 ? chunk.text.substring(0, 80) + '...' : chunk.text)
            : '(text not found)';

        const hasMoreText = chunk.text && chunk.text.length > 80;

        const scoreClass = getScoreClass(chunk.score);
        const decayInfo = chunk.decayApplied
            ? `<span class="vectfox-debug-decay-badge" title="Original: ${chunk.originalScore?.toFixed(3)}">
                   Decay: ${((1 - chunk.decayMultiplier) * 100).toFixed(0)}%↓
               </span>`
            : '';

        // Show matched query keywords badge
        const keywordMatchInfo = chunk.matchedQueryKeywords && chunk.matchedQueryKeywords.length > 0
            ? `<span class="vectfox-debug-keyword-match-badge" title="Matched query keywords: ${chunk.matchedQueryKeywords.join(', ')}">
                   🔑 ${chunk.matchedQueryKeywords.length} keyword${chunk.matchedQueryKeywords.length > 1 ? 's' : ''}
               </span>`
            : '';

        // Build score breakdown showing the math
        const scoreBreakdown = buildScoreBreakdown(chunk);

        // Check if this chunk was excluded in later stages
        const wasExcluded = getExclusionStatus(chunk, stageName, data);

        // Build score display - hybrid vs standard
        const isHybrid = chunk.hybridSearch || (chunk.vectorScore !== undefined && chunk.textScore !== undefined);
        let scoreDisplay;
        if (isHybrid) {
            const isRRF = chunk.fusionMethod === 'rrf';

            // RRF scores are small (0.014), but original vector/text scores are still percentages
            if (isRRF) {
                // Final RRF score is raw decimal, but vector/text are still percentages
                const finalScore = (chunk.score || 0).toFixed(4);
                const vectorPct = ((chunk.vectorScore || 0) * 100).toFixed(0);
                const textPct = ((chunk.textScore || 0) * 100).toFixed(0);
                scoreDisplay = `
                    <span class="vectfox-debug-chunk-score-hybrid">
                        <span class="vectfox-score-main ${scoreClass}">${finalScore}</span>
                        <span class="vectfox-score-mini">
                            <span class="vectfox-mini-vector" title="Semantic similarity (Qdrant cosine)">🔷${vectorPct}%</span>
                            <span class="vectfox-mini-text" title="Keyword match score">📝${textPct}%</span>
                        </span>
                    </span>`;
            } else {
                // Show as percentages for weighted fusion
                const finalPct = ((chunk.score || 0) * 100).toFixed(1);
                const vectorPct = ((chunk.vectorScore || 0) * 100).toFixed(0);
                const textPct = ((chunk.textScore || 0) * 100).toFixed(0);
                scoreDisplay = `
                    <span class="vectfox-debug-chunk-score-hybrid">
                        <span class="vectfox-score-main ${scoreClass}">${finalPct}%</span>
                        <span class="vectfox-score-mini">
                            <span class="vectfox-mini-vector" title="Semantic similarity">🔷${vectorPct}%</span>
                            <span class="vectfox-mini-text" title="Keyword match">📝${textPct}%</span>
                        </span>
                    </span>`;
            }
        } else {
            scoreDisplay = `<span class="vectfox-debug-chunk-score ${scoreClass}">${chunk.score?.toFixed(3) || 'N/A'}</span>`;
        }

        // Build full metadata for expanded view
        const fullMeta = {
            hash: chunk.hash,
            index: chunk.index,
            messageAge: chunk.messageAge,
            score: chunk.score,
            originalScore: chunk.originalScore,
            keywordBoost: chunk.keywordBoost,
            decayMultiplier: chunk.decayMultiplier,
            keywords: chunk.matchedKeywordsWithWeights || chunk.matchedKeywords || [],
            collection: chunk.collection || chunk.collectionId,
            metadata: chunk.metadata
        };

        html += `
            <div class="vectfox-debug-chunk vectfox-debug-chunk-expandable ${wasExcluded ? 'vectfox-debug-chunk-excluded' : ''}" data-chunk-idx="${idx}">
                <div class="vectfox-debug-chunk-header">
                    <span class="vectfox-debug-chunk-rank">#${idx + 1}</span>
                    ${scoreDisplay}
                    ${keywordMatchInfo}
                    ${decayInfo}
                    ${wasExcluded ? `<span class="vectfox-debug-excluded-badge">${wasExcluded}</span>` : ''}
                    <i class="fa-solid fa-chevron-down vectfox-debug-chunk-expand-icon"></i>
                </div>
                ${scoreBreakdown}
                <div class="vectfox-debug-chunk-text-preview">${escapeHtml(textPreview)}</div>

                <!-- Expanded content (hidden by default) -->
                <div class="vectfox-debug-chunk-expanded" style="display: none;">
                    <div class="vectfox-debug-chunk-fulltext">
                        <div class="vectfox-debug-chunk-fulltext-label">Full Text:</div>
                        <pre>${escapeHtml(chunk.text || '(no text)')}</pre>
                    </div>
                    <div class="vectfox-debug-chunk-meta-full">
                        <div class="vectfox-debug-meta-grid">
                            <div class="vectfox-debug-meta-item">
                                <span class="meta-label">Hash</span>
                                <span class="meta-value">${chunk.hash}</span>
                            </div>
                            ${chunk.index !== undefined ? `
                            <div class="vectfox-debug-meta-item">
                                <span class="meta-label">Message #</span>
                                <span class="meta-value">${chunk.index}</span>
                            </div>` : ''}
                            ${chunk.messageAge !== undefined ? `
                            <div class="vectfox-debug-meta-item">
                                <span class="meta-label">Age</span>
                                <span class="meta-value">${chunk.messageAge} messages</span>
                            </div>` : ''}
                            ${chunk.collection || chunk.collectionId ? `
                            <div class="vectfox-debug-meta-item">
                                <span class="meta-label">Collection</span>
                                <span class="meta-value">${chunk.collection || chunk.collectionId}</span>
                            </div>` : ''}
                            ${chunk.metadata?.keywords?.length ? `
                            <div class="vectfox-debug-meta-item">
                                <span class="meta-label">Keywords</span>
                                <span class="meta-value">${chunk.metadata.keywords.map(k => typeof k === 'object' ? `${k.text}(${k.weight}x)` : k).join(', ')}</span>
                            </div>` : ''}
                            ${chunk.matchedQueryKeywords?.length ? `
                            <div class="vectfox-debug-meta-item">
                                <span class="meta-label">Matched Query Keywords</span>
                                <span class="meta-value vectfox-matched-keywords">${chunk.matchedQueryKeywords.join(', ')}</span>
                            </div>` : ''}
                            ${chunk.vectorRank !== undefined ? `
                            <div class="vectfox-debug-meta-item">
                                <span class="meta-label">Vector Rank</span>
                                <span class="meta-value">#${chunk.vectorRank}</span>
                            </div>` : ''}
                            ${chunk.keywordRank !== undefined && chunk.keywordRank !== Infinity ? `
                            <div class="vectfox-debug-meta-item">
                                <span class="meta-label">Keyword Rank</span>
                                <span class="meta-value">#${chunk.keywordRank}</span>
                            </div>` : ''}
                            ${chunk.matchedKeywords !== undefined ? `
                            <div class="vectfox-debug-meta-item">
                                <span class="meta-label">Keywords Matched</span>
                                <span class="meta-value">${chunk.matchedKeywords} keyword${chunk.matchedKeywords !== 1 ? 's' : ''}</span>
                            </div>` : ''}
                            ${chunk.fusionMethod ? `
                            <div class="vectfox-debug-meta-item">
                                <span class="meta-label">Fusion Method</span>
                                <span class="meta-value">${chunk.fusionMethod.toUpperCase()}</span>
                            </div>` : ''}
                        </div>
                    </div>
                </div>

                <!-- Collapsed meta (shown when collapsed) -->
                <div class="vectfox-debug-chunk-meta">
                    <span>Hash: ${String(chunk.hash).substring(0, 12)}...</span>
                    ${chunk.index !== undefined ? `<span>Msg #${chunk.index}</span>` : ''}
                    ${hasMoreText ? `<span class="vectfox-debug-click-hint">Click to expand</span>` : ''}
                </div>
            </div>
        `;
    });

    html += '</div>';
    return html;
}

/**
 * Determines why a chunk was excluded
 */
function getExclusionStatus(chunk, currentStage, data) {
    // Check each stage in order to find where it was dropped
    const threshold = data.settings.threshold || 0;

    // If we're looking at initial chunks, check what happened to them
    if (currentStage === 'initial') {
        // First check: did it pass threshold?
        const passedThreshold = (chunk.score || 0) >= threshold;
        if (!passedThreshold) {
            return 'Below threshold';
        }

        // Check if in afterThreshold stage
        const inAfterThreshold = data.stages.afterThreshold?.some(c => c.hash === chunk.hash);
        if (data.stages.afterThreshold && !inAfterThreshold) {
            return 'Below threshold';
        }

        // Check if in afterDecay
        const inAfterDecay = data.stages.afterDecay?.some(c => c.hash === chunk.hash);
        if (!inAfterDecay) {
            return 'Lost to decay';
        }

        // Check if in afterConditions
        const inAfterConditions = data.stages.afterConditions?.some(c => c.hash === chunk.hash);
        if (!inAfterConditions) {
            return 'Failed conditions';
        }

        // Check if injected
        const inInjected = data.stages.injected?.some(c => c.hash === chunk.hash);
        if (!inInjected) {
            return 'Not injected';
        }
    }

    // For other stages, check forward
    if (currentStage === 'afterThreshold' || currentStage === 'afterDecay') {
        const inAfterConditions = data.stages.afterConditions?.some(c => c.hash === chunk.hash);
        if (!inAfterConditions) {
            return 'Failed conditions';
        }
        const inInjected = data.stages.injected?.some(c => c.hash === chunk.hash);
        if (!inInjected) {
            return 'Not injected';
        }
    }

    if (currentStage === 'afterConditions') {
        const inInjected = data.stages.injected?.some(c => c.hash === chunk.hash);
        if (!inInjected) {
            return 'Not injected';
        }
    }

    return null;
}

/**
 * Builds a score breakdown showing the math behind the final score
 * Shows: vectorScore × keywordBoost × decayMultiplier = finalScore
 * For hybrid search: shows vector and text scores separately
 */
function buildScoreBreakdown(chunk) {
    // Check if this is a hybrid search result
    const isHybridSearch = chunk.hybridSearch || (chunk.vectorScore !== undefined && chunk.textScore !== undefined);

    if (isHybridSearch) {
        // Hybrid search breakdown - show vector and text scores
        const fusionMethod = chunk.fusionMethod || 'rrf';
        const isRRF = fusionMethod === 'rrf';
        const hasTextMatch = (chunk.textScore || 0) > 0.01;

        let matchIndicator = '';
        if (!hasTextMatch) {
            matchIndicator = '<span class="vectfox-score-warning" title="No keyword match - semantic only">⚠️</span>';
        } else {
            matchIndicator = '<span class="vectfox-score-good" title="Both semantic and keyword match">✓</span>';
        }

        // RRF final score is raw, but vector/text scores are still percentages (from Qdrant)
        let vectorDisplay, textDisplay, finalDisplay;
        if (isRRF) {
            vectorDisplay = ((chunk.vectorScore || 0) * 100).toFixed(0) + '%';  // Qdrant cosine
            textDisplay = ((chunk.textScore || 0) * 100).toFixed(0) + '%';     // Keyword match
            finalDisplay = (chunk.score || 0).toFixed(4);                      // RRF fusion
        } else {
            vectorDisplay = ((chunk.vectorScore || 0) * 100).toFixed(0) + '%';
            textDisplay = ((chunk.textScore || 0) * 100).toFixed(0) + '%';
            finalDisplay = ((chunk.score || 0) * 100).toFixed(1) + '%';
        }

        return `<div class="vectfox-debug-score-breakdown vectfox-hybrid-breakdown">
            <div class="vectfox-hybrid-scores">
                <span class="vectfox-score-vector-badge" title="Semantic similarity">🔷 Vector: ${vectorDisplay}</span>
                <span class="vectfox-score-text-badge" title="Keyword/BM25 match">📝 Text: ${textDisplay}</span>
                ${matchIndicator}
            </div>
            <div class="vectfox-score-math">
                <span class="vectfox-score-fusion">${fusionMethod.toUpperCase()}</span>
                <span class="vectfox-score-operator">→</span>
                <span class="vectfox-score-final">${finalDisplay}</span>
            </div>
        </div>`;
    }

    // Standard (non-hybrid) breakdown
    // Get the original vector similarity score (before any boosts)
    const vectorScore = chunk.originalScore ?? chunk.score;
    const keywordBoost = chunk.keywordBoost ?? 1.0;
    const decayMultiplier = chunk.decayMultiplier ?? 1.0;
    const finalScore = chunk.score;

    // Only show breakdown if there's something to break down
    const hasKeywordBoost = keywordBoost && keywordBoost !== 1.0;
    const hasDecay = chunk.decayApplied && decayMultiplier !== 1.0;

    if (!hasKeywordBoost && !hasDecay && vectorScore === finalScore) {
        // No modifications, just show vector score
        return `<div class="vectfox-debug-score-breakdown">
            <span class="vectfox-score-math">Vector: ${vectorScore?.toFixed(3) || 'N/A'}</span>
        </div>`;
    }

    // Build the math equation
    let mathParts = [];
    mathParts.push(`<span class="vectfox-score-vector">${vectorScore?.toFixed(3) || '?'}</span>`);

    if (hasKeywordBoost) {
        // Show keyword breakdown with weights if available
        let boostTitle = 'Keyword boost';
        if (chunk.matchedKeywordsWithWeights?.length > 0) {
            const kwDetails = chunk.matchedKeywordsWithWeights.map(k =>
                `${k.text}: +${((k.weight - 1) * 100).toFixed(0)}%`
            ).join(', ');
            boostTitle = `Additive boost: ${kwDetails}`;
        } else if (chunk.matchedKeywords?.length > 0) {
            boostTitle = `Matched: ${chunk.matchedKeywords.join(', ')}`;
        }
        mathParts.push(`<span class="vectfox-score-operator">×</span>`);
        mathParts.push(`<span class="vectfox-score-boost" title="${boostTitle}">${keywordBoost.toFixed(2)}x</span>`);
    }

    if (hasDecay) {
        mathParts.push(`<span class="vectfox-score-operator">×</span>`);
        mathParts.push(`<span class="vectfox-score-decay" title="Age: ${chunk.messageAge || '?'} msgs">${decayMultiplier.toFixed(2)}↓</span>`);
    }

    mathParts.push(`<span class="vectfox-score-operator">=</span>`);
    mathParts.push(`<span class="vectfox-score-final">${finalScore?.toFixed(3) || '?'}</span>`);

    // Add keyword matches with weights if present
    let keywordInfo = '';
    if (chunk.matchedKeywordsWithWeights?.length > 0) {
        const kwStr = chunk.matchedKeywordsWithWeights.map(k =>
            k.weight !== 1.5 ? `${k.text} (${k.weight}x)` : k.text
        ).join(', ');
        keywordInfo = `<div class="vectfox-score-keywords">Keywords: ${kwStr}</div>`;
    } else if (chunk.matchedKeywords?.length > 0) {
        keywordInfo = `<div class="vectfox-score-keywords">Keywords: ${chunk.matchedKeywords.join(', ')}</div>`;
    }

    return `<div class="vectfox-debug-score-breakdown">
        <div class="vectfox-score-math">${mathParts.join(' ')}</div>
        ${keywordInfo}
    </div>`;
}

/**
 * Renders critical failure alert when 0 chunks were injected
 * Diagnoses the pipeline and provides actionable fixes
 */
/**
 * Renders injection verification card - proof that injection actually happened
 */
function renderInjectionVerification(data) {
    // Only show if there were injected chunks
    if (!data.injection || data.stages.injected.length === 0) {
        return '';
    }

    const { verified, text, position, depth, charCount } = data.injection;
    const statusClass = verified ? 'vectfox-verification-success' : 'vectfox-verification-failed';
    const statusIcon = verified ? 'fa-circle-check' : 'fa-circle-xmark';
    const statusText = verified ? 'VERIFIED' : 'VERIFICATION FAILED';

    // Position label
    const positionLabels = {
        0: 'After Main Prompt',
        1: 'In-chat @ Depth',
        2: 'Before Main Prompt',
        3: 'After Character Defs',
        4: 'Before Character Defs',
        5: 'At End of Chat',
        6: 'Before AN/Author\'s Note'
    };
    const positionLabel = positionLabels[position] || `Position ${position}`;

    return `
        <div class="vectfox-debug-card vectfox-debug-verification ${statusClass}">
            <div class="vectfox-debug-card-header vectfox-debug-clickable" id="VectFox_verification_header">
                <i class="fa-solid ${statusIcon}"></i>
                <span>Injection Verification</span>
                <span class="vectfox-verification-badge ${statusClass}">${statusText}</span>
                <i class="fa-solid fa-chevron-down vectfox-debug-expand-icon"></i>
            </div>
            <div class="vectfox-debug-card-body">
                <div class="vectfox-verification-summary">
                    <div class="vectfox-verification-stat">
                        <span class="stat-label">Position</span>
                        <span class="stat-value">${positionLabel}</span>
                    </div>
                    <div class="vectfox-verification-stat">
                        <span class="stat-label">Depth</span>
                        <span class="stat-value">${depth}</span>
                    </div>
                    <div class="vectfox-verification-stat">
                        <span class="stat-label">Characters</span>
                        <span class="stat-value">${charCount.toLocaleString()}</span>
                    </div>
                </div>
                <div class="vectfox-verification-text-wrapper" style="display: none;">
                    <div class="vectfox-verification-text-label">Actual Injected Text:</div>
                    <pre class="vectfox-verification-text">${escapeHtml(text)}</pre>
                </div>
            </div>
        </div>
    `;
}

function renderCriticalFailure(data) {
    // Only show if we got 0 injected chunks
    if (data.stages.injected.length > 0) {
        return '';
    }

    // Diagnose the pipeline step by step
    const diagnosis = diagnosePipeline(data);

    // Build a one-line summary of what went wrong
    const failedStage = diagnosis.find(d => d.isCause);
    const failureSummary = failedStage
        ? `Failed at: ${failedStage.label}`
        : 'Unknown failure point';

    return `
        <div class="vectfox-debug-critical-failure">
            <div class="vectfox-debug-critical-header">
                <div class="vectfox-debug-critical-icon">
                    <i class="fa-solid fa-triangle-exclamation"></i>
                </div>
                <div>
                    <div class="vectfox-debug-critical-title">No Chunks Injected — ${failureSummary}</div>
                    <div class="vectfox-debug-critical-subtitle">
                        ${data.stages.initial.length === 0
                            ? 'Vector search returned no results'
                            : `${data.stages.initial.length} chunks retrieved, but all were filtered out before injection`}
                    </div>
                </div>
            </div>

            <div class="vectfox-debug-diagnosis">
                <div class="vectfox-debug-diagnosis-title">
                    <i class="fa-solid fa-stethoscope"></i>
                    Pipeline Diagnosis
                </div>

                ${diagnosis.map((item, idx) => `
                    <div class="vectfox-debug-diagnosis-item ${item.isCause ? 'is-cause' : ''} ${item.isOk ? 'is-ok' : ''}">
                        <div class="vectfox-debug-diagnosis-number">${idx + 1}</div>
                        <div class="vectfox-debug-diagnosis-content">
                            <div class="vectfox-debug-diagnosis-label">
                                ${item.label}
                                <span class="vectfox-debug-diagnosis-status ${item.isOk ? 'status-ok' : 'status-fail'}">
                                    ${item.isOk ? '✓ OK' : '✗ FAILED'}
                                </span>
                            </div>
                            <div class="vectfox-debug-diagnosis-detail">${item.detail}</div>
                            ${item.fix ? `
                                <div class="vectfox-debug-diagnosis-fix">
                                    <strong>Fix:</strong> ${item.fix}
                                </div>
                            ` : ''}
                        </div>
                    </div>
                `).join('')}
            </div>
        </div>
    `;
}

/**
 * Diagnoses the RAG pipeline to find where and why chunks were lost
 * Returns bespoke, specific fixes based on the actual data
 * @returns {Array<{label: string, detail: string, fix?: string, isCause: boolean, isOk: boolean}>}
 */
function diagnosePipeline(data) {
    const diagnosis = [];
    const threshold = data.settings.threshold || 0;
    const topK = data.settings.topK || 10;
    const temporalDecay = data.settings.temporal_decay;

    // Step 1: Initial Vector Search
    const initialCount = data.stages.initial.length;
    if (initialCount === 0) {
        diagnosis.push({
            label: 'Vector Search',
            detail: `No matches returned from vector database for collection "${data.collectionId}".`,
            fix: `Open Database Browser and check if "${data.collectionId}" exists and contains chunks. If empty, send some messages first to build the vector index.`,
            isCause: true,
            isOk: false
        });
        return diagnosis;
    }

    // Analyze initial chunks in detail
    const scores = data.stages.initial.map(c => c.score || 0);
    const bestScore = Math.max(...scores);
    const worstScore = Math.min(...scores);
    const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;

    diagnosis.push({
        label: 'Vector Search',
        detail: `Retrieved ${initialCount} chunks. Scores: best ${bestScore.toFixed(3)}, worst ${worstScore.toFixed(3)}, avg ${avgScore.toFixed(3)}`,
        isCause: false,
        isOk: true
    });

    // Step 2: Threshold Filter - find chunks that would fail
    const aboveThreshold = data.stages.initial.filter(c => (c.score || 0) >= threshold);
    const belowThreshold = data.stages.initial.filter(c => (c.score || 0) < threshold);

    if (aboveThreshold.length === 0) {
        // ALL chunks failed threshold - give very specific fix
        const marginNeeded = (threshold - bestScore).toFixed(3);
        const suggestedThreshold = Math.max(0, bestScore - 0.02).toFixed(2);

        // Find the closest chunk to the threshold
        const closestChunk = data.stages.initial.reduce((closest, chunk) => {
            const diff = threshold - (chunk.score || 0);
            const closestDiff = threshold - (closest.score || 0);
            return diff < closestDiff ? chunk : closest;
        });

        diagnosis.push({
            label: 'Threshold Filter',
            detail: `All ${initialCount} chunks rejected. Your threshold is ${threshold}, but the best match only scored ${bestScore.toFixed(3)} (${marginNeeded} short).`,
            fix: `Change threshold from ${threshold} → ${suggestedThreshold}. Your closest chunk "${truncateText(closestChunk.text, 50)}" scored ${closestChunk.score?.toFixed(3)}.`,
            isCause: true,
            isOk: false
        });
        return diagnosis;
    } else if (belowThreshold.length > 0) {
        // Some chunks failed - show which ones and why
        const justMissed = belowThreshold.filter(c => (c.score || 0) >= threshold - 0.1);
        let detail = `${aboveThreshold.length}/${initialCount} passed threshold (${threshold}).`;
        if (justMissed.length > 0) {
            detail += ` ${justMissed.length} chunks just missed (within 0.1 of threshold).`;
        }
        diagnosis.push({
            label: 'Threshold Filter',
            detail: detail,
            isCause: false,
            isOk: true
        });
    } else {
        diagnosis.push({
            label: 'Threshold Filter',
            detail: `All ${initialCount} chunks passed threshold (${threshold}).`,
            isCause: false,
            isOk: true
        });
    }

    // Step 3: Temporal Decay - analyze actual decay impact
    const afterDecay = data.stages.afterDecay;
    const afterDecayCount = afterDecay.length;

    if (temporalDecay?.enabled) {
        // Find chunks that were lost specifically to decay
        const lostToDecay = aboveThreshold.filter(chunk => {
            return !afterDecay.some(dc => dc.hash === chunk.hash);
        });

        if (afterDecayCount === 0 && aboveThreshold.length > 0) {
            // All chunks killed by decay - analyze the decay impact
            const decayedChunks = aboveThreshold.map(chunk => {
                const afterDecayChunk = data.stages.initial.find(c => c.hash === chunk.hash);
                return {
                    ...chunk,
                    originalScore: chunk.originalScore || chunk.score,
                    finalScore: afterDecayChunk?.score || 0,
                    age: chunk.messageAge || 'unknown'
                };
            });

            // Find the chunk that was closest to surviving
            const bestSurvivor = decayedChunks.reduce((best, chunk) => {
                return (chunk.finalScore || 0) > (best.finalScore || 0) ? chunk : best;
            });

            const decayStrength = temporalDecay.strength || temporalDecay.rate || 'unknown';
            const halfLife = temporalDecay.halfLife || temporalDecay.half_life || 'unknown';

            diagnosis.push({
                label: 'Temporal Decay',
                detail: `All ${aboveThreshold.length} chunks fell below threshold after decay. Best surviving score was ${bestSurvivor.finalScore?.toFixed(3) || 'N/A'} (age: ${bestSurvivor.age} messages).`,
                fix: `Your decay settings (strength: ${decayStrength}, half-life: ${halfLife}) are too aggressive. Either disable temporal decay, or increase half-life to preserve older messages longer.`,
                isCause: true,
                isOk: false
            });
            return diagnosis;
        } else if (lostToDecay.length > 0) {
            // Some chunks lost to decay - show specifics
            const oldestLost = lostToDecay.reduce((oldest, c) => {
                return (c.messageAge || 0) > (oldest.messageAge || 0) ? c : oldest;
            });
            diagnosis.push({
                label: 'Temporal Decay',
                detail: `${afterDecayCount}/${aboveThreshold.length} survived decay. Lost ${lostToDecay.length} chunks, oldest was ${oldestLost.messageAge || '?'} messages ago.`,
                isCause: false,
                isOk: true
            });
        } else {
            diagnosis.push({
                label: 'Temporal Decay',
                detail: `All ${afterDecayCount} chunks survived decay.`,
                isCause: false,
                isOk: true
            });
        }
    } else {
        diagnosis.push({
            label: 'Temporal Decay',
            detail: 'Disabled.',
            isCause: false,
            isOk: true
        });
    }

    // Step 4: Condition Filtering - analyze what conditions failed
    const afterConditions = data.stages.afterConditions;
    const afterConditionsCount = afterConditions.length;

    // Find chunks lost to conditions
    const lostToConditions = afterDecay.filter(chunk => {
        return !afterConditions.some(cc => cc.hash === chunk.hash);
    });

    if (afterConditionsCount === 0 && afterDecayCount > 0) {
        // All chunks failed conditions - try to determine why
        const chunksWithConditions = afterDecay.filter(c => c.metadata?.conditions);

        if (chunksWithConditions.length > 0) {
            // Chunks had explicit conditions that failed
            const conditionTypes = [...new Set(chunksWithConditions.map(c =>
                c.metadata.conditions?.type || 'unknown'
            ))];
            diagnosis.push({
                label: 'Condition Filtering',
                detail: `All ${afterDecayCount} chunks failed their conditions. Condition types present: ${conditionTypes.join(', ')}.`,
                fix: `Check the conditions on your chunks. ${chunksWithConditions.length} chunks have explicit conditions (${conditionTypes.join(', ')}). These may be character filters, keyword requirements, or custom rules that aren't being met.`,
                isCause: true,
                isOk: false
            });
        } else {
            // No explicit conditions - might be protected messages or other filtering
            diagnosis.push({
                label: 'Condition Filtering',
                detail: `All ${afterDecayCount} chunks were filtered out. This may be due to message protection settings.`,
                fix: `Check if these messages fall within your "protect recent N messages" setting. Messages in the protected range won't be injected as RAG context.`,
                isCause: true,
                isOk: false
            });
        }
        return diagnosis;
    } else if (lostToConditions.length > 0) {
        diagnosis.push({
            label: 'Condition Filtering',
            detail: `${afterConditionsCount}/${afterDecayCount} passed conditions. ${lostToConditions.length} filtered out.`,
            isCause: false,
            isOk: true
        });
    } else {
        diagnosis.push({
            label: 'Condition Filtering',
            detail: `All ${afterConditionsCount} chunks passed.`,
            isCause: false,
            isOk: true
        });
    }

    // Step 5: Final Injection
    const injected = data.stages.injected;
    const injectedCount = injected.length;

    // Find chunks that passed conditions but weren't injected
    const notInjected = afterConditions.filter(chunk => {
        return !injected.some(ic => ic.hash === chunk.hash);
    });

    // Get skipped duplicates count from stats
    const skippedDuplicates = data.stats?.skippedDuplicates || 0;

    if (injectedCount === 0 && afterConditionsCount > 0) {
        if (topK === 0) {
            diagnosis.push({
                label: 'Injection',
                detail: `${afterConditionsCount} chunks ready but Top K is set to 0.`,
                fix: `Set Top K to at least 1. Currently Top K = 0 which means no chunks will ever be injected.`,
                isCause: true,
                isOk: false
            });
        } else if (skippedDuplicates > 0 && skippedDuplicates >= afterConditionsCount) {
            // All chunks were already in context - this is actually fine, not a failure
            diagnosis.push({
                label: 'Injection',
                detail: `All ${afterConditionsCount} retrieved chunks are already in current chat context.`,
                fix: `This is normal! The relevant content is already in your recent messages, so no injection was needed. RAG will inject when older/forgotten content becomes relevant.`,
                isCause: false,
                isOk: true
            });
        } else {
            // No specific failure reason tracked - this shouldn't happen
            diagnosis.push({
                label: 'Injection',
                detail: `${afterConditionsCount} chunks passed all filters but none were injected. No specific reason was recorded.`,
                fix: `This may be a bug. Open DevTools (F12) → Console tab, look for "VectFox" errors, and report the issue with console output.`,
                isCause: true,
                isOk: false
            });
        }
    } else if (notInjected.length > 0) {
        // Some chunks not injected - explain why
        const reasons = [];
        if (skippedDuplicates > 0) reasons.push(`${skippedDuplicates} already in context`);
        const hitTopK = notInjected.length - skippedDuplicates;
        if (hitTopK > 0) reasons.push(`${hitTopK} hit Top K limit`);
        const reason = reasons.length > 0 ? reasons.join(', ') : `hit Top K limit (${topK})`;

        diagnosis.push({
            label: 'Injection',
            detail: `${injectedCount}/${afterConditionsCount} injected. ${notInjected.length} not injected: ${reason}.`,
            isCause: false,
            isOk: true
        });
    } else if (afterConditionsCount > 0) {
        diagnosis.push({
            label: 'Injection',
            detail: `All ${injectedCount} chunks injected successfully.`,
            isCause: false,
            isOk: true
        });
    }

    // Fallback if we somehow still have 0 injected and no cause found
    if (injectedCount === 0 && !diagnosis.some(d => d.isCause)) {
        diagnosis.push({
            label: 'Unknown',
            detail: 'Pipeline completed but no chunks were injected. No specific cause identified.',
            fix: `This may be a bug. Open DevTools (F12) → Console tab, look for "VectFox" errors, and report the issue with console output.`,
            isCause: true,
            isOk: false
        });
    }

    return diagnosis;
}

/**
 * Truncates text to specified length with ellipsis
 */
function truncateText(text, maxLength) {
    if (!text) return '(no text)';
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength) + '...';
}

/**
 * Renders analysis of why chunks were excluded
 */
function renderExcludedAnalysis(data) {
    const initial = data.stages.initial;
    const injected = data.stages.injected;
    const excluded = initial.filter(c => !injected.some(i => i.hash === c.hash));

    if (excluded.length === 0) {
        return '';
    }

    // Categorize exclusions
    const belowThreshold = excluded.filter(c => c.score < (data.settings.threshold || 0));
    const lostToDecay = excluded.filter(c => {
        const inDecay = data.stages.afterDecay.some(d => d.hash === c.hash);
        return !inDecay && c.score >= (data.settings.threshold || 0);
    });
    const failedConditions = excluded.filter(c => {
        const inDecay = data.stages.afterDecay.some(d => d.hash === c.hash);
        const inConditions = data.stages.afterConditions.some(d => d.hash === c.hash);
        return inDecay && !inConditions;
    });
    const limitExceeded = excluded.filter(c => {
        const inConditions = data.stages.afterConditions.some(d => d.hash === c.hash);
        const inInjected = data.stages.injected.some(d => d.hash === c.hash);
        return inConditions && !inInjected;
    });

    return `
        <div class="vectfox-debug-card vectfox-debug-exclusions">
            <div class="vectfox-debug-card-header">
                <i class="fa-solid fa-filter-circle-xmark"></i>
                <span>Exclusion Analysis</span>
                <span class="vectfox-debug-exclusion-count">${excluded.length} chunks excluded</span>
            </div>
            <div class="vectfox-debug-card-body">
                <div class="vectfox-debug-exclusion-categories">
                    ${belowThreshold.length > 0 ? `
                        <div class="vectfox-debug-exclusion-category">
                            <div class="vectfox-debug-exclusion-icon vectfox-debug-exclusion-threshold">
                                <i class="fa-solid fa-less-than"></i>
                            </div>
                            <div class="vectfox-debug-exclusion-info">
                                <strong>${belowThreshold.length}</strong> below threshold
                                <small>Score < ${data.settings.threshold}</small>
                            </div>
                        </div>
                    ` : ''}
                    ${lostToDecay.length > 0 ? `
                        <div class="vectfox-debug-exclusion-category">
                            <div class="vectfox-debug-exclusion-icon vectfox-debug-exclusion-decay">
                                <i class="fa-solid fa-clock"></i>
                            </div>
                            <div class="vectfox-debug-exclusion-info">
                                <strong>${lostToDecay.length}</strong> lost to temporal decay
                                <small>Score reduced below threshold</small>
                            </div>
                        </div>
                    ` : ''}
                    ${failedConditions.length > 0 ? `
                        <div class="vectfox-debug-exclusion-category">
                            <div class="vectfox-debug-exclusion-icon vectfox-debug-exclusion-conditions">
                                <i class="fa-solid fa-code-branch"></i>
                            </div>
                            <div class="vectfox-debug-exclusion-info">
                                <strong>${failedConditions.length}</strong> failed conditions
                                <small>Chunk conditions not met</small>
                            </div>
                        </div>
                    ` : ''}
                    ${limitExceeded.length > 0 ? `
                        <div class="vectfox-debug-exclusion-category">
                            <div class="vectfox-debug-exclusion-icon vectfox-debug-exclusion-limit">
                                <i class="fa-solid fa-ban"></i>
                            </div>
                            <div class="vectfox-debug-exclusion-info">
                                <strong>${limitExceeded.length}</strong> hit injection limit
                                <small>Top K limit reached</small>
                            </div>
                        </div>
                    ` : ''}
                </div>
            </div>
        </div>
    `;
}

/**
 * Gets CSS class for score value
 */
function getScoreClass(score) {
    if (score >= 0.7) return 'vectfox-debug-score-high';
    if (score >= 0.4) return 'vectfox-debug-score-medium';
    return 'vectfox-debug-score-low';
}

/**
 * Gets human-readable time ago string
 */
function getTimeAgo(timestamp) {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);

    if (seconds < 60) return 'Just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return new Date(timestamp).toLocaleString();
}

/**
 * Escapes HTML special characters
 */
function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ============================================================================
// DEVELOPER TRACE LOG
// ============================================================================

/**
 * Renders the full trace log for debugging
 */
function renderTraceLog(data) {
    if (!data.trace || data.trace.length === 0) {
        return '';
    }

    const startTime = data.trace[0]?.time || data.timestamp;

    return `
        <div class="vectfox-debug-card vectfox-debug-trace">
            <div class="vectfox-debug-card-header">
                <i class="fa-solid fa-terminal"></i>
                <span>Pipeline Trace Log</span>
                <button class="vectfox-debug-toggle-btn" id="VectFox_toggle_trace">
                    <i class="fa-solid fa-chevron-down"></i>
                </button>
            </div>
            <div class="vectfox-debug-card-body vectfox-debug-trace-body" id="VectFox_trace_body" style="display: none;">
                <div class="vectfox-debug-trace-list">
                    ${data.trace.map((entry, idx) => {
                        const relTime = entry.time - startTime;
                        const stageClass = getStageClass(entry.stage);
                        const detailsJson = JSON.stringify(
                            Object.fromEntries(
                                Object.entries(entry).filter(([k]) => !['time', 'stage', 'action'].includes(k))
                            ),
                            null, 2
                        );

                        return `
                            <div class="vectfox-debug-trace-entry ${stageClass}">
                                <div class="vectfox-debug-trace-time">+${relTime}ms</div>
                                <div class="vectfox-debug-trace-stage">${entry.stage}</div>
                                <div class="vectfox-debug-trace-action">${escapeHtml(entry.action)}</div>
                                ${detailsJson !== '{}' ? `
                                    <pre class="vectfox-debug-trace-details">${escapeHtml(detailsJson)}</pre>
                                ` : ''}
                            </div>
                        `;
                    }).join('')}
                </div>
            </div>
        </div>
    `;
}

/**
 * Renders per-chunk fate tracking
 */
function renderChunkFates(data) {
    if (!data.chunkFates || Object.keys(data.chunkFates).length === 0) {
        return '';
    }

    const fates = Object.values(data.chunkFates);
    const dropped = fates.filter(f => f.finalFate === 'dropped');
    const injected = fates.filter(f => f.finalFate === 'injected');

    return `
        <div class="vectfox-debug-card vectfox-debug-fates">
            <div class="vectfox-debug-card-header">
                <i class="fa-solid fa-route"></i>
                <span>Chunk Fate Tracker</span>
                <span class="vectfox-debug-fate-summary">
                    <span class="vectfox-fate-injected">${injected.length} injected</span>
                    <span class="vectfox-fate-dropped">${dropped.length} dropped</span>
                </span>
                <button class="vectfox-debug-toggle-btn" id="VectFox_toggle_fates">
                    <i class="fa-solid fa-chevron-down"></i>
                </button>
            </div>
            <div class="vectfox-debug-card-body vectfox-debug-fates-body" id="VectFox_fates_body" style="display: none;">
                <div class="vectfox-debug-fates-list">
                    ${fates.map(fate => {
                        const isDropped = fate.finalFate === 'dropped';
                        const hashShort = String(fate.hash).substring(0, 12);

                        return `
                            <div class="vectfox-debug-fate-entry ${isDropped ? 'fate-dropped' : 'fate-injected'}">
                                <div class="vectfox-debug-fate-header">
                                    <span class="vectfox-debug-fate-hash" title="${fate.hash}">${hashShort}...</span>
                                    <span class="vectfox-debug-fate-result ${isDropped ? 'result-dropped' : 'result-injected'}">
                                        ${isDropped ? `✗ Dropped at ${fate.droppedAt}` : '✓ Injected'}
                                    </span>
                                </div>
                                ${isDropped && fate.finalReason ? `
                                    <div class="vectfox-debug-fate-reason">${escapeHtml(fate.finalReason)}</div>
                                ` : ''}
                                <div class="vectfox-debug-fate-journey">
                                    ${fate.stages.map(s => `
                                        <span class="vectfox-fate-stage ${s.fate === 'dropped' ? 'stage-dropped' : s.fate === 'injected' ? 'stage-injected' : 'stage-passed'}">
                                            ${s.stage}${s.fate === 'dropped' ? ' ✗' : s.fate === 'injected' ? ' ✓' : ''}
                                        </span>
                                    `).join('<span class="vectfox-fate-arrow">→</span>')}
                                </div>
                            </div>
                        `;
                    }).join('')}
                </div>
            </div>
        </div>
    `;
}

/**
 * Gets CSS class for trace stage
 */
function getStageClass(stage) {
    const stageClasses = {
        'init': 'trace-init',
        'vector_search': 'trace-search',
        'threshold': 'trace-threshold',
        'decay': 'trace-decay',
        'conditions': 'trace-conditions',
        'injection': 'trace-injection',
        'final': 'trace-final'
    };
    return stageClasses[stage] || 'trace-default';
}

/**
 * Generates diagnostic dump for debugging
 */
function generateDiagnosticDump(data) {
    const d = data;
    const s = d.settings;
    const st = d.stages;

    // Chunk fates - readable format
    const fates = Object.values(d.chunkFates || {});
    const fatesSummary = fates.map(f => {
        const journey = f.stages.map(s => {
            const status = s.fate === 'passed' ? '✓' : s.fate === 'dropped' ? '✗' : '→';
            return `${s.stage}${status}`;
        }).join(' → ');
        const result = f.finalFate === 'dropped'
            ? `DROPPED at ${f.droppedAt}: ${f.finalReason || 'unknown'}`
            : f.finalFate === 'injected' ? 'INJECTED' : 'unknown';
        return `  [${String(f.hash).slice(0,10)}] ${journey}\n    Result: ${result}`;
    });

    // Trace - readable
    const startTime = d.trace?.[0]?.time || d.timestamp;
    const traceLines = (d.trace || []).map(t => {
        const ms = t.time - startTime;
        const details = Object.entries(t)
            .filter(([k]) => !['time', 'stage', 'action'].includes(k))
            .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
            .join(', ');
        return `  +${String(ms).padStart(4)}ms [${t.stage.padEnd(12)}] ${t.action}${details ? '\n           ' + details : ''}`;
    });

    // Injection info - skipped duplicates (chunks already in context)
    const skippedCount = d.stats?.skippedDuplicates || 0;
    const injectionInfo = skippedCount > 0
        ? `  ${skippedCount} chunks skipped (already in current chat context)`
        : '  No chunks skipped';

    // Build human-readable dump
    const dump = `VectFox DEBUG DUMP
${'='.repeat(50)}
Time: ${new Date(d.timestamp).toLocaleString()}
Collection: ${d.collectionId}

SETTINGS
  Threshold: ${s.threshold}
  Top K: ${s.topK}
  Min Chat Length: ${s.min_chat_length ?? 0} (current: ${s.chatLength} messages)
  Temporal Decay: ${s.temporal_decay?.enabled ? `ON (half-life: ${s.temporal_decay.halfLife || s.temporal_decay.half_life})` : 'OFF'}

PIPELINE RESULTS
  Vector Search: ${st.initial?.length || 0} chunks retrieved
  After Threshold: ${st.afterThreshold?.length || 0} passed (threshold: ${s.threshold})
  After Decay: ${st.afterDecay?.length || 0} survived
  After Conditions: ${st.afterConditions?.length || 0} passed
  Final Injected: ${st.injected?.length || 0}

INITIAL SCORES (top 10)
  ${st.initial?.slice(0, 10).map((c, i) => {
      const parts = [`#${i+1}: ${c.score?.toFixed(3)}`];
      if (c.originalScore !== undefined && c.originalScore !== c.score) {
          parts.push(`(vector: ${c.originalScore?.toFixed(3)}`);
          if (c.keywordBoost && c.keywordBoost !== 1.0) {
              parts.push(`× ${c.keywordBoost?.toFixed(2)}x boost`);
          }
          if (c.decayMultiplier && c.decayMultiplier !== 1.0) {
              parts.push(`× ${c.decayMultiplier?.toFixed(2)} decay`);
          }
          parts.push(')');
      }
      if (c.matchedKeywordsWithWeights?.length > 0) {
          const kwStr = c.matchedKeywordsWithWeights.map(k =>
              k.weight !== 1.5 ? `${k.text}(${k.weight}x)` : k.text
          ).join(', ');
          parts.push(`[keywords: ${kwStr}]`);
      } else if (c.matchedKeywords?.length > 0) {
          parts.push(`[keywords: ${c.matchedKeywords.join(', ')}]`);
      }
      parts.push(`[${String(c.hash).slice(0,8)}]`);
      return parts.join(' ');
  }).join('\n  ') || 'none'}

INJECTION STATUS
${injectionInfo}
  Skipped: ${skippedCount} chunks (already in context)
  Injected: ${st.injected?.length || 0} chunks

CHUNK FATES
${fatesSummary.join('\n\n') || '  none'}

TRACE LOG
${traceLines.join('\n') || '  none'}

QUERY (full)
  ${d.query?.replace(/\n/g, '\n  ') || 'empty'}
${'='.repeat(50)}`;

    return dump;
}

/**
 * Copies diagnostic dump to clipboard
 */
async function copyDiagnosticDump() {
    if (!lastDebugData) {
        toastr.warning('No debug data available');
        return;
    }

    try {
        const dump = generateDiagnosticDump(lastDebugData);
        await navigator.clipboard.writeText(dump);
        toastr.success('Diagnostic dump copied to clipboard');
    } catch (err) {
        console.error('Failed to copy diagnostic:', err);
        toastr.error('Failed to copy to clipboard');
    }
}

// ============================================================================
// EVENT BINDING
// ============================================================================

// Track current history index for refreshing modal
let currentHistoryIndex = 0;

function bindEvents() {
    // Close button
    $('#VectFox_search_debug_close').on('click', closeSearchDebugModal);

    // Copy diagnostic dump
    $('#VectFox_copy_diagnostic').on('click', copyDiagnosticDump);

    // Stop mousedown propagation (ST closes drawers on mousedown/touchstart)
    $('#VectFox_search_debug_modal').on('mousedown touchstart', function(e) {
        e.stopPropagation();
    });

    // Close on background click
    $('#VectFox_search_debug_modal').on('click', function(e) {
        if (e.target === this) {
            closeSearchDebugModal();
        }
    });

    // History tabs - switch between past queries
    $('.vectfox-debug-history-tab').on('click', function() {
        const historyIndex = parseInt($(this).data('history-index'));
        if (queryHistory[historyIndex]) {
            currentHistoryIndex = historyIndex;
            lastDebugData = queryHistory[historyIndex];
            // Refresh the modal content
            const newHtml = createModalHtml(lastDebugData, historyIndex);
            $('#VectFox_search_debug_modal').replaceWith(newHtml);
            $('#VectFox_search_debug_modal').show();
            bindEvents();
        }
    });

    // Query card expand/collapse
    $('#VectFox_query_header').on('click', function() {
        const $card = $(this).closest('.vectfox-debug-query-card');
        const $preview = $card.find('.vectfox-debug-query-preview');
        const $full = $card.find('.vectfox-debug-query-full');
        const $icon = $(this).find('.vectfox-debug-expand-icon');

        $preview.slideToggle(200);
        $full.slideToggle(200);
        $icon.toggleClass('fa-chevron-down fa-chevron-up');
    });

    // Verification card expand/collapse (shows actual injected text)
    $('#VectFox_verification_header').on('click', function() {
        const $card = $(this).closest('.vectfox-debug-verification');
        const $textWrapper = $card.find('.vectfox-verification-text-wrapper');
        const $icon = $(this).find('.vectfox-debug-expand-icon');

        $textWrapper.slideToggle(200);
        $icon.toggleClass('fa-chevron-down fa-chevron-up');
    });

    // Expandable chunks
    $(document).off('click.chunkExpand').on('click.chunkExpand', '.vectfox-debug-chunk-expandable', function(e) {
        // Don't trigger if clicking on a link or button inside
        if ($(e.target).is('a, button')) return;

        const $chunk = $(this);
        const $expanded = $chunk.find('.vectfox-debug-chunk-expanded');
        const $preview = $chunk.find('.vectfox-debug-chunk-text-preview');
        const $meta = $chunk.find('.vectfox-debug-chunk-meta');
        const $icon = $chunk.find('.vectfox-debug-chunk-expand-icon');

        $expanded.slideToggle(200);
        $preview.slideToggle(200);
        $meta.slideToggle(200);
        $icon.toggleClass('fa-chevron-down fa-chevron-up');
        $chunk.toggleClass('expanded');
    });

    // Stage tabs
    $('.vectfox-debug-stage-tab').on('click', function() {
        const stage = $(this).data('stage');
        $('.vectfox-debug-stage-tab').removeClass('active');
        $(this).addClass('active');

        const data = lastDebugData;
        if (data && data.stages[stage]) {
            $('#VectFox_debug_stage_content').html(
                renderStageChunks(data.stages[stage], stage, data)
            );
        }
    });

    // Toggle trace log
    $('#VectFox_toggle_trace').on('click', function() {
        $('#VectFox_trace_body').slideToggle();
        $(this).find('i').toggleClass('fa-chevron-down fa-chevron-up');
    });

    // Toggle chunk fates
    $('#VectFox_toggle_fates').on('click', function() {
        $('#VectFox_fates_body').slideToggle();
        $(this).find('i').toggleClass('fa-chevron-down fa-chevron-up');
    });
}

// ============================================================================
// EVENTBASE QUERY TESTER
// ============================================================================

/**
 * Opens the EventBase Query Tester modal.
 * The user types a test message, clicks Run, and sees the exact
 * <VectFoxMemory> block that would be injected for that message —
 * using all current settings (agentic mode, filters, locked collections).
 */
export function openQueryTestModal() {
    $('#VectFox_query_tester_modal').remove();

    const html = `
        <div id="VectFox_query_tester_modal" class="vectfox-modal" style="display:none;">
            <div class="vectfox-modal-overlay"></div>
            <div class="vectfox-modal-content" style="max-width:660px; max-height:88vh; display:flex; flex-direction:column;">
                <div class="vectfox-modal-header">
                    <h3><i class="fa-solid fa-flask"></i> EventBase Query Tester</h3>
                    <button class="vectfox-modal-close" id="VectFox_qtester_close">✕</button>
                </div>
                <div class="vectfox-modal-body" style="padding:16px; display:flex; flex-direction:column; gap:10px; overflow-y:auto; flex:1 1 auto;">
                    <small style="color:var(--SmartThemeQuoteColor,#999);">
                        Type a test message to preview which EventBase memories would be retrieved.
                        Uses all current settings — agentic mode, planner filters, locked collections.
                        The real prompt injection is <b>not</b> affected.
                    </small>
                    <textarea id="VectFox_qtester_input"
                        class="text_pole"
                        placeholder="e.g. Do you remember how I rescued you?"
                        rows="3"
                        style="resize:vertical; width:100%; box-sizing:border-box;"></textarea>
                    <button id="VectFox_qtester_run" class="menu_button" style="align-self:flex-start;">
                        <i class="fa-solid fa-play"></i>&nbsp;Run Retrieval
                    </button>
                    <div id="VectFox_qtester_status" style="display:none; color:var(--SmartThemeQuoteColor,#999); font-size:0.85em;">
                        <i class="fa-solid fa-spinner fa-spin"></i>&nbsp;Running retrieval…
                    </div>
                    <div id="VectFox_qtester_result" style="display:none; flex-direction:column; gap:6px;">
                        <small id="VectFox_qtester_meta" style="color:var(--SmartThemeQuoteColor,#999);"></small>
                        <textarea id="VectFox_qtester_output"
                            readonly
                            rows="20"
                            style="width:100%; box-sizing:border-box; font-family:monospace; font-size:0.78em; resize:vertical; white-space:pre;"></textarea>
                    </div>
                </div>
            </div>
        </div>
    `;

    $('body').append(html);

    // Prevent SillyTavern from closing drawers on mousedown inside modal
    $('#VectFox_query_tester_modal').on('mousedown touchstart', e => e.stopPropagation());

    // Close on ✕ button or backdrop click
    $('#VectFox_qtester_close').on('click', _closeQueryTester);
    $('#VectFox_query_tester_modal').on('click', function (e) {
        if (e.target === this) _closeQueryTester();
    });

    // Run button
    $('#VectFox_qtester_run').on('click', async function () {
        const testMessage = $('#VectFox_qtester_input').val().trim();
        if (!testMessage) {
            toastr.warning('Enter a test message first.', 'VectFox');
            return;
        }

        $('#VectFox_qtester_run').prop('disabled', true);
        $('#VectFox_qtester_status').show();
        $('#VectFox_qtester_result').hide().css('display', 'none');

        try {
            const [{ extension_settings, getContext }, { runEventBaseRetrieval }] = await Promise.all([
                import('../../../../extensions.js'),
                import('../core/eventbase-workflow.js'),
            ]);

            const settings = extension_settings.vectfox;
            const { chat } = getContext();

            const result = await runEventBaseRetrieval({
                chat,
                searchText: testMessage,
                settings,
                dryRun: true,
                testMessage,
            });

            $('#VectFox_qtester_status').hide();

            if (result?.injectionText) {
                $('#VectFox_qtester_meta').text(`${result.eventCount ?? '?'} event(s) retrieved`);
                $('#VectFox_qtester_output').val(result.injectionText);
            } else {
                $('#VectFox_qtester_meta').text('No events retrieved');
                $('#VectFox_qtester_output').val(
                    '(no events matched — verify a collection is locked to this chat)'
                );
            }
            $('#VectFox_qtester_result').css('display', 'flex').show();
        } catch (err) {
            $('#VectFox_qtester_status').hide();
            console.error('[VectFox Query Tester]', err);
            toastr.error(`Retrieval failed: ${err.message}`, 'VectFox');
        } finally {
            $('#VectFox_qtester_run').prop('disabled', false);
        }
    });

    $('#VectFox_query_tester_modal').fadeIn(200);
    setTimeout(() => $('#VectFox_qtester_input').focus(), 250);
}

function _closeQueryTester() {
    $('#VectFox_query_tester_modal').fadeOut(200, function () { $(this).remove(); });
}
