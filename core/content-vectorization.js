/**
 * ============================================================================
 * VECTHARE CONTENT VECTORIZATION
 * ============================================================================
 * Unified vectorization handler for all content types.
 * Uses the same pipeline infrastructure, just with type-appropriate settings.
 *
 * @author Coneja Chibi
 * @version 2.2.0-alpha
 * ============================================================================
 */

import { getContentType, getContentTypeDefaults, hasFeature } from './content-types.js';
import { chunkText } from './chunking.js';
import { insertVectorItems, purgeVectorIndex, getSavedHashes } from './core-vector-api.js';
import { setCollectionMeta, getDefaultDecayForType } from './collection-metadata.js';
import { registerCollection } from './collection-loader.js';
import { getBackend } from '../backends/backend-manager.js';
// Import from collection-ids.js - single source of truth for collection ID operations
import {
    buildChatCollectionId,
    buildLorebookCollectionId,
    buildCharacterCollectionId,
    buildDocumentCollectionId,
    COLLECTION_PREFIXES,
} from './collection-ids.js';
import { extractLorebookKeywords, extractTextKeywords, extractChatKeywords, extractBM25Keywords, EXTRACTION_LEVELS, DEFAULT_EXTRACTION_LEVEL, DEFAULT_BASE_WEIGHT } from './keyword-boost.js';
import { cleanText, cleanMessages } from './text-cleaning.js';
import { summarizeText, isSummarizationFatalError } from './summarizer.js';
import { progressTracker } from '../ui/progress-tracker.js';
import { extension_settings, getContext } from '../../../../extensions.js';
import { getStringHash } from '../../../../utils.js';

/**
 * Main entry point for content vectorization
 * @param {object} params - Vectorization parameters
 * @param {string} params.contentType - Content type ID
 * @param {object} params.source - Source data
 * @param {object} params.settings - Type-specific settings
 * @param {AbortSignal} [params.abortSignal] - Optional abort signal to stop vectorization
 * @returns {Promise<{success: boolean, chunkCount: number, collectionId: string}>}
 */
