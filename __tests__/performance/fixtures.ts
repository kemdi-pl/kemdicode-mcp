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
 * Performance Test Fixtures
 *
 * Infrastructure for performance and load testing including benchmarking,
 * stress testing utilities, and performance metrics collection.
 */

import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import { vi } from 'vitest';

/**
 * Performance metrics for a single benchmark run
 */
export interface BenchmarkMetrics {
  name: string;
  iterations: number;
  totalDurationMs: number;
  avgDurationMs: number;
  minDurationMs: number;
  maxDurationMs: number;
  p50DurationMs: number;
  p95DurationMs: number;
  p99DurationMs: number;
  opsPerSecond: number;
  successRate: number;
  errorCount: number;
  memoryUsedMB?: number;
}

/**
 * Configuration for benchmark runs
 */
export interface BenchmarkConfig {
  name: string;
  warmupIterations?: number;
  iterations: number;
  concurrency?: number;
  collectMemory?: boolean;
  timeout?: number;
}

/**
 * Run a benchmark and collect metrics
 */
export async function runBenchmark<T>(
  config: BenchmarkConfig,
  fn: (iteration: number) => Promise<T>
): Promise<BenchmarkMetrics> {
  const { name, warmupIterations = 5, iterations, concurrency = 1, collectMemory = false } = config;

  // Warmup phase
  for (let i = 0; i < warmupIterations; i++) {
    await fn(i);
  }

  // Force GC if available
  if (global.gc && collectMemory) {
    global.gc();
  }

  const memoryBefore = collectMemory ? process.memoryUsage().heapUsed : 0;
  const durations: number[] = [];
  let errorCount = 0;

  if (concurrency === 1) {
    // Sequential execution
    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      try {
        await fn(i);
      } catch {
        errorCount++;
      }
      durations.push(performance.now() - start);
    }
  } else {
    // Concurrent execution in batches
    for (let batch = 0; batch < iterations; batch += concurrency) {
      const batchSize = Math.min(concurrency, iterations - batch);
      const batchPromises = Array.from({ length: batchSize }, async (_, i) => {
        const start = performance.now();
        try {
          await fn(batch + i);
          return performance.now() - start;
        } catch {
          errorCount++;
          return performance.now() - start;
        }
      });
      const batchDurations = await Promise.all(batchPromises);
      durations.push(...batchDurations);
    }
  }

  const memoryAfter = collectMemory ? process.memoryUsage().heapUsed : 0;

  // Calculate metrics
  const sortedDurations = [...durations].sort((a, b) => a - b);
  const totalDurationMs = durations.reduce((a, b) => a + b, 0);

  return {
    name,
    iterations,
    totalDurationMs,
    avgDurationMs: totalDurationMs / iterations,
    minDurationMs: sortedDurations[0],
    maxDurationMs: sortedDurations[sortedDurations.length - 1],
    p50DurationMs: percentile(sortedDurations, 50),
    p95DurationMs: percentile(sortedDurations, 95),
    p99DurationMs: percentile(sortedDurations, 99),
    opsPerSecond: (iterations / totalDurationMs) * 1000,
    successRate: ((iterations - errorCount) / iterations) * 100,
    errorCount,
    memoryUsedMB: collectMemory ? (memoryAfter - memoryBefore) / 1024 / 1024 : undefined,
  };
}

/**
 * Calculate percentile from sorted array
 */
function percentile(sortedArr: number[], p: number): number {
  const index = Math.ceil((p / 100) * sortedArr.length) - 1;
  return sortedArr[Math.max(0, index)];
}

/**
 * Stress test configuration
 */
export interface StressTestConfig {
  name: string;
  targetOps: number;
  durationMs: number;
  rampUpMs?: number;
  cooldownMs?: number;
  maxConcurrency?: number;
}

/**
 * Stress test results
 */
export interface StressTestResult {
  name: string;
  targetOps: number;
  actualOps: number;
  durationMs: number;
  avgLatencyMs: number;
  maxLatencyMs: number;
  errorRate: number;
  throughputOpsPerSec: number;
  saturationPoint?: number;
}

/**
 * Run a stress test with sustained load
 */
