/**
 * KemdiCode MCP Server - Async Utilities & Resilience Patterns
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
 * Async Utilities & Resilience Patterns
 *
 * Features:
 * - Circuit breaker with configurable thresholds
 * - Retry with exponential backoff
 * - Bulkhead pattern for isolation
 * - Rate limiter
 * - Debounce/throttle utilities
 *
 * @module utils/async
 */

export interface CircuitBreakerConfig {
  failureThreshold: number;
  successThreshold: number;
  timeout: number;
  volumeThreshold: number;
}

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerStats {
  state: CircuitState;
  failures: number;
  successes: number;
  requests: number;
  lastFailure?: number;
  lastSuccess?: number;
}

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failures = 0;
  private successes = 0;
  private requests: Array<{ timestamp: number; success: boolean }> = [];
  private lastFailure = 0;
  private lastSuccess = 0;
  private timeoutTimer: NodeJS.Timeout | null = null;
  private config: Required<CircuitBreakerConfig>;

  constructor(config: Partial<CircuitBreakerConfig> = {}) {
    this.config = {
      failureThreshold: config.failureThreshold ?? 5,
      successThreshold: config.successThreshold ?? 2,
      timeout: config.timeout ?? 30000,
      volumeThreshold: config.volumeThreshold ?? 10,
    };
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      if (Date.now() - this.lastFailure >= this.config.timeout) {
        this.state = 'half-open';
      } else {
        throw new Error('Circuit breaker is open');
      }
    }

    const start = Date.now();
    try {
      const result = await fn();
      this.recordSuccess(start);
      return result;
    } catch (error) {
      this.recordFailure(start);
      throw error;
    }
  }

  private recordSuccess(start: number): void {
    this.successes++;
    this.lastSuccess = Date.now();
    this.requests.push({ timestamp: start, success: true });

    if (this.state === 'half-open') {
      if (this.successes >= this.config.successThreshold) {
        this.state = 'closed';
        this.failures = 0;
        this.successes = 0;
      }
    }

    this.cleanup();
  }

  private recordFailure(start: number): void {
    this.failures++;
    this.lastFailure = Date.now();
    this.requests.push({ timestamp: start, success: false });

    if (this.state === 'half-open') {
      this.state = 'open';
    } else if (this.state === 'closed') {
      if (this.failures >= this.config.failureThreshold) {
        this.state = 'open';
      }
    }

    this.cleanup();
  }

  private cleanup(): void {
    const now = Date.now();
    this.requests = this.requests.filter((r) => now - r.timestamp < 60000);
  }

  getStats(): CircuitBreakerStats {
    const recentFailures = this.requests.filter((r) => !r.success).length;
    return {
      state: this.state,
      failures: recentFailures,
      successes: this.successes,
      requests: this.requests.length,
      lastFailure: this.lastFailure || undefined,
      lastSuccess: this.lastSuccess || undefined,
    };
  }

  reset(): void {
    this.state = 'closed';
    this.failures = 0;
    this.successes = 0;
    this.requests = [];
    this.lastFailure = 0;
    this.lastSuccess = 0;
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
  }
}

export interface RetryConfig {
  maxAttempts: number;
  baseDelay: number;
  maxDelay: number;
  backoffMultiplier: number;
  jitter: boolean;
  retryOn: Array<number | string>;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  config?: Partial<RetryConfig>
): Promise<T> {
  const cfg: Required<RetryConfig> = {
    maxAttempts: config?.maxAttempts ?? 3,
    baseDelay: config?.baseDelay ?? 1000,
    maxDelay: config?.maxDelay ?? 30000,
    backoffMultiplier: config?.backoffMultiplier ?? 2,
    jitter: config?.jitter ?? true,
    retryOn: config?.retryOn ?? ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND'],
  };

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= cfg.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;

      const shouldRetry = cfg.retryOn.some((code) => {
        if (typeof code === 'number') {
          const err = error as { code?: string | number };
          return err.code === code;
        }
        return (error as Error).message.includes(code);
      });

      if (!shouldRetry || attempt >= cfg.maxAttempts) {
        throw lastError;
      }

      const delay = Math.min(
        cfg.baseDelay * Math.pow(cfg.backoffMultiplier, attempt - 1),
        cfg.maxDelay
      );

      const jitteredDelay = cfg.jitter ? delay * (0.5 + Math.random() * 0.5) : delay;

      await new Promise((resolve) => setTimeout(resolve, jitteredDelay));
    }
  }

  throw lastError;
}

export interface BulkheadConfig {
  maxConcurrent: number;
  maxQueue: number;
  timeout: number;
}

export interface BulkheadStats {
  available: number;
  queued: number;
  executed: number;
  rejected: number;
  timedOut: number;
}