export async function vectorizeContent({ contentType, source, settings, abortSignal = null, continueMode = false }) {
    const throwIfAborted = () => {
        if (abortSignal?.aborted) {
            const err = new Error('Vectorization stopped by user');
            err.name = 'AbortError';
            throw err;
        }
    };

    const type = getContentType(contentType);
    if (!type) {
        throw new Error(`Unknown content type: ${contentType}`);
    }

    const sourceName = source.name || source.filename || source.id || contentType;
    progressTracker.show(`Vectorizing ${type.label || contentType}`, 4, 'Steps');
    progressTracker.updateCurrentItem(sourceName);

    try {
        throwIfAborted();

        // Step 1: Resolve source
        progressTracker.updateProgress(1, 'Loading content...');
        const rawContent = await resolveSource(contentType, source);
        throwIfAborted();

        // Step 2: Prepare and chunk
        progressTracker.updateProgress(2, 'Chunking content...');
        const preparedContent = await prepareContent(contentType, rawContent, settings);
        throwIfAborted();
        const chunks = await chunkText(preparedContent.text || preparedContent, {
            strategy: settings.strategy || type.defaultStrategy,
            chunkSize: settings.chunkSize || type.defaults.chunkSize,
            chunkOverlap: settings.chunkOverlap || type.defaults.chunkOverlap,
            batchSize: settings.batchSize || 4,
        });
        throwIfAborted();

        if (chunks.length === 0) {
            throw new Error('No chunks generated from content');
        }

        // Log chunking results for debugging
        const chunkLengths = chunks.map(c => (typeof c === 'string' ? c : c.text || '').length);
        const maxChunkLen = Math.max(...chunkLengths);
        const avgChunkLen = Math.round(chunkLengths.reduce((a, b) => a + b, 0) / chunkLengths.length);
        console.log(`VectHare: Chunked "${sourceName}" into ${chunks.length} chunks (avg: ${avgChunkLen} chars, max: ${maxChunkLen} chars)`);

        progressTracker.updateChunks(chunks.length);

        // Step 3: Enrich and hash
        progressTracker.updateProgress(3, 'Processing chunks...');
        const collectionId = generateCollectionId(contentType, source, settings);
        
        // Get full extension settings for keyword extraction (includes custom_stopwords)
        const vecthareSettings = extension_settings.vecthare;
        
        const enrichedChunks = enrichChunks(chunks, contentType, source, settings, preparedContent, vecthareSettings);
        const hashedChunks = enrichedChunks.map(chunk => ({
            ...chunk,
            hash: getStringHash(chunk.text),
        }));

        // Continue mode: skip chunks already present in the collection
        let finalChunks;
        if (continueMode) {
            try {
                progressTracker.updateProgress(3, 'Checking existing chunks...');
                const savedHashes = await getSavedHashes(collectionId, vecthareSettings);
                const savedSet = new Set(savedHashes);
                const before = hashedChunks.length;
                finalChunks = hashedChunks.filter(c => !savedSet.has(c.hash));
                const skipped = before - finalChunks.length;
                console.log(`VectHare: Continue mode — ${skipped} chunks already in DB, ${finalChunks.length} remaining`);
                progressTracker.updateChunks(finalChunks.length);
                if (finalChunks.length === 0) {
                    progressTracker.complete(true, 'Already up to date — no new chunks to insert');
                    return { success: true, chunkCount: 0, collectionId };
                }
                toastr.info(`Continuing: ${skipped} chunks skipped, ${finalChunks.length} to insert`, 'VectHare');
            } catch (e) {
                console.warn('VectHare: Could not fetch saved hashes for dedup, inserting all:', e.message);
                finalChunks = hashedChunks;
            }
        } else {
            finalChunks = hashedChunks;
        }

        // Step 3.5 + 4 combined: For chat with summarization, pipeline each chunk
        // (summarize → embed → insert immediately) to start filling Qdrant right away.
        // For everything else, do the original batch approach.
        if (contentType === 'chat' && (vecthareSettings?.summarize_provider || 'off') !== 'off') {
            progressTracker.updateProgress(3, `Summarizing and inserting ${hashedChunks.length} chunks...`);
            console.log(`[VectHare Summarizer] Pipelining ${hashedChunks.length} chat chunks via ${vecthareSettings.summarize_provider}...`);

            // Pre-init backend once before pipeline starts
            try {
                await getBackend(vecthareSettings);
            } catch (e) {
                console.warn('VectHare: Backend init failed before pipeline insert, will still attempt:', e.message);
            }

            let pipelined = 0;
            for (const chunk of hashedChunks) {
                throwIfAborted();

                let summaryText;
                try {
                    summaryText = await summarizeText(chunk.text, vecthareSettings);
                } catch (err) {
                    if (isSummarizationFatalError(err)) {
                        const providerLabel = (vecthareSettings?.summarize_provider || 'summarizer').toUpperCase();
                        const msg = `Summarization is enabled but misconfigured: ${err.message}`;
                        try { toastr.error(msg, `${providerLabel} configuration error`); } catch (_) {}
                        throw new Error(msg);
                    }
                    throw err;
                }
                const keywordLevel = vecthareSettings?.keywordLevel || 'balanced';
                const summaryKeywords = keywordLevel !== 'off'
                    ? extractBM25Keywords(summaryText, {
                        level: keywordLevel,
                        baseWeight: vecthareSettings?.keywordBaseWeight || 1.5,
                        settings: vecthareSettings,
                    })
                    : [];
                const summarizedChunk = { ...chunk, text: summaryText, keywords: summaryKeywords };

                try {
                    throwIfAborted();
                    await insertVectorItems(collectionId, [summarizedChunk], vecthareSettings);
                } catch (insertErr) {
                    if (insertErr?.name === 'AbortError') throw insertErr;
                    console.error('VectHare: Pipeline insert failed for chunk, skipping:', insertErr.message);
                    progressTracker.addError(`Chunk ${pipelined + 1}: ${insertErr.message}`);
                }

                pipelined++;
                progressTracker.updateProgress(3, `Summarizing + inserting... ${pipelined}/${hashedChunks.length}`);
                progressTracker.updateEmbeddingProgress(pipelined, hashedChunks.length);
            }

            console.log(`[VectHare Summarizer] Pipeline complete: ${pipelined} chunks processed`);

        } else {
            // Non-chat or summarization off: standard batch summarize then insert
            if (contentType === 'chat') {
                // No summarization — finalChunks already equals hashedChunks
            }

            // Step 4: Insert into vector store
            progressTracker.updateProgress(4, 'Processing chunks...');

            try {
                await getBackend(vecthareSettings);
            } catch (e) {
                console.warn('VectHare: Backend initialization failed before insert, will still attempt insert:', e.message);
                try { progressTracker.addError(`Backend init failed: ${e.message}`); } catch (_) {}
                try { toastr.error('Backend initialization failed: ' + e.message, 'VectHare'); } catch (_) {}
            }

            try {
                await insertVectorItems(collectionId, finalChunks, vecthareSettings, (embedded, total) => {
                    throwIfAborted();
                    console.log(`[Content Vectorization] Processing progress callback: ${embedded}/${total}`);
                    progressTracker.updateEmbeddingProgress(embedded, total);
                    progressTracker.updateCurrentItem(`Processing: ${embedded}/${total} chunks (${total - embedded} remaining)`);
                });
            } catch (error) {
                console.error('VectHare: insertVectorItems failed', error);
                try { progressTracker.addError(error.message || String(error)); } catch (_) {}
                try { toastr.error('Failed to write embeddings: ' + (error.message || String(error)), 'VectHare'); } catch (_) {}
                throw error;
            }
        }

        // Save collection metadata
        setCollectionMeta(collectionId, {
            contentType,
            sourceName,
            scope: settings.scope || 'global',
            chunkCount: finalChunks.length,
            createdAt: new Date().toISOString(),
            settings: {
                strategy: settings.strategy,
                chunkSize: settings.chunkSize,
            },
            temporalDecay: hasFeature(contentType, 'temporalDecay')
                ? (settings.temporalDecay || getDefaultDecayForType(contentType))
                : { enabled: false },
        });

        // Register collection in the registry so it's discoverable
        registerCollection(collectionId);
        console.log(`VectHare: Registered collection ${collectionId}`);

        throwIfAborted();
        progressTracker.complete(true, `Vectorized ${finalChunks.length} chunks`);

        return {
            success: true,
            chunkCount: finalChunks.length,
            collectionId,
        };
    } catch (error) {
        if (error?.name === 'AbortError') {
            progressTracker.complete(false, 'Stopped by user');
            throw error;
        }

        progressTracker.addError(error.message);
        progressTracker.complete(false, 'Vectorization failed');
        throw error;
    }
}

