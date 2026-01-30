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
import { UnifiedTool } from '../registry.js';
import { Logger } from '../../utils/logger.js';
import { checkRateLimit } from '../../utils/validation.js';
import { type ProjectMemory, MEMORY_PREFIX, getRedis, getProjectId } from './shared.js';

const schema = z.object({
  names: z.array(z.string().min(1)).min(1).max(20).describe('Memory names to retrieve (1-20)'),
});

type ReadMemoryArgs = z.infer<typeof schema>;

export const readMemoryTool: UnifiedTool = {
  name: 'read-memory',
  description: 'Retrieve 1-20 named memories from current project.',
  zodSchema: schema,

  execute: async (args): Promise<string> => {
    const { names } = args as ReadMemoryArgs;

    if (!checkRateLimit('memory-operations', { maxRequests: 200, windowMs: 60000 })) {
      return JSON.stringify({
        success: false,
        error: 'Rate limit exceeded for memory operations',
        code: 'RATE_LIMIT_EXCEEDED',
      });
    }

    const projectId = getProjectId();

    try {
      const client = await getRedis();

      // Pipeline: fetch all memories at once
      const getPipeline = client.pipeline();
      const ttlPipeline = client.pipeline();
      for (const name of names) {
        const memoryKey = `${MEMORY_PREFIX}${projectId}:${name}`;
        getPipeline.get(memoryKey);
        ttlPipeline.ttl(memoryKey);
      }

      const getResults = await getPipeline.exec();
      const ttlResults = await ttlPipeline.exec();

      const results = names.map((name, i) => {
        const data = getResults?.[i]?.[1] as string | null;
        const ttl = (ttlResults?.[i]?.[1] as number) ?? -1;

        if (!data) {
          return {
            name,
            success: false,
            error: `Memory '${name}' not found`,
            code: 'MEMORY_NOT_FOUND',
          };
        }

        const memory = JSON.parse(data) as ProjectMemory;
        Logger.debug(`read-memory: retrieved '${name}' for project ${projectId}`);

        return {
          name: memory.name,
          success: true,
          content: memory.content,
          contentLength: memory.content.length,
          tags: memory.tags,
          createdAt: memory.createdAt,
          updatedAt: memory.updatedAt,
          ttlSeconds: ttl > 0 ? ttl : null,
          ttlDays: ttl > 0 ? Math.round(ttl / 86400) : null,
        };
      });

      const successful = results.filter((r) => r.success);
      const failed = results.filter((r) => !r.success);

      return JSON.stringify({
        success: failed.length === 0,
        projectId,
        found: successful.length,
        notFound: failed.length,
        results,
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
