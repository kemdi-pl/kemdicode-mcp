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
 * Configuration Manager
 *
 * Singleton class for managing application configuration.
 * Supports loading from defaults, environment variables, and CLI args.
 *
 * @module config/manager
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import type { AppConfig, ConfigGroup } from './types.js';
import { DEFAULT_CONFIG } from './defaults.js';
import { groupSchemas } from './schema.js';

/**
 * Project config filename
 */
const CONFIG_FILENAME = '.kemdicode-mcp.json';

/**
 * Environment variable prefix for config
 */
const ENV_PREFIX = 'KEMDICODE_';

/**
 * Environment variable mappings
 * Maps env var names (without prefix) to config paths
 */
const ENV_MAPPINGS: Record<string, { group: ConfigGroup; key: string }> = {
  // Server
  SERVER_PORT: { group: 'server', key: 'port' },
  SERVER_HOST: { group: 'server', key: 'host' },
  SERVER_MODEL: { group: 'server', key: 'primaryModel' },
  SERVER_FALLBACK_MODEL: { group: 'server', key: 'fallbackModel' },
  // Redis
  REDIS_HOST: { group: 'redis', key: 'host' },
  REDIS_PORT: { group: 'redis', key: 'port' },
  REDIS_DB: { group: 'redis', key: 'db' },
  REDIS_PASSWORD: { group: 'redis', key: 'password' },
  // Timeouts
  TIMEOUT_COMMAND: { group: 'timeouts', key: 'command' },
  TIMEOUT_SHORT: { group: 'timeouts', key: 'short' },
  TIMEOUT_LONG: { group: 'timeouts', key: 'long' },
  TIMEOUT_KEEPALIVE: { group: 'timeouts', key: 'keepalive' },
  // Cache
  CACHE_MAX_ENTRIES: { group: 'cache', key: 'maxEntries' },
  CACHE_DEFAULT_TTL: { group: 'cache', key: 'defaultTtl' },
  CACHE_GIT_SIZE: { group: 'cache', key: 'gitSize' },
  CACHE_GIT_TTL: { group: 'cache', key: 'gitTtl' },
  // Session
  SESSION_ACTIVE_TTL: { group: 'session', key: 'activeTtl' },
  SESSION_IDLE_TTL: { group: 'session', key: 'idleTtl' },
  SESSION_CLEANUP_INTERVAL: { group: 'session', key: 'cleanupInterval' },
  // Context
  CONTEXT_SCHEMA_TTL: { group: 'context', key: 'schema' },
  CONTEXT_API_DOCS_TTL: { group: 'context', key: 'apiDocs' },
  CONTEXT_QUERY_TTL: { group: 'context', key: 'query' },
  // Limits
  LIMITS_MAX_FILE_SIZE: { group: 'limits', key: 'maxFileSize' },
  LIMITS_MAX_DIFF_BUFFER: { group: 'limits', key: 'maxDiffBuffer' },
  LIMITS_MAX_BUFFER: { group: 'limits', key: 'maxBuffer' },
  // Retry
  RETRY_MAX_ATTEMPTS: { group: 'retry', key: 'maxAttempts' },
  RETRY_BASE_DELAY: { group: 'retry', key: 'baseDelay' },
  RETRY_MAX_DELAY: { group: 'retry', key: 'maxDelay' },
};

/**
 * Deep clone an object
 */
function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

/**
 * Parse environment variable value
 */
function parseEnvValue(value: string, currentValue: unknown): unknown {
  if (typeof currentValue === 'number') {
    const num = parseInt(value, 10);
    return isNaN(num) ? currentValue : num;
  }
  if (typeof currentValue === 'boolean') {
    return value.toLowerCase() === 'true' || value === '1';
  }
  return value;
}

/**
 * Configuration Manager
 *
 * Manages application configuration with support for:
 * - Default values from defaults.ts
 * - Environment variable overrides
 * - CLI argument overrides
 * - Runtime updates
 */
class ConfigManager {
  private config: AppConfig;
  private initial: AppConfig;
  private loaded = false;
  private projectDir: string = process.cwd();

  constructor() {
    this.config = deepClone(DEFAULT_CONFIG);
    this.initial = deepClone(DEFAULT_CONFIG);
  }

  /**
   * Set the project directory for config file operations
   */
  setProjectDir(dir: string): void {
    this.projectDir = dir;
  }

  /**
   * Get the project directory
   */
  getProjectDir(): string {
    return this.projectDir;
  }

  /**
   * Get config file path
   */
  private getConfigFilePath(): string {
    return join(this.projectDir, CONFIG_FILENAME);
  }

