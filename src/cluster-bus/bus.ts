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
 * Cluster Bus - Full-Duplex Inter-Cluster Communication
 *
 * Redis Pub/Sub backed message bus with dual connections for
 * simultaneous publish and subscribe. Supports unicast, broadcast,
 * and meta-tag routed signal delivery with dedup.
 *
 * @module cluster-bus/bus
 */

import { v4 as uuidv4 } from 'uuid';
import { createHmac } from 'node:crypto';
import { Redis } from 'ioredis';
import { Logger } from '../utils/logger.js';
import { getSharedRedis } from '../infrastructure/redis/connection.js';
import type {
  ClusterSignal,
  ClusterSignalHandler,
  ClusterSubscription,
  SignalType,
  SignalDirection,
  SignalPriority,
  ClusterBusConfig,
} from './types.js';
import { CLUSTER_KEYS } from './types.js';
import { MetaTagRouter } from './meta-router.js';
import { SignalFlowController } from './signal-flow.js';

/** Subscription record with TTL */
interface Subscription {
  id: string;
  signalType: SignalType | '*';
  handler: ClusterSignalHandler;
  sourceFilter?: string[];
  /** Timestamp when this subscription was created */
  createdAt: number;
  /** Last time this subscription's handler was invoked */
  lastInvokedAt: number;
  /** TTL in ms — subscriptions idle longer than this are auto-cleaned (0 = no TTL) */
  ttlMs: number;
}

/**
 * BloomFilter — space-efficient probabilistic set for signal deduplication.
 * Uses k=3 hash functions over a bit array. False positive rate ~1% at 10K entries.
 */
class BloomFilter {
  private bits: Uint32Array;
  private readonly size: number;
  private readonly hashCount: number;
  private _count = 0;
  /** Stored for atomic swap reconstruction */
  readonly expectedItems: number;
  readonly configuredFPR: number;

  constructor(expectedItems = 20000, falsePositiveRate = 0.01) {
    this.expectedItems = expectedItems;
    this.configuredFPR = falsePositiveRate;
    // Validate inputs to prevent DoS via memory exhaustion or NaN/Infinity
    const items = typeof expectedItems === 'number' && expectedItems > 0 ? expectedItems : 20000;
    const rate =
      typeof falsePositiveRate === 'number' && falsePositiveRate > 0 && falsePositiveRate < 1
        ? falsePositiveRate
        : 0.01;

    // Optimal size: m = -n*ln(p) / (ln2)^2, cap at 10M entries to prevent OOM
    this.size = Math.min(
      10_000_000,
      Math.max(1024, Math.ceil((-items * Math.log(rate)) / (Math.LN2 * Math.LN2)))
    );
    // Optimal hash count: k = (m/n) * ln2
    this.hashCount = Math.max(2, Math.min(8, Math.round((this.size / items) * Math.LN2)));
    this.bits = new Uint32Array(Math.ceil(this.size / 32));
  }

  private hash(str: string, seed: number): number {
    if (typeof str !== 'string' || str.length === 0) return 0;
    let h = seed >>> 0;
    for (let i = 0; i < str.length; i++) {
      h = ((h << 5) - h + str.charCodeAt(i)) >>> 0;
    }
    return h % this.size;
  }

  add(item: string): void {
    if (typeof item !== 'string' || item.length === 0) return;
    for (let i = 0; i < this.hashCount; i++) {
      const pos = this.hash(item, i * 0x9e3779b9);
      this.bits[pos >>> 5] |= (1 >>> 0) << (pos & 31);
    }
    this._count++;
  }

  has(item: string): boolean {
    if (typeof item !== 'string' || item.length === 0) return false;
    for (let i = 0; i < this.hashCount; i++) {
      const pos = this.hash(item, i * 0x9e3779b9);
      if (!(this.bits[pos >>> 5] & ((1 >>> 0) << (pos & 31)))) return false;
    }
    return true;
  }

  get count(): number {
    return this._count;
  }

  /** Memory usage in bytes */
  get memoryBytes(): number {
    return this.bits.byteLength;
  }

  /** Reset the filter */
  clear(): void {
    this.bits.fill(0);
    this._count = 0;
  }
}

/**
 * ClusterBus — full-duplex inter-cluster message bus.
 *
 * Architecture:
 * - Publisher connection: sends signals via Redis PUBLISH
 * - Subscriber connection: receives signals via Redis PSUBSCRIBE
 * - In-process subscriptions: local handlers for incoming signals
 * - Signal dedup: prevents echo loops via seen-ID set
 */
