/**
 * KemdiCode MCP Server - Provider Registry
 * Singleton registry for all LLM providers with lazy initialization.
 *
 * @license GPL-3.0
 */

import type { LLMProvider, ProviderId, ProviderConfig } from './types.js';
import { PROVIDER_ENV_KEYS, PROVIDER_BASE_URLS } from './types.js';
import { OpenAIProvider } from './openai.provider.js';
import { AnthropicProvider } from './anthropic.provider.js';
import { GeminiProvider } from './gemini.provider.js';
import { createOpenAICompatProvider } from './openai-compat.provider.js';
import { Logger } from '../../utils/logger.js';

/** Registry of all providers */
const providers = new Map<ProviderId, LLMProvider>();

/** Manual config overrides per provider */
const providerConfigs = new Map<ProviderId, Partial<ProviderConfig>>();

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
    else providers.set(id, createOpenAICompatProvider(id as ProviderId));
  }
}

/**
 * Resolve API key for a provider from environment variables or config.
 */
function resolveApiKey(id: ProviderId): string | undefined {
  // Check manual config first
  const configKey = providerConfigs.get(id)?.apiKey;
  if (configKey) return configKey;

  // Check environment variables
  const envKeys = PROVIDER_ENV_KEYS[id];
  for (const envKey of envKeys) {
    const value = process.env[envKey];
    if (value) return value;
  }

  return undefined;
}

/**
 * Ensure a provider is initialized. Lazy initialization on first use.
 */
function ensureInitialized(provider: LLMProvider): boolean {
  if (provider.isInitialized()) return true;

  const apiKey = resolveApiKey(provider.id);

  // Ollama doesn't need an API key
  if (!apiKey && provider.id !== 'ollama') {
    return false;
  }

  const overrides = providerConfigs.get(provider.id);
  const config: ProviderConfig = {
    id: provider.id,
    apiKey: apiKey || '',
    baseURL: overrides?.baseURL || PROVIDER_BASE_URLS[provider.id],
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
    throw new Error(`Unknown provider: ${id}`);
  }

  if (!ensureInitialized(provider)) {
    const envKeys = PROVIDER_ENV_KEYS[id];
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

  // Check if we can initialize (has API key)
  if (id === 'ollama') return true; // Always available
  return resolveApiKey(id) !== undefined;
}

/**
 * List all registered providers with their availability status.
 */
export function listProviders(): Array<{
  id: ProviderId;
  available: boolean;
  initialized: boolean;
}> {
  registerBuiltinProviders();

  return Array.from(providers.entries()).map(([id, provider]) => ({
    id,
    available: isProviderAvailable(id),
    initialized: provider.isInitialized(),
  }));
}
