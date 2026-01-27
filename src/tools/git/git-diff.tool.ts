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
 * Git Diff Tool
 *
 * Show changes between commits, commit and working tree, etc.
 * Supports staged/cached changes, file filters, and unified diff output.
 *
 * @module tools/git/git-diff
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { execGit, validateGitRepo, parseFileList, formatGitError } from '../../utils/git-utils.js';

const schema = z.object({
  cwd: z.string().optional().describe('Working directory path (defaults to current directory)'),
  staged: z.boolean().default(false).describe('Show staged/cached changes (same as --cached)'),
  files: z.string().optional().describe('Space-separated list of files to diff'),
  commit: z.string().optional().describe('Commit SHA or ref to diff against (e.g., HEAD~1, main)'),
  commitRange: z
    .string()
    .optional()
    .describe('Commit range to diff (e.g., main..feature, abc123..def456)'),
  stat: z.boolean().default(false).describe('Show diffstat instead of full diff'),
  nameOnly: z.boolean().default(false).describe('Show only names of changed files'),
  nameStatus: z.boolean().default(false).describe('Show names and status of changed files'),
  context: z.number().min(0).max(100).default(3).describe('Number of context lines (default: 3)'),
  ignoreWhitespace: z.boolean().default(false).describe('Ignore whitespace changes'),
  colorWords: z.boolean().default(false).describe('Show word-level diff with colors'),
});

export const gitDiffTool: UnifiedTool = {
  name: 'git-diff',
  description:
    'Show git diff with support for staged changes, file filters, and various output formats',
  zodSchema: schema,
  skipContextShare: true,
  execute: async (args) => {
    const {
      cwd,
      staged,
      files,
      commit,
      commitRange,
      stat,
      nameOnly,
      nameStatus,
      context,
      ignoreWhitespace,
      colorWords,
    } = args as z.infer<typeof schema>;

    // Check if directory is a git repo
    const repoError = validateGitRepo(cwd);
    if (repoError) {
      return repoError;
    }

    const diffArgs: string[] = ['diff', '--no-color'];

    // Add staged/cached flag
    if (staged) {
      diffArgs.push('--staged');
    }

    // Output format flags (mutually exclusive priority)
    if (nameOnly) {
      diffArgs.push('--name-only');
    } else if (nameStatus) {
      diffArgs.push('--name-status');
    } else if (stat) {
      diffArgs.push('--stat');
    }

    // Context lines
    if (context !== 3) {
      diffArgs.push(`-U${context}`);
    }

    // Whitespace handling
    if (ignoreWhitespace) {
      diffArgs.push('-w');
    }

    // Color words
    if (colorWords) {
      diffArgs.push('--color-words');
    }

    // Commit or commit range
    if (commitRange) {
      diffArgs.push(commitRange);
    } else if (commit) {
      diffArgs.push(commit);
    }

    // Add specific files if provided
    if (files) {
      diffArgs.push('--');
      diffArgs.push(...parseFileList(files));
    }

    try {
      const output = execGit(diffArgs, { cwd });

      // If output is empty, provide a helpful message
      if (!output.trim()) {
        if (staged) {
          return 'No staged changes.';
        } else if (commitRange) {
          return `No differences between ${commitRange}.`;
        } else if (commit) {
          return `No differences from ${commit}.`;
        }
        return 'No changes detected.';
      }

      return output.trim();
    } catch (error) {
      return formatGitError(error, 'Git diff');
    }
  },
};
