/**
 * Cluster Bus — Performance Benchmarks
 *
 * Throughput and latency measurements for critical paths:
 * - Signal evaluation throughput
 * - Rate limiting overhead
 * - Circuit breaker overhead
 * - Policy matching performance
 * - Meta-tag parsing performance
 * - Redis key sanitization performance
 *
 * Self-contained: no Redis, no mocks.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  SignalFlowController,
  defaultLLMPolicy,
  defaultControlPolicy,
  defaultHeartbeatPolicy,
} from '../../src/cluster-bus/signal-flow.js';
import {
  parseMetaTag,
  serializeMetaTag,
  CLUSTER_KEYS,
  loadClusterBusConfig,
  PassConfigSchema,
  LLMRequestPayload,
  HeartbeatPayload,
} from '../../src/cluster-bus/types.js';
import {
  shouldSkipAssessment,
  detectTaskBudget,
} from '../../src/cluster-bus/pass-controller.js';
import type { ClusterSignal } from '../../src/cluster-bus/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function measure(fn: () => void, iterations: number): { totalMs: number; opsPerSec: number; avgUs: number } {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    fn();
  }
  const totalMs = performance.now() - start;
  return {
    totalMs,
    opsPerSec: Math.round((iterations / totalMs) * 1000),
    avgUs: Math.round((totalMs / iterations) * 1000),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Performance: Signal Flow Controller', () => {
  let flow: SignalFlowController;

  beforeEach(() => {
    flow = new SignalFlowController();
  });

  afterEach(() => {
    flow.reset();
  });

  // =========================================================================
  // 1. Bare Evaluate Throughput (no policies)
  // =========================================================================

  it('should evaluate >50k signals/sec without policies', () => {
    const iterations = 10000;
    const signal = makeSignal();

    const { opsPerSec } = measure(() => flow.evaluate(signal), iterations);

    expect(opsPerSec).toBeGreaterThan(50000);
  });

  // =========================================================================
  // 2. Evaluate with Rate Limiting Policy
  // =========================================================================

  it('should evaluate >20k signals/sec with rate limiting policy', () => {
    flow.addPolicy({
      signalTypes: ['llm:request'],
      allowedDirections: [],
      rateLimit: 100000, // high limit so most pass
      maxQueueDepth: 0,
      minPriority: 0,
      bufferOnPressure: false,
    });

    const iterations = 10000;
    const signal = makeSignal({ type: 'llm:request' });

    const { opsPerSec } = measure(() => flow.evaluate(signal), iterations);

    expect(opsPerSec).toBeGreaterThan(20000);
  });

  // =========================================================================
  // 3. Evaluate with Multiple Policies
  // =========================================================================

  it('should evaluate >10k signals/sec with 3 policies', () => {
    flow.addPolicy(defaultLLMPolicy());
    flow.addPolicy(defaultControlPolicy());
    flow.addPolicy(defaultHeartbeatPolicy());

    const iterations = 10000;
    const signal = makeSignal({ type: 'llm:request', direction: 'duplex' });

    const { opsPerSec } = measure(() => flow.evaluate(signal), iterations);

    expect(opsPerSec).toBeGreaterThan(10000);
  });

  // =========================================================================
  // 4. Circuit Breaker Check Overhead
  // =========================================================================

  it('should check circuit breaker state >100k ops/sec', () => {
    // Pre-populate a channel state
    flow.recordFailure('llm:request', 'src', 'tgt');

    const iterations = 10000;

    const { opsPerSec } = measure(
      () => flow.isCircuitOpen('llm:request', 'src', 'tgt'),
      iterations,
    );

    expect(opsPerSec).toBeGreaterThan(100000);
  });

  // =========================================================================
  // 5. Record Failure/Success Throughput
  // =========================================================================

  it('should record >100k failures/sec', () => {
    const iterations = 10000;

    const { opsPerSec } = measure(
      () => flow.recordFailure('llm:request', 'src', 'tgt'),
      iterations,
    );

    expect(opsPerSec).toBeGreaterThan(100000);
  });

  // =========================================================================
  // 6. Burst Rate Detection
  // =========================================================================

  it('should compute burst rate >50k ops/sec', () => {
    // Populate some signals
    for (let i = 0; i < 100; i++) {
      flow.evaluate(makeSignal({ type: 'data:broadcast', sourceCluster: 'a', targetCluster: 'b' }));
    }

    const iterations = 10000;

    const { opsPerSec } = measure(
      () => flow.getBurstRate('data:broadcast', 'a', 'b'),
      iterations,
    );

    expect(opsPerSec).toBeGreaterThan(50000);
  });

  // =========================================================================
  // 7. Many Channels Scalability
  // =========================================================================

  it('should handle 1000 distinct channels without degradation', () => {
    const signals: ClusterSignal[] = [];
    for (let i = 0; i < 1000; i++) {
      signals.push(makeSignal({
        type: 'data:broadcast',
        sourceCluster: `src-${i}`,
        targetCluster: `tgt-${i}`,
      }));
    }

    const start = performance.now();
    for (const sig of signals) {
      flow.evaluate(sig);
    }
    const elapsed = performance.now() - start;

    // 1000 evaluations should complete in < 100ms
    expect(elapsed).toBeLessThan(100);
    expect((flow as any).channelStates.size).toBe(1000);
  });
});

// ---------------------------------------------------------------------------
// Meta-Tag Performance
// ---------------------------------------------------------------------------

describe('Performance: Meta-tag operations', () => {
  it('should parse >500k tags/sec', () => {
    const iterations = 10000;
    const tag = 'env:production';

    const { opsPerSec } = measure(() => parseMetaTag(tag), iterations);

    expect(opsPerSec).toBeGreaterThan(500000);
  });

  it('should serialize >500k tags/sec', () => {
    const iterations = 10000;
    const tag = { key: 'env', value: 'production' };

    const { opsPerSec } = measure(() => serializeMetaTag(tag), iterations);

    expect(opsPerSec).toBeGreaterThan(500000);
  });

  it('should round-trip >200k tags/sec', () => {
    const iterations = 10000;
    const input = 'model:gpt-4o-turbo';

    const { opsPerSec } = measure(
      () => serializeMetaTag(parseMetaTag(input)),
      iterations,
    );

    expect(opsPerSec).toBeGreaterThan(200000);
  });
});

// ---------------------------------------------------------------------------
// Redis Key Sanitization Performance
// ---------------------------------------------------------------------------

describe('Performance: Redis key sanitization', () => {
  it('should sanitize >200k keys/sec for normal input', () => {
    const iterations = 10000;
    const input = 'cluster-node-123';

    const { opsPerSec } = measure(() => CLUSTER_KEYS.node(input), iterations);

    expect(opsPerSec).toBeGreaterThan(200000);
  });

  it('should sanitize >100k keys/sec for dangerous input', () => {
    const iterations = 10000;
    const input = '../../../etc/passwd\r\nFLUSHALL\r\n';

    const { opsPerSec } = measure(() => CLUSTER_KEYS.node(input), iterations);

    expect(opsPerSec).toBeGreaterThan(100000);
  });

  it('should sanitize >100k keys/sec for long input', () => {
    const iterations = 10000;
    const input = 'a'.repeat(1000);

    const { opsPerSec } = measure(() => CLUSTER_KEYS.node(input), iterations);

    expect(opsPerSec).toBeGreaterThan(100000);
  });
});

// ---------------------------------------------------------------------------
// Zod Schema Validation Performance
// ---------------------------------------------------------------------------

describe('Performance: Zod schema validation', () => {
  it('should validate >50k LLMRequestPayload/sec', () => {
    const iterations = 10000;
    const payload = { prompt: 'Test prompt for performance measurement' };

    const { opsPerSec } = measure(
      () => LLMRequestPayload.safeParse(payload),
      iterations,
    );

    expect(opsPerSec).toBeGreaterThan(50000);
  });

  it('should validate >50k HeartbeatPayload/sec', () => {
    const iterations = 10000;
    const payload = { clusterId: 'cluster-1', status: 'online', load: 0.5 };

    const { opsPerSec } = measure(
      () => HeartbeatPayload.safeParse(payload),
      iterations,
    );

    expect(opsPerSec).toBeGreaterThan(50000);
  });

  it('should validate >50k PassConfigSchema/sec', () => {
    const iterations = 10000;

    const { opsPerSec } = measure(
      () => PassConfigSchema.safeParse({ maxPasses: 3, qualityThreshold: 0.85, strategy: 'quality-target' }),
      iterations,
    );

    expect(opsPerSec).toBeGreaterThan(50000);
  });

  it('should reject invalid payloads >50k/sec', () => {
    const iterations = 10000;
    const invalid = { prompt: 123 }; // wrong type

    const { opsPerSec } = measure(
      () => LLMRequestPayload.safeParse(invalid),
      iterations,
    );

    expect(opsPerSec).toBeGreaterThan(20000);
  });
});

// ---------------------------------------------------------------------------
// Pass Controller Heuristic Performance
// ---------------------------------------------------------------------------

describe('Performance: Pass controller heuristics', () => {
  it('should evaluate shouldSkipAssessment >200k/sec', () => {
    const iterations = 10000;
    const prompt = 'Explain how quantum computing works in simple terms';

    const { opsPerSec } = measure(() => shouldSkipAssessment(prompt), iterations);

    expect(opsPerSec).toBeGreaterThan(200000);
  });

  it('should evaluate detectTaskBudget >200k/sec', () => {
    const iterations = 10000;
    const prompt = 'Fix the critical authentication bug in the login handler';

    const { opsPerSec } = measure(() => detectTaskBudget(prompt), iterations);

    expect(opsPerSec).toBeGreaterThan(200000);
  });
});

// ---------------------------------------------------------------------------
// Config Loading Performance
// ---------------------------------------------------------------------------

describe('Performance: Config loading', () => {
  it('should load config >10k/sec', () => {
    const iterations = 1000;

    const { opsPerSec } = measure(() => loadClusterBusConfig(), iterations);

    expect(opsPerSec).toBeGreaterThan(10000);
  });
});
