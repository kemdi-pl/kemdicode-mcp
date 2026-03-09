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

/**
 * AI Configuration Tool
 *
 * Manages AI provider settings (API URL, model, API key) and saves them
 * to the project configuration file (.kemdicode-mcp.json).
 *
 * Uses OpenAI SDK - compatible with any OpenAI-compatible API:
 * - OpenAI
 * - NVIDIA NIM
 * - Azure OpenAI
 * - OpenRouter
 * - Local models (Ollama, LM Studio)
 *
 * @module tools/system/ai-config
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { config } from '../../config/index.js';
import { initAIClient, testConnection as testAIConnection } from '../../ai/index.js';
import {
  registerCustomEndpoint,
  deregisterCustomEndpoint,
  listCustomEndpoints,
  getCustomEndpoint,
} from '../../ai/providers/registry.js';
import { getSharedRedis } from '../../infrastructure/redis/connection.js';
import { Logger } from '../../utils/logger.js';

const REDIS_AI_CONFIG_KEY = 'mcp:config:ai';

/**
 * Hot-reload all custom endpoints with updated apiKey/baseURL.
 * Fixes the bug where ai-config set/set-key only updated the legacy client
 * but left custom endpoint providers with stale credentials.
 */
function hotReloadCustomEndpoints(apiKey: string, baseURL?: string): void {
  try {
    const endpoints = listCustomEndpoints();
    for (const ep of endpoints) {
      const updated = {
        ...ep,
        apiKey: apiKey || ep.apiKey,
        baseURL: baseURL || ep.baseURL,
      };
      registerCustomEndpoint(updated);
      Logger.info(`Hot-reloaded custom endpoint: custom:${ep.name}`);
    }
  } catch {
    // Non-critical — endpoints will use old credentials until restart
  }
}

/**
 * AI Config Tool Schema
 */
const schema = z.object({
  action: z
    .enum(['get', 'set', 'set-key', 'list-providers', 'test', 'add-custom', 'remove-custom', 'list-custom'])
    .describe('Action: get|set|set-key|list-providers|test|add-custom|remove-custom|list-custom'),
  apiBaseUrl: z
    .string()
    .url()
    .optional()
    .describe('API base URL'),
  primaryModel: z
    .string()
    .optional()
    .describe('Primary model ID'),
  fallbackModel: z.string().optional().describe('Fallback model ID'),
  apiKey: z.string().optional().describe('API key'),
  provider: z
    .string()
    .optional()
    .describe('Provider preset name or custom endpoint name'),
  defaultModel: z.string().optional().describe('Default model for custom endpoint'),
  models: z.string().optional().describe('Pipe-separated model list for custom endpoint (e.g. "llama3|mistral")'),
});

/**
 * Provider presets - examples only, not hardcoded defaults
 * Users should configure via ai-config --action set
 */
const PROVIDER_PRESETS: Record<string, { url: string; description: string }> = {
  openai: {
    url: 'https://api.openai.com/v1',
    description: 'OpenAI API',
  },
  nvidia: {
    url: 'https://integrate.api.nvidia.com/v1',
    description: 'NVIDIA NIM (OpenAI-compatible)',
  },
  anthropic: {
    url: 'https://api.anthropic.com/v1',
    description: 'Anthropic API',
  },
  openrouter: {
    url: 'https://openrouter.ai/api/v1',
    description: 'OpenRouter (multi-provider)',
  },
  local: {
    url: 'http://localhost:11434/v1',
    description: 'Local Ollama/LM Studio',
  },
};

/**
 * Save AI config to Redis for persistence across restarts
 */
async function saveConfigToRedis(): Promise<void> {
  try {
    const redis = await getSharedRedis();
    const serverConfig = config.get('server');
    await redis.set(
      REDIS_AI_CONFIG_KEY,
      JSON.stringify({
        apiBaseUrl: serverConfig.apiBaseUrl,
        primaryModel: serverConfig.primaryModel,
        fallbackModel: serverConfig.fallbackModel,
        apiKey: serverConfig.apiKey,
      })
    );
  } catch {
    // Redis unavailable — file config is still saved
  }
}

/**
 * Load AI config from Redis (called at startup)
 */
