/**
 * Level 4 Resilience Tests: Error Handling
 *
 * Tests error handling, recovery, and graceful degradation.
 *
 * Test Cases:
 * - R4.1: Redis connection failures
 * - R4.2: Invalid input handling
 * - R4.3: Timeout scenarios
 * - R4.4: State recovery
 * - R4.5: Graceful degradation
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AgentMonitor } from '../../src/context/agent-monitor.js';
import { ContextStorage } from '../../src/context/storage.js';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';

describe('Level 4 Resilience: Error Handling', () => {
  let agentMonitor: AgentMonitor;
  let contextStorage: ContextStorage;
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
  // R4.1: Redis Connection Failures
  // ═══════════════════════════════════════════════════════════════════════════

  describe('R4.1: Redis connection failures', () => {
    it('should return null when not connected', async () => {
      const disconnectedMonitor = new AgentMonitor({ db: 3 });
      // Don't set connected to true

      const result = await disconnectedMonitor.registerAgent(
        'TestAgent',
        'worker',
        'test-session',
        'opencode-mcp'
      );

      expect(result).toBeNull();
    });

    it('should return null for agent operations when disconnected', async () => {
      const disconnectedMonitor = new AgentMonitor({ db: 3 });

      expect(await disconnectedMonitor.listAgents('test-session')).toEqual([]);
      expect(await disconnectedMonitor.getAgent('nonexistent')).toBeNull();
      expect(await disconnectedMonitor.getMessageHistory('test-session')).toEqual([]);
    });

    it('should return false for context operations when disconnected', async () => {
      const disconnectedStorage = new ContextStorage({ db: 3 });

      const result = await disconnectedStorage.saveContext({
        id: 'test-1',
        sessionId: 'test-session',
        serverId: 'opencode-mcp',
        toolName: 'test',
        timestamp: Date.now() * 1000,
        ttl: 3600,
        args: {},
        output: {},
        summary: 'Test',
        tags: [],
      });

      expect(result).toBe(false);
    });

    it('should handle Redis errors gracefully', async () => {
      // Create a mock that throws errors
      const failingRedis = {
        hset: vi.fn().mockRejectedValue(new Error('Redis error')),
        hget: vi.fn().mockRejectedValue(new Error('Redis error')),
        zadd: vi.fn().mockRejectedValue(new Error('Redis error')),
        zrange: vi.fn().mockRejectedValue(new Error('Redis error')),
        smembers: vi.fn().mockRejectedValue(new Error('Redis error')),
        sadd: vi.fn().mockRejectedValue(new Error('Redis error')),
        expire: vi.fn().mockRejectedValue(new Error('Redis error')),
        publish: vi.fn().mockRejectedValue(new Error('Redis error')),
        del: vi.fn().mockResolvedValue(1),
      } as unknown as Redis;

      (agentMonitor as unknown as { redis: unknown }).redis = failingRedis;

      // These should not throw, but return null/empty
      const agent = await agentMonitor.registerAgent(
        'TestAgent',
        'worker',
        'test-session',
        'opencode-mcp'
      );
      expect(agent).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // R4.2: Invalid Input Handling
  // ═══════════════════════════════════════════════════════════════════════════

  describe('R4.2: Invalid input handling', () => {
    it('should handle empty session ID', async () => {
      const agents = await agentMonitor.listAgents('');
      expect(agents).toEqual([]);
    });

    it('should handle empty agent ID for lookup', async () => {
      const agent = await agentMonitor.getAgent('');
      expect(agent).toBeNull();
    });

    it('should handle non-existent agent for status update', async () => {
      const result = await agentMonitor.updateAgentStatus(
        'nonexistent-agent-id',
        'processing',
        'Test task'
      );
      // Should not throw
      expect(result).toBeDefined();
    });

    it('should handle non-existent session for context query', async () => {
      const result = await contextStorage.queryContext({
        sessionId: 'nonexistent-session',
        limit: 10,
      });
      expect(result).toEqual([]);
    });

    it('should handle empty tags array', async () => {
      const entry = await contextStorage.saveContext({
        id: 'test-empty-tags',
        sessionId: 'test-session',
        serverId: 'opencode-mcp',
        toolName: 'test',
        timestamp: Date.now() * 1000,
        ttl: 3600,
        args: {},
        output: {},
        summary: 'Test with empty tags',
        tags: [],
      });

      expect(entry).toBeDefined();
    });

    it('should handle special characters in content', async () => {
      const specialContent = 'Test with "quotes" and \'apostrophes\' and <html> and \n newlines';
      const sessionId = 'test-special-chars-session';

      const result = await contextStorage.saveContext({
        id: 'test-special-chars',
        sessionId,
        serverId: 'opencode-mcp',
        toolName: 'test',
        timestamp: Date.now() * 1000,
        ttl: 3600,
        args: { content: specialContent },
        output: { data: specialContent },
        summary: specialContent,
        tags: ['special'],
      });

      expect(result).toBe(true);

      // Verify by querying
      const history = await contextStorage.getSessionHistory(sessionId, 10);
      expect(history.length).toBe(1);
      expect(history[0].summary).toBe(specialContent);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // R4.3: Timeout Scenarios
  // ═══════════════════════════════════════════════════════════════════════════

  describe('R4.3: Timeout scenarios', () => {
    it('should handle slow operations', async () => {
      // Operations should complete within reasonable time
      const start = Date.now();

      await agentMonitor.registerAgent(
        'TimeoutTest',
        'worker',
        'test-session',
        'opencode-mcp'
      );

      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(5000); // Should complete within 5s
    });

    it('should handle concurrent rapid operations', async () => {
      const sessionId = 'rapid-test';
      const operations: Promise<unknown>[] = [];

      // Launch many concurrent operations
      for (let i = 0; i < 50; i++) {
        operations.push(
          agentMonitor.registerAgent(`Rapid-${i}`, 'worker', sessionId, 'opencode-mcp')
        );
      }

      const start = Date.now();
      await Promise.all(operations);
      const elapsed = Date.now() - start;

      // All should complete within reasonable time
      expect(elapsed).toBeLessThan(10000);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // R4.4: State Recovery
  // ═══════════════════════════════════════════════════════════════════════════

  describe('R4.4: State recovery', () => {
    it('should persist agent data correctly', async () => {
      const sessionId = 'persist-test';

      // Register agent
      const agent = await agentMonitor.registerAgent(
        'PersistAgent',
        'worker',
        sessionId,
        'opencode-mcp'
      );

      expect(agent).not.toBeNull();

      // Retrieve and verify
      const retrieved = await agentMonitor.getAgent(agent!.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.name).toBe('PersistAgent');
    });

    it('should persist context data correctly', async () => {
      const sessionId = 'persist-context-test';
      const contextId = `ctx-${Date.now()}`;

      // Save context
      await contextStorage.saveContext({
        id: contextId,
        sessionId,
        serverId: 'opencode-mcp',
        toolName: 'persist-test',
        timestamp: Date.now() * 1000,
        ttl: 3600,
        args: { key: 'value' },
        output: { result: 'success' },
        summary: 'Persistence test',
        tags: ['persist'],
      });

      // Retrieve and verify
      const history = await contextStorage.getSessionHistory(sessionId, 10);
      expect(history.length).toBe(1);
      expect(history[0].id).toBe(contextId);
    });

    it('should maintain data integrity after updates', async () => {
      const sessionId = 'integrity-test';

      // Register agent
      const agent = await agentMonitor.registerAgent(
        'IntegrityAgent',
        'worker',
        sessionId,
        'opencode-mcp'
      );

      // Update status multiple times
      await agentMonitor.updateAgentStatus(agent!.id, 'processing', 'Task 1');
      await agentMonitor.updateAgentStatus(agent!.id, 'idle');
      await agentMonitor.updateAgentStatus(agent!.id, 'processing', 'Task 2');

      // Verify final state
      const retrieved = await agentMonitor.getAgent(agent!.id);
      expect(retrieved?.status).toBe('processing');
      expect(retrieved?.currentTask).toBe('Task 2');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // R4.5: Graceful Degradation
  // ═══════════════════════════════════════════════════════════════════════════

  describe('R4.5: Graceful degradation', () => {
    it('should return empty list when Redis fails during list', async () => {
      const failingRedis = {
        smembers: vi.fn().mockRejectedValue(new Error('Redis unavailable')),
        hgetall: vi.fn().mockRejectedValue(new Error('Redis unavailable')),
      } as unknown as Redis;

      (agentMonitor as unknown as { redis: unknown }).redis = failingRedis;

      const agents = await agentMonitor.listAgents('test-session');
      expect(agents).toEqual([]);
    });

    it('should return empty history when Redis fails during query', async () => {
      const failingRedis = {
        zrevrange: vi.fn().mockRejectedValue(new Error('Redis unavailable')),
        zrangebyscore: vi.fn().mockRejectedValue(new Error('Redis unavailable')),
      } as unknown as Redis;

      (contextStorage as unknown as { redis: unknown }).redis = failingRedis;

      const history = await contextStorage.getSessionHistory('test-session', 10);
      expect(history).toEqual([]);
    });

    it('should handle partial failures gracefully', async () => {
      const sessionId = 'partial-fail-test';

      // Register some agents successfully
      for (let i = 0; i < 3; i++) {
        await agentMonitor.registerAgent(`Partial-${i}`, 'worker', sessionId, 'opencode-mcp');
      }

      // Verify we can still list them
      const agents = await agentMonitor.listAgents(sessionId);
      expect(agents.length).toBe(3);
    });

    it('should not crash on undefined values', async () => {
      // These should handle undefined gracefully
      const result1 = await agentMonitor.getAgent(undefined as unknown as string);
      const result2 = await agentMonitor.listAgents(undefined as unknown as string);

      expect(result1).toBeNull();
      expect(result2).toEqual([]);
    });
  });
});
