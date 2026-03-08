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

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { formatResponse, silentIds, silentOk, silentCount } from '../../src/utils/response.js';
import { setOutputLevel, getOutputLevel, type OutputLevel } from '../../src/config/silent.js';

describe('Response Formatter', () => {
  let originalLevel: OutputLevel;

  beforeEach(() => {
    originalLevel = getOutputLevel();
  });

  afterEach(() => {
    setOutputLevel(originalLevel);
  });

  describe('formatResponse - normal mode', () => {
    beforeEach(() => setOutputLevel('normal'));

    it('should pass through string data unchanged', () => {
      expect(formatResponse('hello world')).toBe('hello world');
    });

    it('should JSON.stringify objects', () => {
      const data = { key: 'value', num: 42 };
      expect(formatResponse(data)).toBe(JSON.stringify(data));
    });

    it('should JSON.stringify arrays', () => {
      const data = [1, 2, 3];
      expect(formatResponse(data)).toBe(JSON.stringify(data));
    });
  });

  describe('formatResponse - silent mode', () => {
    beforeEach(() => setOutputLevel('silent'));

    it('should strip success field', () => {
      const data = { success: true, id: '123', name: 'test' };
      const result = JSON.parse(formatResponse(data));
      expect(result.success).toBeUndefined();
      expect(result.id).toBe('123');
    });

    it('should strip sessionId field', () => {
      const data = { sessionId: 'sess-1', id: '123', name: 'test' };
      const result = JSON.parse(formatResponse(data));
      expect(result.sessionId).toBeUndefined();
      expect(result.id).toBe('123');
    });

    it('should strip createdBy field', () => {
      const data = { createdBy: 'agent-1', id: '123', name: 'test' };
      const result = JSON.parse(formatResponse(data));
      expect(result.createdBy).toBeUndefined();
    });

    it('should strip priorityIcon and statusIcon', () => {
      const data = { priorityIcon: '🔴', statusIcon: '✅', id: '123' };
      const result = JSON.parse(formatResponse(data));
      expect(result.priorityIcon).toBeUndefined();
      expect(result.statusIcon).toBeUndefined();
    });

    it('should strip tool field (single remaining value unwrapped)', () => {
      const data = { tool: 'git-status', result: 'ok' };
      // After stripping 'tool', only 'result' remains -> unwrapped to raw string 'ok'
      expect(formatResponse(data)).toBe('ok');
    });

    it('should strip timestamp fields in strict silent', () => {
      const data = { id: '123', name: 'test', createdAt: '2025-01-01', updatedAt: '2025-01-02' };
      const result = JSON.parse(formatResponse(data));
      expect(result.createdAt).toBeUndefined();
      expect(result.updatedAt).toBeUndefined();
      expect(result.id).toBe('123');
    });

    it('should strip encoding, totalLines, size fields in strict silent (single value unwrapped)', () => {
      const data = { content: 'hello', encoding: 'utf-8', totalLines: 10, size: 500 };
      // After stripping encoding/totalLines/size, only 'content' remains -> unwrapped
      expect(formatResponse(data)).toBe('hello');
    });

    it('should strip null and undefined values', () => {
      const data = { id: '123', name: null, desc: undefined };
      const result = JSON.parse(formatResponse(data));
      expect(result.name).toBeUndefined();
      expect(result.desc).toBeUndefined();
    });

    it('should strip empty arrays', () => {
      const data = { id: '123', tags: [], items: [1] };
      const result = JSON.parse(formatResponse(data));
      expect(result.tags).toBeUndefined();
      expect(result.items).toEqual([1]);
    });

    it('should unwrap single-value objects to raw value', () => {
      const data = { content: 'hello world' };
      expect(formatResponse(data)).toBe('hello world');
    });

    it('should unwrap single-value arrays', () => {
      const data = { items: [1, 2, 3] };
      expect(formatResponse(data)).toBe(JSON.stringify([1, 2, 3]));
    });

    it('should recursively strip nested objects', () => {
      const data = {
        task: {
          id: '1',
          success: true,
          sessionId: 'sess',
          title: 'Test',
        },
      };
      const result = JSON.parse(formatResponse(data));
      expect(result.task.success).toBeUndefined();
      expect(result.task.sessionId).toBeUndefined();
      expect(result.task.id).toBe('1');
      expect(result.task.title).toBe('Test');
    });

    it('should truncate large responses', () => {
      const data = { content: 'x'.repeat(10000) };
      const result = formatResponse(data);
      expect(result.length).toBeLessThanOrEqual(8192 + 20); // max + truncation marker
      expect(result).toContain('...[truncated]');
    });

    it('should handle non-object data', () => {
      expect(formatResponse(42)).toBe('42');
      expect(formatResponse(true)).toBe('true');
      expect(formatResponse(null)).toBe('null');
    });
  });

  describe('formatResponse - compact mode', () => {
    beforeEach(() => setOutputLevel('compact'));

    it('should strip success/sessionId but keep timestamps', () => {
      const data = {
        success: true,
        sessionId: 'sess-1',
        id: '123',
        createdAt: '2025-01-01',
      };
      const result = JSON.parse(formatResponse(data));
      expect(result.success).toBeUndefined();
      expect(result.sessionId).toBeUndefined();
      expect(result.id).toBe('123');
      expect(result.createdAt).toBe('2025-01-01');
    });
  });

  describe('formatResponse - per-call level override', () => {
    beforeEach(() => setOutputLevel('normal'));

    it('should use override level when specified', () => {
      const data = { success: true, id: '123' };
      const result = JSON.parse(formatResponse(data, { level: 'silent' }));
      expect(result.success).toBeUndefined();
    });

    it('should use normal when override is normal', () => {
      setOutputLevel('silent');
      const data = { success: true, id: '123' };
      const result = JSON.parse(formatResponse(data, { level: 'normal' }));
      expect(result.success).toBe(true);
    });
  });

  describe('formatResponse - keep option', () => {
    beforeEach(() => setOutputLevel('silent'));

    it('should preserve fields listed in keep', () => {
      const data = { success: true, sessionId: 'sess-1', id: '123' };
      const result = JSON.parse(formatResponse(data, { keep: ['sessionId'] }));
      expect(result.sessionId).toBe('sess-1');
      expect(result.success).toBeUndefined();
    });
  });

  describe('formatResponse - raw option', () => {
    beforeEach(() => setOutputLevel('silent'));

    it('should return raw string when raw is true', () => {
      expect(formatResponse('raw content', { raw: true })).toBe('raw content');
    });
  });

  describe('silentIds', () => {
    it('should return JSON array of IDs', () => {
      const result = silentIds(['id-1', 'id-2', 'id-3']);
      expect(JSON.parse(result)).toEqual(['id-1', 'id-2', 'id-3']);
    });

    it('should return empty array', () => {
      expect(JSON.parse(silentIds([]))).toEqual([]);
    });
  });

  describe('silentOk', () => {
    it('should return ok:true JSON', () => {
      expect(JSON.parse(silentOk())).toEqual({ ok: true });
    });
  });

  describe('silentCount', () => {
    it('should return count JSON with custom key', () => {
      expect(JSON.parse(silentCount('tasks', 42))).toEqual({ tasks: 42 });
    });

    it('should return zero count', () => {
      expect(JSON.parse(silentCount('items', 0))).toEqual({ items: 0 });
    });
  });
});
