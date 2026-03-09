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
 * List Memories Tool
 *
 * Lists all memory entries for the current project.
 *
 * @module tools/memory/list-memories
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { Logger } from '../../utils/logger.js';
import { executeWithGuard } from '../tool-shared.js';
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
  offset: z.number().int().min(0).optional().default(0).describe('Number of items to skip (for pagination)'),
  limit: z.number().min(1).max(100).default(50).describe('Max memories to list'),
  includeContent: z.boolean().default(false).describe('Include content (can be large)'),
});

type ListMemoriesArgs = z.infer<typeof schema>;

export const listMemoriesTool: UnifiedTool = {
  name: 'list-memories',
  description:
    'List all memories for current project with optional tag filtering. ' +
    'Use when: discovering what knowledge is already stored before writing new memories.',
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
    const { tag, offset, limit, includeContent } = args as ListMemoriesArgs;

    return executeWithGuard('list-memories', 'memory-operations', async () => {
    const projectId = getProjectId();
    const indexKey = `${MEMORY_INDEX_PREFIX}${projectId}`;
      const client = await getRedis();

      // Get all memory names from index
      const names = await client.smembers(indexKey);

      if (names.length === 0) {
        return JSON.stringify({
          success: true,
          projectId,
          total: 0,
          offset,
          limit,
          hasMore: false,
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

      const allMemories: MemorySummary[] = [];
      const allMemoriesWithContent: (MemorySummary & { content?: string })[] = [];
      const staleNames: string[] = [];

      for (let i = 0; i < names.length; i++) {
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

          allMemories.push(summary);

          if (includeContent) {
            allMemoriesWithContent.push({
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
      allMemories.sort((a, b) => b.updatedAt - a.updatedAt);
      if (includeContent) {
        allMemoriesWithContent.sort((a, b) => b.updatedAt - a.updatedAt);
      }

      // Apply pagination after filtering and sorting
      const total = allMemories.length;
      const memories = allMemories.slice(offset, offset + limit);
      const memoriesWithContent = includeContent
        ? allMemoriesWithContent.slice(offset, offset + limit)
        : [];
      const hasMore = offset + limit < total;

      Logger.debug(`list-memories: found ${total} memories, returning ${memories.length} (offset=${offset}) for project ${projectId}`);

      // Silent mode: return names only (or names+tags in compact)
      if (isSilent()) {
        return JSON.stringify(memories.map((m) => ({ name: m.name, tags: m.tags })));
      }

      return JSON.stringify({
        success: true,
        projectId,
        total,
        offset,
        limit,
        hasMore,
        count: memories.length,
        filter: tag ? { tag } : null,
        memories: includeContent ? memoriesWithContent : memories,
      });
    });
  },
};
