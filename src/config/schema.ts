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
 * Configuration Schema
 *
 * Zod validation schemas for all configuration groups.
 *
 * @module config/schema
 */

import { z } from 'zod';

/** Server config schema */
export const serverSchema = z.object({
  port: z.number().int().min(1).max(65535).describe('HTTP server port'),
  host: z.string().min(1).describe('HTTP server host'),
  primaryModel: z.string().describe('Primary AI model (set via CLI or env)'),
  fallbackModel: z.string().describe('Fallback model for quota exceeded (optional)'),
  apiBaseUrl: z.string().url().optional().describe('AI API base URL for hot-reload'),
  apiKey: z.string().optional().describe('AI API key'),
});

/** Redis config schema */
export const redisSchema = z.object({
  host: z.string().min(1).describe('Redis host'),
  port: z.number().int().min(1).max(65535).describe('Redis port'),
  db: z.number().int().min(0).max(15).describe('Redis database number'),
  password: z.string().optional().describe('Redis password'),
});

/** Timeout config schema */
export const timeoutsSchema = z.object({
  command: z.number().int().min(1000).describe('Default command timeout in ms'),
  short: z.number().int().min(1000).describe('Short operation timeout in ms'),
  long: z.number().int().min(1000).describe('Long operation timeout in ms'),
  keepalive: z.number().int().min(1000).describe('SSE keepalive interval in ms'),
  forceKill: z.number().int().min(1000).describe('Force kill delay after SIGTERM in ms'),
  safeExec: z.number().int().min(1000).describe('Safe exec default timeout in ms'),
});

/** Cache config schema */
export const cacheSchema = z.object({
  maxEntries: z.number().int().min(10).describe('Default max entries'),
  defaultTtl: z.number().int().min(1000).describe('Default TTL in ms'),
  gitSize: z.number().int().min(10).describe('Git cache max entries'),
  gitTtl: z.number().int().min(1000).describe('Git cache TTL in ms'),
  fsSize: z.number().int().min(10).describe('FS cache max entries'),
  fsTtl: z.number().int().min(1000).describe('FS cache TTL in ms'),
  projectSize: z.number().int().min(10).describe('Project cache max entries'),
  projectTtl: z.number().int().min(1000).describe('Project cache TTL in ms'),
});

/** Session config schema */
export const sessionSchema = z.object({
  activeTtl: z.number().int().min(60).describe('Active session TTL in seconds'),
  idleTtl: z.number().int().min(60).describe('Idle session timeout in seconds'),
  cleanupInterval: z.number().int().min(10).describe('Cleanup check interval in seconds'),
});

/** Context TTL config schema */
export const contextSchema = z.object({
  schema: z.number().int().min(60).describe('Schema TTL in seconds'),
  apiDocs: z.number().int().min(60).describe('API docs TTL in seconds'),
  query: z.number().int().min(60).describe('Query TTL in seconds'),
  analysis: z.number().int().min(60).describe('Analysis TTL in seconds'),
  session: z.number().int().min(60).describe('Session TTL in seconds'),
  default: z.number().int().min(60).describe('Default TTL in seconds'),
});

/** Limits config schema */
export const limitsSchema = z.object({
  maxFileSize: z.number().int().min(1024).describe('Max file size for reading in bytes'),
  maxDiffBuffer: z.number().int().min(1024).describe('Max diff buffer size in bytes'),
  maxBuffer: z.number().int().min(1024).describe('Max git output buffer in bytes'),
  binarySampleSize: z.number().int().min(512).describe('Binary sample size for detection in bytes'),
});

/** Retry config schema */
export const retrySchema = z.object({
  maxAttempts: z.number().int().min(1).describe('Max retry attempts'),
  baseDelay: z.number().int().min(10).describe('Base delay in ms'),
  maxDelay: z.number().int().min(100).describe('Max delay in ms'),
});

/** RL config schema */
export const rlSchema = z.object({
  maxHistorySize: z.number().int().min(10).describe('Max state history entries'),
  historyTtl: z.number().int().min(60).describe('State history TTL in seconds'),
  maxSignals: z.number().int().min(10).describe('Max dopamine signals'),
  signalTtl: z.number().int().min(60).describe('Dopamine signal TTL in seconds'),
  rewardHistoryTtl: z.number().int().min(60).describe('Reward history TTL in seconds'),
});

/** Loci config schema */
export const lociSchema = z.object({
  nodeTtl: z.number().int().min(60).describe('Graph node TTL in seconds'),
  edgeTtl: z.number().int().min(60).describe('Graph edge TTL in seconds'),
});

/** Provider entry schema */
const providerEntrySchema = z.object({
  apiKey: z.string().optional().describe('API key for this provider'),
  baseURL: z.string().url().optional().describe('Custom base URL override'),
  enabled: z.boolean().optional().describe('Whether this provider is enabled'),
});

/** Providers config schema */
export const providersSchema = z.object({
  defaultProvider: z
    .enum(['openai', 'anthropic', 'gemini', 'groq', 'deepseek', 'ollama', 'openrouter'])
    .describe('Default provider when no prefix'),
  openai: providerEntrySchema.describe('OpenAI configuration'),
  anthropic: providerEntrySchema.describe('Anthropic configuration'),
  gemini: providerEntrySchema.describe('Google Gemini configuration'),
  groq: providerEntrySchema.describe('Groq configuration'),
  deepseek: providerEntrySchema.describe('DeepSeek configuration'),
  ollama: providerEntrySchema.describe('Ollama configuration'),
  openrouter: providerEntrySchema.describe('OpenRouter configuration'),
});

/** Complete app config schema */
export const appConfigSchema = z.object({
  server: serverSchema,
  redis: redisSchema,
  timeouts: timeoutsSchema,
  cache: cacheSchema,
  session: sessionSchema,
  context: contextSchema,
  limits: limitsSchema,
  retry: retrySchema,
  rl: rlSchema,
  loci: lociSchema,
  providers: providersSchema,
});

/** Schema map for individual group validation */
export const groupSchemas = {
  server: serverSchema,
  redis: redisSchema,
  timeouts: timeoutsSchema,
  cache: cacheSchema,
  session: sessionSchema,
  context: contextSchema,
  limits: limitsSchema,
  retry: retrySchema,
  rl: rlSchema,
  loci: lociSchema,
  providers: providersSchema,
} as const;
