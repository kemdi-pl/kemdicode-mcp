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
import type { Redis } from 'ioredis';
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
const MEMORY_INDEX_PREFIX = 'mcp:memory:index:';

/** Default TTL: 30 days in seconds */
const DEFAULT_TTL = 30 * 24 * 60 * 60;

/** Maximum memory content size: 1MB */
const MAX_CONTENT_SIZE = 1024 * 1024;

const getRedis = getSharedRedis;
/**
 * Generate a unique project identifier from current working directory
 *
 * @description Creates a SHA-256 hash of the CWD, truncated to 16 characters.
 *              This ensures memories are scoped to specific projects.
 * @returns {string} 16-character hex string project identifier
 * @internal
 */
function getProjectId(): string {
  const cwd = process.cwd();
  return createHash('sha256').update(cwd).digest('hex').slice(0, 16);
}

const schema = z.object({
  name: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-zA-Z0-9_-]+$/, 'Name must be alphanumeric with dashes/underscores')
    .describe('Memory name (unique per project, alphanumeric with dashes/underscores)'),
  content: z.string().min(1).describe('Memory content to store'),
  tags: z.array(z.string()).default([]).describe('Tags for categorization'),
  overwrite: z.boolean().default(false).describe('Overwrite if memory already exists'),
  ttlDays: z.number().min(1).max(365).default(30).describe('Time-to-live in days'),
});

type WriteMemoryArgs = z.infer<typeof schema>;

export const writeMemoryTool: UnifiedTool = {
  name: 'write-memory',
  description: 'Store a named memory for the current project (persists across sessions)',
  zodSchema: schema,

  execute: async (args): Promise<string> => {
    const { name, content, tags, overwrite, ttlDays } = args as WriteMemoryArgs;

    // Rate limit check
    if (!checkRateLimit('memory-operations', { maxRequests: 100, windowMs: 60000 })) {
      return JSON.stringify({
        success: false,
        error: 'Rate limit exceeded for memory operations',
        code: 'RATE_LIMIT_EXCEEDED',
      });
    }

    // Check content size
    if (content.length > MAX_CONTENT_SIZE) {
      return JSON.stringify({
        success: false,
        error: `Content too large: ${content.length} bytes (max: ${MAX_CONTENT_SIZE} bytes)`,
        code: 'CONTENT_TOO_LARGE',
      });
    }

    const projectId = getProjectId();
    const memoryKey = `${MEMORY_PREFIX}${projectId}:${name}`;
    const indexKey = `${MEMORY_INDEX_PREFIX}${projectId}`;

    try {
      const client = await getRedis();

      // Check if memory exists
      const existing = await client.exists(memoryKey);
      if (existing && !overwrite) {
        return JSON.stringify({
          success: false,
          error: `Memory '${name}' already exists. Use overwrite: true to replace.`,
          code: 'MEMORY_EXISTS',
          name,
          projectId,
        });
      }

      const now = Date.now();
      const memory: ProjectMemory = {
        name,
        projectId,
        content,
        createdAt: existing ? ((await getExistingCreatedAt(client, memoryKey)) ?? now) : now,
        updatedAt: now,
        tags,
      };

      const ttl = ttlDays * 24 * 60 * 60;

      // Store memory
      await client.setex(memoryKey, ttl, JSON.stringify(memory));

      // Update index
      await client.sadd(indexKey, name);
      await client.expire(indexKey, DEFAULT_TTL);

      Logger.debug(`write-memory: stored '${name}' for project ${projectId}`);

      return JSON.stringify({
        success: true,
        name,
        projectId,
        contentLength: content.length,
        tags,
        ttlDays,
        overwritten: existing > 0,
        createdAt: memory.createdAt,
        updatedAt: memory.updatedAt,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      Logger.error(`write-memory error: ${errorMessage}`);

      return JSON.stringify({
        success: false,
        error: errorMessage,
        code: 'STORAGE_ERROR',
      });
    }
  },
};

/**
 * Retrieve the original creation timestamp of an existing memory
 *
 * @description Used when overwriting a memory to preserve the original createdAt
 * @param {Redis} client - Redis client instance
 * @param {string} key - Redis key for the memory
 * @returns {Promise<number | null>} Original createdAt timestamp or null
 * @internal
 */
async function getExistingCreatedAt(client: Redis, key: string): Promise<number | null> {
  try {
    const data = await client.get(key);
    if (data) {
      const memory = JSON.parse(data) as ProjectMemory;
      return memory.createdAt;
    }
  } catch {
    // Ignore parse errors
  }
  return null;
}
