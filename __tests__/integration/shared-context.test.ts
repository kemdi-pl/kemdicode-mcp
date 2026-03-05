/**
 * Level 2 Integration Tests: Shared Context
 *
 * Tests concurrent access to shared context storage, data conflicts,
 * race conditions, and multi-agent context coordination.
 *
 * Test Cases:
 * - I2.9: Concurrent context entry writes
 * - I2.10: Context query under load
 * - I2.11: Index consistency during concurrent updates
 * - I2.12: Session context isolation
 * - I2.13: TTL behavior under concurrent access
 * - I2.14: Context ordering and timestamps
 * - I2.15: Multi-server context sharing
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ContextStorage } from '../../src/context/storage.js';
import {
  createSharedRedisMock,
  runConcurrentTasks,
  calculateConcurrencyMetrics,
  IntegrationIds,
  IntegrationMockData,
  suppressConsoleForIntegration,
} from './fixtures.js';

describe('Level 2 Integration: Shared Context', () => {
  suppressConsoleForIntegration();

  let contextStorage: ContextStorage;
  let sessionId: string;

  beforeEach(async () => {
    sessionId = IntegrationIds.session();
    contextStorage = new ContextStorage({ db: 3 });

    // Mock Redis
    const mockRedis = createSharedRedisMock();
    (contextStorage as unknown as { redis: unknown }).redis = mockRedis;
    (contextStorage as unknown as { connected: boolean }).connected = true;
  });

  afterEach(async () => {
    try {
      await contextStorage.disconnect();
    } catch {
      // Ignore
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // I2.9: Concurrent Context Entry Writes
  // ═══════════════════════════════════════════════════════════════════════════

  describe('I2.9: Concurrent context entry writes', () => {
    it('should handle 20 concurrent writes to same session', async () => {
      const writeCount = 20;

      const tasks = Array.from({ length: writeCount }, (_, i) => ({
        name: `write-${i}`,
        fn: async () => {
          const entry = IntegrationMockData.contextEntry(sessionId, 'code-review', i);
          return contextStorage.saveContext(entry);
        },
      }));

      const results = await runConcurrentTasks(tasks);
      const metrics = calculateConcurrencyMetrics(results);

      expect(metrics.successCount).toBe(writeCount);
      expect(metrics.errorCount).toBe(0);
      expect(metrics.parallelismFactor).toBeGreaterThan(1);
    });

    it('should maintain data integrity under concurrent writes', async () => {
      const entries = Array.from({ length: 10 }, (_, i) => ({
        ...IntegrationMockData.contextEntry(sessionId, 'code-review', i),
        summary: `Unique summary ${i}: ${Math.random().toString(36)}`,
      }));

      const tasks = entries.map((entry, i) => ({
        name: `write-${i}`,
        fn: () => contextStorage.saveContext(entry),
      }));

      await runConcurrentTasks(tasks);

      // Verify each entry was saved correctly
      for (const entry of entries) {
        const retrieved = await contextStorage.getContext(sessionId, entry.id);
        expect(retrieved).not.toBeNull();
        expect(retrieved!.summary).toBe(entry.summary);
      }
    });

    it('should handle writes from different tools concurrently', async () => {
      const tools = ['code-review', 'explain-code', 'fix-bug', 'refactor', 'auto-fix'];

      const tasks = tools.flatMap((tool, toolIndex) =>
        Array.from({ length: 5 }, (_, i) => ({
          name: `${tool}-${i}`,
          fn: async () => {
            const entry = IntegrationMockData.contextEntry(sessionId, tool, toolIndex * 10 + i);
            return contextStorage.saveContext(entry);
          },
        }))
      );

      const results = await runConcurrentTasks(tasks);

      expect(results.every((r) => r.result === true)).toBe(true);
      expect(results.length).toBe(25);
    });

    it('should prevent data corruption with rapid sequential writes', async () => {
      const writeCount = 50;

      for (let i = 0; i < writeCount; i++) {
        const entry = {
          ...IntegrationMockData.contextEntry(sessionId, 'rapid-test', i),
          output: { iteration: i, data: `Data for iteration ${i}` },
        };
        await contextStorage.saveContext(entry);
      }

      const history = await contextStorage.getSessionHistory(sessionId, 100);
      expect(history.length).toBe(writeCount);

      // Verify each entry has correct data
      for (const entry of history) {
        expect(entry.output).toBeDefined();
        expect((entry.output as { iteration: number }).iteration).toBeDefined();
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // I2.10: Context Query Under Load
  // ═══════════════════════════════════════════════════════════════════════════

  describe('I2.10: Context query under load', () => {
    beforeEach(async () => {
      // Pre-populate with test data
      for (let i = 0; i < 30; i++) {
        await contextStorage.saveContext(
          IntegrationMockData.contextEntry(sessionId, 'preload-tool', i)
        );
      }
    });

    it('should handle concurrent read operations', async () => {
      const readCount = 20;

      const tasks = Array.from({ length: readCount }, (_, i) => ({
        name: `read-${i}`,
        fn: () => contextStorage.queryContext({ sessionId, limit: 10 }),
      }));

      const results = await runConcurrentTasks(tasks);
      const metrics = calculateConcurrencyMetrics(results);

      expect(metrics.successCount).toBe(readCount);
      expect(results.every((r) => Array.isArray(r.result))).toBe(true);
    });

    it('should handle mixed read/write operations', async () => {
      const readTasks = Array.from({ length: 10 }, (_, i) => ({
        name: `read-${i}`,
        fn: () => contextStorage.getSessionHistory(sessionId, 20),
      }));

      const writeTasks = Array.from({ length: 10 }, (_, i) => ({
        name: `write-${i}`,
        fn: () =>
          contextStorage.saveContext(
            IntegrationMockData.contextEntry(sessionId, 'mixed-test', 100 + i)
          ),
      }));

      const allTasks = [...readTasks, ...writeTasks].sort(() => Math.random() - 0.5);
      const results = await runConcurrentTasks(allTasks);

      expect(results.every((r) => !r.error)).toBe(true);
    });

    it('should maintain query consistency during writes', async () => {
      // Start background writes
      const writePromise = (async () => {
        for (let i = 0; i < 20; i++) {
          await contextStorage.saveContext(
            IntegrationMockData.contextEntry(sessionId, 'bg-write', 200 + i)
          );
          await new Promise((r) => setTimeout(r, 10));
        }
      })();

      // Concurrent queries should not fail
      const queryResults = [];
      for (let i = 0; i < 10; i++) {
        const result = await contextStorage.queryContext({ sessionId, limit: 50 });
        queryResults.push(result);
        await new Promise((r) => setTimeout(r, 25));
      }

      await writePromise;

      // All queries should have returned valid arrays
      expect(queryResults.every((r) => Array.isArray(r))).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // I2.11: Index Consistency During Concurrent Updates
  // ═══════════════════════════════════════════════════════════════════════════

  describe('I2.11: Index consistency during concurrent updates', () => {
    it('should maintain server index integrity', async () => {
      const servers = ['opencode-mcp', 'laravel-mcp', 'python-mcp'] as const;

      const tasks = servers.flatMap((server) =>
        Array.from({ length: 5 }, (_, i) => ({
          name: `${server}-${i}`,
          fn: () =>
            contextStorage.saveContext({
              ...IntegrationMockData.contextEntry(sessionId, 'index-test', i),
              id: `${server}_entry_${i}`,
              serverId: server,
            }),
        }))
      );

      await runConcurrentTasks(tasks);

      // Query by each server
      for (const server of servers) {
        const results = await contextStorage.queryContext({
          sessionId,
          serverId: server,
          limit: 20,
        });
        expect(results.every((r) => r.serverId === server)).toBe(true);
      }
    });

    it('should maintain tool index integrity', async () => {
      const tools = ['code-review', 'explain-code', 'fix-bug'];

      const tasks = tools.flatMap((tool) =>
        Array.from({ length: 5 }, (_, i) => ({
          name: `${tool}-${i}`,
          fn: () =>
            contextStorage.saveContext({
              ...IntegrationMockData.contextEntry(sessionId, tool, i),
              id: `${tool}_entry_${i}`,
            }),
        }))
      );

      await runConcurrentTasks(tasks);

      for (const tool of tools) {
        const results = await contextStorage.queryContext({
          sessionId,
          toolName: tool,
          limit: 20,
        });
        expect(results.every((r) => r.toolName === tool)).toBe(true);
      }
    });

    it('should maintain tag index integrity', async () => {
      const tagSets = [
        ['security', 'critical'],
        ['performance', 'optimization'],
        ['refactoring', 'cleanup'],
      ];

      const tasks = tagSets.flatMap((tags, setIndex) =>
        Array.from({ length: 3 }, (_, i) => ({
          name: `tagset-${setIndex}-${i}`,
          fn: () =>
            contextStorage.saveContext({
              ...IntegrationMockData.contextEntry(sessionId, 'tag-test', setIndex * 10 + i),
              id: `tag_entry_${setIndex}_${i}`,
              tags,
            }),
        }))
      );

      await runConcurrentTasks(tasks);

      // Query by first tag of each set
      for (const tags of tagSets) {
        const results = await contextStorage.queryContext({
          sessionId,
          tags: [tags[0]],
          limit: 20,
        });
        expect(results.every((r) => r.tags.includes(tags[0]))).toBe(true);
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // I2.12: Session Context Isolation
  // ═══════════════════════════════════════════════════════════════════════════

  describe('I2.12: Session context isolation', () => {
    it('should isolate context between sessions', async () => {
      const session1 = IntegrationIds.session();
      const session2 = IntegrationIds.session();

      // Write to both sessions concurrently
      const tasks = [
        ...Array.from({ length: 5 }, (_, i) => ({
          name: `session1-${i}`,
          fn: () =>
            contextStorage.saveContext({
              ...IntegrationMockData.contextEntry(session1, 'iso-test', i),
              id: `s1_entry_${i}`,
            }),
        })),
        ...Array.from({ length: 5 }, (_, i) => ({
          name: `session2-${i}`,
          fn: () =>
            contextStorage.saveContext({
              ...IntegrationMockData.contextEntry(session2, 'iso-test', i),
              id: `s2_entry_${i}`,
            }),
        })),
      ];

      await runConcurrentTasks(tasks);

      // Verify isolation
      const session1History = await contextStorage.getSessionHistory(session1, 20);
      const session2History = await contextStorage.getSessionHistory(session2, 20);

      expect(session1History.every((e) => e.sessionId === session1)).toBe(true);
      expect(session2History.every((e) => e.sessionId === session2)).toBe(true);
      expect(session1History.length).toBe(5);
      expect(session2History.length).toBe(5);
    });

    it('should clear one session without affecting others', async () => {
      const session1 = IntegrationIds.session();
      const session2 = IntegrationIds.session();

      // Populate both sessions
      for (let i = 0; i < 5; i++) {
        await contextStorage.saveContext({
          ...IntegrationMockData.contextEntry(session1, 'clear-test', i),
          id: `s1_${i}`,
        });
        await contextStorage.saveContext({
          ...IntegrationMockData.contextEntry(session2, 'clear-test', i),
          id: `s2_${i}`,
        });
      }

      // Clear session1
      await contextStorage.clearSession(session1);

      // Verify session1 is cleared but session2 remains
      const session1History = await contextStorage.getSessionHistory(session1, 20);
      const session2History = await contextStorage.getSessionHistory(session2, 20);

      expect(session1History.length).toBe(0);
      expect(session2History.length).toBe(5);
    });

    it('should handle concurrent operations on different sessions', async () => {
      const sessions = Array.from({ length: 5 }, () => IntegrationIds.session());

      const tasks = sessions.flatMap((sess, sessionIndex) =>
        Array.from({ length: 10 }, (_, i) => ({
          name: `session-${sessionIndex}-write-${i}`,
          fn: () =>
            contextStorage.saveContext({
              ...IntegrationMockData.contextEntry(sess, 'multi-session', i),
              id: `ms_${sessionIndex}_${i}`,
            }),
        }))
      );

      const results = await runConcurrentTasks(tasks);

      expect(results.every((r) => r.result === true)).toBe(true);

      // Verify each session has exactly 10 entries
      for (const sess of sessions) {
        const history = await contextStorage.getSessionHistory(sess, 20);
        expect(history.length).toBe(10);
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // I2.13: TTL Behavior Under Concurrent Access
  // ═══════════════════════════════════════════════════════════════════════════

  describe('I2.13: TTL behavior under concurrent access', () => {
    it('should set TTL correctly on concurrent writes', async () => {
      const ttlValues = [60, 300, 600, 1800, 3600];

      const tasks = ttlValues.map((ttl, i) => ({
        name: `ttl-${ttl}`,
        fn: () =>
          contextStorage.saveContext({
            ...IntegrationMockData.contextEntry(sessionId, 'ttl-test', i),
            id: `ttl_entry_${i}`,
            ttl,
          }),
      }));

      await runConcurrentTasks(tasks);

      // Verify entries were saved
      for (let i = 0; i < ttlValues.length; i++) {
        const entry = await contextStorage.getContext(sessionId, `ttl_entry_${i}`);
        expect(entry).not.toBeNull();
        expect(entry!.ttl).toBe(ttlValues[i]);
      }
    });

    it('should handle different TTLs for same session entries', async () => {
      const entries = [
        { ttl: 60, id: 'short_ttl' },
        { ttl: 3600, id: 'medium_ttl' },
        { ttl: 86400, id: 'long_ttl' },
      ];

      const tasks = entries.map((e) => ({
        name: e.id,
        fn: () =>
          contextStorage.saveContext({
            ...IntegrationMockData.contextEntry(sessionId, 'multi-ttl', 0),
            id: e.id,
            ttl: e.ttl,
          }),
      }));

      await runConcurrentTasks(tasks);

      const history = await contextStorage.getSessionHistory(sessionId, 10);
      expect(history.length).toBe(3);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // I2.14: Context Ordering and Timestamps
  // ═══════════════════════════════════════════════════════════════════════════

  describe('I2.14: Context ordering and timestamps', () => {
    it('should maintain chronological order in session history', async () => {
      // Write entries with explicit timestamps
      for (let i = 0; i < 10; i++) {
        const entry = {
          ...IntegrationMockData.contextEntry(sessionId, 'order-test', i),
          id: `order_entry_${i}`,
          timestamp: Date.now() + i * 100, // 100ms apart
        };
        await contextStorage.saveContext(entry);
        await new Promise((r) => setTimeout(r, 50));
      }

      const history = await contextStorage.getSessionHistory(sessionId, 20);

      // Should be in reverse chronological order (newest first)
      for (let i = 1; i < history.length; i++) {
        expect(history[i - 1].timestamp).toBeGreaterThanOrEqual(history[i].timestamp);
      }
    });

    it('should filter by timestamp correctly', async () => {
      const baseTimestamp = Date.now();

      for (let i = 0; i < 10; i++) {
        await contextStorage.saveContext({
          ...IntegrationMockData.contextEntry(sessionId, 'time-filter', i),
          id: `tf_entry_${i}`,
          timestamp: baseTimestamp + i * 1000,
        });
      }

      // Query entries after midpoint
      const midpoint = baseTimestamp + 5000;
      const results = await contextStorage.queryContext({
        sessionId,
        since: midpoint,
        limit: 20,
      });

      expect(results.every((e) => e.timestamp >= midpoint)).toBe(true);
    });

    it('should handle concurrent writes with close timestamps', async () => {
      const baseTimestamp = Date.now();

      const tasks = Array.from({ length: 20 }, (_, i) => ({
        name: `close-ts-${i}`,
        fn: () =>
          contextStorage.saveContext({
            ...IntegrationMockData.contextEntry(sessionId, 'close-ts', i),
            id: `cts_entry_${i}`,
            timestamp: baseTimestamp + i, // 1ms apart
          }),
      }));

      await runConcurrentTasks(tasks);

      const history = await contextStorage.getSessionHistory(sessionId, 30);
      expect(history.length).toBe(20);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // I2.15: Multi-Server Context Sharing
  // ═══════════════════════════════════════════════════════════════════════════

  describe('I2.15: Multi-server context sharing', () => {
    it('should share context between multiple server types', async () => {
      const servers = ['opencode-mcp', 'laravel-mcp', 'python-mcp'] as const;

      // Each server writes entries
      for (const server of servers) {
        for (let i = 0; i < 3; i++) {
          await contextStorage.saveContext({
            ...IntegrationMockData.contextEntry(sessionId, `${server}-tool`, i),
            id: `${server}_${i}`,
            serverId: server,
          });
        }
      }

      // All entries should be in session history
      const history = await contextStorage.getSessionHistory(sessionId, 20);
      expect(history.length).toBe(9);

      // Each server's entries should be queryable
      for (const server of servers) {
        const serverEntries = await contextStorage.getLatestFromServer(sessionId, server, 10);
        expect(serverEntries.length).toBe(3);
      }
    });

    it('should handle concurrent writes from multiple servers', async () => {
      const servers = ['opencode-mcp', 'laravel-mcp', 'python-mcp'] as const;

      const tasks = servers.flatMap((server) =>
        Array.from({ length: 10 }, (_, i) => ({
          name: `${server}-${i}`,
          fn: () =>
            contextStorage.saveContext({
              ...IntegrationMockData.contextEntry(sessionId, 'multi-server', i),
              id: `${server}_ms_${i}`,
              serverId: server,
            }),
        }))
      );

      const results = await runConcurrentTasks(tasks);
      const metrics = calculateConcurrencyMetrics(results);

      expect(metrics.successCount).toBe(30);
      expect(metrics.errorCount).toBe(0);

      const history = await contextStorage.getSessionHistory(sessionId, 50);
      expect(history.length).toBe(30);
    });

    it('should allow cross-server context queries', async () => {
      // Server A writes with tag "shared"
      await contextStorage.saveContext({
        ...IntegrationMockData.contextEntry(sessionId, 'tool-a', 0),
        id: 'cross_a',
        serverId: 'server-a',
        tags: ['shared', 'from-a'],
      });

      // Server B writes with same tag
      await contextStorage.saveContext({
        ...IntegrationMockData.contextEntry(sessionId, 'tool-b', 0),
        id: 'cross_b',
        serverId: 'server-b',
        tags: ['shared', 'from-b'],
      });

      // Query by shared tag should return both
      const sharedResults = await contextStorage.queryContext({
        sessionId,
        tags: ['shared'],
        limit: 10,
      });

      expect(sharedResults.length).toBe(2);
      expect(sharedResults.some((e) => e.serverId === 'server-a')).toBe(true);
      expect(sharedResults.some((e) => e.serverId === 'server-b')).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Integration Scenario: Concurrent Multi-Agent Context Access
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Concurrent multi-agent context access scenario', () => {
    it('should handle realistic multi-agent context sharing workflow', async () => {
      // Simulate 5 agents concurrently accessing and writing context

      const agentActions = Array.from({ length: 5 }, (_, agentIndex) => ({
        name: `agent-${agentIndex}`,
        fn: async () => {
          // Each agent performs a series of operations
          const results = [];

          // Write initial context
          results.push(
            await contextStorage.saveContext({
              ...IntegrationMockData.contextEntry(sessionId, 'agent-work', agentIndex * 100),
              id: `agent_${agentIndex}_init`,
              summary: `Agent ${agentIndex} starting work`,
            })
          );

          // Read session history
          const history = await contextStorage.getSessionHistory(sessionId, 20);
          results.push(history.length >= 0);

          // Write result context
          results.push(
            await contextStorage.saveContext({
              ...IntegrationMockData.contextEntry(sessionId, 'agent-result', agentIndex * 100 + 1),
              id: `agent_${agentIndex}_result`,
              summary: `Agent ${agentIndex} completed with ${history.length} context entries visible`,
            })
          );

          // Query for own entries
          const ownEntries = await contextStorage.queryContext({
            sessionId,
            toolName: 'agent-work',
            limit: 20,
          });
          results.push(ownEntries.length >= 0);

          return results.every((r) => r === true);
        },
      }));

      const results = await runConcurrentTasks(agentActions);

      expect(results.every((r) => r.result === true)).toBe(true);

      // Verify final state
      const finalHistory = await contextStorage.getSessionHistory(sessionId, 50);
      expect(finalHistory.length).toBe(10); // 2 entries per agent
    });
  });
});
