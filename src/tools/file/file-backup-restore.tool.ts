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
 * File Backup Restore Tool
 *
 * List and restore file backups created by file-write tool.
 * Backups use the `.bak` naming convention (e.g. `file.ts.bak`).
 * Restoring creates a safety backup of the current file first.
 *
 * @module tools/file/file-backup-restore
 */

import { z } from 'zod';
import { promises as fs } from 'fs';
import { dirname, basename } from 'path';
import { UnifiedTool } from '../registry.js';
import { Logger } from '../../utils/logger.js';
import { fromNodeError, formatErrorResponse, handleToolError } from '../../utils/errors.js';
import { validatePathSafe, rateLimitGuard } from '../../utils/validation.js';
import { isSilent } from '../../config/silent.js';

const schema = z.object({
  action: z.enum(['list', 'restore']).describe('List available backups or restore one'),
  path: z.string().min(1).describe('Original file path'),
  backupPath: z.string().optional().describe('Specific backup to restore (for restore action)'),
});

type FileBackupRestoreArgs = z.infer<typeof schema>;

/**
 * Backup file patterns to search for.
 * file-write creates backups as `<filename>.bak`
 */
const BACKUP_SUFFIXES = ['.bak'];

/**
 * Find all backup files for a given original file path
 */
async function findBackups(
  originalPath: string
): Promise<Array<{ path: string; size: number; modifiedAt: string }>> {
  const dir = dirname(originalPath);
  const base = basename(originalPath);
  const backups: Array<{ path: string; size: number; modifiedAt: string }> = [];

  try {
    const entries = await fs.readdir(dir);

    for (const entry of entries) {
      // Match exact .bak suffix pattern
      for (const suffix of BACKUP_SUFFIXES) {
        if (entry === `${base}${suffix}`) {
          const fullPath = `${dir}/${entry}`;
          try {
            const stats = await fs.stat(fullPath);
            if (stats.isFile()) {
              backups.push({
                path: fullPath,
                size: stats.size,
                modifiedAt: stats.mtime.toISOString(),
              });
            }
          } catch {
            // Skip inaccessible files
          }
        }
      }

      // Also match timestamped backup patterns like file.ts.bak.20260130-120000
      if (entry.startsWith(`${base}.bak`)) {
        const fullPath = `${dir}/${entry}`;
        try {
          const stats = await fs.stat(fullPath);
          if (stats.isFile()) {
            // Avoid duplicates
            if (!backups.some((b) => b.path === fullPath)) {
              backups.push({
                path: fullPath,
                size: stats.size,
                modifiedAt: stats.mtime.toISOString(),
              });
            }
          }
        } catch {
          // Skip inaccessible files
        }
      }
    }
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code !== 'ENOENT') {
      throw error;
    }
    // Directory doesn't exist - no backups
  }

  // Sort by modification time, newest first
  backups.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());

  return backups;
}

