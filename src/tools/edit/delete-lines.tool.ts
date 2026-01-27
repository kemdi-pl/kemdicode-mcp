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
 * Delete Lines Tool
 *
 * Delete a range of lines from a file.
 *
 * @module tools/edit/delete-lines
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { Logger } from '../../utils/logger.js';
import { fromNodeError, formatErrorResponse } from '../../utils/errors.js';
import { validatePath, ValidationError, checkRateLimit } from '../../utils/validation.js';
import {
  readFileLines,
  writeFileLines,
  validateLineRange,
  truncateForPreview,
} from '../../utils/edit-utils.js';

const schema = z.object({
  path: z.string().min(1).describe('File path to edit'),
  startLine: z.number().int().positive().describe('First line to delete (1-based, inclusive)'),
  endLine: z.number().int().positive().describe('Last line to delete (1-based, inclusive)'),
  createBackup: z.boolean().default(true).describe('Create .bak backup before editing'),
});

type DeleteLinesArgs = z.infer<typeof schema>;

export const deleteLinesTool: UnifiedTool = {
  name: 'delete-lines',
  description: 'Delete a range of lines from a file',
  zodSchema: schema,

  execute: async (args): Promise<string> => {
    const { path: inputPath, startLine, endLine, createBackup } = args as DeleteLinesArgs;

    // Rate limit check
    if (!checkRateLimit('edit-operations', { maxRequests: 50, windowMs: 60000 })) {
      return JSON.stringify({
        success: false,
        error: 'Rate limit exceeded for edit operations',
        code: 'RATE_LIMIT_EXCEEDED',
        path: inputPath,
      });
    }

    // Validate path
    let validatedPath: string;
    try {
      validatedPath = await validatePath(inputPath, {
        allowSymlinks: false,
        requireWithinProject: false,
        allowReadFromBlocked: false,
        operation: 'write',
      });
    } catch (validationError) {
      if (validationError instanceof ValidationError) {
        Logger.warn(`delete-lines security validation failed: ${validationError.message}`);
        return JSON.stringify({
          success: false,
          error: validationError.message,
          code: validationError.code,
          path: inputPath,
        });
      }
      throw validationError;
    }

    try {
      // Read existing file
      const lines = await readFileLines(validatedPath);
      const totalLines = lines.length;

      // Validate line range
      try {
        validateLineRange(startLine, endLine, totalLines);
      } catch (validationError) {
        return JSON.stringify({
          success: false,
          error: (validationError as Error).message,
          code: 'INVALID_LINE_RANGE',
          path: validatedPath,
          totalLines,
        });
      }

      // Extract deleted content for preview
      const deletedLines = lines.slice(startLine - 1, endLine);
      const deletedContent = deletedLines.join('\n');
      const linesDeleted = deletedLines.length;

      // Delete lines (splice removes from startLine-1, count = endLine - startLine + 1)
      lines.splice(startLine - 1, linesDeleted);

      // Write back
      const backupPath = await writeFileLines(validatedPath, lines, createBackup);

      Logger.debug(
        `delete-lines: deleted lines ${startLine}-${endLine} (${linesDeleted} lines) from ${validatedPath}`
      );

      return JSON.stringify({
        success: true,
        path: validatedPath,
        startLine,
        endLine,
        linesDeleted,
        deletedContent: truncateForPreview(deletedContent, 500),
        newTotalLines: lines.length,
        backup: backupPath,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      Logger.error(`delete-lines error: ${errorMessage}`);

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
  },
};
