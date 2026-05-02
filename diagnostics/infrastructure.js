/**
 * ============================================================================
 * VECTHARE DIAGNOSTICS - INFRASTRUCTURE
 * ============================================================================
 * Backend, provider, and plugin availability checks
 *
 * @author Coneja Chibi
 * @version 2.2.0-alpha
 * ============================================================================
 */

import { getRequestHeaders } from '../../../../../script.js';
import { secret_state } from '../../../../secrets.js';
import { textgen_types, textgenerationwebui_settings } from '../../../../textgen-settings.js';
import {
    EMBEDDING_PROVIDERS,
    getValidProviderIds,
    isValidProvider,
    getProviderConfig,
    getModelField,
    getSecretKey,
    requiresApiKey,
    requiresUrl,
    getUrlProviders
} from '../core/providers.js';

/**
 * Helper: Get provider-specific body parameters for Similharity plugin requests
 * This ensures BananaBread and other providers that need special params get them
 * @param {object} settings - VectHare settings
 * @returns {object} Additional body parameters for the request
 */
function getPluginProviderParams(settings) {
    const params = {};
    const source = settings.source;

    // BananaBread requires apiUrl and apiKey in request body
    if (source === 'bananabread') {
        params.apiUrl = settings.use_alt_endpoint ? settings.alt_endpoint_url : 'http://localhost:8008';
        // API key is stored in extension settings (not ST's secret store)
        if (settings.bananabread_api_key) {
            params.apiKey = settings.bananabread_api_key;
        }
    }

    // Ollama needs apiUrl and keep param
    if (source === 'ollama') {
        params.apiUrl = settings.use_alt_endpoint
            ? settings.alt_endpoint_url
            : textgenerationwebui_settings.server_urls[textgen_types.OLLAMA];
        params.keep = !!settings.ollama_keep;
    }

    // llamacpp needs apiUrl
    if (source === 'llamacpp') {
        params.apiUrl = settings.use_alt_endpoint
            ? settings.alt_endpoint_url
            : textgenerationwebui_settings.server_urls[textgen_types.LLAMACPP];
    }

    // vllm needs apiUrl
    if (source === 'vllm') {
        params.apiUrl = settings.use_alt_endpoint
            ? settings.alt_endpoint_url
            : textgenerationwebui_settings.server_urls[textgen_types.VLLM];
    }

    return params;
}

/**
 * Check: ST Vectra backend (standard file-based vector storage)
 * This is the default backend - always available if ST is running
 */
export async function checkVectorsExtension() {
    try {
        const response = await fetch('/api/vector/list', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                collectionId: 'test',
                source: 'transformers'
            })
        });

        if (response.status === 404) {
            return {
                name: 'ST Vectra (Standard)',
                status: 'fail',
                message: 'ST vector API not available - check SillyTavern installation',
                fixable: false,
                category: 'infrastructure'
            };
        }

        return {
            name: 'ST Vectra (Standard)',
            status: 'pass',
            message: 'Standard file-based vector storage ready',
            category: 'infrastructure'
        };
    } catch (error) {
        return {
            name: 'ST Vectra (Standard)',
            status: 'fail',
            message: 'Cannot reach ST vector API',
            fixable: false,
            category: 'infrastructure'
        };
    }
}

/**
 * Check: ST Vector API endpoints
 * Tests all /api/vector/* endpoints comprehensively
 * NOTE: Always uses 'transformers' source for this check because native ST
 * endpoints don't recognize custom sources like bananabread. VectHare uses
 * the Similharity plugin endpoints for actual operations, not these.
 */
