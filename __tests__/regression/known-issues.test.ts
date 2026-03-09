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
 * Level 5 Regression Tests: Known Issues
 *
 * Tests for previously fixed bugs to ensure they don't regress.
 * Each test documents the original issue and its fix.
 *
 * Test Cases:
 * - REG.1: Division by zero in concurrency metrics (PR #55f27bb)
 * - REG.2: ioredis-mock Pub/Sub causing test hangs (PR #8a436c8)
 * - REG.3: saveContext returning boolean, not entry
 * - REG.4: Warmup iterations affecting exact count assertions
 * - REG.5: Performance thresholds too aggressive for mock Redis
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { AgentMonitor } from '../../src/context/agent-monitor.js';
import { ContextStorage } from '../../src/context/storage.js';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import {
  calculateConcurrencyMetrics,
  runConcurrentTasks,
  ConcurrentResult,
} from '../integration/fixtures.js';

describe('Level 5 Regression: Known Issues', () => {
  let agentMonitor: AgentMonitor;
  let contextStorage: ContextStorage;
  let mockRedis: Redis;

  const originalConsole = { ...console };

  beforeEach(async () => {
    // Suppress console during tests
    console.log = () => {};
    console.info = () => {};
    console.warn = () => {};
    console.error = () => {};
    console.debug = () => {};

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
  // REG.1: Division by zero in concurrency metrics
  // ═══════════════════════════════════════════════════════════════════════════

  describe('REG.1: Division by zero in concurrency metrics', () => {
    it('should not return NaN when totalDurationMs is 0', () => {
      // Simulate results that complete instantaneously (same start and end time)
      const instantResults: ConcurrentResult<string>[] = [
        {
          name: 'task1',
          result: 'ok',
          durationMs: 0,
          startedAt: 1000,
          completedAt: 1000,
        },
        {
          name: 'task2',
          result: 'ok',
          durationMs: 0,
          startedAt: 1000,
          completedAt: 1000,
        },
      ];

      const metrics = calculateConcurrencyMetrics(instantResults);

      // Should not be NaN
      expect(Number.isNaN(metrics.parallelismFactor)).toBe(false);
      expect(metrics.parallelismFactor).toBe(1);
      expect(metrics.successCount).toBe(2);
    });

    it('should handle empty results array', () => {
      const emptyResults: ConcurrentResult<string>[] = [];

      const metrics = calculateConcurrencyMetrics(emptyResults);

      // Should not throw or return NaN
      expect(Number.isNaN(metrics.parallelismFactor)).toBe(false);
      expect(Number.isNaN(metrics.averageDurationMs)).toBe(false);
    });

    it('should calculate correct parallelism for real concurrent tasks', async () => {
      const tasks = Array.from({ length: 5 }, (_, i) => ({
        name: `task-${i}`,
        fn: async () => {
          await new Promise((r) => setTimeout(r, 10));
          return `done-${i}`;
        },
      }));

      const results = await runConcurrentTasks(tasks);
      const metrics = calculateConcurrencyMetrics(results);

      expect(Number.isNaN(metrics.parallelismFactor)).toBe(false);
      expect(metrics.parallelismFactor).toBeGreaterThanOrEqual(1);
      expect(metrics.successCount).toBe(5);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // REG.2: ioredis-mock Pub/Sub causing test hangs
  // ═══════════════════════════════════════════════════════════════════════════

  describe('REG.2: ioredis-mock Pub/Sub behavior', () => {
    it('should not hang when using mock Redis publish', async () => {
      // This test ensures mock Redis Pub/Sub doesn't cause hangs
      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Timeout')), 1000)
      );

      const publish = async () => {
        // Mock publish should complete quickly
        await mockRedis.publish('test-channel', 'test-message');
        return 'done';
      };

      const result = await Promise.race([publish(), timeout]);
      expect(result).toBe('done');
    });

    it('should handle agent registration without hanging', async () => {
      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Timeout')), 2000)
      );

      const register = async () => {
        const agent = await agentMonitor.registerAgent(
          'RegTest',
          'worker',
          'regression-session',
          'opencode-mcp'
        );
        return agent;
      };

      const agent = await Promise.race([register(), timeout]);
      expect(agent).not.toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // REG.3: saveContext return type confusion
  // ═══════════════════════════════════════════════════════════════════════════

  describe('REG.3: saveContext return type', () => {
    it('should return boolean, not the context entry', async () => {
      const result = await contextStorage.saveContext({
        id: 'return-type-test',
        sessionId: 'test-session',
        serverId: 'opencode-mcp',
        toolName: 'test',
        timestamp: Date.now() * 1000,
        ttl: 3600,
        args: {},
        output: {},
        summary: 'Return type test',
        tags: [],
      });

      // Result should be a boolean (true for success)
      expect(typeof result).toBe('boolean');
      expect(result).toBe(true);
    });

    it('should return false when not connected, not null', async () => {
      const disconnectedStorage = new ContextStorage({ db: 3 });

      // Prevent lazy connect by stubbing connect() to always fail
      spyOn(disconnectedStorage, 'connect').mockResolvedValue(false);

      const result = await disconnectedStorage.saveContext({
        id: 'disconnect-test',
        sessionId: 'test-session',
        serverId: 'opencode-mcp',
        toolName: 'test',
        timestamp: Date.now() * 1000,
        ttl: 3600,
        args: {},
        output: {},
        summary: 'Disconnected test',
        tags: [],
      });

      // Should return false, not null
      expect(result).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // REG.4: Warmup iterations affecting counts
  // ═══════════════════════════════════════════════════════════════════════════

  describe('REG.4: Warmup iterations affecting exact counts', () => {
    it('should allow exact count verification without warmup', async () => {
      const sessionId = 'exact-count-session';
      const targetCount = 5;

      // Register exact number of agents
      for (let i = 0; i < targetCount; i++) {
        await agentMonitor.registerAgent(`Exact-${i}`, 'worker', sessionId, 'opencode-mcp');
      }

      const agents = await agentMonitor.listAgents(sessionId);

      // Exact count should match
      expect(agents.length).toBe(targetCount);
    });

    it('should correctly track context entries without extra iterations', async () => {
      const sessionId = 'exact-context-session';
      const targetCount = 10;

      for (let i = 0; i < targetCount; i++) {
        await contextStorage.saveContext({
          id: `exact-${i}`,
          sessionId,
          serverId: 'opencode-mcp',
          toolName: 'test',
          timestamp: Date.now() * 1000 + i,
          ttl: 3600,
          args: {},
          output: {},
          summary: `Entry ${i}`,
          tags: [],
        });
      }

      const history = await contextStorage.getSessionHistory(sessionId, 100);
      expect(history.length).toBe(targetCount);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // REG.5: Performance thresholds for mock Redis
  // ═══════════════════════════════════════════════════════════════════════════

  describe('REG.5: Performance with mock Redis overhead', () => {
    it('should complete operations within reasonable mock time', async () => {
      const sessionId = 'perf-mock-session';
      const start = Date.now();

      // Run 20 operations
      for (let i = 0; i < 20; i++) {
        await agentMonitor.registerAgent(`Perf-${i}`, 'worker', sessionId, 'opencode-mcp');
      }

      const elapsed = Date.now() - start;

      // Should complete within 5 seconds (mock Redis has overhead)
      expect(elapsed).toBeLessThan(5000);

      // But should be fast enough
      const opsPerSecond = (20 / elapsed) * 1000;
      expect(opsPerSecond).toBeGreaterThan(10); // At least 10 ops/sec
    });

    it('should handle concurrent operations with mock', async () => {
      const sessionId = 'concurrent-mock-session';

      // Launch 10 concurrent operations
      const promises = Array(10)
        .fill(0)
        .map((_, i) =>
          agentMonitor.registerAgent(`Concurrent-${i}`, 'worker', sessionId, 'opencode-mcp')
        );

      const start = Date.now();
      await Promise.all(promises);
      const elapsed = Date.now() - start;

      // Should complete within 2 seconds
      expect(elapsed).toBeLessThan(2000);
    });
  });
});
