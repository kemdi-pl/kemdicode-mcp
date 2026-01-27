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
 * Constants Module
 *
 * Central location for application-wide constants including
 * error messages, CLI configuration, protocol settings, and logging configuration.
 *
 * @module constants
 */

import { config } from './config/index.js';

// Re-export types from the types module for backward compatibility
export type { BaseToolArguments as ToolArguments } from './types/tool-types.js';

/** Log prefix for all log messages */
export const LOG_PREFIX = '[OMCP]';

/**
 * Error messages used throughout the application
 */
export const ERROR_MESSAGES = {
  QUOTA_EXCEEDED: 'quota exceeded',
  NO_PROMPT: 'Prompt is required. Use @filepath to include files or ask general questions.',
} as const;

/**
 * CLI configuration
 */
export const CLI = {
  COMMANDS: {},
  SUBCOMMANDS: {},
  FLAGS: {
    MODEL: '-m',
    AGENT: '--agent',
  },
} as const;

/**
 * MCP protocol configuration
 *
 * Note: KEEPALIVE_INTERVAL is now a getter that reads from config.
 * This allows runtime configuration changes while maintaining backward compatibility.
 */
export const PROTOCOL = {
  get KEEPALIVE_INTERVAL(): number {
    return config.get('timeouts').keepalive;
  },
  NOTIFICATIONS: { PROGRESS: 'notifications/progress' },
} as const;

/**
 * Logging configuration
 *
 * Environment variables:
 * - KEMDICODE_LOG_LEVEL: debug | info | warn | error (default: info)
 * - KEMDICODE_LOG_FORMAT: text | json (default: text)
 * - KEMDICODE_LOG_MEMORY: true | false (default: false)
 *
 * @example
 * ```bash
 * # Enable debug logging with JSON format
 * KEMDICODE_LOG_LEVEL=debug KEMDICODE_LOG_FORMAT=json node dist/index.js
 *
 * # Enable memory logging for performance debugging
 * KEMDICODE_LOG_LEVEL=debug KEMDICODE_LOG_MEMORY=true node dist/index.js
 * ```
 */
export const LOGGING = {
  /** Environment variable names */
  ENV_VARS: {
    /** Log level: debug, info, warn, error */
    LEVEL: 'KEMDICODE_LOG_LEVEL',
    /** Log format: text, json */
    FORMAT: 'KEMDICODE_LOG_FORMAT',
    /** Enable memory logging: true, false */
    MEMORY: 'KEMDICODE_LOG_MEMORY',
  },
  /** Default values */
  DEFAULTS: {
    LEVEL: 'info',
    FORMAT: 'text',
    MEMORY: false,
  },
  /** Log level numeric values for comparison */
  LEVELS: {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3,
  },
} as const;
