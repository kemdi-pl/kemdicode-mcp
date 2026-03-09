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
 * Git Utilities
 *
 * Shared utilities for git operations across git tools.
 * Provides common git command execution, repository detection,
 * and output formatting.
 *
 * Performance optimizations:
 * - Caches git repository checks (git rev-parse is slow)
 * - Caches git root detection
 * - Supports parallel git command execution
 *
 * @module utils/git-utils
 */

import { execFileSync } from 'child_process';
import { gitCache } from './cache.js';
import { config } from '../config/index.js';

/**
 * Options for git command execution
 */
export interface GitExecOptions {
  /** Working directory for the command */
  cwd?: string;
  /** Max buffer size in bytes (default: from config) */
  maxBuffer?: number;
  /** Encoding for output (default: utf-8) */
  encoding?: BufferEncoding;
}

/**
 * Execute a git command and return output
 *
 * @param args - Git command arguments (e.g., ['status', '--short'])
 * @param options - Execution options
 * @returns Command output as string
 * @throws Error if command fails
 *
 * @example
 * ```typescript
 * const status = execGit(['status', '--short'], { cwd: '/path/to/repo' });
 * const log = execGit(['log', '-n', '5', '--oneline']);
 * ```
 */
export function execGit(args: string[], options: GitExecOptions = {}): string {
  const execOptions: {
    cwd?: string;
    encoding: BufferEncoding;
    maxBuffer: number;
  } = {
    cwd: options.cwd,
    encoding: options.encoding ?? 'utf-8',
    maxBuffer: options.maxBuffer ?? config.get('limits').maxBuffer,
  };

  // IMPORTANT: never execute through a shell. Passing args as an array prevents
  // command injection via crafted arguments.
  return execFileSync('git', args, execOptions);
}

/**
 * Get cache TTL for git repo checks from config
 */
function getRepoCheckTtl(): number {
  return config.get('cache').gitTtl;
}

/** Cache TTL for branch info (30 seconds - changes more frequently) */
const BRANCH_CHECK_TTL = 30 * 1000;

/**
 * Check if a directory is a git repository (cached)
 *
 * @param cwd - Directory to check (defaults to current directory)
 * @returns true if the directory is a git repository
 *
 * @example
 * ```typescript
 * if (!isGitRepo('/path/to/dir')) {
 *   return 'Error: Not a git repository';
 * }
 * ```
 */
export function isGitRepo(cwd?: string): boolean {
  const dir = cwd || process.cwd();
  const cacheKey = `isrepo:${dir}`;

  const cached = gitCache.get(cacheKey);
  if (cached !== undefined) {
    return cached as boolean;
  }

  const repoTtl = getRepoCheckTtl();
  try {
    execGit(['rev-parse', '--git-dir'], { cwd });
    gitCache.set(cacheKey, true, repoTtl);
    return true;
  } catch {
    gitCache.set(cacheKey, false, repoTtl);
    return false;
  }
}

/**
 * Get current branch name (cached)
 *
 * @param cwd - Working directory (defaults to current directory)
 * @returns Current branch name or detached HEAD info
 *
 * @example
 * ```typescript
 * const branch = getCurrentBranch('/path/to/repo');
 * // Returns: 'main' or '(HEAD detached at abc1234)'
 * ```
 */
export function getCurrentBranch(cwd?: string): string {
  const dir = cwd || process.cwd();
  const cacheKey = `branch:${dir}`;

  const cached = gitCache.get(cacheKey);
  if (cached !== undefined) {
    return cached as string;
  }

  try {
    const branch = execGit(['branch', '--show-current'], { cwd }).trim();
    if (branch) {
      gitCache.set(cacheKey, branch, BRANCH_CHECK_TTL);
      return branch;
    }
    // Detached HEAD state
    const head = execGit(['rev-parse', '--short', 'HEAD'], { cwd }).trim();
    const result = `(HEAD detached at ${head})`;
    gitCache.set(cacheKey, result, BRANCH_CHECK_TTL);
    return result;
  } catch {
    return '(unknown)';
  }
}