export async function checkBackendEndpoints(settings) {
    const results = [];
    // Always use 'transformers' - native ST endpoints don't know custom sources
    // This check tests "do endpoints respond?" not "does my provider work?"
    const source = 'transformers';

    const endpoints = [
        { name: 'list', method: 'POST', url: '/api/vector/list', body: { collectionId: 'vecthare_diag', source } },
        { name: 'query', method: 'POST', url: '/api/vector/query', body: { collectionId: 'vecthare_diag', searchText: 'test', topK: 1, source } },
        { name: 'insert', method: 'POST', url: '/api/vector/insert', body: { collectionId: 'vecthare_diag', items: [], source } },
        { name: 'delete', method: 'POST', url: '/api/vector/delete', body: { collectionId: 'vecthare_diag', hashes: [], source } },
        { name: 'purge', method: 'POST', url: '/api/vector/purge', body: { collectionId: 'vecthare_diag_nonexistent' } },
    ];

    for (const endpoint of endpoints) {
        try {
            const response = await fetch(endpoint.url, {
                method: endpoint.method,
                headers: getRequestHeaders(),
                body: JSON.stringify(endpoint.body),
            });

            if (response.status === 404) {
                results.push({ name: endpoint.name, ok: false, status: 404 });
            } else {
                results.push({ name: endpoint.name, ok: true, status: response.status });
            }
        } catch (error) {
            results.push({ name: endpoint.name, ok: false, error: error.message });
        }
    }

    const passed = results.filter(r => r.ok);
    const failed = results.filter(r => !r.ok);

    const formatResults = results.map(r =>
        `${r.name} ${r.ok ? '✓' : `✗(${r.status || r.error})`}`
    ).join(', ');

    if (failed.length === 0) {
        return {
            name: 'ST Vector Endpoints',
            status: 'pass',
            message: `All ${passed.length} endpoints: ${formatResults}`,
            category: 'infrastructure',
        };
    } else if (passed.length > 0) {
        return {
            name: 'ST Vector Endpoints',
            status: 'warning',
            message: `${passed.length}/${results.length} working: ${formatResults}`,
            category: 'infrastructure',
        };
    } else {
        return {
            name: 'ST Vector Endpoints',
            status: 'fail',
            message: 'No ST vector endpoints available',
            category: 'infrastructure',
        };
    }
}

/**
 * Check: VectHare Server Plugin (similharity)
 * Provides advanced features: LanceDB, Qdrant, collection browser, full metadata
 */
export async function checkServerPlugin() {
    try {
        const response = await fetch('/api/plugins/similharity/health', {
            method: 'GET',
            headers: getRequestHeaders()
        });

        if (!response.ok) {
            return {
                name: 'VectHare Plugin',
                status: 'warning',
                message: 'Plugin not installed (optional - enables LanceDB, Qdrant, advanced features)',
                fixable: false,
                category: 'infrastructure'
            };
        }

        const data = await response.json();

        if (data.status !== 'ok') {
            return {
                name: 'VectHare Plugin',
                status: 'warning',
                message: `Plugin unhealthy: ${data.status}`,
                category: 'infrastructure'
            };
        }

        const features = data.features?.join(', ') || 'core';
        return {
            name: 'VectHare Plugin',
            status: 'pass',
            message: `v${data.version} - Features: ${features}`,
            category: 'infrastructure'
        };
    } catch (error) {
        return {
            name: 'VectHare Plugin',
            status: 'warning',
            message: 'Plugin not available (standard mode only)',
            category: 'infrastructure'
        };
    }
}

/**
 * Check: VectHare Plugin API Endpoints
 * Tests all plugin-provided endpoints for advanced functionality
 */