export async function runStressTest<T>(
  config: StressTestConfig,
  fn: () => Promise<T>
): Promise<StressTestResult> {
  const {
    name,
    targetOps,
    durationMs,
    rampUpMs: _rampUpMs = 0,
    cooldownMs: _cooldownMs = 0,
    maxConcurrency = 100,
  } = config;

  const startTime = Date.now();
  const endTime = startTime + durationMs;
  const latencies: number[] = [];
  let errorCount = 0;
  let completedOps = 0;
  let activeOps = 0;

  const opsPerMs = targetOps / durationMs;

  while (Date.now() < endTime) {
    const elapsed = Date.now() - startTime;
    const expectedOps = Math.floor(opsPerMs * elapsed);
    const opsToLaunch = Math.min(expectedOps - completedOps - activeOps, maxConcurrency - activeOps);

    if (opsToLaunch > 0) {
      for (let i = 0; i < opsToLaunch; i++) {
        activeOps++;
        const opStart = performance.now();
        fn()
          .then(() => {
            latencies.push(performance.now() - opStart);
            completedOps++;
          })
          .catch(() => {
            errorCount++;
            completedOps++;
          })
          .finally(() => {
            activeOps--;
          });
      }
    }

    // Small delay to prevent busy loop
    await new Promise((r) => setTimeout(r, 1));
  }

  // Wait for remaining operations
  while (activeOps > 0) {
    await new Promise((r) => setTimeout(r, 10));
  }

  const actualDuration = Date.now() - startTime;
  const sortedLatencies = [...latencies].sort((a, b) => a - b);

  return {
    name,
    targetOps,
    actualOps: completedOps,
    durationMs: actualDuration,
    avgLatencyMs: latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0,
    maxLatencyMs: sortedLatencies[sortedLatencies.length - 1] || 0,
    errorRate: (errorCount / completedOps) * 100,
    throughputOpsPerSec: (completedOps / actualDuration) * 1000,
  };
}

/**
 * Load generator for sustained concurrent operations
 */
export class LoadGenerator {
  private running = false;
  private operations: Promise<unknown>[] = [];
  private metrics = {
    completed: 0,
    errors: 0,
    latencies: [] as number[],
  };

  constructor(
    private fn: () => Promise<unknown>,
    private concurrency: number = 10
  ) {}

  async start(durationMs: number): Promise<{
    completed: number;
    errors: number;
    avgLatencyMs: number;
    opsPerSecond: number;
  }> {
    this.running = true;
    this.metrics = { completed: 0, errors: 0, latencies: [] };

    const startTime = Date.now();
    const endTime = startTime + durationMs;

    // Launch initial concurrent operations
    for (let i = 0; i < this.concurrency; i++) {
      this.launchOperation();
    }

    // Wait until duration expires
    while (Date.now() < endTime && this.running) {
      await new Promise((r) => setTimeout(r, 10));
    }

    this.running = false;

    // Wait for in-flight operations
    await Promise.allSettled(this.operations);

    const totalDuration = Date.now() - startTime;
    return {
      completed: this.metrics.completed,
      errors: this.metrics.errors,
      avgLatencyMs:
        this.metrics.latencies.length > 0
          ? this.metrics.latencies.reduce((a, b) => a + b, 0) / this.metrics.latencies.length
          : 0,
      opsPerSecond: (this.metrics.completed / totalDuration) * 1000,
    };
  }

  stop(): void {
    this.running = false;
  }

  private launchOperation(): void {
    if (!this.running) return;

    const start = performance.now();
    const op = this.fn()
      .then(() => {
        this.metrics.latencies.push(performance.now() - start);
        this.metrics.completed++;
      })
      .catch(() => {
        this.metrics.errors++;
      })
      .finally(() => {
        // Remove from active operations
        const idx = this.operations.indexOf(op);
        if (idx >= 0) this.operations.splice(idx, 1);

        // Launch replacement if still running
        if (this.running) {
          this.launchOperation();
        }
      });

    this.operations.push(op);
  }
}

/**
 * Create a shared Redis mock with optional latency simulation
 * The publish/subscribe functions are mocked to be no-ops to avoid blocking
 */
export function createPerformanceRedisMock(options: { simulatedLatencyMs?: number } = {}): Redis {
  const { simulatedLatencyMs = 0 } = options;
  const mock = new RedisMock({ data: {} });

  // Mock Pub/Sub functions to be fast no-ops (ioredis-mock can cause hangs)
  mock.publish = async () => 0;
  mock.subscribe = async () => mock;
  mock.psubscribe = async () => mock;
  mock.unsubscribe = async () => mock;
  mock.punsubscribe = async () => mock;
  mock.on = () => mock;

  if (simulatedLatencyMs > 0) {
    // Wrap methods with simulated latency
    const originalGet = mock.get.bind(mock);
    const originalSet = mock.set.bind(mock);
    const originalSetex = mock.setex.bind(mock);

    mock.get = async (...args: Parameters<typeof originalGet>) => {
      await new Promise((r) => setTimeout(r, simulatedLatencyMs));
      return originalGet(...args);
    };

    mock.set = async (...args: Parameters<typeof originalSet>) => {
      await new Promise((r) => setTimeout(r, simulatedLatencyMs));
      return originalSet(...args);
    };

    mock.setex = async (...args: Parameters<typeof originalSetex>) => {
      await new Promise((r) => setTimeout(r, simulatedLatencyMs));
      return originalSetex(...args);
    };
  }

  return mock as unknown as Redis;
}

