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
 * Git Operation Types
 *
 * Type definitions for git-related operations and their results.
 *
 * @module types/git-types
 */

/**
 * Git file status codes
 */
export type GitStatusCode =
  | 'M' // Modified
  | 'A' // Added
  | 'D' // Deleted
  | 'R' // Renamed
  | 'C' // Copied
  | 'U' // Unmerged
  | '?' // Untracked
  | '!'; // Ignored

/**
 * Single file status entry
 */
export interface GitFileStatus {
  /** Status code for staging area */
  staged: GitStatusCode | ' ';
  /** Status code for working tree */
  unstaged: GitStatusCode | ' ';
  /** File path */
  path: string;
  /** Original path (for renames) */
  originalPath?: string;
}

/**
 * Git status result
 */
export interface GitStatusResult {
  success: boolean;
  /** Current branch name */
  branch?: string;
  /** Tracking branch */
  upstream?: string;
  /** Commits ahead of upstream */
  ahead?: number;
  /** Commits behind upstream */
  behind?: number;
  /** Staged files */
  staged: GitFileStatus[];
  /** Modified but unstaged files */
  modified: GitFileStatus[];
  /** Untracked files */
  untracked: string[];
  /** Whether the working tree is clean */
  clean: boolean;
  /** Error message if failed */
  error?: string;
}

/**
 * Git diff hunk
 */
export interface GitDiffHunk {
  /** Starting line in old file */
  oldStart: number;
  /** Number of lines in old file */
  oldLines: number;
  /** Starting line in new file */
  newStart: number;
  /** Number of lines in new file */
  newLines: number;
  /** Hunk header/context */
  header?: string;
  /** Diff content lines */
  lines: GitDiffLine[];
}

/**
 * Single diff line
 */
export interface GitDiffLine {
  /** Line type */
  type: 'context' | 'add' | 'delete' | 'header';
  /** Line content */
  content: string;
  /** Line number in old file (for context/delete) */
  oldLineNumber?: number;
  /** Line number in new file (for context/add) */
  newLineNumber?: number;
}

/**
 * Git diff for a single file
 */
export interface GitFileDiff {
  /** File path */
  path: string;
  /** Original path (for renames) */
  originalPath?: string;
  /** Change type */
  changeType: 'add' | 'delete' | 'modify' | 'rename' | 'copy';
  /** Binary file */
  binary: boolean;
  /** Diff hunks */
  hunks: GitDiffHunk[];
  /** Lines added */
  additions: number;
  /** Lines deleted */
  deletions: number;
}

/**
 * Git diff result
 */
export interface GitDiffResult {
  success: boolean;
  /** Files changed */
  files: GitFileDiff[];
  /** Total lines added */
  totalAdditions: number;
  /** Total lines deleted */
  totalDeletions: number;
  /** Total files changed */
  totalFiles: number;
  /** Error message if failed */
  error?: string;
}

/**
 * Git log entry
 */
export interface GitLogEntry {
  /** Commit hash (full) */
  hash: string;
  /** Abbreviated hash */
  abbreviatedHash: string;
  /** Author name */
  author: string;
  /** Author email */
  authorEmail: string;
  /** Commit date (ISO format) */
  date: string;
  /** Commit message subject */
  subject: string;
  /** Full commit message body */
  body?: string;
  /** Parent commit hashes */
  parents: string[];
  /** Refs pointing to this commit */
  refs?: string[];
}

/**
 * Git log result
 */
export interface GitLogResult {
  success: boolean;
  /** Log entries */
  entries: GitLogEntry[];
  /** Total commits (may be more than returned) */
  totalCommits?: number;
  /** Error message if failed */
  error?: string;
}

/**
 * Git blame line
 */
export interface GitBlameLine {
  /** Commit hash */
  hash: string;
  /** Author name */
  author: string;
  /** Date */
  date: string;
  /** Line number */
  lineNumber: number;
  /** Line content */
  content: string;
}

/**
 * Git blame result
 */
export interface GitBlameResult {
  success: boolean;
  /** File path */
  path: string;
  /** Blame lines */
  lines: GitBlameLine[];
  /** Error message if failed */
  error?: string;
}

/**
 * Git branch info
 */
export interface GitBranchInfo {
  /** Branch name */
  name: string;
  /** Whether this is the current branch */
  current: boolean;
  /** Tracking branch */
  upstream?: string;
  /** Last commit hash */
  lastCommit?: string;
  /** Last commit message */
  lastCommitMessage?: string;
  /** Ahead of upstream */
  ahead?: number;
  /** Behind upstream */
  behind?: number;
}

/**
 * Git branch result
 */
export interface GitBranchResult {
  success: boolean;
  /** Current branch */
  current: string;
  /** All local branches */
  local: GitBranchInfo[];
  /** Remote branches */
  remote: GitBranchInfo[];
  /** Error message if failed */
  error?: string;
}

/**
 * Git tool arguments
 */
export interface GitStatusArguments {
  path?: string;
  short?: boolean;
}

export interface GitDiffArguments {
  path?: string;
  files?: string[];
  staged?: boolean;
  base?: string;
  head?: string;
  context?: number;
}

export interface GitLogArguments {
  path?: string;
  limit?: number;
  since?: string;
  until?: string;
  author?: string;
  grep?: string;
  format?: 'full' | 'short' | 'oneline';
}

export interface GitBlameArguments {
  file: string;
  startLine?: number;
  endLine?: number;
}

export interface GitBranchArguments {
  path?: string;
  all?: boolean;
  remote?: boolean;
}

/**
 * Type guard for Git operation errors
 */
export interface GitOperationError {
  code: string;
  message: string;
  command?: string;
  stderr?: string;
}

export function isGitError(error: unknown): error is GitOperationError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    'message' in error &&
    typeof (error as GitOperationError).code === 'string' &&
    typeof (error as GitOperationError).message === 'string'
  );
}
