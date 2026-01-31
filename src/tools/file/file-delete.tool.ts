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
 * File Delete Tool
 *
 * Delete files with security validation, critical file protection,
 * dry-run support, and batch operations.
 *
 * @module tools/file/file-delete
 */

import { z } from 'zod';
import { promises as fs } from 'fs';
import { UnifiedTool } from '../registry.js';
import { Logger } from '../../utils/logger.js';
import { fromNodeError, formatErrorResponse } from '../../utils/errors.js';
import { validatePath, ValidationError, checkRateLimit } from '../../utils/validation.js';

/**
 * Critical file/directory patterns that must never be deleted
 */
const CRITICAL_PATTERNS: readonly RegExp[] = [
  /^\.git$/,
  /^\.git\//,
  /^node_modules$/,
  /^package\.json$/,
  /^package-lock\.json$/,
  /^yarn\.lock$/,
  /^bun\.lockb$/,
  /^pnpm-lock\.yaml$/,
  /^composer\.json$/,
  /^composer\.lock$/,
  /^tsconfig\.json$/,
  /^\.env$/i,
  /^\.env\.\w+$/i,
];

const schema = z.object({
  files: z
    .array(
      z.object({
        path: z.string().min(1).describe('File path to delete'),
      })
    )
    .min(1)
    .max(20)
    .describe('Files to delete (1-20)'),
  dryRun: z.boolean().default(false).describe('Preview without deleting'),
});

type FileDeleteArgs = z.infer<typeof schema>;

/**
 * Check if a file path matches a critical pattern
 */
function isCriticalFile(filePath: string): boolean {
  const segments = filePath.replace(/\\/g, '/').split('/');
  const fileName = segments[segments.length - 1];

  for (const pattern of CRITICAL_PATTERNS) {
    if (pattern.test(fileName) || pattern.test(filePath)) {
      return true;
    }
  }

  // Block deletion of .git directory contents
  if (segments.some((seg) => seg === '.git')) {
    return true;
  }

  return false;
}

/**
 * Delete a single file and return structured result
 */
async function deleteSingleFile(
  inputPath: string,
  dryRun: boolean,
  sessionCwd?: string
): Promise<Record<string, unknown>> {
  try {
    let validatedPath: string;
    try {
      validatedPath = await validatePath(inputPath, {
        allowSymlinks: false,
        requireWithinProject: false,
        allowReadFromBlocked: false,
        operation: 'write',
        projectRoot: sessionCwd,
      });
    } catch (validationError) {
      if (validationError instanceof ValidationError) {
        Logger.warn(`file-delete security validation failed: ${validationError.message}`);
        return {
          success: false,
          error: validationError.message,
          code: (validationError as ValidationError).code,
          path: inputPath,
        };
      }
      throw validationError;
    }

    // Check critical file protection
    if (isCriticalFile(validatedPath)) {
      Logger.warn(`file-delete blocked: critical file ${validatedPath}`);
      return {
        success: false,
        error: `Cannot delete critical file: ${validatedPath}`,
        code: 'CRITICAL_FILE_PROTECTED',
        path: validatedPath,
      };
    }

    // Check file exists and is a file
    let stats;
    try {
      stats = await fs.stat(validatedPath);
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === 'ENOENT') {
        return {
          success: false,
          error: `File not found: ${validatedPath}`,
          code: 'FILE_NOT_FOUND',
          path: validatedPath,
        };
      }
      throw error;
    }

    if (!stats.isFile()) {
      return {
        success: false,
        error: `Path is not a file: ${validatedPath}`,
        code: 'NOT_A_FILE',
        path: validatedPath,
      };
    }

    if (dryRun) {
      return {
        success: true,
        dryRun: true,
        path: validatedPath,
        size: stats.size,
        wouldDelete: true,
      };
    }

    await fs.unlink(validatedPath);

    Logger.debug(`file-delete: deleted ${validatedPath} (${stats.size} bytes)`);
    return {
      success: true,
      path: validatedPath,
      size: stats.size,
      deleted: true,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    Logger.error(`file-delete error: ${errorMessage}`);

    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code) {
      const mcpError = fromNodeError(nodeError, inputPath, 'write');
      const errorResponse = formatErrorResponse(mcpError);
      return { success: false, ...errorResponse, path: inputPath };
    }

    return { success: false, error: errorMessage, code: 'UNKNOWN_ERROR', path: inputPath };
  }
}

export const fileDeleteTool: UnifiedTool = {
  name: 'file-delete',
  description: 'Delete 1-20 files with security checks, critical file protection, and dry-run support.',
  zodSchema: schema,
  metadata: { category: 'file', tags: ['delete', 'remove', 'batch'] },

  execute: async (args): Promise<string> => {
    const { files, dryRun } = args as unknown as FileDeleteArgs;

    if (!checkRateLimit('file-operations', { maxRequests: 50, windowMs: 60000 })) {
      return JSON.stringify({
        success: false,
        error: 'Rate limit exceeded for file operations',
        code: 'RATE_LIMIT_EXCEEDED',
      });
    }

    const sessionCwd = (args as Record<string, unknown>)._sessionCwd as string | undefined;

    const results = await Promise.all(
      files.map((item) => deleteSingleFile(item.path, dryRun, sessionCwd))
    );

    const successful = results.filter((r) => r.success);
    const failed = results.filter((r) => !r.success);

    return JSON.stringify({
      success: failed.length === 0,
      deleted: successful.length,
      failed: failed.length,
      dryRun,
      results,
    });
  },
};
