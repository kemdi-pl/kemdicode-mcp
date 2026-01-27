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
 * File Utilities
 *
 * Shared utilities for file operations across file tools.
 * Provides validation, path resolution, binary detection,
 * and common file system helpers.
 *
 * @module utils/file-utils
 */

import { promises as fs } from 'fs';
import { resolve, dirname } from 'path';
import { config } from '../config/index.js';

/**
 * Get maximum file size to read (from config)
 */
export function getMaxFileSize(): number {
  return config.get('limits').maxFileSize;
}

/**
 * Get maximum file size for diff operations (from config)
 */
export function getMaxDiffSize(): number {
  return config.get('limits').maxDiffBuffer;
}

/**
 * Maximum file size to read by default (5MB)
 * @deprecated Use getMaxFileSize() instead for runtime config support
 */
export const MAX_FILE_SIZE = 5 * 1024 * 1024;

/**
 * Maximum file size for diff operations (10MB)
 * @deprecated Use getMaxDiffSize() instead for runtime config support
 */
export const MAX_DIFF_SIZE = 10 * 1024 * 1024;

/**
 * Common binary file extensions
 */
export const BINARY_EXTENSIONS = new Set([
  // Images
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.ico',
  '.webp',
  '.svg',
  // Documents
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  // Archives
  '.zip',
  '.tar',
  '.gz',
  '.rar',
  '.7z',
  '.bz2',
  // Executables
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.bin',
  // Media
  '.mp3',
  '.mp4',
  '.avi',
  '.mkv',
  '.mov',
  '.wav',
  '.flac',
  // Fonts
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  // Compiled/Database
  '.sqlite',
  '.db',
  '.class',
  '.pyc',
  '.o',
  '.a',
]);

/**
 * File validation result
 */
export interface FileValidationResult {
  valid: boolean;
  error?: string;
  size?: number;
  isFile?: boolean;
  isDirectory?: boolean;
}

/**
 * Validate that a file exists and is accessible
 *
 * @param path - Path to validate
 * @param maxSize - Maximum allowed file size (optional)
 * @returns Validation result with details
 *
 * @example
 * ```typescript
 * const result = await validateFile('/path/to/file.txt');
 * if (!result.valid) {
 *   return { success: false, error: result.error };
 * }
 * ```
 */
export async function validateFile(path: string, maxSize?: number): Promise<FileValidationResult> {
  try {
    const stats = await fs.stat(path);

    if (!stats.isFile()) {
      return {
        valid: false,
        error: `Not a file: ${path}`,
        isDirectory: stats.isDirectory(),
      };
    }

    if (maxSize !== undefined && stats.size > maxSize) {
      return {
        valid: false,
        error: `File too large: ${stats.size} bytes (max: ${maxSize})`,
        size: stats.size,
        isFile: true,
      };
    }

    return { valid: true, size: stats.size, isFile: true };
  } catch (error) {
    return handleFsError(error, path);
  }
}

/**
 * Validate that a directory exists and is accessible
 *
 * @param path - Path to validate
 * @returns Validation result with details
 *
 * @example
 * ```typescript
 * const result = await validateDirectory('/path/to/dir');
 * if (!result.valid) {
 *   throw new Error(result.error);
 * }
 * ```
 */
export async function validateDirectory(path: string): Promise<FileValidationResult> {
  try {
    const stats = await fs.stat(path);

    if (!stats.isDirectory()) {
      return {
        valid: false,
        error: `Not a directory: ${path}`,
        isFile: stats.isFile(),
      };
    }

    return { valid: true, isDirectory: true };
  } catch (error) {
    return handleFsError(error, path);
  }
}

/**
 * Handle common file system errors and return user-friendly messages
 */
function handleFsError(error: unknown, path: string): FileValidationResult {
  const nodeError = error as NodeJS.ErrnoException;

  if (nodeError.code === 'ENOENT') {
    return { valid: false, error: `File not found: ${path}` };
  }
  if (nodeError.code === 'EACCES') {
    return { valid: false, error: `Permission denied: ${path}` };
  }
  if (nodeError.code === 'ENOTDIR') {
    return { valid: false, error: `Not a directory in path: ${path}` };
  }

  return {
    valid: false,
    error: error instanceof Error ? error.message : String(error),
  };
}

/**
 * Detect if a file is binary based on extension and content sampling
 *
 * @param filePath - Path to the file
 * @returns true if the file appears to be binary
 *
 * @example
 * ```typescript
 * if (await isBinaryFile('/path/to/file.png')) {
 *   return { error: 'Binary file detected' };
 * }
 * ```
 */
