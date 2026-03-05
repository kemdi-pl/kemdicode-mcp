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
 * Configuration Types
 *
 * TypeScript interfaces for all configuration groups.
 *
 * @module config/types
 */

/** Server configuration */
export interface ServerConfig {
  /** HTTP server port */
  port: number;
  /** HTTP server host */
  host: string;
  /** Primary AI model */
  primaryModel: string;
  /** Fallback model for quota exceeded */
  fallbackModel: string;
  /** AI API base URL for hot-reload (optional) */
  apiBaseUrl?: string;
  /** AI API key (optional) */
  apiKey?: string;
}

/** Redis configuration */
export interface RedisConfig {
  /** Redis host */
  host: string;
  /** Redis port */
  port: number;
  /** Redis database number */
  db: number;
  /** Redis password (optional) */
  password?: string;
}

/** Timeout configuration in milliseconds */
export interface TimeoutConfig {
  /** Default command timeout (5 min) */
  command: number;
  /** Short operation timeout (2 min) */
  short: number;
  /** Long operation timeout (10 min) */
  long: number;
  /** SSE keepalive interval */
  keepalive: number;
  /** Force kill delay after SIGTERM */
  forceKill: number;
  /** Safe exec default timeout */
  safeExec: number;
}

/** Cache configuration */
export interface CacheConfig {
  /** Default max entries */
  maxEntries: number;
  /** Default TTL in ms */
  defaultTtl: number;
  /** Git cache max entries */
  gitSize: number;
  /** Git cache TTL in ms */
  gitTtl: number;
  /** FS cache max entries */
  fsSize: number;
  /** FS cache TTL in ms */
  fsTtl: number;
  /** Project cache max entries */
  projectSize: number;
  /** Project cache TTL in ms */
  projectTtl: number;
}

/** Session configuration in seconds */
export interface SessionConfig {
  /** Active session TTL */
  activeTtl: number;
  /** Idle session timeout */
  idleTtl: number;
  /** Cleanup check interval */
  cleanupInterval: number;
}

/** Context TTL configuration in seconds */
export interface ContextTtlConfig {
  /** Schema TTL */
  schema: number;
  /** API docs TTL */
  apiDocs: number;
  /** Query TTL */
  query: number;
  /** Analysis TTL */
  analysis: number;
  /** Session TTL */
  session: number;
  /** Default TTL */
  default: number;
}

/** File/buffer limits */
export interface LimitsConfig {
  /** Max file size for reading (bytes) */
  maxFileSize: number;
  /** Max diff buffer size (bytes) */
  maxDiffBuffer: number;
  /** Max git output buffer (bytes) */
  maxBuffer: number;
  /** Binary sample size for detection (bytes) */
  binarySampleSize: number;
}

/** Retry configuration */
export interface RetryConfig {
  /** Max retry attempts */
  maxAttempts: number;
  /** Base delay in ms */
  baseDelay: number;
  /** Max delay in ms */
  maxDelay: number;
}

/** RL (Reinforcement Learning) configuration */
export interface RlConfig {
  /** Max state history entries */
  maxHistorySize: number;
  /** State history TTL in seconds */
  historyTtl: number;
  /** Max dopamine signals */
  maxSignals: number;
  /** Dopamine signal TTL in seconds */
  signalTtl: number;
  /** Reward history TTL in seconds */
  rewardHistoryTtl: number;
}

/** Loci/Graph configuration */
export interface LociConfig {
  /** Graph node TTL in seconds */
  nodeTtl: number;
  /** Graph edge TTL in seconds */
  edgeTtl: number;
}

/** Single provider entry configuration */
export interface ProviderEntry {
  /** API key for this provider */
  apiKey?: string;
  /** Custom base URL override */
  baseURL?: string;
  /** Whether this provider is enabled */
  enabled?: boolean;
}

/** Multi-provider configuration */
export interface ProvidersConfig {
  /** Default provider when no prefix is specified */
  defaultProvider: string;
  /** Per-provider settings */
  openai: ProviderEntry;
  anthropic: ProviderEntry;
  gemini: ProviderEntry;
  groq: ProviderEntry;
  deepseek: ProviderEntry;
  ollama: ProviderEntry;
  openrouter: ProviderEntry;
  perplexity: ProviderEntry;
  /** Allow dynamic provider access */
  [key: string]: string | ProviderEntry;
}

/** Complete application configuration */
export interface AppConfig {
  server: ServerConfig;
  redis: RedisConfig;
  timeouts: TimeoutConfig;
  cache: CacheConfig;
  session: SessionConfig;
  context: ContextTtlConfig;
  limits: LimitsConfig;
  retry: RetryConfig;
  rl: RlConfig;
  loci: LociConfig;
  providers: ProvidersConfig;
}

/** Config group names */
export type ConfigGroup = keyof AppConfig;

/** All config group names as array */
export const CONFIG_GROUPS: ConfigGroup[] = [
  'server',
  'redis',
  'timeouts',
  'cache',
  'session',
  'context',
  'limits',
  'retry',
  'rl',
  'loci',
  'providers',
];