export async function checkPluginEndpoints() {
    const results = [];
    const testSource = 'transformers';

    // First check if plugin is available
    try {
        const healthResponse = await fetch('/api/plugins/similharity/health', {
            method: 'GET',
            headers: getRequestHeaders()
        });

        if (!healthResponse.ok) {
            return {
                name: 'Plugin API Endpoints',
                status: 'skipped',
                message: 'Plugin not installed - endpoints not available',
                category: 'infrastructure'
            };
        }
        results.push({ name: 'health', ok: true });
    } catch (error) {
        return {
            name: 'Plugin API Endpoints',
            status: 'skipped',
            message: 'Plugin not available',
            category: 'infrastructure'
        };
    }

    // Test each plugin endpoint (unified API)
    const pluginEndpoints = [
        { name: 'collections', method: 'GET', url: `/api/plugins/similharity/collections` },
        { name: 'sources', method: 'GET', url: '/api/plugins/similharity/sources' },
        { name: 'chunks/list', method: 'POST', url: '/api/plugins/similharity/chunks/list',
          body: { backend: 'vectra', collectionId: 'vecthare_diag', source: testSource, limit: 1 } },
        { name: 'chunks/query', method: 'POST', url: '/api/plugins/similharity/chunks/query',
          body: { backend: 'vectra', collectionId: 'vecthare_diag', searchText: 'test', topK: 1, source: testSource } },
        { name: 'backend/health', method: 'GET', url: '/api/plugins/similharity/backend/health/vectra' },
    ];

    for (const ep of pluginEndpoints) {
        try {
            const opts = {
                method: ep.method,
                headers: getRequestHeaders(),
            };
            if (ep.body) opts.body = JSON.stringify(ep.body);

            const response = await fetch(ep.url, opts);
            results.push({ name: ep.name, ok: response.status !== 404, status: response.status });
        } catch (error) {
            results.push({ name: ep.name, ok: false, error: error.message });
        }
    }

    const passed = results.filter(r => r.ok);
    const failed = results.filter(r => !r.ok);
    const summary = results.map(r => `${r.name}${r.ok ? '✓' : '✗'}`).join(', ');

    if (failed.length === 0) {
        return {
            name: 'Plugin API Endpoints',
            status: 'pass',
            message: `${passed.length} endpoints: ${summary}`,
            category: 'infrastructure'
        };
    } else if (passed.length > 0) {
        return {
            name: 'Plugin API Endpoints',
            status: 'warning',
            message: `${passed.length}/${results.length}: ${summary}`,
            category: 'infrastructure'
        };
    } else {
        return {
            name: 'Plugin API Endpoints',
            status: 'fail',
            message: `All failed: ${summary}`,
            category: 'infrastructure'
        };
    }
}

/**
 * Check: LanceDB Backend (disk-based, scalable vector storage)
 * Requires VectHare plugin with vectordb package
 */
export async function checkLanceDBBackend(settings) {
    const backendName = 'LanceDB (Scalable)';

    if (settings.vector_backend !== 'lancedb') {
        return {
            name: backendName,
            status: 'skipped',
            message: `Not selected (using: ${settings.vector_backend || 'standard'})`,
            category: 'infrastructure'
        };
    }

    try {
        const healthResponse = await fetch('/api/plugins/similharity/backend/health/lancedb', {
            method: 'GET',
            headers: getRequestHeaders()
        });

        if (!healthResponse.ok) {
            return {
                name: backendName,
                status: 'fail',
                message: 'LanceDB plugin not installed. Run: cd plugins/similharity && npm install vectordb',
                category: 'infrastructure',
                fixable: true,
                fixAction: 'install_lancedb'
            };
        }

        const healthData = await healthResponse.json();

        if (healthData.healthy) {
            return {
                name: backendName,
                status: 'pass',
                message: 'LanceDB ready - disk-based vector storage active',
                category: 'infrastructure'
            };
        } else {
            return {
                name: backendName,
                status: 'warning',
                message: `LanceDB not initialized: ${healthData.message || 'Run "Vectorize All" to create tables'}`,
                category: 'infrastructure'
            };
        }
    } catch (error) {
        return {
            name: backendName,
            status: 'fail',
            message: `LanceDB unavailable: ${error.message}`,
            category: 'infrastructure'
        };
    }
}

/**
 * Check: Qdrant Backend (production-grade vector search)
 * Supports local Docker or Qdrant Cloud
 * Note: Qdrant Cloud may have CORS issues - use local instance for best results
 */
