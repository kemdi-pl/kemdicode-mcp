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
 * Security utilities for input validation, sanitization, and safe operations
 * @module utils/security
 */

import { randomBytes, createHmac, scryptSync, createCipheriv, createDecipheriv } from 'crypto';
import { isBun } from '../runtime/index.js';
import { Logger } from './logger.js';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 16;

/**
 * Secure memory storage for sensitive data
 * Uses AES-256-GCM encryption in Bun, memory-safe storage in Node.js
 */
export class SecureStorage {
  private masterKey: Buffer;
  private secrets: Map<string, { encrypted: string; iv: string; tag: string }> = new Map();
  private static readonly MAX_SECRETS = 500;

  constructor(password: string, salt?: string) {
    const actualSalt = salt || process.env.SECURE_STORAGE_SALT;
    if (!actualSalt) {
      // Generate random salt per instance if not configured (ephemeral - not persisted)
      const ephemeralSalt = randomBytes(16).toString('hex');
      Logger.warn(
        '[SecureStorage] No salt configured. Using ephemeral salt (secrets will not survive restart). ' +
        'Set SECURE_STORAGE_SALT env var for persistence. Generate with: openssl rand -hex 32'
      );
      this.masterKey = scryptSync(password, ephemeralSalt, KEY_LENGTH);
    } else {
      this.masterKey = scryptSync(password, actualSalt, KEY_LENGTH);
    }
  }

  /**
   * Encrypt and store a secret
   */
  set(key: string, value: string): void {
    // Evict oldest entry if at capacity
    if (this.secrets.size >= SecureStorage.MAX_SECRETS && !this.secrets.has(key)) {
      const firstKey = this.secrets.keys().next().value;
      if (firstKey !== undefined) this.secrets.delete(firstKey);
    }

    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.masterKey, iv);
    let encrypted = cipher.update(value, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    this.secrets.set(key, {
      encrypted,
      iv: iv.toString('hex'),
      tag: cipher.getAuthTag().toString('hex'),
    });
  }

  /**
   * Retrieve and decrypt a secret
   */
  get(key: string): string | null {
    const data = this.secrets.get(key);
    if (!data) return null;

    try {
      const decipher = createDecipheriv(ALGORITHM, this.masterKey, Buffer.from(data.iv, 'hex'));
      decipher.setAuthTag(Buffer.from(data.tag, 'hex'));
      let decrypted = decipher.update(data.encrypted, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      return decrypted;
    } catch {
      return null;
    }
  }

  /**
   * Remove a secret from storage
   */
  delete(key: string): void {
    this.secrets.delete(key);
  }

  /**
   * Check if a key exists
   */
  has(key: string): boolean {
    return this.secrets.has(key);
  }

  /**
   * Clear all secrets
   */
  clear(): void {
    this.secrets.clear();
  }
}

// Global secure storage instance
let globalSecureStorage: SecureStorage | null = null;

export function getSecureStorage(): SecureStorage {
  if (!globalSecureStorage) {
    const masterPassword = process.env.SECURE_STORAGE_KEY || randomBytes(32).toString('hex');
    globalSecureStorage = new SecureStorage(masterPassword);
  }
  return globalSecureStorage;
}

/**
 * Validate URL to prevent SSRF attacks
 * Blocks private IPs, localhost, and metadata endpoints
 */
export function validateUrl(url: string): { valid: boolean; error?: string } {
  try {
    const parsed = new URL(url);

    // Protocol check
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return { valid: false, error: `Invalid protocol: ${parsed.protocol}` };
    }

    // Hostname checks
    const blockedHosts = [
      'localhost',
      '127.0.0.1',
      '0.0.0.0',
      '169.254.169.254', // AWS metadata
      'metadata.google.internal',
      'metadata',
    ];

    if (blockedHosts.includes(parsed.hostname)) {
      return { valid: false, error: `Blocked hostname: ${parsed.hostname}` };
    }

    // Private IP ranges check
    if (isPrivateIP(parsed.hostname)) {
      return { valid: false, error: 'Private IP addresses are not allowed' };
    }

    return { valid: true };
  } catch {
    return { valid: false, error: 'Invalid URL format' };
  }
}

/**
 * Check if IP is in private range
 */
