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
import { readFileLines, writeFileLines, validateLineNumber } from '../../utils/edit-utils.js';
import { validateEditRequest, formatEditError } from './edit-shared.js';

const schema = z.object({
  path: z.string().min(1).describe('File path'),
  line: z
    .number()
    .int()
    .positive()
    .describe('Insert at line (1-based, inserted before this line)'),
  content: z.string().describe('Content to insert'),
  createBackup: z.boolean().default(true).describe('Create .bak backup'),
});

type InsertAtLineArgs = z.infer<typeof schema>;

export const insertAtLineTool: UnifiedTool = {
  name: 'insert-at-line',
  description: 'Insert content at specific line number',
  zodSchema: schema,

  execute: async (args): Promise<string> => {
    const { path: inputPath, line, content, createBackup } = args as InsertAtLineArgs;

    // Common validation: rate limit + content size + path
    const validation = await validateEditRequest('insert-at-line', inputPath, {
      contentLength: content.length,
      projectRoot: (args as Record<string, unknown>)._sessionCwd as string | undefined,
    });
    if (!validation.ok) return validation.errorResponse;
    const { validatedPath } = validation;

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
      return formatEditError('insert-at-line', error, validatedPath);
    }
  },
};