export async function checkQdrantBackend(settings) {
    const isCloud = settings.qdrant_use_cloud;
    const backendName = isCloud ? 'Qdrant (Cloud)' : 'Qdrant (Local)';

    if (settings.vector_backend !== 'qdrant') {
        return {
            name: 'Qdrant (Production)',
            status: 'skipped',
            message: `Not selected (using: ${settings.vector_backend || 'standard'})`,
            category: 'infrastructure'
        };
    }

    // Check configuration
    if (isCloud) {
        if (!settings.qdrant_url) {
            return {
                name: backendName,
                status: 'fail',
                message: 'Qdrant Cloud URL not configured',
                fixable: true,
                fixAction: 'configure_qdrant',
                category: 'infrastructure'
            };
        }
        if (!settings.qdrant_api_key) {
            return {
                name: backendName,
                status: 'fail',
                message: 'Qdrant Cloud API key not configured',
                fixable: true,
                fixAction: 'configure_qdrant',
                category: 'infrastructure'
            };
        }
    } else {
        if (!settings.qdrant_host || !settings.qdrant_port) {
            return {
                name: backendName,
                status: 'fail',
                message: 'Qdrant local host/port not configured (default: localhost:6333)',
                fixable: true,
                fixAction: 'configure_qdrant',
                category: 'infrastructure'
            };
        }
    }

    // First, try to initialize Qdrant with current settings
    try {
        const initConfig = {
            host: settings.qdrant_host || 'localhost',
            port: settings.qdrant_port || 6333,
            url: isCloud ? settings.qdrant_url : null,
            apiKey: settings.qdrant_api_key || null,
        };

        const initResponse = await fetch('/api/plugins/similharity/backend/init/qdrant', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(initConfig)
        });

        if (!initResponse.ok) {
            const errorText = await initResponse.text();
            return {
                name: backendName,
                status: 'fail',
                message: `Qdrant init failed: ${errorText}`,
                fixable: true,
                fixAction: 'configure_qdrant',
                category: 'infrastructure'
            };
        }
    } catch (error) {
        return {
            name: backendName,
            status: 'fail',
            message: `Qdrant init error: ${error.message}`,
            fixable: true,
            fixAction: 'configure_qdrant',
            category: 'infrastructure'
        };
    }

    // Then check health
    try {
        const healthResponse = await fetch('/api/plugins/similharity/backend/health/qdrant', {
            method: 'GET',
            headers: getRequestHeaders()
        });

        if (!healthResponse.ok) {
            return {
                name: backendName,
                status: 'fail',
                message: 'Qdrant plugin health check failed',
                category: 'infrastructure',
                fixable: true,
                fixAction: 'configure_qdrant'
            };
        }

        const healthData = await healthResponse.json();

        if (healthData.healthy) {
            const target = isCloud ? settings.qdrant_url : `${settings.qdrant_host}:${settings.qdrant_port}`;
            return {
                name: backendName,
                status: 'pass',
                message: `Connected to ${target}`,
                category: 'infrastructure'
            };
        } else {
            const error = healthData.message || 'Connection failed';
            // Provide more helpful error messages
            let suggestion = '';
            if (error.includes('ECONNREFUSED')) {
                suggestion = isCloud
                    ? ' - Check URL and API key'
                    : ' - Is Qdrant running? Try: docker run -p 6333:6333 qdrant/qdrant';
            } else if (error.includes('401') || error.includes('403')) {
                suggestion = ' - Invalid API key';
            } else if (error.includes('CORS')) {
                suggestion = ' - CORS blocked (use local Qdrant instead of Cloud)';
            }
            return {
                name: backendName,
                status: 'fail',
                message: `Qdrant error: ${error}${suggestion}`,
                fixable: true,
                fixAction: 'configure_qdrant',
                category: 'infrastructure'
            };
        }
    } catch (error) {
        return {
            name: backendName,
            status: 'fail',
            message: `Qdrant unavailable: ${error.message}`,
            category: 'infrastructure'
        };
    }
}

/**
 * Check: Qdrant vector dimension matches current embedding model
 * This catches the common "Internal Server Error" when switching embedding models
 */
