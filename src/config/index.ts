/**
 * KemdiCode MCP Server
 * Copyright (C) 2025-2026 Kemdi Sp. z o.o.
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
 * Configuration Module
 *
 * Centralized configuration management for KemdiCode MCP server.
 *
 * @module config
 *
 * @example
 * ```typescript
 * import { config } from './config/index.js';
 *
 * // Get a config group
 * const server = config.get('server');
 * console.log(server.port); // 3100
 *
 * // Update at runtime
 * config.set('server', { primaryModel: 'google/gemini-2.5-flash' });
 *
 * // Reset to initial values
 * config.reset('server');
 * ```
 */

export { config } from './manager.js';
export { DEFAULT_CONFIG } from './defaults.js';
export { appConfigSchema, groupSchemas } from './schema.js';
export type {
  AppConfig,
  ConfigGroup,
  ServerConfig,
  RedisConfig,
  TimeoutConfig,
  CacheConfig,
  SessionConfig,
  ContextTtlConfig,
  LimitsConfig,
  RetryConfig,
  RlConfig,
  LociConfig,
} from './types.js';
export { CONFIG_GROUPS } from './types.js';
