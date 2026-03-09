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
 * Bus Bridges — connect ClusterBus (L3) to GlobalEventBus (L1).
 *
 * Architecture:
 *   L1: GlobalEventBus (in-process, namespaced events)
 *   L3: ClusterBus (full-duplex, cross-process Redis Pub/Sub)
 *
 * These bridges enable transparent signal propagation between layers.
 *
 * @module cluster-bus/bridges
 */

import { Logger } from '../utils/logger.js';
import type { ClusterBus } from './bus.js';
import type { ClusterSignal, SignalType } from './types.js';
import { getGlobalEventBus } from '../events/global-bus.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Bridge configuration */
export interface BridgeConfig {
  /** Global event types to bridge from GlobalEventBus → ClusterBus */
  eventsToCluster: string[];
  /** Signal types to bridge from ClusterBus → GlobalEventBus */
  clusterToEvents: SignalType[];
}

/** Default bridge configuration */
const DEFAULT_BRIDGE_CONFIG: BridgeConfig = {
  eventsToCluster: ['kanban:task:critical', 'cognition:decision:recorded'],
  clusterToEvents: ['cluster:join', 'cluster:leave', 'cluster:heartbeat'],
};

/** Unsubscribe handle for all bridge connections */
export interface BridgeHandle {
  /** Disconnect all bridges */
  disconnect: () => void;
  /** Get bridge statistics */
  getStats: () => BridgeStats;
}

export interface BridgeStats {
  eventsToCluster: number;
  clusterToEvents: number;
}

// ---------------------------------------------------------------------------
// Bridge Setup
// ---------------------------------------------------------------------------

/**
 * Connect ClusterBus to GlobalEventBus.
 * Returns a handle to disconnect all bridges.
 */
export function connectBridges(
  bus: ClusterBus,
  config: Partial<BridgeConfig> = {},
): BridgeHandle {
  const cfg = { ...DEFAULT_BRIDGE_CONFIG, ...config };
  const unsubscribers: (() => void)[] = [];
  const stats: BridgeStats = {
    eventsToCluster: 0,
    clusterToEvents: 0,
  };

  const MAX_BRIDGE_HOPS = 5;

  // Guard: verify event bus is available before wiring
  let hasEventBus = true;
  try { getGlobalEventBus(); } catch { hasEventBus = false; Logger.warn('[Bridge] GlobalEventBus not available — skipping event bridges'); }

  // -----------------------------------------------------------------------
  // GlobalEventBus → ClusterBus
  // -----------------------------------------------------------------------
  if (hasEventBus && cfg.eventsToCluster.length > 0) {
    const eventBus = getGlobalEventBus();

    for (const eventType of cfg.eventsToCluster) {
      const sub = eventBus.on(eventType, (event) => {
        // Prevent amplification loops — drop events that already crossed too many bridges
        const rawHops = (event.payload as Record<string, unknown>)?._bridgeHops;
        const hops = (typeof rawHops === 'number' && Number.isFinite(rawHops) && rawHops >= 0) ? rawHops : 0;
        if (hops >= MAX_BRIDGE_HOPS) {
          Logger.debug(`[Bridge] Dropping event ${event.type} — bridge hop limit (${MAX_BRIDGE_HOPS}) reached`);
          return;
        }

        const prevPath = ((event.payload as Record<string, unknown>)?._bridgePath as string[]) ?? [];
        bus.broadcast('data:broadcast', {
          bridgedFrom: 'global-event-bus',
          eventType: event.type,
          ...event.payload,
          _bridgeHops: hops + 1,
          _bridgePath: [...prevPath, `L1→L3:${event.type}`],
        }, {
          sessionId: event.sessionId,
          agentId: event.agentId,
        }).catch((err) => {
          Logger.warn(`[Bridge] Events→ClusterBus error: ${err instanceof Error ? err.message : String(err)}`);
        });

        stats.eventsToCluster++;
      });

      unsubscribers.push(sub.unsubscribe);
    }

    Logger.debug(`[Bridge] GlobalEventBus→ClusterBus: bridging ${cfg.eventsToCluster.length} event types`);
  }

  // -----------------------------------------------------------------------
  // ClusterBus → GlobalEventBus
  // -----------------------------------------------------------------------
  if (hasEventBus && cfg.clusterToEvents.length > 0) {
    for (const signalType of cfg.clusterToEvents) {
      // Permanent subscription — bridge must not be cleaned up by idle reaper
      const sub = bus.onSignal(signalType, (signal: ClusterSignal) => {
        // Prevent amplification loops
        const payloadObj = (signal.payload && typeof signal.payload === 'object') ? signal.payload as Record<string, unknown> : {};
        const rawHops = payloadObj._bridgeHops;
        // Validate hop count is a finite non-negative number; for external signals with missing hops, default to MAX to prevent bypass
        const hops = (typeof rawHops === 'number' && Number.isFinite(rawHops) && rawHops >= 0)
          ? rawHops
          : (signal.sourceCluster !== bus.clusterId ? MAX_BRIDGE_HOPS : 0);
        if (hops >= MAX_BRIDGE_HOPS) {
          Logger.debug(`[Bridge] Dropping signal ${signal.type} — bridge hop limit (${MAX_BRIDGE_HOPS}) reached`);
          return;
        }

        const eventBus = getGlobalEventBus();

        const prevPath = (payloadObj._bridgePath as string[]) ?? [];
        eventBus.emit(
          `cluster:${signal.type}`,
          {
            signalId: signal.id,
            sourceCluster: signal.sourceCluster,
            targetCluster: signal.targetCluster,
            ...payloadObj,
            _bridgeHops: hops + 1,
            _bridgePath: [...prevPath, `L3→L1:${signal.type}`],
          },
          {
            sessionId: signal.sessionId || '',
            agentId: signal.agentId,
            sourceModule: 'cluster-bus',
          },
        );

        stats.clusterToEvents++;
      }, undefined, { ttlMs: 0 });

      unsubscribers.push(sub.unsubscribe);
    }

    Logger.debug(`[Bridge] ClusterBus→GlobalEventBus: bridging ${cfg.clusterToEvents.length} signal types`);
  }

  Logger.info('[Bridge] All bus bridges connected');

  return {
    disconnect: () => {
      for (const unsub of unsubscribers) {
        try { unsub(); } catch { /* ignore */ }
      }
      unsubscribers.length = 0;
      Logger.info('[Bridge] All bus bridges disconnected');
    },
    getStats: () => ({ ...stats }),
  };
}