export async function isBinaryFile(filePath: string): Promise<boolean> {
  // Check extension first (fast path)
  const ext = filePath.toLowerCase().slice(filePath.lastIndexOf('.'));
  if (BINARY_EXTENSIONS.has(ext)) {
    return true;
  }

  // Sample bytes for null bytes (binary indicator)
  const sampleSize = config.get('limits').binarySampleSize;
  try {
    const fd = await fs.open(filePath, 'r');
    try {
      const buffer = Buffer.alloc(sampleSize);
      const { bytesRead } = await fd.read(buffer, 0, sampleSize, 0);

      // Check for null bytes (common in binary files)
      for (let i = 0; i < bytesRead; i++) {
        if (buffer[i] === 0) {
          return true;
        }
      }
    } finally {
      await fd.close();
    }
  } catch {
    // If we can't read, assume text
  }

  return false;
}

/**
 * Detect file encoding from BOM markers
 *
 * @param buffer - File content buffer
 * @returns Detected encoding name
 *
 * @example
 * ```typescript
 * const buffer = await fs.readFile('/path/to/file.txt');
 * const encoding = detectEncoding(buffer);
 * ```
 */
export function detectEncoding(buffer: Buffer): string {
  // Check for BOM markers
  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return 'utf-8';
  }
  if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    return 'utf-16be';
  }
  if (buffer[0] === 0xff && buffer[1] === 0xfe) {
    return 'utf-16le';
  }
  return 'utf-8'; // Default
}

/**
 * Ensure a directory exists, creating it if necessary
 *
 * @param dirPath - Directory path to ensure
 * @returns true if directory was created, false if it already existed
 *
 * @example
 * ```typescript
 * const created = await ensureDirectory('/path/to/new/dir');
 * if (created) {
 *   console.log('Directory was created');
 * }
 * ```
 */
export async function ensureDirectory(dirPath: string): Promise<boolean> {
  try {
    await fs.mkdir(dirPath, { recursive: true });
    return true;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === 'EEXIST') {
      return false;
    }
    throw error;
  }
}

/**
 * Ensure parent directory exists for a file path
 *
 * @param filePath - File path whose parent should exist
 * @returns true if parent directory was created
 */
export async function ensureParentDirectory(filePath: string): Promise<boolean> {
  const dir = dirname(filePath);
  return ensureDirectory(dir);
}

/**
 * Resolve a path, handling both absolute and relative paths
 *
 * @param path - Path to resolve
 * @param basePath - Base path for relative resolution (defaults to cwd)
 * @returns Absolute resolved path
 *
 * @example
 * ```typescript
 * const abs = resolvePath('./src/index.ts', '/project');
 * // Returns: '/project/src/index.ts'
 * ```
 */
export function resolvePath(path: string, basePath?: string): string {
  return resolve(basePath || process.cwd(), path);
}

/**
 * Get the working directory, defaulting to process.cwd()
 *
 * @param cwd - Optional working directory
 * @returns The provided cwd or process.cwd()
 *
 * @example
 * ```typescript
 * const workDir = getWorkingDirectory(args.cwd);
 * ```
 */
export function getWorkingDirectory(cwd?: string): string {
  return cwd || process.cwd();
}

/**
 * Format file size for display
 *
 * @param bytes - Size in bytes
 * @returns Human-readable size string
 *
 * @example
 * ```typescript
 * formatSize(1536); // '1.5 KB'
 * formatSize(1048576); // '1.0 MB'
 * ```
 */
export function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

/**
 * Create a JSON result object for file operations
 *
 * @param success - Whether the operation succeeded
 * @param path - File path
 * @param data - Additional data to include
 * @returns JSON string
 */
export function createFileResult(
  success: boolean,
  path: string,
  data: Record<string, unknown> = {}
): string {
  return JSON.stringify({
    success,
    path,
    ...data,
  });
}

/**
 * Create an error result for file operations
 *
 * @param path - File path
 * @param error - Error message
 * @param data - Additional data to include
 * @returns JSON string
 */
export function createFileError(
  path: string,
  error: string,
  data: Record<string, unknown> = {}
): string {
  return createFileResult(false, path, { error, ...data });
}

/**
 * Parse file system error and return appropriate error message
 *
 * @param error - The caught error
 * @param path - File path for context
 * @returns User-friendly error message
 */
export function parseFileError(error: unknown, path: string): string {
  const nodeError = error as NodeJS.ErrnoException;

  switch (nodeError.code) {
    case 'ENOENT':
      return `File not found: ${path}`;
    case 'EACCES':
      return `Permission denied: ${path}`;
    case 'ENOSPC':
      return 'No space left on device';
    case 'EROFS':
      return 'Read-only file system';
    case 'EISDIR':
      return `Is a directory: ${path}`;
    case 'ENOTDIR':
      return `Not a directory: ${path}`;
    default:
      return error instanceof Error ? error.message : String(error);
  }
}