/**
 * Resolves and prepares content for preview or chunking
 * Exported for use by the preview functionality
 * @param {string} contentType - Content type ID
 * @param {object} source - Source data from getSourceData()
 * @param {object} settings - Type-specific settings
 * @returns {Promise<{text: string, ...}>} Prepared content with text property
 */
export async function resolveAndPrepareContent(contentType, source, settings) {
    const rawContent = await resolveSource(contentType, source);
    const prepared = await prepareContent(contentType, rawContent, settings);

    // Return as-is - text may be string or array depending on strategy
    return prepared;
}

/**
 * Resolves source data to actual content
 */
async function resolveSource(contentType, source) {
    switch (source.type) {
        case 'paste':
            return { content: source.content, name: source.name };

        case 'file':
            // File uploads may already be parsed by the UI
            // For lorebooks: source.entries contains parsed entries
            // For characters: source.character contains parsed character data
            // For chats: source.messages contains parsed messages
            if (contentType === 'lorebook' && source.entries) {
                return {
                    content: source.entries,
                    name: source.name || source.filename,
                    entries: source.entries,
                };
            }
            if (contentType === 'character' && source.character) {
                return {
                    content: source.character,
                    name: source.name || source.character.name || source.filename,
                    character: source.character,
                };
            }
            if (contentType === 'chat' && source.messages) {
                return {
                    content: source.messages,
                    name: source.name || source.characterName || source.filename,
                    messages: source.messages,
                    metadata: source.metadata,
                };
            }
            // Generic file (plain text)
            return { content: source.content, name: source.filename || source.name };

        case 'url':
            return { content: source.content, name: source.title || source.url, url: source.url };

        case 'wiki':
            // Wiki content already scraped by UI
            return {
                content: source.content,
                name: source.name || 'Wiki',
                wikiType: source.wikiType,
                pages: source.pages,
                pageCount: source.pageCount,
            };

        case 'youtube':
            // YouTube transcript already fetched by UI
            return {
                content: source.content,
                name: source.name || `YouTube-${source.videoId}`,
                videoId: source.videoId,
                url: source.url,
            };

        case 'select':
            return await loadSelectedSource(contentType, source.id);

        case 'current':
            // For chat type - content is passed directly
            return { content: source.content, name: source.name, messages: source.content };

        default:
            if (source.content) {
                return { content: source.content, name: source.name || 'Unknown' };
            }
            throw new Error(`Unknown source type: ${source.type}`);
    }
}

