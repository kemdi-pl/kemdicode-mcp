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
import {
  readFileLines,
  writeFileLines,
  validateLineRange,
  truncateForPreview,
} from '../../utils/edit-utils.js';
import { validateEditRequest, formatEditError } from './edit-shared.js';
import { isSilent } from '../../config/silent.js';

const schema = z.object({
  path: z.string().min(1).describe('File path'),
  startLine: z.number().int().positive().describe('First line to delete (1-based)'),
  endLine: z.number().int().positive().describe('Last line to delete (1-based)'),
  createBackup: z.boolean().default(true).describe('Create .bak backup'),
});

type DeleteLinesArgs = z.infer<typeof schema>;

export const deleteLinesTool: UnifiedTool = {
  name: 'delete-lines',
  description: 'Delete line range from file',
  zodSchema: schema,
  metadata: {
    category: 'edit',
    tags: ['delete', 'lines'],
    examples: [
      {
        args: { path: 'src/utils/helpers.ts', startLine: 10, endLine: 20 },
        description: 'Delete lines 10-20 from a file',
      },
    ],
    relatedTools: ['replace-lines', 'insert-at-line', 'replace-content'],
  },

  execute: async (args): Promise<string> => {
    const { path: inputPath, startLine, endLine, createBackup } = args as DeleteLinesArgs;

    // Common validation: rate limit + path
    const validation = await validateEditRequest('delete-lines', inputPath, {
      projectRoot: (args as Record<string, unknown>)._sessionCwd as string | undefined,
    });
    if (!validation.ok) return validation.errorResponse;
    const { validatedPath } = validation;

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

      if (isSilent()) {
        return JSON.stringify({ path: validatedPath, linesDeleted });
      }

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
      return formatEditError('delete-lines', error, validatedPath);
    }
  },
};
