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
 * File Read Tool
 *
 * Read file content with encoding detection, line range support,
 * binary file detection, size limits, and security validation.
 *
 * @module tools/file/file-read
 */

import { z } from 'zod';
import { promises as fs } from 'fs';
import { UnifiedTool, errorToJsonString } from '../registry.js';
import { Logger } from '../../utils/logger.js';
import { fromNodeError } from '../../utils/errors.js';
import {
  validatePath,
  validateFileSize,
  ValidationError,
  checkRateLimit,
} from '../../utils/validation.js';

/** Maximum file size to read (5MB) */
const MAX_FILE_SIZE = 5 * 1024 * 1024;

/** Common binary file extensions */
const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.ico',
  '.webp',
  '.svg',
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.zip',
  '.tar',
  '.gz',
  '.rar',
  '.7z',
  '.bz2',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.bin',
  '.mp3',
  '.mp4',
  '.avi',
  '.mkv',
  '.mov',
  '.wav',
  '.flac',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  '.sqlite',
  '.db',
  '.class',
  '.pyc',
  '.o',
  '.a',
]);

const schema = z.object({
  path: z.string().min(1).describe('Absolute or relative file path to read'),
  startLine: z.number().int().positive().optional().describe('Start line number (1-based)'),
  endLine: z.number().int().positive().optional().describe('End line number (1-based, inclusive)'),
  encoding: z
    .enum(['utf-8', 'utf-16', 'ascii', 'latin1', 'base64'])
    .default('utf-8')
    .describe('File encoding'),
  maxSize: z.number().int().positive().optional().describe('Maximum bytes to read (default: 5MB)'),
});

type FileReadArgs = z.infer<typeof schema>;

/**
 * Detect if a file is binary based on extension and content sampling
 */
async function isBinaryFile(filePath: string): Promise<boolean> {
  // Check extension first
  const ext = filePath.toLowerCase().slice(filePath.lastIndexOf('.'));
  if (BINARY_EXTENSIONS.has(ext)) {
    return true;
  }

  // Sample first 8KB for null bytes (binary indicator)
  try {
    const fd = await fs.open(filePath, 'r');
    const buffer = Buffer.alloc(8192);
    const { bytesRead } = await fd.read(buffer, 0, 8192, 0);
    await fd.close();

    // Check for null bytes (common in binary files)
    for (let i = 0; i < bytesRead; i++) {
      if (buffer[i] === 0) {
        return true;
      }
    }
  } catch {
    // If we can't read, assume text
  }

  return false;
}

/**
 * Get file encoding from Buffer
 */
function detectEncoding(buffer: Buffer): string {
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

export const fileReadTool: UnifiedTool = {
  name: 'file-read',
  description: 'Read file content with encoding detection, line ranges, and binary detection',
  zodSchema: schema,
  skipContextShare: true, // File content may be large

  execute: async (args): Promise<string> => {
    const { path: inputPath, startLine, endLine, encoding, maxSize } = args as FileReadArgs;
    const maxBytes = maxSize ?? MAX_FILE_SIZE;

    // Rate limit check
    if (!checkRateLimit('file-read', { maxRequests: 200, windowMs: 60000 })) {
      return JSON.stringify({
        success: false,
        error: 'Rate limit exceeded for file-read operations',
        code: 'RATE_LIMIT_EXCEEDED',
      });
    }

    try {
      // Validate and sanitize the path
      // Note: requireWithinProject is false to allow reading files from external codebases
      let validatedPath: string;
      try {
        validatedPath = await validatePath(inputPath, {
          allowSymlinks: false,
          requireWithinProject: false, // Allow reading any accessible file
          allowReadFromBlocked: true, // Allow reading from more places, but not /proc, /sys, /dev
          operation: 'read',
        });
      } catch (validationError) {
        if (validationError instanceof ValidationError) {
          Logger.warn(`file-read security validation failed: ${validationError.message}`);
          return JSON.stringify({
            success: false,
            error: validationError.message,
            code: validationError.code,
            path: inputPath,
          });
        }
        throw validationError;
      }

      // Validate file size
      let fileStats: { size: number; isFile: boolean };
      try {
        fileStats = await validateFileSize(validatedPath, maxBytes);
      } catch (validationError) {
        if (validationError instanceof ValidationError) {
          return JSON.stringify({
            success: false,
            error: validationError.message,
            code: validationError.code,
            path: validatedPath,
          });
        }
        throw validationError;
      }

      if (!fileStats.isFile) {
        return JSON.stringify({
          success: false,
          error: `Path is not a file: ${validatedPath}`,
          path: validatedPath,
        });
      }

      // Get file stats for additional metadata
      const stats = await fs.stat(validatedPath);

      // Check for binary
      if (await isBinaryFile(validatedPath)) {
        return JSON.stringify({
          success: false,
          error: 'Binary file detected. Use appropriate tools for binary files.',
          path: validatedPath,
          size: stats.size,
          isBinary: true,
        });
      }

      // Read file content
      const buffer = await fs.readFile(validatedPath);
      const detectedEncoding = detectEncoding(buffer);
      const content = buffer.toString(encoding === 'utf-8' ? 'utf8' : (encoding as BufferEncoding));

      // Handle line ranges
      if (startLine !== undefined || endLine !== undefined) {
        const lines = content.split('\n');
        const start = (startLine ?? 1) - 1; // Convert to 0-based
        const end = endLine ?? lines.length;

        if (start >= lines.length) {
          return JSON.stringify({
            success: false,
            error: `Start line ${startLine} exceeds file length (${lines.length} lines)`,
            totalLines: lines.length,
          });
        }

        const selectedLines = lines.slice(start, end);
        const lineNumbers = selectedLines.map((line, idx) => ({
          lineNumber: start + idx + 1,
          content: line,
        }));

        return JSON.stringify({
          success: true,
          path: validatedPath,
          encoding: detectedEncoding,
          totalLines: lines.length,
          range: { start: start + 1, end: Math.min(end, lines.length) },
          lines: lineNumbers,
        });
      }

      // Return full file content
      const lines = content.split('\n');
      return JSON.stringify({
        success: true,
        path: validatedPath,
        encoding: detectedEncoding,
        size: stats.size,
        totalLines: lines.length,
        content,
        modifiedAt: stats.mtime.toISOString(),
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      Logger.error(`file-read error: ${errorMessage}`);

      // Convert Node.js errno errors to custom error types
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code) {
        const mcpError = fromNodeError(nodeError, inputPath, 'read');
        return errorToJsonString(mcpError);
      }

      // For other errors, return a generic error response
      return JSON.stringify({
        success: false,
        error: errorMessage,
        code: 'UNKNOWN_ERROR',
        path: inputPath,
      });
    }
  },
};