export const fileBackupRestoreTool: UnifiedTool = {
  name: 'file-backup-restore',
  description: 'List available backups or restore a backup file. Works with .bak backups created by file-write.',
  zodSchema: schema,
  metadata: { category: 'file', tags: ['backup', 'restore', 'recovery'] },

  execute: async (args): Promise<string> => {
    const { action, path: inputPath, backupPath } = args as unknown as FileBackupRestoreArgs;

    const blocked = rateLimitGuard('file-operations', { maxRequests: 50, windowMs: 60000 });
    if (blocked) return blocked;

    const sessionCwd = (args as Record<string, unknown>)._sessionCwd as string | undefined;

    // Validate the original file path
    const pathResult = await validatePathSafe(inputPath, {allowSymlinks: false,
        requireWithinProject: false,
        allowReadFromBlocked: true,
        operation: 'read',
        projectRoot: sessionCwd}, 'file-backup-restore');

    if (!pathResult.ok) return JSON.stringify({ success: false, error: pathResult.error, code: pathResult.code, path: inputPath });

    const validatedPath = pathResult.path;

    if (action === 'list') {
      try {
        const backups = await findBackups(validatedPath);

        // Silent mode: return backup paths only
        if (isSilent()) {
          return JSON.stringify(backups.map((b) => b.path));
        }

        return JSON.stringify({
          success: true,
          action: 'list',
          originalPath: validatedPath,
          backupCount: backups.length,
          backups,
        });
      } catch (error) {

        return handleToolError('file-backup-restore', error);
      }
    }

    // action === 'restore'
    try {
      // Determine which backup to restore
      let restoreFrom: string;

      if (backupPath) {
        // Validate the specified backup path
        const bkResult = await validatePathSafe(backupPath, {
          allowSymlinks: false,
          requireWithinProject: false,
          allowReadFromBlocked: true,
          operation: 'read',
          projectRoot: sessionCwd,
        }, 'file-backup-restore');
        if (!bkResult.ok) return JSON.stringify({ success: false, error: bkResult.error, code: bkResult.code, backupPath });
        restoreFrom = bkResult.path;
      } else {
        // Find the most recent backup
        const backups = await findBackups(validatedPath);
        if (backups.length === 0) {
          return JSON.stringify({
            success: false,
            error: `No backups found for: ${validatedPath}`,
            code: 'NO_BACKUPS',
            path: validatedPath,
          });
        }
        restoreFrom = backups[0].path;
      }

      // Check backup file exists
      let backupStats;
      try {
        backupStats = await fs.stat(restoreFrom);
      } catch (error) {
        const nodeError = error as NodeJS.ErrnoException;
        if (nodeError.code === 'ENOENT') {
          return JSON.stringify({
            success: false,
            error: `Backup file not found: ${restoreFrom}`,
            code: 'BACKUP_NOT_FOUND',
            backupPath: restoreFrom,
          });
        }
        throw error;
      }

      if (!backupStats.isFile()) {
        return JSON.stringify({
          success: false,
          error: `Backup path is not a file: ${restoreFrom}`,
          code: 'NOT_A_FILE',
          backupPath: restoreFrom,
        });
      }

      // Validate destination for write
      const wpResult = await validatePathSafe(inputPath, {
        allowSymlinks: false,
        requireWithinProject: false,
        allowReadFromBlocked: false,
        operation: 'write',
        projectRoot: sessionCwd,
      }, 'file-backup-restore');
      if (!wpResult.ok) return JSON.stringify({ success: false, error: wpResult.error, code: wpResult.code, path: inputPath });
      const writePath = wpResult.path;

      // Create a safety backup of the current file before restoring
      let safetyBackupPath: string | null = null;
      try {
        const currentStats = await fs.stat(writePath);
        if (currentStats.isFile()) {
          safetyBackupPath = `${writePath}.bak`;
          await fs.copyFile(writePath, safetyBackupPath);
        }
      } catch (error) {
        const nodeError = error as NodeJS.ErrnoException;
        if (nodeError.code !== 'ENOENT') {
          // Non-critical: log but continue
          Logger.warn(`file-backup-restore: could not create safety backup: ${(error as Error).message}`);
          safetyBackupPath = null;
        }
      }

      // Restore: copy backup over original
      await fs.copyFile(restoreFrom, writePath);

      const restoredStats = await fs.stat(writePath);

      Logger.debug(`file-backup-restore: restored ${restoreFrom} -> ${writePath}`);
      return JSON.stringify({
        success: true,
        action: 'restore',
        originalPath: writePath,
        restoredFrom: restoreFrom,
        safetyBackup: safetyBackupPath,
        size: restoredStats.size,
        restoredAt: new Date().toISOString(),
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      Logger.error(`file-backup-restore restore error: ${errorMessage}`);

      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code) {
        const mcpError = fromNodeError(nodeError, inputPath, 'write');
        const errorResponse = formatErrorResponse(mcpError);
        return JSON.stringify({ success: false, ...errorResponse, path: inputPath });
      }

      return JSON.stringify({
        success: false,
        error: errorMessage,
        code: 'RESTORE_ERROR',
        path: inputPath,
      });
    }
  },
};