export class ClusterBus {
  private config: ClusterBusConfig;
  private publisher: Redis | null = null;
  private subscriber: Redis | null = null;
  private subscriptions = new Map<string, Subscription>();
  /** Bloom filter for fast signal dedup (probabilistic, ~0.1% false positive at 20K items) */
  private bloomFilter = new BloomFilter(20000, 0.001);
  /** Small exact-match set for recent signals (prevents bloom filter false positives) */
  private recentSignals = new Set<string>();
  private readonly maxRecent = 2000;
  /** Generation counter — bloom filter resets every N signals to bound FP rate */
  private bloomGeneration = 0;
  private readonly bloomResetThreshold = 15000;
  private signalHistory: ClusterSignal[] = [];
  private _connected = false;
  /** Subscription cleanup interval */
  private subscriptionCleanupInterval: ReturnType<typeof setInterval> | null = null;
  /** Periodic queue drain interval — processes backpressured signals */
  private queueDrainInterval: ReturnType<typeof setInterval> | null = null;
  /** Default subscription TTL: 30 minutes */
  private readonly defaultSubscriptionTtlMs = 30 * 60 * 1000;
  /** Cleanup interval: every 5 minutes */
  private readonly subscriptionCleanupIntervalMs = 5 * 60 * 1000;

  /** Loopback depth guard — prevents infinite local signal loops */
  private loopbackDepth = 0;
  private readonly maxLoopbackDepth = 8;
  /** Counter for loopback depth violations (for observability) */
  private loopbackViolations = 0;

  /** Outbound signal buffer — holds signals while publisher is disconnected */
  private outboundBuffer: Array<{ channel: string; signal: ClusterSignal }> = [];
  /** Max buffered signals during disconnection */
  private readonly maxOutboundBuffer = 500;
  /** Whether we're currently in a disconnected state */
  private _publisherHealthy = true;

  /** MetaTag-based signal router */
  readonly router: MetaTagRouter;
  /** Signal flow controller (rate limiting, backpressure, direction filtering) */
  readonly flowController: SignalFlowController;
  /** HMAC secret for signal authentication (env: MCP_CLUSTER_SECRET) */
  private readonly hmacSecret: string | null;
  /** Whether to enforce signal authentication */
  private readonly enforceAuth: boolean;

  constructor(config: ClusterBusConfig) {
    this.config = config;
    this.router = new MetaTagRouter();
    this.flowController = new SignalFlowController();
    // Signal authentication: shared secret for HMAC signing
    this.hmacSecret = process.env.MCP_CLUSTER_SECRET || null;
    // Default: enforce auth when secret is set (secure-by-default)
    // Can be explicitly disabled with MCP_CLUSTER_ENFORCE_AUTH=0
    const explicitDisable =
      process.env.MCP_CLUSTER_ENFORCE_AUTH === '0' || process.env.MCP_CLUSTER_ENFORCE_AUTH === 'false';
    this.enforceAuth = this.hmacSecret
      ? !explicitDisable
      : (process.env.MCP_CLUSTER_ENFORCE_AUTH === '1' || process.env.MCP_CLUSTER_AUTH_REQUIRED === '1');
    if (this.hmacSecret) {
      Logger.info(
        `[ClusterBus] Signal authentication enabled (HMAC-SHA256)${this.enforceAuth ? ' [STRICT MODE — unsigned messages rejected]' : ' [WARN: enforcement disabled via MCP_CLUSTER_ENFORCE_AUTH=0]'}`
      );
    } else if (this.enforceAuth) {
      Logger.warn(
        '[ClusterBus] MCP_CLUSTER_AUTH_REQUIRED=1 but MCP_CLUSTER_SECRET not set — enforcement disabled'
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this as any).enforceAuth = false;
    }
  }

  /**
   * Sign a serialized signal with HMAC-SHA256.
   * Appends signature as a JSON wrapper: { data: ..., sig: ... }
   */
  private signMessage(serialized: string): string {
    if (!this.hmacSecret) return serialized;
    const sig = createHmac('sha256', this.hmacSecret).update(serialized).digest('hex');
    return JSON.stringify({ data: serialized, sig });
  }

