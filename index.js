/**
 * Similharity Server Plugin
 *
 * Unified vector database backend for VectHare extension.
 * Supports multiple backends: Vectra (file-based), LanceDB, Qdrant
 *
 * All chunk operations go through unified /chunks/* endpoints.
 * Backend is specified via `backend` parameter in request body.
 *
 * @version 3.2.0
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { exec } from 'node:child_process';
import sanitize from 'sanitize-filename';
import vectra from 'vectra';
import lancedbBackend from './lancedb-backend.js';
import qdrantBackend from './qdrant-backend.js';
import milvusBackend from './milvus-backend.js';

const pluginName = 'similharity';
const pluginVersion = '3.2.0';

// ─── CJK-aware query keyword extractor ───────────────────────────────────────

// Full stopword list mirrored from VectHare/core/bm25-scorer.js (STOP_WORDS).
// Must be kept in sync manually — similharity is a Node.js server plugin and
// cannot import from the browser-side VectHare ESM bundle.
const _STOP_WORDS = new Set([
    // English stopwords
    'the', 'a', 'an', 'this', 'that', 'these', 'those', 'some', 'any', 'each',
    'every', 'both', 'either', 'neither', 'such', 'what', 'which', 'whose', 'i', 'me',
    'my', 'mine', 'myself', 'you', 'your', 'yours', 'yourself', 'he', 'him', 'his',
    'himself', 'she', 'her', 'hers', 'herself', 'it', 'its', 'itself', 'we', 'us',
    'our', 'ours', 'ourselves', 'they', 'them', 'their', 'theirs', 'themselves', 'who', 'whom',
    'whoever', 'someone', 'anyone', 'everyone', 'nobody', 'something', 'anything', 'everything', 'nothing', 'and',
    'or', 'but', 'nor', 'so', 'yet', 'for', 'because', 'although', 'while', 'whereas',
    'unless', 'until', 'since', 'when', 'whenever', 'where', 'wherever', 'whether', 'if', 'then',
    'than', 'as', 'in', 'on', 'at', 'to', 'of', 'with', 'by', 'from',
    'into', 'onto', 'upon', 'out', 'off', 'over', 'under', 'above', 'below', 'between',
    'among', 'through', 'during', 'before', 'after', 'behind', 'beside', 'beyond', 'within', 'without',
    'about', 'around', 'against', 'along', 'across', 'be', 'am', 'is', 'are', 'was',
    'were', 'been', 'being', 'have', 'has', 'had', 'having', 'do', 'does', 'did',
    'doing', 'done', 'will', 'would', 'shall', 'should', 'may', 'might', 'must', 'can',
    'could', 'get', 'got', 'go', 'went', 'gone', 'come', 'came', 'take', 'took',
    'taken', 'make', 'made', 'say', 'said', 'know', 'knew', 'think', 'thought', 'see',
    'saw', 'seen', 'want', 'use', 'find', 'found', 'give', 'gave', 'very', 'really',
    'quite', 'just', 'only', 'even', 'also', 'still', 'already', 'always', 'never', 'ever',
    'often', 'sometimes', 'usually', 'now', 'here', 'there', 'today', 'soon', 'again', 'much',
    'more', 'most', 'less', 'well', 'however', 'therefore', 'thus', 'too', 'enough', 'good',
    'great', 'best', 'better', 'bad', 'new', 'old', 'big', 'small', 'large', 'little',
    'long', 'short', 'high', 'low', 'same', 'different', 'other', 'another', 'next', 'last',
    'first', 'many', 'few', 'own', 'thing', 'things', 'way', 'ways', 'place', 'part',
    'case', 'point', 'fact', 'like', 'back', 'time', 'year', 'day', 'one', 'two',

    // Chinese stopwords (Simplified + Traditional)
    'three', '的', '地', '得', '着', '了', '过', '嘛', '呢', '吧',
    '啊', '哦', '哈', '嗯', '我', '你', '他', '她', '它', '谁',
    '这', '那', '哪', '我们', '你们', '他们', '她们', '它们', '是', '有',
    '在', '被', '让', '把', '使', '叫', '会', '要', '能', '说',
    '做', '来', '去', '到', '看', '用', '将', '和', '与', '及',
    '或', '但', '而', '因', '所', '如', '既', '虽', '若', '则',
    '就', '才', '也', '还', '都', '又', '再', '不', '没', '很',
    '最', '更', '只', '其', '此', '已', '正', '便', '即', '仍',
    '曾', '各', '该', '于', '以', '从', '由', '向', '往', '对',
    '为', '给', '按', '比', '跟', '同', '什么', '怎么', '为什么', '哪里',
    '一', '二', '三', '四', '五', '六', '七', '八', '九', '十',
    '百', '千', '万', '亿', '个', '些', '点', '多', '少', '几',
    '上', '下', '中', '内', '外', '里', '前', '后', '左', '右',
    '今', '年', '月', '日', '时', '现在', '以前', '以后', '但是', '所以',
    '因此', '然后', '虽然', '不过', '而且', '另外', '此外', '总之', '如果', '即使',
    '发出', '进行', '出现', '开始', '表示', '感到', '看到', '听到', '走向', '回到',
    '走进', '走出', '拿出', '拿起', '放下', '站起', '坐下', '转向', '继续', '停下',
    '离开', '来到', '回来', '出来', '进来', '上来', '下来', '完成', '结束', '发现',
    '明白', '知道', '觉得', '认为', '希望', '想到', '一下', '一起', '一直', '一样',
    '一边', '一旁', '一番', '一声', '微微', '轻轻', '慢慢', '缓缓', '渐渐', '稍微',
    '略微', '稍稍', '脸上', '身上', '手上', '眼中', '心中', '脑中', '胸口', '那是',
    '这是', '就是', '只是', '还是', '或是', '可是', '因为', '不管', '无论', '已经',
    '正在', '将要', '可以', '应该', '需要', '必须', '非常', '十分', '相当', '有些',
    '有点', '有时', '有人', '有什么', '自己', '彼此', '大家', '大概', '可能', '似乎',
    '好像', '确实', '布料', '声音', '气息', '气氛', '动作', '姿态', '表情', '眼神',
    '却', '现', '妳', '妳们', '您', '她的', '他的', '它的', '妳的', '你的',
    '我的', '著', '過', '這', '誰', '什麼', '我們', '你們', '他們', '她們',
    '它們', '讓', '會', '沒', '說', '將', '與', '卻', '還', '雖',
    '該', '從', '對', '為', '給', '於', '哪裡', '怎麼', '為什麼', '萬',
    '億', '個', '點', '幾', '裡', '裏', '後', '時', '現', '然後',
    '雖然', '不過', '總之', '妳們', '牠', '牠們', '發出', '進行', '出現', '開始',
    '聽到', '走進', '轉向', '繼續', '離開', '來到', '回來', '出來', '進來', '上來',
    '下來', '結束', '發現', '覺得', '認為', '一樣', '一邊', '一聲', '輕輕', '緩緩',
    '漸漸', '臉上', '腦中', '這是', '還是', '因為', '無論', '已經', '將要', '應該',
    '必須', '相當', '有點', '有時', '有什麼', '確實', '聲音', '氣息', '氣氛', '動作',
    '姿態',

    // Japanese stopwords (particles, auxiliaries, function words, connectors)
    'は', 'が', 'を', 'に', 'へ', 'で', 'と', 'も', 'の', 'や',
    'か', 'な', 'ね', 'よ', 'ぞ', 'さ', 'わ',
    'だ', 'です', 'ます', 'でした', 'ません', 'である', 'ある', 'いる', 'する', 'した',
    'して', 'ない', 'なく', 'なり', 'なる', 'れる', 'られる', 'たい',
    'これ', 'それ', 'あれ', 'この', 'その', 'あの', 'ここ', 'そこ', 'あそこ', 'どこ',
    'そして', 'しかし', 'だから', 'また', 'ただ', 'でも', 'ので', 'など', 'ため',
    'よう', 'もの', 'こと', 'ところ', 'ほう', 'ほか', 'まで', 'より', 'だけ', 'ばかり',
    'くらい', 'ぐらい', 'ほとんど', 'とても', 'かなり',

    // Korean stopwords (particles, postpositions, auxiliary verbs, conjunctions)
    '은', '는', '이', '가', '을', '를', '의', '에', '에서', '에게',
    '로', '으로', '와', '과', '도', '만', '부터', '까지', '보다',
    '처럼', '같이', '마다', '이나', '나', '든', '든지', '라도', '조차', '마저',
    '이것', '그것', '저것', '이게', '그게', '저게', '여기', '거기', '저기',
    '어디', '누구', '무엇', '어느',
    '이다', '이에요', '예요', '입니다', '이었다', '였다', '있다', '없다',
    '하다', '했다', '한다', '합니다', '했습니다', '되다', '됩니다', '됐다',
    '같다', '같은', '그런', '이런', '저런',
    '안', '못', '않다', '않고', '없이',
    '그리고', '그러나', '하지만', '그래서', '따라서', '그러므로', '또한', '또는',
    '혹은', '아니면', '만약', '비록', '즉', '결국', '왜냐하면', '때문에',
    '위해', '위해서', '통해', '통해서',
    '매우', '아주', '너무', '정말', '참', '좀', '조금', '많이', '잘', '더',
    '가장', '제일', '별로', '전혀', '거의', '약간', '꽤', '다시', '또', '이미',
    '아직', '항상', '자주', '보통', '갑자기', '함께', '서로', '모두', '다',
    '말하다', '생각하다', '보다', '오다', '가다', '나오다', '들어오다', '돌아오다',
]);

// Matches CJK ideographs + Kana + Hangul spans.
const _CJK_SPAN_RE = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]+/g;

/**
 * Extract search keywords from a mixed Latin/CJK query string.
 *
 * Strategy:
 *  1. Latin tokens — simple regex word extraction (min 3 chars, no stopwords).
 *  2. CJK spans   — Intl.Segmenter word granularity when available and producing
 *                   real multi-char words; otherwise bigram fallback.
 *  3. Dedup, strip stopwords, cap to maxKeywords.
 *
 * @param {string} searchText
 * @param {number} [maxKeywords=20]
 * @returns {string[]}
 */