/**
 * Loads content from a selected source (lorebook, character, etc.)
 */
async function loadSelectedSource(contentType, sourceId) {
    const context = getContext();

    switch (contentType) {
        case 'lorebook':
            return await loadLorebookContent(sourceId, context);

        case 'character':
            return await loadCharacterContent(sourceId, context);

        default:
            throw new Error(`Cannot load selected source for type: ${contentType}`);
    }
}

/**
 * Loads lorebook/world info content by name
 */
async function loadLorebookContent(lorebookName, context) {
    try {
        // Import ST's world-info module to load the lorebook
        const worldInfoModule = await import('../../../../world-info.js');
        const loadWorldInfo = worldInfoModule.loadWorldInfo;

        if (!loadWorldInfo) {
            throw new Error('World Info loader not available');
        }

        // Load the lorebook data
        const data = await loadWorldInfo(lorebookName);

        if (!data || !data.entries) {
            throw new Error(`Lorebook "${lorebookName}" has no entries`);
        }

        const entries = Object.values(data.entries).filter(e => e.content);

        console.log(`VectHare: Loaded lorebook "${lorebookName}" with ${entries.length} entries`);

        return {
            content: entries,
            name: lorebookName,
            entries: entries,
        };

    } catch (e) {
        console.error('VectHare: Failed to load lorebook:', e);
        throw new Error(`Failed to load lorebook "${lorebookName}": ${e.message}`);
    }
}

/**
 * Loads character card content
 */
async function loadCharacterContent(characterId, context) {
    const characters = context?.characters || [];
    const character = characters.find(c => c.avatar === characterId);

    if (!character) {
        throw new Error(`Character not found: ${characterId}`);
    }

    return {
        content: character,
        name: character.name,
        character: character,
    };
}

/**
 * Prepares content for chunking based on content type
 */
async function prepareContent(contentType, rawContent, settings) {
    switch (contentType) {
        case 'lorebook':
            return prepareLorebookContent(rawContent, settings);

        case 'character':
            return prepareCharacterContent(rawContent, settings);

        case 'chat':
            return prepareChatContent(rawContent, settings);

        case 'url':
            return prepareUrlContent(rawContent, settings);

        case 'document':
            return prepareDocumentContent(rawContent, settings);

        case 'wiki':
            return prepareWikiContent(rawContent, settings);

        case 'youtube':
            return prepareYouTubeContent(rawContent, settings);

        default:
            return rawContent.content || rawContent;
    }
}

/**
 * Prepares lorebook content
 * For per_entry: each entry.content becomes one chunk
 * For other strategies: concatenate all entries, then chunk by that strategy
 */
function prepareLorebookContent(rawContent, settings) {
    // Handle both array (from Object.values) and object (raw entries)
    let entries = rawContent.entries || rawContent.content;

    // If entries is an object (not array), convert to array
    if (entries && typeof entries === 'object' && !Array.isArray(entries)) {
        entries = Object.values(entries);
    }

    if (!entries || !Array.isArray(entries) || entries.length === 0) {
        return { text: '', type: 'empty' };
    }

    // Filter to entries that have content, and apply text cleaning
    const validEntries = entries
        .filter(e => e && e.content)
        .map(e => ({ ...e, content: cleanText(e.content) }));

    if (settings.strategy === 'per_entry') {
        // Each entry becomes its own chunk - return array of content strings
        // Also pass entries so enrichChunks can attach keywords
        return {
            text: validEntries.map(e => e.content),
            type: 'per_entry',
            entries: validEntries,
            entryCount: validEntries.length,
        };
    }

    // For other strategies, concatenate all entries with separators
    const combined = validEntries.map(e => {
        const header = e.comment || e.name || e.key?.[0] || '';
        return header ? `# ${header}\n${e.content}` : e.content;
    }).join('\n\n---\n\n');

    return { text: combined, type: 'combined', entryCount: validEntries.length };
}

