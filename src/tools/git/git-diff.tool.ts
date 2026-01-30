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
  cwd: z.string().optional().describe('Working directory'),
  staged: z.boolean().default(false).describe('Show staged changes'),
  files: z.string().optional().describe('Files to diff, space-separated'),
  commit: z.string().optional().describe('Commit or ref to diff against'),
  commitRange: z
    .string()
    .optional()
    .describe('Commit range to diff'),
  stat: z.boolean().default(false).describe('Show diffstat only'),
  nameOnly: z.boolean().default(false).describe('Show changed file names only'),
  nameStatus: z.boolean().default(false).describe('Show file names and status'),
  context: z.number().min(0).max(100).default(3).describe('Context lines'),
  ignoreWhitespace: z.boolean().default(false).describe('Ignore whitespace'),
  colorWords: z.boolean().default(false).describe('Word-level diff'),
});

export const gitDiffTool: UnifiedTool = {
  name: 'git-diff',
  description: 'Show git diff for staged, unstaged, or commit changes',
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
