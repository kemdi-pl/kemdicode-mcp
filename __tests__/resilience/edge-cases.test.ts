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
 * Level 4 Resilience Tests: Edge Cases and Boundary Conditions
 *
 * Tests edge cases, boundary conditions, and unusual inputs.
 *
 * Test Cases:
 * - R4.6: Boundary value handling
 * - R4.7: Large data handling
 * - R4.8: Unicode and encoding
 * - R4.9: Concurrent operations edge cases
 * - R4.10: Session lifecycle edge cases
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AgentMonitor } from '../../src/context/agent-monitor.js';
import { ContextStorage } from '../../src/context/storage.js';
import { SessionManager } from '../../src/session/manager.js';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';

describe('Level 4 Resilience: Edge Cases and Boundary Conditions', () => {
  let agentMonitor: AgentMonitor;
  let contextStorage: ContextStorage;
  let sessionManager: SessionManager;
  let mockRedis: Redis;

  const originalConsole = { ...console };

  beforeEach(async () => {
    // Suppress console during tests
    console.log = vi.fn();
    console.info = vi.fn();
    console.warn = vi.fn();
    console.error = vi.fn();
    console.debug = vi.fn();

    mockRedis = new RedisMock({ data: {} }) as unknown as Redis;
    agentMonitor = new AgentMonitor({ db: 3 });
    contextStorage = new ContextStorage({ db: 3 });
    sessionManager = new SessionManager();

    // Inject mock
    (agentMonitor as unknown as { redis: unknown }).redis = mockRedis;
    (agentMonitor as unknown as { subscriber: unknown }).subscriber = mockRedis;
    (agentMonitor as unknown as { connected: boolean }).connected = true;

    (contextStorage as unknown as { redis: unknown }).redis = mockRedis;
    (contextStorage as unknown as { connected: boolean }).connected = true;
  });

  afterEach(async () => {
    // Restore console
    console.log = originalConsole.log;
    console.info = originalConsole.info;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
    console.debug = originalConsole.debug;

    try {
      await agentMonitor.disconnect();
      await contextStorage.disconnect();
    } catch {
      // Ignore
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // R4.6: Boundary Value Handling
  // ═══════════════════════════════════════════════════════════════════════════

  describe('R4.6: Boundary value handling', () => {
    it('should handle very long agent names', async () => {
      const longName = 'A'.repeat(1000);
      const agent = await agentMonitor.registerAgent(
        longName,
        'worker',
        'test-session',
        'opencode-mcp'
      );

      expect(agent).not.toBeNull();
      expect(agent?.name).toBe(longName);
    });

    it('should handle very long session IDs', async () => {
      const longSessionId = 'session-' + 'x'.repeat(500);
      const agent = await agentMonitor.registerAgent(
        'TestAgent',
        'worker',
        longSessionId,
        'opencode-mcp'
      );

      expect(agent).not.toBeNull();

      const agents = await agentMonitor.listAgents(longSessionId);
      expect(agents.length).toBe(1);
    });

    it('should handle minimum TTL values', async () => {
      const result = await contextStorage.saveContext({
        id: 'min-ttl-test',
        sessionId: 'test-session',
        serverId: 'opencode-mcp',
        toolName: 'test',
        timestamp: Date.now() * 1000,
        ttl: 1, // 1 second TTL
        args: {},
        output: {},
        summary: 'Minimum TTL test',
        tags: [],
      });

      expect(result).toBe(true);
    });

    it('should handle zero and negative timestamps gracefully', async () => {
      // Zero timestamp
      const result1 = await contextStorage.saveContext({
        id: 'zero-ts-test',
        sessionId: 'test-session',
        serverId: 'opencode-mcp',
        toolName: 'test',
        timestamp: 0,
        ttl: 3600,
        args: {},
        output: {},
        summary: 'Zero timestamp',
        tags: [],
      });

      expect(result1).toBe(true);

      // Negative timestamp (edge case)
      const result2 = await contextStorage.saveContext({
        id: 'neg-ts-test',
        sessionId: 'test-session',
        serverId: 'opencode-mcp',
        toolName: 'test',
        timestamp: -1000,
        ttl: 3600,
        args: {},
        output: {},
        summary: 'Negative timestamp',
        tags: [],
      });

      expect(result2).toBe(true);
    });

    it('should handle maximum reasonable values', async () => {
      const result = await contextStorage.saveContext({
        id: 'max-values-test',
        sessionId: 'test-session',
        serverId: 'opencode-mcp',
        toolName: 'test',
        timestamp: Number.MAX_SAFE_INTEGER,
        ttl: 86400 * 365, // 1 year TTL
        args: { index: Number.MAX_SAFE_INTEGER },
        output: { value: Number.MAX_SAFE_INTEGER },
        summary: 'Maximum values test',
        tags: Array(100).fill('tag'),
      });

      expect(result).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // R4.7: Large Data Handling
  // ═══════════════════════════════════════════════════════════════════════════

  describe('R4.7: Large data handling', () => {
    it('should handle large output objects', async () => {
      const largeOutput = {
        data: 'x'.repeat(10000),
        nested: {
          array: Array(100)
            .fill(0)
            .map((_, i) => ({ id: i, value: `item-${i}` })),
        },
      };

      const result = await contextStorage.saveContext({
        id: 'large-output-test',
        sessionId: 'test-session',
        serverId: 'opencode-mcp',
        toolName: 'test',
        timestamp: Date.now() * 1000,
        ttl: 3600,
        args: {},
        output: largeOutput,
        summary: 'Large output test',
        tags: [],
      });

      expect(result).toBe(true);
    });

    it('should handle deeply nested objects', async () => {
      // Create a deeply nested object
      let nested: Record<string, unknown> = { value: 'deepest' };
      for (let i = 0; i < 20; i++) {
        nested = { level: i, child: nested };
      }

      const result = await contextStorage.saveContext({
        id: 'nested-test',
        sessionId: 'test-session',
        serverId: 'opencode-mcp',
        toolName: 'test',
        timestamp: Date.now() * 1000,
        ttl: 3600,
        args: nested,
        output: {},
        summary: 'Deeply nested test',
        tags: [],
      });

      expect(result).toBe(true);
    });

    it('should handle many tags', async () => {
      const manyTags = Array(500)
        .fill(0)
        .map((_, i) => `tag-${i}`);

      const result = await contextStorage.saveContext({
        id: 'many-tags-test',
        sessionId: 'test-session',
        serverId: 'opencode-mcp',
        toolName: 'test',
        timestamp: Date.now() * 1000,
        ttl: 3600,
        args: {},
        output: {},
        summary: 'Many tags test',
        tags: manyTags,
      });

      expect(result).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // R4.8: Unicode and Encoding
  // ═══════════════════════════════════════════════════════════════════════════

  describe('R4.8: Unicode and encoding', () => {
    it('should handle unicode agent names', async () => {
      const unicodeName = 'Agent 中文 عربي 日本語 🤖';
      const agent = await agentMonitor.registerAgent(
        unicodeName,
        'worker',
        'test-session',
        'opencode-mcp'
      );

      expect(agent).not.toBeNull();
      expect(agent?.name).toBe(unicodeName);
    });

    it('should handle emoji in content', async () => {
      const emojiContent = '🚀 Success! ✅ Done! 🎉 Celebration! 💻 Coding!';

      const result = await contextStorage.saveContext({
        id: 'emoji-test',
        sessionId: 'test-session',
        serverId: 'opencode-mcp',
        toolName: 'test',
        timestamp: Date.now() * 1000,
        ttl: 3600,
        args: { message: emojiContent },
        output: { status: emojiContent },
        summary: emojiContent,
        tags: ['emoji', '🏷️'],
      });

      expect(result).toBe(true);
    });

    it('should handle various unicode scripts', async () => {
      const multiScriptContent = `
        Latin: Hello World
        Cyrillic: Привет мир
        Greek: Γεια σου κόσμε
        Hebrew: שלום עולם
        Arabic: مرحبا بالعالم
        Chinese: 你好世界
        Japanese: こんにちは世界
        Korean: 안녕하세요 세계
        Thai: สวัสดีโลก
      `;

      const result = await contextStorage.saveContext({
        id: 'multi-script-test',
        sessionId: 'test-session',
        serverId: 'opencode-mcp',
        toolName: 'test',
        timestamp: Date.now() * 1000,
        ttl: 3600,
        args: {},
        output: { content: multiScriptContent },
        summary: 'Multi-script content',
        tags: ['unicode', '国际化'],
      });

      expect(result).toBe(true);
    });

    it('should handle control characters', async () => {
      const controlChars = 'Line1\nLine2\rLine3\tTab\x00Null';

      const result = await contextStorage.saveContext({
        id: 'control-chars-test',
        sessionId: 'test-session',
        serverId: 'opencode-mcp',
        toolName: 'test',
        timestamp: Date.now() * 1000,
        ttl: 3600,
        args: { content: controlChars },
        output: {},
        summary: 'Control characters',
        tags: [],
      });

      expect(result).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // R4.9: Concurrent Operations Edge Cases
  // ═══════════════════════════════════════════════════════════════════════════

  describe('R4.9: Concurrent operations edge cases', () => {
    it('should handle registering same agent name twice', async () => {
      const agent1 = await agentMonitor.registerAgent(
        'DuplicateName',
        'worker',
        'test-session',
        'opencode-mcp'
      );

      const agent2 = await agentMonitor.registerAgent(
        'DuplicateName',
        'worker',
        'test-session',
        'opencode-mcp'
      );

      expect(agent1).not.toBeNull();
      expect(agent2).not.toBeNull();
      // Both should succeed - IDs should be unique
      expect(agent1?.id).not.toBe(agent2?.id);
    });

    it('should handle concurrent status updates to same agent', async () => {
      const agent = await agentMonitor.registerAgent(
        'ConcurrentUpdate',
        'worker',
        'test-session',
        'opencode-mcp'
      );

      // Launch concurrent updates
      const updates = Array(10)
        .fill(0)
        .map((_, i) =>
          agentMonitor.updateAgentStatus(
            agent!.id,
            i % 2 === 0 ? 'processing' : 'idle',
            `Task ${i}`
          )
        );

      await Promise.all(updates);

      const retrieved = await agentMonitor.getAgent(agent!.id);
      expect(retrieved).not.toBeNull();
      expect(['processing', 'idle']).toContain(retrieved?.status);
    });

    it('should handle interleaved writes to same session', async () => {
      const sessionId = 'interleaved-session';

      // Interleave agent registration and context saving
      const operations = Array(20)
        .fill(0)
        .map((_, i) => {
          if (i % 2 === 0) {
            return agentMonitor.registerAgent(`Interleaved-${i}`, 'worker', sessionId, 'opencode-mcp');
          } else {
            return contextStorage.saveContext({
              id: `interleaved-ctx-${i}`,
              sessionId,
              serverId: 'opencode-mcp',
              toolName: 'test',
              timestamp: Date.now() * 1000 + i,
              ttl: 3600,
              args: {},
              output: {},
              summary: `Interleaved ${i}`,
              tags: [],
            });
          }
        });

      await Promise.all(operations);

      const agents = await agentMonitor.listAgents(sessionId);
      expect(agents.length).toBe(10);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // R4.10: Session Lifecycle Edge Cases
  // ═══════════════════════════════════════════════════════════════════════════

  describe('R4.10: Session lifecycle edge cases', () => {
    it('should handle operations on non-existent sessions', async () => {
      const nonExistent = 'non-existent-session-xyz';

      const agents = await agentMonitor.listAgents(nonExistent);
      expect(agents).toEqual([]);

      const history = await contextStorage.getSessionHistory(nonExistent, 10);
      expect(history).toEqual([]);

      const messages = await agentMonitor.getMessageHistory(nonExistent);
      expect(messages).toEqual([]);
    });

    it('should handle session manager edge cases', async () => {
      // Create session with specific ID
      const customSession = await sessionManager.createSession({ sessionId: 'custom-edge-id' });
      expect(customSession.sessionId).toBe('custom-edge-id');

      // Create another session
      const autoSession = await sessionManager.createSession({});
      expect(autoSession.sessionId).toBeDefined();
      expect(autoSession.sessionId).toContain('sess_');

      // Get session by ID
      const retrieved = await sessionManager.getSession('custom-edge-id');
      expect(retrieved).not.toBeNull();
      expect(retrieved?.sessionId).toBe('custom-edge-id');

      // Get non-existent session
      const nonExistent = await sessionManager.getSession('not-exists');
      expect(nonExistent).toBeNull();
    });

    it('should handle session with special ID characters', async () => {
      const specialId = 'session-with-special_chars.and-dashes';
      const agent = await agentMonitor.registerAgent(
        'SpecialSession',
        'worker',
        specialId,
        'opencode-mcp'
      );

      expect(agent).not.toBeNull();

      const agents = await agentMonitor.listAgents(specialId);
      expect(agents.length).toBe(1);
    });

    it('should handle UUID-like session IDs', async () => {
      const uuidLike = '550e8400-e29b-41d4-a716-446655440000';
      const agent = await agentMonitor.registerAgent('UUIDSession', 'worker', uuidLike, 'opencode-mcp');

      expect(agent).not.toBeNull();

      const agents = await agentMonitor.listAgents(uuidLike);
      expect(agents.length).toBe(1);
    });
  });
});
