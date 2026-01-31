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
import { UnifiedTool } from '../registry.js';
import { Logger } from '../../utils/logger.js';
import { checkRateLimit } from '../../utils/validation.js';
import { MEMORY_PREFIX, MEMORY_INDEX_PREFIX, getRedis, getProjectId } from './shared.js';

const schema = z.object({
  names: z.array(z.string().min(1)).min(1).max(20).describe('Memory names to delete (1-20)'),
});

type DeleteMemoryArgs = z.infer<typeof schema>;

export const deleteMemoryTool: UnifiedTool = {
  name: 'delete-memory',
  description: 'Delete 1-20 named memories from current project.',
  zodSchema: schema,
  metadata: {
    category: 'memory',
    tags: ['memory', 'delete'],
    examples: [
      { args: { names: ['old-context'] }, description: 'Delete a single memory entry' },
      { args: { names: ['temp-data', 'draft-plan', 'obsolete-notes'] }, description: 'Delete multiple memory entries at once' },
    ],
    relatedTools: ['write-memory', 'list-memories', 'read-memory'],
  },

  execute: async (args): Promise<string> => {
    const { names } = args as DeleteMemoryArgs;

    if (!checkRateLimit('memory-operations', { maxRequests: 50, windowMs: 60000 })) {
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

      // Pipeline: check existence
      const existsPipeline = client.pipeline();
      for (const name of names) {
        existsPipeline.exists(`${MEMORY_PREFIX}${projectId}:${name}`);
      }
      const existsResults = await existsPipeline.exec();

      // Pipeline: delete existing + remove from index
      const delPipeline = client.pipeline();
      const results = names.map((name, i) => {
        const exists = (existsResults?.[i]?.[1] as number) > 0;
        if (!exists) {
          return { name, success: false, error: `Memory '${name}' not found`, code: 'MEMORY_NOT_FOUND' };
        }
        delPipeline.del(`${MEMORY_PREFIX}${projectId}:${name}`);
        delPipeline.srem(indexKey, name);
        return { name, success: true };
      });

      if (results.some((r) => r.success)) {
        await delPipeline.exec();
      }

      for (const r of results) {
        if (r.success) {
          Logger.debug(`delete-memory: deleted '${r.name}' from project ${projectId}`);
        }
      }

      const successful = results.filter((r) => r.success);
      const failed = results.filter((r) => !r.success);

      return JSON.stringify({
        success: failed.length === 0,
        projectId,
        deleted: successful.length,
        notFound: failed.length,
        results,
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
