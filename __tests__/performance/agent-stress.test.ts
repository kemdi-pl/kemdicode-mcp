/**
 * Level 3 Performance Tests: Agent Stress Tests
 *
 * Tests high-concurrency agent operations and system behavior under load.
 * Uses mock Redis - designed for CI/CD environments where real Redis may not be available.
 *
 * Test Cases:
 * - P3.1: High-concurrency agent registration (50-100 agents)
 * - P3.2: Concurrent message sending (500+ messages)
 * - P3.3: Agent status update throughput
 * - P3.4: Alert sending performance
 * - P3.5: Benchmark summary
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AgentMonitor } from '../../src/context/agent-monitor.js';
import {
  runBenchmark,
  createPerformanceRedisMock,
  PerfIds,
  suppressConsoleForPerformance,
  assertPerformance,
  BenchmarkMetrics,
} from './fixtures.js';

describe('Level 3 Performance: Agent Stress Tests', () => {
  suppressConsoleForPerformance();

  let agentMonitor: AgentMonitor;
  let sessionId: string;

  beforeEach(async () => {
    sessionId = PerfIds.session();
    agentMonitor = new AgentMonitor({ db: 3 });

    const mockRedis = createPerformanceRedisMock();
    (agentMonitor as unknown as { redis: unknown }).redis = mockRedis;
    (agentMonitor as unknown as { subscriber: unknown }).subscriber = mockRedis;
    (agentMonitor as unknown as { connected: boolean }).connected = true;
  });

  afterEach(async () => {
    try {
      await agentMonitor.disconnect();
    } catch {
      // Ignore
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // P3.1: High-Concurrency Agent Registration
  // ═══════════════════════════════════════════════════════════════════════════

  describe('P3.1: High-concurrency agent registration', () => {
    it('should register 50 agents concurrently', async () => {
      const metrics = await runBenchmark(
        { name: 'Register 50 agents', iterations: 50, concurrency: 50, warmupIterations: 0 },
        async (i) => {
          return agentMonitor.registerAgent(
            `Agent-${i}`,
            'worker',
            sessionId,
            'opencode-mcp',
            'test-model'
          );
        }
      );

      assertPerformance(metrics, {
        maxAvgMs: 50,
        minSuccessRate: 100,
      });

      const agents = await agentMonitor.listAgents(sessionId);
      expect(agents.length).toBe(50);
    });

    it('should register 100 agents concurrently', async () => {
      const metrics = await runBenchmark(
        { name: 'Register 100 agents', iterations: 100, concurrency: 100, warmupIterations: 2 },
        async (i) => {
          return agentMonitor.registerAgent(
            `Agent-${i}`,
            i % 4 === 0 ? 'supervisor' : 'worker',
            sessionId,
            'opencode-mcp'
          );
        }
      );

      assertPerformance(metrics, {
        maxAvgMs: 100,
        minSuccessRate: 100,
      });

      expect(metrics.opsPerSecond).toBeGreaterThan(100);
    });

    it('should handle rapid sequential registrations', async () => {
      const metrics = await runBenchmark(
        { name: 'Sequential agent registration', iterations: 50, concurrency: 1, warmupIterations: 0 },
        async (i) => {
          return agentMonitor.registerAgent(
            `SeqAgent-${i}`,
            'worker',
            sessionId,
            'opencode-mcp'
          );
        }
      );

      assertPerformance(metrics, {
        maxAvgMs: 20,
        minSuccessRate: 100,
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // P3.2: Concurrent Message Sending
  // ═══════════════════════════════════════════════════════════════════════════

  describe('P3.2: Concurrent message sending', () => {
    let agentIds: string[] = [];

    beforeEach(async () => {
      // Pre-register agents
      agentIds = [];
      for (let i = 0; i < 5; i++) {
        const agent = await agentMonitor.registerAgent(
          `MsgAgent-${i}`,
          'worker',
          sessionId,
          'opencode-mcp'
        );
        if (agent) agentIds.push(agent.id);
      }
    });

    it('should send 200 messages concurrently', async () => {
      const metrics = await runBenchmark(
        { name: 'Send 200 messages', iterations: 200, concurrency: 20, warmupIterations: 0 },
        async (i) => {
          const from = agentIds[i % agentIds.length];
          const to = agentIds[(i + 1) % agentIds.length];
          return agentMonitor.sendMessage(
            from,
            to,
            sessionId,
            `Message ${i}`,
            'chat',
            'normal'
          );
        }
      );

      assertPerformance(metrics, {
        maxAvgMs: 30,
        minSuccessRate: 100,
      });

      expect(metrics.opsPerSecond).toBeGreaterThan(100);
    });

    it('should send messages with varying priorities', async () => {
      const priorities = ['low', 'normal', 'high', 'critical'] as const;

      const metrics = await runBenchmark(
        { name: 'Send mixed-priority messages', iterations: 100, concurrency: 10, warmupIterations: 0 },
        async (i) => {
          const from = agentIds[i % agentIds.length];
          const to = agentIds[(i + 1) % agentIds.length];
          return agentMonitor.sendMessage(
            from,
            to,
            sessionId,
            `Priority message ${i}`,
            'chat',
            priorities[i % priorities.length]
          );
        }
      );

      assertPerformance(metrics, {
        maxAvgMs: 50,
        minSuccessRate: 100,
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // P3.3: Agent Status Update Throughput
  // ═══════════════════════════════════════════════════════════════════════════

  describe('P3.3: Agent status update throughput', () => {
    let agentIds: string[] = [];

    beforeEach(async () => {
      agentIds = [];
      for (let i = 0; i < 10; i++) {
        const agent = await agentMonitor.registerAgent(
          `StatusAgent-${i}`,
          'worker',
          sessionId,
          'opencode-mcp'
        );
        if (agent) agentIds.push(agent.id);
      }
    });

    it('should update 200 agent statuses', async () => {
      const statuses = ['active', 'idle', 'processing'] as const;

      const metrics = await runBenchmark(
        { name: 'Update 200 statuses', iterations: 200, concurrency: 20, warmupIterations: 0 },
        async (i) => {
          const agentId = agentIds[i % agentIds.length];
          return agentMonitor.updateAgentStatus(
            agentId,
            statuses[i % statuses.length],
            `Task ${i}`
          );
        }
      );

      assertPerformance(metrics, {
        maxAvgMs: 30,
        minSuccessRate: 100,
      });
    });

    it('should handle rapid status transitions', async () => {
      const agentId = agentIds[0];

      const metrics = await runBenchmark(
        { name: 'Rapid status transitions', iterations: 50, concurrency: 1, warmupIterations: 0 },
        async (i) => {
          const status = i % 2 === 0 ? 'processing' : 'idle';
          return agentMonitor.updateAgentStatus(agentId, status, `Transition ${i}`);
        }
      );

      assertPerformance(metrics, {
        maxAvgMs: 15,
        minSuccessRate: 100,
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // P3.4: Alert Performance
  // ═══════════════════════════════════════════════════════════════════════════

  describe('P3.4: Alert performance', () => {
    let agentIds: string[] = [];

    beforeEach(async () => {
      agentIds = [];
      for (let i = 0; i < 3; i++) {
        const agent = await agentMonitor.registerAgent(
          `AlertAgent-${i}`,
          'worker',
          sessionId,
          'opencode-mcp'
        );
        if (agent) agentIds.push(agent.id);
      }
    });

    it('should send alerts to individual agents', async () => {
      const metrics = await runBenchmark(
        { name: 'Single agent alerts', iterations: 15, concurrency: 3, warmupIterations: 0 },
        async (i) => {
          return agentMonitor.sendAlert(
            [agentIds[i % agentIds.length]],
            `Alert ${i}`,
            'Supervisor',
            'normal',
            false,
            sessionId
          );
        }
      );

      assertPerformance(metrics, {
        maxAvgMs: 200,
        minSuccessRate: 100,
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Benchmark Summary
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Performance benchmarks summary', () => {
    it('should meet baseline performance requirements', async () => {
      const benchmarks: BenchmarkMetrics[] = [];

      // Agent registration benchmark
      benchmarks.push(
        await runBenchmark(
          { name: 'Agent Registration', iterations: 30, concurrency: 10, warmupIterations: 0 },
          async (i) => agentMonitor.registerAgent(`Bench-${i}`, 'worker', sessionId, 'opencode-mcp')
        )
      );

      // Message sending benchmark
      const agent = await agentMonitor.registerAgent('BenchTarget', 'worker', sessionId, 'opencode-mcp');
      benchmarks.push(
        await runBenchmark(
          { name: 'Message Sending', iterations: 50, concurrency: 10, warmupIterations: 0 },
          async (i) => agentMonitor.sendMessage('supervisor', agent!.id, sessionId, `Bench ${i}`)
        )
      );

      // Status update benchmark
      benchmarks.push(
        await runBenchmark(
          { name: 'Status Update', iterations: 30, concurrency: 10, warmupIterations: 0 },
          async (i) => agentMonitor.updateAgentStatus(agent!.id, i % 2 === 0 ? 'processing' : 'idle')
        )
      );

      // All benchmarks should meet baseline
      for (const metrics of benchmarks) {
        expect(metrics.successRate).toBe(100);
        expect(metrics.avgDurationMs).toBeLessThan(100);
        expect(metrics.opsPerSecond).toBeGreaterThan(10);
      }
    });
  });
});
