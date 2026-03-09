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
 * Level 3 Performance Tests: Scalability and Resource Contention
 *
 * Tests scaling behavior and resource contention across components.
 * Uses mock Redis - designed for CI/CD environments.
 *
 * Test Cases:
 * - P3.11: Linear scaling verification
 * - P3.12: Concurrent session scaling
 * - P3.13: Resource contention under load
 * - P3.14: Recovery after peak load
 * - P3.15: Summary benchmarks
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { AgentMonitor } from '../../src/context/agent-monitor.js';
import { ContextStorage } from '../../src/context/storage.js';
import { SessionManager } from '../../src/session/manager.js';
import {
  runBenchmark,
  createPerformanceRedisMock,
  PerfIds,
  suppressConsoleForPerformance,
  assertPerformance,
  BenchmarkMetrics,
} from './fixtures.js';

describe('Level 3 Performance: Scalability and Resource Contention', () => {
  suppressConsoleForPerformance();

  let agentMonitor: AgentMonitor;
  let contextStorage: ContextStorage;
  let _sessionManager: SessionManager;

  beforeEach(async () => {
    agentMonitor = new AgentMonitor({ db: 3 });
    contextStorage = new ContextStorage({ db: 3 });
    _sessionManager = new SessionManager();

    const mockRedis = createPerformanceRedisMock();
    (agentMonitor as unknown as { redis: unknown }).redis = mockRedis;
    (agentMonitor as unknown as { subscriber: unknown }).subscriber = mockRedis;
    (agentMonitor as unknown as { connected: boolean }).connected = true;

    (contextStorage as unknown as { redis: unknown }).redis = mockRedis;
    (contextStorage as unknown as { connected: boolean }).connected = true;
  });

  afterEach(async () => {
    try {
      await agentMonitor.disconnect();
      await contextStorage.disconnect();
    } catch {
      // Ignore
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // P3.11: Linear Scaling Verification
  // ═══════════════════════════════════════════════════════════════════════════

  describe('P3.11: Linear scaling verification', () => {
    it('should scale linearly with agent count', async () => {
      const results: { count: number; opsPerSec: number }[] = [];

      for (const agentCount of [5, 10, 20]) {
        const sessionId = PerfIds.session();

        // Pre-register agents
        for (let i = 0; i < agentCount; i++) {
          await agentMonitor.registerAgent(`Scale-${i}`, 'worker', sessionId, 'opencode-mcp');
        }

        const metrics = await runBenchmark(
          { name: `Query ${agentCount} agents`, iterations: 30, concurrency: 10, warmupIterations: 0 },
          async () => agentMonitor.listAgents(sessionId)
        );

        results.push({ count: agentCount, opsPerSec: metrics.opsPerSecond });
      }

      // Performance should not degrade more than 70% as we scale
      const degradationRatio = results[2].opsPerSec / results[0].opsPerSec;
      expect(degradationRatio).toBeGreaterThan(0.3);
    });

    it('should scale with context volume', async () => {
      const sessionId = PerfIds.session();
      let counter = 0;

      for (const entryCount of [50, 100, 200]) {
        // Add entries
        while (counter < entryCount) {
          await contextStorage.saveContext({
            id: `scale_${counter}_${Math.random().toString(36).slice(2, 8)}`,
            sessionId,
            serverId: 'opencode-mcp',
            toolName: 'scale-test',
            timestamp: Date.now() * 1000 + counter,
            ttl: 3600,
            args: { index: counter },
            output: { result: counter },
            summary: `Entry ${counter}`,
            tags: [`batch${Math.floor(counter / 50)}`],
          });
          counter++;
        }

        const metrics = await runBenchmark(
          { name: `Query ${entryCount} entries`, iterations: 20, concurrency: 5, warmupIterations: 0 },
          async () => contextStorage.getSessionHistory(sessionId, 50)
        );

        assertPerformance(metrics, {
          maxAvgMs: 100,
          minSuccessRate: 100,
        });
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // P3.12: Concurrent Session Scaling
  // ═══════════════════════════════════════════════════════════════════════════

  describe('P3.12: Concurrent session scaling', () => {
    it('should handle 10 concurrent sessions', async () => {
      const sessions = Array.from({ length: 10 }, () => PerfIds.session());

      const metrics = await runBenchmark(
        { name: '10 concurrent sessions', iterations: 100, concurrency: 10, warmupIterations: 0 },
        async (i) => {
          const sessId = sessions[i % sessions.length];
          return agentMonitor.registerAgent(`Sess-${i}`, 'worker', sessId, 'opencode-mcp');
        }
      );

      assertPerformance(metrics, {
        maxAvgMs: 50,
        minSuccessRate: 100,
      });

      // Verify isolation
      for (const sessId of sessions) {
        const agents = await agentMonitor.listAgents(sessId);
        expect(agents.length).toBe(10);
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // P3.13: Resource Contention Under Load
  // ═══════════════════════════════════════════════════════════════════════════

  describe('P3.13: Resource contention under load', () => {
    it('should handle contention on single session', async () => {
      const sessionId = PerfIds.session();

      // Pre-register agents
      for (let i = 0; i < 10; i++) {
        await agentMonitor.registerAgent(`Contend-${i}`, 'worker', sessionId, 'opencode-mcp');
      }

      const agents = await agentMonitor.listAgents(sessionId);

      const metrics = await runBenchmark(
        { name: 'Single session contention', iterations: 100, concurrency: 20, warmupIterations: 0 },
        async (i) => {
          const agentId = agents[i % agents.length].id;
          return agentMonitor.updateAgentStatus(agentId, i % 2 === 0 ? 'processing' : 'idle');
        }
      );

      assertPerformance(metrics, {
        maxAvgMs: 30,
        minSuccessRate: 100,
      });
    });

    it('should handle write contention', async () => {
      const sessionId = PerfIds.session();
      let counter = 0;

      const metrics = await runBenchmark(
        { name: 'Write contention', iterations: 100, concurrency: 20, warmupIterations: 0 },
        async (i) => {
          return contextStorage.saveContext({
            id: `write_${counter++}_${Math.random().toString(36).slice(2, 8)}`,
            sessionId,
            serverId: 'opencode-mcp',
            toolName: 'write-test',
            timestamp: Date.now() * 1000 + counter,
            ttl: 3600,
            args: {},
            output: {},
            summary: `Write ${i}`,
            tags: [],
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
  // P3.14: Recovery After Peak Load
  // ═══════════════════════════════════════════════════════════════════════════

  describe('P3.14: Recovery after peak load', () => {
    it('should recover performance after load spike', async () => {
      const sessionId = PerfIds.session();

      // Baseline performance
      const baselineMetrics = await runBenchmark(
        { name: 'Baseline', iterations: 30, concurrency: 10, warmupIterations: 0 },
        async (i) => agentMonitor.registerAgent(`Base-${i}`, 'worker', sessionId, 'opencode-mcp')
      );

      // Stress phase - moderate load
      await runBenchmark(
        { name: 'Stress', iterations: 50, concurrency: 20, warmupIterations: 0 },
        async (i) => agentMonitor.sendMessage('supervisor', `agent_${i % 10}`, sessionId, `Stress ${i}`)
      );

      // Small cooldown
      await new Promise((r) => setTimeout(r, 50));

      // Recovery check
      const newSession = PerfIds.session();
      const recoveryMetrics = await runBenchmark(
        { name: 'Recovery', iterations: 30, concurrency: 10, warmupIterations: 0 },
        async (i) => agentMonitor.registerAgent(`Rec-${i}`, 'worker', newSession, 'opencode-mcp')
      );

      // Recovery performance should be within 5x of baseline
      const degradation = recoveryMetrics.avgDurationMs / baselineMetrics.avgDurationMs;
      expect(degradation).toBeLessThan(5);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // P3.15: Summary Benchmarks
  // ═══════════════════════════════════════════════════════════════════════════

  describe('P3.15: Summary benchmarks', () => {
    it('should meet baseline scalability requirements', async () => {
      const benchmarks: BenchmarkMetrics[] = [];
      const sessionId = PerfIds.session();

      // Initialize
      for (let i = 0; i < 10; i++) {
        await agentMonitor.registerAgent(`Summary-${i}`, 'worker', sessionId, 'opencode-mcp');
      }

      // Agent operations
      benchmarks.push(
        await runBenchmark(
          { name: 'Agent ops', iterations: 50, concurrency: 10, warmupIterations: 0 },
          async () => agentMonitor.listAgents(sessionId)
        )
      );

      // Context operations
      let counter = 0;
      benchmarks.push(
        await runBenchmark(
          { name: 'Context ops', iterations: 50, concurrency: 10, warmupIterations: 0 },
          async (i) =>
            contextStorage.saveContext({
              id: `summary_${counter++}_${Math.random().toString(36).slice(2, 8)}`,
              sessionId,
              serverId: 'opencode-mcp',
              toolName: 'summary',
              timestamp: Date.now() * 1000 + counter,
              ttl: 3600,
              args: {},
              output: {},
              summary: `Summary ${i}`,
              tags: [],
            })
        )
      );

      // All benchmarks should meet requirements
      for (const metrics of benchmarks) {
        expect(metrics.successRate).toBe(100);
        expect(metrics.avgDurationMs).toBeLessThan(100);
        expect(metrics.opsPerSecond).toBeGreaterThan(50);
      }
    });
  });
});
