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

/** Maximum memory content size: 1MB */
const MAX_CONTENT_SIZE = 1024 * 1024;

const getRedis = getSharedRedis;

/**
 * Generate project ID from current working directory
 */
function getProjectId(): string {
  const cwd = process.cwd();
  return createHash('sha256').update(cwd).digest('hex').slice(0, 16);
}

const schema = z.object({
  name: z.string().min(1).describe('Memory name to edit'),
  content: z.string().optional().describe('New content (replaces existing)'),
  appendContent: z.string().optional().describe('Content to append to existing'),
  prependContent: z.string().optional().describe('Content to prepend to existing'),
  tags: z.array(z.string()).optional().describe('New tags (replaces existing)'),
  addTags: z.array(z.string()).optional().describe('Tags to add'),
  removeTags: z.array(z.string()).optional().describe('Tags to remove'),
});

type EditMemoryArgs = z.infer<typeof schema>;

export const editMemoryTool: UnifiedTool = {
  name: 'edit-memory',
  description: 'Edit an existing memory (update content, append, modify tags)',
  zodSchema: schema,

  execute: async (args): Promise<string> => {
    const { name, content, appendContent, prependContent, tags, addTags, removeTags } =
      args as EditMemoryArgs;

    // Rate limit check
    if (!checkRateLimit('memory-operations', { maxRequests: 50, windowMs: 60000 })) {
      return JSON.stringify({
        success: false,
        error: 'Rate limit exceeded for memory operations',
        code: 'RATE_LIMIT_EXCEEDED',
      });
    }

    // Check if any edit is requested
    if (!content && !appendContent && !prependContent && !tags && !addTags && !removeTags) {
      return JSON.stringify({
        success: false,
        error: 'No edit operations specified',
        code: 'NO_EDITS',
      });
    }

    const projectId = getProjectId();
    const memoryKey = `${MEMORY_PREFIX}${projectId}:${name}`;

    try {
      const client = await getRedis();

      // Get existing memory
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

      // Track changes
      const changes: string[] = [];

      // Update content
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

      // Check content size
      if (newContent.length > MAX_CONTENT_SIZE) {
        return JSON.stringify({
          success: false,
          error: `Content too large: ${newContent.length} bytes (max: ${MAX_CONTENT_SIZE} bytes)`,
          code: 'CONTENT_TOO_LARGE',
        });
      }

      // Update tags
      let newTags = memory.tags;
      if (tags !== undefined) {
        newTags = tags;
        changes.push('tags replaced');
      }
      if (addTags && addTags.length > 0) {
        const added = addTags.filter((t) => !newTags.includes(t));
        newTags = [...newTags, ...added];
        if (added.length > 0) {
          changes.push(`added tags: ${added.join(', ')}`);
        }
      }
      if (removeTags && removeTags.length > 0) {
        const removed = removeTags.filter((t) => newTags.includes(t));
        newTags = newTags.filter((t) => !removeTags.includes(t));
        if (removed.length > 0) {
          changes.push(`removed tags: ${removed.join(', ')}`);
        }
      }

      // Update memory
      const updatedMemory: ProjectMemory = {
        ...memory,
        content: newContent,
        tags: newTags,
        updatedAt: Date.now(),
      };

      // Save with preserved TTL
      if (ttl > 0) {
        await client.setex(memoryKey, ttl, JSON.stringify(updatedMemory));
      } else {
        await client.set(memoryKey, JSON.stringify(updatedMemory));
      }

      Logger.debug(
        `edit-memory: updated '${name}' for project ${projectId}: ${changes.join(', ')}`
      );

      return JSON.stringify({
        success: true,
        name,
        projectId,
        changes,
        contentLength: newContent.length,
        tags: newTags,
        updatedAt: updatedMemory.updatedAt,
        ttlDays: ttl > 0 ? Math.round(ttl / 86400) : null,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      Logger.error(`edit-memory error: ${errorMessage}`);

      return JSON.stringify({
        success: false,
        error: errorMessage,
        code: 'STORAGE_ERROR',
      });
    }
  },
};