  /**
   * Load configuration from project file (.kemdicode-mcp.json)
   */
  loadFromFile(): boolean {
    const filePath = this.getConfigFilePath();

    if (!existsSync(filePath)) {
      return false;
    }

    try {
      const content = readFileSync(filePath, 'utf-8');
      const fileConfig = JSON.parse(content) as Partial<AppConfig>;

      // Merge file config into current config
      for (const [group, values] of Object.entries(fileConfig)) {
        if (group in this.config && values && typeof values === 'object') {
          const currentGroup = this.config[group as ConfigGroup] as unknown as Record<
            string,
            unknown
          >;
          for (const [key, value] of Object.entries(values)) {
            if (key in currentGroup) {
              currentGroup[key] = value;
            }
          }
        }
      }

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Save current configuration to project file
   */
  saveToFile(groups?: ConfigGroup[]): boolean {
    const filePath = this.getConfigFilePath();

    try {
      // Ensure directory exists
      const dir = dirname(filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      // Load existing file config or start fresh
      let fileConfig: Partial<AppConfig> = {};
      if (existsSync(filePath)) {
        try {
          const content = readFileSync(filePath, 'utf-8');
          fileConfig = JSON.parse(content);
        } catch {
          // Start fresh on parse error
        }
      }

      // Update only specified groups, or all if not specified
      const groupsToSave = groups || (['server'] as ConfigGroup[]);
      for (const group of groupsToSave) {
        (fileConfig as Record<string, unknown>)[group] = deepClone(this.config[group]);
      }

      // Write to file with nice formatting
      writeFileSync(filePath, JSON.stringify(fileConfig, null, 2) + '\n', 'utf-8');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Load configuration from all sources
   * Order: defaults -> project file -> env vars -> CLI args
   */
  load(cliOpts?: Record<string, unknown>): void {
    // Start with defaults
    this.config = deepClone(DEFAULT_CONFIG);

    // Load from project file (.kemdicode-mcp.json)
    this.loadFromFile();

    // Load from environment variables
    this.loadFromEnv();

    // Load from CLI args
    if (cliOpts) {
      this.loadFromCli(cliOpts);
    }

    // Store as initial config (for reset)
    this.initial = deepClone(this.config);
    this.loaded = true;
  }

  /**
   * Load configuration from environment variables
   */
  private loadFromEnv(): void {
    for (const [envKey, mapping] of Object.entries(ENV_MAPPINGS)) {
      const fullKey = `${ENV_PREFIX}${envKey}`;
      const value = process.env[fullKey];

      if (value !== undefined) {
        const group = this.config[mapping.group] as unknown as Record<string, unknown>;
        const currentValue = group[mapping.key];
        group[mapping.key] = parseEnvValue(value, currentValue);
      }
    }

    // Also check legacy env vars for backward compatibility
    if (process.env.REDIS_HOST) {
      this.config.redis.host = process.env.REDIS_HOST;
    }
    if (process.env.REDIS_PORT) {
      const parsed = parseInt(process.env.REDIS_PORT, 10);
      if (!isNaN(parsed)) this.config.redis.port = parsed;
    }
    if (process.env.REDIS_PASSWORD) {
      this.config.redis.password = process.env.REDIS_PASSWORD;
    }
  }

  /**
   * Load configuration from CLI arguments
   */
  private loadFromCli(opts: Record<string, unknown>): void {
    // Server options
    if (opts.model !== undefined) {
      this.config.server.primaryModel = String(opts.model);
    }
    if (opts.fallbackModel !== undefined) {
      this.config.server.fallbackModel = String(opts.fallbackModel);
    }
    if (opts.port !== undefined) {
      const parsed = parseInt(String(opts.port), 10);
      if (!isNaN(parsed)) this.config.server.port = parsed;
    }
    if (opts.host !== undefined) {
      this.config.server.host = String(opts.host);
    }

    // Redis options
    if (opts.redisHost !== undefined) {
      this.config.redis.host = String(opts.redisHost);
    }
    if (opts.redisPort !== undefined) {
      const parsed = parseInt(String(opts.redisPort), 10);
      if (!isNaN(parsed)) this.config.redis.port = parsed;
    }
  }

  /**
   * Get a configuration group
   */
  get<K extends ConfigGroup>(group: K): AppConfig[K] {
    if (!this.loaded) {
      this.load();
    }
    return this.config[group];
  }

  /**
   * Get the entire configuration
   */
  getAll(): Readonly<AppConfig> {
    if (!this.loaded) {
      this.load();
    }
    return this.config;
  }

  /**
   * Get initial configuration (from startup)
   */
  getInitial(): Readonly<AppConfig> {
    return this.initial;
  }

  /**
   * Update a configuration group
   */
  set<K extends ConfigGroup>(group: K, updates: Partial<AppConfig[K]>): void {
    // Validate updates
    const schema = groupSchemas[group];
    const current = this.config[group];
    const merged = { ...current, ...updates };

    const result = schema.safeParse(merged);
    if (!result.success) {
      throw new Error(`Invalid config for ${group}: ${result.error.message}`);
    }

    // Apply updates
    (this.config[group] as unknown as Record<string, unknown>) = result.data;
  }

  /**
   * Reset configuration to initial values
   */
  reset(group?: ConfigGroup): void {
    if (group) {
      (this.config as unknown as Record<string, unknown>)[group] = deepClone(this.initial[group]);
    } else {
      this.config = deepClone(this.initial);
    }
  }

  /**
   * Reset configuration to defaults
   */
  resetToDefaults(group?: ConfigGroup): void {
    if (group) {
      (this.config as unknown as Record<string, unknown>)[group] = deepClone(DEFAULT_CONFIG[group]);
    } else {
      this.config = deepClone(DEFAULT_CONFIG);
    }
  }

  /**
   * Check if config is loaded
   */
  isLoaded(): boolean {
    return this.loaded;
  }
}

/**
 * Singleton config manager instance
 */
export const config = new ConfigManager();
