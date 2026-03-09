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
 * Config Tool
 *
 * Runtime configuration management for KemdiCode MCP server.
 * Manages all configuration groups: server, redis, timeouts,
 * cache, session, context, limits, retry, rl, loci.
 *
 * @module tools/system/config
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { config, CONFIG_GROUPS, DEFAULT_CONFIG, groupSchemas } from '../../config/index.js';
import type { ConfigGroup, AppConfig } from '../../config/index.js';

/**
 * Environment variable mappings for documentation
 */
const ENV_VAR_MAPPINGS: Record<ConfigGroup, Record<string, string>> = {
  server: {
    port: 'KEMDICODE_SERVER_PORT',
    host: 'KEMDICODE_SERVER_HOST',
    primaryModel: 'KEMDICODE_SERVER_MODEL',
    fallbackModel: 'KEMDICODE_SERVER_FALLBACK_MODEL',
    apiBaseUrl: 'KEMDICODE_SERVER_API_BASE_URL',
  },
  redis: {
    host: 'KEMDICODE_REDIS_HOST',
    port: 'KEMDICODE_REDIS_PORT',
    db: 'KEMDICODE_REDIS_DB',
    password: 'KEMDICODE_REDIS_PASSWORD',
  },
  timeouts: {
    command: 'KEMDICODE_TIMEOUT_COMMAND',
    short: 'KEMDICODE_TIMEOUT_SHORT',
    long: 'KEMDICODE_TIMEOUT_LONG',
    keepalive: 'KEMDICODE_TIMEOUT_KEEPALIVE',
    forceKill: 'KEMDICODE_TIMEOUT_FORCE_KILL',
    safeExec: 'KEMDICODE_TIMEOUT_SAFE_EXEC',
  },
  cache: {
    maxEntries: 'KEMDICODE_CACHE_MAX_ENTRIES',
    defaultTtl: 'KEMDICODE_CACHE_DEFAULT_TTL',
    gitSize: 'KEMDICODE_CACHE_GIT_SIZE',
    gitTtl: 'KEMDICODE_CACHE_GIT_TTL',
    fsSize: 'KEMDICODE_CACHE_FS_SIZE',
    fsTtl: 'KEMDICODE_CACHE_FS_TTL',
    projectSize: 'KEMDICODE_CACHE_PROJECT_SIZE',
    projectTtl: 'KEMDICODE_CACHE_PROJECT_TTL',
  },
  session: {
    activeTtl: 'KEMDICODE_SESSION_ACTIVE_TTL',
    idleTtl: 'KEMDICODE_SESSION_IDLE_TTL',
    cleanupInterval: 'KEMDICODE_SESSION_CLEANUP_INTERVAL',
  },
  context: {
    schema: 'KEMDICODE_CONTEXT_SCHEMA_TTL',
    apiDocs: 'KEMDICODE_CONTEXT_API_DOCS_TTL',
    query: 'KEMDICODE_CONTEXT_QUERY_TTL',
    analysis: 'KEMDICODE_CONTEXT_ANALYSIS_TTL',
    session: 'KEMDICODE_CONTEXT_SESSION_TTL',
    default: 'KEMDICODE_CONTEXT_DEFAULT_TTL',
  },
  limits: {
    maxFileSize: 'KEMDICODE_LIMITS_MAX_FILE_SIZE',
    maxDiffBuffer: 'KEMDICODE_LIMITS_MAX_DIFF_BUFFER',
    maxBuffer: 'KEMDICODE_LIMITS_MAX_BUFFER',
    binarySampleSize: 'KEMDICODE_LIMITS_BINARY_SAMPLE_SIZE',
  },
  retry: {
    maxAttempts: 'KEMDICODE_RETRY_MAX_ATTEMPTS',
    baseDelay: 'KEMDICODE_RETRY_BASE_DELAY',
    maxDelay: 'KEMDICODE_RETRY_MAX_DELAY',
  },
  loci: {
    nodeTtl: 'KEMDICODE_LOCI_NODE_TTL',
    edgeTtl: 'KEMDICODE_LOCI_EDGE_TTL',
  },
  providers: {
    defaultProvider: 'KEMDICODE_PROVIDERS_DEFAULT',
    openai: 'KEMDICODE_OPENAI_API_KEY',
    anthropic: 'KEMDICODE_ANTHROPIC_API_KEY',
    gemini: 'KEMDICODE_GEMINI_API_KEY',
    groq: 'KEMDICODE_GROQ_API_KEY',
    deepseek: 'KEMDICODE_DEEPSEEK_API_KEY',
    ollama: 'KEMDICODE_OLLAMA_HOST',
    openrouter: 'KEMDICODE_OPENROUTER_API_KEY',
  },
};