export async function checkQdrantDimensionMatch(settings) {
    if (settings.vector_backend !== 'qdrant') {
        return {
            name: 'Qdrant Dimensions',
            status: 'skipped',
            message: 'Not using Qdrant backend',
            category: 'infrastructure'
        };
    }

    try {
        // Get collection info from Qdrant
        const infoResponse = await fetch('/api/plugins/similharity/backend/qdrant/collection-info', {
            method: 'GET',
            headers: getRequestHeaders()
        });

        if (!infoResponse.ok) {
            // Qdrant not initialized - that's checked elsewhere
            return {
                name: 'Qdrant Dimensions',
                status: 'skipped',
                message: 'Qdrant not initialized',
                category: 'infrastructure'
            };
        }

        const info = await infoResponse.json();

        if (!info.exists) {
            return {
                name: 'Qdrant Dimensions',
                status: 'pass',
                message: 'No collection yet - will be created on first vectorization',
                category: 'infrastructure'
            };
        }

        // Get current embedding dimension by generating a test embedding
        const testResponse = await fetch('/api/plugins/similharity/get-embedding', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                text: 'test',
                source: settings.source || 'transformers',
                model: getModelFromSettings(settings),
                // Include provider-specific params (apiUrl, apiKey for BananaBread, etc.)
                ...getPluginProviderParams(settings),
            })
        });

        if (!testResponse.ok) {
            return {
                name: 'Qdrant Dimensions',
                status: 'warning',
                message: 'Could not test embedding dimension - check embedding provider',
                category: 'infrastructure'
            };
        }

        const testData = await testResponse.json();
        const currentDimension = testData.embedding?.length || 0;

        if (currentDimension === 0) {
            return {
                name: 'Qdrant Dimensions',
                status: 'warning',
                message: 'Could not determine current embedding dimension',
                category: 'infrastructure'
            };
        }

        // Compare dimensions
        if (info.dimension !== currentDimension) {
            const sourceInfo = info.embeddingSources?.length > 0
                ? info.embeddingSources.join(', ')
                : 'unknown';
            const modelInfo = info.embeddingModels?.length > 0
                ? info.embeddingModels.join(', ')
                : '(not recorded)';

            return {
                name: 'Qdrant Dimensions',
                status: 'fail',
                message: `Dimension mismatch! Collection: ${info.dimension}-dim (source: ${sourceInfo}, model: ${modelInfo}). Current model: ${currentDimension}-dim.`,
                fixable: true,
                fixAction: 'fix_qdrant_dimension',
                category: 'infrastructure',
                data: {
                    collectionDimension: info.dimension,
                    currentDimension: currentDimension,
                    collectionSources: info.embeddingSources,
                    collectionModels: info.embeddingModels,
                    pointsCount: info.pointsCount,
                }
            };
        }

        return {
            name: 'Qdrant Dimensions',
            status: 'pass',
            message: `Dimensions match (${info.dimension}-dim, ${info.pointsCount} vectors)`,
            category: 'infrastructure'
        };

    } catch (error) {
        return {
            name: 'Qdrant Dimensions',
            status: 'warning',
            message: `Could not check dimensions: ${error.message}`,
            category: 'infrastructure'
        };
    }
}

/**
 * Helper to get model from settings based on source
 */
function getModelFromSettings(settings) {
    const modelField = getModelField(settings.source);
    return modelField ? settings[modelField] || '' : '';
}

/**
 * Check: Embedding provider is configured properly
 */
export async function checkEmbeddingProvider(settings) {
    const source = settings.source;

    if (!source) {
        return {
            name: 'Embedding Provider',
            status: 'fail',
            message: 'No embedding provider selected',
            fixable: true,
            fixAction: 'configure_provider'
        };
    }

    const config = getProviderConfig(source);
    if (!config) {
        return {
            name: 'Embedding Provider',
            status: 'fail',
            message: `Unknown provider: ${source}`,
            fixable: true,
            fixAction: 'configure_provider'
        };
    }

    const modelField = getModelField(source);
    if (config.requiresModel && modelField && !settings[modelField]) {
        return {
            name: 'Embedding Provider',
            status: 'fail',
            message: `${config.name} selected but no model configured`,
            fixable: true,
            fixAction: 'configure_provider'
        };
    }

    const modelInfo = modelField && settings[modelField] ? ` (${settings[modelField]})` : '';
    return {
        name: 'Embedding Provider',
        status: 'pass',
        message: `Using ${config.name}${modelInfo}`
    };
}

