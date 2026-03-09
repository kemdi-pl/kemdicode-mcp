/**
 * KemdiCode MCP Server
 * Copyright (C) 2025-2026 Kemdi Sp. z o.o. (Dawid Irzyk <dawid@kemdi.pl>)
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

import type { LLMProvider, ProviderId, ProviderConfig, BuiltinProviderId, CustomEndpointConfig } from './types.js';
import { PROVIDER_ENV_KEYS, PROVIDER_BASE_URLS } from './types.js';
import { OpenAIProvider } from './openai.provider.js';
import { AnthropicProvider } from './anthropic.provider.js';
import { GeminiProvider } from './gemini.provider.js';
import { createOpenAICompatProvider } from './openai-compat.provider.js';
import { Logger } from '../../utils/logger.js';
import { getSharedRedis } from '../../infrastructure/redis/connection.js';

const REDIS_CUSTOM_ENDPOINTS_KEY = 'mcp:config:custom-endpoints';

/** Registry of all providers (built-in + custom) */
const providers = new Map<ProviderId, LLMProvider>();

/** Manual config overrides per provider */
const providerConfigs = new Map<ProviderId, Partial<ProviderConfig>>();

/** Registry of custom endpoint configurations */
const customEndpoints = new Map<string, CustomEndpointConfig>();

/** Init locks to prevent concurrent initialization of the same provider */
const initLocks = new Set<ProviderId>();

/** Cumulative token usage tracking (reset on server restart) */
const tokenUsage = { prompt: 0, completion: 0, total: 0 };

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

  // Persist to Redis (fire-and-forget)
  persistCustomEndpointsToRedis().catch((err) => {
    Logger.debug(`[ProviderRegistry] Failed to persist custom endpoints to Redis: ${err instanceof Error ? err.message : String(err)}`);
  });

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
    // Persist removal to Redis (fire-and-forget)
    persistCustomEndpointsToRedis().catch((err) => {
    Logger.debug(`[ProviderRegistry] Failed to persist custom endpoints to Redis: ${err instanceof Error ? err.message : String(err)}`);
  });
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
 * Uses a simple lock to prevent concurrent init of the same provider.
 */
function ensureInitialized(provider: LLMProvider): boolean {
  if (provider.isInitialized()) return true;

  // Prevent concurrent initialization
  if (initLocks.has(provider.id)) return false;
  initLocks.add(provider.id);

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
  } finally {
    initLocks.delete(provider.id);
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

// ---------------------------------------------------------------------------
// Cumulative Token Tracking
// ---------------------------------------------------------------------------

/**
 * Record token usage from a completion response.
 */
export function recordTokenUsage(usage: { promptTokens: number; completionTokens: number; totalTokens: number }): void {
  tokenUsage.prompt += usage.promptTokens;
  tokenUsage.completion += usage.completionTokens;
  tokenUsage.total += usage.totalTokens;
}

/**
 * Get cumulative token usage since server start.
 */
export function getTokenUsage(): { prompt: number; completion: number; total: number } {
  return { ...tokenUsage };
}

// ---------------------------------------------------------------------------
// Redis Persistence for Custom Endpoints
// ---------------------------------------------------------------------------

/**
 * Save all custom endpoints to Redis.
 */
async function persistCustomEndpointsToRedis(): Promise<void> {
  try {
    const client = await getSharedRedis();
    const entries = Array.from(customEndpoints.values());
    await client.set(REDIS_CUSTOM_ENDPOINTS_KEY, JSON.stringify(entries));
    Logger.debug(`[Registry] Persisted ${entries.length} custom endpoints to Redis`);
  } catch (err) {
    Logger.warn(`[Registry] Failed to persist custom endpoints: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Load custom endpoints from Redis and register them.
 * Called at server startup to restore previously configured endpoints.
 */
export async function loadCustomEndpointsFromRedis(): Promise<number> {
  try {
    const client = await getSharedRedis();
    const raw = await client.get(REDIS_CUSTOM_ENDPOINTS_KEY);
    if (!raw) return 0;

    const entries = JSON.parse(raw) as CustomEndpointConfig[];
    if (!Array.isArray(entries) || entries.length === 0) return 0;

    let loaded = 0;
    for (const ep of entries) {
      if (!ep.name || !ep.baseURL) continue;
      try {
        // Register in memory without re-persisting (avoid loop)
        const providerId: ProviderId = `custom:${ep.name}`;
        customEndpoints.set(ep.name, ep);
        const provider = createOpenAICompatProvider(providerId);
        provider.init({
          id: providerId,
          apiKey: ep.apiKey || 'not-needed',
          baseURL: ep.baseURL,
        });
        providers.set(providerId, provider);
        loaded++;
        Logger.info(`[Registry] Restored custom endpoint: custom:${ep.name} → ${ep.baseURL}`);
      } catch (err) {
        Logger.warn(`[Registry] Failed to restore custom:${ep.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return loaded;
  } catch (err) {
    Logger.warn(`[Registry] Failed to load custom endpoints from Redis: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
}