export async function loadConfigFromRedis(): Promise<boolean> {
  try {
    const redis = await getSharedRedis();
    const raw = await redis.get(REDIS_AI_CONFIG_KEY);
    if (!raw) return false;

    const saved = JSON.parse(raw) as {
      apiBaseUrl?: string;
      primaryModel?: string;
      fallbackModel?: string;
      apiKey?: string;
    };

    const serverConfig = config.get('server');
    let changed = false;

    // Redis config fills in missing values (doesn't override CLI/env)
    if (saved.apiBaseUrl && !serverConfig.apiBaseUrl) {
      serverConfig.apiBaseUrl = saved.apiBaseUrl;
      changed = true;
    }
    if (saved.primaryModel && !serverConfig.primaryModel) {
      serverConfig.primaryModel = saved.primaryModel;
      changed = true;
    }
    if (saved.fallbackModel && !serverConfig.fallbackModel) {
      serverConfig.fallbackModel = saved.fallbackModel;
      changed = true;
    }
    if (saved.apiKey && !serverConfig.apiKey) {
      serverConfig.apiKey = saved.apiKey;
      changed = true;
    }

    if (changed && serverConfig.apiBaseUrl && serverConfig.apiKey) {
      initAIClient({
        baseURL: serverConfig.apiBaseUrl,
        apiKey: serverConfig.apiKey,
        defaultModel: serverConfig.primaryModel,
        fallbackModel: serverConfig.fallbackModel,
      });
    }

    return changed;
  } catch {
    return false;
  }
}

/**
 * Get current active model info for dynamic tool descriptions
 */
export function getActiveModelInfo(): string {
  const serverConfig = config.get('server');
  const model = serverConfig.primaryModel || '(not configured)';
  const url = serverConfig.apiBaseUrl || '';
  let provider = 'unknown';
  if (url.includes('openrouter')) provider = 'openrouter';
  else if (url.includes('openai.com')) provider = 'openai';
  else if (url.includes('anthropic')) provider = 'anthropic';
  else if (url.includes('minimax')) provider = 'minimax';
  else if (url.includes('groq')) provider = 'groq';
  else if (url.includes('deepseek')) provider = 'deepseek';
  else if (url.includes('localhost') || url.includes('127.0.0.1')) provider = 'local';
  return `${provider}:${model}`;
}

/**
 * Get current AI configuration (with masked API key)
 */
function getCurrentConfig(): Record<string, unknown> {
  const serverConfig = config.get('server');
  return {
    apiBaseUrl: serverConfig.apiBaseUrl,
    primaryModel: serverConfig.primaryModel,
    fallbackModel: serverConfig.fallbackModel,
    apiKey: serverConfig.apiKey ? '***' : '(not set)',
    source: 'config',
  };
}

/**
 * Set AI configuration values
 */
async function setConfig(updates: {
  apiBaseUrl?: string;
  primaryModel?: string;
  fallbackModel?: string;
  apiKey?: string;
}): Promise<string> {
  const serverConfig = config.get('server');

  if (updates.apiBaseUrl) {
    serverConfig.apiBaseUrl = updates.apiBaseUrl;
  }
  if (updates.primaryModel) {
    serverConfig.primaryModel = updates.primaryModel;
  }
  if (updates.fallbackModel) {
    serverConfig.fallbackModel = updates.fallbackModel;
  }
  if (updates.apiKey) {
    serverConfig.apiKey = updates.apiKey;
  }

  // Save to config file and Redis
  const saved = config.saveToFile(['server']);
  await saveConfigToRedis();

  // Re-initialize AI client with new settings
  try {
    if (serverConfig.apiBaseUrl && serverConfig.apiKey) {
      initAIClient({
        baseURL: serverConfig.apiBaseUrl,
        apiKey: serverConfig.apiKey,
        defaultModel: serverConfig.primaryModel,
        fallbackModel: serverConfig.fallbackModel,
      });
    }
  } catch {
    // Ignore re-init errors, will be caught on first use
  }

  // Hot-reload custom endpoints when apiKey or baseURL changes
  if ((updates.apiKey || updates.apiBaseUrl) && serverConfig.apiKey) {
    hotReloadCustomEndpoints(serverConfig.apiKey, serverConfig.apiBaseUrl);
  }

  return (
    `Configuration updated${saved ? ' and saved to .kemdicode-mcp.json + Redis' : ' and saved to Redis'}:\n` +
    `- API URL: ${serverConfig.apiBaseUrl}\n` +
    `- Primary Model: ${serverConfig.primaryModel || '(not set)'}\n` +
    `- Fallback Model: ${serverConfig.fallbackModel || '(not set)'}`
  );
}

