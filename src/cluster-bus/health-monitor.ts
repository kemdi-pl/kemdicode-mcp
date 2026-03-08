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
 * Cluster Health Monitor
 *
 * Manages heartbeat broadcasting, stale node detection, and
 * cluster health event propagation. Runs periodic tasks to
 * keep the cluster mesh healthy.
 *
 * @module cluster-bus/health-monitor
 */

import { Logger } from '../utils/logger.js';
import type { ClusterBus } from './bus.js';
import type { ClusterBusConfig, SignalPayloadMap } from './types.js';
import { updateHeartbeat, detectStaleNodes, deregisterCluster, listClusters } from './cluster-registry.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Health monitor statistics */
export interface HealthMonitorStats {
  /** Total heartbeats sent */
  heartbeatsSent: number;
  /** Total stale nodes detected (cumulative) */
  staleNodesDetected: number;
  /** Total stale nodes pruned (cumulative) */
  staleNodesPruned: number;
  /** Whether the monitor is running */
  running: boolean;
  /** Last heartbeat timestamp */
  lastHeartbeatAt: number;
  /** Current online cluster count (from last check) */
  onlineClusterCount: number;
}

/** Health event handler */
export type HealthEventHandler = (event: HealthEvent) => void | Promise<void>;

/** Health event types */
export interface HealthEvent {
  type: 'node-stale' | 'node-pruned' | 'node-joined' | 'node-left' | 'heartbeat-sent';
  clusterId: string;
  clusterName?: string;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// ClusterHealthMonitor
// ---------------------------------------------------------------------------

/**
 * ClusterHealthMonitor — heartbeat and stale node management.
 *
 * Lifecycle:
 *   const monitor = new ClusterHealthMonitor(bus, config);
 *   monitor.start();
 *   // ... runs periodic heartbeat + pruning ...
 *   monitor.stop();
 */
export class ClusterHealthMonitor {
  private bus: ClusterBus;
  private config: ClusterBusConfig;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private pruneInterval: ReturnType<typeof setInterval> | null = null;
  private _running = false;
  private _pruning = false;
  private handlers = new Map<string, HealthEventHandler>();
  private handlerIdCounter = 0;

  private stats: HealthMonitorStats = {
    heartbeatsSent: 0,
    staleNodesDetected: 0,
    staleNodesPruned: 0,
    running: false,
    lastHeartbeatAt: 0,
    onlineClusterCount: 0,
  };

  constructor(bus: ClusterBus, config: ClusterBusConfig) {
    this.bus = bus;
    this.config = config;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Start the health monitor (heartbeats + pruning). */
  start(): void {
    if (this._running) return;
    this._running = true;
    this.stats.running = true;

    // Heartbeat loop
    this.heartbeatInterval = setInterval(() => {
      this.sendHeartbeat().catch((err) => {
        Logger.warn(`[HealthMonitor] Heartbeat error: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, this.config.heartbeatIntervalMs);

    // Prune loop (3x heartbeat interval)
    this.pruneInterval = setInterval(() => {
      this.checkAndPrune().catch((err) => {
        Logger.warn(`[HealthMonitor] Prune error: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, this.config.heartbeatIntervalMs * 3);

    // Send initial heartbeat
    this.sendHeartbeat().catch(() => {});

    Logger.info(
      `[HealthMonitor] Started (heartbeat: ${this.config.heartbeatIntervalMs}ms, stale threshold: ${this.config.staleThresholdMs}ms)`,
    );
  }

  /** Stop the health monitor. */
  stop(): void {
    if (!this._running) return;
    this._running = false;
    this.stats.running = false;

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.pruneInterval) {
      clearInterval(this.pruneInterval);
      this.pruneInterval = null;
    }

    Logger.info('[HealthMonitor] Stopped');
  }

  get isRunning(): boolean {
    return this._running;
  }

  // -------------------------------------------------------------------------
  // Event Handlers
  // -------------------------------------------------------------------------

  /** Register a health event handler. Returns unsubscribe function. */
  onHealthEvent(handler: HealthEventHandler): () => void {
    const id = `heh-${++this.handlerIdCounter}`;
    this.handlers.set(id, handler);
    return () => {
      this.handlers.delete(id);
    };
  }

  // -------------------------------------------------------------------------
  // Stats
  // -------------------------------------------------------------------------

  /** Get health monitor statistics. */
  getStats(): HealthMonitorStats {
    return { ...this.stats };
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private async sendHeartbeat(): Promise<void> {
    // Update our own heartbeat in the registry
    await updateHeartbeat(this.config.clusterId, 'online');

    // Broadcast heartbeat signal to other clusters
    const payload: SignalPayloadMap['cluster:heartbeat'] = {
      clusterId: this.config.clusterId,
      status: 'online',
    };

    await this.bus.broadcast('cluster:heartbeat', payload, {
      direction: 'duplex',
      priority: 0,
    });

    this.stats.heartbeatsSent++;
    this.stats.lastHeartbeatAt = Date.now();

    this.emitHealthEvent({
      type: 'heartbeat-sent',
      clusterId: this.config.clusterId,
      timestamp: Date.now(),
    });
  }

  private async checkAndPrune(): Promise<void> {
    if (this._pruning) return;
    this._pruning = true;

    try {
    // Detect stale nodes (exclude local virtual clusters — they don't send heartbeats)
    const allStale = await detectStaleNodes(this.config.staleThresholdMs);
    const stale = allStale.filter((n) => !this.bus.isLocalVirtualCluster(n.id));

    if (stale.length > 0) {
      this.stats.staleNodesDetected += stale.length;

      for (const node of stale) {
        this.emitHealthEvent({
          type: 'node-stale',
          clusterId: node.id,
          clusterName: node.name,
          timestamp: Date.now(),
        });
      }

      // Prune only non-virtual stale nodes
      const pruned: string[] = [];
      for (const node of stale) {
        await deregisterCluster(node.id);
        pruned.push(node.id);
      }
      if (pruned.length > 0) {
        Logger.info(`[HealthMonitor] Pruned ${pruned.length} stale nodes: ${pruned.join(', ')}`);
      }
      this.stats.staleNodesPruned += pruned.length;

      for (const prunedId of pruned) {
        this.emitHealthEvent({
          type: 'node-pruned',
          clusterId: prunedId,
          timestamp: Date.now(),
        });
      }
    }

    // Update online count
    const all = await listClusters();
    this.stats.onlineClusterCount = all.filter((n) => n.status === 'online').length;
    } finally {
      this._pruning = false;
    }
  }

  private emitHealthEvent(event: HealthEvent): void {
    for (const handler of this.handlers.values()) {
      try {
        const result = handler(event);
        if (result instanceof Promise) {
          result.catch((err) => {
            Logger.warn(`[HealthMonitor] Handler error: ${err instanceof Error ? err.message : String(err)}`);
          });
        }
      } catch (err) {
        Logger.warn(`[HealthMonitor] Sync handler error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}