  /**
   * Verify and unwrap a signed message.
   * Returns the original serialized data or null if verification fails.
   */
  private verifyMessage(message: string): string | null {
    if (!this.hmacSecret) return message;

    try {
      // Try to parse as signed envelope
      const envelope = JSON.parse(message);
      if (typeof envelope.data === 'string' && typeof envelope.sig === 'string') {
        const expected = createHmac('sha256', this.hmacSecret).update(envelope.data).digest('hex');
        // Constant-time comparison
        if (envelope.sig.length === expected.length) {
          let diff = 0;
          for (let i = 0; i < envelope.sig.length; i++) {
            diff |= envelope.sig.charCodeAt(i) ^ expected.charCodeAt(i);
          }
          if (diff === 0) {
            // Replay protection: reject signals older than 5 minutes
            try {
              const parsed = JSON.parse(envelope.data);
              if (parsed.timestamp && Math.abs(Date.now() - parsed.timestamp) > 5 * 60 * 1000) {
                Logger.warn(
                  `[ClusterBus] Rejecting replayed signal (age=${Math.round((Date.now() - parsed.timestamp) / 1000)}s)`
                );
                return this.enforceAuth ? null : envelope.data;
              }
            } catch {
              /* non-JSON data — allow through */
            }
            return envelope.data;
          }
        }
        Logger.warn('[ClusterBus] Signal authentication failed: invalid HMAC signature');
        return this.enforceAuth ? null : envelope.data;
      }
    } catch {
      // Not a signed envelope — pass through if not enforcing
    }
    // Unsigned message
    if (this.enforceAuth) {
      Logger.warn('[ClusterBus] Signal authentication enforced: rejecting unsigned message');
      return null;
    }
    return message;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Connect both publisher and subscriber Redis connections.
   */
  async connect(): Promise<void> {
    if (this._connected) return;

    try {
      // Publisher uses shared connection
      this.publisher = await getSharedRedis();

      // Subscriber needs dedicated connection (Redis requirement for Pub/Sub)
      this.subscriber = new Redis({
        host: process.env.REDIS_HOST || '127.0.0.1',
        port: parseInt(process.env.REDIS_PORT || '6379', 10),
        password: process.env.REDIS_PASSWORD || undefined,
        db: 2,
        lazyConnect: false,
        maxRetriesPerRequest: 3,
      });

      this.subscriber.on('error', (err: Error) => {
        Logger.error(`[ClusterBus] Subscriber error: ${err.message}`);
      });

      this.subscriber.on('reconnecting', () => {
        Logger.warn('[ClusterBus] Subscriber reconnecting to Redis...');
      });

      this.subscriber.on('ready', () => {
        Logger.info('[ClusterBus] Subscriber Redis connection restored');
      });

      // Subscribe to broadcast channel
      const broadcastPattern = CLUSTER_KEYS.channelBroadcast();
      await this.subscriber.psubscribe(broadcastPattern);
      this.subscribedPatterns.add(broadcastPattern);

      // Subscribe to unicast channels for this cluster
      const unicastPattern = `mcp:cluster:*:${this.config.clusterId}`;
      await this.subscriber.psubscribe(unicastPattern);
      this.subscribedPatterns.add(unicastPattern);

      // Handle incoming messages
      this.subscriber.on('pmessage', (_pattern: string, _channel: string, message: string) => {
        this.handleIncoming(message);
      });

      this._connected = true;

      // Start periodic subscription cleanup (removes idle/orphaned subscriptions)
      this.subscriptionCleanupInterval = setInterval(() => {
        this.cleanupIdleSubscriptions();
      }, this.subscriptionCleanupIntervalMs);

      // Start periodic queue drain (processes backpressured signals every 2 seconds)
      this.queueDrainInterval = setInterval(() => {
        const flowStats = this.flowController.getStats();
        if (flowStats.totalQueued > 0) {
          // Drain all signal types that have policies
          for (const policy of this.flowController.getPolicies()) {
            for (const st of policy.signalTypes) {
              this.drainQueued(st as SignalType, 50);
            }
          }
        }
      }, 2000);

      Logger.info(
        `[ClusterBus] Connected as ${this.config.clusterId} (${this.config.clusterName})`
      );
    } catch (err) {
      // Clean up subscriber connection on error to prevent connection leak
      if (this.subscriber) {
        try {
          this.subscriber.disconnect();
        } catch { /* ignore disconnect errors during cleanup */ }
        this.subscriber = null;
      }
      Logger.error(`[ClusterBus] Connection failed:`, err);
      throw err;
    }
  }

  /**
   * Disconnect and clean up.
   */
  async disconnect(): Promise<void> {
    if (this.subscriber) {
      await this.subscriber.punsubscribe().catch(() => {});
      this.subscriber.disconnect();
      this.subscriber = null;
    }
    // Don't disconnect publisher — it's the shared Redis connection
    this.publisher = null;
    this.subscriptions.clear();
    this.bloomFilter.clear();
    this.recentSignals.clear();
    this.bloomGeneration = 0;
    this.signalHistory = [];
    this.historyWriteIndex = 0;
    this.historyFull = false;
    this.localVirtualClusters.clear();
    this.subscribedPatterns.clear();
    this.flowController.reset();
    if (this.subscriptionCleanupInterval) {
      clearInterval(this.subscriptionCleanupInterval);
      this.subscriptionCleanupInterval = null;
    }
    if (this.queueDrainInterval) {
      clearInterval(this.queueDrainInterval);
      this.queueDrainInterval = null;
    }
    this._connected = false;
    Logger.info(`[ClusterBus] Disconnected`);
  }

  get isConnected(): boolean {
    return this._connected;
  }

  get clusterId(): string {
    return this.config.clusterId;
  }

  /** Set of virtual cluster IDs hosted on this node (for loopback routing). */
  private localVirtualClusters = new Set<string>();
  /** Tracks Redis psubscribe patterns to prevent duplicate subscriptions */
  private subscribedPatterns = new Set<string>();

  /**
   * Subscribe to unicast channel for an additional cluster ID.
   * Used when virtual clusters are registered on this node so
   * that their llm:request signals are delivered locally.
   */
  async subscribeToCluster(clusterId: string): Promise<void> {
    if (!this.subscriber || !this._connected) {
      throw new Error('[ClusterBus] Not connected — call connect() first');
    }
    if (clusterId === this.config.clusterId) return; // already subscribed
    if (this.localVirtualClusters.has(clusterId)) return; // already added

    const pattern = `mcp:cluster:*:${clusterId}`;
    if (this.subscribedPatterns.has(pattern)) return;
    await this.subscriber.psubscribe(pattern);
    this.subscribedPatterns.add(pattern);
    this.localVirtualClusters.add(clusterId);
    Logger.info(`[ClusterBus] Subscribed to virtual cluster channel: ${clusterId}`);
  }

  /**
   * Unsubscribe from a virtual cluster channel.
   */
  async unsubscribeFromCluster(clusterId: string): Promise<void> {
    if (!this.subscriber || !this._connected) return;
    if (!this.localVirtualClusters.has(clusterId)) return;

    const pattern = `mcp:cluster:*:${clusterId}`;
    await this.subscriber.punsubscribe(pattern);
    this.subscribedPatterns.delete(pattern);
    this.localVirtualClusters.delete(clusterId);
    Logger.info(`[ClusterBus] Unsubscribed from virtual cluster channel: ${clusterId}`);
  }

  /**
   * Check if a cluster ID is a local virtual cluster.
   */
  isLocalVirtualCluster(clusterId: string): boolean {
    return this.localVirtualClusters.has(clusterId);
  }

  // -------------------------------------------------------------------------
  // Publish
  // -------------------------------------------------------------------------

  /**
   * Send a signal to a specific target cluster (unicast).
   */
  async send<T = unknown>(
    targetCluster: string,
    signalType: SignalType,
    payload: T,
    options: {
      direction?: SignalDirection;
      priority?: SignalPriority;
      ttl?: number;
      correlationId?: string;
      sessionId?: string;
      agentId?: string;
    } = {}
  ): Promise<string> {
    const signal = this.buildSignal(targetCluster, signalType, payload, options);

    // Loopback: deliver locally when target is self or a local virtual cluster
    if (targetCluster === this.config.clusterId || this.localVirtualClusters.has(targetCluster)) {
      if (this.loopbackDepth >= this.maxLoopbackDepth) {
        this.loopbackViolations++;
        Logger.warn(
          `[ClusterBus] Loopback depth limit (${this.maxLoopbackDepth}) reached for ${signal.type}, dropping (total violations: ${this.loopbackViolations})`
        );
        return signal.id;
      }
      this.loopbackDepth++;
      try {
        this.markSeen(signal.id);
        this.addToHistory(signal);
        this.deliverToSubscriptions(signal as ClusterSignal);
      } finally {
        this.loopbackDepth--;
      }
      Logger.debug(
        `[ClusterBus] Loopback ${signal.type} → ${targetCluster} (${signal.id.slice(0, 8)})`
      );
      return signal.id;
    }

    const channel = CLUSTER_KEYS.channelUnicast(this.config.clusterId, targetCluster);
    await this.publishSignal(channel, signal);
    return signal.id;
  }

  /**
   * Broadcast a signal to all clusters.
   */
  async broadcast<T = unknown>(
    signalType: SignalType,
    payload: T,
    options: {
      direction?: SignalDirection;
      priority?: SignalPriority;
      ttl?: number;
      correlationId?: string;
      sessionId?: string;
      agentId?: string;
    } = {}
  ): Promise<string> {
    const signal = this.buildSignal('', signalType, payload, options);
    const channel = CLUSTER_KEYS.channelBroadcast();
    await this.publishSignal(channel, signal);
    return signal.id;
  }

  /**
   * Route a signal via MetaTag rules to matching clusters (unicast to each).
   * Returns the signal ID and list of target cluster IDs.
   */
  async routedSend<T = unknown>(
    signalType: SignalType,
    payload: T,
    options: {
      direction?: SignalDirection;
      priority?: SignalPriority;
      ttl?: number;
      correlationId?: string;
      sessionId?: string;
      agentId?: string;
    } = {}
  ): Promise<{ signalId: string; targets: string[] }> {
    const signal = this.buildSignal('', signalType, payload, options);

    // Route via meta-tag rules
    const result = await this.router.route(signal);

    // Send unicast to each matched target
    for (const targetId of result.targets) {
      const targetSignal = { ...signal, targetCluster: targetId };
      const channel = CLUSTER_KEYS.channelUnicast(this.config.clusterId, targetId);
      await this.publishSignal(channel, targetSignal);
    }

    Logger.debug(
      `[ClusterBus] Routed ${signalType} → ${result.targets.length} targets (rules: ${result.matchedRules.join(', ')})`
    );

    return { signalId: signal.id, targets: result.targets };
  }

  /**
   * Multicast a signal to multiple target clusters simultaneously.
   * Returns the signal ID and list of target cluster IDs.
   * CI pipelines use this for fan-out to build/test/deploy clusters.
   */
  async multicast<T = unknown>(
    targets: string[],
    signalType: SignalType,
    payload: T,
    options: {
      direction?: SignalDirection;
      priority?: SignalPriority;
      ttl?: number;
      correlationId?: string;
      sessionId?: string;
      agentId?: string;
      multicastId?: string;
    } = {}
  ): Promise<{ signalId: string; multicastId: string; targets: string[] }> {
    const multicastId =
      options.multicastId || `mc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const signal = this.buildSignal('', signalType, payload, {
      ...options,
      correlationId: options.correlationId || multicastId,
    });

    const _channel = CLUSTER_KEYS.channelMulticast(multicastId);

    for (const targetId of targets) {
      const targetSignal = { ...signal, targetCluster: targetId };
      const unicastChannel = CLUSTER_KEYS.channelUnicast(this.config.clusterId, targetId);
      await this.publishSignal(unicastChannel, targetSignal);
    }

    Logger.debug(
      `[ClusterBus] Multicast ${signalType} → ${targets.length} targets (multicastId: ${multicastId})`
    );

    return { signalId: signal.id, multicastId, targets };
  }

  /**
   * Subscribe to multicast channel for a specific pipeline.
   * Used by CI workers to receive pipeline tasks.
   */
  async subscribeToMulticast(multicastId: string): Promise<void> {
    if (!this.subscriber || !this._connected) {
      throw new Error('[ClusterBus] Not connected — call connect() first');
    }

    const pattern = CLUSTER_KEYS.channelMulticast(multicastId);
    if (this.subscribedPatterns.has(pattern)) return;
    await this.subscriber.psubscribe(pattern);
    this.subscribedPatterns.add(pattern);
    Logger.info(`[ClusterBus] Subscribed to multicast channel: ${multicastId}`);
  }

  /**
   * Unsubscribe from a multicast channel.
   */
  async unsubscribeFromMulticast(multicastId: string): Promise<void> {
    if (!this.subscriber || !this._connected) return;

    const pattern = CLUSTER_KEYS.channelMulticast(multicastId);
    await this.subscriber.punsubscribe(pattern);
    this.subscribedPatterns.delete(pattern);
    Logger.info(`[ClusterBus] Unsubscribed from multicast channel: ${multicastId}`);
  }

  // -------------------------------------------------------------------------
  // Subscribe
  // -------------------------------------------------------------------------

  /**
   * Subscribe to signals of a specific type (or '*' for all).
   */
  onSignal<T = unknown>(
    signalType: SignalType | '*',
    handler: ClusterSignalHandler<T>,
    sourceFilter?: string[],
    options?: { ttlMs?: number }
  ): ClusterSubscription {
    const now = Date.now();
    const sub: Subscription = {
      id: uuidv4(),
      signalType,
      handler: handler as ClusterSignalHandler,
      sourceFilter,
      createdAt: now,
      lastInvokedAt: now,
      ttlMs: options?.ttlMs ?? this.defaultSubscriptionTtlMs,
    };

    this.subscriptions.set(sub.id, sub);

    return {
      id: sub.id,
      unsubscribe: () => {
        this.subscriptions.delete(sub.id);
      },
    };
  }

  // -------------------------------------------------------------------------
  // History & Metrics
  // -------------------------------------------------------------------------

  /**
   * Get recent signal history.
   */
  getHistory(limit = 50): ClusterSignal[] {
    const len = this.signalHistory.length;
    if (!this.historyFull || len < this.config.historyCap) {
      return this.signalHistory.slice(-limit);
    }
    // Circular buffer: read from writeIndex (oldest) to writeIndex-1 (newest)
    const result: ClusterSignal[] = [];
    const start = Math.max(0, len - limit);
    for (let i = start; i < len; i++) {
      result.push(this.signalHistory[(this.historyWriteIndex + i) % len]);
    }
    return result;
  }

  /**
   * Drain queued signals from the flow controller and deliver them.
   * Call periodically to process backpressured signals.
   */
  drainQueued(signalType: SignalType, limit = 50): number {
    const signals = this.flowController.drain(signalType, limit);
    for (const signal of signals) {
      this.addToHistory(signal);
      this.deliverToSubscriptions(signal);
    }
    return signals.length;
  }

  /**
   * Get stats about the bus.
   */
  getStats(): {
    connected: boolean;
    clusterId: string;
    subscriptionCount: number;
    historySize: number;
    seenSetSize: number;
    bloomMemoryBytes: number;
    bloomGeneration: number;
    recentSetSize: number;
    loopbackViolations: number;
    flowStats: import('./signal-flow.js').FlowStats;
  } {
    return {
      connected: this._connected,
      clusterId: this.config.clusterId,
      subscriptionCount: this.subscriptions.size,
      historySize: this.signalHistory.length,
      seenSetSize: this.bloomFilter.count,
      bloomMemoryBytes: this.bloomFilter.memoryBytes,
      bloomGeneration: this.bloomGeneration,
      recentSetSize: this.recentSignals.size,
      loopbackViolations: this.loopbackViolations,
      flowStats: this.flowController.getStats(),
    };
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private buildSignal<T>(
    targetCluster: string,
    signalType: SignalType,
    payload: T,
    options: {
      direction?: SignalDirection;
      priority?: SignalPriority;
      ttl?: number;
      correlationId?: string;
      sessionId?: string;
      agentId?: string;
    }
  ): ClusterSignal<T> {
    return {
      id: uuidv4(),
      type: signalType,
      sourceCluster: this.config.clusterId,
      targetCluster,
      payload,
      metaTags: this.config.metaTags,
      correlationId: options.correlationId,
      direction: options.direction || 'duplex',
      priority: options.priority ?? 1,
      ttl: options.ttl ?? 0,
      schemaVersion: 1,
      timestamp: Date.now(),
      originCluster: this.config.clusterId,
      sessionId: options.sessionId,
      agentId: options.agentId,
    };
  }

  private async publishSignal(channel: string, signal: ClusterSignal): Promise<void> {
    if (!this.publisher) {
      throw new Error('[ClusterBus] Not connected — call connect() first');
    }

    // Track our own signals to skip on receive
    this.markSeen(signal.id);

    // Store in local history
    this.addToHistory(signal);

    const serialized = JSON.stringify(signal);
    const wireMessage = this.signMessage(serialized);

    // Publish to Redis Pub/Sub (buffer on failure)
    try {
      await this.publisher.publish(channel, wireMessage);
      if (!this._publisherHealthy) {
        this._publisherHealthy = true;
        Logger.info(
          `[ClusterBus] Publisher recovered — draining ${this.outboundBuffer.length} buffered signals`
        );
        await this.drainOutboundBuffer();
      }
    } catch (pubErr) {
      this._publisherHealthy = false;
      if (this.outboundBuffer.length < this.maxOutboundBuffer) {
        this.outboundBuffer.push({ channel, signal: signal as ClusterSignal });
        Logger.warn(
          `[ClusterBus] Publisher failed, buffered signal (${this.outboundBuffer.length}/${this.maxOutboundBuffer}): ${pubErr instanceof Error ? pubErr.message : String(pubErr)}`
        );
      } else {
        // Priority-based eviction: drop lowest priority buffered signal to make room
        const incomingPriority = signal.priority ?? 1;
        let lowestIdx = -1;
        let lowestPriority = incomingPriority;
        for (let i = 0; i < this.outboundBuffer.length; i++) {
          const p = this.outboundBuffer[i].signal.priority ?? 1;
          if (p < lowestPriority) {
            lowestPriority = p;
            lowestIdx = i;
          }
        }
        if (lowestIdx >= 0) {
          const evicted = this.outboundBuffer.splice(lowestIdx, 1)[0];
          this.outboundBuffer.push({ channel, signal: signal as ClusterSignal });
          Logger.warn(
            `[ClusterBus] Outbound buffer full — evicted priority ${lowestPriority} signal ${evicted.signal.id.slice(0, 8)}, buffered priority ${incomingPriority} signal ${signal.id.slice(0, 8)}`
          );
        } else {
          Logger.warn(
            `[ClusterBus] Outbound buffer full (${this.maxOutboundBuffer}), dropping signal ${signal.id.slice(0, 8)} (priority ${incomingPriority})`
          );
        }
      }
      return;
    }

    // Persist to signal history in Redis
    try {
      const historyKey = signal.targetCluster
        ? CLUSTER_KEYS.signals(signal.sourceCluster, signal.targetCluster)
        : CLUSTER_KEYS.broadcastHistory();

      const pipeline = this.publisher.pipeline();
      pipeline.lpush(historyKey, serialized);
      pipeline.ltrim(historyKey, 0, this.config.historyCap - 1);
      if (this.config.historyTtlSeconds > 0) {
        pipeline.expire(historyKey, this.config.historyTtlSeconds);
      }
      await pipeline.exec();
    } catch (err) {
      Logger.warn(
        `[ClusterBus] Failed to persist signal history: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    Logger.debug(
      `[ClusterBus] Sent ${signal.type} → ${signal.targetCluster || 'broadcast'} (${signal.id.slice(0, 8)})`
    );
  }

  /**
   * Drain buffered outbound signals after publisher reconnects.
   */
  private async drainOutboundBuffer(): Promise<void> {
    const buffered = this.outboundBuffer.splice(0);
    let sent = 0;
    for (let i = 0; i < buffered.length; i++) {
      const { channel, signal } = buffered[i];
      try {
        const serialized = JSON.stringify(signal);
        const wireMessage = this.signMessage(serialized);
        await this.publisher!.publish(channel, wireMessage);
        sent++;
      } catch (err) {
        Logger.warn(
          `[ClusterBus] Failed to drain buffered signal: ${err instanceof Error ? err.message : String(err)}`
        );
        // Re-buffer ALL remaining signals (current + rest) to prevent signal loss
        for (let j = i; j < buffered.length; j++) {
          this.outboundBuffer.push(buffered[j]);
        }
        break;
      }
    }
    if (sent > 0) {
      Logger.info(
        `[ClusterBus] Drained ${sent} buffered signals, ${this.outboundBuffer.length} remaining`
      );
    }
  }

  /** Maximum incoming message size (1 MB) */
  private readonly maxMessageSize = 1024 * 1024;

  private handleIncoming(message: string): void {
    if (message.length > this.maxMessageSize) {
      Logger.warn(
        `[ClusterBus] Dropping oversized message (${message.length} bytes > ${this.maxMessageSize})`
      );
      return;
    }
    try {
      // Verify HMAC signature if authentication is configured
      const verified = this.verifyMessage(message);
      if (verified === null) return; // Authentication failed

      const signal = JSON.parse(verified) as ClusterSignal;

      // Structural validation: reject malformed signals missing critical fields
      if (
        !signal ||
        typeof signal !== 'object' ||
        typeof signal.id !== 'string' ||
        typeof signal.type !== 'string' ||
        typeof signal.sourceCluster !== 'string' ||
        signal.payload === undefined ||
        signal.payload === null
      ) {
        Logger.warn(
          `[ClusterBus] Dropping malformed signal: missing required fields (type=${signal?.type}, id=${signal?.id?.slice(0, 8)})`
        );
        return;
      }

      // Dedup: skip if we've seen this signal (bloom filter + recent exact set)
      // BUT allow broadcast signals from ourselves (targetCluster='') to pass through
      // so that local handlers (e.g. file:read) can process self-broadcasts
      const isSelfBroadcast =
        signal.sourceCluster === this.config.clusterId && signal.targetCluster === '';
      if (
        !isSelfBroadcast &&
        (this.bloomFilter.has(signal.id) || this.recentSignals.has(signal.id))
      ) {
        Logger.debug(
          `[ClusterBus] Dropping ${signal.type} - already seen (id: ${signal.id.slice(0, 8)})`
        );
        return;
      }
      this.markSeen(signal.id);

      // Skip unicast signals from ourselves (but allow self-broadcasts through)
      if (signal.sourceCluster === this.config.clusterId && signal.targetCluster !== '') {
        Logger.debug(
          `[ClusterBus] Dropping ${signal.type} - unicast from self (id: ${signal.id.slice(0, 8)})`
        );
        return;
      }

      // Enforce signal TTL: reject expired signals
      if (signal.ttl > 0) {
        const ageMs = Date.now() - signal.timestamp;
        if (ageMs > signal.ttl * 1000) {
          Logger.debug(
            `[ClusterBus] Dropping expired signal ${signal.id.slice(0, 8)} (age=${Math.round(ageMs / 1000)}s, ttl=${signal.ttl}s)`
          );
          return;
        }
      }

      // Flow control: evaluate rate limits, direction, and backpressure
      const flowDecision = this.flowController.evaluate(signal);
      if (flowDecision === 'drop') return;
      if (flowDecision === 'queue') {
        // Signal is queued in the flow controller; will be drained later
        return;
      }

      // Store in history
      this.addToHistory(signal);

      // Deliver to matching subscriptions
      this.deliverToSubscriptions(signal);

      Logger.debug(
        `[ClusterBus] Received ${signal.type} from ${signal.sourceCluster} (${signal.id.slice(0, 8)})`
      );
    } catch (err) {
      Logger.warn(
        `[ClusterBus] Failed to parse incoming signal: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private deliverToSubscriptions(signal: ClusterSignal): void {
    const now = Date.now();
    // Snapshot subscriptions to prevent mutation during iteration (handlers may add/remove subs)
    const subs = Array.from(this.subscriptions.values());
    for (const sub of subs) {
      if (sub.signalType !== '*' && sub.signalType !== signal.type) continue;
      if (sub.sourceFilter?.length && !sub.sourceFilter.includes(signal.sourceCluster)) continue;

      sub.lastInvokedAt = now;
      try {
        const result = sub.handler(signal);
        if (result instanceof Promise) {
          result
            .then(() => {
              this.flowController.recordSuccess(
                signal.type,
                signal.sourceCluster,
                signal.targetCluster || '*'
              );
            })
            .catch((err) => {
              this.flowController.recordFailure(
                signal.type,
                signal.sourceCluster,
                signal.targetCluster || '*'
              );
              Logger.error(
                `[ClusterBus] Async handler error for ${signal.type} (sub=${sub.id.slice(0, 8)}, src=${signal.sourceCluster}, target=${signal.targetCluster || '*'}, sig=${signal.id.slice(0, 8)}, corr=${signal.correlationId?.slice(0, 8) || '-'}): ${err instanceof Error ? err.message : String(err)}`
              );
            });
        } else {
          this.flowController.recordSuccess(
            signal.type,
            signal.sourceCluster,
            signal.targetCluster || '*'
          );
        }
      } catch (err) {
        this.flowController.recordFailure(
          signal.type,
          signal.sourceCluster,
          signal.targetCluster || '*'
        );
        Logger.error(
          `[ClusterBus] Sync handler error for ${signal.type} (sub=${sub.id.slice(0, 8)}, src=${signal.sourceCluster}, target=${signal.targetCluster || '*'}, sig=${signal.id.slice(0, 8)}, corr=${signal.correlationId?.slice(0, 8) || '-'}): ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  /**
   * Mark a signal as seen using bloom filter + small exact-match set.
   * The bloom filter provides O(1) memory-bounded dedup.
   * The recent set catches false positives for the most recent signals.
   * The bloom filter resets every bloomResetThreshold signals to bound FP rate.
   */
  private markSeen(signalId: string): void {
    this.bloomFilter.add(signalId);
    this.recentSignals.add(signalId);

    // Evict oldest from recent set incrementally to avoid spikes under high load
    if (this.recentSignals.size > this.maxRecent) {
      const evictCount = Math.min(100, this.recentSignals.size - this.maxRecent + 100);
      // Convert to array and evict oldest entries - safer than iterator during deletion
      const allIds = Array.from(this.recentSignals);
      for (let i = 0; i < evictCount && i < allIds.length; i++) {
        this.recentSignals.delete(allIds[i]);
      }
    }

    // Reset bloom filter periodically to bound false positive rate.
    // Atomic swap: build new filter from recentSignals, then replace in one assignment.
    // This prevents a window where the filter is empty and signals pass dedup.
    if (this.bloomFilter.count > this.bloomResetThreshold) {
      this.bloomGeneration++;
      const fresh = new BloomFilter(this.bloomFilter.expectedItems, this.bloomFilter.configuredFPR);
      for (const id of this.recentSignals) {
        fresh.add(id);
      }
      this.bloomFilter = fresh;
      Logger.info(
        `[ClusterBus] Bloom filter reset (generation ${this.bloomGeneration}), re-added ${this.recentSignals.size} recent signals`
      );
    }
  }

  /**
   * Cleanup idle subscriptions that haven't been invoked within their TTL.
   * Prevents subscription leak from orphaned handlers.
   */
  private cleanupIdleSubscriptions(): void {
    const now = Date.now();
    const before = this.subscriptions.size;
    for (const [id, sub] of this.subscriptions) {
      if (sub.ttlMs === 0) continue; // No TTL = permanent
      const idleMs = now - sub.lastInvokedAt;
      if (idleMs > sub.ttlMs) {
        Logger.info(
          `[ClusterBus] Cleaned up idle subscription ${id} (type=${sub.signalType}, idle=${Math.round(idleMs / 1000)}s)`
        );
        this.subscriptions.delete(id);
      }
    }
    const cleaned = before - this.subscriptions.size;
    if (cleaned > 0) {
      Logger.info(
        `[ClusterBus] Subscription cleanup: removed ${cleaned} idle subscriptions, ${this.subscriptions.size} active`
      );
    }
  }

  /** Circular index for signal history (avoids O(n) shift) */
  private historyWriteIndex = 0;
  private historyFull = false;

  private addToHistory(signal: ClusterSignal): void {
    const cap = this.config.historyCap;
    if (this.signalHistory.length < cap) {
      this.signalHistory.push(signal);
    } else {
      this.signalHistory[this.historyWriteIndex] = signal;
      this.historyFull = true;
    }
    this.historyWriteIndex = (this.historyWriteIndex + 1) % cap;
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let busInstance: ClusterBus | null = null;

/**
 * Get the global ClusterBus singleton.
 * Must be initialized via initClusterBus() first.
 */
export function getClusterBus(): ClusterBus | null {
  return busInstance;
}

/**
 * Initialize and connect the global ClusterBus.
 */
export async function initClusterBus(config: ClusterBusConfig): Promise<ClusterBus> {
  if (busInstance) {
    await busInstance.disconnect();
  }
  busInstance = new ClusterBus(config);
  await busInstance.connect();
  return busInstance;
}

/**
 * Shutdown the global ClusterBus.
 */
export async function shutdownClusterBus(): Promise<void> {
  if (busInstance) {
    await busInstance.disconnect();
    busInstance = null;
  }
}