function extractQueryKeywords(searchText, maxKeywords = 20) {
    const text = searchText.toLowerCase();
    const tokens = new Set();

    // ── Latin words (a-z, length ≥ 3, not in stopwords) ────────────────────
    const latinMatches = text.match(/[a-z][a-z0-9'_-]{2,}/g) || [];
    for (const tok of latinMatches) {
        if (!_STOP_WORDS.has(tok)) tokens.add(tok);
    }

    // ── CJK spans ──────────────────────────────────────────────────────────
    const spans = text.match(_CJK_SPAN_RE) || [];
    for (const span of spans) {
        let usedSegmenter = false;

        // Try Intl.Segmenter (Node 16+ with full ICU data).
        // Only trust it when it produces at least one genuine multi-char word;
        // single-char-only output means ICU lacks dictionary data → fall back.
        if (typeof Intl !== 'undefined' && Intl.Segmenter) {
            try {
                const seg = new Intl.Segmenter('zh', { granularity: 'word' });
                const segs = Array.from(seg.segment(span));
                const multiChar = segs.filter(s => s.isWordLike && s.segment.length >= 2);
                if (multiChar.length > 0) {
                    for (const { segment } of multiChar) {
                        if (!_STOP_WORDS.has(segment)) tokens.add(segment);
                    }
                    usedSegmenter = true;
                }
            } catch (_) { /* fallthrough */ }
        }

        if (!usedSegmenter) {
            // Bigram fallback — reliable across all ICU configurations.
            for (let i = 0; i + 1 < span.length; i++) {
                const bigram = span.slice(i, i + 2);
                if (!_STOP_WORDS.has(bigram)) tokens.add(bigram);
            }
        }
    }

    return Array.from(tokens).slice(0, maxKeywords);
}

/**
 * Initialize the plugin
 * @param {import('express').Router} router - Express router for plugin endpoints
 */
export async function init(router) {
    console.log(`[${pluginName}] Initializing v${pluginVersion}...`);

    // ========================================================================
    // BACKEND HANDLER - Routes requests to appropriate backend
    // ========================================================================

    /**
     * Ensures LanceDB is initialized before use
     * @param {object} directories - User directories containing vectors path
     */
    async function ensureLanceDBInitialized(directories) {
        if (!lancedbBackend.basePath) {
            console.log(`[${pluginName}] Auto-initializing LanceDB backend...`);
            await lancedbBackend.initialize(directories.vectors);
        }
    }

    function getBackendHandler(backend) {
        switch (backend) {
            case 'vectra':
            case 'standard':
                return {
                    type: 'vectra',

                    list: async (collectionId, source, model, directories, options = {}) => {
                        const store = await getIndex(directories, collectionId, source, model);
                        const items = await store.listItems();

                        // Apply pagination
                        const offset = options.offset || 0;
                        const limit = options.limit || items.length;
                        const paginatedItems = items.slice(offset, offset + limit);

                        return {
                            items: paginatedItems.map(item => ({
                                hash: item.metadata.hash,
                                text: item.metadata.text,
                                index: item.metadata.index,
                                vector: options.includeVectors ? item.vector : undefined,
                                metadata: item.metadata
                            })),
                            total: items.length,
                            offset,
                            limit,
                            hasMore: offset + limit < items.length
                        };
                    },

                    get: async (collectionId, hash, source, model, directories) => {
                        const store = await getIndex(directories, collectionId, source, model);
                        const items = await store.listItems();
                        const item = items.find(i => i.metadata.hash == hash);
                        if (!item) return null;
                        return {
                            hash: item.metadata.hash,
                            text: item.metadata.text,
                            index: item.metadata.index,
                            vector: item.vector,
                            metadata: item.metadata
                        };
                    },

                    insert: async (collectionId, items, source, model, directories, req) => {
                        const store = await getIndex(directories, collectionId, source, model);

                        // Generate embeddings if not provided
                        let itemsWithVectors = [...items];
                        const itemsNeedingVectors = itemsWithVectors.filter(i => !i.vector);

                        if (itemsNeedingVectors.length > 0) {
                            const texts = itemsNeedingVectors.map(i => i.text);
                            const vectors = await getVectorsForSource(source, texts, model, directories, req);

                            let vIndex = 0;
                            itemsWithVectors = itemsWithVectors.map(item => {
                                if (!item.vector) {
                                    return { ...item, vector: vectors[vIndex++] };
                                }
                                return item;
                            });
                        }

                        await store.beginUpdate();
                        for (const item of itemsWithVectors) {
                            await store.upsertItem({
                                vector: item.vector,
                                metadata: {
                                    hash: item.hash,
                                    text: item.text,
                                    index: item.index,
                                    ...item.metadata
                                }
                            });
                        }
                        await store.endUpdate();
                    },

                    updateText: async (collectionId, hash, newText, source, model, directories, req) => {
                        const store = await getIndex(directories, collectionId, source, model);
                        const items = await store.listItems();
                        const item = items.find(i => i.metadata.hash == hash);
                        if (!item) throw new Error('Chunk not found');

                        // Generate new embedding for the new text
                        const newVector = await getEmbeddingForSource(source, newText, model, directories, req);
                        const newHash = getStringHash(newText);

                        // Delete old item
                        await store.deleteItem(item.id);

                        // Insert updated item
                        await store.beginUpdate();
                        await store.upsertItem({
                            vector: newVector,
                            metadata: {
                                ...item.metadata,
                                hash: newHash,
                                text: newText
                            }
                        });
                        await store.endUpdate();

                        return { oldHash: hash, newHash, text: newText };
                    },

                    updateMetadata: async (collectionId, hash, metadata, source, model, directories) => {
                        const store = await getIndex(directories, collectionId, source, model);
                        const items = await store.listItems();
                        const item = items.find(i => i.metadata.hash == hash);
                        if (!item) throw new Error('Chunk not found');

                        // Delete and re-insert with same vector but updated metadata
                        await store.deleteItem(item.id);

                        await store.beginUpdate();
                        await store.upsertItem({
                            vector: item.vector,
                            metadata: {
                                ...item.metadata,
                                ...metadata,
                                hash: item.metadata.hash, // Preserve hash
                                text: item.metadata.text   // Preserve text
                            }
                        });
                        await store.endUpdate();

                        return { hash, metadata };
                    },

                    delete: async (collectionId, hashes, source, model, directories) => {
                        const store = await getIndex(directories, collectionId, source, model);
                        const items = await store.listItems();

                        let deleted = 0;
                        for (const hash of hashes) {
                            const item = items.find(i => i.metadata.hash == hash);
                            if (item) {
                                await store.deleteItem(item.id);
                                deleted++;
                            }
                        }
                        return deleted;
                    },

                    query: async (collectionId, queryVector, topK, threshold, source, model, directories, options = {}) => {
                        const store = await getIndex(directories, collectionId, source, model);
                        const results = await store.queryItems(queryVector, topK);
                        return results
                            .filter(r => r.score >= threshold)
                            .map(r => ({
                                hash: r.item.metadata.hash,
                                score: r.score,
                                text: r.item.metadata.text,
                                vector: options.includeVectors ? r.item.vector : undefined,
                                metadata: r.item.metadata
                            }));
                    },

                    purge: async (collectionId, source, model, directories) => {
                        const store = await getIndex(directories, collectionId, source, model);
                        if (await store.isIndexCreated()) {
                            await store.deleteIndex();
                        }
                    },

                    stats: async (collectionId, source, model, directories) => {
                        const store = await getIndex(directories, collectionId, source, model);
                        const items = await store.listItems();

                        let totalCharacters = 0;
                        let totalTokens = 0;
                        const sources = {};
                        const messageHashes = new Set();
                        let embeddingDimensions = 0;

                        for (const item of items) {
                            const text = item.metadata.text || '';
                            totalCharacters += text.length;
                            totalTokens += Math.ceil(text.length / 4); // Rough estimate

                            const src = item.metadata.source || 'unknown';
                            sources[src] = (sources[src] || 0) + 1;

                            if (item.metadata.originalMessageHash) {
                                messageHashes.add(item.metadata.originalMessageHash);
                            }

                            if (item.vector && item.vector.length > 0) {
                                embeddingDimensions = item.vector.length;
                            }
                        }

                        // Get file size
                        const indexPath = model
                            ? path.join(directories.vectors, sanitize(source), sanitize(collectionId), sanitize(model), 'index.json')
                            : path.join(directories.vectors, sanitize(source), sanitize(collectionId), 'index.json');

                        let storageSize = 0;
                        try {
                            const stat = await fs.stat(indexPath);
                            storageSize = stat.size;
                        } catch (e) {
                            // File may not exist yet, which is fine
                            console.debug(`[${pluginName}] Could not stat index file (may not exist): ${indexPath}`);
                        }

                        return {
                            chunkCount: items.length,
                            totalCharacters,
                            totalTokens,
                            storageSize,
                            embeddingDimensions,
                            avgChunkSize: items.length > 0 ? Math.round(totalCharacters / items.length) : 0,
                            messageCount: messageHashes.size,
                            sources,
                            backend: 'vectra',
                            model: model || '(default)'
                        };
                    }
                };

            case 'lancedb':
                return {
                    type: 'lancedb',

                    list: async (collectionId, source, model, directories, options = {}) => {
                        const items = await lancedbBackend.listItems(collectionId, source, options);
                        // Return same format as Vectra handler for consistency
                        const offset = options.offset || 0;
                        const limit = options.limit || items.length;
                        const paginatedItems = items.slice(offset, offset + limit);
                        return {
                            items: paginatedItems,
                            total: items.length,
                            offset,
                            limit,
                            hasMore: offset + limit < items.length
                        };
                    },

                    get: async (collectionId, hash, source) => {
                        return await lancedbBackend.getItem(collectionId, hash, source);
                    },

                    insert: async (collectionId, items, source, model, directories, req) => {
                        // Generate embeddings if not provided
                        let itemsWithVectors = [...items];
                        const itemsNeedingVectors = itemsWithVectors.filter(i => !i.vector);

                        if (itemsNeedingVectors.length > 0) {
                            console.log(`[LanceDB] Generating embeddings for ${itemsNeedingVectors.length} items`);
                            const texts = itemsNeedingVectors.map(i => i.text);
                            const vectors = await getVectorsForSource(source, texts, model, directories, req);

                            let vIndex = 0;
                            itemsWithVectors = itemsWithVectors.map(item => {
                                if (!item.vector) {
                                    const vector = vectors[vIndex++];
                                    if (!vector || !Array.isArray(vector) || vector.length === 0) {
                                        console.error(`[LanceDB] Failed to generate valid vector for item hash=${item.hash}, source=${source}, model=${model}`);
                                        throw new Error(`Failed to generate embedding for item. Source: ${source}, Model: ${model}`);
                                    }
                                    return { ...item, vector };
                                }
                                return item;
                            });
                        }

                        await lancedbBackend.insertVectors(collectionId, itemsWithVectors, source);
                    },

                    updateText: async (collectionId, hash, newText, source, model, directories, req) => {
                        // Get new embedding
                        const newVector = await getEmbeddingForSource(source, newText, model, directories, req);
                        const newHash = getStringHash(newText);
                        await lancedbBackend.updateItem(collectionId, hash, { text: newText, hash: newHash, vector: newVector }, source);
                        return { oldHash: hash, newHash, text: newText };
                    },

                    updateMetadata: async (collectionId, hash, metadata, source) => {
                        await lancedbBackend.updateItemMetadata(collectionId, hash, metadata, source);
                        return { hash, metadata };
                    },

                    delete: async (collectionId, hashes, source) => {
                        await lancedbBackend.deleteVectors(collectionId, hashes, source);
                        return hashes.length;
                    },

                    query: async (collectionId, queryVector, topK, threshold, source, model, directories, options = {}) => {
                        const results = await lancedbBackend.queryVectors(collectionId, queryVector, topK, threshold, source);
                        return results;
                    },

                    purge: async (collectionId, source) => {
                        await lancedbBackend.purgeCollection(collectionId, source);
                    },

                    stats: async (collectionId, source) => {
                        return await lancedbBackend.getCollectionStats(collectionId, source);
                    }
                };

            case 'qdrant':
                return {
                    type: 'qdrant',

                    list: async (collectionId, source, model, directories, options = {}) => {
                        const items = await qdrantBackend.listItems(collectionId, options.filters || {}, options);
                        // Return same format as Vectra handler for consistency
                        const offset = options.offset || 0;
                        const limit = options.limit || items.length;
                        const paginatedItems = items.slice(offset, offset + limit);
                        return {
                            items: paginatedItems,
                            total: items.length,
                            offset,
                            limit,
                            hasMore: offset + limit < items.length
                        };
                    },

                    get: async (collectionId, hash, source, model, directories, filters = {}) => {
                        return await qdrantBackend.getItem(collectionId, hash, filters);
                    },

                    insert: async (collectionId, items, source, model, directories, req, filters = {}) => {
                        // Generate embeddings if not provided
                        let itemsWithVectors = [...items];
                        const itemsNeedingVectors = itemsWithVectors.filter(i => !i.vector);

                        if (itemsNeedingVectors.length > 0) {
                            console.log(`[Qdrant] Generating embeddings for ${itemsNeedingVectors.length} items`);
                            const texts = itemsNeedingVectors.map(i => i.text);
                            const vectors = await getVectorsForSource(source, texts, model, directories, req);

                            let vIndex = 0;
                            itemsWithVectors = itemsWithVectors.map(item => {
                                if (!item.vector) {
                                    const vector = vectors[vIndex++];
                                    if (!vector || !Array.isArray(vector) || vector.length === 0) {
                                        console.error(`[Qdrant] Failed to generate valid vector for item hash=${item.hash}, source=${source}, model=${model}`);
                                        throw new Error(`Failed to generate embedding for item. Source: ${source}, Model: ${model}`);
                                    }
                                    return { ...item, vector };
                                }
                                return item;
                            });
                        }

                        // Pass source and model for embedding tracking
                        await qdrantBackend.insertVectors(collectionId, itemsWithVectors, {
                            ...filters,
                            embeddingSource: source,
                            embeddingModel: model,
                        });
                    },

                    updateText: async (collectionId, hash, newText, source, model, directories, req, filters = {}) => {
                        const newVector = await getEmbeddingForSource(source, newText, model, directories, req);
                        const newHash = getStringHash(newText);
                        await qdrantBackend.updateItem(collectionId, hash, { text: newText, hash: newHash, vector: newVector }, filters);
                        return { oldHash: hash, newHash, text: newText };
                    },

                    updateMetadata: async (collectionId, hash, metadata, source, model, directories, filters = {}) => {
                        await qdrantBackend.updateItemMetadata(collectionId, hash, metadata, filters);
                        return { hash, metadata };
                    },

                    delete: async (collectionId, hashes, source, model, directories, filters = {}) => {
                        await qdrantBackend.deleteVectors(collectionId, hashes);
                        return hashes.length;
                    },

                    query: async (collectionId, queryVector, topK, threshold, source, model, directories, options = {}) => {
                        const results = await qdrantBackend.queryVectors(collectionId, queryVector, topK, threshold, options.filters || {});
                        return results;
                    },

                    purge: async (collectionId, source, model, directories, filters = {}) => {
                        await qdrantBackend.purgeAll(collectionId, filters);
                    },

                    stats: async (collectionId, source, model, directories, filters = {}) => {
                        return await qdrantBackend.getCollectionStats(collectionId, filters);
                    }
                };

            case 'milvus':
                return {
                    type: 'milvus',

                    list: async (collectionId, source, model, directories, options = {}) => {
                        const items = await milvusBackend.listItems(collectionId, options.filters || {}, options);
                        const offset = options.offset || 0;
                        const limit = options.limit || items.length;
                        return {
                            items: items,
                            total: items.length,
                            offset,
                            limit,
                            hasMore: items.length >= limit
                        };
                    },

                    get: async (collectionId, hash, source, model, directories, filters = {}) => {
                        return await milvusBackend.getItem(collectionId, hash, filters);
                    },

                    insert: async (collectionId, items, source, model, directories, req, filters = {}) => {
                        // Generate embeddings if not provided
                        let itemsWithVectors = [...items];
                        const itemsNeedingVectors = itemsWithVectors.filter(i => !i.vector);

                        if (itemsNeedingVectors.length > 0) {
                            console.log(`[Milvus] Generating embeddings for ${itemsNeedingVectors.length} items`);
                            const texts = itemsNeedingVectors.map(i => i.text);
                            const vectors = await getVectorsForSource(source, texts, model, directories, req);

                            let vIndex = 0;
                            itemsWithVectors = itemsWithVectors.map(item => {
                                if (!item.vector) {
                                    return { ...item, vector: vectors[vIndex++] };
                                }
                                return item;
                            });
                        }

                        await milvusBackend.insertVectors(collectionId, itemsWithVectors, {
                            ...filters,
                            embeddingSource: source,
                            embeddingModel: model,
                        });
                    },

                    updateText: async (collectionId, hash, newText, source, model, directories, req, filters = {}) => {
                        const newVector = await getEmbeddingForSource(source, newText, model, directories, req);
                        const newHash = getStringHash(newText);
                        await milvusBackend.updateItem(collectionId, hash, { text: newText, hash: newHash, vector: newVector }, filters);
                        return { oldHash: hash, newHash, text: newText };
                    },

                    updateMetadata: async (collectionId, hash, metadata, source, model, directories, filters = {}) => {
                        await milvusBackend.updateItem(collectionId, hash, metadata, filters);
                        return { hash, metadata };
                    },

                    delete: async (collectionId, hashes, source, model, directories, filters = {}) => {
                        await milvusBackend.deleteVectors(collectionId, hashes);
                        return hashes.length;
                    },

                    query: async (collectionId, queryVector, topK, threshold, source, model, directories, options = {}) => {
                        const results = await milvusBackend.queryCollection(collectionId, queryVector, topK, options.filters || {});
                        return results.filter(r => r.score >= threshold);
                    },

                    purge: async (collectionId, source, model, directories, filters = {}) => {
                        await milvusBackend.purgeCollection(collectionId, filters);
                    },

                    stats: async (collectionId, source, model, directories, filters = {}) => {
                        return await milvusBackend.getCollectionStats(collectionId, filters);
                    }
                };

            default:
                throw new Error(`Unknown backend: ${backend}`);
        }
    }

    // ========================================================================
    // UTILITY ENDPOINTS
    // ========================================================================

    /**
     * GET /api/plugins/similharity/health
     * Overall plugin health check
     */
    router.get('/health', (req, res) => {
        res.json({
            status: 'ok',
            plugin: pluginName,
            version: pluginVersion,
            backends: ['vectra', 'lancedb', 'qdrant', 'milvus']
        });
    });

    /**
     * POST /api/plugins/similharity/open-folder
     * Opens collection folder in file explorer
     */
    router.post('/open-folder', async (req, res) => {
        try {
            const { collectionId, backend, source } = req.body;

            if (!collectionId || !backend) {
                return res.status(400).json({ error: 'collectionId and backend are required' });
            }

            const vectorsPath = req.user.directories.vectors;
            let folderPath;

            if (backend === 'lancedb') {
                // LanceDB structure: lancedb/{source}/{collectionId}.lance
                const effectiveSource = source || 'bananabread';
                folderPath = path.join(vectorsPath, 'lancedb', effectiveSource, `${collectionId}.lance`);
            } else if (backend === 'qdrant') {
                return res.status(400).json({ error: 'Qdrant collections are stored remotely' });
            } else {
                const effectiveSource = source || 'transformers';
                folderPath = path.join(vectorsPath, effectiveSource, collectionId);
            }

            folderPath = path.resolve(folderPath);

            try {
                await fs.access(folderPath);
            } catch {
                return res.status(404).json({ error: `Folder not found: ${folderPath}` });
            }

            const platform = process.platform;
            const cmd = platform === 'win32' ? `start "" "${folderPath}"`
                : platform === 'darwin' ? `open "${folderPath}"`
                : `xdg-open "${folderPath}"`;

            exec(cmd, { shell: true });
            res.json({ success: true, path: folderPath });

        } catch (error) {
            console.error(`[${pluginName}] open-folder error:`, error);
            res.status(500).json({ error: error.message });
        }
    });

    /**
     * GET /api/plugins/similharity/collections
     * Lists ALL collections across ALL backends
     */
    router.get('/collections', async (req, res) => {
        try {
            const vectorsPath = req.user.directories.vectors;
            const allCollections = await scanAllSourcesForCollections(vectorsPath);

            res.json({
                success: true,
                count: allCollections.length,
                collections: allCollections
            });
        } catch (error) {
            console.error(`[${pluginName}] collections error:`, error);
            res.status(500).json({ error: error.message });
        }
    });

    /**
     * GET /api/plugins/similharity/sources
     * Lists available embedding sources
     */
    router.get('/sources', async (req, res) => {
        try {
            const vectorsPath = req.user.directories.vectors;
            const entries = await fs.readdir(vectorsPath, { withFileTypes: true });
            const sources = entries.filter(e => e.isDirectory()).map(e => e.name);

            res.json({ success: true, sources });
        } catch (error) {
            console.error(`[${pluginName}] sources error:`, error);
            res.status(500).json({ error: error.message });
        }
    });

    /**
     * POST /api/plugins/similharity/get-embedding
     * Get embedding for single text
     */
    router.post('/get-embedding', async (req, res) => {
        try {
            const { text, source, model = '' } = req.body;

            if (!text || !source) {
                return res.status(400).json({ error: 'text and source are required' });
            }

            const embedding = await getEmbeddingForSource(source, text, model, req.user.directories, req);
            res.json({ success: true, embedding });

        } catch (error) {
            console.error(`[${pluginName}] get-embedding error:`, error);
            res.status(500).json({ error: error.message });
        }
    });

    /**
     * POST /api/plugins/similharity/batch-embeddings
     * Get embeddings for multiple texts
     */
    router.post('/batch-embeddings', async (req, res) => {
        try {
            const { texts, source, model = '' } = req.body;

            if (!texts || !Array.isArray(texts) || !source) {
                return res.status(400).json({ error: 'texts array and source are required' });
            }

            const embeddings = await getVectorsForSource(source, texts, model, req.user.directories, req);
            res.json({ success: true, embeddings });

        } catch (error) {
            console.error(`[${pluginName}] batch-embeddings error:`, error);
            res.status(500).json({ error: error.message });
        }
    });

    // ========================================================================
    // BACKEND MANAGEMENT ENDPOINTS
    // ========================================================================

    /**
     * GET /api/plugins/similharity/backend/health/:backend
     * Health check for specific backend
     */
    router.get('/backend/health/:backend', async (req, res) => {
        try {
            const { backend } = req.params;
            let healthy = false;
            let message = '';

            switch (backend) {
                case 'vectra':
                case 'standard':
                    healthy = true;
                    message = 'Vectra is always available (file-based)';
                    break;

                case 'lancedb':
                    if (!lancedbBackend.basePath) {
                        await lancedbBackend.initialize(req.user.directories.vectors);
                    }
                    healthy = lancedbBackend.basePath != null;
                    message = healthy ? 'LanceDB initialized' : 'LanceDB not initialized';
                    break;

                case 'qdrant':
                    healthy = await qdrantBackend.healthCheck();
                    message = healthy ? 'Qdrant connected' : 'Qdrant not available';
                    break;

                case 'milvus':
                    healthy = await milvusBackend.healthCheck();
                    message = healthy ? 'Milvus connected' : 'Milvus not available';
                    break;

                default:
                    return res.status(400).json({ error: `Unknown backend: ${backend}` });
            }

            res.json({ backend, healthy, message });

        } catch (error) {
            console.error(`[${pluginName}] backend/health error:`, error);
            res.status(500).json({ backend: req.params.backend, healthy: false, error: error.message });
        }
    });

    /**
     * POST /api/plugins/similharity/backend/init/:backend
     * Initialize specific backend
     */
    router.post('/backend/init/:backend', async (req, res) => {
        try {
            const { backend } = req.params;
            const config = req.body;

            switch (backend) {
                case 'vectra':
                case 'standard':
                    res.json({ success: true, message: 'Vectra requires no initialization' });
                    break;

                case 'lancedb':
                    await lancedbBackend.initialize(req.user.directories.vectors);
                    res.json({ success: true, message: 'LanceDB initialized' });
                    break;

                case 'qdrant':
                    await qdrantBackend.initialize(config);
                    res.json({ success: true, message: 'Qdrant initialized' });
                    break;

                case 'milvus':
                    await milvusBackend.initialize(config);
                    res.json({ success: true, message: 'Milvus initialized' });
                    break;

                default:
                    return res.status(400).json({ error: `Unknown backend: ${backend}` });
            }

        } catch (error) {
            console.error(`[${pluginName}] backend/init error:`, error);
            res.status(500).json({ error: error.message });
        }
    });

/**
 * Get multiple embeddings for texts from specified source
 */
async function getVectorsForSource(source, texts, model, directories, req) {
    // Specialized batch handling
    if (source === 'bananabread') {
        // BananaBread llama.cpp-compatible endpoint
        let apiUrl = req.body.apiUrl || 'http://localhost:8008';
        let apiKey = req.body.apiKey || '';

        if (!apiUrl || typeof apiUrl !== 'string' || apiUrl.trim() === '') {
            throw new Error('BananaBread: apiUrl is missing or invalid. Configure the embedding URL in VectHare settings.');
        }
        apiUrl = apiUrl.trim();

        let url;
        try {
            url = new URL(apiUrl);
            url.pathname = '/embedding';
        } catch (e) {
            throw new Error(`BananaBread: Invalid URL format "${apiUrl}" - ${e.message}`);
        }

        const headers = { 'Content-Type': 'application/json' };
        if (apiKey) {
            headers['Authorization'] = `Bearer ${apiKey}`;
        }

        const BATCH_SIZE = 20;
        const allEmbeddings = [];

        try {
            for (let i = 0; i < texts.length; i += BATCH_SIZE) {
                const batchTexts = texts.slice(i, i + BATCH_SIZE);
                // console.log(`[BananaBread] Processing batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(texts.length / BATCH_SIZE)} (${batchTexts.length} items)`);

                const response = await fetch(url.toString(), {
                    method: 'POST',
                    headers: headers,
                    body: JSON.stringify({ content: batchTexts }),
                });

                if (!response.ok) {
                    const errorText = await response.text();
                    throw new Error(`BananaBread: ${response.statusText} ${errorText}`);
                }

                const data = await response.json();
                const embeddings = data.embedding;

                if (!embeddings) {
                    throw new Error('BananaBread: Invalid response format (missing embedding)');
                }

                if (Array.isArray(embeddings)) {
                    // Check for single item flattened response
                    if (batchTexts.length === 1 && typeof embeddings[0] === 'number') {
                        allEmbeddings.push(embeddings);
                    } else if (Array.isArray(embeddings[0])) {
                        allEmbeddings.push(...embeddings);
                    } else {
                         // Some providers might return a single vector for batch of 1 as a flat array even if asked in batch mode
                         if (batchTexts.length === 1 && Array.isArray(embeddings)) {
                             allEmbeddings.push(embeddings);
                         } else {
                            throw new Error('BananaBread: Unexpected embedding format');
                         }
                    }
                } else {
                    throw new Error('BananaBread: Unexpected embedding format (not array)');
                }
            }

            return allEmbeddings;

        } catch (e) {
            console.error(`[BananaBread] Batch embedding error:`, e);
            throw e;
        }
    }

    // API-based sources: run in parallel — each call is a network request and parallelism
    // reduces total wall-clock time from N×T to ~T (limited by remote server, not local GPU).
    // Local GPU sources (transformers, ollama, llamacpp, koboldcpp) serialize internally, so
    // parallel JS calls would queue on the model anyway — keep them sequential to avoid OOM.
    const parallelSources = new Set(['openai', 'togetherai', 'mistral', 'electronhub', 'openrouter', 'nomicai', 'cohere']);
    if (parallelSources.has(source)) {
        return await Promise.all(texts.map(text => _getLegacySingleEmbedding(source, text, model, directories, req)));
    }

    // Default fallback: sequential processing for local/GPU sources
    const results = [];
    for (const text of texts) {
        results.push(await _getLegacySingleEmbedding(source, text, model, directories, req));
    }
    return results;
}

/**
 * Wrapper for single embedding (backwards compatibility)
 */
async function getEmbeddingForSource(source, text, model, directories, req) {
    const vectors = await getVectorsForSource(source, [text], model, directories, req);
    return vectors[0];
}

/**
 * Helper function for KoboldCpp embedding generation
 * @param {string} text - Text to embed
 * @param {string} model - Model name
 * @param {object} req - Request object containing apiUrl
 * @returns {Promise<number[]>} Embedding vector
 */
async function _getKoboldCppEmbedding(text, model, req) {
    const apiUrl = req.body?.apiUrl || 'http://localhost:5001';

    let url;
    try {
        url = new URL(apiUrl);
        // Ensure we're hitting the embeddings endpoint
        if (!url.pathname.includes('/embeddings')) {
            url.pathname = url.pathname.replace(/\/?$/, '/v1/embeddings').replace(/\/+/g, '/');
        }
    } catch (e) {
        throw new Error(`KoboldCpp: Invalid URL format "${apiUrl}" - ${e.message}`);
    }

    const response = await fetch(url.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            input: text,
            model: model || 'koboldcpp',
        }),
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`KoboldCpp: ${response.status} ${response.statusText} - ${errorText}`);
    }

    const data = await response.json();
    // OpenAI format: { data: [{ embedding: [...] }] }
    if (data?.data?.[0]?.embedding) {
        return data.data[0].embedding;
    }
    // Fallback: direct embedding array
    if (Array.isArray(data?.embedding)) {
        return data.embedding;
    }
    throw new Error('KoboldCpp: Invalid response format - no embedding found');
}

