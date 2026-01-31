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
 * Redis Pipeline Helper
 *
 * Utility for batching multiple Redis commands into a single round-trip
 * using ioredis pipeline functionality. Improves performance by reducing
 * network overhead when executing multiple independent Redis operations.
 *
 * @module utils/redis-pipeline
 */

import type { Redis } from 'ioredis';

/**
 * Execute multiple Redis commands in a single pipeline
 *
 * @description Batches multiple Redis commands into a single network round-trip,
 *              significantly improving performance when executing multiple
 *              independent operations.
 * @param {Redis} redis - Redis client instance
 * @param {Array<[string, ...string[]]>} commands - Array of commands, each as [command, ...args]
 * @returns {Promise<unknown[]>} Array of results corresponding to each command
 * @throws {Error} If any command in the pipeline fails
 *
 * @example
 * ```typescript
 * const results = await redisPipeline(redis, [
 *   ['get', 'key1'],
 *   ['get', 'key2'],
 *   ['set', 'key3', 'value3'],
 * ]);
 * // results[0] = value of key1
 * // results[1] = value of key2
 * // results[2] = 'OK' (set result)
 * ```
 */
export async function redisPipeline(
  redis: Redis,
  commands: Array<[string, ...string[]]>
): Promise<unknown[]> {
  if (commands.length === 0) {
    return [];
  }

  const pipeline = redis.pipeline();

  // Add all commands to the pipeline
  for (const [command, ...args] of commands) {
    // @ts-expect-error - Dynamic command invocation
    pipeline[command](...args);
  }

  // Execute pipeline and extract results
  const results = await pipeline.exec();

  if (!results) {
    return [];
  }

  // Pipeline results are [error, result] tuples
  const values: unknown[] = [];
  for (const [err, value] of results) {
    if (err) {
      throw err;
    }
    values.push(value);
  }

  return values;
}