/**
 * Get the root directory of the git repository (cached)
 *
 * @param cwd - Directory within the repository
 * @returns Absolute path to repository root
 * @throws Error if not in a git repository
 *
 * @example
 * ```typescript
 * const root = getRepoRoot('/path/to/repo/subdir');
 * // Returns: '/path/to/repo'
 * ```
 */
export function getRepoRoot(cwd?: string): string {
  const dir = cwd || process.cwd();
  const cacheKey = `root:${dir}`;

  const cached = gitCache.get(cacheKey);
  if (cached !== undefined) {
    return cached as string;
  }

  const root = execGit(['rev-parse', '--show-toplevel'], { cwd }).trim();
  gitCache.set(cacheKey, root, getRepoCheckTtl());
  return root;
}

/**
 * Validate that a directory is a git repository and return an error message if not
 *
 * @param cwd - Directory to validate
 * @returns null if valid, error string if not a git repository
 *
 * @example
 * ```typescript
 * const error = validateGitRepo('/path/to/dir');
 * if (error) {
 *   return error;
 * }
 * ```
 */
export function validateGitRepo(cwd?: string): string | null {
  if (!isGitRepo(cwd)) {
    const dir = cwd || process.cwd();
    return `Error: '${dir}' is not a git repository or not accessible.`;
  }
  return null;
}

/**
 * Parse a space-separated file list into an array
 * Filters out empty strings
 *
 * @param files - Space-separated file list
 * @returns Array of file paths
 *
 * @example
 * ```typescript
 * const fileList = parseFileList('src/index.ts  src/utils.ts');
 * // Returns: ['src/index.ts', 'src/utils.ts']
 * ```
 */
export function parseFileList(files: string): string[] {
  return files.split(/\s+/).filter((f) => f.trim());
}

/**
 * Format a git command error for user-friendly output
 *
 * @param error - The caught error
 * @param operation - Description of the operation (e.g., 'Git status')
 * @returns Formatted error message
 *
 * @example
 * ```typescript
 * try {
 *   execGit(['status']);
 * } catch (error) {
 *   return formatGitError(error, 'Git status');
 * }
 * ```
 */
