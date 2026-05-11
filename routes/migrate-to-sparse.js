/**
 * ============================================================================
 * MIGRATION ROUTES — Dev-only, throwaway
 * ============================================================================
 * Re-tokenizes an existing Qdrant collection's `payload.text` into native sparse
 * vectors WITHOUT re-embedding (kept dense vectors). Tokenization happens in the
 * browser because the CJK tokenizer lives there; this file is just the transport
 * + Qdrant orchestration layer.
 *
 * MIGRATE-DELETE — entire file. Plus:
 *   1. Remove `router.use(...)` line in similharity/index.js (also MIGRATE-DELETE tagged)
 *   2. Delete core/migrate-to-sparse.js on the VectHare side
 *   3. Delete the Dev Tools UI block in ui-manager.js (MIGRATE-DELETE tagged)
 *
 * @since Phase 4 — Qdrant native sparse vectors migration
 * ============================================================================
 */

import qdrantBackend from '../qdrant-backend.js';

const SENTINEL_ID = '00000000-0000-0000-0000-0000feedf00d';

/**
 * Register migration routes on the given Express router.
 * @param {import('express').Router} router
 * @param {string} pluginName - for log prefixing
 */
export function registerMigrationRoutes(router, pluginName = 'similharity') {

    /**
     * POST /chunks/migrate-to-sparse/create-target
     * Body: { sourceCollection, targetCollection?, vectorSize }
     * Creates the target collection with sparse_vectors schema.
     */
    router.post('/chunks/migrate-to-sparse/create-target', async (req, res) => {
        try {
            const { sourceCollection, targetCollection: rawTarget, vectorSize } = req.body;
            if (!sourceCollection || !vectorSize) {
                return res.status(400).json({ error: 'sourceCollection and vectorSize required' });
            }
            const target = rawTarget || `${sourceCollection}_v2`;

            // Bail if target exists (dev tool — single shot; do not overwrite).
            const collections = await qdrantBackend._request('GET', '/collections');
            const exists = collections.result?.collections?.some(c => c.name === target);
            if (exists) {
                return res.status(409).json({ error: `Target collection "${target}" already exists. Drop it first.` });
            }

            await qdrantBackend.ensureCollection(target, vectorSize, { nativeSparse: true });
            res.json({ ok: true, target });
        } catch (error) {
            console.error(`[${pluginName}] migrate/create-target error:`, error);
            res.status(500).json({ error: error.message });
        }
    });

    /**
     * POST /chunks/migrate-to-sparse/scroll-source
     * Body: { sourceCollection, offset?, limit? }
     * Scrolls a page of points (with text + dense vector + payload). Browser then
     * tokenizes locally and submits to /upsert-target.
     */
    router.post('/chunks/migrate-to-sparse/scroll-source', async (req, res) => {
        try {
            const { sourceCollection, offset = null, limit = 250 } = req.body;
            if (!sourceCollection) {
                return res.status(400).json({ error: 'sourceCollection required' });
            }

            const body = {
                limit,
                with_payload: true,
                with_vector: true,
                // Exclude the sentinel from the data being migrated; we write a fresh sentinel
                // on the target at finalize time.
                filter: {
                    must_not: [{ key: 'type', match: { value: '_vecthare_meta' } }],
                },
            };
            if (offset) body.offset = offset;

            const resp = await qdrantBackend._request('POST', `/collections/${sourceCollection}/points/scroll`, body);
            const points = (resp.result?.points || []).map(p => ({
                id: p.id,
                vector: p.vector,
                text: p.payload?.text || '',
                payload: p.payload,
            }));

            res.json({
                ok: true,
                points,
                nextOffset: resp.result?.next_page_offset || null,
            });
        } catch (error) {
            console.error(`[${pluginName}] migrate/scroll-source error:`, error);
            res.status(500).json({ error: error.message });
        }
    });

    /**
     * POST /chunks/migrate-to-sparse/upsert-target
     * Body: { targetCollection, points: [{id, vector, sparseVector, payload}] }
     * Bulk upsert points into the target collection. `vector` is the kept dense
     * vector from source; `sparseVector` is {indices, values} computed by the browser.
     */
    router.post('/chunks/migrate-to-sparse/upsert-target', async (req, res) => {
        try {
            const { targetCollection, points } = req.body;
            if (!targetCollection || !Array.isArray(points)) {
                return res.status(400).json({ error: 'targetCollection and points[] required' });
            }

            const formatted = points.map(p => ({
                id: p.id,
                vector: {
                    '': p.vector,
                    text_sparse: p.sparseVector,
                },
                payload: p.payload,
            }));

            await qdrantBackend._request('PUT', `/collections/${targetCollection}/points?wait=true`, {
                points: formatted,
            });

            res.json({ ok: true, inserted: formatted.length });
        } catch (error) {
            console.error(`[${pluginName}] migrate/upsert-target error:`, error);
            res.status(500).json({ error: error.message });
        }
    });

    /**
     * POST /chunks/migrate-to-sparse/finalize
     * Body: { sourceCollection, targetCollection, cjkTokenizerMode }
     * Writes the sentinel on the target, drops the source, then creates an alias
     * from `sourceCollection` → `targetCollection` so existing queries keep working.
     */
    router.post('/chunks/migrate-to-sparse/finalize', async (req, res) => {
        try {
            const { sourceCollection, targetCollection, cjkTokenizerMode, vectorSize } = req.body;
            if (!sourceCollection || !targetCollection || !cjkTokenizerMode || !vectorSize) {
                return res.status(400).json({ error: 'sourceCollection, targetCollection, cjkTokenizerMode, vectorSize required' });
            }

            // Write sentinel onto target with the tokenizer-mode lock.
            await qdrantBackend.setCollectionMetadata(targetCollection, {
                cjk_tokenizer_mode: cjkTokenizerMode,
                migrated_from: sourceCollection,
            }, vectorSize);

            // Drop the original collection (this also removes any alias pointing to it).
            await qdrantBackend._request('DELETE', `/collections/${sourceCollection}`);

            // Alias the original name → target so all existing query paths keep working.
            await qdrantBackend._request('POST', '/collections/aliases', {
                actions: [{
                    create_alias: {
                        alias_name: sourceCollection,
                        collection_name: targetCollection,
                    },
                }],
            });

            res.json({ ok: true, alias: sourceCollection, target: targetCollection });
        } catch (error) {
            console.error(`[${pluginName}] migrate/finalize error:`, error);
            res.status(500).json({ error: error.message });
        }
    });

    /**
     * POST /chunks/migrate-to-sparse/abort
     * Body: { targetCollection }
     * Drops the half-built target. Safe to call any time before finalize.
     */
    router.post('/chunks/migrate-to-sparse/abort', async (req, res) => {
        try {
            const { targetCollection } = req.body;
            if (!targetCollection) {
                return res.status(400).json({ error: 'targetCollection required' });
            }
            await qdrantBackend._request('DELETE', `/collections/${targetCollection}`);
            res.json({ ok: true });
        } catch (error) {
            console.error(`[${pluginName}] migrate/abort error:`, error);
            res.status(500).json({ error: error.message });
        }
    });
}
