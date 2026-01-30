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
 * Shared types and utilities for memory and checkpoint tools.
 *
 * @module tools/memory/shared
 */

import { createHash } from 'crypto';
import { getSharedRedis } from '../../infrastructure/redis/connection.js';
import type { Redis } from 'ioredis';

/** Memory entry structure */
export interface ProjectMemory {
  name: string;
  projectId: string;
  content: string;
  createdAt: number;
  updatedAt: number;
  tags: string[];
}

/** Checkpoint entry structure */
export interface Checkpoint {
  name: string;
  projectId: string;
  content: string;
  createdAt: number;
  updatedAt: number;
  tags: string[];
}

/** Redis key prefixes */
export const MEMORY_PREFIX = 'mcp:memory:';
export const MEMORY_INDEX_PREFIX = 'mcp:memory:index:';
export const CHECKPOINT_PREFIX = 'mcp:checkpoint:';
export const CHECKPOINT_INDEX_PREFIX = 'mcp:checkpoint:index:';

/** Maximum content size: 1MB */
export const MAX_CONTENT_SIZE = 1024 * 1024;

/** Default TTL: 30 days in seconds */
export const DEFAULT_MEMORY_TTL = 30 * 24 * 60 * 60;

/** Default checkpoint TTL: 7 days in seconds */
export const DEFAULT_CHECKPOINT_TTL = 7 * 24 * 60 * 60;

/** Shared Redis getter */
export const getRedis = getSharedRedis;

/**
 * Generate a unique project identifier from current working directory.
 * Creates a SHA-256 hash of the CWD, truncated to 16 characters.
 */
export function getProjectId(): string {
  const cwd = process.cwd();
  return createHash('sha256').update(cwd).digest('hex').slice(0, 16);
}

/**
 * Retrieve the original creation timestamp of an existing entry.
 * Used when overwriting to preserve the original createdAt.
 */
export async function getExistingCreatedAt(client: Redis, key: string): Promise<number | null> {
  try {
    const data = await client.get(key);
    if (data) {
      const entry = JSON.parse(data) as { createdAt: number };
      return entry.createdAt;
    }
  } catch {
    // Ignore parse errors
  }
  return null;
}
