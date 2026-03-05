/**
 * Integration Test Fixtures
 *
 * Extended fixtures for integration tests that require multiple components
 * working together, simulated agents, and concurrent operations.
 */

import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import { vi } from 'vitest';

/**
 * Create a shared Redis mock for multi-agent scenarios
 * All agents in the test will share the same underlying data store
 */
export function createSharedRedisMock(): Redis {
  const sharedData = {};
  return new RedisMock({ data: sharedData }) as unknown as Redis;
}

/**
 * Create multiple independent Redis mocks that share the same backing store
 * Simulates multiple agent connections to the same Redis instance
 */
export function createConnectedRedisMocks(count: number): Redis[] {
  const sharedData = {};
  return Array.from({ length: count }, () => {
    return new RedisMock({ data: sharedData }) as unknown as Redis;
  }) as unknown as Redis[];
}

/**
 * Simulated agent for integration testing
 */
export interface SimulatedAgent {
  id: string;
  name: string;
  role: 'supervisor' | 'worker' | 'specialist' | 'coordinator';
  sessionId: string;
  redis: Redis;
  messageQueue: AgentMessage[];
  status: 'active' | 'idle' | 'processing' | 'terminated';
  processedTasks: string[];
}

export interface AgentMessage {
  id: string;
  fromAgentId: string;
  toAgentId: string;
  content: string;
  type: 'chat' | 'alert' | 'directive' | 'context' | 'query' | 'response';
  timestamp: number;
}

/**
 * Create a simulated agent for testing
 */
export function createSimulatedAgent(
  options: Partial<SimulatedAgent> & { redis: Redis }
): SimulatedAgent {
  const id = options.id || `agent_${Math.random().toString(36).slice(2, 10)}`;
  return {
    id,
    name: options.name || `Agent-${id.slice(-4)}`,
    role: options.role || 'worker',
    sessionId: options.sessionId || `sess_${Date.now()}`,
    redis: options.redis,
    messageQueue: [],
    status: 'active',
    processedTasks: [],
  };
}

/**
 * Create a pool of simulated agents
 */
export function createAgentPool(
  count: number,
  sessionId: string,
  options: { redis?: Redis; includesSupervisor?: boolean } = {}
): SimulatedAgent[] {
  const sharedData = {};
  const redis = options.redis || (new RedisMock({ data: sharedData }) as unknown as Redis);

  const agents: SimulatedAgent[] = [];

  // Optionally create a supervisor
  if (options.includesSupervisor) {
    agents.push(
      createSimulatedAgent({
        id: `agent_supervisor`,
        name: 'Supervisor',
        role: 'supervisor',
        sessionId,
        redis,
      })
    );
  }

  // Create worker agents
  for (let i = 0; i < count; i++) {
    agents.push(
      createSimulatedAgent({
        id: `agent_worker_${i}`,
        name: `Worker-${i}`,
        role: 'worker',
        sessionId,
        redis,
      })
    );
  }

  return agents;
}

/**
 * Concurrent task executor for parallel testing
 */
export interface ConcurrentTask<T> {
  name: string;
  fn: () => Promise<T>;
}

export interface ConcurrentResult<T> {
  name: string;
  result?: T;
  error?: Error;
  durationMs: number;
  startedAt: number;
  completedAt: number;
}

/**
 * Execute multiple tasks concurrently and collect results
 */
export async function runConcurrentTasks<T>(
  tasks: ConcurrentTask<T>[]
): Promise<ConcurrentResult<T>[]> {
  const results = await Promise.all(
    tasks.map(async (task) => {
      const startedAt = Date.now();
      try {
        const result = await task.fn();
        const completedAt = Date.now();
        return {
          name: task.name,
          result,
          durationMs: completedAt - startedAt,
          startedAt,
          completedAt,
        };
      } catch (error) {
        const completedAt = Date.now();
        return {
          name: task.name,
          error: error instanceof Error ? error : new Error(String(error)),
          durationMs: completedAt - startedAt,
          startedAt,
          completedAt,
        };
      }
    })
  );
  return results;
}

/**
 * Run tasks with controlled concurrency (limited parallelism)
 */
