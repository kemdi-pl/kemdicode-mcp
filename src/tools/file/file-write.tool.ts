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
 * File Write Tool
 *
 * Write file content with automatic backup, directory creation,
 * append mode support, permission preservation, and security validation.
 *
 * @module tools/file/file-write
 */

import { z } from 'zod';
import { promises as fs } from 'fs';
import { dirname } from 'path';
import { UnifiedTool } from '../registry.js';
import { Logger } from '../../utils/logger.js';
import { fromNodeError, formatErrorResponse } from '../../utils/errors.js';
import { validatePath, ValidationError, checkRateLimit } from '../../utils/validation.js';

const schema = z.object({
  path: z.string().min(1).describe('File path to write'),
  content: z.string().describe('Content to write to the file'),
  createBackup: z.boolean().default(true).describe('Create .bak backup of existing file'),
  createDirs: z.boolean().default(true).describe('Create parent directories if they do not exist'),
  append: z.boolean().default(false).describe('Append to file instead of overwriting'),
  encoding: z
    .enum(['utf-8', 'utf-16', 'ascii', 'latin1'])
    .default('utf-8')
    .describe('File encoding'),
  mode: z.string().optional().describe('File permissions (e.g., "0644")'),
});

type FileWriteArgs = z.infer<typeof schema>;

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
 * Create a backup of an existing file
 */
async function createBackupFile(filePath: string): Promise<string | null> {
  try {
    const stats = await fs.stat(filePath);
    if (stats.isFile()) {
      const backupPath = `${filePath}.bak`;
      await fs.copyFile(filePath, backupPath);
      return backupPath;
    }
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code !== 'ENOENT') {
      throw error;
    }
  }
  return null;
}

/**
 * Get file permissions
 */
async function getFileMode(filePath: string): Promise<number | null> {
  try {
    const stats = await fs.stat(filePath);
    return stats.mode;
  } catch {
    return null;
  }
}

/** Maximum content size to write (10MB) */
const MAX_CONTENT_SIZE = 10 * 1024 * 1024;

export const fileWriteTool: UnifiedTool = {
  name: 'file-write',
  description: 'Write file with automatic backup, directory creation, and append mode',
  zodSchema: schema,

  execute: async (args): Promise<string> => {
    const {
      path: inputPath,
      content,
      createBackup,
      createDirs,
      append,
      encoding,
      mode,
    } = args as FileWriteArgs;

    // Rate limit check (stricter for write operations)
    if (!checkRateLimit('file-write', { maxRequests: 50, windowMs: 60000 })) {
      return JSON.stringify({
        success: false,
        error: 'Rate limit exceeded for file-write operations',
        code: 'RATE_LIMIT_EXCEEDED',
        path: inputPath,
      });
    }

    // Check content size limit
    if (content.length > MAX_CONTENT_SIZE) {
      return JSON.stringify({
        success: false,
        error: `Content too large: ${content.length} bytes (max: ${MAX_CONTENT_SIZE} bytes)`,
        code: 'CONTENT_TOO_LARGE',
        path: inputPath,
      });
    }

    // Validate and sanitize the path
    let validatedPath: string;
    try {
      validatedPath = await validatePath(inputPath, {
        allowSymlinks: false,
        requireWithinProject: false, // Allow writing anywhere (except system dirs)
        allowReadFromBlocked: false, // Strict mode for writes
        operation: 'write',
      });
    } catch (validationError) {
      if (validationError instanceof ValidationError) {
        Logger.warn(`file-write security validation failed: ${validationError.message}`);
        return JSON.stringify({
          success: false,
          error: validationError.message,
          code: validationError.code,
          path: inputPath,
        });
      }
      throw validationError;
    }

    const results: {
      success: boolean;
      path: string;
      backup?: string;
      created?: boolean;
      appended?: boolean;
      bytesWritten?: number;
      error?: string;
      directoriesCreated?: boolean;
      mode?: string;
    } = {
      success: false,
      path: validatedPath,
    };

    try {
      // Check if file exists and get original permissions
      const existingMode = await getFileMode(validatedPath);
      const fileExists = existingMode !== null;

      // Create parent directories if needed
      if (createDirs) {
        const dir = dirname(validatedPath);
        try {
          await fs.access(dir);
        } catch {
          await ensureDirectory(dir);
          results.directoriesCreated = true;
        }
      }

      // Create backup if file exists and backup is requested
      if (fileExists && createBackup && !append) {
        const backupPath = await createBackupFile(validatedPath);
        if (backupPath) {
          results.backup = backupPath;
        }
      }

      // Determine encoding for write
      const writeEncoding = encoding === 'utf-8' ? 'utf8' : (encoding as BufferEncoding);

      // Write or append content
      if (append) {
        await fs.appendFile(validatedPath, content, { encoding: writeEncoding });
        results.appended = true;
      } else {
        await fs.writeFile(validatedPath, content, { encoding: writeEncoding });
        results.created = !fileExists;
      }

      // Set file permissions if specified or preserve existing
      const targetMode = mode ? parseInt(mode, 8) : (existingMode ?? 0o644);

      if (mode || existingMode) {
        await fs.chmod(validatedPath, targetMode);
        results.mode = '0' + (targetMode & 0o777).toString(8);
      }

      // Get final file stats
      const stats = await fs.stat(validatedPath);
      results.bytesWritten = stats.size;
      results.success = true;

      Logger.debug(`file-write: wrote ${stats.size} bytes to ${validatedPath}`);

      return JSON.stringify(results);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      Logger.error(`file-write error: ${errorMessage}`);

      // Convert Node.js errno errors to custom error types
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code) {
        const mcpError = fromNodeError(nodeError, validatedPath, 'write');
        const errorResponse = formatErrorResponse(mcpError);
        return JSON.stringify({ ...results, ...errorResponse });
      }

      results.error = errorMessage;
      results.success = false;
      return JSON.stringify(results);
    }
  },
};