export function formatGitError(error: unknown, operation: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${operation} failed: ${message}`;
}

/**
 * Common git error messages and their user-friendly replacements
 */
const GIT_ERROR_MAPPINGS: Array<{ pattern: string; getMessage: (match?: string) => string }> = [
  {
    pattern: 'no such path',
    getMessage: () => 'File not found in repository.',
  },
  {
    pattern: 'bad revision',
    getMessage: () => 'Invalid revision specified.',
  },
  {
    pattern: 'already exists',
    getMessage: () => 'Already exists.',
  },
  {
    pattern: 'not found',
    getMessage: () => 'Not found.',
  },
  {
    pattern: 'not fully merged',
    getMessage: () => 'Not fully merged. Use force option to proceed anyway.',
  },
  {
    pattern: 'invalid branch name',
    getMessage: () => 'Invalid branch name.',
  },
];

/**
 * Enhance a git error message with user-friendly details
 *
 * @param message - Original error message
 * @returns Enhanced error message if a pattern matches, otherwise original
 *
 * @example
 * ```typescript
 * const enhanced = enhanceGitErrorMessage('fatal: bad revision abc123');
 * // Returns: 'Invalid revision specified.'
 * ```
 */
export function enhanceGitErrorMessage(message: string): string {
  const lowerMessage = message.toLowerCase();

  for (const mapping of GIT_ERROR_MAPPINGS) {
    if (lowerMessage.includes(mapping.pattern)) {
      return mapping.getMessage();
    }
  }

  return message;
}

// ============================================================================
// PARALLEL EXECUTION UTILITIES
// ============================================================================

/**
 * Result of a parallel git command execution
 */
export interface GitParallelResult {
  /** The command arguments that were executed */
  args: string[];
  /** The output if successful */
  output?: string;
  /** The error if failed */
  error?: Error;
  /** Whether the command succeeded */
  success: boolean;
}

/**
 * Execute multiple git commands in parallel
 * Useful for gathering information from multiple git operations simultaneously
 *
 * @param commands - Array of { args, cwd } objects
 * @returns Array of results with output or error
 *
 * @example
 * ```typescript
 * const results = await execGitParallel([
 *   { args: ['status', '--short'], cwd: '/repo' },
 *   { args: ['log', '-1', '--oneline'], cwd: '/repo' },
 *   { args: ['branch', '--show-current'], cwd: '/repo' },
 * ]);
 * ```
 */
export async function execGitParallel(
  commands: Array<{ args: string[]; cwd?: string }>
): Promise<GitParallelResult[]> {
  return Promise.all(
    commands.map(async ({ args, cwd }) => {
      try {
        const output = execGit(args, { cwd });
        return { args, output, success: true };
      } catch (error) {
        return {
          args,
          error: error instanceof Error ? error : new Error(String(error)),
          success: false,
        };
      }
    })
  );
}

/**
 * Get a comprehensive repository summary in parallel
 * Combines multiple git info calls for efficiency
 *
 * @param cwd - Working directory (optional)
 * @returns Repository summary object or null if not a git repo
 *
 * @example
 * ```typescript
 * const summary = await getRepoSummary('/path/to/repo');
 * if (summary) {
 *   console.log(`Branch: ${summary.branch}, Clean: ${summary.isClean}`);
 * }
 * ```
 */
export async function getRepoSummary(cwd?: string): Promise<{
  branch: string;
  isClean: boolean;
  lastCommit: string;
  ahead: number;
  behind: number;
} | null> {
  const dir = cwd || process.cwd();

  if (!isGitRepo(dir)) {
    return null;
  }

  const results = await execGitParallel([
    { args: ['status', '--porcelain'], cwd: dir },
    { args: ['log', '-1', '--format=%h %s', '--no-color'], cwd: dir },
    { args: ['branch', '-vv', '--no-color'], cwd: dir },
  ]);

  const [statusResult, logResult, branchResult] = results;

  const isClean = statusResult.success && statusResult.output?.trim() === '';
  const lastCommit = logResult.success ? logResult.output?.trim() || '' : '';

  // Parse ahead/behind from branch -vv output
  let ahead = 0;
  let behind = 0;

  if (branchResult.success && branchResult.output) {
    const currentBranchLine = branchResult.output.split('\n').find((line) => line.startsWith('*'));
    if (currentBranchLine) {
      const aheadMatch = currentBranchLine.match(/ahead (\d+)/);
      const behindMatch = currentBranchLine.match(/behind (\d+)/);
      if (aheadMatch) ahead = parseInt(aheadMatch[1], 10);
      if (behindMatch) behind = parseInt(behindMatch[1], 10);
    }
  }

  return {
    branch: getCurrentBranch(dir),
    isClean,
    lastCommit,
    ahead,
    behind,
  };
}

/**
 * Clear git-related caches
 * Call this when git state might have changed significantly
 */
export function clearGitCache(): void {
  gitCache.clear();
}

/**
 * Execute a git tool command with standard validation and error handling.
 * Eliminates duplicated repo-validation + try/catch boilerplate across 8 git tools.
 *
 * @param toolName - Tool name for error messages
 * @param cwd - Working directory (resolved by the tool)
 * @param fn - Function that performs the git operation and returns the result
 * @returns Tool result string
 *
 * @example
 * ```typescript
 * return executeGitTool('git-status', cwd, () => {
 *   const output = execGit(['status', '--short'], { cwd });
 *   return output || 'Working tree clean';
 * });
 * ```
 */
export function executeGitTool(
  toolName: string,
  cwd: string | undefined,
  fn: () => string
): string {
  const repoError = validateGitRepo(cwd);
  if (repoError) return repoError;

  try {
    return fn();
  } catch (error) {
    return formatGitError(error, toolName);
  }
}
