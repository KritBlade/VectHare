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
     * Body: { sourceCollection, targetCollection, cjkTokenizerMode, vectorSize }
     *
     * Replaces the original collection in-place so queries keep using the same name:
     *   1. Drop the source
     *   2. Recreate source with the sparse_vectors schema
     *   3. Server-side scroll target → upsert into the freshly-created source
     *      (keeps dense + sparse vectors; no re-tokenization needed)
     *   4. Write sentinel onto source with the cjk_tokenizer_mode lock
     *   5. Drop the temporary target
     *
     * No Qdrant collection aliases involved (avoids the alias-resolution issues
     * seen with CJK-named collections on /query).
     */
    router.post('/chunks/migrate-to-sparse/finalize', async (req, res) => {
        try {
            const { sourceCollection, targetCollection, cjkTokenizerMode: requestedMode, vectorSize } = req.body;
            if (!sourceCollection || !targetCollection || !requestedMode || !vectorSize) {
                return res.status(400).json({ error: 'sourceCollection, targetCollection, cjkTokenizerMode, vectorSize required' });
            }

            // Prefer the mode locked into the target's sentinel (if one already exists from a
            // prior migration). This protects against the user changing CJK mode between a
            // failed migration and the recovery — the bakedinto tokens still use the original.
            let cjkTokenizerMode = requestedMode;
            try {
                const existingMeta = await qdrantBackend.getCollectionMetadata(targetCollection);
                if (existingMeta?.cjk_tokenizer_mode) {
                    cjkTokenizerMode = existingMeta.cjk_tokenizer_mode;
                    if (cjkTokenizerMode !== requestedMode) {
                        console.warn(`[${pluginName}] migrate/finalize: target sentinel says cjk=${cjkTokenizerMode}; ignoring client-supplied ${requestedMode}`);
                    }
                }
            } catch (e) { /* no sentinel yet — fine */ }

            // 1. Drop the original source collection.
            try {
                await qdrantBackend._request('DELETE', `/collections/${sourceCollection}`);
                console.log(`[${pluginName}] migrate/finalize: dropped source ${sourceCollection}`);
            } catch (e) {
                console.warn(`[${pluginName}] migrate/finalize: source drop failed (already gone?):`, e.message);
            }

            // 2. Recreate source with the sparse schema.
            await qdrantBackend.ensureCollection(sourceCollection, vectorSize, { nativeSparse: true });

            // 3. Server-side scroll target → upsert to source, in 250-point batches.
            let nextOffset = null;
            let copied = 0;
            while (true) {
                const scrollBody = {
                    limit: 250,
                    with_payload: true,
                    with_vector: true,
                    filter: { must_not: [{ key: 'type', match: { value: '_vecthare_meta' } }] },
                };
                if (nextOffset) scrollBody.offset = nextOffset;
                const page = await qdrantBackend._request('POST', `/collections/${targetCollection}/points/scroll`, scrollBody);
                const points = page.result?.points || [];
                if (points.length === 0) break;

                // Scroll returns vector as object form when collection has named vectors:
                //   { "": [...dense], "text_sparse": {indices, values} }
                // Pass through as-is when upserting.
                const formatted = points.map(p => ({
                    id: p.id,
                    vector: p.vector,
                    payload: p.payload,
                }));
                await qdrantBackend._request('PUT', `/collections/${sourceCollection}/points?wait=true`, {
                    points: formatted,
                });
                copied += formatted.length;

                nextOffset = page.result?.next_page_offset || null;
                if (!nextOffset) break;
            }
            console.log(`[${pluginName}] migrate/finalize: copied ${copied} points from ${targetCollection} → ${sourceCollection}`);

            // 4. Write sentinel onto source with the tokenizer-mode lock.
            await qdrantBackend.setCollectionMetadata(sourceCollection, {
                cjk_tokenizer_mode: cjkTokenizerMode,
                migrated_at: Date.now(),
            }, vectorSize);

            // 5. Drop the temporary target.
            try {
                await qdrantBackend._request('DELETE', `/collections/${targetCollection}`);
                console.log(`[${pluginName}] migrate/finalize: dropped temp ${targetCollection}`);
            } catch (e) {
                console.warn(`[${pluginName}] migrate/finalize: temp drop failed:`, e.message);
            }

            res.json({ ok: true, collection: sourceCollection, copied });
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
