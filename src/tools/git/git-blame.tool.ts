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
 * Git Blame Tool
 *
 * Show line-by-line history for a file, with optional
 * date formatting and line range support.
 *
 * @module tools/git/git-blame
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import {
  execGit,
  validateGitRepo,
  formatGitError,
  enhanceGitErrorMessage,
} from '../../utils/git-utils.js';

const schema = z.object({
  file: z.string().min(1).describe('File path to blame (required)'),
  cwd: z.string().optional().describe('Working directory path (defaults to current directory)'),
  lineStart: z.number().min(1).optional().describe('Start line number for range'),
  lineEnd: z.number().min(1).optional().describe('End line number for range'),
  showEmail: z.boolean().default(false).describe('Show author email instead of name'),
  showDate: z.boolean().default(true).describe('Show commit date'),
  dateFormat: z
    .enum(['relative', 'local', 'iso', 'short', 'human'])
    .default('short')
    .describe('Date format (relative, local, iso, short, human)'),
  ignoreWhitespace: z.boolean().default(false).describe('Ignore whitespace changes'),
  ignoreRevs: z
    .string()
    .optional()
    .describe('Ignore commits from this file (e.g., .git-blame-ignore-revs)'),
  showMovement: z
    .boolean()
    .default(false)
    .describe('Show line movement from other files (-C -C -C)'),
  rev: z.string().optional().describe('Blame at specific revision (commit SHA or ref)'),
  porcelain: z.boolean().default(false).describe('Machine-readable output format'),
});

export const gitBlameTool: UnifiedTool = {
  name: 'git-blame',
  description: 'Show line-by-line git history for a file with author, date, and commit info',
  zodSchema: schema,
  skipContextShare: true,
  execute: async (args) => {
    const {
      file,
      cwd,
      lineStart,
      lineEnd,
      showEmail,
      showDate,
      dateFormat,
      ignoreWhitespace,
      ignoreRevs,
      showMovement,
      rev,
      porcelain,
    } = args as z.infer<typeof schema>;

    // Validate file parameter
    if (!file || !file.trim()) {
      return 'Error: File path is required for git blame.';
    }

    // Check if directory is a git repo
    const repoError = validateGitRepo(cwd);
    if (repoError) {
      return repoError;
    }

    // Note: git blame doesn't support --color=never or --no-color
    // It only has --color-lines and --color-by-age for enabling color
    // Default output is already uncolored
    const blameArgs: string[] = ['blame'];

    // Porcelain output (machine-readable)
    if (porcelain) {
      blameArgs.push('--porcelain');
    }

    // Email or name
    if (showEmail) {
      blameArgs.push('-e');
    }

    // Date format
    if (showDate && !porcelain) {
      blameArgs.push(`--date=${dateFormat}`);
    }

    // Line range
    if (lineStart !== undefined && lineEnd !== undefined) {
      if (lineEnd < lineStart) {
        return `Error: lineEnd (${lineEnd}) must be >= lineStart (${lineStart})`;
      }
      blameArgs.push(`-L${lineStart},${lineEnd}`);
    } else if (lineStart !== undefined) {
      // Just start line - blame from that line to end
      blameArgs.push(`-L${lineStart},`);
    } else if (lineEnd !== undefined) {
      // Just end line - blame from start to that line
      blameArgs.push(`-L1,${lineEnd}`);
    }

    // Ignore whitespace
    if (ignoreWhitespace) {
      blameArgs.push('-w');
    }

    // Ignore revs file
    if (ignoreRevs) {
      blameArgs.push(`--ignore-revs-file=${ignoreRevs}`);
    }

    // Show line movement
    if (showMovement) {
      blameArgs.push('-C', '-C', '-C');
    }

    // Specific revision
    if (rev) {
      blameArgs.push(rev);
    }

    // Add the file
    blameArgs.push('--', file);

    try {
      const output = execGit(blameArgs, { cwd });

      // If output is empty, provide a helpful message
      if (!output.trim()) {
        return `No blame information available for '${file}'.`;
      }

      return output.trim();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const enhanced = enhanceGitErrorMessage(message);

      // Add context for specific errors
      if (message.includes('no such path')) {
        return `Error: File '${file}' not found in repository.`;
      }
      if (message.includes('bad revision')) {
        return `Error: Invalid revision '${rev}'.`;
      }

      return formatGitError(new Error(enhanced), 'Git blame');
    }
  },
};
