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
 * Git Branch Tool
 *
 * List, create, and delete git branches.
 * Show current branch, remote branches, and tracking info.
 *
 * @module tools/git/git-branch
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import {
  execGit,
  validateGitRepo,
  getCurrentBranch,
  formatGitError,
  enhanceGitErrorMessage,
} from '../../utils/git-utils.js';

const schema = z.object({
  cwd: z.string().optional().describe('Working directory'),
  action: z
    .enum(['list', 'create', 'delete', 'rename', 'current'])
    .default('list')
    .describe('Action to perform'),
  name: z.string().optional().describe('Branch name (required for create/delete/rename)'),
  newName: z.string().optional().describe('New name (required for rename)'),
  all: z.boolean().default(false).describe('Include remote branches'),
  remotes: z.boolean().default(false).describe('Remote branches only'),
  verbose: z.boolean().default(false).describe('Show tracking info'),
  merged: z.boolean().optional().describe('Only merged branches'),
  noMerged: z.boolean().optional().describe('Only unmerged branches'),
  force: z.boolean().default(false).describe('Force delete'),
  startPoint: z.string().optional().describe('Start point for new branch'),
  track: z.boolean().default(true).describe('Set up tracking'),
  showCurrent: z.boolean().default(true).describe('Highlight current branch'),
});

export const gitBranchTool: UnifiedTool = {
  name: 'git-branch',
  description: 'Manage git branches: list, create, delete, rename',
  zodSchema: schema,
  skipContextShare: true,
  metadata: {
    category: 'git',
    tags: ['branch', 'management'],
    examples: [
      { args: { action: 'list', verbose: true }, description: 'List all local branches with tracking info' },
      { args: { action: 'create', name: 'feature/auth', startPoint: 'main' }, description: 'Create a new branch from main' },
    ],
    relatedTools: ['git-status', 'git-log'],
  },
  execute: async (args) => {
    const {
      cwd,
      action,
      name,
      newName,
      all,
      remotes,
      verbose,
      merged,
      noMerged,
      force,
      startPoint,
      track,
    } = args as z.infer<typeof schema>;

    // Check if directory is a git repo
    const repoError = validateGitRepo(cwd);
    if (repoError) {
      return repoError;
    }

    try {
      switch (action) {
        case 'current': {
          const currentBranch = getCurrentBranch(cwd);
          return `Current branch: ${currentBranch}`;
        }

        case 'list': {
          const listArgs: string[] = ['branch', '--no-color'];

          if (all) {
            listArgs.push('-a');
          } else if (remotes) {
            listArgs.push('-r');
          }

          if (verbose) {
            listArgs.push('-vv');
          }

          if (merged === true) {
            listArgs.push('--merged');
          } else if (noMerged === true) {
            listArgs.push('--no-merged');
          }

          const output = execGit(listArgs, { cwd });

          if (!output.trim()) {
            return 'No branches found.';
          }

          // Add header with current branch info
          const currentBranch = getCurrentBranch(cwd);
          const header = `Current branch: ${currentBranch}\n\nBranches:\n`;
          return header + output.trim();
        }

        case 'create': {
          if (!name || !name.trim()) {
            return 'Error: Branch name is required for create action.';
          }

          const createArgs: string[] = ['branch'];

          if (track) {
            createArgs.push('--track');
          } else {
            createArgs.push('--no-track');
          }

          createArgs.push(name);

          if (startPoint) {
            createArgs.push(startPoint);
          }

          execGit(createArgs, { cwd });
          return `Branch '${name}' created successfully.${startPoint ? ` Based on: ${startPoint}` : ''}`;
        }

        case 'delete': {
          if (!name || !name.trim()) {
            return 'Error: Branch name is required for delete action.';
          }

          // Check if trying to delete current branch
          const currentBranch = getCurrentBranch(cwd);
          if (name === currentBranch) {
            return `Error: Cannot delete current branch '${name}'. Switch to another branch first.`;
          }

          const deleteArgs: string[] = ['branch'];
          deleteArgs.push(force ? '-D' : '-d');
          deleteArgs.push(name);

          execGit(deleteArgs, { cwd });
          return `Branch '${name}' deleted successfully.`;
        }

        case 'rename': {
          if (!name || !name.trim()) {
            return 'Error: Current branch name is required for rename action.';
          }
          if (!newName || !newName.trim()) {
            return 'Error: New branch name is required for rename action.';
          }

          const renameArgs: string[] = ['branch', '-m', name, newName];
          execGit(renameArgs, { cwd });
          return `Branch '${name}' renamed to '${newName}' successfully.`;
        }

        default:
          return `Error: Unknown action '${action}'. Valid actions: list, create, delete, rename, current`;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const enhanced = enhanceGitErrorMessage(message);

      // Provide more helpful error messages with context
      if (message.includes('already exists')) {
        return `Error: Branch '${name}' already exists.`;
      }
      if (message.includes('not found')) {
        return `Error: Branch '${name}' not found.`;
      }
      if (message.includes('not fully merged')) {
        return `Error: Branch '${name}' is not fully merged. Use force=true to delete anyway.`;
      }
      if (message.includes('invalid branch name')) {
        return `Error: Invalid branch name '${name}'.`;
      }

      return formatGitError(new Error(enhanced), 'Git branch');
    }
  },
};
