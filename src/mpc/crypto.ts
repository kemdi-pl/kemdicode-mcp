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
 * MPC Cryptographic Utilities
 *
 * AES-256-GCM encryption for securing shares and deriving session keys.
 * Uses Node.js built-in crypto module.
 */

import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  pbkdf2Sync,
} from 'crypto';

/**
 * Encryption result with IV and auth tag
 */
export interface EncryptedData {
  /** Encrypted data (hex) */
  ciphertext: string;
  /** Initialization vector (hex) */
  iv: string;
  /** Authentication tag (hex) */
  authTag: string;
}

/**
 * Generate a random 256-bit key
 */
export function generateKey(): Buffer {
  return randomBytes(32);
}

/**
 * Generate a random 96-bit IV for AES-GCM
 */
export function generateIV(): Buffer {
  return randomBytes(12);
}

/**
 * Derive a key from a password/passphrase using PBKDF2
 */
export function deriveKey(passphrase: string, salt?: Buffer): { key: Buffer; salt: Buffer } {
  const actualSalt = salt || randomBytes(16);
  const key = pbkdf2Sync(passphrase, actualSalt, 100000, 32, 'sha256');
  return { key, salt: actualSalt };
}

/**
 * Derive a session-specific key from session ID using HKDF
 *
 * SECURITY: Uses HKDF (HMAC-based Key Derivation Function) with proper
 * salt derivation instead of simple SHA256 concatenation.
 * This prevents collision attacks and provides proper key separation.
 */
export function deriveSessionKey(sessionId: string, masterSecret: string): Buffer {
  // Use HKDF: first extract, then expand
  // Extract: Create a PRK (pseudo-random key) using HMAC with session-derived salt
  const salt = createHash('sha256').update(`mpc-session-salt:${sessionId}`).digest();
  const prk = createHmac('sha256', salt).update(masterSecret).digest();

  // Expand: Derive the final key using HMAC with context info
  const info = Buffer.from(`mpc-key-v1:${sessionId}`, 'utf8');
  const key = createHmac('sha256', prk)
    .update(Buffer.concat([info, Buffer.from([1])]))
    .digest();

  return key;
}

/**
 * Encrypt data using AES-256-GCM
 */
export function encrypt(data: string, key: Buffer): EncryptedData {
  const iv = generateIV();
  const cipher = createCipheriv('aes-256-gcm', key, iv);

  let ciphertext = cipher.update(data, 'utf8', 'hex');
  ciphertext += cipher.final('hex');

  const authTag = cipher.getAuthTag();

  return {
    ciphertext,
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
  };
}

/**
 * Decrypt data using AES-256-GCM
 */
export function decrypt(encrypted: EncryptedData, key: Buffer): string {
  const iv = Buffer.from(encrypted.iv, 'hex');
  const authTag = Buffer.from(encrypted.authTag, 'hex');

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  let plaintext = decipher.update(encrypted.ciphertext, 'hex', 'utf8');
  plaintext += decipher.final('utf8');

  return plaintext;
}

/**
 * Hash data using SHA-256
 */
