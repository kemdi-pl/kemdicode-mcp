/**
 * KemdiCode MCP Server - Bun File Module Tests
 * Copyright (C) 2024-2026 Kemdi Sp. z o.o.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  readFileBun,
  writeFileBun,
  existsBun,
  getFileInfoBun,
  removeFileBun,
  copyFileBun,
  ensureDirBun,
  readDirBun,
  hashFileBun,
  hashStringBun,
  globBun,
  safeReadJsonBun,
  safeWriteJsonBun,
} from '../../src/utils/bun-file.js';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdtempSync, rmdirSync, writeFileSync } from 'fs';

describe('Bun File Module', () => {
  const testDir = mkdtempSync(join(tmpdir(), 'bun-file-test-'));

  beforeAll(() => {
    // Create test files
    writeFileSync(join(testDir, 'test.txt'), 'Hello, World!');
    writeFileSync(join(testDir, 'test.json'), '{"key": "value"}');
  });

  afterAll(() => {
    // Cleanup
    try {
      rmdirSync(testDir, { recursive: true });
    } catch {
      // Ignore
    }
  });

  describe('readFileBun', () => {
    it('should read file content', async () => {
      const content = await readFileBun(join(testDir, 'test.txt'));
      expect(content).toBe('Hello, World!');
    });

    it('should throw for non-existent file', async () => {
      await expect(readFileBun(join(testDir, 'non-existent.txt'))).rejects.toThrow();
    });
  });

  describe('writeFileBun', () => {
    it('should write file content', async () => {
      const filePath = join(testDir, 'write-test.txt');
      await writeFileBun(filePath, 'Test content');
      
      const content = await readFileBun(filePath);
      expect(content).toBe('Test content');
    });
  });

  describe('existsBun', () => {
    it('should return true for existing file', async () => {
      const exists = await existsBun(join(testDir, 'test.txt'));
      expect(exists).toBe(true);
    });

    it('should return false for non-existent file', async () => {
      const exists = await existsBun(join(testDir, 'non-existent.txt'));
      expect(exists).toBe(false);
    });
  });

  describe('getFileInfoBun', () => {
    it('should return file info for existing file', async () => {
      const info = await getFileInfoBun(join(testDir, 'test.txt'));
      expect(info).not.toBeNull();
      expect(info?.size).toBeGreaterThan(0);
      expect(info?.isFile).toBe(true);
      expect(info?.exists).toBe(true);
    });

    it('should return exists=false for non-existent file', async () => {
      const info = await getFileInfoBun(join(testDir, 'non-existent.txt'));
      expect(info?.exists).toBe(false);
    });
  });

  describe('safeReadJsonBun', () => {
    it('should parse JSON file', async () => {
      const data = await safeReadJsonBun<{ key: string }>(join(testDir, 'test.json'));
      expect(data).toEqual({ key: 'value' });
    });

    it('should return null for invalid JSON', async () => {
      const filePath = join(testDir, 'invalid.json');
      await writeFileBun(filePath, 'not json');
      const data = await safeReadJsonBun(filePath);
      expect(data).toBeNull();
    });

    it('should return null for non-existent file', async () => {
      const data = await safeReadJsonBun(join(testDir, 'non-existent.json'));
      expect(data).toBeNull();
    });
  });

  describe('safeWriteJsonBun', () => {
    it('should write JSON file', async () => {
      const filePath = join(testDir, 'write-test.json');
      const data = { test: true, number: 42 };
      
      const success = await safeWriteJsonBun(filePath, data);
      expect(success).toBe(true);
      
      const read = await safeReadJsonBun(filePath);
      expect(read).toEqual(data);
    });
  });

  describe('hashStringBun', () => {
    it('should hash string with SHA-256', async () => {
      const hash = await hashStringBun('test', 'sha256');
      expect(typeof hash).toBe('string');
      expect(hash.length).toBe(64); // SHA-256 hex is 64 chars
    });

    it('should hash string with MD5', async () => {
      const hash = await hashStringBun('test', 'md5');
      expect(typeof hash).toBe('string');
      expect(hash.length).toBe(32); // MD5 hex is 32 chars
    });

    it('should return hash for empty input', async () => {
      const hash = await hashStringBun('', 'sha256');
      expect(typeof hash).toBe('string');
      expect(hash.length).toBeGreaterThan(0);
    });
  });

  describe('hashFileBun', () => {
    it('should hash existing file', async () => {
      const hash = await hashFileBun(join(testDir, 'test.txt'));
      expect(typeof hash).toBe('string');
      expect(hash.length).toBe(64);
    });

    it('should throw for non-existent file', async () => {
      await expect(hashFileBun(join(testDir, 'non-existent.txt'))).rejects.toThrow();
    });
  });

  describe('ensureDirBun', () => {
    it('should create directory', async () => {
      const dirPath = join(testDir, 'new-dir');
      const success = await ensureDirBun(dirPath);
      expect(success).toBe(true);
      expect(await existsBun(dirPath)).toBe(true);
    });

    it('should return true for existing directory', async () => {
      const success = await ensureDirBun(testDir);
      expect(success).toBe(true);
    });
  });

  describe('readDirBun', () => {
    it('should list directory contents', async () => {
      const entries = await readDirBun(testDir);
      expect(Array.isArray(entries)).toBe(true);
      expect(entries.length).toBeGreaterThan(0);
    });

    it('should return empty array for non-existent directory', async () => {
      const entries = await readDirBun(join(testDir, 'non-existent'));
      expect(entries).toEqual([]);
    });
  });

  describe('copyFileBun', () => {
    it('should copy file', async () => {
      const source = join(testDir, 'test.txt');
      const dest = join(testDir, 'test-copy.txt');
      
      const success = await copyFileBun(source, dest);
      expect(success).toBe(true);
      expect(await existsBun(dest)).toBe(true);
      
      const original = await readFileBun(source);
      const copy = await readFileBun(dest);
      expect(original).toBe(copy);
    });

    it('should return false for non-existent source', async () => {
      const success = await copyFileBun(
        join(testDir, 'non-existent.txt'),
        join(testDir, 'dest.txt')
      );
      expect(success).toBe(false);
    });
  });

  describe('removeFileBun', () => {
    it('should remove file', async () => {
      const filePath = join(testDir, 'to-remove.txt');
      await writeFileBun(filePath, 'delete me');
      expect(await existsBun(filePath)).toBe(true);
      
      const success = await removeFileBun(filePath);
      expect(success).toBe(true);
      expect(await existsBun(filePath)).toBe(false);
    });

    it('should return false for non-existent file', async () => {
      const success = await removeFileBun(join(testDir, 'non-existent.txt'));
      expect(success).toBe(false);
    });
  });

  describe('globBun', () => {
    it('should match files with pattern', async () => {
      const files = await globBun('*.txt', testDir);
      expect(files.length).toBeGreaterThan(0);
    });

    it('should return empty array for no matches', async () => {
      const files = await globBun('*.xyz', testDir);
      expect(files).toEqual([]);
    });
  });
});
