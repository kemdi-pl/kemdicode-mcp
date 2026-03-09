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
 * Signal Flow Controller
 *
 * Manages directional signal flow between clusters:
 * - Upstream: signals from leaf → hub
 * - Downstream: signals from hub → leaf
 * - Duplex: bidirectional signal exchange
 *
 * Provides backpressure, rate limiting, and flow control
 * for the ClusterBus signal pipeline.
 *
 * @module cluster-bus/signal-flow
 */

import { Logger } from '../utils/logger.js';
import type { ClusterSignal, SignalDirection, SignalType, SignalPriority } from './types.js';

// ---------------------------------------------------------------------------
// Flow Policy Types
// ---------------------------------------------------------------------------

/** Per-signal-type flow policy */
export interface FlowPolicy {
  /** Signal types this policy applies to (empty = all) */
  signalTypes: SignalType[];
  /** Allowed directions */
  allowedDirections: SignalDirection[];
  /** Maximum signals per second (0 = unlimited) */
  rateLimit: number;
  /** Maximum queued signals before dropping (0 = unlimited) */
  maxQueueDepth: number;
  /** Minimum priority to accept (signals below this are dropped) */
  minPriority: SignalPriority;
  /** Whether to buffer during backpressure or drop */
  bufferOnPressure: boolean;
}

/** Backpressure state for a channel with circuit breaker */
interface ChannelState {
  /** Number of signals processed in the current window */
  windowCount: number;
  /** Window start timestamp */
  windowStart: number;
  /** Queued signals waiting for capacity */
  queue: ClusterSignal[];
  /** Whether this channel is currently under backpressure */
  pressured: boolean;
  /** Circuit breaker state */
  circuitState: 'closed' | 'open' | 'half-open';
  /** Consecutive failure count for circuit breaker */
  consecutiveFailures: number;
  /** Timestamp when circuit breaker opened */
  circuitOpenedAt: number;
  /** Sliding window: timestamps of recent signals for burst detection */
  slidingWindow: number[];
  /** Number of probe requests allowed through in half-open state */
  halfOpenProbes: number;
}

/** Flow controller statistics */
export interface FlowStats {
  /** Total signals processed */
  totalProcessed: number;
  /** Total signals dropped due to flow control */
  totalDropped: number;
  /** Total signals currently queued */
  totalQueued: number;
  /** Per-direction counts */
  directionCounts: Record<SignalDirection, number>;
  /** Channels currently under backpressure */
  pressuredChannels: string[];
}

// ---------------------------------------------------------------------------
// Signal Flow Controller
// ---------------------------------------------------------------------------

/**
 * SignalFlowController — manages directional flow, rate limiting,
 * and backpressure for inter-cluster signal delivery.
 *
 * Usage:
 *   const flow = new SignalFlowController();
 *   flow.addPolicy({ signalTypes: ['llm:request'], rateLimit: 100, ... });
 *   const allowed = flow.evaluate(signal);
 *   if (allowed) { ... deliver signal ... }
 */
export class SignalFlowController {
  private policies: FlowPolicy[] = [];
  private channelStates = new Map<string, ChannelState>();
  private stats = {
    totalProcessed: 0,
    totalDropped: 0,
    directionCounts: { upstream: 0, downstream: 0, duplex: 0 } as Record<SignalDirection, number>,
  };