const schema = z.object({
  action: z
    .enum(['get', 'set', 'reset', 'list', 'save'])
    .describe(
      'Action: get (show config), set (update values and save to file), reset (restore initial), list (show all options), save (save current config to file)'
    ),
  group: z
    .enum([
      'server',
      'redis',
      'timeouts',
      'cache',
      'session',
      'context',
      'limits',
      'retry',
      'loci',
      'providers',
      'all',
    ])
    .optional()
    .describe('Config group to operate on (default: all)'),
  // For backward compatibility with model switching
  primaryModel: z.string().optional().describe('Shortcut: set server.primaryModel'),
  fallbackModel: z.string().optional().describe('Shortcut: set server.fallbackModel'),
  // Generic updates
  updates: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Key-value pairs to update (e.g., {"port": 3200, "host": "0.0.0.0"})'),
});

type ConfigArgs = z.infer<typeof schema>;

/**
 * Get field descriptions from Zod schema
 */
function getFieldDescriptions(group: ConfigGroup): Record<string, string> {
  const groupSchema = groupSchemas[group];
  const shape = groupSchema.shape as Record<string, z.ZodTypeAny>;
  const descriptions: Record<string, string> = {};

  for (const [key, fieldSchema] of Object.entries(shape)) {
    descriptions[key] = fieldSchema.description || 'No description';
  }

  return descriptions;
}

/**
 * Format a single group's configuration for output
 */
function formatGroupConfig(group: ConfigGroup): {
  group: string;
  current: Record<string, unknown>;
  initial: Record<string, unknown>;
  default: Record<string, unknown>;
  envVars: Record<string, string>;
} {
  const current = config.get(group) as unknown as Record<string, unknown>;
  const initial = config.getInitial()[group] as unknown as Record<string, unknown>;
  const defaults = DEFAULT_CONFIG[group] as unknown as Record<string, unknown>;

  // Mask sensitive values in all outputs
  const maskedCurrent: Record<string, unknown> = {};
  const maskedInitial: Record<string, unknown> = {};
  const maskedDefaults: Record<string, unknown> = {};
  for (const key of Object.keys(current)) {
    maskedCurrent[key] = maskSensitiveValue(key, current[key]);
    maskedInitial[key] = maskSensitiveValue(key, initial[key]);
    maskedDefaults[key] = maskSensitiveValue(key, defaults[key]);
  }

  return {
    group,
    current: maskedCurrent,
    initial: maskedInitial,
    default: maskedDefaults,
    envVars: ENV_VAR_MAPPINGS[group],
  };
}

/** Keys whose values must be masked in output */
const SENSITIVE_CONFIG_KEYS = new Set([
  'apikey',
  'apiKey',
  'password',
  'secret',
  'token',
]);

/**
 * Mask a sensitive value, keeping first 6 and last 4 chars
 */
function maskSensitiveValue(key: string, value: unknown): unknown {
  if (typeof value !== 'string' || value.length === 0) return value;
  const lowerKey = key.toLowerCase();
  if (!SENSITIVE_CONFIG_KEYS.has(key) && !SENSITIVE_CONFIG_KEYS.has(lowerKey)) return value;
  if (value.length <= 12) return '***';
  return value.slice(0, 6) + '***' + value.slice(-4);
}

/**
 * Format all groups for list action
 */
function formatListOutput(): Record<string, unknown> {
  const result: Record<string, unknown> = {
    groups: CONFIG_GROUPS,
  };

  for (const group of CONFIG_GROUPS) {
    const currentConfig = config.get(group) as unknown as Record<string, unknown>;
    const defaultConfig = DEFAULT_CONFIG[group] as unknown as Record<string, unknown>;
    const descriptions = getFieldDescriptions(group);
    const envVars = ENV_VAR_MAPPINGS[group];

    const groupDetails: Record<
      string,
      {
        current: unknown;
        default: unknown;
        envVar: string;
        description: string;
      }
    > = {};

    for (const [key, value] of Object.entries(currentConfig)) {
      groupDetails[key] = {
        current: maskSensitiveValue(key, value),
        default: maskSensitiveValue(key, defaultConfig[key]),
        envVar: envVars[key] || `KEMDICODE_${group.toUpperCase()}_${key.toUpperCase()}`,
        description: descriptions[key] || 'No description',
      };
    }

    result[group] = groupDetails;
  }

  return result;
}