/**
 * Prepares character content
 */
function prepareCharacterContent(rawContent, settings) {
    const character = rawContent.character || rawContent.content;
    const selectedFields = settings.fields || getContentTypeDefaults('character').fields;

    const FIELD_MAP = {
        description: { key: 'description', label: 'Description' },
        personality: { key: 'personality', label: 'Personality' },
        scenario: { key: 'scenario', label: 'Scenario' },
        first_mes: { key: 'first_mes', label: 'First Message' },
        mes_example: { key: 'mes_example', label: 'Example Messages' },
        system_prompt: { key: 'system_prompt', label: 'System Prompt' },
        post_history_instructions: { key: 'post_history_instructions', label: 'Post-History Instructions' },
        creator_notes: { key: 'creator_notes', label: 'Creator Notes' },
    };

    // For per_field strategy
    if (settings.strategy === 'per_field') {
        const fields = {};
        for (const [fieldId, enabled] of Object.entries(selectedFields)) {
            if (enabled && FIELD_MAP[fieldId] && character[FIELD_MAP[fieldId].key]) {
                fields[FIELD_MAP[fieldId].label] = cleanText(character[FIELD_MAP[fieldId].key]);
            }
        }
        return { text: fields, type: 'fields', character: character };
    }

    // Otherwise, concatenate selected fields
    const combined = Object.entries(selectedFields)
        .filter(([, enabled]) => enabled)
        .map(([fieldId]) => {
            const field = FIELD_MAP[fieldId];
            if (field && character[field.key]) {
                return `## ${field.label}\n${cleanText(character[field.key])}`;
            }
            return null;
        })
        .filter(Boolean)
        .join('\n\n');

    return { text: combined, type: 'combined', character: character };
}

/**
 * Prepares chat content for chunking
 * Maps to the unified chunking strategies in chunking.js
 */
function prepareChatContent(rawContent, settings) {
    const messages = rawContent.messages || rawContent.content;

    if (!Array.isArray(messages)) {
        return { text: cleanText(String(messages)), type: 'text' };
    }

    // Filter out system messages and empty messages
    const validMessages = messages.filter(m => m.mes && !m.is_system);

    // Apply text cleaning to messages
    const cleanedMessages = cleanMessages(validMessages);

    // Normalize messages to have consistent properties for chunking.js
    const normalizedMessages = cleanedMessages.map((m, idx) => ({
        text: m.mes,
        mes: m.mes,
        is_user: m.is_user,
        name: m.name,
        index: idx,
        id: m.send_date || m.id || idx,
    }));

    // For per_message strategy - return array of messages for chunking.js
    if (settings.strategy === 'per_message') {
        return {
            text: normalizedMessages,
            type: 'messages',
            messages: validMessages,
        };
    }

    // For conversation_turns strategy - return array for chunking.js to pair
    if (settings.strategy === 'conversation_turns') {
        return {
            text: normalizedMessages,
            type: 'messages',
            messages: validMessages,
        };
    }

    // For message_batch strategy - return array for chunking.js to batch
    if (settings.strategy === 'message_batch') {
        return {
            text: normalizedMessages,
            type: 'messages',
            messages: validMessages,
        };
    }

    // For adaptive or other text strategies - combine into single text
    const combined = cleanedMessages.map(m => {
        const speaker = m.is_user ? 'User' : (m.name || 'Character');
        return `[${speaker}]: ${m.mes}`;
    }).join('\n\n');

    return { text: combined, type: 'combined', messages: cleanedMessages };
}

/**
 * Prepares URL/webpage content
 */
