/**
 * KemdiCode MCP Server - Cluster Bus Initialization
 * Copyright (C) 2025-2026 Kemdi Sp. z o.o. (Dawid Irzyk <dawid@kemdi.pl>)
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

/**
 * Cluster Bus Initialization
 *
 * Orchestrates startup of the entire cluster bus subsystem:
 * 1. Load config from environment
 * 2. Initialize ClusterBus (connect Redis Pub/Sub)
 * 3. Register custom endpoints into provider registry
 * 4. Register this node in the cluster registry
 * 5. Start health monitor (heartbeats + pruning)
 * 6. Connect bus bridges (L1 ↔ L2 ↔ L3)
 * 7. Apply default flow policies
 *
 * @module cluster-bus/init
 */

import { Logger } from '../utils/logger.js';
import { loadClusterBusConfig } from './types.js';
import { initClusterBus, shutdownClusterBus, getClusterBus } from './bus.js';
import { registerCluster, deregisterCluster } from './cluster-registry.js';
import { ClusterHealthMonitor } from './health-monitor.js';
import { connectBridges } from './bridges.js';
import type { BridgeHandle } from './bridges.js';
import { defaultLLMPolicy, defaultControlPolicy, defaultHeartbeatPolicy } from './signal-flow.js';
import { routeToAnyLLM } from './meta-router.js';
import { registerCustomEndpoint } from '../ai/providers/registry.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let healthMonitor: ClusterHealthMonitor | null = null;
let bridgeHandle: BridgeHandle | null = null;
let registeredClusterId: string | null = null;

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

/**
 * Initialize the cluster bus subsystem.
 *
 * Reads config from environment (MCP_CLUSTER_*), connects Redis,
 * registers in the cluster mesh, starts heartbeats, and wires bridges.
 *
 * Returns false if cluster bus is disabled (MCP_CLUSTER_ENABLED != 1).
 */
export async function initClusterBusSystem(): Promise<boolean> {
  const config = loadClusterBusConfig();

  if (!config.enabled) {
    Logger.debug('[ClusterBus] Disabled (MCP_CLUSTER_ENABLED not set)');
    return false;
  }

  try {
    Logger.info(`[ClusterBus] Initializing cluster bus: ${config.clusterId} (${config.clusterName})`);

    // 1. Initialize ClusterBus (Redis connections)
    const bus = await initClusterBus(config);

    // 2. Register custom endpoints from config into provider registry
    const customProviderIds: string[] = [];
    for (const ep of config.customEndpoints) {
      const providerId = registerCustomEndpoint({
        name: ep.name,
        displayName: ep.displayName,
        baseURL: ep.baseURL,
        apiKey: ep.requiresApiKey ? (process.env[`MCP_CUSTOM_${ep.name.toUpperCase()}_KEY`] || '') : '',
        defaultModel: ep.defaultModel,
        models: ep.models,
      });
      customProviderIds.push(providerId);
    }

    // 3. Register this node in the cluster registry
    await registerCluster({
      id: config.clusterId,
      name: config.clusterName,
      metaTags: config.metaTags,
      connectedProviders: customProviderIds,
      customEndpoints: config.customEndpoints,
      capabilities: ['llm', 'code-analysis', 'kanban', 'memory', 'cognition'],
    });
    registeredClusterId = config.clusterId;

    // 4. Apply default flow policies
    bus.flowController.addPolicy(defaultLLMPolicy());
    bus.flowController.addPolicy(defaultControlPolicy());
    bus.flowController.addPolicy(defaultHeartbeatPolicy());

    // 5. Add default routing rule
    bus.router.addRule(routeToAnyLLM());

    // 6. Start health monitor
    healthMonitor = new ClusterHealthMonitor(bus, config);
    healthMonitor.start();

    // 7. Connect bridges (L1 ↔ L2 ↔ L3)
    bridgeHandle = connectBridges(bus);

    Logger.info(
      `[ClusterBus] System ready: ${config.clusterId} | tags: ${config.metaTags.map((t) => `${t.key}:${t.value}`).join(', ') || 'none'}`,
    );

    return true;
  } catch (err) {
    Logger.error(`[ClusterBus] Initialization failed:`, err);
    // Attempt cleanup
    await shutdownClusterBusSystem().catch(() => {});
    return false;
  }
}

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

/**
 * Gracefully shut down the cluster bus subsystem.
 */
export async function shutdownClusterBusSystem(): Promise<void> {
  // Disconnect bridges
  if (bridgeHandle) {
    bridgeHandle.disconnect();
    bridgeHandle = null;
  }

  // Stop health monitor
  if (healthMonitor) {
    healthMonitor.stop();
    healthMonitor = null;
  }

  // Deregister from cluster mesh
  if (registeredClusterId) {
    try {
      await deregisterCluster(registeredClusterId);
    } catch {
      // Ignore deregistration errors during shutdown
    }
    registeredClusterId = null;
  }

  // Shutdown bus
  await shutdownClusterBus();

  Logger.info('[ClusterBus] System shut down');
}

// ---------------------------------------------------------------------------
// Accessors
// ---------------------------------------------------------------------------

/** Get the health monitor instance (null if not initialized). */
export function getHealthMonitor(): ClusterHealthMonitor | null {
  return healthMonitor;
}

/** Get the bridge handle (null if not initialized). */
export function getBridgeHandle(): BridgeHandle | null {
  return bridgeHandle;
}

/** Check if the cluster bus subsystem is active. */
export function isClusterBusActive(): boolean {
  const bus = getClusterBus();
  return bus !== null && bus.isConnected;
}

/** Get a summary of the cluster bus system state. */
export function getClusterBusSystemStatus(): {
  active: boolean;
  clusterId: string | null;
  healthMonitorRunning: boolean;
  bridgesConnected: boolean;
  busStats: ReturnType<NonNullable<ReturnType<typeof getClusterBus>>['getStats']> | null;
  healthStats: ReturnType<ClusterHealthMonitor['getStats']> | null;
  bridgeStats: ReturnType<NonNullable<BridgeHandle>['getStats']> | null;
} {
  const bus = getClusterBus();

  return {
    active: bus !== null && bus.isConnected,
    clusterId: registeredClusterId,
    healthMonitorRunning: healthMonitor?.isRunning ?? false,
    bridgesConnected: bridgeHandle !== null,
    busStats: bus?.getStats() ?? null,
    healthStats: healthMonitor?.getStats() ?? null,
    bridgeStats: bridgeHandle?.getStats() ?? null,
  };
}
