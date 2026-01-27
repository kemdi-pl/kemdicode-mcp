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
 * List Memories Tool
 *
 * Lists all memory entries for the current project.
 *
 * @module tools/memory/list-memories
 */

import { z } from 'zod';
import { Redis } from 'ioredis';
import { createHash } from 'crypto';
import { UnifiedTool } from '../registry.js';
import { Logger } from '../../utils/logger.js';
import { checkRateLimit } from '../../utils/validation.js';

/** Memory entry structure */
interface ProjectMemory {
  name: string;
  projectId: string;
  content: string;
  createdAt: number;
  updatedAt: number;
  tags: string[];
}

/** Memory summary for listing */
interface MemorySummary {
  name: string;
  contentLength: number;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  ttlDays: number | null;
}

/** Redis key prefix for memories */
const MEMORY_PREFIX = 'mcp:memory:';
const MEMORY_INDEX_PREFIX = 'mcp:memory:index:';

/** Redis client (lazy init) */
let redis: Redis | null = null;

/**
 * Get or create Redis connection
 */
async function getRedis(): Promise<Redis> {
  if (!redis) {
    redis = new Redis({
      host: process.env.REDIS_HOST || '127.0.0.1',
      port: parseInt(process.env.REDIS_PORT || '6379'),
      password: process.env.REDIS_PASSWORD || undefined,
      db: 2,
      lazyConnect: true,
    });
    await redis.connect();
  }
  return redis;
}

/**
 * Generate project ID from current working directory
 */
function getProjectId(): string {
  const cwd = process.cwd();
  return createHash('sha256').update(cwd).digest('hex').slice(0, 16);
}

const schema = z.object({
  tag: z.string().optional().describe('Filter memories by tag'),
  limit: z.number().min(1).max(100).default(50).describe('Maximum memories to list'),
  includeContent: z.boolean().default(false).describe('Include memory content (can be large)'),
});

type ListMemoriesArgs = z.infer<typeof schema>;

export const listMemoriesTool: UnifiedTool = {
  name: 'list-memories',
  description: 'List all memories for the current project',
  zodSchema: schema,

  execute: async (args): Promise<string> => {
    const { tag, limit, includeContent } = args as ListMemoriesArgs;

    // Rate limit check
    if (!checkRateLimit('memory-operations', { maxRequests: 100, windowMs: 60000 })) {
      return JSON.stringify({
        success: false,
        error: 'Rate limit exceeded for memory operations',
        code: 'RATE_LIMIT_EXCEEDED',
      });
    }

    const projectId = getProjectId();
    const indexKey = `${MEMORY_INDEX_PREFIX}${projectId}`;

    try {
      const client = await getRedis();

      // Get all memory names from index
      const names = await client.smembers(indexKey);

      if (names.length === 0) {
        return JSON.stringify({
          success: true,
          projectId,
          count: 0,
          memories: [],
          message: 'No memories found for this project',
        });
      }

      // Fetch memory details
      const memories: MemorySummary[] = [];
      const memoriesWithContent: (MemorySummary & { content?: string })[] = [];

      for (const name of names) {
        if (memories.length >= limit) break;

        const memoryKey = `${MEMORY_PREFIX}${projectId}:${name}`;
        const data = await client.get(memoryKey);

        if (data) {
          try {
            const memory = JSON.parse(data) as ProjectMemory;

            // Filter by tag if specified
            if (tag && !memory.tags.includes(tag)) {
              continue;
            }

            const ttl = await client.ttl(memoryKey);
            const summary: MemorySummary = {
              name: memory.name,
              contentLength: memory.content.length,
              tags: memory.tags,
              createdAt: memory.createdAt,
              updatedAt: memory.updatedAt,
              ttlDays: ttl > 0 ? Math.round(ttl / 86400) : null,
            };

            memories.push(summary);

            if (includeContent) {
              memoriesWithContent.push({
                ...summary,
                content: memory.content,
              });
            }
          } catch {
            // Skip corrupted entries
            Logger.warn(`list-memories: skipping corrupted entry '${name}'`);
          }
        } else {
          // Memory expired or deleted, remove from index
          await client.srem(indexKey, name);
        }
      }

      // Sort by updatedAt descending
      memories.sort((a, b) => b.updatedAt - a.updatedAt);
      if (includeContent) {
        memoriesWithContent.sort((a, b) => b.updatedAt - a.updatedAt);
      }

      Logger.debug(`list-memories: found ${memories.length} memories for project ${projectId}`);

      return JSON.stringify({
        success: true,
        projectId,
        count: memories.length,
        filter: tag ? { tag } : null,
        memories: includeContent ? memoriesWithContent : memories,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      Logger.error(`list-memories error: ${errorMessage}`);

      return JSON.stringify({
        success: false,
        error: errorMessage,
        code: 'STORAGE_ERROR',
      });
    }
  },
};
