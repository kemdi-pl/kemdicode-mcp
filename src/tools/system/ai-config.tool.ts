/**
 * KemdiCode MCP Server
 * Copyright (C) 2025-2026 Kemdi Sp. z o.o. (Dawid Irzyk <dawid@kemdi.pl>)
 *
 * This program is free software: you can distributed under the terms of the GNU
 * General Public License as published by the Free Software Foundation.
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
function setConfig(updates: {
  apiBaseUrl?: string;
  primaryModel?: string;
  fallbackModel?: string;
  apiKey?: string;
}): string {
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

  // Save to config file
  const saved = config.saveToFile(['server']);

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

  return (
    `Configuration updated${saved ? ' and saved to .kemdicode-mcp.json' : ''}:\n` +
    `- API URL: ${serverConfig.apiBaseUrl}\n` +
    `- Primary Model: ${serverConfig.primaryModel || '(not set)'}\n` +
    `- Fallback Model: ${serverConfig.fallbackModel || '(not set)'}`
  );
}

/**
 * Set API key securely
 */
function setApiKey(apiKey: string): string {
  const serverConfig = config.get('server');
  serverConfig.apiKey = apiKey;

  // Save to config file
  const saved = config.saveToFile(['server']);

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

  return (
    `API key set${saved ? ' and saved to .kemdicode-mcp.json' : ''}.\n` +
    `⚠️  Warning: API key is stored in plain text in the config file.\n` +
    `   Consider using KEMDICODE_SERVER_API_KEY environment variable instead.`
  );
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
      { args: { action: 'set', provider: 'openai', primaryModel: 'gpt-4o' }, description: 'Set OpenAI as provider with gpt-4o model' },
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