  private readonly windowMs = 1000; // 1-second rate limit window
  /** Circuit breaker: time to stay open before trying half-open (ms) */
  private readonly circuitOpenDurationMs = 5000;
  /** Circuit breaker: failures needed to trip */
  private readonly circuitFailureThreshold = 10;
  /** Burst detection: sliding window size in ms */
  private readonly burstWindowMs = 500;
  /** Max sliding window entries per channel (env: MCP_MAX_SLIDING_WINDOW, default: 500) */
  private readonly maxSlidingWindowSize = parseInt(process.env.MCP_MAX_SLIDING_WINDOW || '500', 10);
  /** Max channel states to track — LRU eviction beyond this (env: MCP_MAX_CHANNEL_STATES, default: 50000) */
  private readonly maxChannelStates = parseInt(process.env.MCP_MAX_CHANNEL_STATES || '50000', 10);
  /** Periodic cleanup interval for sliding windows */
  private slidingWindowCleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // Periodic cleanup of sliding window timestamps (every 5 seconds)
    this.slidingWindowCleanupInterval = setInterval(() => {
      this.cleanupSlidingWindows();
    }, 5000);
  }

  // -------------------------------------------------------------------------
  // Policy Management
  // -------------------------------------------------------------------------

  /** Add a flow policy. */
  addPolicy(policy: FlowPolicy): void {
    this.policies.push(policy);
  }

  /** Remove all policies matching specific signal types. */
  removePolicies(signalTypes: SignalType[]): number {
    const before = this.policies.length;
    this.policies = this.policies.filter(
      (p) => !signalTypes.some((st) => p.signalTypes.includes(st)),
    );
    return before - this.policies.length;
  }

  /** Clear all policies. */
  clearPolicies(): void {
    this.policies = [];
  }

  /** Get current policies. */
  getPolicies(): readonly FlowPolicy[] {
    return this.policies;
  }

  // -------------------------------------------------------------------------
  // Flow Evaluation
  // -------------------------------------------------------------------------

  /**
   * Evaluate whether a signal should be delivered.
   *
   * Checks:
   * 1. Direction allowed by policies
   * 2. Minimum priority met
   * 3. Rate limit not exceeded
   * 4. Queue depth not exceeded (if buffering)
   *
   * Returns 'allow' | 'drop' | 'queue'
   */
  evaluate(signal: ClusterSignal): 'allow' | 'drop' | 'queue' {
    const matchingPolicies = this.getMatchingPolicies(signal.type);

    // No policies = allow all (but still check circuit breaker)
    const channelKey = this.getChannelKey(signal);
    if (this.isCircuitOpen(signal.type, signal.sourceCluster, signal.targetCluster || '*')) {
      this.stats.totalDropped++;
      Logger.debug(`[SignalFlow] Dropped ${signal.type} — circuit breaker open`);
      return 'drop';
    }

    if (matchingPolicies.length === 0) {
      this.recordProcessed(signal);
      // Track in sliding window for burst detection (capped to prevent memory leak)
      const state = this.getOrCreateState(channelKey);
      state.slidingWindow.push(Date.now());
      if (state.slidingWindow.length > this.maxSlidingWindowSize) {
        state.slidingWindow = state.slidingWindow.slice(-this.maxSlidingWindowSize);
      }
      return 'allow';
    }

    // Check direction
    const directionAllowed = matchingPolicies.some(
      (p) => p.allowedDirections.length === 0 || p.allowedDirections.includes(signal.direction),
    );
    if (!directionAllowed) {
      this.stats.totalDropped++;
      Logger.debug(
        `[SignalFlow] Dropped ${signal.type} — direction ${signal.direction} not allowed`,
      );
      return 'drop';
    }

    // Check priority
    const minPriority = Math.max(...matchingPolicies.map((p) => p.minPriority));
    if (signal.priority < minPriority) {
      this.stats.totalDropped++;
      Logger.debug(
        `[SignalFlow] Dropped ${signal.type} — priority ${signal.priority} < ${minPriority}`,
      );
      return 'drop';
    }

    // Check rate limit
    const rateLimit = Math.min(
      ...matchingPolicies.map((p) => p.rateLimit).filter((r) => r > 0),
      Infinity,
    );

    if (rateLimit < Infinity) {
      // Reuse channelKey from line 175 (was shadowed here before)
      const state = this.getOrCreateState(channelKey);
      const now = Date.now();

      // Reset window if expired
      if (now - state.windowStart >= this.windowMs) {
        state.windowCount = 0;
        state.windowStart = now;
        state.pressured = false;
      }

      if (state.windowCount >= rateLimit) {
        state.pressured = true;

        // Check if we should buffer
        const shouldBuffer = matchingPolicies.some((p) => p.bufferOnPressure);
        const maxQueue = Math.max(...matchingPolicies.map((p) => p.maxQueueDepth));

        if (shouldBuffer && (maxQueue === 0 || state.queue.length < maxQueue)) {
          state.queue.push(signal);
          Logger.debug(
            `[SignalFlow] Queued ${signal.type} — rate limit reached (queue: ${state.queue.length})`,
          );
          return 'queue';
        }

        this.stats.totalDropped++;
        Logger.debug(`[SignalFlow] Dropped ${signal.type} — rate limit ${rateLimit}/s exceeded`);
        return 'drop';
      }

      state.windowCount++;
    }

    this.recordProcessed(signal);
    return 'allow';
  }

  /**
   * Drain queued signals for a channel.
   * Returns signals that can now be processed (up to limit).
   */
  drain(signalType: SignalType, limit = 50): ClusterSignal[] {
    const drained: ClusterSignal[] = [];

    for (const [key, state] of this.channelStates) {
      if (!key.startsWith(signalType) && !key.startsWith('*')) continue;

      const now = Date.now();
      if (now - state.windowStart >= this.windowMs) {
        state.windowCount = 0;
        state.windowStart = now;
        state.pressured = false;
      }

      const matchingPolicies = this.getMatchingPolicies(signalType);
      const rateLimit = Math.min(
        ...matchingPolicies.map((p) => p.rateLimit).filter((r) => r > 0),
        Infinity,
      );

      const available = rateLimit < Infinity ? Math.max(0, rateLimit - state.windowCount) : limit;
      const toDrain = Math.min(available, state.queue.length, limit - drained.length);

      for (let i = 0; i < toDrain; i++) {
        const signal = state.queue.shift();
        if (signal) {
          drained.push(signal);
          state.windowCount++;
          this.recordProcessed(signal);
        }
      }

      if (state.queue.length === 0) {
        state.pressured = false;
      }

      if (drained.length >= limit) break;
    }

    return drained;
  }

  // -------------------------------------------------------------------------
  // Direction Helpers
  // -------------------------------------------------------------------------

  /** Check if a signal direction is allowed for the given type. */
  isDirectionAllowed(signalType: SignalType, direction: SignalDirection): boolean {
    const policies = this.getMatchingPolicies(signalType);
    if (policies.length === 0) return true;
    return policies.some(
      (p) => p.allowedDirections.length === 0 || p.allowedDirections.includes(direction),
    );
  }

  /** Get allowed directions for a signal type. */
  getAllowedDirections(signalType: SignalType): SignalDirection[] {
    const policies = this.getMatchingPolicies(signalType);
    if (policies.length === 0) return ['upstream', 'downstream', 'duplex'];

    const dirs = new Set<SignalDirection>();
    for (const p of policies) {
      if (p.allowedDirections.length === 0) {
        return ['upstream', 'downstream', 'duplex'];
      }
      for (const d of p.allowedDirections) dirs.add(d);
    }
    return [...dirs];
  }

  // -------------------------------------------------------------------------
  // Stats
  // -------------------------------------------------------------------------

  /** Get flow controller statistics. */
  getStats(): FlowStats {
    let totalQueued = 0;
    const pressuredChannels: string[] = [];

    for (const [key, state] of this.channelStates) {
      totalQueued += state.queue.length;
      if (state.pressured) pressuredChannels.push(key);
    }

    return {
      totalProcessed: this.stats.totalProcessed,
      totalDropped: this.stats.totalDropped,
      totalQueued,
      directionCounts: { ...this.stats.directionCounts },
      pressuredChannels,
    };
  }

  /** Reset all state and statistics, clearing timers. */
  reset(): void {
    this.channelStates.clear();
    this.stats = {
      totalProcessed: 0,
      totalDropped: 0,
      directionCounts: { upstream: 0, downstream: 0, duplex: 0 },
    };
    this.destroy();
  }

  /** Stop background timers. Call when discarding this controller. */
  destroy(): void {
    if (this.slidingWindowCleanupInterval) {
      clearInterval(this.slidingWindowCleanupInterval);
      this.slidingWindowCleanupInterval = null;
    }
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private getMatchingPolicies(signalType: SignalType): FlowPolicy[] {
    return this.policies.filter(
      (p) => p.signalTypes.length === 0 || p.signalTypes.includes(signalType),
    );
  }

  private getChannelKey(signal: ClusterSignal): string {
    return `${signal.type}:${signal.sourceCluster}:${signal.targetCluster || '*'}`;
  }

  private getOrCreateState(key: string): ChannelState {
    let state = this.channelStates.get(key);
    if (!state) {
      // Evict oldest idle channels when at capacity (LRU-style)
      if (this.channelStates.size >= this.maxChannelStates) {
        this.evictIdleChannels();
      }
      state = {
        windowCount: 0,
        windowStart: Date.now(),
        queue: [],
        pressured: false,
        circuitState: 'closed',
        consecutiveFailures: 0,
        circuitOpenedAt: 0,
        slidingWindow: [],
        halfOpenProbes: 0,
      };
      this.channelStates.set(key, state);
    }
    return state;
  }

  /** Evict idle channels (no queue, closed circuit, empty sliding window).
   *  Falls back to oldest-first eviction if no idle channels found, enforcing the hard bound. */
  private evictIdleChannels(): void {
    const target = Math.floor(this.maxChannelStates * 0.1);
    const toEvict: string[] = [];

    // Pass 1: evict truly idle channels
    for (const [key, state] of this.channelStates) {
      if (
        state.queue.length === 0 &&
        state.circuitState === 'closed' &&
        state.slidingWindow.length === 0
      ) {
        toEvict.push(key);
      }
      if (toEvict.length >= target) break;
    }

    // Pass 2: if no idle channels found, force-evict oldest entries (FIFO order from Map)
    if (toEvict.length === 0) {
      const keys = Array.from(this.channelStates.keys());
      for (let i = 0; i < Math.min(target, keys.length); i++) {
        toEvict.push(keys[i]);
      }
    }

    for (const key of toEvict) {
      this.channelStates.delete(key);
    }
    if (toEvict.length > 0) {
      Logger.debug(`[SignalFlow] Evicted ${toEvict.length} channel states (capacity: ${this.channelStates.size}/${this.maxChannelStates})`);
    }
  }

  /**
   * Record a failure for circuit breaker evaluation.
   * Call this when a signal delivery fails downstream.
   */
  recordFailure(signalType: SignalType, sourceCluster: string, targetCluster = '*'): void {
    const key = `${signalType}:${sourceCluster}:${targetCluster}`;
    const state = this.getOrCreateState(key);
    state.consecutiveFailures++;

    if (state.consecutiveFailures >= this.circuitFailureThreshold && state.circuitState === 'closed') {
      state.circuitState = 'open';
      state.circuitOpenedAt = Date.now();
      Logger.warn(`[SignalFlow] Circuit breaker OPEN for ${key} after ${state.consecutiveFailures} failures`);
    } else if (state.circuitState === 'half-open') {
      // Failures during half-open probing should re-open the circuit immediately
      state.circuitState = 'open';
      state.circuitOpenedAt = Date.now();
      Logger.warn(`[SignalFlow] Circuit breaker RE-OPENED for ${key} — failure during half-open probe`);
    }
  }

  /**
   * Record a success — resets circuit breaker failure counter.
   */
  recordSuccess(signalType: SignalType, sourceCluster: string, targetCluster = '*'): void {
    const key = `${signalType}:${sourceCluster}:${targetCluster}`;
    const state = this.channelStates.get(key);
    if (state) {
      state.consecutiveFailures = 0;
      state.halfOpenProbes = 0;
      if (state.circuitState === 'half-open') {
        state.circuitState = 'closed';
        Logger.info(`[SignalFlow] Circuit breaker CLOSED for ${key}`);
      }
    }
  }

  /**
   * Check if a channel's circuit breaker allows traffic.
   */
  /** Max probe requests in half-open state before re-opening if no success */
  private readonly maxHalfOpenProbes = 2;

  isCircuitOpen(signalType: SignalType, sourceCluster: string, targetCluster = '*'): boolean {
    const key = `${signalType}:${sourceCluster}:${targetCluster}`;
    const state = this.channelStates.get(key);
    if (!state || state.circuitState === 'closed') return false;

    if (state.circuitState === 'open') {
      // Check if enough time passed to try half-open (with jitter to prevent thundering herd)
      const jitter = Math.random() * this.circuitOpenDurationMs * 0.3; // 0-30% jitter
      if (Date.now() - state.circuitOpenedAt >= this.circuitOpenDurationMs + jitter) {
        state.circuitState = 'half-open';
        state.halfOpenProbes = 0;
        Logger.info(`[SignalFlow] Circuit breaker HALF-OPEN for ${key}`);
        return false; // Allow first probe request
      }
      return true; // Still open
    }

    // Half-open: allow limited probe requests
    if (state.halfOpenProbes < this.maxHalfOpenProbes) {
      state.halfOpenProbes++;
      return false; // Allow probe
    }

    // Max probes reached without success — reopen circuit
    state.circuitState = 'open';
    state.circuitOpenedAt = Date.now();
    Logger.warn(`[SignalFlow] Circuit breaker RE-OPENED for ${key} — ${this.maxHalfOpenProbes} probes failed`);
    return true;
  }

  /**
   * Detect burst conditions using sliding window analysis.
   * Returns the current signals/second rate for a channel.
   */
  getBurstRate(signalType: SignalType, sourceCluster: string, targetCluster = '*'): number {
    const key = `${signalType}:${sourceCluster}:${targetCluster}`;
    const state = this.channelStates.get(key);
    if (!state) return 0;

    const now = Date.now();
    // Clean up old entries in sliding window
    state.slidingWindow = state.slidingWindow.filter((t) => now - t < this.burstWindowMs);
    return (state.slidingWindow.length / this.burstWindowMs) * 1000; // signals/sec
  }

  /**
   * Periodic cleanup: trim sliding window arrays across all channels.
   * Prevents unbounded memory growth from burst detection timestamps.
   */
  private cleanupSlidingWindows(): void {
    const now = Date.now();
    for (const [, state] of this.channelStates) {
      if (state.slidingWindow.length > 0) {
        state.slidingWindow = state.slidingWindow.filter((t) => now - t < this.burstWindowMs);
      }
    }
  }

  private recordProcessed(signal: ClusterSignal): void {
    this.stats.totalProcessed++;
    this.stats.directionCounts[signal.direction] =
      (this.stats.directionCounts[signal.direction] || 0) + 1;
  }
}

