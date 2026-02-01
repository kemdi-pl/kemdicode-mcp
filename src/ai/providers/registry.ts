/**
 * KemdiCode MCP Server - Provider Registry
 * Singleton registry for all LLM providers with lazy initialization.
 *
 * @license GPL-3.0
 */

import type { LLMProvider, ProviderId, ProviderConfig, BuiltinProviderId, CustomEndpointConfig } from './types.js';
import { PROVIDER_ENV_KEYS, PROVIDER_BASE_URLS } from './types.js';
import { OpenAIProvider } from './openai.provider.js';
import { AnthropicProvider } from './anthropic.provider.js';
import { GeminiProvider } from './gemini.provider.js';
import { createOpenAICompatProvider } from './openai-compat.provider.js';
import { Logger } from '../../utils/logger.js';

/** Registry of all providers (built-in + custom) */
const providers = new Map<ProviderId, LLMProvider>();

/** Manual config overrides per provider */
const providerConfigs = new Map<ProviderId, Partial<ProviderConfig>>();

/** Registry of custom endpoint configurations */
const customEndpoints = new Map<string, CustomEndpointConfig>();

/**
 * Register all built-in providers (called once at startup).
 */
export function registerBuiltinProviders(): void {
  if (providers.size > 0) return; // Already registered

  providers.set('openai', new OpenAIProvider());
  providers.set('anthropic', new AnthropicProvider());
  providers.set('gemini', new GeminiProvider());
  providers.set('groq', createOpenAICompatProvider('groq'));
  providers.set('deepseek', createOpenAICompatProvider('deepseek'));
  providers.set('ollama', createOpenAICompatProvider('ollama'));
  providers.set('openrouter', createOpenAICompatProvider('openrouter'));
  providers.set('perplexity', createOpenAICompatProvider('perplexity'));

  Logger.info(`Registered ${providers.size} LLM providers`);
}

/**
 * Set configuration override for a provider (from config file or tool).
 */
export function setProviderConfig(id: ProviderId, config: Partial<ProviderConfig>): void {
  const existing = providerConfigs.get(id);
  providerConfigs.set(id, { ...existing, ...config });
  // Reset provider so it re-initializes with new config on next use
  const provider = providers.get(id);
  if (provider?.isInitialized()) {
    // Re-create the provider to reset state
    if (id === 'openai') providers.set(id, new OpenAIProvider());
    else if (id === 'anthropic') providers.set(id, new AnthropicProvider());
    else if (id === 'gemini') providers.set(id, new GeminiProvider());
    else providers.set(id, createOpenAICompatProvider(id));
  }
}

// ---------------------------------------------------------------------------
// Custom Endpoints
// ---------------------------------------------------------------------------

/**
 * Register a custom OpenAI-compatible endpoint.
 *
 * Creates or hot-reloads a provider under `custom:<name>`.
 * Works for vLLM, LMStudio, Together AI, Fireworks AI, Azure, NVIDIA NIM, etc.
 *
 * @example
 *   registerCustomEndpoint({
 *     name: 'vllm',
 *     baseURL: 'http://gpu-server:8000/v1',
 *     apiKey: 'not-needed',
 *     defaultModel: 'meta-llama/Llama-3-70B',
 *   });
 *   // Now usable as: custom:vllm:meta-llama/Llama-3-70B
 */
export function registerCustomEndpoint(endpoint: CustomEndpointConfig): ProviderId {
  const providerId: ProviderId = `custom:${endpoint.name}`;

  customEndpoints.set(endpoint.name, endpoint);

  // Create or re-create the OpenAI-compatible provider
  const provider = createOpenAICompatProvider(providerId);
  provider.init({
    id: providerId,
    apiKey: endpoint.apiKey || 'not-needed',
    baseURL: endpoint.baseURL,
  });
  providers.set(providerId, provider);

  Logger.info(
    `Custom endpoint registered: ${providerId} → ${endpoint.baseURL}` +
      (endpoint.defaultModel ? ` (default: ${endpoint.defaultModel})` : ''),
  );

  return providerId;
}

/**
 * Remove a custom endpoint and its provider.
 */
export function deregisterCustomEndpoint(name: string): boolean {
  const providerId: ProviderId = `custom:${name}`;
  const removed = providers.delete(providerId);
  customEndpoints.delete(name);
  providerConfigs.delete(providerId);

  if (removed) {
    Logger.info(`Custom endpoint deregistered: ${providerId}`);
  }
  return removed;
}

/**
 * Get a custom endpoint configuration by name.
 */
export function getCustomEndpoint(name: string): CustomEndpointConfig | undefined {
  return customEndpoints.get(name);
}

/**
 * List all registered custom endpoints.
 */
export function listCustomEndpoints(): CustomEndpointConfig[] {
  return Array.from(customEndpoints.values());
}

