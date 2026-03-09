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
 * Crypto Abstraction
 *
 * Cross-runtime cryptographic utilities for Bun and Node.js.
 * Uses Bun.CryptoHasher for 2-3x faster hashing in Bun runtime.
 *
 * @module runtime/crypto
 */

import {
  randomUUID as nodeRandomUUID,
  randomBytes as nodeRandomBytes,
  createHash,
  timingSafeEqual as nodeTimingSafeEqual,
} from 'crypto';
import { isBun } from './index.js';

/**
 * Generate a random UUID v4
 * Bun: uses native crypto.getRandomValues() - faster
 */
export function randomUUID(): string {
  if (isBun && typeof crypto !== 'undefined' && crypto.randomUUID) {
    // Bun has optimized randomUUID
    return crypto.randomUUID();
  }
  return nodeRandomUUID();
}

/**
 * Generate random bytes
 * Bun: uses native random generation - faster
 */
export function randomBytes(size: number): Buffer {
  if (isBun && typeof crypto !== 'undefined' && crypto.getRandomValues) {
    // Bun.allocUnsafe + crypto.getRandomValues is faster
    const buf = Buffer.allocUnsafe(size);
    crypto.getRandomValues(buf);
    return buf;
  }
  return nodeRandomBytes(size);
}

/**
 * Generate a random hex string
 */
export function randomHex(bytes: number): string {
  if (isBun && typeof crypto !== 'undefined' && crypto.getRandomValues) {
    // Direct hex encoding in Bun
    const buf = Buffer.allocUnsafe(bytes);
    crypto.getRandomValues(buf);
    return buf.toString('hex');
  }
  return randomBytes(bytes).toString('hex');
}

/**
 * Generate a short random ID
 *
 * @param prefix - Optional prefix for the ID
 * @returns Random ID string
 */
export function randomId(prefix = ''): string {
  const timestamp = Date.now().toString(36);
  const random = randomHex(4);
  return prefix ? `${prefix}_${timestamp}_${random}` : `${timestamp}_${random}`;
}

/**
 * Generate a request ID for logging
 * Bun: shorter, faster ID
 */
export function requestId(): string {
  if (isBun && typeof crypto !== 'undefined' && crypto.getRandomValues) {
    // Faster ID generation in Bun
    const buf = Buffer.allocUnsafe(8);
    crypto.getRandomValues(buf);
    return `req_${buf.toString('hex')}`;
  }
  return `req_${randomUUID().replace(/-/g, '').substring(0, 12)}`;
}

/**
 * Fast SHA-256 hashing using Bun.CryptoHasher
 * 2-3x faster than Node.js crypto in Bun runtime
 */
export function sha256(data: string): string {
  if (isBun && typeof Bun !== 'undefined' && Bun.CryptoHasher) {
    const hasher = new Bun.CryptoHasher('sha256');
    hasher.update(data);
    return hasher.digest('hex') as string;
  }
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Fast SHA-512 hashing using Bun.CryptoHasher
 */
export function sha512(data: string): string {
  if (isBun && typeof Bun !== 'undefined' && Bun.CryptoHasher) {
    const hasher = new Bun.CryptoHasher('sha512');
    hasher.update(data);
    return hasher.digest('hex') as string;
  }
  return createHash('sha512').update(data).digest('hex');
}

/**
 * Fast MD5 hashing (for non-cryptographic use only)
 */
export function md5(data: string): string {
  if (isBun && typeof Bun !== 'undefined' && Bun.CryptoHasher) {
    const hasher = new Bun.CryptoHasher('md5');
    hasher.update(data);
    return hasher.digest('hex') as string;
  }
  return createHash('md5').update(data).digest('hex');
}

/**
 * Hash data using specified algorithm
 * Automatically uses Bun.CryptoHasher when available
 */
export function hash(data: string, algorithm: 'sha256' | 'sha512' | 'md5' = 'sha256'): string {
  switch (algorithm) {
    case 'sha256':
      return sha256(data);
    case 'sha512':
      return sha512(data);
    case 'md5':
      return md5(data);
    default:
      return sha256(data);
  }
}

/**
 * Hash a file using Bun's streaming CryptoHasher
 * Much faster than reading entire file into memory
 */
export async function hashFile(
  filePath: string,
  algorithm: 'sha256' | 'sha512' | 'md5' = 'sha256'
): Promise<string> {
  if (isBun && typeof Bun !== 'undefined') {
    const file = Bun.file(filePath);
    const hasher = new Bun.CryptoHasher(algorithm);

    // Stream the file for memory efficiency
    const stream = file.stream();
    const reader = stream.getReader();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      hasher.update(value);
    }

    return hasher.digest('hex') as string;
  }

  // Fallback to Node.js streaming
  const { createReadStream } = await import('fs');
  const hash = createHash(algorithm);

  return new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * Generate a cryptographically secure session ID
 */
export function generateSessionId(): string {
  if (isBun && typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const buf = Buffer.allocUnsafe(16);
    crypto.getRandomValues(buf);
    return `sess_${buf.toString('hex')}`;
  }
  return `sess_${randomUUID().replace(/-/g, '').substring(0, 16)}`;
}

/**
 * Generate a secure agent ID
 */
export function generateAgentId(): string {
  if (isBun && typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const buf = Buffer.allocUnsafe(8);
    crypto.getRandomValues(buf);
    return `agent_${buf.toString('hex')}`;
  }
  return `agent_${randomUUID().replace(/-/g, '').substring(0, 8)}`;
}

/**
 * Generate a secure context entry ID
 */
export function generateContextId(): string {
  if (isBun && typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const buf = Buffer.allocUnsafe(12);
    crypto.getRandomValues(buf);
    return `ctx_${buf.toString('hex')}`;
  }
  return `ctx_${randomUUID().replace(/-/g, '').substring(0, 12)}`;
}

/**
 * Constant-time comparison to prevent timing attacks
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;

  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);

  if (bufA.length !== bufB.length) return false;
  return nodeTimingSafeEqual(bufA, bufB);
}

/**
 * Generate a secure random integer within range
 */
export function randomInt(min: number, max: number): number {
  const range = max - min;
  if (isBun && typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const buf = Buffer.allocUnsafe(4);
    crypto.getRandomValues(buf);
    return min + (buf.readUInt32LE(0) % range);
  }
  // Fallback using randomBytes
  const buf = nodeRandomBytes(4);
  return min + (buf.readUInt32LE(0) % range);
}