function isPrivateIP(ip: string): boolean {
  const privateRanges = [
    /^10\./,
    /^172\.(1[6-9]|2[0-9]|3[01])\./,
    /^192\.168\./,
    /^127\./,
    /^169\.254\./,
    /^0\./,
    /^fc00:/i,
    /^fe80:/i,
  ];

  return privateRanges.some((range) => range.test(ip));
}

/**
 * Sanitize a string for safe use in Redis keys
 * Prevents injection attacks
 */
export function sanitizeRedisKey(key: string): string {
  // Remove dangerous characters
  return key.replace(/[^a-zA-Z0-9_:.-]/g, '_');
}

/**
 * Validate and sanitize a filename or path component
 */
export function sanitizePathComponent(name: string): {
  valid: boolean;
  sanitized?: string;
  error?: string;
} {
  // Check for path traversal attempts
  if (name.includes('..') || name.includes('/') || name.includes('\\')) {
    return { valid: false, error: 'Path traversal detected' };
  }

  // Check for null bytes
  if (name.includes('\0')) {
    return { valid: false, error: 'Null byte detected' };
  }

  // Check length
  if (name.length > 255) {
    return { valid: false, error: 'Name too long (max 255 chars)' };
  }

  // Check for valid characters
  const validNameRegex = /^[a-zA-Z0-9._-]+$/;
  if (!validNameRegex.test(name)) {
    return { valid: false, error: 'Invalid characters in name' };
  }

  return { valid: true, sanitized: name };
}

/**
 * Resolve the HMAC secret from explicit parameter, env var, or secure storage.
 * Throws if no secret is available.
 */
function resolveHmacSecret(explicit?: string): string {
  const secret = explicit || process.env.HMAC_SECRET || getSecureStorage().get('hmac_secret');
  if (!secret) {
    throw new Error(
      'No HMAC secret available. Set HMAC_SECRET env var or provide secret parameter.'
    );
  }
  return secret;
}

/**
 * Sign data with HMAC for integrity verification
 */
export function signData(data: string, secret?: string): string {
  const hmacSecret = resolveHmacSecret(secret);
  return createHmac('sha256', hmacSecret).update(data).digest('hex');
}

/**
 * Verify data signature
 */
