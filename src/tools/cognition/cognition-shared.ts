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
 * Shared utilities for cognition tools.
 *
 * Extracts the common execute pattern:
 *   rateLimitGuard → getStore() → try { fn(store) } catch { handleToolError }
 *
 * @module tools/cognition/cognition-shared
 */

import { rateLimitGuard } from '../../utils/validation.js';
import { handleToolError } from '../../utils/errors.js';

/**
 * Execute a cognition tool with standard boilerplate:
 * 1. Rate limit check (60 req/min default)
 * 2. Store initialization via provided getter
 * 3. Try-catch with handleToolError
 *
 * @param toolName - Tool name for error logging
 * @param getStore - Factory function to get the Redis-backed store
 * @param fn - Tool logic receiving the initialized store
 * @param maxRequests - Rate limit (default 60)
 */
export async function executeCognitionTool<TStore>(
  toolName: string,
  getStore: () => TStore,
  fn: (store: TStore) => Promise<string> | string,
  maxRequests = 60
): Promise<string> {
  const blocked = rateLimitGuard(toolName, { maxRequests, windowMs: 60000 });
  if (blocked) return blocked;

  const store = getStore();

  try {
    return await fn(store);
  } catch (error) {
    return handleToolError(toolName, error);
  }
}