export async function runWithConcurrencyLimit<T>(
  tasks: ConcurrentTask<T>[],
  limit: number
): Promise<ConcurrentResult<T>[]> {
  const results: ConcurrentResult<T>[] = [];
  const executing: Promise<void>[] = [];

  for (const task of tasks) {
    const p = (async () => {
      const startedAt = Date.now();
      try {
        const result = await task.fn();
        const completedAt = Date.now();
        results.push({
          name: task.name,
          result,
          durationMs: completedAt - startedAt,
          startedAt,
          completedAt,
        });
      } catch (error) {
        const completedAt = Date.now();
        results.push({
          name: task.name,
          error: error instanceof Error ? error : new Error(String(error)),
          durationMs: completedAt - startedAt,
          startedAt,
          completedAt,
        });
      }
    })();

    executing.push(p);

    if (executing.length >= limit) {
      await Promise.race(executing);
      // Remove completed promises
      for (let i = executing.length - 1; i >= 0; i--) {
        const status = await Promise.race([
          executing[i].then(() => 'done'),
          Promise.resolve('pending'),
        ]);
        if (status === 'done') {
          executing.splice(i, 1);
        }
      }
    }
  }

  await Promise.all(executing);
  return results;
}

/**
 * Wait for a condition with timeout
 */
export async function waitForCondition(
  condition: () => boolean | Promise<boolean>,
  options: { timeout?: number; interval?: number; description?: string } = {}
): Promise<void> {
  const { timeout = 5000, interval = 50, description = 'condition' } = options;
  const start = Date.now();

  while (Date.now() - start < timeout) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }

  throw new Error(`Timeout waiting for ${description} after ${timeout}ms`);
}

/**
 * Create deferred promise for async coordination
 */
export function createDeferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;

  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

/**
 * Create a barrier for synchronizing multiple agents
 */
export function createBarrier(
  count: number
): {
  wait: () => Promise<void>;
  release: () => void;
  reset: () => void;
} {
  let waiting = 0;
  let resolve: (() => void) | null = null;
  let promise = new Promise<void>((res) => {
    resolve = res;
  });

  return {
    wait: async () => {
      waiting++;
      if (waiting >= count && resolve) {
        resolve();
      }
      await promise;
    },
    release: () => {
      if (resolve) {
        resolve();
      }
    },
    reset: () => {
      waiting = 0;
      promise = new Promise<void>((res) => {
        resolve = res;
      });
    },
  };
}

/**
 * Measure execution time of concurrent operations
 */
export interface ConcurrencyMetrics {
  totalDurationMs: number;
  averageDurationMs: number;
  maxDurationMs: number;
  minDurationMs: number;
  parallelismFactor: number;
  successCount: number;
  errorCount: number;
}

export function calculateConcurrencyMetrics<T>(results: ConcurrentResult<T>[]): ConcurrencyMetrics {
  const durations = results.map((r) => r.durationMs);
  const sequentialTime = durations.reduce((a, b) => a + b, 0);

  const earliestStart = Math.min(...results.map((r) => r.startedAt));
  const latestEnd = Math.max(...results.map((r) => r.completedAt));
  const totalDurationMs = latestEnd - earliestStart;

  // Avoid division by zero - if totalDurationMs is 0, parallelism is 1
  const parallelismFactor = totalDurationMs > 0 ? sequentialTime / totalDurationMs : 1;

  return {
    totalDurationMs,
    averageDurationMs: results.length > 0 ? sequentialTime / results.length : 0,
    maxDurationMs: durations.length > 0 ? Math.max(...durations) : 0,
    minDurationMs: durations.length > 0 ? Math.min(...durations) : 0,
    parallelismFactor,
    successCount: results.filter((r) => !r.error).length,
    errorCount: results.filter((r) => r.error).length,
  };
}

/**
 * Generate unique IDs for integration tests
 */
export const IntegrationIds = {
  session: () => `sess_int_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
  agent: () => `agent_int_${Math.random().toString(36).slice(2, 10)}`,
  message: () => `msg_int_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
  context: () => `ctx_int_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
};

/**
 * Suppress console output during integration tests
 */
export function suppressConsoleForIntegration() {
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
 * Create test data generators for integration tests
 */
export const IntegrationMockData = {
  contextEntry: (sessionId: string, toolName = 'code-review', index = 0) => ({
    id: `entry_${index}_${Date.now()}`,
    sessionId,
    serverId: 'opencode-mcp' as const,
    toolName,
    timestamp: Date.now() + index,
    ttl: 3600,
    args: { files: `@src/file${index}.ts` },
    output: { success: true, data: `Result ${index}` },
    summary: `Test entry ${index}`,
    tags: ['test', `tag${index}`],
  }),

  message: (fromAgentId: string, toAgentId: string, sessionId: string, index = 0) => ({
    id: `msg_${index}_${Date.now()}`,
    fromAgentId,
    toAgentId,
    sessionId,
    type: 'chat' as const,
    priority: 'normal' as const,
    content: `Message ${index} from ${fromAgentId}`,
    timestamp: Date.now() + index,
    acknowledged: false,
  }),
};
