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
 * Delete Memory Tool
 *
 * Deletes a named memory entry for the current project.
 *
 * @module tools/memory/delete-memory
 */

import { z } from 'zod';
import { Redis } from 'ioredis';
import { createHash } from 'crypto';
import { UnifiedTool } from '../registry.js';
import { Logger } from '../../utils/logger.js';
import { checkRateLimit } from '../../utils/validation.js';

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
  name: z.string().min(1).describe('Memory name to delete'),
});

type DeleteMemoryArgs = z.infer<typeof schema>;

export const deleteMemoryTool: UnifiedTool = {
  name: 'delete-memory',
  description: 'Delete a named memory from the current project',
  zodSchema: schema,

  execute: async (args): Promise<string> => {
    const { name } = args as DeleteMemoryArgs;

    // Rate limit check
    if (!checkRateLimit('memory-operations', { maxRequests: 50, windowMs: 60000 })) {
      return JSON.stringify({
        success: false,
        error: 'Rate limit exceeded for memory operations',
        code: 'RATE_LIMIT_EXCEEDED',
      });
    }

    const projectId = getProjectId();
    const memoryKey = `${MEMORY_PREFIX}${projectId}:${name}`;
    const indexKey = `${MEMORY_INDEX_PREFIX}${projectId}`;

    try {
      const client = await getRedis();

      // Check if memory exists
      const exists = await client.exists(memoryKey);
      if (!exists) {
        return JSON.stringify({
          success: false,
          error: `Memory '${name}' not found`,
          code: 'MEMORY_NOT_FOUND',
          name,
          projectId,
        });
      }

      // Delete memory and remove from index
      await client.del(memoryKey);
      await client.srem(indexKey, name);

      Logger.debug(`delete-memory: deleted '${name}' from project ${projectId}`);

      return JSON.stringify({
        success: true,
        name,
        projectId,
        message: `Memory '${name}' deleted successfully`,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      Logger.error(`delete-memory error: ${errorMessage}`);

      return JSON.stringify({
        success: false,
        error: errorMessage,
        code: 'STORAGE_ERROR',
      });
    }
  },
};