export class Bulkhead {
  private available = 0;
  private queue: Array<{
    fn: () => Promise<unknown>;
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    queuedAt: number;
  }> = [];
  private stats = {
    executed: 0,
    rejected: 0,
    timedOut: 0,
  };
  private config: Required<BulkheadConfig>;
  private timer: NodeJS.Timeout | null = null;

  constructor(config: Partial<BulkheadConfig> = {}) {
    this.config = {
      maxConcurrent: config.maxConcurrent ?? 10,
      maxQueue: config.maxQueue ?? 100,
      timeout: config.timeout ?? 30000,
    };
    this.available = this.config.maxConcurrent;
    this.startQueueProcessor();
  }

  private startQueueProcessor(): void {
    this.timer = setInterval(() => this.processQueue(), 100);
  }

  private processQueue(): void {
    while (this.available > 0 && this.queue.length > 0) {
      const item = this.queue.shift();
      if (!item) break;

      const waited = Date.now() - item.queuedAt;
      if (waited > this.config.timeout) {
        this.stats.timedOut++;
        item.reject(new Error('Bulkhead queue timeout'));
        continue;
      }

      this.execute(item.fn).then(item.resolve).catch(item.reject);
    }
  }

  private async execute<T>(fn: () => Promise<T>): Promise<T> {
    this.available--;
    this.stats.executed++;
    try {
      return await fn();
    } finally {
      this.available++;
      this.processQueue();
    }
  }

  async acquire<T>(fn: () => Promise<T>): Promise<T> {
    if (this.queue.length >= this.config.maxQueue) {
      this.stats.rejected++;
      throw new Error('Bulkhead queue is full');
    }

    if (this.available > 0) {
      return this.execute(fn);
    }

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const idx = this.queue.findIndex((q) => q.fn === fn);
        if (idx > -1) {
          this.queue.splice(idx, 1);
        }
        this.stats.timedOut++;
        reject(new Error('Bulkhead timeout'));
      }, this.config.timeout);

      this.queue.push({
        fn: fn as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject: (e: Error) => {
          clearTimeout(timeout);
          reject(e);
        },
        queuedAt: Date.now(),
      });
    });
  }

  getStats(): BulkheadStats {
    return {
      available: this.available,
      queued: this.queue.length,
      executed: this.stats.executed,
      rejected: this.stats.rejected,
      timedOut: this.stats.timedOut,
    };
  }

  destroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const item of this.queue) {
      item.reject(new Error('Bulkhead destroyed'));
    }
    this.queue = [];
  }
}

export function debounce<T extends (...args: unknown[]) => unknown>(
  fn: T,
  delay: number
): (...args: Parameters<T>) => void {
  let timer: NodeJS.Timeout | null = null;
  return (...args: Parameters<T>) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

export function throttle<T extends (...args: unknown[]) => unknown>(
  fn: T,
  limit: number
): (...args: Parameters<T>) => void {
  let inThrottle = false;
  return (...args: Parameters<T>) => {
    if (!inThrottle) {
      fn(...args);
      inThrottle = true;
      setTimeout(() => (inThrottle = false), limit);
    }
  };
}

export interface RateLimiterConfig {
  windowMs: number;
  maxRequests: number;
}

export class RateLimiter {
  private windowStart = 0;
  private requests: number[] = [];
  private config: Required<RateLimiterConfig>;

  constructor(config: Partial<RateLimiterConfig> = {}) {
    this.config = {
      windowMs: config.windowMs ?? 60000,
      maxRequests: config.maxRequests ?? 100,
    };
  }

  tryAcquire(): boolean {
    const now = Date.now();

    if (now - this.windowStart >= this.config.windowMs) {
      this.windowStart = now;
      this.requests = [];
    }

    if (this.requests.length >= this.config.maxRequests) {
      return false;
    }

    this.requests.push(now);
    return true;
  }

  getRemaining(): number {
    const now = Date.now();
    if (now - this.windowStart >= this.config.windowMs) {
      return this.config.maxRequests;
    }
    return Math.max(0, this.config.maxRequests - this.requests.length);
  }

  getResetTime(): number {
    const now = Date.now();
    const remaining = this.config.windowMs - (now - this.windowStart);
    return Math.max(0, remaining);
  }

  reset(): void {
    this.windowStart = 0;
    this.requests = [];
  }
}

export function batchAsync<T, R>(
  items: T[],
  batchSize: number,
  processor: (batch: T[]) => Promise<R[]>
): Promise<R[]> {
  const results: R[] = [];
  const batches: T[][] = [];

  for (let i = 0; i < items.length; i += batchSize) {
    batches.push(items.slice(i, i + batchSize));
  }

  return Promise.all(
    batches.map(async (batch) => {
      const batchResults = await processor(batch);
      results.push(...batchResults);
    })
  ).then(() => results);
}

export const defaultCircuitBreaker = new CircuitBreaker();
export const defaultBulkhead = new Bulkhead();
export const defaultRateLimiter = new RateLimiter();
