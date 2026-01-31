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
import { isSilent } from '../../config/silent.js';

/** Maximum file size to read (5MB) */
const MAX_FILE_SIZE = 5 * 1024 * 1024;

/** Reusable buffer for binary file detection (8KB) */
const binaryDetectionBuffer = Buffer.alloc(8192);

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

const fileItemSchema = z.object({
  path: z.string().min(1).describe('File path to read'),
  startLine: z.number().int().positive().optional().describe('Start line (1-based)'),
  endLine: z.number().int().positive().optional().describe('End line (1-based, inclusive)'),
});

const baseSchema = z.object({
  files: z.array(fileItemSchema).min(1).max(20).describe('Files to read (1-20)'),
  encoding: z
    .enum(['utf-8', 'utf-16', 'ascii', 'latin1', 'base64'])
    .default('utf-8')
    .describe('Encoding'),
  maxSize: z.number().int().positive().optional().describe('Max bytes per file'),
});

/**
 * Accepts both array format { files: [...] } and shorthand { path: "file.ts", startLine?, endLine? }.
 * The shorthand is normalized to array format before validation.
 */
const schema = z.preprocess((input) => {
  if (typeof input === 'object' && input !== null && 'path' in input && !('files' in input)) {
    const { path, startLine, endLine, encoding, maxSize } = input as Record<string, unknown>;
    return {
      files: [{ path, startLine, endLine }],
      ...(encoding !== undefined && { encoding }),
      ...(maxSize !== undefined && { maxSize }),
    };
  }
  return input;
}, baseSchema);

type FileReadArgs = z.infer<typeof schema>;
type FileItem = z.infer<typeof fileItemSchema>;

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
    // Reuse pre-allocated buffer to reduce GC pressure
    const { bytesRead } = await fd.read(binaryDetectionBuffer, 0, 8192, 0);
    await fd.close();

    // Check for null bytes (common in binary files)
    for (let i = 0; i < bytesRead; i++) {
      if (binaryDetectionBuffer[i] === 0) {
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

/**
 * Read a single file and return structured result
 */
async function readSingleFile(
  item: FileItem,
  encoding: string,
  maxBytes: number,
  sessionCwd?: string
): Promise<Record<string, unknown>> {
  const inputPath = item.path;
  try {
    let validatedPath: string;
    try {
      validatedPath = await validatePath(inputPath, {
        allowSymlinks: false,
        requireWithinProject: false,
        allowReadFromBlocked: true,
        operation: 'read',
        projectRoot: sessionCwd,
      });
    } catch (validationError) {
      if (validationError instanceof ValidationError) {
        Logger.warn(`file-read security validation failed: ${validationError.message}`);
        return { success: false, error: validationError.message, code: (validationError as ValidationError).code, path: inputPath };
      }
      throw validationError;
    }

    let fileStats: { size: number; isFile: boolean };
    try {
      fileStats = await validateFileSize(validatedPath, maxBytes);
    } catch (validationError) {
      if (validationError instanceof ValidationError) {
        return { success: false, error: validationError.message, code: (validationError as ValidationError).code, path: validatedPath };
      }
      throw validationError;
    }

    if (!fileStats.isFile) {
      return { success: false, error: `Path is not a file: ${validatedPath}`, path: validatedPath };
    }

    const stats = await fs.stat(validatedPath);

    if (await isBinaryFile(validatedPath)) {
      return { success: false, error: 'Binary file detected', path: validatedPath, size: stats.size, isBinary: true };
    }

    // Use encoding option directly to avoid unnecessary conversions
    const detectedEncoding = encoding === 'utf-8' ? 'utf-8' : encoding;
    const content = await fs.readFile(validatedPath, {
      encoding: encoding === 'utf-8' ? 'utf8' : (encoding as BufferEncoding)
    });

    if (item.startLine !== undefined || item.endLine !== undefined) {
      const lines = content.split('\n');
      const start = (item.startLine ?? 1) - 1;
      const end = item.endLine ?? lines.length;

      if (start >= lines.length) {
        return { success: false, error: `Start line ${item.startLine} exceeds file length (${lines.length} lines)`, totalLines: lines.length };
      }

      const selectedLines = lines.slice(start, end);
      const lineNumbers = selectedLines.map((line, idx) => ({ lineNumber: start + idx + 1, content: line }));

      return {
        success: true,
        path: validatedPath,
        encoding: detectedEncoding,
        totalLines: lines.length,
        range: { start: start + 1, end: Math.min(end, lines.length) },
        lines: lineNumbers,
      };
    }

    const lines = content.split('\n');
    return {
      success: true,
      path: validatedPath,
      encoding: detectedEncoding,
      size: stats.size,
      totalLines: lines.length,
      content,
      modifiedAt: stats.mtime.toISOString(),
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    Logger.error(`file-read error: ${errorMessage}`);

    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code) {
      const mcpError = fromNodeError(nodeError, inputPath, 'read');
      return JSON.parse(errorToJsonString(mcpError));
    }

    return { success: false, error: errorMessage, code: 'UNKNOWN_ERROR', path: inputPath };
  }
}

export const fileReadTool: UnifiedTool = {
  name: 'file-read',
  description: 'Read 1-20 files with encoding detection and line ranges.',
  zodSchema: schema,
  skipContextShare: true,
  metadata: {
    category: 'file',
    tags: ['read', 'encoding'],
    examples: [
      { args: { paths: ['src/index.ts'] }, description: 'Read a single file' },
      { args: { paths: ['src/a.ts', 'src/b.ts'], lineRange: '1-50' }, description: 'Read first 50 lines of multiple files' },
    ],
    relatedTools: ['file-write', 'file-search', 'file-diff'],
  },

  execute: async (args): Promise<string> => {
    const { files, encoding, maxSize } = args as unknown as FileReadArgs;
    const maxBytes = maxSize ?? MAX_FILE_SIZE;

    if (!checkRateLimit('file-read', { maxRequests: 200, windowMs: 60000 })) {
      return JSON.stringify({
        success: false,
        error: 'Rate limit exceeded for file-read operations',
        code: 'RATE_LIMIT_EXCEEDED',
      });
    }

    const sessionCwd = (args as Record<string, unknown>)._sessionCwd as string | undefined;

    const results = await Promise.all(
      files.map((item) => readSingleFile(item, encoding, maxBytes, sessionCwd))
    );

    const successful = results.filter((r) => r.success);
    const failed = results.filter((r) => !r.success);

    // Silent mode: return content directly without metadata wrappers
    if (isSilent()) {
      if (files.length === 1 && successful.length === 1) {
        // Single file: return content or lines directly
        const r = successful[0];
        if (r.content) return r.content as string;
        if (r.lines) return JSON.stringify(r.lines);
      }
      // Multiple files: compact array (use template for better perf on simple cases)
      if (results.length <= 5) {
        const items = results.map((r) => {
          if (!r.success) {
            const escapedPath = String(r.path).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
            const escapedError = String(r.error).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
            return `{"path":"${escapedPath}","error":"${escapedError}"}`;
          }
          const escapedPath = String(r.path).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
          // For content, fallback to JSON.stringify since it may be large/complex
          return `{"path":"${escapedPath}","content":${JSON.stringify(r.content ?? r.lines)}}`;
        }).join(',');
        return `[${items}]`;
      }
      // Fallback for many files
      return JSON.stringify(results.map((r) => r.success
        ? { path: r.path, content: r.content ?? r.lines }
        : { path: r.path, error: r.error }
      ));
    }

    return JSON.stringify({
      success: failed.length === 0,
      read: successful.length,
      failed: failed.length,
      results,
    });
  },
};