export function verifySignature(data: string, signature: string, secret?: string): boolean {
  const hmacSecret = resolveHmacSecret(secret);
  const expected = createHmac('sha256', hmacSecret).update(data).digest('hex');
  // Constant-time comparison to prevent timing attacks
  if (expected.length !== signature.length) return false;
  let result = 0;
  for (let i = 0; i < expected.length; i++) {
    result |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return result === 0;
}

/**
 * Mask sensitive data in logs
 */
export function maskSensitiveData(text: string): string {
  return text
    .replace(/(api[_-]?key[:=]\s*)([^\s&]+)/gi, '$1***')
    .replace(/(password[:=]\s*)([^\s&]+)/gi, '$1***')
    .replace(/(token[:=]\s*)([^\s&]+)/gi, '$1***')
    .replace(/(secret[:=]\s*)([^\s&]+)/gi, '$1***')
    .replace(/(nvapi-[a-zA-Z0-9]+)/gi, 'nvapi-***');
}

/**
 * Sanitize error message to prevent information leakage
 */
export function sanitizeErrorMessage(error: Error | string): string {
  const message = typeof error === 'string' ? error : error.message;

  return message
    .replace(/\/home\/[^/]+/g, '/home/<user>')
    .replace(/\/Users\/[^/]+/g, '/Users/<user>')
    .replace(process.cwd(), '<cwd>')
    .replace(/(?:api[_-]?key|password|token|secret)[=:][^\s&]+/gi, '<redacted>');
}

/**
 * Generate a cryptographically secure random ID
 */
export function generateSecureId(prefix = ''): string {
  const random = isBun
    ? crypto.getRandomValues(Buffer.allocUnsafe(16)).toString('hex')
    : randomBytes(16).toString('hex');
  const timestamp = Date.now().toString(36);
  return prefix ? `${prefix}_${timestamp}_${random}` : `${timestamp}_${random}`;
}

/**
 * Rate limiter using sliding window
 */
export class RateLimiter {
  private requests: Map<string, number[]> = new Map();
  private maxRequests: number;
  private windowMs: number;
  private static readonly MAX_KEYS = 1000;

  constructor(maxRequests = 100, windowMs = 60000) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  /**
   * Check if request is allowed
   */
  isAllowed(key: string): boolean {
    const now = Date.now();
    const timestamps = this.requests.get(key) || [];

    // Remove old timestamps
    const validTimestamps = timestamps.filter((t) => now - t < this.windowMs);

    if (validTimestamps.length >= this.maxRequests) {
      return false;
    }

    validTimestamps.push(now);
    this.requests.set(key, validTimestamps);

    // Evict stale keys if map grows too large
    if (this.requests.size > RateLimiter.MAX_KEYS) {
      for (const [k, v] of this.requests) {
        const valid = v.filter((t) => now - t < this.windowMs);
        if (valid.length === 0) {
          this.requests.delete(k);
        }
        if (this.requests.size <= RateLimiter.MAX_KEYS) break;
      }
    }

    return true;
  }

  /**
   * Get remaining requests
   */
  getRemaining(key: string): number {
    const now = Date.now();
    const timestamps = this.requests.get(key) || [];
    const validTimestamps = timestamps.filter((t) => now - t < this.windowMs);
    return Math.max(0, this.maxRequests - validTimestamps.length);
  }

  /**
   * Reset limit for a key
   */
  reset(key: string): void {
    this.requests.delete(key);
  }
}

/**
 * Safe JSON parse with size limit
 */
export function safeJsonParse(text: string, maxSize = 10 * 1024 * 1024): unknown | null {
  if (text.length > maxSize) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Keys blocked to prevent prototype pollution during JSON deserialization */
const PROTO_BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Parse JSON with prototype pollution protection.
 * Strips __proto__, constructor, and prototype keys from the parsed result.
 * Use for any data from external sources (Redis, HTTP, network).
 */
export function safeJsonParseNoProto<T = unknown>(raw: string): T | null {
  try {
    return JSON.parse(raw, (key, value) =>
      PROTO_BLOCKED_KEYS.has(key) ? undefined : value
    ) as T;
  } catch {
    return null;
  }
}

/**
 * Prevent prototype pollution in object merge
 */
export function safeObjectMerge<T extends Record<string, unknown>>(
  target: T,
  source: Record<string, unknown>
): T {
  const dangerousKeys = ['__proto__', 'constructor', 'prototype'];

  const safeSource = Object.entries(source).reduce(
    (acc, [key, value]) => {
      if (!dangerousKeys.includes(key)) {
        acc[key] = value;
      }
      return acc;
    },
    {} as Record<string, unknown>
  );

  return { ...target, ...safeSource } as T;
}

/**
 * Validate command arguments to prevent injection.
 *
 * Arguments that follow a regex flag (-e, --regexp, -g, --glob) are exempt
 * from metacharacter checks because they are regex/glob patterns passed
 * directly to the child process (no shell expansion when shell: false).
 */
export function validateCommandArgs(args: string[]): { valid: boolean; error?: string } {
  const REGEX_FLAGS = new Set(['-e', '--regexp', '-g', '--glob']);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    // Skip regex/glob pattern values — they legitimately contain ()[]|*? etc.
    if (i > 0 && REGEX_FLAGS.has(args[i - 1])) {
      // Still block shell execution vectors even in patterns
      if (arg.includes('$(') || arg.includes('`')) {
        return { valid: false, error: 'Command substitution not allowed in pattern' };
      }
      continue;
    }

    // Check for shell metacharacters
    const dangerousChars = /[;&|`$(){}[\]\\*?<>]/;
    if (dangerousChars.test(arg)) {
      return { valid: false, error: `Invalid character in argument: ${arg.slice(0, 20)}` };
    }

    // Check for command substitution
    if (arg.includes('$(') || arg.includes('`')) {
      return { valid: false, error: 'Command substitution not allowed' };
    }
  }

  return { valid: true };
}

/**
 * Create a secure temporary directory path
 */
export function getSecureTempPath(prefix = 'kemdicode-'): string {
  const random = randomBytes(8).toString('hex');
  const tmpDir = process.env.TMPDIR || process.env.TEMP || '/tmp';
  return `${tmpDir}/${prefix}${random}`;
}
