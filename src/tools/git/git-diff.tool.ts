/**
 * KemdiCode MCP Server
 * Copyright (C) 2025-2026 Kemdi Sp. z o.o. (Dawid Irzyk <dawid@kemdi.pl>)
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
import { execGit, executeGitTool, parseFileList } from '../../utils/git-utils.js';
import { isSilent } from '../../config/silent.js';

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
  format: z.enum(['text', 'json']).default('text').describe('Output format'),
});

export const gitDiffTool: UnifiedTool = {
  name: 'git-diff',
  description: 'Show git diff for staged, unstaged, or commit changes',
  zodSchema: schema,
  skipContextShare: true,
  metadata: {
    category: 'git',
    tags: ['diff', 'changes'],
    examples: [
      { args: { staged: true }, description: 'Show staged changes' },
      { args: { commit: 'HEAD~3', stat: true }, description: 'Show diffstat against 3 commits ago' },
    ],
    relatedTools: ['git-status', 'git-log', 'file-diff'],
  },
  execute: async (args) => {
    const { cwd, staged, files, commit, commitRange, stat, nameOnly, nameStatus, context, ignoreWhitespace, colorWords, format } = args as z.infer<typeof schema>;

    return executeGitTool('git-diff', cwd, () => {
      const diffArgs: string[] = ['diff', '--no-color'];
      if (staged) diffArgs.push('--staged');
      if (nameOnly) diffArgs.push('--name-only');
      else if (nameStatus) diffArgs.push('--name-status');
      else if (stat) diffArgs.push('--stat');
      if (context !== 3) diffArgs.push(`-U${context}`);
      if (ignoreWhitespace) diffArgs.push('-w');
      if (colorWords) diffArgs.push('--color-words');
      if (commitRange) diffArgs.push(commitRange);
      else if (commit) diffArgs.push(commit);
      if (files) { diffArgs.push('--'); diffArgs.push(...parseFileList(files)); }

      const output = execGit(diffArgs, { cwd });

      if (!output.trim()) {
        const message = staged ? 'No staged changes.'
          : commitRange ? `No differences between ${commitRange}.`
          : commit ? `No differences from ${commit}.`
          : 'No changes detected.';
        return format === 'json' ? JSON.stringify({ success: true, output: message, tool: 'git-diff' }) : message;
      }

      const result = output.trim();
      if (format === 'json' && !isSilent()) {
        return JSON.stringify({ success: true, output: result, tool: 'git-diff' });
      }
      return result;
    });
  },
};
