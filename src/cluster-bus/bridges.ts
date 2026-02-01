/**
 * KemdiCode MCP Server - Cluster Bus Bridges
 * Copyright (C) 2025-2026 Kemdi Sp. z o.o. (Dawid Irzyk <dawid@kemdi.pl>)
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

/**
 * Bus Bridges — connect ClusterBus (L3) to DataFlowBus (L2) and GlobalEventBus (L1).
 *
 * Architecture:
 *   L1: GlobalEventBus (in-process, namespaced events)
 *   L2: DataFlowBus (typed channels, in-process + Redis)
 *   L3: ClusterBus (full-duplex, cross-process Redis Pub/Sub)
 *
 * These bridges enable transparent signal propagation between layers.
 *
 * @module cluster-bus/bridges
 */

import { Logger } from '../utils/logger.js';
import type { ClusterBus } from './bus.js';
import type { ClusterSignal, SignalType } from './types.js';
import { getDataFlowBus } from '../dataflow/bus.js';
import type { DataFlowChannel } from '../dataflow/types.js';
import { getGlobalEventBus } from '../events/global-bus.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Bridge configuration */
export interface BridgeConfig {
  /** Signal types to bridge from ClusterBus → DataFlowBus */
  clusterToDataFlow: SignalType[];
  /** DataFlow channels to bridge from DataFlowBus → ClusterBus */
  dataFlowToCluster: DataFlowChannel[];
  /** Global event types to bridge from GlobalEventBus → ClusterBus */
  eventsToCluster: string[];
  /** Signal types to bridge from ClusterBus → GlobalEventBus */
  clusterToEvents: SignalType[];
}

/** Default bridge configuration */
const DEFAULT_BRIDGE_CONFIG: BridgeConfig = {
  clusterToDataFlow: ['llm:result', 'llm:error', 'data:broadcast'],
  dataFlowToCluster: ['ai:completion', 'agent:status', 'system:health'],
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
  clusterToDataFlow: number;
  dataFlowToCluster: number;
  eventsToCluster: number;
  clusterToEvents: number;
}

// ---------------------------------------------------------------------------
// Bridge Setup
// ---------------------------------------------------------------------------

/**
 * Connect ClusterBus to both DataFlowBus and GlobalEventBus.
 * Returns a handle to disconnect all bridges.
 */
export function connectBridges(
  bus: ClusterBus,
  config: Partial<BridgeConfig> = {},
): BridgeHandle {
  const cfg = { ...DEFAULT_BRIDGE_CONFIG, ...config };
  const unsubscribers: (() => void)[] = [];
  const stats: BridgeStats = {
    clusterToDataFlow: 0,
    dataFlowToCluster: 0,
    eventsToCluster: 0,
    clusterToEvents: 0,
  };

  // -----------------------------------------------------------------------
  // ClusterBus → DataFlowBus
  // -----------------------------------------------------------------------
  if (cfg.clusterToDataFlow.length > 0) {
    for (const signalType of cfg.clusterToDataFlow) {
      const sub = bus.onSignal(signalType, (signal: ClusterSignal) => {
        const dataflowBus = getDataFlowBus();
        const channel = mapSignalToDataFlowChannel(signal.type);
        if (!channel) return;

        dataflowBus.publish(channel, signal.payload as Record<string, unknown>, {
          source: `cluster:${signal.sourceCluster}`,
          sessionId: signal.sessionId,
          agentId: signal.agentId,
          correlationId: signal.correlationId,
          priority: signal.priority,
        }).catch((err) => {
          Logger.warn(`[Bridge] ClusterBus→DataFlow error: ${err instanceof Error ? err.message : String(err)}`);
        });

        stats.clusterToDataFlow++;
      });

      unsubscribers.push(sub.unsubscribe);
    }

    Logger.debug(`[Bridge] ClusterBus→DataFlowBus: bridging ${cfg.clusterToDataFlow.length} signal types`);
  }

  // -----------------------------------------------------------------------
  // DataFlowBus → ClusterBus
  // -----------------------------------------------------------------------
  if (cfg.dataFlowToCluster.length > 0) {
    const dataflowBus = getDataFlowBus();

    for (const channel of cfg.dataFlowToCluster) {
      const unsub = dataflowBus.subscribe(channel, (envelope) => {
        // Don't bridge back signals that came from the cluster bus
        if (typeof envelope.source === 'string' && envelope.source.startsWith('cluster:')) return;

        const signalType = mapDataFlowToSignalType(channel);
        if (!signalType) return;

        bus.broadcast(signalType, envelope.payload, {
          correlationId: envelope.correlationId,
          priority: envelope.priority,
          sessionId: envelope.sessionId,
          agentId: envelope.agentId,
        }).catch((err) => {
          Logger.warn(`[Bridge] DataFlow→ClusterBus error: ${err instanceof Error ? err.message : String(err)}`);
        });

        stats.dataFlowToCluster++;
      });

      unsubscribers.push(unsub);
    }

    Logger.debug(`[Bridge] DataFlowBus→ClusterBus: bridging ${cfg.dataFlowToCluster.length} channels`);
  }

  // -----------------------------------------------------------------------
  // GlobalEventBus → ClusterBus
  // -----------------------------------------------------------------------
  if (cfg.eventsToCluster.length > 0) {
    const eventBus = getGlobalEventBus();

    for (const eventType of cfg.eventsToCluster) {
      const sub = eventBus.on(eventType, (event) => {
        bus.broadcast('data:broadcast', {
          bridgedFrom: 'global-event-bus',
          eventType: event.type,
          ...event.payload,
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
  if (cfg.clusterToEvents.length > 0) {
    for (const signalType of cfg.clusterToEvents) {
      const sub = bus.onSignal(signalType, (signal: ClusterSignal) => {
        const eventBus = getGlobalEventBus();

        eventBus.emit(
          `cluster:${signal.type}`,
          {
            signalId: signal.id,
            sourceCluster: signal.sourceCluster,
            targetCluster: signal.targetCluster,
            ...((signal.payload && typeof signal.payload === 'object') ? signal.payload as Record<string, unknown> : {}),
          },
          {
            sessionId: signal.sessionId || '',
            agentId: signal.agentId,
            sourceModule: 'cluster-bus',
          },
        );

        stats.clusterToEvents++;
      });

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

// ---------------------------------------------------------------------------
// Mapping Helpers
// ---------------------------------------------------------------------------

/** Map ClusterBus signal type to DataFlowBus channel. */
function mapSignalToDataFlowChannel(signalType: SignalType): DataFlowChannel | null {
  const map: Partial<Record<SignalType, DataFlowChannel>> = {
    'llm:result': 'ai:completion',
    'llm:error': 'cognition:error',
    'data:broadcast': 'system:config',
    'cluster:heartbeat': 'system:health',
    'cluster:join': 'agent:status',
    'cluster:leave': 'agent:status',
  };
  return map[signalType] ?? null;
}

/** Map DataFlowBus channel to ClusterBus signal type. */
function mapDataFlowToSignalType(channel: DataFlowChannel): SignalType | null {
  const map: Partial<Record<DataFlowChannel, SignalType>> = {
    'ai:completion': 'data:unicast',
    'agent:status': 'data:broadcast',
    'system:health': 'cluster:heartbeat',
  };
  return map[channel] ?? null;
}
