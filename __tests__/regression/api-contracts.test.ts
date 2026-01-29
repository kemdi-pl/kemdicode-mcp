/**
 * Level 5 Regression Tests: API Contracts
 *
 * Tests that API contracts remain stable and backward compatible.
 * These tests ensure that function signatures, return types, and
 * expected behaviors don't change unexpectedly.
 *
 * Test Cases:
 * - REG.6: AgentMonitor API contract
 * - REG.7: ContextStorage API contract
 * - REG.8: SessionManager API contract
 * - REG.9: Tool registry contract
 * - REG.10: Error handling contracts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AgentMonitor } from '../../src/context/agent-monitor.js';
import { ContextStorage } from '../../src/context/storage.js';
import { SessionManager } from '../../src/session/manager.js';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';

describe('Level 5 Regression: API Contracts', () => {
  let agentMonitor: AgentMonitor;
  let contextStorage: ContextStorage;
  let sessionManager: SessionManager;
  let mockRedis: Redis;

  const originalConsole = { ...console };

  beforeEach(async () => {
    console.log = vi.fn();
    console.info = vi.fn();
    console.warn = vi.fn();
    console.error = vi.fn();
    console.debug = vi.fn();

    mockRedis = new RedisMock({ data: {} }) as unknown as Redis;
    agentMonitor = new AgentMonitor({ db: 3 });
    contextStorage = new ContextStorage({ db: 3 });
    sessionManager = new SessionManager();

    (agentMonitor as unknown as { redis: unknown }).redis = mockRedis;
    (agentMonitor as unknown as { subscriber: unknown }).subscriber = mockRedis;
    (agentMonitor as unknown as { connected: boolean }).connected = true;

    (contextStorage as unknown as { redis: unknown }).redis = mockRedis;
    (contextStorage as unknown as { connected: boolean }).connected = true;
  });

  afterEach(async () => {
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
  // REG.6: AgentMonitor API Contract
  // ═══════════════════════════════════════════════════════════════════════════

  describe('REG.6: AgentMonitor API contract', () => {
    it('registerAgent should return AgentInfo with required fields', async () => {
      const agent = await agentMonitor.registerAgent(
        'ContractAgent',
        'worker',
        'contract-session',
        'opencode-mcp',
        'test-model'
      );

      expect(agent).not.toBeNull();
      expect(agent).toHaveProperty('id');
      expect(agent).toHaveProperty('name');
      expect(agent).toHaveProperty('role');
      expect(agent).toHaveProperty('sessionId');
      expect(agent).toHaveProperty('serverId');
      expect(agent).toHaveProperty('status');
      expect(agent).toHaveProperty('registeredAt');

      expect(agent!.name).toBe('ContractAgent');
      expect(agent!.role).toBe('worker');
      expect(agent!.sessionId).toBe('contract-session');
      expect(agent!.serverId).toBe('opencode-mcp');
    });

    it('listAgents should return array of AgentInfo', async () => {
      const sessionId = 'list-contract-session';
      await agentMonitor.registerAgent('Agent1', 'worker', sessionId, 'opencode-mcp');
      await agentMonitor.registerAgent('Agent2', 'supervisor', sessionId, 'opencode-mcp');

      const agents = await agentMonitor.listAgents(sessionId);

      expect(Array.isArray(agents)).toBe(true);
      expect(agents.length).toBe(2);
      agents.forEach((agent) => {
        expect(agent).toHaveProperty('id');
        expect(agent).toHaveProperty('name');
        expect(agent).toHaveProperty('role');
      });
    });

    it('getAgent should return null for non-existent agent', async () => {
      const agent = await agentMonitor.getAgent('non-existent-id');
      expect(agent).toBeNull();
    });

    it('updateAgentStatus should accept valid status values', async () => {
      const agent = await agentMonitor.registerAgent(
        'StatusAgent',
        'worker',
        'status-session',
        'opencode-mcp'
      );

      const validStatuses = ['active', 'idle', 'processing', 'completed', 'error'] as const;

      for (const status of validStatuses) {
        const result = await agentMonitor.updateAgentStatus(agent!.id, status);
        expect(result).toBeDefined();
      }
    });

    it('sendMessage should return message info', async () => {
      const sender = await agentMonitor.registerAgent('Sender', 'worker', 'msg-session', 'opencode-mcp');
      const receiver = await agentMonitor.registerAgent(
        'Receiver',
        'worker',
        'msg-session',
        'opencode-mcp'
      );

      const message = await agentMonitor.sendMessage(
        sender!.id,
        receiver!.id,
        'msg-session',
        'Test message',
        'chat',
        'normal'
      );

      expect(message).not.toBeNull();
      expect(message).toHaveProperty('id');
      expect(message).toHaveProperty('fromAgentId');
      expect(message).toHaveProperty('toAgentId');
      expect(message).toHaveProperty('content');
      expect(message).toHaveProperty('sessionId');
      expect(message).toHaveProperty('type');
      expect(message).toHaveProperty('priority');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // REG.7: ContextStorage API Contract
  // ═══════════════════════════════════════════════════════════════════════════

  describe('REG.7: ContextStorage API contract', () => {
    it('saveContext should return boolean', async () => {
      const result = await contextStorage.saveContext({
        id: 'ctx-contract-1',
        sessionId: 'ctx-session',
        serverId: 'opencode-mcp',
        toolName: 'test-tool',
        timestamp: Date.now() * 1000,
        ttl: 3600,
        args: { key: 'value' },
        output: { result: 'success' },
        summary: 'Contract test',
        tags: ['tag1', 'tag2'],
      });

      expect(typeof result).toBe('boolean');
    });

    it('queryContext should return array with required fields', async () => {
      const sessionId = 'query-contract-session';
      await contextStorage.saveContext({
        id: 'query-ctx-1',
        sessionId,
        serverId: 'opencode-mcp',
        toolName: 'query-test',
        timestamp: Date.now() * 1000,
        ttl: 3600,
        args: {},
        output: { data: 'test' },
        summary: 'Query test',
        tags: ['query'],
      });

      const results = await contextStorage.queryContext({ sessionId, limit: 10 });

      expect(Array.isArray(results)).toBe(true);
      if (results.length > 0) {
        expect(results[0]).toHaveProperty('id');
        expect(results[0]).toHaveProperty('sessionId');
        expect(results[0]).toHaveProperty('toolName');
        expect(results[0]).toHaveProperty('summary');
      }
    });

    it('getSessionHistory should return array', async () => {
      const history = await contextStorage.getSessionHistory('any-session', 10);
      expect(Array.isArray(history)).toBe(true);
    });

    it('getLatestFromServer should return array', async () => {
      const results = await contextStorage.getLatestFromServer('session', 'opencode-mcp', 5);
      expect(Array.isArray(results)).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // REG.8: SessionManager API Contract
  // ═══════════════════════════════════════════════════════════════════════════

  describe('REG.8: SessionManager API contract', () => {
    it('createSession should return SessionConfig with required fields', async () => {
      const session = await sessionManager.createSession({});

      expect(session).toHaveProperty('sessionId');
      expect(session).toHaveProperty('createdAt');
      expect(typeof session.sessionId).toBe('string');
      expect(session.sessionId).toContain('sess_');
    });

    it('createSession should use custom sessionId if provided', async () => {
      const customId = 'custom-session-id';
      const session = await sessionManager.createSession({ sessionId: customId });

      expect(session.sessionId).toBe(customId);
    });

    it('getSession should return null for non-existent session', async () => {
      const session = await sessionManager.getSession('definitely-not-exists');
      expect(session).toBeNull();
    });

    it('getSession should return created session', async () => {
      const created = await sessionManager.createSession({ sessionId: 'retrievable-session' });
      const retrieved = await sessionManager.getSession('retrievable-session');

      expect(retrieved).not.toBeNull();
      expect(retrieved?.sessionId).toBe(created.sessionId);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // REG.9: Error Handling Contracts
  // ═══════════════════════════════════════════════════════════════════════════

  describe('REG.9: Error handling contracts', () => {
    it('should return empty array, not throw, for listAgents on invalid session', async () => {
      const result = await agentMonitor.listAgents('');
      expect(result).toEqual([]);
    });

    it('should return null, not throw, for getAgent on empty ID', async () => {
      const result = await agentMonitor.getAgent('');
      expect(result).toBeNull();
    });

    it('should return empty array, not throw, for queryContext on empty session', async () => {
      const result = await contextStorage.queryContext({ sessionId: '', limit: 10 });
      expect(result).toEqual([]);
    });

    it('should return false, not throw, for saveContext when disconnected', async () => {
      const disconnectedStorage = new ContextStorage({ db: 3 });

      const result = await disconnectedStorage.saveContext({
        id: 'disconnect-contract',
        sessionId: 'test',
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

    it('should return null, not throw, for registerAgent when disconnected', async () => {
      const disconnectedMonitor = new AgentMonitor({ db: 3 });

      const result = await disconnectedMonitor.registerAgent(
        'Agent',
        'worker',
        'session',
        'opencode-mcp'
      );

      expect(result).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // REG.10: Type Coercion Contracts
  // ═══════════════════════════════════════════════════════════════════════════

  describe('REG.10: Type coercion contracts', () => {
    it('should handle numeric strings in context args', async () => {
      const result = await contextStorage.saveContext({
        id: 'numeric-string-test',
        sessionId: 'coerce-session',
        serverId: 'opencode-mcp',
        toolName: 'test',
        timestamp: Date.now() * 1000,
        ttl: 3600,
        args: { number: '123', float: '3.14' },
        output: {},
        summary: 'Numeric string test',
        tags: [],
      });

      expect(result).toBe(true);
    });

    it('should handle boolean strings in context args', async () => {
      const result = await contextStorage.saveContext({
        id: 'bool-string-test',
        sessionId: 'coerce-session',
        serverId: 'opencode-mcp',
        toolName: 'test',
        timestamp: Date.now() * 1000,
        ttl: 3600,
        args: { truthy: 'true', falsy: 'false' },
        output: {},
        summary: 'Boolean string test',
        tags: [],
      });

      expect(result).toBe(true);
    });

    it('should handle null and undefined in context output', async () => {
      const result = await contextStorage.saveContext({
        id: 'null-test',
        sessionId: 'coerce-session',
        serverId: 'opencode-mcp',
        toolName: 'test',
        timestamp: Date.now() * 1000,
        ttl: 3600,
        args: {},
        output: { nullVal: null, undefinedVal: undefined },
        summary: 'Null/undefined test',
        tags: [],
      });

      expect(result).toBe(true);
    });
  });
});
