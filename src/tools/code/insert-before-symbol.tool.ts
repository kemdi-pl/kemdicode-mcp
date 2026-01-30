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
 * Insert Before Symbol Tool
 *
 * Inserts content before a symbol's definition in the codebase.
 * Uses ripgrep patterns to locate symbols and then inserts content.
 *
 * @module tools/code/insert-before-symbol
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { Logger } from '../../utils/logger.js';
import { validatePath, ValidationError, checkRateLimit } from '../../utils/validation.js';
import { readFileLines, writeFileLines } from '../../utils/edit-utils.js';
import {
  findSymbolDefinition,
  findSymbolAuto,
  type SymbolLocation,
} from './symbol-search.js';

const schema = z.object({
  symbol: z.string().min(1).describe('Symbol name'),
  content: z.string().describe('Content to insert before symbol'),
  path: z.string().optional().describe('Search path'),
  language: z
    .enum(['ts', 'php', 'py', 'go', 'rs', 'auto'])
    .default('auto')
    .describe('Target language'),
  createBackup: z.boolean().default(true).describe('Create backup'),
});

type InsertBeforeSymbolArgs = z.infer<typeof schema>;

export const insertBeforeSymbolTool: UnifiedTool = {
  name: 'insert-before-symbol',
  description: 'Insert content before symbol definition',
  zodSchema: schema,

  execute: async (args): Promise<string> => {
    const {
      symbol,
      content,
      path: inputPath,
      language,
      createBackup,
    } = args as InsertBeforeSymbolArgs;

    // Rate limit check
    if (!checkRateLimit('edit-operations', { maxRequests: 50, windowMs: 60000 })) {
      return JSON.stringify({
        success: false,
        error: 'Rate limit exceeded for edit operations',
        code: 'RATE_LIMIT_EXCEEDED',
      });
    }

    const searchPath = inputPath || process.cwd();

    try {
      // Find the symbol
      let location: SymbolLocation | null = null;
      let detectedLanguage: 'ts' | 'php' | 'py' | 'go' | 'rs' | 'auto' = language;

      if (language === 'auto') {
        const result = await findSymbolAuto(symbol, searchPath);
        if (result) {
          location = result.location;
          detectedLanguage = result.language;
        }
      } else {
        location = await findSymbolDefinition(symbol, language, searchPath);
      }

      if (!location) {
        return JSON.stringify({
          success: false,
          error: `Symbol '${symbol}' not found`,
          code: 'SYMBOL_NOT_FOUND',
          searchPath,
          language: detectedLanguage,
        });
      }

      // Validate the file path for writing
      let validatedPath: string;
      try {
        validatedPath = await validatePath(location.file, {
          allowSymlinks: false,
          requireWithinProject: false,
          operation: 'write',
          projectRoot: (args as Record<string, unknown>)._sessionCwd as string | undefined,
        });
      } catch (validationError) {
        if (validationError instanceof ValidationError) {
          return JSON.stringify({
            success: false,
            error: validationError.message,
            code: validationError.code,
            file: location.file,
          });
        }
        throw validationError;
      }

      // Read file and insert content
      const lines = await readFileLines(validatedPath);
      const insertLine = location.line - 1; // Convert to 0-based index

      if (insertLine < 0 || insertLine > lines.length) {
        return JSON.stringify({
          success: false,
          error: `Invalid line number: ${location.line}`,
          code: 'INVALID_LINE',
        });
      }

      // Split content into lines and insert
      const contentLines = content.split('\n');
      lines.splice(insertLine, 0, ...contentLines);

      // Write back
      const backupPath = await writeFileLines(validatedPath, lines, createBackup);

      Logger.debug(
        `insert-before-symbol: inserted ${contentLines.length} lines before '${symbol}' at ${validatedPath}:${location.line}`
      );

      return JSON.stringify({
        success: true,
        file: validatedPath,
        symbol,
        insertedAt: location.line,
        linesInserted: contentLines.length,
        newTotalLines: lines.length,
        backup: backupPath,
        language: detectedLanguage,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      Logger.error(`insert-before-symbol error: ${errorMessage}`);

      return JSON.stringify({
        success: false,
        error: errorMessage,
      });
    }
  },
};