/**
 * Set API key securely
 */
async function setApiKey(apiKey: string): Promise<string> {
  const serverConfig = config.get('server');
  serverConfig.apiKey = apiKey;

  // Save to config file and Redis
  const saved = config.saveToFile(['server']);
  await saveConfigToRedis();

  // Re-initialize AI client
  try {
    if (serverConfig.apiBaseUrl) {
      initAIClient({
        baseURL: serverConfig.apiBaseUrl,
        apiKey: apiKey,
        defaultModel: serverConfig.primaryModel,
        fallbackModel: serverConfig.fallbackModel,
      });
    }
  } catch {
    // Ignore re-init errors
  }

  // Hot-reload custom endpoints with new API key
  hotReloadCustomEndpoints(apiKey, serverConfig.apiBaseUrl);

  return `API key set${saved ? ' and saved to .kemdicode-mcp.json + Redis' : ' and saved to Redis'}.`;
}

/**
 * List available providers
 */
function listProviders(): string {
  let output = 'Available AI Providers (OpenAI-compatible):\n\n';

  for (const [name, preset] of Object.entries(PROVIDER_PRESETS)) {
    output += `${name}:\n`;
    output += `  URL: ${preset.url}\n`;
    output += `  Description: ${preset.description}\n\n`;
  }

  output += 'Usage:\n';
  output += '  ai-config --action set --apiBaseUrl <url> --primaryModel <model>\n';
  output += '  ai-config --action set --apiKey <key>\n';
  output += '  ai-config --action test\n';
  output += '\nUse ai-models --action list to discover available models from your provider.\n';

  return output;
}

/**
 * Test AI connection using OpenAI SDK
 */
