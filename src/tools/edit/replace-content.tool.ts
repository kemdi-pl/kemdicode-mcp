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
 * Replace Content Tool
 *
 * Find and replace text or patterns in a file.
 * Supports literal strings and regex patterns.
 *
 * @module tools/edit/replace-content
 */

import { z } from 'zod';
import { promises as fs } from 'fs';
import { UnifiedTool } from '../registry.js';
import { Logger } from '../../utils/logger.js';
import {
  validateRegexPattern,
  ValidationError,
} from '../../utils/validation.js';
import { validateEditRequest, formatEditError } from './edit-shared.js';

const schema = z.object({
  path: z.string().min(1).describe('File path'),
  search: z.string().min(1).describe('Search text or regex pattern'),
  replace: z.string().describe('Replacement text (supports $1, $2 for regex)'),
  isRegex: z.boolean().default(false).describe('Treat search as regex'),
  replaceAll: z.boolean().default(true).describe('Replace all occurrences'),
  caseSensitive: z.boolean().default(true).describe('Case-sensitive matching'),
  createBackup: z.boolean().default(true).describe('Create .bak backup'),
  dryRun: z.boolean().default(false).describe('Preview without applying'),
});

type ReplaceContentArgs = z.infer<typeof schema>;

/** Maximum file size to process (10MB) */
const MAX_FILE_SIZE = 10 * 1024 * 1024;

interface MatchPreview {
  line: number;
  before: string;
  after: string;
}

/**
 * Create backup of a file
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
 * Find match locations and create previews
 */
function findMatchPreviews(
  content: string,
  regex: RegExp,
  replacement: string,
  maxPreviews: number = 5
): MatchPreview[] {
  const previews: MatchPreview[] = [];
  const lines = content.split('\n');

  let lineIndex = 0;
  let charIndex = 0;

  // Create a copy of regex for global search
  const searchRegex = new RegExp(
    regex.source,
    regex.flags.includes('g') ? regex.flags : regex.flags + 'g'
  );

  let match: RegExpExecArray | null;
  while ((match = searchRegex.exec(content)) !== null && previews.length < maxPreviews) {
    // Find which line this match is on
    while (lineIndex < lines.length && charIndex + lines[lineIndex].length < match.index) {
      charIndex += lines[lineIndex].length + 1; // +1 for newline
      lineIndex++;
    }

    const originalLine = lines[lineIndex];
    const matchedLine = originalLine.replace(regex, replacement);

    previews.push({
      line: lineIndex + 1,
      before: truncateLine(originalLine),
      after: truncateLine(matchedLine),
    });

    // Prevent infinite loop on zero-width matches
    if (match[0].length === 0) {
      searchRegex.lastIndex++;
    }
  }

  return previews;
}

/**
 * Truncate a line for preview
 */
function truncateLine(line: string, maxLength: number = 100): string {
  if (line.length <= maxLength) {
    return line;
  }
  return line.slice(0, maxLength - 3) + '...';
}

export const replaceContentTool: UnifiedTool = {
  name: 'replace-content',
  description: 'Find and replace text/patterns in file, supports regex and dry-run. For AI-powered fixes, use auto-fix instead',
  zodSchema: schema,
  metadata: {
    category: 'edit',
    tags: ['replace', 'regex', 'find'],
    examples: [
      { args: { path: 'src/index.ts', search: 'oldName', replace: 'newName', replaceAll: true }, description: 'Replace all occurrences of a string' },
      { args: { path: 'src/config.ts', search: 'v\\d+\\.\\d+', replace: 'v2.0', isRegex: true, dryRun: true }, description: 'Dry-run regex replacement' },
    ],
    relatedTools: ['auto-fix', 'replace-lines', 'insert-at-line'],
  },

  execute: async (args): Promise<string> => {
    const {
      path: inputPath,
      search,
      replace,
      isRegex,
      replaceAll,
      caseSensitive,
      createBackup,
      dryRun,
    } = args as ReplaceContentArgs;

    // Validate regex if using regex mode
    if (isRegex) {
      try {
        validateRegexPattern(search);
      } catch (regexError) {
        if (regexError instanceof ValidationError) {
          return JSON.stringify({
            success: false,
            error: `Invalid regex pattern: ${regexError.message}`,
            code: regexError.code,
            path: inputPath,
          });
        }
        throw regexError;
      }
    }

    // Common validation: rate limit + path
    const validation = await validateEditRequest('replace-content', inputPath, {
      operation: dryRun ? 'read' : 'write',
      projectRoot: (args as Record<string, unknown>)._sessionCwd as string | undefined,
    });
    if (!validation.ok) return validation.errorResponse;
    const { validatedPath } = validation;

    try {
      // Check file size
      const stats = await fs.stat(validatedPath);
      if (stats.size > MAX_FILE_SIZE) {
        return JSON.stringify({
          success: false,
          error: `File too large: ${stats.size} bytes (max: ${MAX_FILE_SIZE} bytes)`,
          code: 'FILE_TOO_LARGE',
          path: validatedPath,
        });
      }

      // Read file content
      const content = await fs.readFile(validatedPath, 'utf8');

      // Build regex
      let flags = '';
      if (replaceAll) flags += 'g';
      if (!caseSensitive) flags += 'i';

      let regex: RegExp;
      if (isRegex) {
        regex = new RegExp(search, flags);
      } else {
        // Escape special regex characters for literal search
        const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        regex = new RegExp(escaped, flags);
      }

      // Count matches
      const matches = content.match(
        new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g')
      );
      const matchCount = matches ? matches.length : 0;

      if (matchCount === 0) {
        return JSON.stringify({
          success: true,
          path: validatedPath,
          matchCount: 0,
          replacedCount: 0,
          message: 'No matches found',
          dryRun,
        });
      }

      // Calculate how many will be replaced
      const replacedCount = replaceAll ? matchCount : Math.min(1, matchCount);

      // Generate preview
      const preview = findMatchPreviews(content, regex, replace);

      if (dryRun) {
        Logger.debug(
          `replace-content (dry-run): would replace ${replacedCount} of ${matchCount} matches in ${validatedPath}`
        );

        return JSON.stringify({
          success: true,
          path: validatedPath,
          matchCount,
          replacedCount,
          preview,
          dryRun: true,
        });
      }

      // Apply replacement
      const newContent = content.replace(regex, replace);

      // Create backup if requested
      let backupPath: string | null = null;
      if (createBackup) {
        backupPath = await createBackupFile(validatedPath);
      }

      // Write new content
      await fs.writeFile(validatedPath, newContent, 'utf8');

      Logger.debug(`replace-content: replaced ${replacedCount} occurrences in ${validatedPath}`);

      return JSON.stringify({
        success: true,
        path: validatedPath,
        matchCount,
        replacedCount,
        preview,
        backup: backupPath,
        dryRun: false,
      });
    } catch (error) {
      return formatEditError('replace-content', error, validatedPath);
    }
  },
};
