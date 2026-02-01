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
 * Git Blame Tool
 *
 * Show line-by-line history for a file, with optional
 * date formatting and line range support.
 *
 * @module tools/git/git-blame
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import {
  execGit,
  validateGitRepo,
  formatGitError,
  enhanceGitErrorMessage,
  executeGitTool,
} from '../../utils/git-utils.js';

const schema = z.object({
  file: z.string().min(1).describe('File path to blame'),
  cwd: z.string().optional().describe('Working directory'),
  lineStart: z.number().min(1).optional().describe('Start line'),
  lineEnd: z.number().min(1).optional().describe('End line'),
  showEmail: z.boolean().default(false).describe('Show email instead of name'),
  showDate: z.boolean().default(true).describe('Show date'),
  dateFormat: z
    .enum(['relative', 'local', 'iso', 'short', 'human'])
    .default('short')
    .describe('Date format'),
  ignoreWhitespace: z.boolean().default(false).describe('Ignore whitespace'),
  ignoreRevs: z
    .string()
    .optional()
    .describe('Ignore-revs file path'),
  showMovement: z
    .boolean()
    .default(false)
    .describe('Detect line movement across files'),
  rev: z.string().optional().describe('Blame at specific revision'),
  porcelain: z.boolean().default(false).describe('Machine-readable output'),
});

export const gitBlameTool: UnifiedTool = {
  name: 'git-blame',
  description: 'Line-by-line git blame with author and commit info',
  zodSchema: schema,
  skipContextShare: true,
  metadata: {
    category: 'git',
    tags: ['blame', 'history', 'authorship'],
    examples: [
      { args: { file: 'src/index.ts' }, description: 'Show blame for entire file' },
      { args: { file: 'src/utils.ts', lineStart: 10, lineEnd: 25, dateFormat: 'relative' }, description: 'Blame specific line range with relative dates' },
    ],
    relatedTools: ['git-log', 'git-diff'],
  },
  execute: async (args) => {
    const {
      file,
      cwd,
      lineStart,
      lineEnd,
      showEmail,
      showDate,
      dateFormat,
      ignoreWhitespace,
      ignoreRevs,
      showMovement,
      rev,
      porcelain,
    } = args as z.infer<typeof schema>;

    if (!file || !file.trim()) {
      return 'Error: File path is required for git blame.';
    }
    if (lineStart !== undefined && lineEnd !== undefined && lineEnd < lineStart) {
      return `Error: lineEnd (${lineEnd}) must be >= lineStart (${lineStart})`;
    }

    return executeGitTool('git-blame', cwd, () => {
      const blameArgs: string[] = ['blame'];
      if (porcelain) blameArgs.push('--porcelain');
      if (showEmail) blameArgs.push('-e');
      if (showDate && !porcelain) blameArgs.push(`--date=${dateFormat}`);
      if (lineStart !== undefined && lineEnd !== undefined) blameArgs.push(`-L${lineStart},${lineEnd}`);
      else if (lineStart !== undefined) blameArgs.push(`-L${lineStart},`);
      else if (lineEnd !== undefined) blameArgs.push(`-L1,${lineEnd}`);
      if (ignoreWhitespace) blameArgs.push('-w');
      if (ignoreRevs) blameArgs.push(`--ignore-revs-file=${ignoreRevs}`);
      if (showMovement) blameArgs.push('-C', '-C', '-C');
      if (rev) blameArgs.push(rev);
      blameArgs.push('--', file);

      const output = execGit(blameArgs, { cwd });
      if (!output.trim()) return `No blame information available for '${file}'.`;
      return output.trim();
    });
  },
};
