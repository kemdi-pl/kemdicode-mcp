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
 * Write Memory Tool
 *
 * Stores a named memory entry for the current project.
 * Memories persist across sessions and can be retrieved later.
 *
 * @module tools/memory/write-memory
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { Logger } from '../../utils/logger.js';
import { checkRateLimit } from '../../utils/validation.js';
import {
  type ProjectMemory,
  MEMORY_PREFIX,
  MEMORY_INDEX_PREFIX,
  DEFAULT_MEMORY_TTL,
  MAX_CONTENT_SIZE,
  getRedis,
  getProjectId,
  getExistingCreatedAt,
} from './shared.js';
import { isSilent } from '../../config/silent.js';

const memoryItemSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-zA-Z0-9_-]+$/, 'Name must be alphanumeric with dashes/underscores')
    .describe('Memory name'),
  content: z.string().min(1).describe('Content to store'),
  tags: z.array(z.string()).default([]).describe('Tags for categorization'),
  overwrite: z.boolean().default(false).describe('Overwrite if exists'),
  ttlDays: z.number().min(1).max(365).default(30).describe('TTL in days'),
});

const baseSchema = z.object({
  memories: z.array(memoryItemSchema).min(1).max(20).describe('Memories to store (1-20)'),
});

/**
 * Accepts both array format { memories: [...] } and shorthand { name, content, tags?, overwrite?, ttlDays? }.
 * The shorthand is normalized to array format before validation.
 */
const schema = z.preprocess((input) => {
  if (typeof input === 'object' && input !== null && 'name' in input && !('memories' in input)) {
    const { name, content, tags, overwrite, ttlDays } = input as Record<string, unknown>;
    return {
      memories: [{ name, content, tags, overwrite, ttlDays }],
    };
  }
  return input;
}, baseSchema);

type WriteMemoryArgs = z.infer<typeof schema>;

export const writeMemoryTool: UnifiedTool = {
  name: 'write-memory',
  description: 'Store 1-20 named memories for current project. Returns results.',
  zodSchema: schema,
  metadata: {
    category: 'memory',
    tags: ['memory', 'write', 'store'],
    examples: [
      { args: { name: 'active-session', content: 'session-id: abc123', tags: ['session'] }, description: 'Store a named memory (shorthand)' },
      { args: { memories: [{ name: 'api-schema', content: '{"endpoints":[]}', tags: ['api'], ttlDays: 7 }] }, description: 'Store memory with custom TTL' },
    ],
    relatedTools: ['read-memory', 'list-memories', 'edit-memory'],
  },

  execute: async (args): Promise<string> => {
    const { memories } = args as unknown as WriteMemoryArgs;

    if (!checkRateLimit('memory-operations', { maxRequests: 100, windowMs: 60000 })) {
      return JSON.stringify({
        success: false,
        error: 'Rate limit exceeded for memory operations',
        code: 'RATE_LIMIT_EXCEEDED',
      });
    }

    const projectId = getProjectId();
    const indexKey = `${MEMORY_INDEX_PREFIX}${projectId}`;

    const results = await Promise.all(
      memories.map(async (item) => {
        try {
          if (item.content.length > MAX_CONTENT_SIZE) {
            return {
              name: item.name,
              success: false,
              error: `Content too large: ${item.content.length} bytes`,
              code: 'CONTENT_TOO_LARGE',
            };
          }

          const memoryKey = `${MEMORY_PREFIX}${projectId}:${item.name}`;
          const client = await getRedis();

          const existing = await client.exists(memoryKey);
          if (existing && !item.overwrite) {
            return {
              name: item.name,
              success: false,
              error: `Memory '${item.name}' already exists`,
              code: 'MEMORY_EXISTS',
            };
          }

          const now = Date.now();
          const memory: ProjectMemory = {
            name: item.name,
            projectId,
            content: item.content,
            createdAt: existing ? ((await getExistingCreatedAt(client, memoryKey)) ?? now) : now,
            updatedAt: now,
            tags: item.tags,
          };

          const ttl = item.ttlDays * 24 * 60 * 60;
          await client.setex(memoryKey, ttl, JSON.stringify(memory));
          await client.sadd(indexKey, item.name);
          await client.expire(indexKey, DEFAULT_MEMORY_TTL);

          Logger.debug(`write-memory: stored '${item.name}' for project ${projectId}`);

          return {
            name: item.name,
            success: true,
            contentLength: item.content.length,
            tags: item.tags,
            ttlDays: item.ttlDays,
            overwritten: existing > 0,
          };
        } catch (error) {
          return {
            name: item.name,
            success: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      })
    );

    const successful = results.filter((r) => r.success);
    const failed = results.filter((r) => !r.success);

    // Silent mode: return only names
    if (isSilent()) {
      if (failed.length > 0) {
        return JSON.stringify({ stored: successful.map((r) => r.name), errors: failed.map((r) => r.error) });
      }
      return JSON.stringify(successful.map((r) => r.name));
    }

    return JSON.stringify({
      success: failed.length === 0,
      projectId,
      stored: successful.length,
      failed: failed.length,
      results,
    });
  },
};

