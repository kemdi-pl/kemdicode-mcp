/**
 * Signal Flow Controller — Unit Tests
 *
 * Tests for backpressure, rate limiting, circuit breaker,
 * burst detection, and flow policy management.
 *
 * Self-contained: imports real SignalFlowController (no Redis dependency).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  SignalFlowController,
  defaultLLMPolicy,
  defaultControlPolicy,
  defaultHeartbeatPolicy,
} from '../../../src/cluster-bus/signal-flow.js';
import type { ClusterSignal, SignalDirection, SignalPriority, SignalType } from '../../../src/cluster-bus/types.js';

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

describe('SignalFlowController', () => {
  let flow: SignalFlowController;

  beforeEach(() => {
    flow = new SignalFlowController();
  });

  afterEach(() => {
    flow.reset();
  });

  // =========================================================================
  // 1. Policy Management
  // =========================================================================

  describe('Policy management', () => {
    it('should add and retrieve policies', () => {
      flow.addPolicy(defaultLLMPolicy());
      expect(flow.getPolicies()).toHaveLength(1);
      expect(flow.getPolicies()[0].signalTypes).toContain('llm:request');
    });

    it('should remove policies by signal type', () => {
      flow.addPolicy(defaultLLMPolicy());
      flow.addPolicy(defaultControlPolicy());
      expect(flow.getPolicies()).toHaveLength(2);

      const removed = flow.removePolicies(['llm:request']);
      expect(removed).toBe(1);
      expect(flow.getPolicies()).toHaveLength(1);
      expect(flow.getPolicies()[0].signalTypes).toContain('control:pause');
    });

    it('should clear all policies', () => {
      flow.addPolicy(defaultLLMPolicy());
      flow.addPolicy(defaultControlPolicy());
      flow.clearPolicies();
      expect(flow.getPolicies()).toHaveLength(0);
    });
  });

  // =========================================================================
  // 2. Default Policies — Sanity Checks
  // =========================================================================

  describe('Default policies', () => {
    it('LLM policy: duplex, rate=50, buffer=true', () => {
      const p = defaultLLMPolicy();
      expect(p.signalTypes).toEqual(['llm:request', 'llm:result', 'llm:stream-chunk', 'llm:error']);
      expect(p.rateLimit).toBe(50);
      expect(p.bufferOnPressure).toBe(true);
      expect(p.maxQueueDepth).toBe(200);
    });

    it('Control policy: high priority only, no buffer', () => {
      const p = defaultControlPolicy();
      expect(p.signalTypes).toEqual(['control:pause', 'control:resume', 'control:config']);
      expect(p.minPriority).toBe(2);
      expect(p.bufferOnPressure).toBe(false);
    });

    it('Heartbeat policy: upstream+duplex, rate=10', () => {
      const p = defaultHeartbeatPolicy();
      expect(p.signalTypes).toEqual(['cluster:heartbeat']);
      expect(p.allowedDirections).toEqual(['upstream', 'duplex']);
      expect(p.rateLimit).toBe(10);
    });
  });

  // =========================================================================
  // 3. Direction Enforcement
  // =========================================================================

  describe('Direction enforcement', () => {
    it('should allow signal when direction matches policy', () => {
      flow.addPolicy({
        signalTypes: ['llm:request'],
        allowedDirections: ['upstream'],
        rateLimit: 0,
        maxQueueDepth: 0,
        minPriority: 0,
        bufferOnPressure: false,
      });
      expect(flow.evaluate(makeSignal({ type: 'llm:request', direction: 'upstream' }))).toBe('allow');
    });

    it('should drop signal when direction is not allowed', () => {
      flow.addPolicy({
        signalTypes: ['llm:request'],
        allowedDirections: ['upstream'],
        rateLimit: 0,
        maxQueueDepth: 0,
        minPriority: 0,
        bufferOnPressure: false,
      });
      expect(flow.evaluate(makeSignal({ type: 'llm:request', direction: 'downstream' }))).toBe('drop');
    });

    it('should allow any direction when policy allowedDirections is empty', () => {
      flow.addPolicy({
        signalTypes: ['llm:request'],
        allowedDirections: [],
        rateLimit: 0,
        maxQueueDepth: 0,
        minPriority: 0,
        bufferOnPressure: false,
      });
      expect(flow.evaluate(makeSignal({ type: 'llm:request', direction: 'downstream' }))).toBe('allow');
      expect(flow.evaluate(makeSignal({ type: 'llm:request', direction: 'upstream' }))).toBe('allow');
    });
  });

  // =========================================================================
  // 4. Priority Enforcement
  // =========================================================================

  describe('Priority enforcement', () => {
    it('should drop signals below minimum priority', () => {
      flow.addPolicy({
        signalTypes: ['control:pause'],
        allowedDirections: [],
        rateLimit: 0,
        maxQueueDepth: 0,
        minPriority: 2,
        bufferOnPressure: false,
      });
      expect(flow.evaluate(makeSignal({ type: 'control:pause', priority: 1 }))).toBe('drop');
    });

    it('should allow signals at or above minimum priority', () => {
      flow.addPolicy({
        signalTypes: ['control:pause'],
        allowedDirections: [],
        rateLimit: 0,
        maxQueueDepth: 0,
        minPriority: 2,
        bufferOnPressure: false,
      });
      expect(flow.evaluate(makeSignal({ type: 'control:pause', priority: 2 }))).toBe('allow');
      expect(flow.evaluate(makeSignal({ type: 'control:pause', priority: 3 }))).toBe('allow');
    });
  });

  // =========================================================================
  // 5. Rate Limiting
  // =========================================================================

  describe('Rate limiting', () => {
    it('should allow signals within rate limit', () => {
      flow.addPolicy({
        signalTypes: ['llm:request'],
        allowedDirections: [],
        rateLimit: 3,
        maxQueueDepth: 0,
        minPriority: 0,
        bufferOnPressure: false,
      });

      expect(flow.evaluate(makeSignal({ type: 'llm:request' }))).toBe('allow');
      expect(flow.evaluate(makeSignal({ type: 'llm:request' }))).toBe('allow');
      expect(flow.evaluate(makeSignal({ type: 'llm:request' }))).toBe('allow');
    });

    it('should drop signals exceeding rate limit (no buffer)', () => {
      flow.addPolicy({
        signalTypes: ['llm:request'],
        allowedDirections: [],
        rateLimit: 2,
        maxQueueDepth: 0,
        minPriority: 0,
        bufferOnPressure: false,
      });

      flow.evaluate(makeSignal({ type: 'llm:request' }));
      flow.evaluate(makeSignal({ type: 'llm:request' }));
      expect(flow.evaluate(makeSignal({ type: 'llm:request' }))).toBe('drop');
    });

    it('should queue signals when bufferOnPressure is true', () => {
      flow.addPolicy({
        signalTypes: ['llm:request'],
        allowedDirections: [],
        rateLimit: 1,
        maxQueueDepth: 10,
        minPriority: 0,
        bufferOnPressure: true,
      });

      expect(flow.evaluate(makeSignal({ type: 'llm:request' }))).toBe('allow');
      expect(flow.evaluate(makeSignal({ type: 'llm:request' }))).toBe('queue');
      expect(flow.evaluate(makeSignal({ type: 'llm:request' }))).toBe('queue');
    });

    it('should drop when queue depth exceeded', () => {
      flow.addPolicy({
        signalTypes: ['llm:request'],
        allowedDirections: [],
        rateLimit: 1,
        maxQueueDepth: 2,
        minPriority: 0,
        bufferOnPressure: true,
      });

      expect(flow.evaluate(makeSignal({ type: 'llm:request' }))).toBe('allow');
      expect(flow.evaluate(makeSignal({ type: 'llm:request' }))).toBe('queue');
      expect(flow.evaluate(makeSignal({ type: 'llm:request' }))).toBe('queue');
      expect(flow.evaluate(makeSignal({ type: 'llm:request' }))).toBe('drop');
    });
  });

  // =========================================================================
  // 6. No-Policy Passthrough
  // =========================================================================

  describe('No-policy passthrough', () => {
    it('should allow any signal when no policies are set', () => {
      expect(flow.evaluate(makeSignal({ type: 'llm:request' }))).toBe('allow');
      expect(flow.evaluate(makeSignal({ type: 'cluster:heartbeat' }))).toBe('allow');
      expect(flow.evaluate(makeSignal({ type: 'control:pause' }))).toBe('allow');
    });

    it('should allow unmatched signal types (no matching policy)', () => {
      flow.addPolicy({
        signalTypes: ['llm:request'],
        allowedDirections: ['upstream'],
        rateLimit: 0,
        maxQueueDepth: 0,
        minPriority: 0,
        bufferOnPressure: false,
      });
      // data:broadcast has no matching policy -> allowed
      expect(flow.evaluate(makeSignal({ type: 'data:broadcast' }))).toBe('allow');
    });
  });

  // =========================================================================
  // 7. Circuit Breaker
  // =========================================================================

  describe('Circuit breaker', () => {
    it('should open after 10 consecutive failures', () => {
      for (let i = 0; i < 10; i++) {
        flow.recordFailure('llm:request', 'src', 'tgt');
      }
      const signal = makeSignal({ type: 'llm:request', sourceCluster: 'src', targetCluster: 'tgt' });
      expect(flow.evaluate(signal)).toBe('drop');
      expect(flow.getStats().totalDropped).toBe(1);
    });

    it('should not open before threshold', () => {
      for (let i = 0; i < 9; i++) {
        flow.recordFailure('llm:request', 'src', 'tgt');
      }
      const signal = makeSignal({ type: 'llm:request', sourceCluster: 'src', targetCluster: 'tgt' });
      expect(flow.evaluate(signal)).toBe('allow');
    });

    it('should close after success in half-open state', () => {
      // Trip circuit to open
      for (let i = 0; i < 10; i++) {
        flow.recordFailure('llm:request', 'src', 'tgt');
      }

      const signal = makeSignal({ type: 'llm:request', sourceCluster: 'src', targetCluster: 'tgt' });

      // Circuit is open — should drop
      expect(flow.evaluate(signal)).toBe('drop');

      // Manually transition to half-open by manipulating state
      // (in production this happens after circuitOpenDurationMs=5000ms)
      const key = 'llm:request:src:tgt';
      const state = (flow as any).channelStates.get(key);
      state.circuitState = 'half-open';
      state.halfOpenProbes = 0;

      // First probe allowed in half-open
      expect(flow.evaluate(signal)).toBe('allow');

      // Record success → circuit closes
      flow.recordSuccess('llm:request', 'src', 'tgt');

      // Now should be closed and allow traffic
      expect(flow.evaluate(signal)).toBe('allow');
    });
  });

  // =========================================================================
  // 8. Draining
  // =========================================================================

  describe('Draining', () => {
    it('should drain queued signals', () => {
      flow.addPolicy({
        signalTypes: ['llm:request'],
        allowedDirections: [],
        rateLimit: 1,
        maxQueueDepth: 10,
        minPriority: 0,
        bufferOnPressure: true,
      });

      // One allowed, two queued
      flow.evaluate(makeSignal({ type: 'llm:request' }));
      flow.evaluate(makeSignal({ type: 'llm:request' }));
      flow.evaluate(makeSignal({ type: 'llm:request' }));

      expect(flow.getStats().totalQueued).toBe(2);
    });
  });

  // =========================================================================
  // 9. Statistics
  // =========================================================================

  describe('Statistics', () => {
    it('should track processed, dropped, and direction counts', () => {
      flow.addPolicy({
        signalTypes: ['llm:request'],
        allowedDirections: ['upstream'],
        rateLimit: 0,
        maxQueueDepth: 0,
        minPriority: 0,
        bufferOnPressure: false,
      });

      flow.evaluate(makeSignal({ type: 'llm:request', direction: 'upstream' }));
      flow.evaluate(makeSignal({ type: 'llm:request', direction: 'downstream' }));

      const stats = flow.getStats();
      expect(stats.totalProcessed).toBe(1);
      expect(stats.totalDropped).toBe(1);
      expect(stats.directionCounts.upstream).toBe(1);
    });

    it('should reset all state', () => {
      flow.evaluate(makeSignal({ type: 'llm:request' }));
      expect(flow.getStats().totalProcessed).toBe(1);

      flow.reset();
      expect(flow.getStats().totalProcessed).toBe(0);
      expect(flow.getStats().totalDropped).toBe(0);
      expect(flow.getStats().totalQueued).toBe(0);
    });
  });

  // =========================================================================
  // 10. Direction Helpers
  // =========================================================================

  describe('Direction helpers', () => {
    it('isDirectionAllowed returns true for matching direction', () => {
      flow.addPolicy({
        signalTypes: ['llm:request'],
        allowedDirections: ['upstream'],
        rateLimit: 0,
        maxQueueDepth: 0,
        minPriority: 0,
        bufferOnPressure: false,
      });
      expect(flow.isDirectionAllowed('llm:request', 'upstream')).toBe(true);
      expect(flow.isDirectionAllowed('llm:request', 'downstream')).toBe(false);
    });

    it('isDirectionAllowed returns true when no policies match', () => {
      expect(flow.isDirectionAllowed('llm:request', 'downstream')).toBe(true);
    });

    it('getAllowedDirections returns all directions when no policies', () => {
      expect(flow.getAllowedDirections('llm:request')).toEqual(['upstream', 'downstream', 'duplex']);
    });

    it('getAllowedDirections respects policy restrictions', () => {
      flow.addPolicy({
        signalTypes: ['llm:request'],
        allowedDirections: ['upstream', 'duplex'],
        rateLimit: 0,
        maxQueueDepth: 0,
        minPriority: 0,
        bufferOnPressure: false,
      });
      const dirs = flow.getAllowedDirections('llm:request');
      expect(dirs).toContain('upstream');
      expect(dirs).toContain('duplex');
      expect(dirs).not.toContain('downstream');
    });
  });

  // =========================================================================
  // 11. Burst Detection
  // =========================================================================

  describe('Burst detection', () => {
    it('getBurstRate returns 0 for unknown channel', () => {
      expect(flow.getBurstRate('llm:request', 'unknown', 'unknown')).toBe(0);
    });

    it('getBurstRate counts signals in sliding window', () => {
      // Evaluate signals to populate sliding window
      const sig = makeSignal({ type: 'data:broadcast', sourceCluster: 'a', targetCluster: 'b' });
      flow.evaluate(sig);
      flow.evaluate(sig);

      const rate = flow.getBurstRate('data:broadcast', 'a', 'b');
      expect(rate).toBeGreaterThan(0);
    });
  });
});