/**
 * Legacy single embedding function (renamed)
 */
async function _getLegacySingleEmbedding(source, text, model, directories, req) {
    switch (source) {
        case 'transformers': {
            const { getTransformersVector } = await import('../../src/vectors/embedding.js');
            return await getTransformersVector(text);
        }
        case 'openai':
        case 'togetherai':
        case 'mistral':
        case 'electronhub':
        case 'openrouter': {
            const { getOpenAIVector } = await import('../../src/vectors/openai-vectors.js');
            // ElectronHub requires a model name, provide default if empty
            const effectiveModel = (source === 'electronhub' && !model) ? 'text-embedding-ada-002' : model;
            return await getOpenAIVector(text, source, directories, effectiveModel);
        }
        case 'nomicai': {
            const { getNomicAIVector } = await import('../../src/vectors/nomicai-vectors.js');
            return await getNomicAIVector(text, source, directories);
        }
        case 'cohere': {
            const { getCohereVector } = await import('../../src/vectors/cohere-vectors.js');
            return await getCohereVector(text, true, directories, model);
        }
        case 'koboldcpp': {
            return await _getKoboldCppEmbedding(text, model, req);
        }
        case 'ollama': {
            const { getOllamaVector } = await import('../../src/vectors/ollama-vectors.js');
            const apiUrl = req.body?.apiUrl || 'http://localhost:11434';
            const keep = req.body?.keep || false;
            return await getOllamaVector(text, apiUrl, model, keep, directories);
        }
        case 'llamacpp': {
            const { getLlamaCppVector } = await import('../../src/vectors/llamacpp-vectors.js');
            const apiUrl = req.body?.apiUrl || 'http://localhost:8080';
            return await getLlamaCppVector(text, apiUrl, directories);
        }
        case 'bananabread': {
            // Legacy single-item fallback (should normally be handled by batch handler)
            return (await getVectorsForSource(source, [text], model, directories, req))[0];
        }
        case 'vllm': {
            const { getVllmVector } = await import('../../src/vectors/vllm-vectors.js');
            const apiUrl = req.body?.apiUrl || 'http://localhost:8000';
            return await getVllmVector(text, apiUrl, model, directories);
        }
        case 'palm':
        case 'vertexai': {
            const googleVectors = await import('../../src/vectors/google-vectors.js');
            if (source === 'palm') {
                return await googleVectors.getMakerSuiteVector(text, model, req);
            } else {
                return await googleVectors.getVertexVector(text, model, req);
            }
        }
        case 'extras': {
            const { getExtrasVector } = await import('../../src/vectors/extras-vectors.js');
            const extrasUrl = req.body?.extrasUrl || 'http://localhost:5100';
            const extrasKey = req.body?.extrasKey || '';
            return await getExtrasVector(text, extrasUrl, extrasKey);
        }
        default:
            throw new Error(`Unknown vector source: ${source}`);
    }
}

    // ========================================================================
    // UNIFIED CHUNK ENDPOINTS
    // ========================================================================

    /**
     * POST /api/plugins/similharity/chunks/list
     * List all chunks in a collection with pagination
     * Body: { backend, collectionId, source?, model?, offset?, limit?, includeVectors?, filters? }
     */
    router.post('/chunks/list', async (req, res) => {
        try {
            const {
                backend = 'vectra',
                collectionId,
                source = 'transformers',
                model = '',
                offset = 0,
                limit = 100,
                includeVectors = false,
                filters = {}
            } = req.body;

            if (!collectionId) {
                return res.status(400).json({ error: 'collectionId is required' });
            }

            // Auto-init LanceDB if needed
            if (backend === 'lancedb') {
                await ensureLanceDBInitialized(req.user.directories);
            }

            const handler = getBackendHandler(backend);
            const result = await handler.list(collectionId, source, model, req.user.directories, {
                offset,
                limit,
                includeVectors,
                filters
            });

            res.json({
                success: true,
                backend: handler.type,
                collectionId,
                ...result
            });

        } catch (error) {
            console.error(`[${pluginName}] chunks/list error:`, error);
            res.status(500).json({ error: error.message });
        }
    });

    /**
     * GET /api/plugins/similharity/chunks/:hash
     * Get single chunk by hash
     * Query: backend, collectionId, source?, model?
     */
    router.get('/chunks/:hash', async (req, res) => {
        try {
            const { hash } = req.params;
            const { backend = 'vectra', collectionId, source = 'transformers', model = '' } = req.query;
            // Parse filters from query string (JSON encoded)
            let filters = {};
            if (req.query.filters) {
                try {
                    filters = JSON.parse(req.query.filters);
                } catch (e) {
                    console.warn(`[${pluginName}] Invalid filters JSON:`, req.query.filters);
                }
            }

            if (!collectionId) {
                return res.status(400).json({ error: 'collectionId is required' });
            }

            if (backend === 'lancedb') {
                await ensureLanceDBInitialized(req.user.directories);
            }

            const handler = getBackendHandler(backend);
            const chunk = await handler.get(collectionId, hash, source, model, req.user.directories, filters);

            if (!chunk) {
                return res.status(404).json({ error: 'Chunk not found' });
            }

            res.json({ success: true, chunk });

        } catch (error) {
            console.error(`[${pluginName}] chunks/:hash error:`, error);
            res.status(500).json({ error: error.message });
        }
    });

    /**
     * POST /api/plugins/similharity/chunks/insert
     * Insert new chunks
     * Body: { backend, collectionId, items: [{hash, text, index, metadata?, vector?}], source?, model? }
     */
    router.post('/chunks/insert', async (req, res) => {
        try {
            const {
                backend = 'vectra',
                collectionId,
                items,
                source = 'transformers',
                model = '',
                filters = {}
            } = req.body;

            if (!collectionId) {
                return res.status(400).json({ error: 'collectionId is required' });
            }
            if (!items || !Array.isArray(items)) {
                return res.status(400).json({ error: 'items array is required' });
            }

            if (backend === 'lancedb') {
                await ensureLanceDBInitialized(req.user.directories);
            }

            const handler = getBackendHandler(backend);
            await handler.insert(collectionId, items, source, model, req.user.directories, req, filters);

            res.json({
                success: true,
                backend: handler.type,
                collectionId,
                inserted: items.length
            });

        } catch (error) {
            console.error(`[${pluginName}] chunks/insert error:`, error);
            res.status(500).json({ error: error.message });
        }
    });

    /**
     * PATCH /api/plugins/similharity/chunks/:hash/text
     * Update chunk text (triggers re-embedding)
     * Body: { backend, collectionId, text, source?, model? }
     */
    router.patch('/chunks/:hash/text', async (req, res) => {
        try {
            const { hash } = req.params;
            const {
                backend = 'vectra',
                collectionId,
                text,
                source = 'transformers',
                model = '',
                filters = {}
            } = req.body;

            if (!collectionId || !text) {
                return res.status(400).json({ error: 'collectionId and text are required' });
            }

            if (backend === 'lancedb') {
                await ensureLanceDBInitialized(req.user.directories);
            }

            const handler = getBackendHandler(backend);
            const result = await handler.updateText(collectionId, hash, text, source, model, req.user.directories, req, filters);

            res.json({
                success: true,
                backend: handler.type,
                ...result
            });

        } catch (error) {
            console.error(`[${pluginName}] chunks/:hash/text error:`, error);
            res.status(500).json({ error: error.message });
        }
    });

    /**
     * PATCH /api/plugins/similharity/chunks/:hash/metadata
     * Update chunk metadata (no re-embedding)
     * Body: { backend, collectionId, metadata, source?, model? }
     */
    router.patch('/chunks/:hash/metadata', async (req, res) => {
        try {
            const { hash } = req.params;
            const {
                backend = 'vectra',
                collectionId,
                metadata,
                source = 'transformers',
                model = '',
                filters = {}
            } = req.body;

            if (!collectionId || !metadata) {
                return res.status(400).json({ error: 'collectionId and metadata are required' });
            }

            if (backend === 'lancedb') {
                await ensureLanceDBInitialized(req.user.directories);
            }

            const handler = getBackendHandler(backend);
            const result = await handler.updateMetadata(collectionId, hash, metadata, source, model, req.user.directories, filters);

            res.json({
                success: true,
                backend: handler.type,
                ...result
            });

        } catch (error) {
            console.error(`[${pluginName}] chunks/:hash/metadata error:`, error);
            res.status(500).json({ error: error.message });
        }
    });

    /**
     * POST /api/plugins/similharity/chunks/delete
     * Delete chunks by hash
     * Body: { backend, collectionId, hashes, source?, model? }
     */
    router.post('/chunks/delete', async (req, res) => {
        try {
            const {
                backend = 'vectra',
                collectionId,
                hashes,
                source = 'transformers',
                model = '',
                filters = {}
            } = req.body;

            if (!collectionId) {
                return res.status(400).json({ error: 'collectionId is required' });
            }
            if (!hashes || !Array.isArray(hashes)) {
                return res.status(400).json({ error: 'hashes array is required' });
            }

            if (backend === 'lancedb') {
                await ensureLanceDBInitialized(req.user.directories);
            }

            const handler = getBackendHandler(backend);
            const deleted = await handler.delete(collectionId, hashes, source, model, req.user.directories, filters);

            res.json({
                success: true,
                backend: handler.type,
                collectionId,
                deleted
            });

        } catch (error) {
            console.error(`[${pluginName}] chunks/delete error:`, error);
            res.status(500).json({ error: error.message });
        }
    });

    /**
     * POST /api/plugins/similharity/chunks/query
     * Query chunks by semantic similarity
     * Body: { backend, collectionId, queryVector OR searchText, topK?, threshold?, source?, model?, includeVectors? }
     */
    router.post('/chunks/query', async (req, res) => {
        try {
            const {
                backend = 'vectra',
                collectionId,
                queryVector,
                searchText,
                topK = 10,
                threshold = 0.0,
                source = 'transformers',
                model = '',
                includeVectors = false,
                filters = {}
            } = req.body;

            if (!collectionId) {
                return res.status(400).json({ error: 'collectionId is required' });
            }
            if (!queryVector && !searchText) {
                return res.status(400).json({ error: 'queryVector or searchText is required' });
            }

            if (backend === 'lancedb') {
                await ensureLanceDBInitialized(req.user.directories);
            }

            // Get query vector if not provided
            let vector = queryVector;
            if (!vector && searchText) {
                vector = await getEmbeddingForSource(source, searchText, model, req.user.directories, req);
            }

            const handler = getBackendHandler(backend);
            const results = await handler.query(collectionId, vector, topK, threshold, source, model, req.user.directories, {
                includeVectors,
                filters
            });

            res.json({
                success: true,
                backend: handler.type,
                collectionId,
                count: results.length,
                results
            });

        } catch (error) {
            console.error(`[${pluginName}] chunks/query error:`, error);
            res.status(500).json({ error: error.message });
        }
    });

    /**
     * POST /api/plugins/similharity/chunks/hybrid-query
     * Hybrid search combining vector similarity and keyword matching
     * Body: { backend, collectionId, searchText OR queryVector, keywords?, topK?, options?, filters?, source?, model? }
     */
    router.post('/chunks/hybrid-query', async (req, res) => {
        try {
            const {
                backend = 'qdrant',
                collectionId,
                queryVector,
                searchText,
                keywords,
                topK = 10,
                options = {},
                filters = {},
                source = 'transformers',
                model = '',
                hybridOptions = {}
            } = req.body;

            if (!collectionId) {
                return res.status(400).json({ error: 'collectionId is required' });
            }
            if (!queryVector && !searchText) {
                return res.status(400).json({ error: 'queryVector or searchText is required' });
            }

            // Only Qdrant, Milvus support native hybrid query
            if (backend !== 'qdrant' && backend !== 'milvus') {
                return res.status(400).json({ error: `Backend ${backend} does not support native hybrid query` });
            }

            // Generate embedding if searchText provided
            let vector = queryVector;
            if (!vector && searchText) {
                vector = await getEmbeddingForSource(source, searchText, model, req.user.directories, req);
            }

            // Extract keywords if not provided
            let extractedKeywords = keywords;
            if (!extractedKeywords && searchText) {
                extractedKeywords = extractQueryKeywords(searchText, 20);
                if (hybridOptions.eventbaseDebug) {
                    console.log(`[Qdrant] extractQueryKeywords → ${extractedKeywords.length} tokens: ${extractedKeywords.join(', ')}`);
                }
            }

            // Merge hybridOptions with options
            const mergedOptions = {
                ...hybridOptions,
                ...options
            };

            if (backend === 'qdrant') {
                const results = await qdrantBackend.hybridQuery(
                    collectionId,
                    vector,
                    extractedKeywords || [],
                    topK,
                    mergedOptions,
                    filters
                );

                res.json({
                    success: true,
                    backend: 'qdrant',
                    collectionId,
                    count: results.length,
                    results: results.map(r => ({
                        hash: r.hash,
                        text: r.text,
                        score: r.score,
                        metadata: r.metadata,
                        vectorScore: r.debug?.vectorScore,
                        textScore: r.debug?.keywordScore,
                        debug: r.debug
                    }))
                });
            } else if (backend === 'milvus') {
                // Milvus hybrid query implementation (if available)
                const results = await milvusBackend.hybridQuery(
                    collectionId,
                    vector,
                    extractedKeywords || [],
                    topK,
                    mergedOptions,
                    filters
                );

                res.json({
                    success: true,
                    backend: 'milvus',
                    collectionId,
                    count: results.length,
                    results: results.map(r => ({
                        hash: r.hash,
                        text: r.text,
                        score: r.score,
                        metadata: r.metadata,
                        vectorScore: r.debug?.vectorScore,
                        textScore: r.debug?.keywordScore,
                        debug: r.debug
                    }))
                });
            }

        } catch (error) {
            console.error(`[${pluginName}] chunks/hybrid-query error:`, error);
            res.status(500).json({ error: error.message });
        }
    });

    /**
     * POST /api/plugins/similharity/chunks/purge
     * Purge all chunks in a collection
     * Body: { backend, collectionId, source?, model? }
     */
    router.post('/chunks/purge', async (req, res) => {
        try {
            const {
                backend = 'vectra',
                collectionId,
                source = 'transformers',
                model = '',
                filters = {}
            } = req.body;

            if (!collectionId) {
                return res.status(400).json({ error: 'collectionId is required' });
            }

            if (backend === 'lancedb') {
                await ensureLanceDBInitialized(req.user.directories);
            }

            const handler = getBackendHandler(backend);
            await handler.purge(collectionId, source, model, req.user.directories, filters);

            res.json({
                success: true,
                backend: handler.type,
                collectionId,
                message: `Collection ${collectionId} purged`
            });

        } catch (error) {
            console.error(`[${pluginName}] chunks/purge error:`, error);
            res.status(500).json({ error: error.message });
        }
    });

    /**
     * POST /api/plugins/similharity/purge-all
     * Deletes the entire vectors folder
     */
    router.post('/purge-all', async (req, res) => {
        try {
            const vectorsPath = req.user.directories.vectors;
            await fs.rm(vectorsPath, { recursive: true, force: true });
            await fs.mkdir(vectorsPath, { recursive: true });
            res.json({ success: true, message: 'All vectors purged' });
        } catch (error) {
            console.error(`[${pluginName}] purge-all error:`, error);
            res.status(500).json({ error: error.message });
        }
    });

    /**
     * POST /api/plugins/similharity/rerank
     * Rerank documents using BananaBread's reranking endpoint
     * Body: { apiUrl, query, documents, top_k? }
     */
    router.post('/rerank', async (req, res) => {
        try {
            const {
                apiUrl = 'http://localhost:8008',
                apiKey = '',
                query,
                documents,
                top_k = 10,
                task_description
            } = req.body;

            if (!query || !documents || !Array.isArray(documents)) {
                return res.status(400).json({ error: 'query and documents array required' });
            }

            const url = new URL(apiUrl);
            url.pathname = '/v1/rerank';

            // Default task description if not provided
            const finalTaskDescription = task_description || "Given the following document from a role play, which of the following documents are most relevant to it?";

            const headers = { 'Content-Type': 'application/json' };
            if (apiKey) {
                headers['Authorization'] = `Bearer ${apiKey}`;
            }

            const response = await fetch(url.toString(), {
                method: 'POST',
                headers: headers,
                body: JSON.stringify({
                    query,
                    documents,
                    top_k,
                    return_documents: false,
                    task_description: finalTaskDescription
                }),
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`BananaBread rerank failed: ${response.statusText} ${errorText}`);
            }

            const data = await response.json();
            res.json(data);
        } catch (error) {
            console.error(`[${pluginName}] rerank error:`, error);
            res.status(500).json({ error: error.message });
        }
    });

    /**
     * POST /api/plugins/similharity/chunks/stats
     * Get collection statistics
     * Body: { backend, collectionId, source?, model? }
     */
    router.post('/chunks/stats', async (req, res) => {
        try {
            const {
                backend = 'vectra',
                collectionId,
                source = 'transformers',
                model = '',
                filters = {}
            } = req.body;

            if (!collectionId) {
                return res.status(400).json({ error: 'collectionId is required' });
            }

            if (backend === 'lancedb') {
                await ensureLanceDBInitialized(req.user.directories);
            }

            const handler = getBackendHandler(backend);
            const stats = await handler.stats(collectionId, source, model, req.user.directories, filters);

            res.json({
                success: true,
                backend: handler.type,
                collectionId,
                stats
            });

        } catch (error) {
            console.error(`[${pluginName}] chunks/stats error:`, error);
            res.status(500).json({ error: error.message });
        }
    });

    console.log(`[${pluginName}] Plugin initialized successfully`);
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Get vectra index for a collection
 */
