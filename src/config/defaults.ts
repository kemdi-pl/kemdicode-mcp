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
 * Configuration Defaults
 *
 * All default values in one place. These can be overridden by
 * environment variables or CLI arguments.
 *
 * @module config/defaults
 */

import type { AppConfig } from './types.js';

/**
 * Default configuration values
 */
export const DEFAULT_CONFIG: AppConfig = {
  server: {
    port: 3100,
    host: '127.0.0.1',
    primaryModel: '', // Set via CLI: --model or env: KEMDICODE_SERVER_MODEL
    fallbackModel: '', // Set via CLI: --fallback-model or env: KEMDICODE_SERVER_FALLBACK_MODEL
    apiBaseUrl: '', // Set via ai-config tool or env: KEMDICODE_SERVER_API_BASE_URL
    apiKey: '', // Set via project config or env: KEMDICODE_SERVER_API_KEY
  },

  redis: {
    host: '127.0.0.1',
    port: 6379,
    db: 2, // MCP context database (avoid Laravel cache db 1)
    password: undefined,
  },

  timeouts: {
    command: 300_000, // 5 min
    short: 120_000, // 2 min
    long: 600_000, // 10 min
    keepalive: 25_000, // 25s
    forceKill: 5_000, // 5s
    safeExec: 5_000, // 5s
  },

  cache: {
    maxEntries: 1_000,
    defaultTtl: 5 * 60 * 1_000, // 5 min
    gitSize: 500,
    gitTtl: 2 * 60 * 1_000, // 2 min
    fsSize: 1_000,
    fsTtl: 60 * 1_000, // 1 min
    projectSize: 100,
    projectTtl: 5 * 60 * 1_000, // 5 min
  },

  session: {
    activeTtl: 7_200, // 2 hours (seconds)
    idleTtl: 1_800, // 30 min (seconds)
    cleanupInterval: 300, // 5 min (seconds)
  },

  context: {
    schema: 3_600, // 1 hour (seconds)
    apiDocs: 1_800, // 30 min (seconds)
    query: 600, // 10 min (seconds)
    analysis: 1_800, // 30 min (seconds)
    session: 7_200, // 2 hours (seconds)
    default: 3_600, // 1 hour (seconds)
  },

  limits: {
    maxFileSize: 5 * 1024 * 1024, // 5 MB
    maxDiffBuffer: 10 * 1024 * 1024, // 10 MB
    maxBuffer: 10 * 1024 * 1024, // 10 MB
    binarySampleSize: 8_192, // 8 KB
  },

  retry: {
    maxAttempts: 3,
    baseDelay: 100, // ms
    maxDelay: 1_000, // ms
  },

  rl: {
    maxHistorySize: 1_000,
    historyTtl: 3_600, // 1 hour (seconds)
    maxSignals: 500,
    signalTtl: 3_600, // 1 hour (seconds)
    rewardHistoryTtl: 7_200, // 2 hours (seconds)
  },

  loci: {
    nodeTtl: 7_200, // 2 hours (seconds)
    edgeTtl: 7_200, // 2 hours (seconds)
  },

  providers: {
    defaultProvider: 'openai',
    openai: {},
    anthropic: {},
    gemini: {},
    groq: {},
    deepseek: {},
    ollama: {},
    openrouter: {},
  },
};
