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
 * Read Memory Tool
 *
 * Retrieves a named memory entry for the current project.
 *
 * @module tools/memory/read-memory
 */

import { z } from 'zod';
import { getSharedRedis } from '../../infrastructure/redis/connection.js';
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

/** Redis key prefix for memories */
const MEMORY_PREFIX = 'mcp:memory:';

const getRedis = getSharedRedis;
/**
 * Generate project ID from current working directory
 */
function getProjectId(): string {
  const cwd = process.cwd();
  return createHash('sha256').update(cwd).digest('hex').slice(0, 16);
}

const schema = z.object({
  name: z.string().min(1).describe('Memory name to retrieve'),
});

type ReadMemoryArgs = z.infer<typeof schema>;

export const readMemoryTool: UnifiedTool = {
  name: 'read-memory',
  description: 'Retrieve a named memory from the current project',
  zodSchema: schema,

  execute: async (args): Promise<string> => {
    const { name } = args as ReadMemoryArgs;

    // Rate limit check
    if (!checkRateLimit('memory-operations', { maxRequests: 200, windowMs: 60000 })) {
      return JSON.stringify({
        success: false,
        error: 'Rate limit exceeded for memory operations',
        code: 'RATE_LIMIT_EXCEEDED',
      });
    }

    const projectId = getProjectId();
    const memoryKey = `${MEMORY_PREFIX}${projectId}:${name}`;

    try {
      const client = await getRedis();

      const data = await client.get(memoryKey);
      if (!data) {
        return JSON.stringify({
          success: false,
          error: `Memory '${name}' not found`,
          code: 'MEMORY_NOT_FOUND',
          name,
          projectId,
        });
      }

      const memory = JSON.parse(data) as ProjectMemory;
      const ttl = await client.ttl(memoryKey);

      Logger.debug(`read-memory: retrieved '${name}' for project ${projectId}`);

      return JSON.stringify({
        success: true,
        name: memory.name,
        projectId: memory.projectId,
        content: memory.content,
        contentLength: memory.content.length,
        tags: memory.tags,
        createdAt: memory.createdAt,
        updatedAt: memory.updatedAt,
        ttlSeconds: ttl > 0 ? ttl : null,
        ttlDays: ttl > 0 ? Math.round(ttl / 86400) : null,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      Logger.error(`read-memory error: ${errorMessage}`);

      return JSON.stringify({
        success: false,
        error: errorMessage,
        code: 'STORAGE_ERROR',
      });
    }
  },
};