async function testConnectionHandler(): Promise<string> {
  const serverConfig = config.get('server');

  if (!serverConfig.apiBaseUrl) {
    return '❌ API base URL not configured. Use: ai-config --action set --apiBaseUrl <url>';
  }

  if (!serverConfig.apiKey) {
    return '❌ API key not configured. Use: ai-config --action set --apiKey <key>';
  }

  if (!serverConfig.primaryModel) {
    return '❌ Primary model not configured. Use: ai-config --action set --primaryModel <model>';
  }

  try {
    // Initialize client with current config
    initAIClient({
      baseURL: serverConfig.apiBaseUrl,
      apiKey: serverConfig.apiKey,
      defaultModel: serverConfig.primaryModel,
      fallbackModel: serverConfig.fallbackModel,
    });

    // Test connection
    const result = await testAIConnection();

    if (result.success) {
      return (
        `✅ ${result.message}\n` +
        `   URL: ${serverConfig.apiBaseUrl}\n` +
        `   Model: ${serverConfig.primaryModel}`
      );
    } else {
      return `❌ ${result.message}`;
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return `❌ Connection failed: ${msg}`;
  }
}

/**
 * AI Config Tool
 */
export const aiConfigTool: UnifiedTool = {
  name: 'ai-config',
  description: 'Manage AI provider settings (URL, model, key) and custom OpenAI-compatible endpoints. Use when: switching AI providers or changing model settings at runtime.',
  zodSchema: schema,
  prompt: {
    description: 'Configure AI provider settings, add/remove custom OpenAI-compatible endpoints with hot-reload',
  },
  metadata: {
    category: 'system',
    tags: ['config', 'ai', 'provider', 'custom-endpoint', 'hot-reload'],
    examples: [
      { args: { action: 'get' }, description: 'View current AI configuration' },
      { args: { action: 'set', provider: 'openai', primaryModel: 'gpt-4.1' }, description: 'Set OpenAI as provider with gpt-4.1 model' },
      { args: { action: 'test' }, description: 'Test the current AI connection' },
      { args: { action: 'add-custom', provider: 'vllm', apiBaseUrl: 'http://gpu:8000/v1', defaultModel: 'llama3' }, description: 'Register custom vLLM endpoint (hot-reload)' },
      { args: { action: 'add-custom', provider: 'lmstudio', apiBaseUrl: 'http://localhost:1234/v1' }, description: 'Register LM Studio endpoint' },
      { args: { action: 'remove-custom', provider: 'vllm' }, description: 'Remove custom endpoint' },
      { args: { action: 'list-custom' }, description: 'List all custom endpoints' },
    ],
    relatedTools: ['ai-models', 'env-info'],
  },
  execute: async (args) => {
    const action = args.action as string;

    switch (action) {
      case 'get':
        return JSON.stringify(getCurrentConfig(), null, 2);

      case 'set': {
        const provider = args.provider as string | undefined;
        let apiBaseUrl = args.apiBaseUrl as string | undefined;

        // Apply provider URL preset if specified (model must be set explicitly)
        if (provider && PROVIDER_PRESETS[provider] && !apiBaseUrl) {
          apiBaseUrl = PROVIDER_PRESETS[provider].url;
        }

        return setConfig({
          apiBaseUrl,
          primaryModel: args.primaryModel as string | undefined,
          fallbackModel: args.fallbackModel as string | undefined,
          apiKey: args.apiKey as string | undefined,
        });
      }

      case 'set-key': {
        const apiKey = args.apiKey as string | undefined;
        if (!apiKey) {
          throw new Error('API key required. Use: --apiKey <your-key>');
        }
        return setApiKey(apiKey);
      }

      case 'list-providers':
        return listProviders();

      case 'test':
        return await testConnectionHandler();

      case 'add-custom': {
        const name = args.provider as string | undefined;
        const baseURL = args.apiBaseUrl as string | undefined;
        if (!name) throw new Error('Endpoint name required (--provider <name>)');
        if (!baseURL) throw new Error('Base URL required (--apiBaseUrl <url>)');

        const modelsRaw = args.models as string | undefined;
        const providerId = registerCustomEndpoint({
          name,
          baseURL,
          apiKey: (args.apiKey as string) || '',
          defaultModel: args.defaultModel as string | undefined,
          models: modelsRaw ? modelsRaw.split('|').map((m) => m.trim()) : undefined,
        });

        const existing = getCustomEndpoint(name);
        return (
          `Custom endpoint registered (hot-reload): ${providerId}\n` +
          `  URL: ${baseURL}\n` +
          `  Default model: ${existing?.defaultModel || '(none)'}\n` +
          `  Models: ${existing?.models?.join(', ') || '(auto-detect)'}\n\n` +
          `Usage: custom:${name}:<model>\n` +
          `Example: custom:${name}:${existing?.defaultModel || 'my-model'}`
        );
      }

      case 'remove-custom': {
        const name = args.provider as string | undefined;
        if (!name) throw new Error('Endpoint name required (--provider <name>)');

        const removed = deregisterCustomEndpoint(name);
        return removed
          ? `Custom endpoint "custom:${name}" removed.`
          : `Custom endpoint "${name}" not found.`;
      }

      case 'list-custom': {
        const endpoints = listCustomEndpoints();
        if (endpoints.length === 0) {
          return 'No custom endpoints registered.\n\nUse: ai-config --action add-custom --provider <name> --apiBaseUrl <url>';
        }

        let output = `Custom Endpoints (${endpoints.length}):\n\n`;
        for (const ep of endpoints) {
          output += `custom:${ep.name}\n`;
          output += `  URL: ${ep.baseURL}\n`;
          output += `  API Key: ${ep.apiKey ? '***' : '(none)'}\n`;
          output += `  Default model: ${ep.defaultModel || '(none)'}\n`;
          if (ep.models?.length) {
            output += `  Models: ${ep.models.join(', ')}\n`;
          }
          output += '\n';
        }
        return output;
      }

      default:
        return `Unknown action: ${action}. Use: get, set, set-key, list-providers, test, add-custom, remove-custom, list-custom`;
    }
  },
};
