/**
 * KemdiCode MCP Server - Cluster Bus
 * Copyright (C) 2025-2026 Kemdi Sp. z o.o. (Dawid Irzyk <dawid@kemdi.pl>)
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
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
import Redis from 'ioredis';
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

/** Subscription record */
interface Subscription {
  id: string;
  signalType: SignalType | '*';
  handler: ClusterSignalHandler;
  sourceFilter?: string[];
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
  private subscriptions: Subscription[] = [];
  private seenSignals = new Set<string>();
  private readonly maxSeen = 10000;
  private signalHistory: ClusterSignal[] = [];
  private _connected = false;

  /** MetaTag-based signal router */
  readonly router: MetaTagRouter;
  /** Signal flow controller (rate limiting, backpressure, direction filtering) */
  readonly flowController: SignalFlowController;

  constructor(config: ClusterBusConfig) {
    this.config = config;
    this.router = new MetaTagRouter();
    this.flowController = new SignalFlowController();
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

      // Subscribe to broadcast channel
      await this.subscriber.psubscribe(CLUSTER_KEYS.channelBroadcast());

      // Subscribe to unicast channels for this cluster
      await this.subscriber.psubscribe(`mcp:cluster:*:${this.config.clusterId}`);

      // Handle incoming messages
      this.subscriber.on('pmessage', (_pattern: string, _channel: string, message: string) => {
        this.handleIncoming(message);
      });

      this._connected = true;
      Logger.info(`[ClusterBus] Connected as ${this.config.clusterId} (${this.config.clusterName})`);
    } catch (err) {
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
    this.subscriptions = [];
    this.seenSignals.clear();
    this.signalHistory = [];
    this.localVirtualClusters.clear();
    this.flowController.reset();
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

    await this.subscriber.psubscribe(`mcp:cluster:*:${clusterId}`);
    this.localVirtualClusters.add(clusterId);
    Logger.info(`[ClusterBus] Subscribed to virtual cluster channel: ${clusterId}`);
  }

  /**
   * Unsubscribe from a virtual cluster channel.
   */
  async unsubscribeFromCluster(clusterId: string): Promise<void> {
    if (!this.subscriber || !this._connected) return;
    if (!this.localVirtualClusters.has(clusterId)) return;

    await this.subscriber.punsubscribe(`mcp:cluster:*:${clusterId}`);
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
    } = {},
  ): Promise<string> {
    const signal = this.buildSignal(targetCluster, signalType, payload, options);

    // Loopback: deliver locally when target is self or a local virtual cluster
    if (targetCluster === this.config.clusterId || this.localVirtualClusters.has(targetCluster)) {
      this.markSeen(signal.id);
      this.addToHistory(signal);
      this.deliverToSubscriptions(signal as ClusterSignal);
      Logger.debug(`[ClusterBus] Loopback ${signal.type} → ${targetCluster} (${signal.id.slice(0, 8)})`);
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
    } = {},
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
    } = {},
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
      `[ClusterBus] Routed ${signalType} → ${result.targets.length} targets (rules: ${result.matchedRules.join(', ')})`,
    );

    return { signalId: signal.id, targets: result.targets };
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
  ): ClusterSubscription {
    const sub: Subscription = {
      id: uuidv4(),
      signalType,
      handler: handler as ClusterSignalHandler,
      sourceFilter,
    };

    this.subscriptions.push(sub);

    return {
      id: sub.id,
      unsubscribe: () => {
        const idx = this.subscriptions.findIndex((s) => s.id === sub.id);
        if (idx !== -1) this.subscriptions.splice(idx, 1);
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
    return this.signalHistory.slice(-limit);
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
    flowStats: import('./signal-flow.js').FlowStats;
  } {
    return {
      connected: this._connected,
      clusterId: this.config.clusterId,
      subscriptionCount: this.subscriptions.length,
      historySize: this.signalHistory.length,
      seenSetSize: this.seenSignals.size,
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
    },
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

    // Publish to Redis Pub/Sub
    await this.publisher.publish(channel, serialized);

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
      Logger.warn(`[ClusterBus] Failed to persist signal history: ${err instanceof Error ? err.message : String(err)}`);
    }

    Logger.debug(`[ClusterBus] Sent ${signal.type} → ${signal.targetCluster || 'broadcast'} (${signal.id.slice(0, 8)})`);
  }

  private handleIncoming(message: string): void {
    try {
      const signal = JSON.parse(message) as ClusterSignal;

      // Dedup: skip if we've seen this signal
      if (this.seenSignals.has(signal.id)) return;
      this.markSeen(signal.id);

      // Skip signals from ourselves
      if (signal.sourceCluster === this.config.clusterId) return;

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

      Logger.debug(`[ClusterBus] Received ${signal.type} from ${signal.sourceCluster} (${signal.id.slice(0, 8)})`);
    } catch (err) {
      Logger.warn(`[ClusterBus] Failed to parse incoming signal: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private deliverToSubscriptions(signal: ClusterSignal): void {
    for (const sub of this.subscriptions) {
      if (sub.signalType !== '*' && sub.signalType !== signal.type) continue;
      if (sub.sourceFilter?.length && !sub.sourceFilter.includes(signal.sourceCluster)) continue;

      try {
        const result = sub.handler(signal);
        if (result instanceof Promise) {
          result.catch((err) => {
            Logger.error(`[ClusterBus] Handler error for ${signal.type}: ${err instanceof Error ? err.message : String(err)}`);
          });
        }
      } catch (err) {
        Logger.error(`[ClusterBus] Sync handler error for ${signal.type}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private markSeen(signalId: string): void {
    this.seenSignals.add(signalId);
    // Evict oldest entries if set grows too large
    if (this.seenSignals.size > this.maxSeen) {
      const it = this.seenSignals.values();
      for (let i = 0; i < 1000; i++) {
        const next = it.next();
        if (next.done) break;
        this.seenSignals.delete(next.value);
      }
    }
  }

  private addToHistory(signal: ClusterSignal): void {
    this.signalHistory.push(signal);
    if (this.signalHistory.length > this.config.historyCap) {
      this.signalHistory.shift();
    }
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