export function sha256(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Generate a verification hash for a secret
 * Uses double hashing for security
 */
export function generateVerificationHash(secret: string): string {
  const firstHash = sha256(secret);
  return sha256(firstHash);
}

/**
 * Verify a secret against its verification hash
 */
export function verifySecretHash(secret: string, verificationHash: string): boolean {
  const computedHash = generateVerificationHash(secret);
  // Constant-time comparison to prevent timing attacks
  if (computedHash.length !== verificationHash.length) {
    return false;
  }
  let result = 0;
  for (let i = 0; i < computedHash.length; i++) {
    result |= computedHash.charCodeAt(i) ^ verificationHash.charCodeAt(i);
  }
  return result === 0;
}

/**
 * Generate a unique secret ID
 */
export function generateSecretId(): string {
  return `secret_${Date.now()}_${randomBytes(8).toString('hex')}`;
}

/**
 * Generate a unique share ID
 */
export function generateShareId(secretId: string, index: number): string {
  return `share_${secretId}_${index}`;
}

/**
 * Encrypt a share for storage
 */
export function encryptShare(shareData: string, sessionKey: Buffer): EncryptedData {
  return encrypt(shareData, sessionKey);
}

/**
 * Decrypt a share from storage
 */
export function decryptShare(encrypted: EncryptedData, sessionKey: Buffer): string {
  return decrypt(encrypted, sessionKey);
}

/**
 * Key management for MPC operations
 *
 * SECURITY: Requires MPC_MASTER_SECRET environment variable to be set.
 * Without a persistent master secret, encrypted shares cannot be decrypted
 * after server restart.
 */
/**
 * Session key cache entry with TTL
 */
interface CachedKey {
  key: Buffer;
  expiresAt: number;
}

/**
 * Key management for MPC operations
 *
 * SECURITY: Session keys are cached with TTL to limit exposure window.
 */
export class MpcKeyManager {
  private sessionKeys: Map<string, CachedKey> = new Map();
  private masterSecret: string;
  private static readonly KEY_TTL_MS = 30 * 60 * 1000; // 30 minutes

  constructor(masterSecret?: string) {
    const secret = masterSecret || process.env.MPC_MASTER_SECRET;

    if (!secret) {
      throw new Error(
        'MPC_MASTER_SECRET environment variable is required for MPC operations. ' +
          'Set a persistent 64-character hex string (256 bits) to enable secret sharing. ' +
          'Example: export MPC_MASTER_SECRET=$(openssl rand -hex 32)'
      );
    }

    // Validate master secret format (should be at least 32 characters)
    if (secret.length < 32) {
      throw new Error(
        'MPC_MASTER_SECRET must be at least 32 characters (256 bits recommended). ' +
          'Generate with: openssl rand -hex 32'
      );
    }

    // SECURITY: Validate entropy - reject low-entropy secrets
    if (!this.hasAdequateEntropy(secret)) {
      throw new Error(
        'MPC_MASTER_SECRET has insufficient entropy. ' +
          'The secret appears to be a weak pattern (repeated chars, sequential, etc.). ' +
          'Generate a cryptographically secure secret with: openssl rand -hex 32'
      );
    }

    this.masterSecret = secret;
  }

  /**
   * Check if secret has adequate entropy
   * Rejects patterns like "aaaa...", "1234...", "0000..."
   */
  private hasAdequateEntropy(secret: string): boolean {
    // Check for repeated characters (more than 50% same char)
    const charCounts = new Map<string, number>();
    for (const char of secret) {
      charCounts.set(char, (charCounts.get(char) || 0) + 1);
    }
    const maxCount = Math.max(...charCounts.values());
    if (maxCount > secret.length * 0.5) {
      return false;
    }

    // Check for sequential patterns (at least 8 unique chars required)
    if (charCounts.size < 8) {
      return false;
    }

    // Check for common weak patterns
    const weakPatterns = [
      /^(.)\1+$/, // All same character
      /^(01)+|^(10)+/, // Binary alternating
      /^(12)+|^(21)+|^(ab)+|^(ba)+/i, // Simple alternating
      /^0+$|^1+$/, // All zeros or ones
    ];
    for (const pattern of weakPatterns) {
      if (pattern.test(secret)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Get or derive a session key
   *
   * SECURITY: Keys are cached with TTL to limit exposure window.
   */
  getSessionKey(sessionId: string): Buffer {
    const now = Date.now();
    const cached = this.sessionKeys.get(sessionId);

    // Check if cached key is still valid
    if (cached && cached.expiresAt > now) {
      return cached.key;
    }

    // Derive new key and cache it
    const key = deriveSessionKey(sessionId, this.masterSecret);
    this.sessionKeys.set(sessionId, {
      key,
      expiresAt: now + MpcKeyManager.KEY_TTL_MS,
    });

    // Cleanup expired keys periodically
    if (this.sessionKeys.size > 100) {
      this.cleanupExpiredKeys();
    }

    return key;
  }

  /**
   * Remove expired keys from cache
   */
  private cleanupExpiredKeys(): void {
    const now = Date.now();
    for (const [sessionId, cached] of this.sessionKeys.entries()) {
      if (cached.expiresAt <= now) {
        this.sessionKeys.delete(sessionId);
      }
    }
  }

  /**
   * Clear a session key
   */
  clearSessionKey(sessionId: string): void {
    this.sessionKeys.delete(sessionId);
  }

  /**
   * Clear all session keys
   */
  clearAllKeys(): void {
    this.sessionKeys.clear();
  }

  /**
   * Encrypt data for a session
   */
  encryptForSession(sessionId: string, data: string): EncryptedData {
    const key = this.getSessionKey(sessionId);
    return encrypt(data, key);
  }

  /**
   * Decrypt data for a session
   */
  decryptForSession(sessionId: string, encrypted: EncryptedData): string {
    const key = this.getSessionKey(sessionId);
    return decrypt(encrypted, key);
  }
}

// Singleton instance
let keyManager: MpcKeyManager | null = null;

/**
 * Get the global MPC key manager
 */
export function getKeyManager(): MpcKeyManager {
  if (!keyManager) {
    keyManager = new MpcKeyManager();
  }
  return keyManager;
}

/**
 * Reset the global key manager (for testing)
 */
export function resetKeyManager(): void {
  if (keyManager) {
    keyManager.clearAllKeys();
  }
  keyManager = null;
}