// ---------------------------------------------------------------------------
// Convenience: Default Flow Policies
// ---------------------------------------------------------------------------

/** Default policy for LLM signals: duplex, rate-limited to 50/s, buffer on pressure. */
export function defaultLLMPolicy(): FlowPolicy {
  return {
    signalTypes: ['llm:request', 'llm:result', 'llm:stream-chunk', 'llm:error'],
    allowedDirections: ['duplex', 'upstream', 'downstream'],
    rateLimit: 50,
    maxQueueDepth: 200,
    minPriority: 0,
    bufferOnPressure: true,
  };
}

/** Default policy for control signals: duplex, no rate limit, high priority only. */
export function defaultControlPolicy(): FlowPolicy {
  return {
    signalTypes: ['control:pause', 'control:resume', 'control:config'],
    allowedDirections: ['duplex', 'downstream'],
    rateLimit: 0,
    maxQueueDepth: 0,
    minPriority: 2,
    bufferOnPressure: false,
  };
}

/** Default policy for heartbeats: upstream only, moderate rate limit. */
export function defaultHeartbeatPolicy(): FlowPolicy {
  return {
    signalTypes: ['cluster:heartbeat'],
    allowedDirections: ['upstream', 'duplex'],
    rateLimit: 10,
    maxQueueDepth: 0,
    minPriority: 0,
    bufferOnPressure: false,
  };
}