/**
 * Check: Transformers WASM memory limitations
 * WASM has a 4GB memory cap regardless of system RAM.
 * Large content vectorization can hit this limit and cause OOM errors.
 */
export function checkTransformersMemoryLimits(settings) {
    // Only relevant for transformers provider
    if (settings.source !== 'transformers') {
        return {
            name: 'WASM Memory',
            status: 'skipped',
            message: 'Not using local Transformers'
        };
    }

    // Check if user has Data Bank content or large collections
    // This is informational - we can't know exact memory usage
    return {
        name: 'WASM Memory',
        status: 'info',
        message: 'Transformers uses WASM with 4GB memory limit. For large documents, consider using Ollama or an API provider instead.'
    };
}

/**
 * Check: API keys are present for cloud providers
 */
export function checkApiKeys(settings) {
    const source = settings.source;

    if (!requiresApiKey(source)) {
        return {
            name: 'API Key',
            status: 'skipped',
            message: 'No API key required for this provider'
        };
    }

    // BananaBread stores API key in extension settings (not ST's secret store)
    // because custom keys aren't reliably returned by ST's readSecretState()
    if (source === 'bananabread') {
        if (settings.bananabread_api_key) {
            return {
                name: 'API Key',
                status: 'pass',
                message: 'API key configured'
            };
        } else {
            return {
                name: 'API Key',
                status: 'fail',
                message: 'BananaBread requires an API key',
                fixable: true,
                fixAction: 'configure_api_key'
            };
        }
    }

    const secretKey = getSecretKey(source);
    const keyPresent = secretKey && secret_state[secretKey];

    if (!keyPresent) {
        const config = getProviderConfig(source);
        return {
            name: 'API Key',
            status: 'fail',
            message: `${config?.name || source} requires an API key`,
            fixable: true,
            fixAction: 'configure_api_key'
        };
    }

    return {
        name: 'API Key',
        status: 'pass',
        message: 'API key configured'
    };
}

/**
 * Check: API URLs are configured for local providers
 */
export function checkApiUrls(settings) {
    const source = settings.source;

    if (!requiresUrl(source)) {
        return {
            name: 'API URL',
            status: 'skipped',
            message: 'No custom URL required'
        };
    }

    if (settings.use_alt_endpoint) {
        if (!settings.alt_endpoint_url) {
            return {
                name: 'API URL',
                status: 'fail',
                message: 'Alternative endpoint enabled but no URL configured',
                fixable: true,
                fixAction: 'configure_url'
            };
        }
        return {
            name: 'API URL',
            status: 'pass',
            message: `Custom: ${settings.alt_endpoint_url}`
        };
    }

    const textgenMapping = {
        'ollama': textgen_types.OLLAMA,
        'vllm': textgen_types.VLLM,
        'llamacpp': textgen_types.LLAMACPP,
        'koboldcpp': textgen_types.KOBOLDCPP
    };

    const config = getProviderConfig(source);
    const url = textgenMapping[source] ? textgenerationwebui_settings.server_urls[textgenMapping[source]] : null;

    if (!url) {
        return {
            name: 'API URL',
            status: 'fail',
            message: `${config?.name || source} requires a server URL`,
            fixable: true,
            fixAction: 'configure_url'
        };
    }

    return {
        name: 'API URL',
        status: 'pass',
        message: `${url}`
    };
}

/**
 * Check: Provider connectivity test
 */
export async function checkProviderConnectivity(settings) {
    if (!isValidProvider(settings.source)) {
        return {
            name: 'Provider Connectivity',
            status: 'fail',
            message: `Unknown provider: ${settings.source}`,
            fixable: true,
            fixAction: 'configure_provider'
        };
    }

    const config = getProviderConfig(settings.source);
    return {
        name: 'Provider Connectivity',
        status: 'pass',
        message: `Provider ${config.name} is recognized`
    };
}

/**
 * Check: WebLLM extension availability
 * Only runs if WebLLM is the selected provider
 */
