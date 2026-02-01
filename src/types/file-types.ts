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
 * File Operation Types
 *
 * Type definitions for file-related operations and their results.
 *
 * @module types/file-types
 */

/**
 * File type enumeration
 */
export type FileType = 'file' | 'directory' | 'symlink' | 'unknown';

/**
 * File metadata
 */
export interface FileMetadata {
  /** File path (absolute) */
  path: string;
  /** File name */
  name: string;
  /** File type */
  type: FileType;
  /** File size in bytes */
  size: number;
  /** Creation time (ISO format) */
  created?: string;
  /** Last modified time (ISO format) */
  modified: string;
  /** Last accessed time (ISO format) */
  accessed?: string;
  /** File permissions (octal) */
  mode?: number;
  /** Owner user ID */
  uid?: number;
  /** Owner group ID */
  gid?: number;
  /** Whether file is readable */
  readable: boolean;
  /** Whether file is writable */
  writable: boolean;
  /** Whether file is executable */
  executable: boolean;
}

/**
 * File content with metadata
 */
export interface FileContent {
  /** File path */
  path: string;
  /** File content */
  content: string;
  /** File encoding */
  encoding: BufferEncoding;
  /** File size in bytes */
  size: number;
  /** Line count */
  lineCount: number;
  /** Whether file was truncated */
  truncated: boolean;
  /** Total lines (if truncated) */
  totalLines?: number;
}

/**
 * Directory entry (for file tree)
 */
export interface TreeEntry {
  /** Entry name */
  name: string;
  /** Full path */
  path: string;
  /** Entry type */
  type: 'file' | 'directory';
  /** File size (for files) */
  size?: number;
  /** Display icon */
  icon?: string;
  /** Child entries (for directories) */
  children?: TreeEntry[];
  /** Last modified (ISO format) */
  modified?: string;
}

/**
 * File tree result
 */
export interface FileTreeResult {
  success: boolean;
  /** Root path */
  root: string;
  /** Tree structure */
  tree?: TreeEntry;
  /** Total file count */
  totalFiles?: number;
  /** Total directory count */
  totalDirs?: number;
  /** Total size in bytes */
  totalSize?: number;
  /** Whether result was truncated */
  truncated?: boolean;
  /** Formatted string representation */
  formatted?: string;
  /** Summary line */
  summary?: string;
  /** Error message if failed */
  error?: string;
}

/**
 * File search match
 */
export interface FileSearchMatch {
  /** File path */
  path: string;
  /** Line number (1-based) */
  lineNumber: number;
  /** Column number (1-based) */
  column?: number;
  /** Matched line content */
  line: string;
  /** Match start index in line */
  matchStart: number;
  /** Match end index in line */
  matchEnd: number;
  /** Context lines before */
  before?: string[];
  /** Context lines after */
  after?: string[];
}

/**
 * File search result
 */
export interface FileSearchResult {
  success: boolean;
  /** Search pattern used */
  pattern: string;
  /** Files searched */
  filesSearched: number;
  /** Total matches found */
  totalMatches: number;
  /** Matches grouped by file */
  matches: Map<string, FileSearchMatch[]> | Record<string, FileSearchMatch[]>;
  /** Whether result was truncated */
  truncated: boolean;
  /** Error message if failed */
  error?: string;
}

/**
 * File diff change
 */
export interface FileDiffChange {
  /** Change type */
  type: 'add' | 'delete' | 'modify';
  /** Line number (after for add/modify, before for delete) */
  lineNumber: number;
  /** Content */
  content: string;
}

/**
 * File diff result
 */
export interface FileDiffResult {
  success: boolean;
  /** Original file path */
  originalPath: string;
  /** Modified file path (same as original for in-place diff) */
  modifiedPath: string;
  /** Changes */
  changes: FileDiffChange[];
  /** Lines added count */
  additions: number;
  /** Lines deleted count */
  deletions: number;
  /** Unified diff format */
  unifiedDiff?: string;
  /** Error message if failed */
  error?: string;
}

/**
 * File read arguments
 */
export interface FileReadArguments {
  path: string;
  encoding?: BufferEncoding;
  startLine?: number;
  endLine?: number;
  maxLines?: number;
}

/**
 * File write arguments
 */
export interface FileWriteArguments {
  path: string;
  content: string;
  encoding?: BufferEncoding;
  createDirs?: boolean;
  backup?: boolean;
  mode?: 'overwrite' | 'append' | 'insert';
  insertLine?: number;
}

/**
 * File write result
 */
export interface FileWriteResult {
  success: boolean;
  /** Path written to */
  path: string;
  /** Bytes written */
  bytesWritten: number;
  /** Backup path (if backup was created) */
  backupPath?: string;
  /** Error message if failed */
  error?: string;
}

/**
 * File search arguments
 */
export interface FileSearchArguments {
  pattern: string;
  path?: string;
  filePattern?: string;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
  maxResults?: number;
  context?: number;
  includeHidden?: boolean;
}

// FileTreeArguments is defined in tool-types.ts to avoid circular dependencies

/**
 * File operation error codes
 */
export enum FileErrorCode {
  NOT_FOUND = 'ENOENT',
  PERMISSION_DENIED = 'EACCES',
  IS_DIRECTORY = 'EISDIR',
  NOT_DIRECTORY = 'ENOTDIR',
  EXISTS = 'EEXIST',
  BUSY = 'EBUSY',
  TOO_LARGE = 'ETOOLARGE',
  INVALID_PATH = 'EINVAL',
  UNKNOWN = 'EUNKNOWN',
}

/**
 * File operation error
 */
export interface FileOperationError {
  code: FileErrorCode;
  message: string;
  path: string;
  syscall?: string;
}

/**
 * Type guard for file operation errors
 */
export function isFileError(error: unknown): error is FileOperationError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    'message' in error &&
    'path' in error &&
    typeof (error as FileOperationError).code === 'string' &&
    typeof (error as FileOperationError).message === 'string' &&
    typeof (error as FileOperationError).path === 'string'
  );
}

/**
 * Type guard for Node.js filesystem errors
 */
export function isNodeFsError(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof (error as NodeJS.ErrnoException).code === 'string'
  );
}

/**
 * Convert Node.js error to FileOperationError
 */
export function toFileError(error: NodeJS.ErrnoException, path: string): FileOperationError {
  const codeMap: Record<string, FileErrorCode> = {
    ENOENT: FileErrorCode.NOT_FOUND,
    EACCES: FileErrorCode.PERMISSION_DENIED,
    EPERM: FileErrorCode.PERMISSION_DENIED,
    EISDIR: FileErrorCode.IS_DIRECTORY,
    ENOTDIR: FileErrorCode.NOT_DIRECTORY,
    EEXIST: FileErrorCode.EXISTS,
    EBUSY: FileErrorCode.BUSY,
  };

  return {
    code: codeMap[error.code || ''] || FileErrorCode.UNKNOWN,
    message: error.message,
    path,
    syscall: error.syscall,
  };
}