/**
 * Register multiple custom endpoints at once (hot-reload safe).
 * Existing endpoints with the same name are replaced.
 */
export function registerCustomEndpoints(endpoints: CustomEndpointConfig[]): ProviderId[] {
  return endpoints.map((ep) => registerCustomEndpoint(ep));
}

/**
 * Check if a provider ID refers to a custom endpoint.
 */
export function isCustomProvider(id: ProviderId): boolean {
  return typeof id === 'string' && id.startsWith('custom:');
}

/**
 * Extract the endpoint name from a custom provider ID.
 */
export function customProviderName(id: ProviderId): string | undefined {
  if (!isCustomProvider(id)) return undefined;
  return (id as string).slice('custom:'.length);
}

/**
 * Resolve API key for a provider from environment variables or config.
 */
function resolveApiKey(id: ProviderId): string | undefined {
  // Check manual config first
  const configKey = providerConfigs.get(id)?.apiKey;
  if (configKey) return configKey;

  // Custom endpoints store API key in their config
  if (isCustomProvider(id)) {
    const name = customProviderName(id);
    if (name) {
      const ep = customEndpoints.get(name);
      return ep?.apiKey || 'not-needed';
    }
    return undefined;
  }

  // Check environment variables for built-in providers
  const envKeys = PROVIDER_ENV_KEYS[id as BuiltinProviderId];
  if (envKeys) {
    for (const envKey of envKeys) {
      const value = process.env[envKey];
      if (value) return value;
    }
  }

  return undefined;
}

/**
 * Ensure a provider is initialized. Lazy initialization on first use.
 */
function ensureInitialized(provider: LLMProvider): boolean {
  if (provider.isInitialized()) return true;

  const apiKey = resolveApiKey(provider.id);

  // Ollama and custom endpoints don't always need an API key
  if (!apiKey && provider.id !== 'ollama' && !isCustomProvider(provider.id)) {
    return false;
  }

  const overrides = providerConfigs.get(provider.id);
  const baseURL = overrides?.baseURL
    || (isCustomProvider(provider.id)
      ? customEndpoints.get(customProviderName(provider.id) || '')?.baseURL
      : PROVIDER_BASE_URLS[provider.id as BuiltinProviderId]);

  const config: ProviderConfig = {
    id: provider.id,
    apiKey: apiKey || '',
    baseURL,
  };

  try {
    provider.init(config);
    return true;
  } catch (error) {
    Logger.warn(
      `Failed to initialize ${provider.id} provider: ${error instanceof Error ? error.message : String(error)}`
    );
    return false;
  }
}

/**
 * Get a provider by ID. Lazily initializes if needed.
 * Throws if provider is not available (no API key, init failed, etc.)
 */
export function getProvider(id: ProviderId): LLMProvider {
  registerBuiltinProviders();

  const provider = providers.get(id);
  if (!provider) {
    if (isCustomProvider(id)) {
      const name = customProviderName(id);
      throw new Error(
        `Custom endpoint "${name}" is not registered. Use registerCustomEndpoint() or ai-config to add it.`,
      );
    }
    throw new Error(`Unknown provider: ${id}`);
  }

  if (!ensureInitialized(provider)) {
    if (isCustomProvider(id)) {
      throw new Error(`Custom endpoint "${id}" failed to initialize. Check baseURL and apiKey.`);
    }
    const envKeys = PROVIDER_ENV_KEYS[id as BuiltinProviderId] || [];
    throw new Error(
      `Provider "${id}" is not configured. Set API key via: ${envKeys.join(' or ')}`
    );
  }

  return provider;
}

/**
 * Check if a provider is available (has API key configured).
 */
export function isProviderAvailable(id: ProviderId): boolean {
  registerBuiltinProviders();

  const provider = providers.get(id);
  if (!provider) return false;

  if (provider.isInitialized()) return true;

  // Custom endpoints and ollama don't require API keys
  if (isCustomProvider(id)) return true;
  if (id === 'ollama') return true;
  return resolveApiKey(id) !== undefined;
}

/**
 * List all registered providers with their availability status.
 */
export function listProviders(): Array<{
  id: ProviderId;
  available: boolean;
  initialized: boolean;
  custom?: boolean;
  baseURL?: string;
}> {
  registerBuiltinProviders();

  return Array.from(providers.entries()).map(([id, provider]) => {
    const isCustom = isCustomProvider(id);
    const name = isCustom ? customProviderName(id) : undefined;
    const ep = name ? customEndpoints.get(name) : undefined;

    return {
      id,
      available: isProviderAvailable(id),
      initialized: provider.isInitialized(),
      ...(isCustom && { custom: true }),
      ...(ep && { baseURL: ep.baseURL }),
    };
  });
}
