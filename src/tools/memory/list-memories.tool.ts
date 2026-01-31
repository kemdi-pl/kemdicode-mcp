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
import { UnifiedTool } from '../registry.js';
import { Logger } from '../../utils/logger.js';
import { checkRateLimit } from '../../utils/validation.js';
import {
  type ProjectMemory,
  MEMORY_PREFIX,
  MEMORY_INDEX_PREFIX,
  getRedis,
  getProjectId,
} from './shared.js';
import { isSilent } from '../../config/silent.js';

/** Memory summary for listing */
interface MemorySummary {
  name: string;
  contentLength: number;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  ttlDays: number | null;
}

const schema = z.object({
  tag: z.string().optional().describe('Filter by tag'),
  limit: z.number().min(1).max(100).default(50).describe('Max memories to list'),
  includeContent: z.boolean().default(false).describe('Include content (can be large)'),
});

type ListMemoriesArgs = z.infer<typeof schema>;

export const listMemoriesTool: UnifiedTool = {
  name: 'list-memories',
  description: 'List all memories for current project',
  zodSchema: schema,
  metadata: {
    category: 'memory',
    tags: ['memory', 'list', 'search'],
    examples: [
      { args: {}, description: 'List all memories for the current project' },
      { args: { tag: 'session', includeContent: true }, description: 'List memories tagged with session, including content' },
    ],
    relatedTools: ['read-memory', 'write-memory'],
  },

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

      // Fetch all memory data + TTLs in two pipeline batches (avoid N+1)
      const memoryKeys = names.map((name) => `${MEMORY_PREFIX}${projectId}:${name}`);

      const getPipeline = client.pipeline();
      for (const key of memoryKeys) {
        getPipeline.get(key);
      }
      const getResults = await getPipeline.exec();

      const ttlPipeline = client.pipeline();
      for (const key of memoryKeys) {
        ttlPipeline.ttl(key);
      }
      const ttlResults = await ttlPipeline.exec();

      const memories: MemorySummary[] = [];
      const memoriesWithContent: (MemorySummary & { content?: string })[] = [];
      const staleNames: string[] = [];

      for (let i = 0; i < names.length; i++) {
        if (memories.length >= limit) break;

        const [getErr, data] = (getResults?.[i] ?? [null, null]) as [Error | null, string | null];
        const [ttlErr, ttl] = (ttlResults?.[i] ?? [null, -1]) as [Error | null, number];

        if (getErr || !data) {
          // Memory expired or deleted, mark for index cleanup
          staleNames.push(names[i]);
          continue;
        }

        try {
          const memory = JSON.parse(data) as ProjectMemory;

          // Filter by tag if specified
          if (tag && !memory.tags.includes(tag)) {
            continue;
          }

          const ttlValue = ttlErr ? null : ttl;
          const summary: MemorySummary = {
            name: memory.name,
            contentLength: memory.content.length,
            tags: memory.tags,
            createdAt: memory.createdAt,
            updatedAt: memory.updatedAt,
            ttlDays: ttlValue && ttlValue > 0 ? Math.round(ttlValue / 86400) : null,
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
          Logger.warn(`list-memories: skipping corrupted entry '${names[i]}'`);
        }
      }

      // Cleanup stale index entries
      if (staleNames.length > 0) {
        const cleanupPipeline = client.pipeline();
        for (const name of staleNames) {
          cleanupPipeline.srem(indexKey, name);
        }
        await cleanupPipeline.exec();
      }

      // Sort by updatedAt descending
      memories.sort((a, b) => b.updatedAt - a.updatedAt);
      if (includeContent) {
        memoriesWithContent.sort((a, b) => b.updatedAt - a.updatedAt);
      }

      Logger.debug(`list-memories: found ${memories.length} memories for project ${projectId}`);

      // Silent mode: return names only (or names+tags in compact)
      if (isSilent()) {
        return JSON.stringify(memories.map((m) => ({ name: m.name, tags: m.tags })));
      }

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
