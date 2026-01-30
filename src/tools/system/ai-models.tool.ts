/**
 * KemdiCode MCP Server
 * Copyright (C) 2025-2026 Kemdi Sp. z o.o.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

/**
 * AI Models Tool
 *
 * Lists available AI models from the current provider and allows
 * agents to select models dynamically for their sessions.
 *
 * @module tools/system/ai-models
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { config } from '../../config/index.js';
import { initAIClient } from '../../ai/index.js';
import { validateUrl } from '../../utils/security.js';

/**
 * Model info returned from API
 */
interface ModelInfo {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
}

/**
 * AI Models Tool Schema
 */
const schema = z.object({
  action: z
    .enum(['list', 'select', 'search'])
    .default('list')
    .describe(
      'Action: list (show all models), select (choose model for session), search (filter models)'
    ),
  filter: z
    .string()
    .optional()
    .describe('Filter models by name pattern (e.g., "kimi", "llama", "deepseek")'),
  model: z.string().optional().describe('Model ID to select (for select action)'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .default(50)
    .describe('Maximum number of models to return'),
  category: z
    .enum(['all', 'chat', 'code', 'vision', 'embedding'])
    .default('all')
    .describe('Filter by model category (based on common naming patterns)'),
});

/**
 * Fetch models from OpenAI-compatible API
 */
async function fetchModels(): Promise<ModelInfo[]> {
  const serverConfig = config.get('server');

  if (!serverConfig.apiBaseUrl) {
    throw new Error('API base URL not configured');
  }

  // SSRF guard: validate URL before calling fetch
  const urlCheck = validateUrl(serverConfig.apiBaseUrl);
  if (!urlCheck.valid) {
    throw new Error(`Invalid API base URL: ${urlCheck.error || 'blocked'}`);
  }

  if (!serverConfig.apiKey) {
    throw new Error('API key not configured');
  }

  const controller = new AbortController();
  const timeoutMs = config.get('timeouts').safeExec;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // Avoid double slashes
  const base = serverConfig.apiBaseUrl.replace(/\/+$/, '');
  const modelsUrl = `${base}/models`;

  let response: Response;
  try {
    response = await fetch(modelsUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${serverConfig.apiKey}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    });
  } catch (error) {
    // Normalize abort vs network errors
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new Error(`API error: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as { data?: ModelInfo[] };
  return data.data || [];
}

/**
 * Categorize model based on name patterns
 */
function categorizeModel(modelId: string): string {
  const id = modelId.toLowerCase();

  if (id.includes('embed') || id.includes('bge') || id.includes('e5')) {
    return 'embedding';
  }
  if (id.includes('vision') || id.includes('vl') || id.includes('pali') || id.includes('fuyu')) {
    return 'vision';
  }
  if (id.includes('code') || id.includes('starcoder') || id.includes('coder')) {
    return 'code';
  }
  return 'chat';
}

/**
 * Format model list for display
 */
function formatModelList(models: ModelInfo[], filter?: string, category?: string): string {
  let filtered = models;

  // Apply name filter
  if (filter) {
    const pattern = filter.toLowerCase();
    filtered = filtered.filter((m) => m.id.toLowerCase().includes(pattern));
  }

  // Apply category filter
  if (category && category !== 'all') {
    filtered = filtered.filter((m) => categorizeModel(m.id) === category);
  }

  // Sort alphabetically
  filtered.sort((a, b) => a.id.localeCompare(b.id));

  if (filtered.length === 0) {
    return 'No models found matching criteria.';
  }

  // Group by provider/owner
  const grouped = new Map<string, ModelInfo[]>();
  for (const model of filtered) {
    const provider = model.id.split('/')[0] || model.owned_by || 'other';
    if (!grouped.has(provider)) {
      grouped.set(provider, []);
    }
    grouped.get(provider)!.push(model);
  }

  let output = `Found ${filtered.length} models:\n\n`;

  for (const [provider, providerModels] of grouped) {
    output += `## ${provider}\n`;
    for (const model of providerModels) {
      const cat = categorizeModel(model.id);
      const catIcon =
        cat === 'chat' ? '💬' : cat === 'code' ? '💻' : cat === 'vision' ? '👁️' : '📊';
      output += `  ${catIcon} ${model.id}\n`;
    }
    output += '\n';
  }

  return output;
}

/**
 * AI Models Tool
 */
export const aiModelsTool: UnifiedTool<typeof schema> = {
  name: 'ai-models',
  description:
    'List and select AI models from the provider. Discover and switch models dynamically.',
  zodSchema: schema,

  execute: async (args) => {
    const { action, filter, model, limit, category } = args;
    const serverConfig = config.get('server');

    switch (action) {
      case 'list':
      case 'search': {
        try {
          const models = await fetchModels();
          const limited = models.slice(0, limit);
          return formatModelList(limited, filter, category);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return `Failed to fetch models: ${msg}`;
        }
      }

      case 'select': {
        if (!model) {
          return 'Error: Model ID required. Use: ai-models --action select --model <model-id>';
        }

        // Verify model exists
        try {
          const models = await fetchModels();
          const found = models.find((m) => m.id === model || m.id.endsWith(`/${model}`));

          if (!found) {
            // Model not in list, but might still work - warn user
            const suggestions = models
              .filter((m) => m.id.toLowerCase().includes(model.toLowerCase()))
              .slice(0, 5)
              .map((m) => m.id);

            if (suggestions.length > 0) {
              return `Model "${model}" not found. Did you mean:\n${suggestions.map((s) => `  - ${s}`).join('\n')}`;
            }
          }
        } catch {
          // Can't verify, proceed anyway
        }

        // Update config
        serverConfig.primaryModel = model;
        config.saveToFile(['server']);

        // Re-initialize AI client
        try {
          if (serverConfig.apiBaseUrl && serverConfig.apiKey) {
            initAIClient({
              baseURL: serverConfig.apiBaseUrl,
              apiKey: serverConfig.apiKey,
              defaultModel: model,
            });
          }
        } catch {
          // Ignore init errors
        }

        return `Model selected: ${model}\n\nThis model will be used for all AI operations in this session.`;
      }

      default:
        return `Unknown action: ${action}`;
    }
  },
};
