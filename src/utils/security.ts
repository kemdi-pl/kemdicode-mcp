/**
 * KemdiCode MCP Server - Security Utilities
 * Copyright (C) 2025-2026 Kemdi Sp. z o.o.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

/**
 * Security utilities for input validation, sanitization, and safe operations
 * @module utils/security
 */

import { randomBytes, createHmac, scryptSync, createCipheriv, createDecipheriv } from 'crypto';
import { isBun } from '../runtime/index.js';

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
    const actualSalt = salt || process.env.SECURE_STORAGE_SALT || 'kemdicode-mcp-salt';
    this.masterKey = scryptSync(password, actualSalt, KEY_LENGTH);
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
 * Sign data with HMAC for integrity verification
 */
export function signData(data: string, secret?: string): string {
  const hmacSecret =
    secret || process.env.HMAC_SECRET || getSecureStorage().get('hmac_secret') || 'default-secret';
  return createHmac('sha256', hmacSecret).update(data).digest('hex');
}

/**
 * Verify data signature
 */
export function verifySignature(data: string, signature: string, secret?: string): boolean {
  // Timing-safe comparison
  try {
    return createHmac('sha256', secret || '')
      .update(data)
      .digest()
      .equals(Buffer.from(signature, 'hex'));
  } catch {
    return false;
  }
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
 * Validate command arguments to prevent injection
 */
export function validateCommandArgs(args: string[]): { valid: boolean; error?: string } {
  for (const arg of args) {
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
