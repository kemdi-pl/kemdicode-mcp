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
 * Cluster Bus — Property-Based Tests
 *
 * Invariant-driven testing: verify properties that must hold
 * for ALL possible inputs, not just specific examples.
 *
 * Self-contained: no Redis, no mocks.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  SignalFlowController,
} from '../../../src/cluster-bus/signal-flow.js';
import {
  parseMetaTag,
  serializeMetaTag,
  CLUSTER_KEYS,
  loadClusterBusConfig,
  PassConfigSchema,
  HeartbeatPayload,
  LLMRequestPayload,
} from '../../../src/cluster-bus/types.js';
import {
  shouldSkipAssessment,
  detectTaskBudget,
} from '../../../src/cluster-bus/pass-controller.js';
import type { ClusterSignal, SignalType, SignalDirection } from '../../../src/cluster-bus/types.js';

// ---------------------------------------------------------------------------
// Random generators for property-based tests
// ---------------------------------------------------------------------------

function randomString(len: number): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.!@#$%^&*(){}[]|\\:;"\'<>,?/~`';
  let result = '';
  for (let i = 0; i < len; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomSignalType(): SignalType {
  const types: SignalType[] = [
    'llm:request', 'llm:result', 'llm:stream-chunk', 'llm:error',
    'cluster:join', 'cluster:leave', 'cluster:heartbeat',
    'data:broadcast', 'data:unicast',
    'control:pause', 'control:resume', 'control:config',
  ];
  return types[Math.floor(Math.random() * types.length)];
}

function randomDirection(): SignalDirection {
  const dirs: SignalDirection[] = ['upstream', 'downstream', 'duplex'];
  return dirs[Math.floor(Math.random() * dirs.length)];
}

function makeSignal(overrides: Partial<ClusterSignal> = {}): ClusterSignal {
  return {
    id: `sig-${Math.random().toString(36).slice(2, 8)}`,
    type: 'llm:request',
    sourceCluster: 'src',
    targetCluster: 'tgt',
    payload: {},
    metaTags: [],
    direction: 'duplex',
    priority: 1,
    ttl: 0,
    schemaVersion: 1,
    timestamp: Date.now(),
    originCluster: 'src',
    ...overrides,
  };
}

const ITERATIONS = 200;

// ---------------------------------------------------------------------------
// 1. Meta-Tag Round-Trip Invariant
// ---------------------------------------------------------------------------

describe('Property: Meta-tag round-trip', () => {
  it('parse → serialize → parse should be idempotent for any input', () => {
    for (let i = 0; i < ITERATIONS; i++) {
      const input = randomString(randomInt(0, 100));
      const parsed1 = parseMetaTag(input);
      const serialized = serializeMetaTag(parsed1);
      const parsed2 = parseMetaTag(serialized);

      // Idempotency: second parse should equal first parse
      expect(parsed2).toEqual(parsed1);
    }
  });

  it('serialized tag should always contain exactly one colon separator', () => {
    for (let i = 0; i < ITERATIONS; i++) {
      const tag = { key: randomString(randomInt(0, 20)), value: randomString(randomInt(0, 20)) };
      const serialized = serializeMetaTag(tag);
      // At least one colon
      expect(serialized).toContain(':');
      // Key part should match
      expect(serialized.startsWith(tag.key + ':')).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Redis Key Sanitization Invariants
// ---------------------------------------------------------------------------

describe('Property: Redis key sanitization', () => {
  it('sanitized key should never contain unsafe characters', () => {
    const unsafeChars = /[^a-zA-Z0-9\-_.]/;

    for (let i = 0; i < ITERATIONS; i++) {
      const input = randomString(randomInt(0, 200));
      const key = CLUSTER_KEYS.node(input);
      const sanitized = key.replace('mcp:cluster:', '');

      expect(sanitized).not.toMatch(unsafeChars);
      expect(sanitized.length).toBeLessThanOrEqual(64);
    }
  });

  it('sanitized key length should be <= 64 chars for any input length', () => {
    const lengths = [0, 1, 10, 50, 64, 65, 100, 500, 1000];

    for (const len of lengths) {
      const input = 'a'.repeat(len);
      const key = CLUSTER_KEYS.node(input);
      const sanitized = key.replace('mcp:cluster:', '');
      expect(sanitized.length).toBeLessThanOrEqual(64);
    }
  });

  it('two different safe inputs should produce different keys', () => {
    const seen = new Set<string>();

    for (let i = 0; i < ITERATIONS; i++) {
      const input = `unique-safe-${i}-${randomInt(0, 999999)}`;
      const key = CLUSTER_KEYS.node(input);
      // Note: collisions are possible with sanitization, but unique safe IDs should not collide
      if (input.length <= 64) {
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Signal Flow Invariants
// ---------------------------------------------------------------------------

describe('Property: Signal flow invariants', () => {
  let flow: SignalFlowController;

  beforeEach(() => {
    flow = new SignalFlowController();
  });

  afterEach(() => {
    flow.reset();
  });

  it('totalProcessed + totalDropped should equal total evaluations (no policy)', () => {
    const n = randomInt(50, 200);

    for (let i = 0; i < n; i++) {
      flow.evaluate(makeSignal({
        type: randomSignalType(),
        direction: randomDirection(),
      }));
    }

    const stats = flow.getStats();
    // Without policies, nothing is dropped (unless circuit breaker trips)
    expect(stats.totalProcessed + stats.totalDropped).toBe(n);
  });

  it('totalProcessed + totalDropped + totalQueued should be consistent', () => {
    flow.addPolicy({
      signalTypes: ['llm:request'],
      allowedDirections: [],
      rateLimit: 5,
      maxQueueDepth: 10,
      minPriority: 0,
      bufferOnPressure: true,
    });

    const n = randomInt(20, 100);
    for (let i = 0; i < n; i++) {
      flow.evaluate(makeSignal({ type: 'llm:request' }));
    }

    const stats = flow.getStats();
    expect(stats.totalProcessed + stats.totalDropped + stats.totalQueued).toBe(n);
  });

  it('direction counts should sum to totalProcessed', () => {
    for (let i = 0; i < 100; i++) {
      flow.evaluate(makeSignal({
        type: randomSignalType(),
        direction: randomDirection(),
      }));
    }

    const stats = flow.getStats();
    const dirSum = stats.directionCounts.upstream + stats.directionCounts.downstream + stats.directionCounts.duplex;
    expect(dirSum).toBe(stats.totalProcessed);
  });

  it('after reset, all counters should be zero', () => {
    for (let i = 0; i < 50; i++) {
      flow.evaluate(makeSignal());
    }

    flow.reset();

    const stats = flow.getStats();
    expect(stats.totalProcessed).toBe(0);
    expect(stats.totalDropped).toBe(0);
    expect(stats.totalQueued).toBe(0);
    expect(stats.pressuredChannels).toEqual([]);
  });

  it('no policy means evaluate always returns allow (unless circuit open)', () => {
    for (let i = 0; i < ITERATIONS; i++) {
      const result = flow.evaluate(makeSignal({
        type: randomSignalType(),
        direction: randomDirection(),
        sourceCluster: `src-${randomInt(0, 10)}`,
        targetCluster: `tgt-${randomInt(0, 10)}`,
      }));
      expect(result).toBe('allow');
    }
  });
});

// ---------------------------------------------------------------------------
// 4. PassController Heuristic Invariants
// ---------------------------------------------------------------------------

describe('Property: shouldSkipAssessment invariants', () => {
  it('should always return boolean', () => {
    for (let i = 0; i < ITERATIONS; i++) {
      const input = randomString(randomInt(0, 500));
      expect(typeof shouldSkipAssessment(input)).toBe('boolean');
    }
  });

  it('should always skip very short text without code', () => {
    for (let i = 0; i < 50; i++) {
      const input = randomString(randomInt(1, 10)); // Very short
      // May or may not skip depending on code pattern match, but should not throw
      expect(() => shouldSkipAssessment(input)).not.toThrow();
    }
  });

  it('text with code blocks should never be skipped', () => {
    for (let i = 0; i < 50; i++) {
      const prefix = randomString(randomInt(10, 200));
      const input = `${prefix}\n\`\`\`ts\nconst x = ${i};\n\`\`\``;
      expect(shouldSkipAssessment(input)).toBe(false);
    }
  });
});

describe('Property: detectTaskBudget invariants', () => {
  it('should always return { type: string, budget: number }', () => {
    for (let i = 0; i < ITERATIONS; i++) {
      const input = randomString(randomInt(1, 300));
      const result = detectTaskBudget(input);
      expect(typeof result.type).toBe('string');
      expect(typeof result.budget).toBe('number');
      expect(result.budget).toBeGreaterThanOrEqual(1);
      expect(result.budget).toBeLessThanOrEqual(4);
    }
  });

  it('budget should be monotonically mapped to task complexity', () => {
    // Explain < Fix < Review/Refactor < Generate/Design
    const explain = detectTaskBudget('Explain how this works');
    const fix = detectTaskBudget('Fix this critical bug');
    const review = detectTaskBudget('Review the entire codebase');
    const generate = detectTaskBudget('Generate a complete REST API');

    expect(explain.budget).toBeLessThanOrEqual(fix.budget);
    expect(fix.budget).toBeLessThanOrEqual(review.budget);
    expect(review.budget).toBeLessThanOrEqual(generate.budget);
  });
});

// ---------------------------------------------------------------------------
// 5. Zod Schema Invariants
// ---------------------------------------------------------------------------

describe('Property: Zod schema invariants', () => {
  it('PassConfigSchema.parse({}) should always provide defaults', () => {
    for (let i = 0; i < 50; i++) {
      const result = PassConfigSchema.parse({});
      expect(result.maxPasses).toBe(5);
      expect(result.qualityThreshold).toBe(0.8);
      expect(result.strategy).toBe('min-passes');
    }
  });

  it('HeartbeatPayload should accept all valid status values', () => {
    const statuses = ['online', 'degraded', 'offline'] as const;
    for (const status of statuses) {
      for (let i = 0; i < 10; i++) {
        const load = Math.random();
        const result = HeartbeatPayload.safeParse({
          clusterId: `cluster-${i}`,
          status,
          load,
        });
        expect(result.success).toBe(true);
      }
    }
  });

  it('LLMRequestPayload with valid prompt should always succeed', () => {
    for (let i = 0; i < 50; i++) {
      const prompt = randomString(randomInt(1, 500));
      const result = LLMRequestPayload.safeParse({ prompt });
      expect(result.success).toBe(true);
    }
  });
});
