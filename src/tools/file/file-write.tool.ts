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
import { validatePathSafe, rateLimitGuard } from '../../utils/validation.js';
import { isSilent } from '../../config/silent.js';

const fileItemSchema = z.object({
  path: z.string().min(1).describe('File path'),
  content: z.string().describe('Content to write'),
  mode: z.string().regex(/^[0-7]{3,4}$/, 'Must be valid octal (e.g. "644", "0755")').optional().describe('File permissions (octal)'),
});

const schema = z.object({
  files: z.array(fileItemSchema).min(1).max(20).describe('Files to write (1-20)'),
  createBackup: z.boolean().default(true).describe('Create .bak backup'),
  createDirs: z.boolean().default(true).describe('Create parent dirs'),
  append: z.boolean().default(false).describe('Append instead of overwrite'),
  encoding: z
    .enum(['utf-8', 'utf-16', 'ascii', 'latin1'])
    .default('utf-8')
    .describe('Encoding'),
});

type FileWriteArgs = z.infer<typeof schema>;
type FileItemArgs = z.infer<typeof fileItemSchema>;

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

/**
 * Write a single file and return structured result
 */
async function writeSingleFile(
  item: FileItemArgs,
  options: { createBackup: boolean; createDirs: boolean; append: boolean; encoding: string },
  sessionCwd?: string
): Promise<Record<string, unknown>> {
  const inputPath = item.path;
  const { content, mode } = item;

  if (content.length > MAX_CONTENT_SIZE) {
    return { success: false, error: `Content too large: ${content.length} bytes`, code: 'CONTENT_TOO_LARGE', path: inputPath };
  }

  const pathResult = await validatePathSafe(inputPath, {
    allowSymlinks: false,
    requireWithinProject: false,
    allowReadFromBlocked: false,
    operation: 'write',
    projectRoot: sessionCwd,
  }, 'file-write');
  if (!pathResult.ok) return { success: false, error: pathResult.error, code: pathResult.code, path: inputPath };
  const validatedPath = pathResult.path;

  const result: Record<string, unknown> = { success: false, path: validatedPath };

  try {
    const existingMode = await getFileMode(validatedPath);
    const fileExists = existingMode !== null;

    if (options.createDirs) {
      const dir = dirname(validatedPath);
      try {
        await fs.access(dir);
      } catch {
        await ensureDirectory(dir);
        result.directoriesCreated = true;
      }
    }

    if (fileExists && options.createBackup && !options.append) {
      const backupPath = await createBackupFile(validatedPath);
      if (backupPath) result.backup = backupPath;
    }

    const writeEncoding = options.encoding === 'utf-8' ? 'utf8' : (options.encoding as BufferEncoding);

    if (options.append) {
      await fs.appendFile(validatedPath, content, { encoding: writeEncoding });
      result.appended = true;
    } else {
      await fs.writeFile(validatedPath, content, { encoding: writeEncoding });
      result.created = !fileExists;
    }

    const targetMode = mode ? parseInt(mode, 8) : (existingMode ?? 0o644);
    if (mode || existingMode) {
      await fs.chmod(validatedPath, targetMode);
      result.mode = '0' + (targetMode & 0o777).toString(8);
    }

    const stats = await fs.stat(validatedPath);
    result.bytesWritten = stats.size;
    result.success = true;

    Logger.debug(`file-write: wrote ${stats.size} bytes to ${validatedPath}`);
    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    Logger.error(`file-write error: ${errorMessage}`);

    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code) {
      const mcpError = fromNodeError(nodeError, validatedPath, 'write');
      const errorResponse = formatErrorResponse(mcpError);
      return { ...result, ...errorResponse };
    }

    result.error = errorMessage;
    return result;
  }
}

export const fileWriteTool: UnifiedTool = {
  name: 'file-write',
  description: 'Write 1-20 files with backup, dir creation, and append mode.',
  zodSchema: schema,
  metadata: {
    category: 'file',
    tags: ['write', 'create', 'backup'],
    examples: [
      { args: { files: [{ path: 'src/config.ts', content: 'export const PORT = 3000;' }] }, description: 'Write a single file with backup' },
      { args: { files: [{ path: 'logs/app.log', content: 'New entry\n' }], append: true, createBackup: false }, description: 'Append to a log file without backup' },
    ],
    relatedTools: ['file-read', 'file-delete', 'file-copy'],
  },

  execute: async (args): Promise<string> => {
    const { files, createBackup, createDirs, append, encoding } = args as unknown as FileWriteArgs;

    const blocked = rateLimitGuard('file-write', { maxRequests: 50, windowMs: 60000 });
    if (blocked) return blocked;

    const sessionCwd = (args as Record<string, unknown>)._sessionCwd as string | undefined;
    const options = { createBackup, createDirs, append, encoding };

    const results = await Promise.all(
      files.map((item) => writeSingleFile(item, options, sessionCwd))
    );

    const successful = results.filter((r) => r.success);
    const failed = results.filter((r) => !r.success);

    // Silent mode: return written paths
    if (isSilent()) {
      if (failed.length > 0) {
        return JSON.stringify({ written: successful.map((r) => r.path), errors: failed.map((r) => r.error) });
      }
      return JSON.stringify(successful.map((r) => r.path));
    }

    return JSON.stringify({
      success: failed.length === 0,
      written: successful.length,
      failed: failed.length,
      results,
    });
  },
};