/**
 * Generate unique IDs for performance tests
 */
export const PerfIds = {
  session: () => `sess_perf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
  agent: () => `agent_perf_${Math.random().toString(36).slice(2, 10)}`,
  context: () => `ctx_perf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
};

/**
 * Suppress console output during performance tests
 */
export function suppressConsoleForPerformance() {
  const originalConsole = { ...console };

  beforeEach(() => {
    console.log = vi.fn();
    console.info = vi.fn();
    console.warn = vi.fn();
    console.error = vi.fn();
    console.debug = vi.fn();
  });

  afterEach(() => {
    console.log = originalConsole.log;
    console.info = originalConsole.info;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
    console.debug = originalConsole.debug;
  });
}

/**
 * Format benchmark metrics for display
 */
export function formatBenchmarkMetrics(metrics: BenchmarkMetrics): string {
  return `
${metrics.name}
${'─'.repeat(50)}
Iterations:     ${metrics.iterations}
Total Time:     ${metrics.totalDurationMs.toFixed(2)}ms
Avg Time:       ${metrics.avgDurationMs.toFixed(3)}ms
Min Time:       ${metrics.minDurationMs.toFixed(3)}ms
Max Time:       ${metrics.maxDurationMs.toFixed(3)}ms
P50:            ${metrics.p50DurationMs.toFixed(3)}ms
P95:            ${metrics.p95DurationMs.toFixed(3)}ms
P99:            ${metrics.p99DurationMs.toFixed(3)}ms
Throughput:     ${metrics.opsPerSecond.toFixed(2)} ops/sec
Success Rate:   ${metrics.successRate.toFixed(2)}%
${metrics.memoryUsedMB !== undefined ? `Memory Used:    ${metrics.memoryUsedMB.toFixed(2)}MB` : ''}
`.trim();
}

/**
 * Assert performance thresholds
 */
export function assertPerformance(
  metrics: BenchmarkMetrics,
  thresholds: {
    maxAvgMs?: number;
    maxP95Ms?: number;
    maxP99Ms?: number;
    minOpsPerSecond?: number;
    minSuccessRate?: number;
  }
): void {
  const { maxAvgMs, maxP95Ms, maxP99Ms, minOpsPerSecond, minSuccessRate = 99 } = thresholds;

  if (maxAvgMs !== undefined && metrics.avgDurationMs > maxAvgMs) {
    throw new Error(
      `Average duration ${metrics.avgDurationMs.toFixed(3)}ms exceeds threshold ${maxAvgMs}ms`
    );
  }

  if (maxP95Ms !== undefined && metrics.p95DurationMs > maxP95Ms) {
    throw new Error(
      `P95 duration ${metrics.p95DurationMs.toFixed(3)}ms exceeds threshold ${maxP95Ms}ms`
    );
  }

  if (maxP99Ms !== undefined && metrics.p99DurationMs > maxP99Ms) {
    throw new Error(
      `P99 duration ${metrics.p99DurationMs.toFixed(3)}ms exceeds threshold ${maxP99Ms}ms`
    );
  }

  if (minOpsPerSecond !== undefined && metrics.opsPerSecond < minOpsPerSecond) {
    throw new Error(
      `Throughput ${metrics.opsPerSecond.toFixed(2)} ops/sec below threshold ${minOpsPerSecond} ops/sec`
    );
  }

  if (metrics.successRate < minSuccessRate) {
    throw new Error(
      `Success rate ${metrics.successRate.toFixed(2)}% below threshold ${minSuccessRate}%`
    );
  }
}

/**
 * Memory usage tracker
 */
export class MemoryTracker {
  private samples: number[] = [];
  private interval: ReturnType<typeof setInterval> | null = null;

  start(sampleIntervalMs = 100): void {
    this.samples = [];
    this.interval = setInterval(() => {
      this.samples.push(process.memoryUsage().heapUsed);
    }, sampleIntervalMs);
  }

  stop(): {
    peakMB: number;
    avgMB: number;
    minMB: number;
    samples: number;
  } {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }

    const toMB = (bytes: number) => bytes / 1024 / 1024;

    return {
      peakMB: toMB(Math.max(...this.samples, 0)),
      avgMB: this.samples.length > 0 ? toMB(this.samples.reduce((a, b) => a + b, 0) / this.samples.length) : 0,
      minMB: toMB(Math.min(...this.samples, Infinity)),
      samples: this.samples.length,
    };
  }
}
