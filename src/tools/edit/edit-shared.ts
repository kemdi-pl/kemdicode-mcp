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
 * Shared Edit Tool Utilities
 *
 * Common logic extracted from line-editing tools to reduce duplication.
 * Handles rate limiting, path validation, content size checks, and error formatting.
 *
 * @module tools/edit/edit-shared
 */

import { Logger } from '../../utils/logger.js';
import { fromNodeError, formatErrorResponse } from '../../utils/errors.js';
import { validatePath, ValidationError, checkRateLimit } from '../../utils/validation.js';

/** Maximum content size (10MB) */
export const MAX_CONTENT_SIZE = 10 * 1024 * 1024;

/**
 * Early validation result: either an error response string or a validated path.
 */
export type EarlyValidationResult =
  | { ok: true; validatedPath: string }
  | { ok: false; errorResponse: string };

/**
 * Perform common early validation shared by all edit tools:
 * - Rate limit check
 * - Optional content size check
 * - Path validation
 *
 * @param toolName - Name of the calling tool (for log messages)
 * @param inputPath - Raw input path from user
 * @param options - Additional options
 * @returns Validated path or error response JSON string
 */
export async function validateEditRequest(
  toolName: string,
  inputPath: string,
  options: {
    contentLength?: number;
    operation?: 'read' | 'write';
  } = {}
): Promise<EarlyValidationResult> {
  const { contentLength, operation = 'write' } = options;

  // Rate limit check
  if (!checkRateLimit('edit-operations', { maxRequests: 50, windowMs: 60000 })) {
    return {
      ok: false,
      errorResponse: JSON.stringify({
        success: false,
        error: 'Rate limit exceeded for edit operations',
        code: 'RATE_LIMIT_EXCEEDED',
        path: inputPath,
      }),
    };
  }

  // Content size check (for tools that accept content input)
  if (contentLength !== undefined && contentLength > MAX_CONTENT_SIZE) {
    return {
      ok: false,
      errorResponse: JSON.stringify({
        success: false,
        error: `Content too large: ${contentLength} bytes (max: ${MAX_CONTENT_SIZE} bytes)`,
        code: 'CONTENT_TOO_LARGE',
        path: inputPath,
      }),
    };
  }

  // Path validation
  try {
    const validatedPath = await validatePath(inputPath, {
      allowSymlinks: false,
      requireWithinProject: false,
      allowReadFromBlocked: false,
      operation,
    });
    return { ok: true, validatedPath };
  } catch (validationError) {
    if (validationError instanceof ValidationError) {
      Logger.warn(`${toolName} security validation failed: ${validationError.message}`);
      return {
        ok: false,
        errorResponse: JSON.stringify({
          success: false,
          error: validationError.message,
          code: validationError.code,
          path: inputPath,
        }),
      };
    }
    throw validationError;
  }
}

/**
 * Format a caught error into a JSON error response string.
 * Handles both Node.js errno errors and generic errors.
 *
 * @param toolName - Name of the calling tool (for log messages)
 * @param error - The caught error
 * @param validatedPath - The validated file path
 * @returns JSON error response string
 */
export function formatEditError(toolName: string, error: unknown, validatedPath: string): string {
  const errorMessage = error instanceof Error ? error.message : String(error);
  Logger.error(`${toolName} error: ${errorMessage}`);

  const nodeError = error as NodeJS.ErrnoException;
  if (nodeError.code) {
    const mcpError = fromNodeError(nodeError, validatedPath, 'write');
    const errorResponse = formatErrorResponse(mcpError);
    return JSON.stringify({
      success: false,
      path: validatedPath,
      ...errorResponse,
    });
  }

  return JSON.stringify({
    success: false,
    path: validatedPath,
    error: errorMessage,
  });
}
