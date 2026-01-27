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
 * Edit Utilities
 *
 * Shared functions for line-based file editing operations.
 * Provides common functionality for insert, delete, and replace tools.
 *
 * @module utils/edit-utils
 */

import { promises as fs } from 'fs';
import { Logger } from './logger.js';

/**
 * Result of a line-based edit operation
 */
export interface EditResult {
  success: boolean;
  path: string;
  backup?: string;
  error?: string;
  code?: string;
}

/**
 * Read file and split into lines
 * Preserves original line endings for accurate reconstruction
 */
export async function readFileLines(path: string): Promise<string[]> {
  const content = await fs.readFile(path, 'utf8');
  // Split by newline, keeping empty lines
  return content.split('\n');
}

/**
 * Write lines back to file, optionally creating a backup
 *
 * @param path - File path to write
 * @param lines - Array of lines (without trailing newlines)
 * @param createBackup - Whether to create .bak backup
 * @returns Backup path if created, null otherwise
 */
export async function writeFileLines(
  path: string,
  lines: string[],
  createBackup: boolean
): Promise<string | null> {
  let backupPath: string | null = null;

  // Create backup if requested and file exists
  if (createBackup) {
    try {
      const stats = await fs.stat(path);
      if (stats.isFile()) {
        backupPath = `${path}.bak`;
        await fs.copyFile(path, backupPath);
        Logger.debug(`edit-utils: created backup at ${backupPath}`);
      }
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  // Join lines and write
  const content = lines.join('\n');
  await fs.writeFile(path, content, 'utf8');

  return backupPath;
}

/**
 * Validate line range for editing operations
 *
 * @param startLine - First line (1-based, inclusive)
 * @param endLine - Last line (1-based, inclusive)
 * @param totalLines - Total number of lines in file
 * @throws Error if range is invalid
 */
export function validateLineRange(startLine: number, endLine: number, totalLines: number): void {
  if (startLine < 1) {
    throw new Error(`Invalid startLine: ${startLine}. Line numbers are 1-based.`);
  }

  if (endLine < startLine) {
    throw new Error(
      `Invalid range: endLine (${endLine}) cannot be less than startLine (${startLine}).`
    );
  }

  if (startLine > totalLines) {
    throw new Error(`Invalid startLine: ${startLine}. File only has ${totalLines} lines.`);
  }

  if (endLine > totalLines) {
    throw new Error(`Invalid endLine: ${endLine}. File only has ${totalLines} lines.`);
  }
}

/**
 * Validate single line number for insertion
 *
 * @param line - Line number (1-based)
 * @param totalLines - Total number of lines in file
 * @param allowAppend - Allow line = totalLines + 1 for appending
 * @throws Error if line is invalid
 */
export function validateLineNumber(
  line: number,
  totalLines: number,
  allowAppend: boolean = true
): void {
  if (line < 1) {
    throw new Error(`Invalid line: ${line}. Line numbers are 1-based.`);
  }

  const maxLine = allowAppend ? totalLines + 1 : totalLines;

  if (line > maxLine) {
    throw new Error(
      `Invalid line: ${line}. File has ${totalLines} lines${allowAppend ? ' (can insert at line ' + (totalLines + 1) + ' to append)' : ''}.`
    );
  }
}

/**
 * Truncate string for preview purposes
 *
 * @param str - String to truncate
 * @param maxLength - Maximum length (default 200)
 * @returns Truncated string with ellipsis if needed
 */
export function truncateForPreview(str: string, maxLength: number = 200): string {
  if (str.length <= maxLength) {
    return str;
  }
  return str.slice(0, maxLength - 3) + '...';
}

/**
 * Count the number of lines in a string
 */
export function countLines(str: string): number {
  if (str.length === 0) return 0;
  return str.split('\n').length;
}
