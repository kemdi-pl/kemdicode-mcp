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
 * Level 3 Performance Tests: High-Volume Data Processing
 *
 * Tests high-volume context storage and query performance.
 * Uses mock Redis - designed for CI/CD environments.
 *
 * Test Cases:
 * - P3.6: High-volume context entry writes
 * - P3.7: Bulk query performance
 * - P3.8: Session history retrieval
 * - P3.9: Concurrent read/write
 * - P3.10: Summary benchmarks
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { ContextStorage } from '../../src/context/storage.js';
import {
  runBenchmark,
  createPerformanceRedisMock,
  PerfIds,
  suppressConsoleForPerformance,
  assertPerformance,
} from './fixtures.js';

describe('Level 3 Performance: High-Volume Data Processing', () => {
  suppressConsoleForPerformance();

  let contextStorage: ContextStorage;
  let sessionId: string;
  let entryCounter = 0;

  beforeEach(async () => {
    sessionId = PerfIds.session();
    entryCounter = 0;
    contextStorage = new ContextStorage({ db: 3 });

    const mockRedis = createPerformanceRedisMock();
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

  /**
   * Generate a context entry for testing
   */
  function generateContextEntry(index: number) {
    return {
      id: `entry_${sessionId}_${index}_${Math.random().toString(36).slice(2, 8)}`,
      sessionId,
      serverId: 'opencode-mcp' as const,
      toolName: ['ask-ai', 'semantic-search', 'error-pattern', 'decision-journal'][index % 4],
      timestamp: Date.now() * 1000 + index,
      ttl: 3600,
      args: { files: `@src/file${index}.ts`, index },
      output: { success: true, data: `Result for entry ${index}` },
      summary: `Context entry ${index}`,
      tags: [`tag${index % 10}`, `batch${Math.floor(index / 100)}`, 'perf-test'],
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // P3.6: High-Volume Context Entry Writes
  // ═══════════════════════════════════════════════════════════════════════════

  describe('P3.6: High-volume context entry writes', () => {
    it('should write 200 context entries concurrently', async () => {
      const metrics = await runBenchmark(
        { name: 'Write 200 entries', iterations: 200, concurrency: 20, warmupIterations: 0 },
        async () => {
          return contextStorage.saveContext(generateContextEntry(entryCounter++));
        }
      );

      assertPerformance(metrics, {
        maxAvgMs: 50,
        minSuccessRate: 100,
      });

      expect(metrics.opsPerSecond).toBeGreaterThan(50);
    });

    it('should handle sequential writes', async () => {
      const metrics = await runBenchmark(
        { name: 'Sequential writes', iterations: 50, concurrency: 1, warmupIterations: 0 },
        async () => {
          return contextStorage.saveContext(generateContextEntry(entryCounter++));
        }
      );

      assertPerformance(metrics, {
        maxAvgMs: 20,
        minSuccessRate: 100,
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // P3.7: Bulk Query Performance
  // ═══════════════════════════════════════════════════════════════════════════

  describe('P3.7: Bulk query performance', () => {
    beforeEach(async () => {
      // Pre-populate with 100 entries
      for (let i = 0; i < 100; i++) {
        await contextStorage.saveContext(generateContextEntry(entryCounter++));
      }
    });

    it('should query dataset efficiently', async () => {
      const metrics = await runBenchmark(
        { name: 'Query dataset', iterations: 50, concurrency: 10, warmupIterations: 0 },
        async () => {
          return contextStorage.queryContext({ sessionId, limit: 30 });
        }
      );

      assertPerformance(metrics, {
        maxAvgMs: 50,
        minSuccessRate: 100,
      });
    });

    it('should filter by tool name efficiently', async () => {
      const tools = ['ask-ai', 'semantic-search', 'error-pattern', 'decision-journal'];

      const metrics = await runBenchmark(
        { name: 'Filter by tool', iterations: 40, concurrency: 10, warmupIterations: 0 },
        async (i) => {
          return contextStorage.queryContext({
            sessionId,
            toolName: tools[i % tools.length],
            limit: 20,
          });
        }
      );

      assertPerformance(metrics, {
        maxAvgMs: 50,
        minSuccessRate: 100,
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // P3.8: Session History Retrieval
  // ═══════════════════════════════════════════════════════════════════════════

  describe('P3.8: Session history retrieval', () => {
    beforeEach(async () => {
      // Pre-populate with 200 entries
      for (let i = 0; i < 200; i++) {
        await contextStorage.saveContext(generateContextEntry(entryCounter++));
      }
    });

    it('should retrieve paginated history efficiently', async () => {
      const metrics = await runBenchmark(
        { name: 'Paginated history', iterations: 50, concurrency: 10, warmupIterations: 0 },
        async () => {
          return contextStorage.getSessionHistory(sessionId, 50);
        }
      );

      assertPerformance(metrics, {
        maxAvgMs: 50,
        minSuccessRate: 100,
      });
    });

    it('should get latest from server efficiently', async () => {
      const metrics = await runBenchmark(
        { name: 'Latest from server', iterations: 50, concurrency: 10, warmupIterations: 0 },
        async () => {
          return contextStorage.getLatestFromServer(sessionId, 'opencode-mcp', 10);
        }
      );

      assertPerformance(metrics, {
        maxAvgMs: 30,
        minSuccessRate: 100,
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // P3.9: Concurrent Read/Write
  // ═══════════════════════════════════════════════════════════════════════════

  describe('P3.9: Concurrent read/write', () => {
    it('should handle mixed read/write', async () => {
      // Pre-populate
      for (let i = 0; i < 50; i++) {
        await contextStorage.saveContext(generateContextEntry(entryCounter++));
      }

      const metrics = await runBenchmark(
        { name: 'Mixed read/write', iterations: 100, concurrency: 10, warmupIterations: 0 },
        async (i) => {
          if (i % 2 === 0) {
            return contextStorage.saveContext(generateContextEntry(entryCounter++));
          } else {
            return contextStorage.queryContext({ sessionId, limit: 20 });
          }
        }
      );

      assertPerformance(metrics, {
        maxAvgMs: 50,
        minSuccessRate: 100,
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // P3.10: Summary Benchmarks
  // ═══════════════════════════════════════════════════════════════════════════

  describe('P3.10: Summary benchmarks', () => {
    it('should meet baseline data processing requirements', async () => {
      // Write benchmark
      const writeMetrics = await runBenchmark(
        { name: 'Write baseline', iterations: 50, concurrency: 10, warmupIterations: 0 },
        async () => contextStorage.saveContext(generateContextEntry(entryCounter++))
      );

      // Read benchmark
      const readMetrics = await runBenchmark(
        { name: 'Read baseline', iterations: 50, concurrency: 10, warmupIterations: 0 },
        async () => contextStorage.getSessionHistory(sessionId, 30)
      );

      // Both should meet requirements
      expect(writeMetrics.successRate).toBe(100);
      expect(writeMetrics.opsPerSecond).toBeGreaterThan(100);

      expect(readMetrics.successRate).toBe(100);
      expect(readMetrics.opsPerSecond).toBeGreaterThan(50);
    });
  });
});
