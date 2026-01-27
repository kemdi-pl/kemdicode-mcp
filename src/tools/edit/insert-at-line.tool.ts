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
 * Insert At Line Tool
 *
 * Insert content at a specific line number in a file.
 * Content is inserted before the specified line.
 *
 * @module tools/edit/insert-at-line
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { Logger } from '../../utils/logger.js';
import { fromNodeError, formatErrorResponse } from '../../utils/errors.js';
import { validatePath, ValidationError, checkRateLimit } from '../../utils/validation.js';
import { readFileLines, writeFileLines, validateLineNumber } from '../../utils/edit-utils.js';

const schema = z.object({
  path: z.string().min(1).describe('File path to edit'),
  line: z
    .number()
    .int()
    .positive()
    .describe('Line number to insert at (1-based, content inserted before this line)'),
  content: z.string().describe('Content to insert (can be multiple lines)'),
  createBackup: z.boolean().default(true).describe('Create .bak backup before editing'),
});

type InsertAtLineArgs = z.infer<typeof schema>;

/** Maximum content size to insert (10MB) */
const MAX_CONTENT_SIZE = 10 * 1024 * 1024;

export const insertAtLineTool: UnifiedTool = {
  name: 'insert-at-line',
  description: 'Insert content at a specific line number in a file',
  zodSchema: schema,

  execute: async (args): Promise<string> => {
    const { path: inputPath, line, content, createBackup } = args as InsertAtLineArgs;

    // Rate limit check
    if (!checkRateLimit('edit-operations', { maxRequests: 50, windowMs: 60000 })) {
      return JSON.stringify({
        success: false,
        error: 'Rate limit exceeded for edit operations',
        code: 'RATE_LIMIT_EXCEEDED',
        path: inputPath,
      });
    }

    // Check content size
    if (content.length > MAX_CONTENT_SIZE) {
      return JSON.stringify({
        success: false,
        error: `Content too large: ${content.length} bytes (max: ${MAX_CONTENT_SIZE} bytes)`,
        code: 'CONTENT_TOO_LARGE',
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
        Logger.warn(`insert-at-line security validation failed: ${validationError.message}`);
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

      // Validate line number (allow inserting at end)
      try {
        validateLineNumber(line, totalLines, true);
      } catch (validationError) {
        return JSON.stringify({
          success: false,
          error: (validationError as Error).message,
          code: 'INVALID_LINE_NUMBER',
          path: validatedPath,
          totalLines,
        });
      }

      // Split content into lines to insert
      const linesToInsert = content.split('\n');
      const linesInserted = linesToInsert.length;

      // Insert at position (line - 1 for 0-based array index)
      lines.splice(line - 1, 0, ...linesToInsert);

      // Write back
      const backupPath = await writeFileLines(validatedPath, lines, createBackup);

      Logger.debug(
        `insert-at-line: inserted ${linesInserted} lines at line ${line} in ${validatedPath}`
      );

      return JSON.stringify({
        success: true,
        path: validatedPath,
        line,
        linesInserted,
        newTotalLines: lines.length,
        backup: backupPath,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      Logger.error(`insert-at-line error: ${errorMessage}`);

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
