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
 * Replace Lines Tool
 *
 * Replace a range of lines with new content.
 * The new content can have more or fewer lines than the replaced range.
 *
 * @module tools/edit/replace-lines
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

const schema = z.object({
  path: z.string().min(1).describe('File path to edit'),
  startLine: z.number().int().positive().describe('First line to replace (1-based, inclusive)'),
  endLine: z.number().int().positive().describe('Last line to replace (1-based, inclusive)'),
  content: z.string().describe('New content to insert (can be more or fewer lines)'),
  createBackup: z.boolean().default(true).describe('Create .bak backup before editing'),
});

type ReplaceLinesArgs = z.infer<typeof schema>;

export const replaceLinesTool: UnifiedTool = {
  name: 'replace-lines',
  description: 'Replace a range of lines with new content',
  zodSchema: schema,

  execute: async (args): Promise<string> => {
    const { path: inputPath, startLine, endLine, content, createBackup } = args as ReplaceLinesArgs;

    // Common validation: rate limit + content size + path
    const validation = await validateEditRequest('replace-lines', inputPath, {
      contentLength: content.length,
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

      // Calculate stats
      const originalLinesCount = endLine - startLine + 1;
      const newLines = content.split('\n');
      const newLinesCount = newLines.length;
      const lineDelta = newLinesCount - originalLinesCount;

      // Get preview of replaced content
      const replacedContent = lines.slice(startLine - 1, endLine).join('\n');

      // Replace lines
      lines.splice(startLine - 1, originalLinesCount, ...newLines);

      // Write back
      const backupPath = await writeFileLines(validatedPath, lines, createBackup);

      Logger.debug(
        `replace-lines: replaced lines ${startLine}-${endLine} (${originalLinesCount} -> ${newLinesCount} lines) in ${validatedPath}`
      );

      return JSON.stringify({
        success: true,
        path: validatedPath,
        startLine,
        endLine,
        originalLines: originalLinesCount,
        newLines: newLinesCount,
        lineDelta,
        replacedContent: truncateForPreview(replacedContent, 300),
        newTotalLines: lines.length,
        backup: backupPath,
      });
    } catch (error) {
      return formatEditError('replace-lines', error, validatedPath);
    }
  },
};
