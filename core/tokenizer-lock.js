/**
 * ============================================================================
 * TOKENIZER MODE LOCK
 * ============================================================================
 * When Qdrant native sparse vectors are enabled, the active CJK tokenizer mode
 * is baked into the indexed sparse vectors via FNV-1a hashes. A later mode
 * switch silently breaks query→indexed token matching.
 *
 * This module:
 *   - Reads the per-collection sentinel metadata (cached per session)
 *   - Compares the saved mode against the current setting
 *   - Shows a blocking modal so the user can revert the mode or accept the cost
 *
 * Returns null when the collection has no sentinel (legacy / non-migrated collections).
 *
 * @author VectHare
 * @since Phase 2 — Qdrant native sparse vectors
 * ============================================================================
 */

const metadataCache = new Map();

async function getRequestHeadersImport() {
    const mod = await import('../../../../../script.js');
    return mod.getRequestHeaders;
}

/**
 * Fetch the sentinel metadata for a Qdrant collection. Cached per-session.
 * @param {string} actualCollectionId - the resolved Qdrant collection name (after multitenancy resolution)
 * @returns {Promise<object|null>}
 */
export async function fetchCollectionMetadata(actualCollectionId) {
    if (metadataCache.has(actualCollectionId)) {
        return metadataCache.get(actualCollectionId);
    }
    try {
        const getRequestHeaders = await getRequestHeadersImport();
        const resp = await fetch('/api/plugins/similharity/chunks/collection-metadata', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ backend: 'qdrant', collectionId: actualCollectionId }),
        });
        if (!resp.ok) {
            metadataCache.set(actualCollectionId, null);
            return null;
        }
        const data = await resp.json();
        const payload = data?.payload || null;
        metadataCache.set(actualCollectionId, payload);
        return payload;
    } catch (error) {
        console.warn('[TokenizerLock] Failed to fetch collection metadata:', error.message);
        metadataCache.set(actualCollectionId, null);
        return null;
    }
}

/**
 * Invalidate the cached sentinel for a collection (e.g. after migration or purge).
 */
export function invalidateCollectionMetadata(actualCollectionId) {
    metadataCache.delete(actualCollectionId);
}

/**
 * Compare saved tokenizer mode to the current setting. Returns null when no mismatch,
 * or `{ saved, current }` when the user must take action.
 *
 * @param {object} settings - VectHare settings (reads `cjk_tokenizer_mode`)
 * @param {string} actualCollectionId
 * @returns {Promise<{saved: string, current: string} | null>}
 */
export async function detectTokenizerMismatch(settings, actualCollectionId) {
    const payload = await fetchCollectionMetadata(actualCollectionId);
    if (!payload || !payload.cjk_tokenizer_mode) return null; // collection has no sentinel (legacy / non-sparse)
    const current = settings.cjk_tokenizer_mode;
    if (payload.cjk_tokenizer_mode === current) return null;
    return { saved: payload.cjk_tokenizer_mode, current };
}

/**
 * Show the tokenizer mismatch modal. Returns the user's choice:
 *   'revert'   — revert setting to `saved` and retry
 *   'settings' — keep current setting, do not retry (user will purge/re-vector manually)
 *   'cancel'   — abort the operation
 *
 * @param {{saved: string, current: string}} mismatch
 * @param {string} actualCollectionId
 * @returns {Promise<'revert'|'settings'|'cancel'>}
 */
export async function showTokenizerMismatchModal(mismatch, actualCollectionId) {
    const { callGenericPopup, POPUP_TYPE } = await import('../../../../popup.js');

    const html = `
        <h3>Tokenizer Mode Mismatch</h3>
        <p>This Qdrant collection (<code>${escapeHtml(actualCollectionId)}</code>) was vectorized with the
        <code>${escapeHtml(mismatch.saved)}</code> CJK tokenizer.</p>
        <p>Your current setting is <code>${escapeHtml(mismatch.current)}</code>.</p>
        <p>Querying with a different tokenizer produces inaccurate BM25 results because
        sparse-vector indices are tokenizer-specific.</p>
        <p>To switch tokenizer modes for this collection you must
        <strong>delete the collection and re-vectorize from scratch.</strong></p>
        <p style="margin-top:1em;">Choose:</p>
        <ul>
            <li><strong>Revert</strong> — switch CJK mode back to <code>${escapeHtml(mismatch.saved)}</code> and continue.</li>
            <li><strong>Open Settings</strong> — keep current mode; you will purge and re-vectorize this collection.</li>
            <li><strong>Cancel</strong> — abort this query.</li>
        </ul>
    `;

    const choice = await callGenericPopup(html, POPUP_TYPE.TEXT, '', {
        okButton: `Revert to ${mismatch.saved}`,
        cancelButton: 'Cancel',
        customButtons: ['Open Settings'],
        wide: false,
    });

    // callGenericPopup returns:
    //   true (or 1)  for OK / first button
    //   false / null for cancel
    //   2+           for customButtons (index in array, 1-based after ok)
    if (choice === true || choice === 1) return 'revert';
    if (choice === 2) return 'settings';
    return 'cancel';
}

function escapeHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
