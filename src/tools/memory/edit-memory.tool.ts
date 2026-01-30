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
 * Edit Memory Tool
 *
 * Modifies an existing memory entry for the current project.
 * Supports replacing content, appending content, and updating tags.
 *
 * @module tools/memory/edit-memory
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { Logger } from '../../utils/logger.js';
import { checkRateLimit } from '../../utils/validation.js';
import {
  type ProjectMemory,
  MEMORY_PREFIX,
  MAX_CONTENT_SIZE,
  getRedis,
  getProjectId,
} from './shared.js';

const editItemSchema = z.object({
  name: z.string().min(1).describe('Memory name'),
  content: z.string().optional().describe('Replacement content'),
  appendContent: z.string().optional().describe('Content to append'),
  prependContent: z.string().optional().describe('Content to prepend'),
  tags: z.array(z.string()).optional().describe('Replacement tags'),
  addTags: z.array(z.string()).optional().describe('Tags to add'),
  removeTags: z.array(z.string()).optional().describe('Tags to remove'),
});

const schema = z.object({
  edits: z.array(editItemSchema).min(1).max(10).describe('Memory edits to apply (1-10)'),
});

type EditMemoryArgs = z.infer<typeof schema>;

export const editMemoryTool: UnifiedTool = {
  name: 'edit-memory',
  description: 'Edit 1-10 existing memories (content/tags). Returns results.',
  zodSchema: schema,

  execute: async (args): Promise<string> => {
    const { edits } = args as unknown as EditMemoryArgs;

    if (!checkRateLimit('memory-operations', { maxRequests: 50, windowMs: 60000 })) {
      return JSON.stringify({
        success: false,
        error: 'Rate limit exceeded for memory operations',
        code: 'RATE_LIMIT_EXCEEDED',
      });
    }

    const projectId = getProjectId();

    const results = await Promise.all(
      edits.map(async (item) => {
        try {
          const { name, content, appendContent, prependContent, tags, addTags, removeTags } = item;

          if (!content && !appendContent && !prependContent && !tags && !addTags && !removeTags) {
            return { name, success: false, error: 'No edit operations specified', code: 'NO_EDITS' };
          }

          const memoryKey = `${MEMORY_PREFIX}${projectId}:${name}`;
          const client = await getRedis();

          const data = await client.get(memoryKey);
          if (!data) {
            return { name, success: false, error: `Memory '${name}' not found`, code: 'MEMORY_NOT_FOUND' };
          }

          const memory = JSON.parse(data) as ProjectMemory;
          const ttl = await client.ttl(memoryKey);
          const changes: string[] = [];

          let newContent = memory.content;
          if (content !== undefined) {
            newContent = content;
            changes.push('content replaced');
          }
          if (prependContent) {
            newContent = prependContent + newContent;
            changes.push(`prepended ${prependContent.length} chars`);
          }
          if (appendContent) {
            newContent = newContent + appendContent;
            changes.push(`appended ${appendContent.length} chars`);
          }

          if (newContent.length > MAX_CONTENT_SIZE) {
            return { name, success: false, error: 'Content too large', code: 'CONTENT_TOO_LARGE' };
          }

          let newTags = memory.tags;
          if (tags !== undefined) {
            newTags = tags;
            changes.push('tags replaced');
          }
          if (addTags && addTags.length > 0) {
            const added = addTags.filter((t) => !newTags.includes(t));
            newTags = [...newTags, ...added];
            if (added.length > 0) changes.push(`added tags: ${added.join(', ')}`);
          }
          if (removeTags && removeTags.length > 0) {
            const removed = removeTags.filter((t) => newTags.includes(t));
            newTags = newTags.filter((t) => !removeTags.includes(t));
            if (removed.length > 0) changes.push(`removed tags: ${removed.join(', ')}`);
          }

          const updatedMemory: ProjectMemory = {
            ...memory,
            content: newContent,
            tags: newTags,
            updatedAt: Date.now(),
          };

          if (ttl > 0) {
            await client.setex(memoryKey, ttl, JSON.stringify(updatedMemory));
          } else {
            await client.set(memoryKey, JSON.stringify(updatedMemory));
          }

          Logger.debug(`edit-memory: updated '${name}': ${changes.join(', ')}`);

          return {
            name,
            success: true,
            changes,
            contentLength: newContent.length,
            tags: newTags,
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

    return JSON.stringify({
      success: failed.length === 0,
      projectId,
      edited: successful.length,
      failed: failed.length,
      results,
    });
  },
};
