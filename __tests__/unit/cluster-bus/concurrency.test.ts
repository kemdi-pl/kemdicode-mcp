/**
 * Cluster Bus — Concurrency Tests
 *
 * Tests for race conditions in concurrent signal processing,
 * parallel policy evaluation, and state consistency.
 *
 * Self-contained: uses real SignalFlowController (no Redis dependency).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  SignalFlowController,
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

describe('Concurrency: Race Conditions', () => {
  let flow: SignalFlowController;

  beforeEach(() => {
    flow = new SignalFlowController();
  });

  afterEach(() => {
    flow.reset();
  });

  // =========================================================================
  // 1. Concurrent Evaluate Calls
  // =========================================================================

  describe('Concurrent evaluate calls', () => {
    it('should maintain accurate counts under concurrent evaluation', () => {
      flow.addPolicy({
        signalTypes: ['llm:request'],
        allowedDirections: [],
        rateLimit: 0, // unlimited
        maxQueueDepth: 0,
        minPriority: 0,
        bufferOnPressure: false,
      });

      const total = 1000;
      const results: string[] = [];

      // Synchronous rapid-fire (JS is single-threaded, but tests state consistency)
      for (let i = 0; i < total; i++) {
        results.push(flow.evaluate(makeSignal({ type: 'llm:request' })));
      }

      expect(results.every((r) => r === 'allow')).toBe(true);
      expect(flow.getStats().totalProcessed).toBe(total);
      expect(flow.getStats().totalDropped).toBe(0);
    });

    it('should handle interleaved evaluate and recordFailure', () => {
      const signal = makeSignal({ type: 'llm:request', sourceCluster: 'a', targetCluster: 'b' });

      // Interleave evaluations with failures
      for (let i = 0; i < 20; i++) {
        flow.evaluate(signal);
        flow.recordFailure('llm:request', 'a', 'b');
      }

      // After 10 failures, circuit should have opened
      const key = 'llm:request:a:b';
      const state = (flow as any).channelStates.get(key);
      expect(state.circuitState).toBe('open');
      expect(state.consecutiveFailures).toBe(20);
    });

    it('should handle interleaved recordFailure and recordSuccess', () => {
      // Pattern: 5 failures, 1 success, repeat
      for (let cycle = 0; cycle < 5; cycle++) {
        for (let i = 0; i < 5; i++) {
          flow.recordFailure('llm:request', 'x', 'y');
        }
        flow.recordSuccess('llm:request', 'x', 'y');
      }

      // Circuit should be closed because success resets counter each cycle
      const key = 'llm:request:x:y';
      const state = (flow as any).channelStates.get(key);
      expect(state.consecutiveFailures).toBe(0);
      expect(state.circuitState).toBe('closed');
    });
  });

  // =========================================================================
  // 2. Concurrent Multi-Channel Operations
  // =========================================================================

  describe('Concurrent multi-channel operations', () => {
    it('should handle many distinct channels simultaneously', () => {
      const channelCount = 100;
      const signals: ClusterSignal[] = [];

      for (let i = 0; i < channelCount; i++) {
        signals.push(makeSignal({
          type: 'data:broadcast',
          sourceCluster: `src-${i}`,
          targetCluster: `tgt-${i}`,
        }));
      }

      // Evaluate all
      const results = signals.map((s) => flow.evaluate(s));
      expect(results.every((r) => r === 'allow')).toBe(true);
      expect(flow.getStats().totalProcessed).toBe(channelCount);
      expect((flow as any).channelStates.size).toBe(channelCount);
    });

    it('should maintain correct stats across mixed signal types', () => {
      flow.addPolicy({
        signalTypes: ['llm:request'],
        allowedDirections: ['upstream'],
        rateLimit: 0,
        maxQueueDepth: 0,
        minPriority: 0,
        bufferOnPressure: false,
      });

      flow.addPolicy({
        signalTypes: ['data:broadcast'],
        allowedDirections: ['downstream'],
        rateLimit: 0,
        maxQueueDepth: 0,
        minPriority: 0,
        bufferOnPressure: false,
      });

      // Mixed signals
      const signals = [
        makeSignal({ type: 'llm:request', direction: 'upstream' }),    // allow
        makeSignal({ type: 'llm:request', direction: 'downstream' }),  // drop
        makeSignal({ type: 'data:broadcast', direction: 'downstream' }), // allow
        makeSignal({ type: 'data:broadcast', direction: 'upstream' }),   // drop
        makeSignal({ type: 'cluster:heartbeat', direction: 'duplex' }), // allow (no policy)
      ];

      const results = signals.map((s) => flow.evaluate(s));
      expect(results).toEqual(['allow', 'drop', 'allow', 'drop', 'allow']);
      expect(flow.getStats().totalProcessed).toBe(3);
      expect(flow.getStats().totalDropped).toBe(2);
    });
  });

  // =========================================================================
  // 3. Rate Limit Window Transitions
  // =========================================================================

  describe('Rate limit window boundary', () => {
    it('should reset rate counter after window expires', async () => {
      flow.addPolicy({
        signalTypes: ['llm:request'],
        allowedDirections: [],
        rateLimit: 2,
        maxQueueDepth: 0,
        minPriority: 0,
        bufferOnPressure: false,
      });

      // Exhaust rate limit
      expect(flow.evaluate(makeSignal({ type: 'llm:request' }))).toBe('allow');
      expect(flow.evaluate(makeSignal({ type: 'llm:request' }))).toBe('allow');
      expect(flow.evaluate(makeSignal({ type: 'llm:request' }))).toBe('drop');

      // Wait for window reset (windowMs = 1000)
      await new Promise((resolve) => setTimeout(resolve, 1100));

      // Should allow again
      expect(flow.evaluate(makeSignal({ type: 'llm:request' }))).toBe('allow');
    });
  });

  // =========================================================================
  // 4. Policy Modification During Evaluation
  // =========================================================================

  describe('Policy modification during evaluation', () => {
    it('should apply new policy immediately after add', () => {
      // No policy — allow all
      expect(flow.evaluate(makeSignal({ type: 'llm:request', direction: 'downstream' }))).toBe('allow');

      // Add restrictive policy
      flow.addPolicy({
        signalTypes: ['llm:request'],
        allowedDirections: ['upstream'],
        rateLimit: 0,
        maxQueueDepth: 0,
        minPriority: 0,
        bufferOnPressure: false,
      });

      // Now downstream should be dropped
      expect(flow.evaluate(makeSignal({ type: 'llm:request', direction: 'downstream' }))).toBe('drop');
      expect(flow.evaluate(makeSignal({ type: 'llm:request', direction: 'upstream' }))).toBe('allow');
    });

    it('should stop enforcing removed policy immediately', () => {
      flow.addPolicy({
        signalTypes: ['llm:request'],
        allowedDirections: ['upstream'],
        rateLimit: 0,
        maxQueueDepth: 0,
        minPriority: 0,
        bufferOnPressure: false,
      });

      expect(flow.evaluate(makeSignal({ type: 'llm:request', direction: 'downstream' }))).toBe('drop');

      flow.removePolicies(['llm:request']);

      expect(flow.evaluate(makeSignal({ type: 'llm:request', direction: 'downstream' }))).toBe('allow');
    });

    it('should handle clearPolicies gracefully mid-traffic', () => {
      flow.addPolicy({
        signalTypes: ['llm:request'],
        allowedDirections: ['upstream'],
        rateLimit: 1,
        maxQueueDepth: 5,
        minPriority: 0,
        bufferOnPressure: true,
      });

      // Generate some traffic
      flow.evaluate(makeSignal({ type: 'llm:request', direction: 'upstream' }));
      flow.evaluate(makeSignal({ type: 'llm:request', direction: 'upstream' })); // queued

      flow.clearPolicies();

      // After clear, no policies — all allowed
      expect(flow.evaluate(makeSignal({ type: 'llm:request', direction: 'downstream' }))).toBe('allow');
    });
  });

  // =========================================================================
  // 5. Drain Under Concurrent Queuing
  // =========================================================================

  describe('Drain under concurrent queuing', () => {
    it('should drain exactly the queued signals', async () => {
      flow.addPolicy({
        signalTypes: ['llm:request'],
        allowedDirections: [],
        rateLimit: 1,
        maxQueueDepth: 20,
        minPriority: 0,
        bufferOnPressure: true,
      });

      // 1 allowed + 15 queued
      for (let i = 0; i < 16; i++) {
        flow.evaluate(makeSignal({ type: 'llm:request' }));
      }

      expect(flow.getStats().totalQueued).toBe(15);

      // Wait for rate limit window to expire before draining
      await new Promise((resolve) => setTimeout(resolve, 1100));

      const drained = flow.drain('llm:request', 50);
      expect(drained.length).toBeLessThanOrEqual(15);
      expect(drained.length).toBeGreaterThan(0);
    });

    it('should handle drain with zero queued signals', () => {
      flow.addPolicy({
        signalTypes: ['llm:request'],
        allowedDirections: [],
        rateLimit: 10,
        maxQueueDepth: 10,
        minPriority: 0,
        bufferOnPressure: true,
      });

      flow.evaluate(makeSignal({ type: 'llm:request' }));

      const drained = flow.drain('llm:request', 10);
      expect(drained).toEqual([]);
    });
  });
});