async function getIndex(directories, collectionId, source, model) {
    const pathToFile = model
        ? path.join(directories.vectors, sanitize(source), sanitize(collectionId), sanitize(model))
        : path.join(directories.vectors, sanitize(source), sanitize(collectionId));

    const store = new vectra.LocalIndex(pathToFile);

    if (!await store.isIndexCreated()) {
        await store.createIndex();
    }

    return store;
}

/**
 * Get embedding for text from specified source
 */
async function getEmbeddingForSource(source, text, model, directories, req) {
    switch (source) {
        case 'transformers': {
            const { getTransformersVector } = await import('../../src/vectors/embedding.js');
            return await getTransformersVector(text);
        }
        case 'openai':
        case 'togetherai':
        case 'mistral':
        case 'electronhub':
        case 'openrouter': {
            const { getOpenAIVector } = await import('../../src/vectors/openai-vectors.js');
            // ElectronHub requires a model name, provide default if empty
            const effectiveModel = (source === 'electronhub' && !model) ? 'text-embedding-ada-002' : model;
            return await getOpenAIVector(text, source, directories, effectiveModel);
        }
        case 'koboldcpp': {
            return await _getKoboldCppEmbedding(text, model, req);
        }
        case 'nomicai': {
            const { getNomicAIVector } = await import('../../src/vectors/nomicai-vectors.js');
            return await getNomicAIVector(text, source, directories);
        }
        case 'cohere': {
            const { getCohereVector } = await import('../../src/vectors/cohere-vectors.js');
            return await getCohereVector(text, true, directories, model);
        }
        case 'ollama': {
            const { getOllamaVector } = await import('../../src/vectors/ollama-vectors.js');
            const apiUrl = req.body?.apiUrl || 'http://localhost:11434';
            const keep = req.body?.keep || false;
            return await getOllamaVector(text, apiUrl, model, keep, directories);
        }
        case 'llamacpp': {
            const { getLlamaCppVector } = await import('../../src/vectors/llamacpp-vectors.js');
            const apiUrl = req.body?.apiUrl || 'http://localhost:8080';
            return await getLlamaCppVector(text, apiUrl, directories);
        }
        case 'bananabread': {
            // BananaBread llama.cpp-compatible endpoint (no model param needed - uses server config)
            let apiUrl = req.body.apiUrl || 'http://localhost:8008';
            let apiKey = req.body.apiKey || '';

            // Validate URL before attempting to use it
            if (!apiUrl || typeof apiUrl !== 'string' || apiUrl.trim() === '') {
                throw new Error('BananaBread: apiUrl is missing or invalid. Configure the embedding URL in VectHare settings.');
            }
            apiUrl = apiUrl.trim();

            let url;
            try {
                url = new URL(apiUrl);
                url.pathname = '/embedding';
            } catch (e) {
                throw new Error(`BananaBread: Invalid URL format "${apiUrl}" - ${e.message}`);
            }

            const headers = { 'Content-Type': 'application/json' };
            if (apiKey) {
                headers['Authorization'] = `Bearer ${apiKey}`;
            }

            const response = await fetch(url.toString(), {
                method: 'POST',
                headers: headers,
                body: JSON.stringify({ content: text }),
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`BananaBread: ${response.statusText} ${errorText}`);
            }

            const data = await response.json();
            if (!Array.isArray(data?.embedding)) {
                throw new Error('BananaBread: Invalid response format');
            }
            return data.embedding;
        }
        case 'vllm': {
            const { getVllmVector } = await import('../../src/vectors/vllm-vectors.js');
            const apiUrl = req.body?.apiUrl || 'http://localhost:8000';
            return await getVllmVector(text, apiUrl, model, directories);
        }
        case 'palm':
        case 'vertexai': {
            const googleVectors = await import('../../src/vectors/google-vectors.js');
            if (source === 'palm') {
                return await googleVectors.getMakerSuiteVector(text, model, req);
            } else {
                return await googleVectors.getVertexVector(text, model, req);
            }
        }
        case 'extras': {
            const { getExtrasVector } = await import('../../src/vectors/extras-vectors.js');
            const extrasUrl = req.body?.extrasUrl || 'http://localhost:5100';
            const extrasKey = req.body?.extrasKey || '';
            return await getExtrasVector(text, extrasUrl, extrasKey);
        }
        default:
            throw new Error(`Unknown vector source: ${source}`);
    }
}

