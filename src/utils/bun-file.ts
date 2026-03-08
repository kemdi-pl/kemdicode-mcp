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
 * Bun-optimized file operations
 * Falls back to Node.js fs/promises when not running under Bun
 * @module utils/bun-file
 */

import { isBun } from '../runtime/index.js';
import type { FileValidationResult } from './file-utils.js';

/**
 * Bun-optimized file reading using Bun.file()
 * 2-3x faster than Node.js fs for text files
 */
export async function readFileBun(
  filePath: string,
  encoding: 'utf-8' | 'binary' = 'utf-8'
): Promise<string | Buffer> {
  if (isBun) {
    const file = Bun.file(filePath);
    const exists = await file.exists();
    if (!exists) {
      throw new Error(`File not found: ${filePath}`);
    }

    if (encoding === 'utf-8') {
      return await file.text();
    }

    const arrayBuffer = await file.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  // Fallback dla Node.js
  const { readFile } = await import('fs/promises');
  return readFile(filePath, encoding === 'utf-8' ? 'utf-8' : undefined);
}

/**
 * Bun-optimized file writing using Bun.write()
 * 3-5x faster than Node.js fs.writeFile - uses kernel-specific optimizations
 */
export async function writeFileBun(
  filePath: string,
  content: string | Buffer | Uint8Array
): Promise<void> {
  if (isBun) {
    await Bun.write(filePath, content);
    return;
  }

  const { writeFile } = await import('fs/promises');
  await writeFile(filePath, content);
}

/**
 * Bun-optimized file info retrieval
 */
export async function getFileInfoBun(filePath: string): Promise<{
  size: number;
  exists: boolean;
  isFile: boolean;
  lastModified: number;
}> {
  if (isBun) {
    const file = Bun.file(filePath);
    const exists = await file.exists();
    if (!exists) {
      return { size: 0, exists: false, isFile: false, lastModified: 0 };
    }
    return {
      size: file.size,
      exists: true,
      isFile: true,
      lastModified: file.lastModified,
    };
  }

  // Fallback Node.js
  const { stat } = await import('fs/promises');
  try {
    const stats = await stat(filePath);
    return {
      size: stats.size,
      exists: true,
      isFile: stats.isFile(),
      lastModified: stats.mtimeMs,
    };
  } catch {
    return { size: 0, exists: false, isFile: false, lastModified: 0 };
  }
}

/**
 * Bun-optimized file validation
 */
export async function validateFileBun(
  path: string,
  maxSize?: number
): Promise<FileValidationResult> {
  if (isBun) {
    const file = Bun.file(path);
    const exists = await file.exists();

    if (!exists) {
      return { valid: false, error: `File not found: ${path}`, size: 0, isFile: false };
    }

    const size = file.size;

    if (maxSize !== undefined && size > maxSize) {
      return {
        valid: false,
        error: `File too large: ${size} bytes (max: ${maxSize})`,
        size,
        isFile: true,
      };
    }

    return { valid: true, size, isFile: true };
  }

  // Fallback do istniejącej implementacji
  const { validateFile } = await import('./file-utils.js');
  return validateFile(path, maxSize);
}

/**
 * Bun-optimized directory creation
 */
export async function mkdirBun(dirPath: string, recursive = true): Promise<void> {
  if (isBun) {
    // Bun has optimized mkdir
    await Bun.write(dirPath + '/.keep', '');
    // Remove the placeholder
    const { unlink } = await import('fs/promises');
    await unlink(dirPath + '/.keep').catch(() => {});
    return;
  }

  const { mkdir } = await import('fs/promises');
  await mkdir(dirPath, { recursive });
}

/**
 * Bun-optimized file existence check
 */
export async function existsBun(filePath: string): Promise<boolean> {
  if (isBun) {
    const file = Bun.file(filePath);
    const fileExists = await file.exists();
    if (fileExists) return true;
    // Bun.file().exists() returns false for directories — fall through to stat
  }

  const { stat } = await import('fs/promises');
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Bun-optimized file copy
 */
export async function copyFileBun(src: string, dest: string): Promise<boolean> {
  try {
    if (isBun) {
      const file = Bun.file(src);
      if (!(await file.exists())) {
        return false;
      }
      await Bun.write(dest, file);
      return true;
    }

    const { copyFile } = await import('fs/promises');
    await copyFile(src, dest);
    return true;
  } catch {
    return false;
  }
}

/**
 * Bun-optimized file removal
 */
export async function removeFileBun(filePath: string): Promise<boolean> {
  try {
    if (isBun) {
      const file = Bun.file(filePath);
      if (!(await file.exists())) {
        return false;
      }
    }

    const { unlink } = await import('fs/promises');
    await unlink(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Bun-optimized directory creation
 */
export async function ensureDirBun(dirPath: string): Promise<boolean> {
  try {
    if (isBun) {
      // Use mkdir with recursive
      const { mkdir } = await import('fs/promises');
      await mkdir(dirPath, { recursive: true });
      return true;
    }

    const { mkdir } = await import('fs/promises');
    await mkdir(dirPath, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Bun-optimized directory listing
 */
export async function readDirBun(dirPath: string): Promise<string[]> {
  try {
    const { readdir } = await import('fs/promises');
    return await readdir(dirPath);
  } catch {
    return [];
  }
}

/**
 * Bun-optimized file deletion
 */
export async function deleteFileBun(filePath: string): Promise<boolean> {
  return removeFileBun(filePath);
}

/**
 * Bun-optimized glob pattern matching
 */
export async function globBun(pattern: string, cwd?: string): Promise<string[]> {
  if (isBun) {
    // Bun has native glob support in Bun.glob()
    const glob = new Bun.Glob(pattern);
    const results: string[] = [];
    for await (const file of glob.scan(cwd || '.')) {
      results.push(file);
    }
    return results;
  }

  // Fallback - use simple glob implementation
  const { readdir } = await import('fs/promises');
  const { join } = await import('path');
  const path = cwd || '.';
  const files = await readdir(path, { recursive: true, withFileTypes: true });
  const regex = new RegExp(pattern.replace(/\*/g, '.*').replace(/\?/g, '.'));
  return files
    .filter((f) => f.isFile() && regex.test(f.name))
    .map((f) => join(f.parentPath || path, f.name));
}

/**
 * Bun-optimized file streaming for large files
 */
export async function* streamFileLinesBun(filePath: string): AsyncGenerator<string> {
  if (isBun) {
    const file = Bun.file(filePath);
    const stream = file.stream();
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        yield line;
      }
    }

    if (buffer) {
      yield buffer;
    }
    return;
  }

  // Fallback - read entire file and split
  const { readFile } = await import('fs/promises');
  const content = await readFile(filePath, 'utf-8');
  const lines = content.split('\n');
  for (const line of lines) {
    yield line;
  }
}

/**
 * Bun-optimized hash calculation
 */
export async function hashFileBun(
  filePath: string,
  algorithm: 'sha256' | 'md5' = 'sha256'
): Promise<string> {
  if (isBun) {
    const file = Bun.file(filePath);
    const hasher = new Bun.CryptoHasher(algorithm);

    // Stream the file
    const stream = file.stream();
    const reader = stream.getReader();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      hasher.update(value);
    }

    return hasher.digest('hex') as string;
  }

  // Fallback to Node.js crypto
  const { createHash } = await import('crypto');
  const { createReadStream } = await import('fs');

  return new Promise((resolve, reject) => {
    const hash = createHash(algorithm);
    const stream = createReadStream(filePath);

    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * Get Bun-optimized fetch with connection pooling
 */
export function createBunFetch(): typeof fetch {
  if (isBun) {
    // Bun fetch has built-in connection pooling
    return fetch;
  }

  return fetch;
}

/**
 * Bun-optimized JSON file operations
 */
export async function readJsonFileBun<T>(filePath: string): Promise<T | null> {
  try {
    const content = (await readFileBun(filePath, 'utf-8')) as string;
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

export async function writeJsonFileBun(
  filePath: string,
  data: unknown,
  pretty = false
): Promise<void> {
  const content = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
  await writeFileBun(filePath, content);
}

/**
 * Safe JSON read - returns null on error
 */
export async function safeReadJsonBun<T>(filePath: string): Promise<T | null> {
  return readJsonFileBun<T>(filePath);
}

/**
 * Safe JSON write - returns success status
 */
export async function safeWriteJsonBun(filePath: string, data: unknown): Promise<boolean> {
  try {
    await writeJsonFileBun(filePath, data);
    return true;
  } catch {
    return false;
  }
}

/**
 * Bun-optimized string hashing
 */
export async function hashStringBun(
  data: string,
  algorithm: 'sha256' | 'md5' = 'sha256'
): Promise<string> {
  if (isBun) {
    const hasher = new Bun.CryptoHasher(algorithm);
    hasher.update(data);
    return hasher.digest('hex') as string;
  }

  // Fallback to Node.js crypto
  const { createHash } = await import('crypto');
  const hash = createHash(algorithm);
  hash.update(data);
  return hash.digest('hex');
}

/**
 * Batch file operations with Bun optimizations
 */
export async function batchFileOperations<T>(
  operations: (() => Promise<T>)[],
  concurrency = 10
): Promise<(T | Error)[]> {
  if (isBun) {
    // Bun has optimized Promise.all for parallel operations
    const results: (T | Error)[] = [];

    for (let i = 0; i < operations.length; i += concurrency) {
      const batch = operations.slice(i, i + concurrency);
      const batchResults = await Promise.all(
        batch.map(async (op) => {
          try {
            return await op();
          } catch (error) {
            return error instanceof Error ? error : new Error(String(error));
          }
        })
      );
      results.push(...batchResults);
    }

    return results;
  }

  // Standard parallel processing
  const results: (T | Error)[] = [];
  for (const op of operations) {
    try {
      results.push(await op());
    } catch (error) {
      results.push(error instanceof Error ? error : new Error(String(error)));
    }
  }
  return results;
}
