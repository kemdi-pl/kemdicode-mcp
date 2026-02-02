/**
 * Cluster Bus — Chaos Tests
 *
 * Tests for node failures, circuit breaker recovery, signal loss,
 * and cascading failure scenarios.
 *
 * Self-contained: uses real SignalFlowController (no Redis dependency).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  SignalFlowController,
  defaultLLMPolicy,
} from '../../../src/cluster-bus/signal-flow.js';
import type { ClusterSignal } from '../../../src/cluster-bus/types.js';

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Chaos: Node Failure Scenarios', () => {
  let flow: SignalFlowController;

  beforeEach(() => {
    flow = new SignalFlowController();
  });

  afterEach(() => {
    flow.reset();
  });

  // =========================================================================
  // 1. Circuit Breaker Full Lifecycle
  // =========================================================================

  describe('Circuit breaker full lifecycle', () => {
    it('should transition: closed → open → half-open → closed', () => {
      const signal = makeSignal({ type: 'llm:request', sourceCluster: 'node-a', targetCluster: 'node-b' });

      // Phase 1: closed — signals allowed
      expect(flow.evaluate(signal)).toBe('allow');

      // Phase 2: accumulate failures → trip to open
      for (let i = 0; i < 10; i++) {
        flow.recordFailure('llm:request', 'node-a', 'node-b');
      }
      expect(flow.evaluate(signal)).toBe('drop');

      // Phase 3: manually transition to half-open (simulates time passage)
      const key = 'llm:request:node-a:node-b';
      const state = (flow as any).channelStates.get(key);
      state.circuitState = 'half-open';
      state.halfOpenProbes = 0;

      // Phase 4: probe allowed in half-open
      expect(flow.evaluate(signal)).toBe('allow');

      // Phase 5: success → closed
      flow.recordSuccess('llm:request', 'node-a', 'node-b');
      expect(flow.evaluate(signal)).toBe('allow');
      expect((flow as any).channelStates.get(key).circuitState).toBe('closed');
    });

    it('should re-open circuit when half-open probes exhaust without success', () => {
      const signal = makeSignal({ type: 'llm:request', sourceCluster: 'a', targetCluster: 'b' });

      // Trip to open
      for (let i = 0; i < 10; i++) {
        flow.recordFailure('llm:request', 'a', 'b');
      }

      // Transition to half-open
      const key = 'llm:request:a:b';
      const state = (flow as any).channelStates.get(key);
      state.circuitState = 'half-open';
      state.halfOpenProbes = 0;

      // Exhaust probes (maxHalfOpenProbes = 2)
      expect(flow.evaluate(signal)).toBe('allow'); // probe 1
      expect(flow.evaluate(signal)).toBe('allow'); // probe 2
      // No success recorded — next probe should re-open
      expect(flow.evaluate(signal)).toBe('drop');
      expect(state.circuitState).toBe('open');
    });
  });

  // =========================================================================
  // 2. Multi-Channel Independent Circuit Breakers
  // =========================================================================

  describe('Independent circuit breakers per channel', () => {
    it('should isolate failures between channels', () => {
      const sigAB = makeSignal({ type: 'llm:request', sourceCluster: 'a', targetCluster: 'b' });
      const sigAC = makeSignal({ type: 'llm:request', sourceCluster: 'a', targetCluster: 'c' });

      // Trip circuit for a→b only
      for (let i = 0; i < 10; i++) {
        flow.recordFailure('llm:request', 'a', 'b');
      }

      expect(flow.evaluate(sigAB)).toBe('drop');
      expect(flow.evaluate(sigAC)).toBe('allow');
    });

    it('should isolate failures between signal types on same route', () => {
      const sigLLM = makeSignal({ type: 'llm:request', sourceCluster: 'a', targetCluster: 'b' });
      const sigData = makeSignal({ type: 'data:broadcast', sourceCluster: 'a', targetCluster: 'b' });

      // Trip circuit for llm:request only
      for (let i = 0; i < 10; i++) {
        flow.recordFailure('llm:request', 'a', 'b');
      }

      expect(flow.evaluate(sigLLM)).toBe('drop');
      expect(flow.evaluate(sigData)).toBe('allow');
    });
  });

  // =========================================================================
  // 3. Cascading Failure Simulation
  // =========================================================================

  describe('Cascading failure simulation', () => {
    it('should handle all routes to a target failing simultaneously', () => {
      const sources = ['node-1', 'node-2', 'node-3', 'node-4', 'node-5'];

      // Trip circuit breakers for all routes to target
      for (const src of sources) {
        for (let i = 0; i < 10; i++) {
          flow.recordFailure('llm:request', src, 'dead-node');
        }
      }

      // All routes blocked
      for (const src of sources) {
        const sig = makeSignal({ type: 'llm:request', sourceCluster: src, targetCluster: 'dead-node' });
        expect(flow.evaluate(sig)).toBe('drop');
      }

      // Alternative target still works
      for (const src of sources) {
        const sig = makeSignal({ type: 'llm:request', sourceCluster: src, targetCluster: 'alive-node' });
        expect(flow.evaluate(sig)).toBe('allow');
      }
    });

    it('should recover individual routes independently', () => {
      const sources = ['node-1', 'node-2'];

      // Trip both
      for (const src of sources) {
        for (let i = 0; i < 10; i++) {
          flow.recordFailure('llm:request', src, 'target');
        }
      }

      // Recover node-1 only
      const key1 = 'llm:request:node-1:target';
      const state1 = (flow as any).channelStates.get(key1);
      state1.circuitState = 'half-open';
      state1.halfOpenProbes = 0;

      const sig1 = makeSignal({ type: 'llm:request', sourceCluster: 'node-1', targetCluster: 'target' });
      expect(flow.evaluate(sig1)).toBe('allow');

      flow.recordSuccess('llm:request', 'node-1', 'target');

      // node-1 recovered, node-2 still blocked
      expect(flow.evaluate(sig1)).toBe('allow');
      const sig2 = makeSignal({ type: 'llm:request', sourceCluster: 'node-2', targetCluster: 'target' });
      expect(flow.evaluate(sig2)).toBe('drop');
    });
  });

  // =========================================================================
  // 4. Signal Loss Under Backpressure
  // =========================================================================

  describe('Signal loss under backpressure', () => {
    it('should track dropped signals accurately during sustained overload', () => {
      flow.addPolicy({
        signalTypes: ['llm:request'],
        allowedDirections: [],
        rateLimit: 5,
        maxQueueDepth: 10,
        minPriority: 0,
        bufferOnPressure: true,
      });

      let allowed = 0;
      let queued = 0;
      let dropped = 0;

      // Send 100 signals in a burst
      for (let i = 0; i < 100; i++) {
        const result = flow.evaluate(makeSignal({ type: 'llm:request' }));
        if (result === 'allow') allowed++;
        else if (result === 'queue') queued++;
        else dropped++;
      }

      expect(allowed).toBe(5);      // rate limit = 5
      expect(queued).toBe(10);       // maxQueueDepth = 10
      expect(dropped).toBe(85);      // rest dropped
      expect(allowed + queued + dropped).toBe(100);

      const stats = flow.getStats();
      expect(stats.totalProcessed).toBe(5);
      expect(stats.totalQueued).toBe(10);
      expect(stats.totalDropped).toBe(85);
    });

    it('should drop all signals when no buffering and rate exceeded', () => {
      flow.addPolicy({
        signalTypes: ['llm:request'],
        allowedDirections: [],
        rateLimit: 1,
        maxQueueDepth: 0,
        minPriority: 0,
        bufferOnPressure: false,
      });

      expect(flow.evaluate(makeSignal({ type: 'llm:request' }))).toBe('allow');

      for (let i = 0; i < 50; i++) {
        expect(flow.evaluate(makeSignal({ type: 'llm:request' }))).toBe('drop');
      }

      expect(flow.getStats().totalDropped).toBe(50);
    });
  });

  // =========================================================================
  // 5. Recovery After Total Failure
  // =========================================================================

  describe('Recovery after total failure', () => {
    it('should allow full recovery via reset', () => {
      // Create heavy failure state
      flow.addPolicy(defaultLLMPolicy());

      for (let i = 0; i < 10; i++) {
        flow.recordFailure('llm:request', 'src', 'tgt');
      }

      const sig = makeSignal({ type: 'llm:request', sourceCluster: 'src', targetCluster: 'tgt' });
      expect(flow.evaluate(sig)).toBe('drop');

      // Full reset
      flow.reset();

      // Re-add policy and verify clean state
      flow.addPolicy(defaultLLMPolicy());
      expect(flow.evaluate(sig)).toBe('allow');
      expect(flow.getStats().totalProcessed).toBe(1);
      expect(flow.getStats().totalDropped).toBe(0);
    });

    it('should clear all channel states on reset', () => {
      // Populate multiple channels
      for (const tgt of ['a', 'b', 'c', 'd', 'e']) {
        for (let i = 0; i < 10; i++) {
          flow.recordFailure('llm:request', 'src', tgt);
        }
      }

      expect((flow as any).channelStates.size).toBe(5);

      flow.reset();
      expect((flow as any).channelStates.size).toBe(0);
    });
  });

  // =========================================================================
  // 6. Failure Counter Boundary
  // =========================================================================

  describe('Failure counter boundaries', () => {
    it('should not trip at exactly threshold - 1', () => {
      for (let i = 0; i < 9; i++) {
        flow.recordFailure('llm:request', 'src', 'tgt');
      }

      const sig = makeSignal({ type: 'llm:request', sourceCluster: 'src', targetCluster: 'tgt' });
      expect(flow.evaluate(sig)).toBe('allow');
    });

    it('should trip at exactly threshold', () => {
      for (let i = 0; i < 10; i++) {
        flow.recordFailure('llm:request', 'src', 'tgt');
      }

      const sig = makeSignal({ type: 'llm:request', sourceCluster: 'src', targetCluster: 'tgt' });
      expect(flow.evaluate(sig)).toBe('drop');
    });

    it('should reset failure counter on success', () => {
      for (let i = 0; i < 8; i++) {
        flow.recordFailure('llm:request', 'src', 'tgt');
      }

      flow.recordSuccess('llm:request', 'src', 'tgt');

      // Need 10 more failures to trip again
      for (let i = 0; i < 9; i++) {
        flow.recordFailure('llm:request', 'src', 'tgt');
      }

      const sig = makeSignal({ type: 'llm:request', sourceCluster: 'src', targetCluster: 'tgt' });
      expect(flow.evaluate(sig)).toBe('allow');
    });

    it('should handle massive failure count without overflow', () => {
      for (let i = 0; i < 100000; i++) {
        flow.recordFailure('llm:request', 'src', 'tgt');
      }

      const key = 'llm:request:src:tgt';
      const state = (flow as any).channelStates.get(key);
      expect(state.consecutiveFailures).toBe(100000);
      expect(state.circuitState).toBe('open');
    });
  });
});
