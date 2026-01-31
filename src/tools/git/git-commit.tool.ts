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
 * Git Commit Tool
 *
 * Create a git commit with message. Supports auto-staging, amend, and empty commits.
 * SAFETY: Does not support --no-verify or force flags.
 *
 * @module tools/git/git-commit
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { execGit, validateGitRepo, formatGitError } from '../../utils/git-utils.js';

const schema = z.object({
  message: z.string().min(1).max(500).describe('Commit message'),
  all: z.boolean().default(false).describe('Auto-stage modified files (-a)'),
  amend: z.boolean().default(false).describe('Amend last commit'),
  allowEmpty: z.boolean().default(false).describe('Allow empty commit'),
  cwd: z.string().optional().describe('Working directory'),
});

export const gitCommitTool: UnifiedTool = {
  name: 'git-commit',
  description: 'Create git commit with message, optional auto-stage, amend, or empty commit',
  zodSchema: schema,
  skipContextShare: true,
  metadata: {
    category: 'git',
    tags: ['commit', 'save'],
    examples: [
      { args: { message: 'feat: add user authentication' }, description: 'Create a commit with staged changes' },
      { args: { message: 'fix: resolve login bug', all: true }, description: 'Auto-stage modified files and commit' },
    ],
    relatedTools: ['git-add', 'git-status', 'git-log'],
  },
  execute: async (args) => {
    const { message, all, amend, allowEmpty, cwd } = args as unknown as z.infer<typeof schema>;

    const repoError = validateGitRepo(cwd);
    if (repoError) {
      return repoError;
    }

    try {
      const commitArgs: string[] = ['commit'];

      if (all) {
        commitArgs.push('-a');
      }
      if (amend) {
        commitArgs.push('--amend');
      }
      if (allowEmpty) {
        commitArgs.push('--allow-empty');
      }

      commitArgs.push('-m', message);

      const output = execGit(commitArgs, { cwd });

      // Get the commit hash for the summary
      const hash = execGit(['rev-parse', '--short', 'HEAD'], { cwd }).trim();

      return `Commit ${hash} created successfully.\n\n${output.trim()}`;
    } catch (error) {
      return formatGitError(error, 'Git commit');
    }
  },
};
