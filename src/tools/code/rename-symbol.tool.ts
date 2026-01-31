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
 * Rename Symbol Tool
 *
 * Renames a symbol across the codebase using find-and-replace.
 * Supports dry-run mode to preview changes before applying.
 *
 * @module tools/code/rename-symbol
 */

import { z } from 'zod';
import { promises as fs } from 'fs';
import { UnifiedTool } from '../registry.js';
import { executeCommand } from '../../utils/commandExecutor.js';
import { Logger } from '../../utils/logger.js';
import { validatePath, ValidationError, checkRateLimit } from '../../utils/validation.js';
import { isSilent } from '../../config/silent.js';

/**
 * Get file type filters for ripgrep
 */
function getTypeFilters(language: string): string[] {
  switch (language) {
    case 'ts':
      return ['--type', 'ts', '--type', 'js'];
    case 'php':
      return ['--type', 'php'];
    case 'py':
      return ['--type', 'py'];
    case 'go':
      return ['--type', 'go'];
    case 'rs':
      return ['--type', 'rust'];
    case 'auto':
      return [
        '--type',
        'ts',
        '--type',
        'js',
        '--type',
        'php',
        '--type',
        'py',
        '--type',
        'go',
        '--type',
        'rust',
      ];
    default:
      return [];
  }
}

const schema = z.object({
  oldName: z.string().min(1).describe('Current symbol name'),
  newName: z.string().min(1).describe('New symbol name'),
  path: z.string().optional().describe('Scope directory or file'),
  language: z
    .enum(['ts', 'php', 'py', 'go', 'rs', 'auto'])
    .default('auto')
    .describe('Target language'),
  dryRun: z.boolean().default(true).describe('Preview without applying'),
  createBackups: z.boolean().default(true).describe('Create backups'),
});

type RenameSymbolArgs = z.infer<typeof schema>;

interface FileChange {
  file: string;
  occurrences: number;
  lines: number[];
}

/**
 * Find all occurrences of a symbol using ripgrep
 */
async function findSymbolOccurrences(
  symbol: string,
  language: string,
  searchPath: string
): Promise<Map<string, number[]>> {
  const typeFilters = getTypeFilters(language);

  // Use word boundary to match whole words only
  const pattern = `\\b${symbol}\\b`;

  const occurrences = new Map<string, number[]>();

  const args = [
    '-n',
    '-H',
    '--no-heading',
    '--color=never',
    '-e',
    pattern,
    ...typeFilters,
    searchPath,
  ];

  try {
    const output = await executeCommand('rg', args);
    const lines = output.split('\n').filter((l) => l.trim());

    for (const line of lines) {
      const match = line.match(/^([^:]+):(\d+):/);
      if (match) {
        const file = match[1];
        const lineNum = parseInt(match[2], 10);

        if (!occurrences.has(file)) {
          occurrences.set(file, []);
        }
        occurrences.get(file)!.push(lineNum);
      }
    }
  } catch {
    // No matches found (rg returns exit code 1)
  }

  return occurrences;
}

/**
 * Replace symbol in a file
 */
async function replaceInFile(
  filePath: string,
  oldName: string,
  newName: string,
  createBackup: boolean
): Promise<number> {
  const content = await fs.readFile(filePath, 'utf8');

  // Create word-boundary regex
  const regex = new RegExp(`\\b${oldName}\\b`, 'g');

  // Count replacements
  const matches = content.match(regex);
  const count = matches ? matches.length : 0;

  if (count === 0) {
    return 0;
  }

  // Create backup if requested
  if (createBackup) {
    await fs.copyFile(filePath, `${filePath}.bak`);
  }

  // Replace and write
  const newContent = content.replace(regex, newName);
  await fs.writeFile(filePath, newContent, 'utf8');

  return count;
}

