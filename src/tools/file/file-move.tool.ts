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
 * File Move Tool
 *
 * Move/rename files with security validation, overwrite protection,
 * automatic directory creation, and cross-filesystem support.
 *
 * @module tools/file/file-move
 */

import { z } from 'zod';
import { promises as fs } from 'fs';
import { dirname } from 'path';
import { UnifiedTool } from '../registry.js';
import { Logger } from '../../utils/logger.js';
import { fromNodeError, formatErrorResponse } from '../../utils/errors.js';
import { validatePath, ValidationError, checkRateLimit } from '../../utils/validation.js';
import { isSilent } from '../../config/silent.js';

const schema = z.object({
  operations: z
    .array(
      z.object({
        source: z.string().min(1).describe('Source file path'),
        destination: z.string().min(1).describe('Destination file path'),
      })
    )
    .min(1)
    .max(20)
    .describe('Move operations (1-20)'),
  overwrite: z.boolean().default(false).describe('Overwrite if destination exists'),
  createDirs: z.boolean().default(true).describe('Create destination directories'),
});

type FileMoveArgs = z.infer<typeof schema>;

/**
 * Create parent directories recursively
 */
async function ensureDirectory(dirPath: string): Promise<void> {
  try {
    await fs.mkdir(dirPath, { recursive: true });
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code !== 'EEXIST') {
      throw error;
    }
  }
}

/**
 * Move a single file and return structured result
 */
async function moveSingleFile(
  source: string,
  destination: string,
  overwrite: boolean,
  createDirs: boolean,
  sessionCwd?: string
): Promise<Record<string, unknown>> {
  try {
    // Validate source path
    let validatedSource: string;
    try {
      validatedSource = await validatePath(source, {
        allowSymlinks: false,
        requireWithinProject: false,
        allowReadFromBlocked: false,
        operation: 'read',
        projectRoot: sessionCwd,
      });
    } catch (validationError) {
      if (validationError instanceof ValidationError) {
        Logger.warn(`file-move source validation failed: ${validationError.message}`);
        return {
          success: false,
          error: validationError.message,
          code: (validationError as ValidationError).code,
          source,
        };
      }
      throw validationError;
    }

    // Validate destination path
    let validatedDest: string;
    try {
      validatedDest = await validatePath(destination, {
        allowSymlinks: false,
        requireWithinProject: false,
        allowReadFromBlocked: false,
        operation: 'write',
        projectRoot: sessionCwd,
      });
    } catch (validationError) {
      if (validationError instanceof ValidationError) {
        Logger.warn(`file-move destination validation failed: ${validationError.message}`);
        return {
          success: false,
          error: validationError.message,
          code: (validationError as ValidationError).code,
          source,
          destination,
        };
      }
      throw validationError;
    }

    // Check source exists and is a file
    let sourceStats;
    try {
      sourceStats = await fs.stat(validatedSource);
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === 'ENOENT') {
        return {
          success: false,
          error: `Source file not found: ${validatedSource}`,
          code: 'FILE_NOT_FOUND',
          source: validatedSource,
        };
      }
      throw error;
    }

    if (!sourceStats.isFile()) {
      return {
        success: false,
        error: `Source is not a file: ${validatedSource}`,
        code: 'NOT_A_FILE',
        source: validatedSource,
      };
    }

    // Check destination does not exist (unless overwrite)
    if (!overwrite) {
      try {
        await fs.stat(validatedDest);
        return {
          success: false,
          error: `Destination already exists: ${validatedDest}`,
          code: 'DESTINATION_EXISTS',
          source: validatedSource,
          destination: validatedDest,
        };
      } catch (error) {
        const nodeError = error as NodeJS.ErrnoException;
        if (nodeError.code !== 'ENOENT') {
          throw error;
        }
        // ENOENT is expected - destination doesn't exist
      }
    }

    // Create destination directories if needed
    if (createDirs) {
      const destDir = dirname(validatedDest);
      try {
        await fs.access(destDir);
      } catch {
        await ensureDirectory(destDir);
      }
    }

    // Try fs.rename first (same filesystem, atomic)
    try {
      await fs.rename(validatedSource, validatedDest);
    } catch (renameError) {
      const nodeError = renameError as NodeJS.ErrnoException;
      if (nodeError.code === 'EXDEV') {
        // Cross-filesystem: copy + delete
        await fs.copyFile(validatedSource, validatedDest);
        await fs.unlink(validatedSource);
      } else {
        throw renameError;
      }
    }

    const destStats = await fs.stat(validatedDest);

    Logger.debug(`file-move: moved ${validatedSource} -> ${validatedDest}`);
    return {
      success: true,
      source: validatedSource,
      destination: validatedDest,
      size: destStats.size,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    Logger.error(`file-move error: ${errorMessage}`);

    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code) {
      const mcpError = fromNodeError(nodeError, source, 'write');
      const errorResponse = formatErrorResponse(mcpError);
      return { success: false, ...errorResponse, source, destination };
    }

    return { success: false, error: errorMessage, code: 'UNKNOWN_ERROR', source, destination };
  }
}

export const fileMoveTool: UnifiedTool = {
  name: 'file-move',
  description: 'Move/rename 1-20 files with overwrite protection and automatic directory creation.',
  zodSchema: schema,
  metadata: { category: 'file', tags: ['move', 'rename', 'batch'] },

  execute: async (args): Promise<string> => {
    const { operations, overwrite, createDirs } = args as unknown as FileMoveArgs;

    if (!checkRateLimit('file-operations', { maxRequests: 50, windowMs: 60000 })) {
      return JSON.stringify({
        success: false,
        error: 'Rate limit exceeded for file operations',
        code: 'RATE_LIMIT_EXCEEDED',
      });
    }

    const sessionCwd = (args as Record<string, unknown>)._sessionCwd as string | undefined;

    const results = await Promise.all(
      operations.map((op) => moveSingleFile(op.source, op.destination, overwrite, createDirs, sessionCwd))
    );

    const successful = results.filter((r) => r.success);
    const failed = results.filter((r) => !r.success);

    // Silent mode: return moved count
    if (isSilent()) {
      if (failed.length > 0) {
        return JSON.stringify({ moved: successful.length, errors: failed.map((r) => r.error) });
      }
      return JSON.stringify({ moved: successful.length });
    }

    return JSON.stringify({
      success: failed.length === 0,
      moved: successful.length,
      failed: failed.length,
      results,
    });
  },
};