/**
 * Simple string hash function
 */
function getStringHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return Math.abs(hash);
}

/**
 * Scan all sources for collections
 */
async function scanAllSourcesForCollections(vectorsPath) {
    const allCollections = [];

    try {
        // Scan vectra indexes
        const vectraIndexes = await findAllIndexes(vectorsPath);

        const vectraCollectionMap = new Map();
        for (const index of vectraIndexes) {
            const key = `${index.source}:${index.collectionId}`;

            if (!vectraCollectionMap.has(key)) {
                vectraCollectionMap.set(key, {
                    id: index.collectionId,
                    source: index.source,
                    backend: 'vectra',
                    indexes: [],
                    totalChunks: 0
                });
            }

            const chunkCount = await getChunkCountFromIndex(index.indexPath);
            vectraCollectionMap.get(key).indexes.push({
                modelPath: index.modelPath,
                chunkCount: chunkCount
            });
            vectraCollectionMap.get(key).totalChunks += chunkCount;
        }

        for (const [key, collection] of vectraCollectionMap) {
            if (!collection.id) continue;

            const primaryIndex = collection.indexes.reduce((best, curr) =>
                curr.chunkCount > best.chunkCount ? curr : best
            , collection.indexes[0]);

            const models = collection.indexes.map(idx => ({
                name: idx.modelPath || '(default)',
                path: idx.modelPath,
                chunkCount: idx.chunkCount
            }));

            allCollections.push({
                id: collection.id,
                source: collection.source,
                backend: 'vectra',
                chunkCount: collection.totalChunks,
                modelCount: collection.indexes.length,
                model: primaryIndex?.modelPath || '',
                models: models
            });
        }

        // Scan LanceDB
        const lancedbPath = path.join(vectorsPath, 'lancedb');
        try {
            await fs.access(lancedbPath);
            if (!lancedbBackend.basePath) {
                await lancedbBackend.initialize(vectorsPath);
            }

            const sourceDirs = await fs.readdir(lancedbPath, { withFileTypes: true });
            const sources = sourceDirs.filter(d => d.isDirectory() && !d.name.endsWith('.lance')).map(d => d.name);

            for (const source of sources) {
                try {
                    const db = await lancedbBackend.getDatabase(source);
                    const tableNames = await db.tableNames();

                    for (const tableName of tableNames) {
                        if (!tableName) continue;
                        try {
                            const table = await db.openTable(tableName);
                            const count = await table.countRows();

                            allCollections.push({
                                id: tableName,
                                source: source,
                                backend: 'lancedb',
                                chunkCount: count,
                                modelCount: 1
                            });
                        } catch (e) {
                            console.warn(`[${pluginName}] LanceDB: Failed to open table '${tableName}' in source '${source}':`, e.message);
                        }
                    }
                } catch (e) {
                    console.warn(`[${pluginName}] LanceDB: Failed to scan source '${source}':`, e.message);
                }
            }
        } catch (e) {
            // LanceDB folder doesn't exist - this is normal if LanceDB hasn't been used
            console.debug(`[${pluginName}] LanceDB folder not found or not accessible:`, e.message);
        }

        // Scan Qdrant (uses REST API, so check if initialized via baseUrl)
        try {
            if (qdrantBackend.baseUrl) {
                const healthy = await qdrantBackend.healthCheck();
                if (healthy) {
                    // List items from vecthare_main collection
                    const collections = await qdrantBackend.getCollections();
                    const hasVecthareMain = collections.some(col => col.name === 'vecthare_main'); //just-in-case support for multitenancy?

                    for (const collectionName of collections) {
                        const items = await qdrantBackend.listItems(collectionName, {});
                        console.log('Discovered Qdrant Collection:', collectionName + " " + items.length + " items");

                        // Extract source from collection name (format: "source:id" or "backend:source:id")
                        let source = 'unknown';
                        const parts = collectionName.split(':');
                        if (parts.length === 2) {
                            // Format: "source:id"
                            source = parts[0];
                        } else if (parts.length === 3) {
                            // Format: "backend:source:id"
                            source = parts[1];
                        } else if (items.length > 0 && items[0].metadata?.embeddingSource) {
                            // Fallback: get from item metadata
                            source = items[0].metadata.embeddingSource;
                        }

                         allCollections.push({
                            id: collectionName,
                            source: source,
                            backend: 'qdrant',
                            chunkCount: items.length,
                            modelCount: 1
                        });
                    }
                }
            }
        } catch (e) {
            console.warn(`[${pluginName}] Qdrant: Failed to scan collections:`, e.message);
        }

        // Scan Milvus
        try {
            if (milvusBackend.isConnected) {
                const items = await milvusBackend.listItems('vecthare_main', {}, { limit: 1 });
                if (items.length > 0) {
                    const stats = await milvusBackend.getCollectionStats('vecthare_main');
                    allCollections.push({
                        id: 'vecthare_main',
                        source: 'milvus',
                        backend: 'milvus',
                        chunkCount: stats.chunkCount,
                        modelCount: 1
                    });
                }
            }
        } catch (e) {
            console.warn(`[${pluginName}] Milvus: Failed to scan collections:`, e.message);
        }

    } catch (error) {
        console.error(`[${pluginName}] Error scanning collections:`, error);
    }

    return allCollections;
}

