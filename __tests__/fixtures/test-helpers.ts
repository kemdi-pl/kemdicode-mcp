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
 * Test Helpers for KemdiCode MCP Unit Tests
 *
 * Provides utility functions, assertions, and setup/teardown helpers
 * for consistent test patterns across the test suite.
 */

import { vi, expect } from 'vitest';

/**
 * Wait for a specified duration
 *
 * @param ms - Milliseconds to wait
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait for a condition to be true
 *
 * @param condition - Function that returns boolean or Promise<boolean>
 * @param options - Wait options
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  options: { timeout?: number; interval?: number } = {}
): Promise<void> {
  const { timeout = 5000, interval = 50 } = options;
  const start = Date.now();

  while (Date.now() - start < timeout) {
    if (await condition()) {
      return;
    }
    await sleep(interval);
  }

  throw new Error(`waitFor timed out after ${timeout}ms`);
}

/**
 * Create a mock logger that captures log calls
 */
export function createMockLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    redisOperation: vi.fn(),
    sessionEvent: vi.fn(),
    toolExecution: vi.fn(),
  };
}

/**
 * Assert that a value matches the agent ID pattern
 */
export function expectAgentId(value: unknown): void {
  expect(value).toMatch(/^agent_[a-f0-9]{8}$/);
}

/**
 * Assert that a value matches the session ID pattern
 */
export function expectSessionId(value: unknown): void {
  expect(value).toMatch(/^sess_[a-f0-9]{16}$/);
}

/**
 * Assert that a value matches the message ID pattern
 */
export function expectMessageId(value: unknown): void {
  expect(value).toMatch(/^msg_[a-f0-9]{12}$/);
}

/**
 * Assert that a timestamp is recent (within threshold)
 */
export function expectRecentTimestamp(timestamp: number, thresholdMs = 1000): void {
  const now = Date.now();
  expect(timestamp).toBeGreaterThan(now - thresholdMs);
  expect(timestamp).toBeLessThanOrEqual(now);
}

/**
 * Generate a unique test ID
 */
export function uniqueId(prefix = 'test'): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
}

/**
 * Create a temporary test directory path
 */
export function tempTestPath(name = 'test'): string {
  return `/tmp/opencode-mcp-test/${uniqueId(name)}`;
}

/**
 * Suppress console output during test execution
 */
export function suppressConsole() {
  const originalConsole = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  };

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
 * Create a spy on a module's exports
 */
export function spyOnModule<T extends object>(module: T, methodName: keyof T) {
  const original = module[methodName];
  const spy = vi.fn(original as unknown as (...args: unknown[]) => unknown);
  module[methodName] = spy as T[keyof T];

  return {
    spy,
    restore: () => {
      module[methodName] = original;
    },
  };
}

/**
 * Assert parallel execution happened within time bounds
 *
 * @param executionTimeMs - Actual execution time
 * @param itemCount - Number of items processed
 * @param perItemEstimateMs - Estimated time per item if sequential
 */
export function assertParallelExecution(
  executionTimeMs: number,
  itemCount: number,
  perItemEstimateMs: number
): void {
  const sequentialEstimate = itemCount * perItemEstimateMs;
  // Parallel should be significantly faster than sequential
  expect(executionTimeMs).toBeLessThan(sequentialEstimate * 0.7);
}

/**
 * Create a deferred promise for async testing
 */
export function createDeferred<T = void>() {
  let resolve: (value: T) => void = () => {};
  let reject: (error: Error) => void = () => {};

  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

/**
 * Retry an async function until it succeeds or max attempts reached
 */
export async function retry<T>(
  fn: () => Promise<T>,
  options: { maxAttempts?: number; delay?: number } = {}
): Promise<T> {
  const { maxAttempts = 3, delay = 100 } = options;
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < maxAttempts) {
        await sleep(delay * attempt);
      }
    }
  }

  throw lastError || new Error('Retry failed');
}

/**
 * Measure execution time of an async function
 */
export async function measureTime<T>(fn: () => Promise<T>): Promise<{ result: T; durationMs: number }> {
  const start = Date.now();
  const result = await fn();
  const durationMs = Date.now() - start;
  return { result, durationMs };
}

/**
 * Test data constants
 */
export const TestConstants = {
  VALID_ROLES: ['supervisor', 'worker', 'specialist', 'coordinator'] as const,
  VALID_STATUSES: ['active', 'idle', 'processing', 'terminated'] as const,
  VALID_MESSAGE_TYPES: ['chat', 'alert', 'directive', 'context', 'query', 'response', 'status', 'system'] as const,
  VALID_PRIORITIES: ['low', 'normal', 'high', 'critical'] as const,
  VALID_PROJECT_TYPES: ['node', 'php', 'python', 'rust', 'go', 'ruby', 'java', 'dotnet', 'unknown'] as const,

  // TTL values (seconds)
  TTL: {
    SESSION: 7200,
    DEFAULT: 3600,
    HEARTBEAT: 60,
  },

  // Redis key prefixes
  REDIS_KEYS: {
    PREFIX: 'mcp:',
    AGENTS: 'agents:',
    CONTEXT: 'context:',
    SESSION: 'session:',
  },
} as const;
