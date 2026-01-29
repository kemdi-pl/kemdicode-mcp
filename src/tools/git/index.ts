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
 * Git Tools Module
 *
 * Exports all git-related MCP tools for repository operations.
 *
 * @module tools/git
 */

export { gitStatusTool } from './git-status.tool.js';
export { gitDiffTool } from './git-diff.tool.js';
export { gitLogTool } from './git-log.tool.js';
export { gitBlameTool } from './git-blame.tool.js';
export { gitBranchTool } from './git-branch.tool.js';

// Re-export common git utilities
export {
  execGit,
  isGitRepo,
  getCurrentBranch,
  getRepoRoot,
  validateGitRepo,
  execGitParallel,
  getRepoSummary,
  clearGitCache,
} from '../../utils/git-utils.js';