/**
 * Find all vectra index.json files
 */
async function findAllIndexes(dir, relativePath = '') {
    const results = [];

    try {
        const entries = await fs.readdir(dir, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            const newRelativePath = relativePath ? path.join(relativePath, entry.name) : entry.name;

            if (entry.isDirectory()) {
                const subResults = await findAllIndexes(fullPath, newRelativePath);
                results.push(...subResults);
            } else if (entry.name === 'index.json') {
                const pathParts = newRelativePath.split(path.sep);
                if (pathParts.length >= 3) {
                    results.push({
                        indexPath: fullPath,
                        collectionId: pathParts[1],
                        source: pathParts[0],
                        modelPath: pathParts.slice(2, -1).join(path.sep),
                        relativePath: newRelativePath
                    });
                }
            }
        }
    } catch (e) {
        // Directory may not exist or not be readable - log at debug level since this is recursive
        if (relativePath === '') {
            console.warn(`[${pluginName}] Vectra: Failed to scan vectors directory:`, e.message);
        }
    }

    return results;
}

/**
 * Get chunk count from vectra index
 */
async function getChunkCountFromIndex(indexPath) {
    try {
        const modelDir = path.dirname(indexPath);
        const store = new vectra.LocalIndex(modelDir);

        if (!await store.isIndexCreated()) {
            return 0;
        }

        const items = await store.listItems();
        return items.length;
    } catch (e) {
        console.warn(`[${pluginName}] Vectra: Failed to get chunk count from ${indexPath}:`, e.message);
        return 0;
    }
}

export async function exit() {
    console.log(`[${pluginName}] Plugin shutting down...`);
}

export const info = {
    id: pluginName,
    name: 'Similharity',
    description: 'Unified vector database backend for VectHare - supports Vectra, LanceDB, and Qdrant',
    version: pluginVersion
};