function prepareUrlContent(rawContent, settings) {
    let text = rawContent.content || rawContent;

    // Basic text cleaning for web content
    if (typeof text === 'string') {
        // Apply user's cleaning patterns first
        text = cleanText(text);
        // Remove excessive whitespace
        text = text.replace(/\n{3,}/g, '\n\n');
        // Remove common web artifacts
        text = text.replace(/\[edit\]/gi, '');
        text = text.replace(/\[\d+\]/g, ''); // Remove reference numbers like [1], [2]
        // Trim
        text = text.trim();
    }

    return { text, type: 'url', name: rawContent.name, url: rawContent.url };
}

/**
 * Prepares document content
 */
function prepareDocumentContent(rawContent, settings) {
    let text = rawContent.content || rawContent;

    // Basic text cleaning
    if (typeof text === 'string') {
        // Apply user's cleaning patterns first
        text = cleanText(text);
        // Remove excessive whitespace
        text = text.replace(/\n{3,}/g, '\n\n');
        // Trim
        text = text.trim();
    }

    return { text, type: 'document', name: rawContent.name };
}

/**
 * Prepares wiki content
 */
function prepareWikiContent(rawContent, settings) {
    let text = rawContent.content || rawContent;

    // Wiki content is already formatted with headers from scraper
    if (typeof text === 'string') {
        // Apply user's cleaning patterns first
        text = cleanText(text);
        // Remove excessive whitespace
        text = text.replace(/\n{3,}/g, '\n\n');
        // Trim
        text = text.trim();
    }

    // For per_page strategy, split back into individual pages
    if (settings.strategy === 'per_page' && rawContent.pages) {
        return {
            text: rawContent.pages.map(p => ({
                text: cleanText(`# ${p.title}\n\n${p.content}`),
                metadata: {
                    pageTitle: p.title,
                },
            })),
            type: 'pages',
            pages: rawContent.pages,
            name: rawContent.name,
        };
    }

    return {
        text,
        type: 'wiki',
        name: rawContent.name,
        wikiType: rawContent.wikiType,
        pageCount: rawContent.pageCount,
    };
}

/**
 * Prepares YouTube transcript content
 */
function prepareYouTubeContent(rawContent, settings) {
    let text = rawContent.content || rawContent;

    // Clean up transcript text
    if (typeof text === 'string') {
        // Apply user's cleaning patterns first
        text = cleanText(text);
        // Remove excessive whitespace
        text = text.replace(/\n{3,}/g, '\n\n');
        // Trim
        text = text.trim();
    }

    return {
        text,
        type: 'youtube',
        name: rawContent.name,
        videoId: rawContent.videoId,
        url: rawContent.url,
    };
}

/**
 * Generates a collection ID for the content
 * Uses the unified builders from collection-ids.js
 */
function generateCollectionId(contentType, source, settings) {
    const sourceName = source.name || source.id || source.filename || contentType;
    const timestamp = Date.now();

    switch (contentType) {
        case 'chat':
            // Use UUID-based ID (single source of truth)
            const chatCollectionId = buildChatCollectionId();
            if (chatCollectionId) {
                return chatCollectionId;
            }
            // Fall through to legacy generation if UUID not available
            console.warn('VectHare: Chat UUID not available, using legacy ID generation');
            break;

        case 'lorebook':
            return buildLorebookCollectionId(sourceName, timestamp);

        case 'character':
            return buildCharacterCollectionId(sourceName, timestamp);

        case 'document':
            return buildDocumentCollectionId(sourceName, timestamp);

        case 'url':
            // Use domain from URL or title
            let urlName = sourceName;
            try {
                const url = new URL(source.url || '');
                urlName = source.title || url.hostname || 'webpage';
            } catch {
                urlName = source.title || source.name || 'webpage';
            }
            return buildDocumentCollectionId(urlName, timestamp);

        case 'wiki':
            return buildDocumentCollectionId(source.name || 'wiki', timestamp);

        case 'youtube':
            return buildDocumentCollectionId(source.name || source.videoId || 'youtube', timestamp);
    }

    // Fallback for unknown types or chat fallback
    const scope = settings.scope || 'global';
    const context = getContext();
    const baseName = sourceName;

    // Sanitize name for use in ID
    const sanitizedName = baseName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .substring(0, 50);

    // Add scope prefix
    let scopePrefix = '';
    if (scope === 'character' && context?.characterId) {
        scopePrefix = `char_${context.characterId}_`;
    } else if (scope === 'chat' && context?.chatId) {
        scopePrefix = `chat_${context.chatId}_`;
    }

    return `vecthare_${contentType}_${scopePrefix}${sanitizedName}_${timestamp}`;
}

