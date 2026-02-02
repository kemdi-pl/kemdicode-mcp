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
 * Shared tool execution helpers.
 *
 * Provides wrappers that combine rate limiting, try-catch,
 * and error handling into single-call patterns.
 *
 * @module tools/tool-shared
 */

import { rateLimitGuard, type RateLimitConfig } from '../utils/validation.js';
import { handleToolError, McpError } from '../utils/errors.js';
import { Logger } from '../utils/logger.js';

/**
 * Execute a tool with rate limiting and error handling.
 *
 * Combines:
 *   const blocked = rateLimitGuard(category);
 *   if (blocked) return blocked;
 *   try { return await fn(); } catch (e) { return handleToolError(name, e); }
 *
 * Preserves structured McpError information (code, context) in JSON response.
 *
 * @param toolName - Tool name for error logging
 * @param category - Rate limit category
 * @param fn - Tool logic
 * @param rateLimit - Optional rate limit config override
 */
export async function executeWithGuard(
  toolName: string,
  category: string,
  fn: () => Promise<string> | string,
  rateLimit?: RateLimitConfig
): Promise<string> {
  const blocked = rateLimitGuard(category, rateLimit);
  if (blocked) return blocked;

  try {
    return await fn();
  } catch (error) {
    if (error instanceof McpError) {
      Logger.error(`[${toolName}] ${error.code}: ${error.message}`);
      return JSON.stringify(error.toJSON());
    }
    return handleToolError(toolName, error);
  }
}