export const renameSymbolTool: UnifiedTool = {
  name: 'rename-symbol',
  description: 'Rename symbol across codebase, supports dry-run',
  zodSchema: schema,
  metadata: {
    category: 'code',
    tags: ['rename', 'refactor', 'ast'],
    examples: [
      {
        args: { oldName: 'UserService', newName: 'AccountService', path: 'src/', dryRun: true },
        description: 'Preview renaming UserService to AccountService across all files in src/',
      },
    ],
    relatedTools: ['find-references', 'find-definition', 'refactor'],
  },

  execute: async (args): Promise<string> => {
    const {
      oldName,
      newName,
      path: inputPath,
      language,
      dryRun,
      createBackups,
    } = args as RenameSymbolArgs;

    // Rate limit check
    if (!checkRateLimit('edit-operations', { maxRequests: 20, windowMs: 60000 })) {
      return JSON.stringify({
        success: false,
        error: 'Rate limit exceeded for rename operations',
        code: 'RATE_LIMIT_EXCEEDED',
      });
    }

    // Validate names
    if (oldName === newName) {
      return JSON.stringify({
        success: false,
        error: 'Old and new names are identical',
        code: 'NAMES_IDENTICAL',
      });
    }

    // Check for valid identifier pattern
    const identifierPattern = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;
    if (!identifierPattern.test(newName)) {
      return JSON.stringify({
        success: false,
        error: `Invalid identifier: ${newName}`,
        code: 'INVALID_IDENTIFIER',
      });
    }

    const searchPath = inputPath || process.cwd();

    try {
      // Find all occurrences
      const occurrences = await findSymbolOccurrences(oldName, language, searchPath);

      if (occurrences.size === 0) {
        return JSON.stringify({
          success: true,
          message: `No occurrences of '${oldName}' found`,
          filesChanged: 0,
          occurrencesReplaced: 0,
          dryRun,
        });
      }

      // Build change summary
      const changes: FileChange[] = [];
      let totalOccurrences = 0;

      for (const [file, lines] of occurrences) {
        changes.push({
          file,
          occurrences: lines.length,
          lines: [...new Set(lines)].sort((a, b) => a - b),
        });
        totalOccurrences += lines.length;
      }

      if (dryRun) {
        Logger.debug(
          `rename-symbol (dry-run): would rename '${oldName}' to '${newName}' in ${changes.length} files (${totalOccurrences} occurrences)`
        );

        return JSON.stringify({
          success: true,
          oldName,
          newName,
          filesChanged: changes.length,
          occurrencesReplaced: totalOccurrences,
          changes: changes.slice(0, 20), // Limit preview
          dryRun: true,
          language,
        });
      }

      // Apply changes
      let filesModified = 0;
      let totalReplaced = 0;
      const errors: string[] = [];

      for (const change of changes) {
        try {
          // Validate path
          const validatedPath = await validatePath(change.file, {
            allowSymlinks: false,
            requireWithinProject: false,
            operation: 'write',
            projectRoot: (args as Record<string, unknown>)._sessionCwd as string | undefined,
          });

          const replaced = await replaceInFile(validatedPath, oldName, newName, createBackups);
          if (replaced > 0) {
            filesModified++;
            totalReplaced += replaced;
          }
        } catch (error) {
          if (error instanceof ValidationError) {
            errors.push(`${change.file}: ${error.message}`);
          } else {
            errors.push(
              `${change.file}: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        }
      }

      Logger.debug(
        `rename-symbol: renamed '${oldName}' to '${newName}' in ${filesModified} files (${totalReplaced} occurrences)`
      );

      if (isSilent()) {
        return JSON.stringify({ filesChanged: filesModified, replaced: totalReplaced });
      }

      return JSON.stringify({
        success: errors.length === 0,
        oldName,
        newName,
        filesChanged: filesModified,
        occurrencesReplaced: totalReplaced,
        changes: changes.slice(0, 20),
        errors: errors.length > 0 ? errors : undefined,
        backupsCreated: createBackups,
        dryRun: false,
        language,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      Logger.error(`rename-symbol error: ${errorMessage}`);

      return JSON.stringify({
        success: false,
        error: errorMessage,
      });
    }
  },
};