/**
 * Enriches chunks with metadata and keywords
 * @param {Array} chunks - Array of chunk strings or objects
 * @param {string} contentType - Type of content
 * @param {object} source - Source info
 * @param {object} settings - Vectorization settings including keyword options
 * @param {object} preparedContent - Prepared content data
 * @param {object} vecthareSettings - Full VectHare extension settings (includes custom_stopwords)
 */
function enrichChunks(chunks, contentType, source, settings, preparedContent, vecthareSettings) {
    // Get keyword extraction settings
    const keywordLevel = settings.keywordLevel || 'balanced';
    const keywordBaseWeight = settings.keywordBaseWeight || 1.5;

    return chunks.map((chunk, index) => {
        const chunkText = typeof chunk === 'string' ? chunk : chunk.text;
        let keywords = []; // Will hold {text, weight} objects
        let entryName = null;
        let entryUid = null;

        // For lorebooks with per_entry, get keywords from the entry
        if (contentType === 'lorebook' && preparedContent.entries?.[index]) {
            const entry = preparedContent.entries[index];
            entryName = entry.comment || entry.name || entry.key?.[0] || 'Entry';
            entryUid = entry.uid;

            // Get explicit trigger keys (these are manually set, so use base weight)
            const triggerKeys = extractLorebookKeywords(entry, vecthareSettings);
            keywords = triggerKeys.map(k => ({ text: k, weight: keywordBaseWeight }));

            // Also get auto-extracted keywords with frequency-based weights
            if (keywordLevel !== 'off') {
                const autoKeywords = extractTextKeywords(entry.content || chunkText, {
                    level: keywordLevel,
                    baseWeight: keywordBaseWeight,
                    settings: vecthareSettings,
                });
                keywords = keywords.concat(autoKeywords);
            }
        } else if (contentType === 'chat') {
            // For chat, use BM25/TF-IDF to find most distinctive words
            if (keywordLevel !== 'off') {
                keywords = extractBM25Keywords(chunkText, {
                    level: keywordLevel,
                    baseWeight: keywordBaseWeight,
                    settings: vecthareSettings,
                });
            }
        } else {
            // For other content (url, wiki, document, youtube), use frequency-based extraction
            if (keywordLevel !== 'off') {
                keywords = extractTextKeywords(chunkText, {
                    level: keywordLevel,
                    baseWeight: keywordBaseWeight,
                    settings: vecthareSettings,
                });
            }
        }

        // Add character name as keyword with higher weight (it's the main subject)
        if (contentType === 'character' && preparedContent.character?.name) {
            keywords.push({
                text: preparedContent.character.name.toLowerCase(),
                weight: keywordBaseWeight + 0.5, // Character name gets bonus weight
            });
        }

        // Add speaker name as keyword for chat messages
        if (contentType === 'chat' && chunk.metadata?.speakerName) {
            keywords.push({
                text: chunk.metadata.speakerName.toLowerCase(),
                weight: keywordBaseWeight,
            });
        }

        // Deduplicate keywords (keep highest weight for duplicates)
        const keywordMap = new Map();
        for (const kw of keywords) {
            const existing = keywordMap.get(kw.text);
            if (!existing || kw.weight > existing.weight) {
                keywordMap.set(kw.text, kw);
            }
        }
        const dedupedKeywords = Array.from(keywordMap.values());

        return {
            text: chunkText,
            index: index,
            keywords: dedupedKeywords,
            metadata: {
                contentType,
                sourceName: source.name || source.filename || 'Unknown',
                entryName,
                entryUid,
                keywordLevel,
                keywordBaseWeight,
                ...(chunk.metadata || {}),
            },
        };
    });
}

/**
 * Deletes a content collection
 */
export async function deleteContentCollection(collectionId) {
    const vecthareSettings = extension_settings.vecthare;
    await purgeVectorIndex(collectionId, vecthareSettings);
    console.log(`VectHare: Deleted collection: ${collectionId}`);
}
