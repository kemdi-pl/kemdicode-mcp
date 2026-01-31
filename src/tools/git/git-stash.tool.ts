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
 * Git Stash Tool
 *
 * Manage git stash: push, pop, list, drop, apply, and show stash entries.
 *
 * @module tools/git/git-stash
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { execGit, validateGitRepo, formatGitError } from '../../utils/git-utils.js';

const schema = z.object({
  action: z
    .enum(['push', 'pop', 'list', 'drop', 'apply', 'show'])
    .default('push')
    .describe('Stash action'),
  message: z.string().optional().describe('Stash message (for push)'),
  index: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Stash index (for pop/drop/apply/show)'),
  includeUntracked: z.boolean().default(false).describe('Include untracked files'),
  cwd: z.string().optional().describe('Working directory'),
});

export const gitStashTool: UnifiedTool = {
  name: 'git-stash',
  description: 'Git stash management: push, pop, list, drop, apply, show',
  zodSchema: schema,
  skipContextShare: true,
  metadata: {
    category: 'git',
    tags: ['stash', 'save', 'restore'],
    examples: [
      { args: { action: 'push', message: 'WIP: auth feature', includeUntracked: true }, description: 'Stash changes including untracked files' },
      { args: { action: 'pop', index: 0 }, description: 'Pop the most recent stash entry' },
    ],
    relatedTools: ['git-status', 'git-add', 'git-branch'],
  },
  execute: async (args) => {
    const { action, message, index, includeUntracked, cwd } = args as unknown as z.infer<typeof schema>;

    const repoError = validateGitRepo(cwd);
    if (repoError) {
      return repoError;
    }

    try {
      const stashArgs: string[] = ['stash'];

      switch (action) {
        case 'push': {
          stashArgs.push('push');
          if (includeUntracked) {
            stashArgs.push('--include-untracked');
          }
          if (message) {
            stashArgs.push('-m', message);
          }
          break;
        }
        case 'pop': {
          stashArgs.push('pop');
          if (index !== undefined) {
            stashArgs.push(`stash@{${index}}`);
          }
          break;
        }
        case 'list': {
          stashArgs.push('list');
          break;
        }
        case 'drop': {
          stashArgs.push('drop');
          if (index !== undefined) {
            stashArgs.push(`stash@{${index}}`);
          }
          break;
        }
        case 'apply': {
          stashArgs.push('apply');
          if (index !== undefined) {
            stashArgs.push(`stash@{${index}}`);
          }
          break;
        }
        case 'show': {
          stashArgs.push('show', '-p');
          if (index !== undefined) {
            stashArgs.push(`stash@{${index}}`);
          }
          break;
        }
      }

      const output = execGit(stashArgs, { cwd });

      if (!output.trim()) {
        if (action === 'list') {
          return 'No stash entries found.';
        }
        if (action === 'push') {
          return 'No local changes to save.';
        }
        return `Stash ${action} completed (no output).`;
      }

      return output.trim();
    } catch (error) {
      return formatGitError(error, `Git stash ${action}`);
    }
  },
};
