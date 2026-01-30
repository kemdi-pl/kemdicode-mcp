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
 * Git Status Tool
 *
 * Get current repository status including changed files, staged changes,
 * untracked files, and branch information.
 *
 * @module tools/git/git-status
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { execGit, validateGitRepo, formatGitError } from '../../utils/git-utils.js';

const schema = z.object({
  cwd: z.string().optional().describe('Working directory'),
  short: z.boolean().default(false).describe('Short format'),
  branch: z.boolean().default(true).describe('Show branch info'),
  showStash: z.boolean().default(false).describe('Show stash info'),
  ignored: z.boolean().default(false).describe('Show ignored files'),
  untracked: z
    .enum(['no', 'normal', 'all'])
    .default('normal')
    .describe('Untracked files mode'),
});

export const gitStatusTool: UnifiedTool = {
  name: 'git-status',
  description: 'Git repo status: changed, staged, untracked files and branch',
  zodSchema: schema,
  skipContextShare: true, // Git tools are utility tools, skip context sharing
  execute: async (args) => {
    const { cwd, short, branch, showStash, ignored, untracked } = args as z.infer<typeof schema>;

    // Check if directory is a git repo
    const repoError = validateGitRepo(cwd);
    if (repoError) {
      return repoError;
    }

    const statusArgs: string[] = ['status'];

    // Add flags
    if (short) {
      statusArgs.push('--short');
    }
    if (branch) {
      statusArgs.push('--branch');
    }
    if (showStash) {
      statusArgs.push('--show-stash');
    }
    if (ignored) {
      statusArgs.push('--ignored');
    }
    if (untracked) {
      statusArgs.push(`--untracked-files=${untracked}`);
    }

    try {
      const output = execGit(statusArgs, { cwd });

      // If output is empty, provide a helpful message
      if (!output.trim()) {
        return 'Working tree clean - no changes to commit.';
      }

      return output.trim();
    } catch (error) {
      return formatGitError(error, 'Git status');
    }
  },
};
