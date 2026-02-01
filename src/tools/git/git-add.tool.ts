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
 * Git Add Tool
 *
 * Stage files for commit. Supports staging specific files or all changes.
 *
 * @module tools/git/git-add
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { execGit, executeGitTool } from '../../utils/git-utils.js';
import { isSilent } from '../../config/silent.js';

const schema = z.object({
  files: z
    .array(z.string())
    .min(1)
    .max(50)
    .default([])
    .describe('Files to stage'),
  all: z.boolean().default(false).describe('Stage all changes (-A)'),
  cwd: z.string().optional().describe('Working directory'),
});

export const gitAddTool: UnifiedTool = {
  name: 'git-add',
  description: 'Stage files for commit: specific files or all changes',
  zodSchema: schema,
  skipContextShare: true,
  metadata: {
    category: 'git',
    tags: ['add', 'stage'],
    examples: [
      { args: { files: ['src/index.ts', 'src/utils.ts'] }, description: 'Stage specific files' },
      { args: { all: true }, description: 'Stage all changes' },
    ],
    relatedTools: ['git-commit', 'git-status', 'git-diff'],
  },
  execute: async (args) => {
    const { files, all, cwd } = args as unknown as z.infer<typeof schema>;

    if (!all && (!files || files.length === 0)) {
      return 'Error: Provide files to stage or set all=true to stage all changes.';
    }

    return executeGitTool('git-add', cwd, () => {
      if (all) {
        execGit(['add', '-A'], { cwd });
        return 'Staged all changes (git add -A).';
      }

      execGit(['add', '--', ...files], { cwd });
      const status = execGit(['status', '--short'], { cwd }).trim();
      const stagedLines = status.split('\n').filter((line) => line.length > 0 && line[0] !== ' ' && line[0] !== '?');

      if (isSilent()) return `Staged ${files.length} file(s).`;
      return stagedLines.length > 0
        ? `Staged ${files.length} file(s):\n${stagedLines.join('\n')}`
        : `Staged ${files.length} file(s).`;
    });
  },
};
