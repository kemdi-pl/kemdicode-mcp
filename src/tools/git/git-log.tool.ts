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
 * Git Log Tool
 *
 * Show commit history with various format options,
 * limit/date filters, and author filtering.
 *
 * @module tools/git/git-log
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { execGit, validateGitRepo, parseFileList, formatGitError } from '../../utils/git-utils.js';

const schema = z.object({
  cwd: z.string().optional().describe('Working directory'),
  format: z
    .enum(['oneline', 'short', 'medium', 'full', 'fuller', 'email', 'raw'])
    .default('medium')
    .describe('Output format'),
  limit: z.number().min(1).max(1000).default(10).describe('Max commits'),
  author: z.string().optional().describe('Filter by author'),
  since: z
    .string()
    .optional()
    .describe('Commits after date'),
  until: z.string().optional().describe('Commits before date'),
  grep: z.string().optional().describe('Filter by message pattern'),
  files: z.string().optional().describe('Files to filter, space-separated'),
  all: z.boolean().default(false).describe('Show all branches'),
  graph: z.boolean().default(false).describe('Show ASCII branch graph'),
  stat: z.boolean().default(false).describe('Show file stats per commit'),
  patch: z.boolean().default(false).describe('Show patch per commit'),
  merges: z.boolean().default(true).describe('Include merge commits'),
  firstParent: z.boolean().default(false).describe('Follow first parent only'),
  ref: z.string().optional().describe('Branch, tag, or ref'),
});

export const gitLogTool: UnifiedTool = {
  name: 'git-log',
  description: 'Show git commit history with filters and format options',
  zodSchema: schema,
  skipContextShare: true,
  execute: async (args) => {
    const {
      cwd,
      format,
      limit,
      author,
      since,
      until,
      grep,
      files,
      all,
      graph,
      stat,
      patch,
      merges,
      firstParent,
      ref,
    } = args as z.infer<typeof schema>;

    // Check if directory is a git repo
    const repoError = validateGitRepo(cwd);
    if (repoError) {
      return repoError;
    }

    const logArgs: string[] = ['log', '--no-color'];

    // Format
    if (format === 'oneline') {
      logArgs.push('--oneline');
    } else {
      logArgs.push(`--format=${format}`);
    }

    // Limit
    logArgs.push(`-n${limit}`);

    // Author filter
    if (author) {
      logArgs.push(`--author=${author}`);
    }

    // Date filters
    if (since) {
      logArgs.push(`--since=${since}`);
    }
    if (until) {
      logArgs.push(`--until=${until}`);
    }

    // Message filter
    if (grep) {
      logArgs.push(`--grep=${grep}`);
    }

    // All branches
    if (all) {
      logArgs.push('--all');
    }

    // Graph
    if (graph) {
      logArgs.push('--graph');
      // Add decorations for graph view
      logArgs.push('--decorate');
    }

    // Statistics
    if (stat) {
      logArgs.push('--stat');
    }

    // Patch/diff
    if (patch) {
      logArgs.push('-p');
    }

    // Merge commits
    if (!merges) {
      logArgs.push('--no-merges');
    }

    // First parent only
    if (firstParent) {
      logArgs.push('--first-parent');
    }

    // Specific ref (prevent flag injection via refs starting with --)
    if (ref) {
      if (ref.startsWith('-')) {
        return `Error: Invalid ref '${ref}'. Refs must not start with '-'.`;
      }
      logArgs.push(ref);
    }

    // Specific files
    if (files) {
      logArgs.push('--');
      logArgs.push(...parseFileList(files));
    }

    try {
      const output = execGit(logArgs, { cwd });

      // If output is empty, provide a helpful message
      if (!output.trim()) {
        const filters = [];
        if (author) filters.push(`author: ${author}`);
        if (since) filters.push(`since: ${since}`);
        if (until) filters.push(`until: ${until}`);
        if (grep) filters.push(`grep: ${grep}`);
        if (files) filters.push(`files: ${files}`);

        if (filters.length > 0) {
          return `No commits found matching filters: ${filters.join(', ')}`;
        }
        return 'No commits found.';
      }

      return output.trim();
    } catch (error) {
      return formatGitError(error, 'Git log');
    }
  },
};