export function checkWebLlmExtension(settings) {
    // Only relevant if WebLLM is selected
    if (settings.source !== 'webllm') {
        return {
            name: 'WebLLM Extension',
            status: 'skipped',
            message: 'WebLLM not selected as provider',
            category: 'infrastructure'
        };
    }

    // Check browser WebGPU support
    if (!('gpu' in navigator)) {
        return {
            name: 'WebLLM Extension',
            status: 'fail',
            message: 'Browser does not support WebGPU. Use Chrome 113+, Edge 113+, or another WebGPU-compatible browser.',
            fixable: false,
            category: 'infrastructure'
        };
    }

    // Check if WebLLM extension is installed
    if (!Object.hasOwn(SillyTavern, 'llm')) {
        return {
            name: 'WebLLM Extension',
            status: 'fail',
            message: 'WebLLM extension is not installed. Install from: github.com/SillyTavern/Extension-WebLLM',
            fixable: true,
            fixAction: 'install_webllm',
            category: 'infrastructure'
        };
    }

    // Check if WebLLM extension supports embeddings
    if (typeof SillyTavern.llm.generateEmbedding !== 'function') {
        return {
            name: 'WebLLM Extension',
            status: 'fail',
            message: 'WebLLM extension is outdated and does not support embeddings. Please update the extension.',
            fixable: true,
            fixAction: 'update_webllm',
            category: 'infrastructure'
        };
    }

    // Check if model is selected
    if (!settings.webllm_model) {
        return {
            name: 'WebLLM Extension',
            status: 'warning',
            message: 'WebLLM extension is installed but no model is selected. Select a model in VectHare settings.',
            fixable: false,
            category: 'infrastructure'
        };
    }

    return {
        name: 'WebLLM Extension',
        status: 'pass',
        message: `WebLLM ready with model: ${settings.webllm_model}`,
        category: 'infrastructure'
    };
}

/**
 * Check: BananaBread Connection
 * Tests connection to BananaBread server and validates API key
 */
export async function checkBananaBreadConnection(settings) {
    if (settings.source !== 'bananabread') {
        return {
            name: 'BananaBread Connection',
            status: 'skipped',
            message: 'BananaBread not selected as provider',
            category: 'infrastructure'
        };
    }

    try {
        const serverUrl = settings.use_alt_endpoint ? settings.alt_endpoint_url : 'http://localhost:8008';
        const cleanUrl = serverUrl.replace(/\/$/, '');

        const headers = {
            'Content-Type': 'application/json',
        };

        // Use extension settings for API key (custom keys aren't returned by ST's readSecretState)
        if (settings.bananabread_api_key) {
            headers['Authorization'] = `Bearer ${settings.bananabread_api_key}`;
        }

        const response = await fetch(`${cleanUrl}/v1/models`, {
            method: 'GET',
            headers: headers
        });

        if (!response.ok) {
            if (response.status === 401 || response.status === 403) {
                 return {
                    name: 'BananaBread Connection',
                    status: 'fail',
                    message: `Authentication failed (${response.status}). Check API key.`,
                    fixable: true,
                    fixAction: 'configure_api_key',
                    category: 'infrastructure'
                };
            }
             return {
                name: 'BananaBread Connection',
                status: 'fail',
                message: `Connection failed: ${response.status} ${response.statusText}`,
                fixable: true,
                fixAction: 'configure_url',
                category: 'infrastructure'
            };
        }
        
        const data = await response.json();
        const modelCount = data.data?.length || 0;

        if (modelCount > 0) {
            return {
                name: 'BananaBread Connection',
                status: 'pass',
                message: `Connected to ${cleanUrl} (${modelCount} models available)`,
                category: 'infrastructure'
            };
        } else {
             return {
                name: 'BananaBread Connection',
                status: 'warning',
                message: `Connected to ${cleanUrl} but no models found`,
                category: 'infrastructure'
            };
        }

    } catch (error) {
        return {
            name: 'BananaBread Connection',
            status: 'fail',
            message: `Connection error: ${error.message}`,
            fixable: true,
            fixAction: 'configure_url',
            category: 'infrastructure'
        };
    }
}
