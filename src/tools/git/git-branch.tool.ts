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
  cwd: z.string().optional().describe('Working directory path (defaults to current directory)'),
  action: z
    .enum(['list', 'create', 'delete', 'rename', 'current'])
    .default('list')
    .describe('Action: list, create, delete, rename, or current'),
  name: z.string().optional().describe('Branch name (required for create/delete/rename)'),
  newName: z.string().optional().describe('New branch name (required for rename)'),
  all: z.boolean().default(false).describe('List all branches including remotes'),
  remotes: z.boolean().default(false).describe('List only remote branches'),
  verbose: z.boolean().default(false).describe('Show commit message and tracking info'),
  merged: z.boolean().optional().describe('List only merged branches (with list action)'),
  noMerged: z.boolean().optional().describe('List only unmerged branches (with list action)'),
  force: z.boolean().default(false).describe('Force delete even if not merged'),
  startPoint: z.string().optional().describe('Start point for new branch (commit SHA or ref)'),
  track: z.boolean().default(true).describe('Set up tracking for new branch'),
  showCurrent: z.boolean().default(true).describe('Highlight current branch in list'),
});

export const gitBranchTool: UnifiedTool = {
  name: 'git-branch',
  description: 'List, create, delete, or rename git branches with tracking info',
  zodSchema: schema,
  skipContextShare: true,
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
