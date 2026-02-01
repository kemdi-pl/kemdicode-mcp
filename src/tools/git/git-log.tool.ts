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
 * Git Log Tool
 *
 * Show commit history with various format options,
 * limit/date filters, and author filtering.
 *
 * @module tools/git/git-log
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { execGit, executeGitTool, parseFileList } from '../../utils/git-utils.js';

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
  metadata: {
    category: 'git',
    tags: ['log', 'history', 'commits'],
    examples: [
      { args: { limit: 20, format: 'oneline' }, description: 'Show last 20 commits in oneline format' },
      { args: { author: 'dawid', since: '2025-01-01', stat: true }, description: 'Show commits by author since a date with stats' },
    ],
    relatedTools: ['git-blame', 'git-diff', 'git-branch'],
  },
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

    // Ref validation before entering git wrapper (needs early return with custom message)
    if (ref && ref.startsWith('-')) {
      return `Error: Invalid ref '${ref}'. Refs must not start with '-'.`;
    }

    return executeGitTool('git-log', cwd, () => {
      const logArgs: string[] = ['log', '--no-color'];
      if (format === 'oneline') logArgs.push('--oneline');
      else logArgs.push(`--format=${format}`);
      logArgs.push(`-n${limit}`);
      if (author) logArgs.push(`--author=${author}`);
      if (since) logArgs.push(`--since=${since}`);
      if (until) logArgs.push(`--until=${until}`);
      if (grep) logArgs.push(`--grep=${grep}`);
      if (all) logArgs.push('--all');
      if (graph) { logArgs.push('--graph'); logArgs.push('--decorate'); }
      if (stat) logArgs.push('--stat');
      if (patch) logArgs.push('-p');
      if (!merges) logArgs.push('--no-merges');
      if (firstParent) logArgs.push('--first-parent');
      if (ref) logArgs.push(ref);
      if (files) { logArgs.push('--'); logArgs.push(...parseFileList(files)); }

      const output = execGit(logArgs, { cwd });
      if (!output.trim()) {
        const filters = [];
        if (author) filters.push(`author: ${author}`);
        if (since) filters.push(`since: ${since}`);
        if (until) filters.push(`until: ${until}`);
        if (grep) filters.push(`grep: ${grep}`);
        if (files) filters.push(`files: ${files}`);
        return filters.length > 0 ? `No commits found matching filters: ${filters.join(', ')}` : 'No commits found.';
      }
      return output.trim();
    });
  },
};