export const configTool: UnifiedTool<typeof schema> = {
  name: 'config',
  description:
    'Manage server config at runtime. Switch AI models, adjust timeouts, cache settings. Actions: get, set, reset, list, save',
  zodSchema: schema,
  skipContextShare: true,
  metadata: {
    category: 'system',
    tags: ['config', 'settings'],
    examples: [
      { args: { action: 'get', group: 'server' }, description: 'View server configuration' },
      { args: { action: 'set', group: 'timeouts', updates: { command: 600000 } }, description: 'Update command timeout to 10 minutes' },
      { args: { action: 'list' }, description: 'List all configuration options with descriptions' },
    ],
    relatedTools: ['ai-config', 'env-info'],
  },

  execute: async (args: ConfigArgs): Promise<string> => {
    const { action, group, primaryModel, fallbackModel, updates } = args;
    const targetGroup = group === 'all' ? undefined : group;

    switch (action) {
      case 'get': {
        if (targetGroup) {
          // Return single group
          return JSON.stringify(formatGroupConfig(targetGroup), null, 2);
        }

        // Return all groups
        const allConfigs: Record<string, unknown> = {};
        for (const g of CONFIG_GROUPS) {
          allConfigs[g] = formatGroupConfig(g);
        }
        return JSON.stringify(allConfigs, null, 2);
      }

      case 'set': {
        // Handle backward compatibility: primaryModel/fallbackModel shortcuts
        if (primaryModel || fallbackModel) {
          const serverUpdates: Partial<AppConfig['server']> = {};
          if (primaryModel) serverUpdates.primaryModel = primaryModel;
          if (fallbackModel) serverUpdates.fallbackModel = fallbackModel;

          try {
            config.set('server', serverUpdates);
            // Auto-save to project file
            const saved = config.saveToFile(['server']);
            const updated = config.get('server');
            return JSON.stringify(
              {
                status: 'updated',
                group: 'server',
                changed: Object.keys(serverUpdates),
                savedToFile: saved,
                configFile: saved ? '.kemdicode-mcp.json' : null,
                config: {
                  primaryModel: updated.primaryModel,
                  fallbackModel: updated.fallbackModel || '(none)',
                },
              },
              null,
              2
            );
          } catch (error) {
            return JSON.stringify({
              error: `Validation failed: ${error instanceof Error ? error.message : error}`,
            });
          }
        }

        // Handle generic updates
        if (!targetGroup) {
          return JSON.stringify({
            error: 'Provide group to update (e.g., group: "timeouts")',
            example: {
              action: 'set',
              group: 'timeouts',
              updates: { command: 600000 },
            },
          });
        }

        if (!updates || Object.keys(updates).length === 0) {
          return JSON.stringify({
            error: 'Provide updates object with key-value pairs',
            example: {
              action: 'set',
              group: targetGroup,
              updates: { port: 3200 },
            },
          });
        }

        try {
          config.set(targetGroup, updates as Partial<AppConfig[typeof targetGroup]>);
          // Auto-save to project file
          const saved = config.saveToFile([targetGroup]);
          const updatedConfig = config.get(targetGroup);
          return JSON.stringify(
            {
              status: 'updated',
              group: targetGroup,
              changed: Object.keys(updates),
              savedToFile: saved,
              configFile: saved ? '.kemdicode-mcp.json' : null,
              config: updatedConfig,
            },
            null,
            2
          );
        } catch (error) {
          return JSON.stringify({
            error: `Validation failed: ${error instanceof Error ? error.message : error}`,
            hint: 'Check that values match expected types (numbers, strings, etc.)',
          });
        }
      }

      case 'reset': {
        if (targetGroup) {
          // Reset single group
          config.reset(targetGroup);
          return JSON.stringify(
            {
              status: 'reset to initial values',
              group: targetGroup,
              config: config.get(targetGroup),
            },
            null,
            2
          );
        }

        // Reset all groups
        config.reset();
        return JSON.stringify(
          {
            status: 'reset all groups to initial values',
            groups: CONFIG_GROUPS,
            hint: 'Use action="get" to see current config',
          },
          null,
          2
        );
      }

      case 'list': {
        return JSON.stringify(formatListOutput(), null, 2);
      }

      case 'save': {
        // Save current config to project file
        const groupsToSave = targetGroup ? [targetGroup] : CONFIG_GROUPS;
        const saved = config.saveToFile(groupsToSave);
        return JSON.stringify(
          {
            status: saved ? 'saved' : 'failed',
            file: '.kemdicode-mcp.json',
            projectDir: config.getProjectDir(),
            groups: groupsToSave,
          },
          null,
          2
        );
      }

      default:
        return JSON.stringify({ error: `Unknown action: ${action}` });
    }
  },
};
