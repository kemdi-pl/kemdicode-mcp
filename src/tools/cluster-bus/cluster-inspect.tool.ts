/**
 * KemdiCode MCP Server - Cluster Bus Inspect Tool
 * Copyright (C) 2025-2026 Kemdi Sp. z o.o. (Dawid Irzyk <dawid@kemdi.pl>)
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import { z } from 'zod';
import type { UnifiedTool } from '../registry.js';
import {
  isClusterBusActive,
  getClusterBus,
  getHealthMonitor,
  getBridgeHandle,
  getClusterBusSystemStatus,
} from '../../cluster-bus/index.js';
import { getGlobalEventBus } from '../../events/global-bus.js';

const schema = z.object({
  view: z
    .enum([
      'signal-history',
      'health-events',
      'bridge-stats',
      'subscription-diagnostics',
      'bloom-stats',
      'full-report',
    ])
    .describe('Inspection view'),

  // For signal-history
  limit: z
    .number()
    .min(1)
    .max(200)
    .default(30)
    .describe('Max results for history views'),

  // For signal-history filtering
  signalType: z
    .string()
    .optional()
    .describe('Filter history by signal type'),
  sourceCluster: z
    .string()
    .optional()
    .describe('Filter history by source cluster'),
});

export const clusterInspectTool: UnifiedTool<typeof schema> = {
  name: 'cluster-bus-inspect',
  description:
    'Deep inspection of cluster bus internals: signal history, health events, bridge stats, subscription diagnostics, bloom filter',
  zodSchema: schema,
  metadata: {
    category: 'cluster-bus',
    tags: ['cluster', 'inspect', 'diagnostics', 'history', 'health', 'bridge'],
    examples: [
      { args: { view: 'signal-history', limit: 20 }, description: 'Recent signal history' },
      { args: { view: 'signal-history', signalType: 'llm:request', limit: 10 }, description: 'LLM request history' },
      { args: { view: 'health-events' }, description: 'Health monitor events and stats' },
      { args: { view: 'bridge-stats' }, description: 'Cross-layer bridge statistics' },
      { args: { view: 'subscription-diagnostics' }, description: 'Subscription health and idle analysis' },
      { args: { view: 'bloom-stats' }, description: 'Bloom filter deduplication statistics' },
      { args: { view: 'full-report' }, description: 'Comprehensive diagnostic report' },
    ],
    relatedTools: ['cluster-bus-status', 'cluster-bus-flow', 'cluster-bus-routing'],
  },

  execute: async (args) => {
    if (!isClusterBusActive()) {
      return 'Cluster bus is not active. Check Redis connectivity and server logs.';
    }

    const bus = getClusterBus();
    if (!bus) return 'Cluster bus not initialized.';

    switch (args.view) {
      case 'signal-history': {
        let history = bus.getHistory(args.limit);

        // Apply filters
        if (args.signalType) {
          history = history.filter((s) => s.type === args.signalType);
        }
        if (args.sourceCluster) {
          history = history.filter((s) => s.sourceCluster === args.sourceCluster);
        }

        if (history.length === 0) {
          return 'No signals in history' +
            (args.signalType ? ` matching type '${args.signalType}'` : '') +
            (args.sourceCluster ? ` from '${args.sourceCluster}'` : '') +
            '.';
        }

        const lines = [
          '# Signal History',
          '',
          `Showing ${history.length} signals${args.signalType ? ` (type: ${args.signalType})` : ''}${args.sourceCluster ? ` (source: ${args.sourceCluster})` : ''}:`,
          '',
          '| ID | Type | Source → Target | Dir | P | Time |',
          '|----|------|-----------------|-----|---|------|',
        ];

        for (const s of history) {
          lines.push(
            `| \`${s.id.slice(0, 8)}\` | ${s.type} | ${s.sourceCluster} → ${s.targetCluster || 'broadcast'} | ${s.direction} | ${s.priority} | ${new Date(s.timestamp).toISOString().slice(11, 23)} |`,
          );
        }

        // Signal type distribution
        const typeCounts = new Map<string, number>();
        for (const s of history) {
          typeCounts.set(s.type, (typeCounts.get(s.type) || 0) + 1);
        }

        lines.push('', '### Type Distribution');
        for (const [type, count] of [...typeCounts.entries()].sort((a, b) => b[1] - a[1])) {
          lines.push(`- **${type}**: ${count}`);
        }

        return lines.join('\n');
      }

      case 'health-events': {
        const monitor = getHealthMonitor();
        if (!monitor) return 'Health monitor not initialized.';

        const stats = monitor.getStats();

        return [
          '# Health Monitor',
          '',
          `- **Running:** ${stats.running ? 'Yes' : 'No'}`,
          `- **Heartbeats Sent:** ${stats.heartbeatsSent}`,
          `- **Last Heartbeat:** ${stats.lastHeartbeatAt ? new Date(stats.lastHeartbeatAt).toISOString() : 'never'}`,
          `- **Online Clusters:** ${stats.onlineClusterCount}`,
          `- **Stale Nodes Detected:** ${stats.staleNodesDetected}`,
          `- **Stale Nodes Pruned:** ${stats.staleNodesPruned}`,
        ].join('\n');
      }

      case 'bridge-stats': {
        const bridge = getBridgeHandle();
        if (!bridge) return 'Bus bridges not connected.';

        const stats = bridge.getStats();

        return [
          '# Bridge Statistics',
          '',
          '| Direction | Messages Bridged |',
          '|-----------|-----------------|',
          `| ClusterBus → DataFlowBus | ${stats.clusterToDataFlow} |`,
          `| DataFlowBus → ClusterBus | ${stats.dataFlowToCluster} |`,
          `| GlobalEventBus → ClusterBus | ${stats.eventsToCluster} |`,
          `| ClusterBus → GlobalEventBus | ${stats.clusterToEvents} |`,
          '',
          `**Total bridged:** ${stats.clusterToDataFlow + stats.dataFlowToCluster + stats.eventsToCluster + stats.clusterToEvents}`,
        ].join('\n');
      }

      case 'subscription-diagnostics': {
        const busStats = bus.getStats();

        const lines = [
          '# Subscription Diagnostics',
          '',
          '## Cluster Bus',
          `- **Active Subscriptions:** ${busStats.subscriptionCount}`,
        ];

        // GlobalEventBus diagnostics
        try {
          const eventBus = getGlobalEventBus();
          const diag = eventBus.getSubscriptionDiagnostics();

          lines.push(
            '',
            '## Global Event Bus',
            `- **Active Subscriptions:** ${diag.total}`,
            `- **Oldest Idle:** ${diag.oldestIdleMs > 0 ? `${Math.round(diag.oldestIdleMs / 60000)}min` : 'N/A'}`,
            '',
            '### By Event Type',
          );

          const sorted = Object.entries(diag.byEventType).sort((a, b) => b[1] - a[1]);
          for (const [type, count] of sorted) {
            lines.push(`- **${type}**: ${count}`);
          }
        } catch {
          lines.push('', '## Global Event Bus', 'Not available.');
        }

        // Listener count from emitter
        const listenerCounts = eventBusListenerCounts();
        if (listenerCounts) {
          lines.push(
            '',
            '## Event Listener Counts',
          );
          const sorted = Object.entries(listenerCounts).sort((a, b) => b[1] - a[1]).slice(0, 15);
          for (const [event, count] of sorted) {
            lines.push(`- **${event}**: ${count}`);
          }
        }

        return lines.join('\n');
      }

      case 'bloom-stats': {
        const stats = bus.getStats();

        return [
          '# Bloom Filter Statistics',
          '',
          `- **Memory:** ${formatBytes(stats.bloomMemoryBytes)}`,
          `- **Generation:** ${stats.bloomGeneration}`,
          `- **Recent Set Size:** ${stats.recentSetSize}`,
          `- **History Size:** ${stats.historySize}`,
          `- **Seen Set (total):** ${stats.seenSetSize}`,
          '',
          '## Deduplication Efficiency',
          `- Bloom filter provides O(1) membership testing with ~0.01% false positive rate`,
          `- Recent set (exact, last 2000) catches bloom filter false positives`,
          `- Auto-reset every 15K signals to prevent bloom saturation`,
        ].join('\n');
      }

      case 'full-report': {
        const status = getClusterBusSystemStatus();
        const busStats = bus.getStats();
        const flowStats = bus.flowController.getStats();
        const monitor = getHealthMonitor();
        const bridge = getBridgeHandle();

        const lines = [
          '# Cluster Bus Full Diagnostic Report',
          '',
          `**Timestamp:** ${new Date().toISOString()}`,
          `**Cluster ID:** ${status.clusterId || 'N/A'}`,
          '',
          '## System Status',
          `- Active: ${status.active ? 'Yes' : 'No'}`,
          `- Health Monitor: ${status.healthMonitorRunning ? 'Running' : 'Stopped'}`,
          `- Bridges: ${status.bridgesConnected ? 'Connected' : 'Disconnected'}`,
          '',
          '## Bus Stats',
          `- Subscriptions: ${busStats.subscriptionCount}`,
          `- History Size: ${busStats.historySize}`,
          `- Seen Set: ${busStats.seenSetSize}`,
          `- Bloom Memory: ${formatBytes(busStats.bloomMemoryBytes)}`,
          `- Bloom Generation: ${busStats.bloomGeneration}`,
          `- Recent Set: ${busStats.recentSetSize}`,
          '',
          '## Flow Control',
          `- Processed: ${flowStats.totalProcessed}`,
          `- Dropped: ${flowStats.totalDropped}`,
          `- Queued: ${flowStats.totalQueued}`,
          `- Policies: ${bus.flowController.getPolicies().length}`,
          `- Pressured Channels: ${flowStats.pressuredChannels.length > 0 ? flowStats.pressuredChannels.join(', ') : 'none'}`,
          '',
          '## Routing',
          `- Rules: ${bus.router.getRules().length}`,
        ];

        if (monitor) {
          const mStats = monitor.getStats();
          lines.push(
            '',
            '## Health Monitor',
            `- Heartbeats Sent: ${mStats.heartbeatsSent}`,
            `- Online Clusters: ${mStats.onlineClusterCount}`,
            `- Stale Detected: ${mStats.staleNodesDetected}`,
            `- Pruned: ${mStats.staleNodesPruned}`,
          );
        }

        if (bridge) {
          const bStats = bridge.getStats();
          const total = bStats.clusterToDataFlow + bStats.dataFlowToCluster + bStats.eventsToCluster + bStats.clusterToEvents;
          lines.push(
            '',
            '## Bridges',
            `- Cluster→DataFlow: ${bStats.clusterToDataFlow}`,
            `- DataFlow→Cluster: ${bStats.dataFlowToCluster}`,
            `- Events→Cluster: ${bStats.eventsToCluster}`,
            `- Cluster→Events: ${bStats.clusterToEvents}`,
            `- Total bridged: ${total}`,
          );
        }

        // GlobalEventBus
        try {
          const eventBus = getGlobalEventBus();
          const diag = eventBus.getSubscriptionDiagnostics();
          lines.push(
            '',
            '## Global Event Bus',
            `- Active Subscriptions: ${diag.total}`,
            `- Oldest Idle: ${diag.oldestIdleMs > 0 ? `${Math.round(diag.oldestIdleMs / 60000)}min` : 'N/A'}`,
          );
        } catch { /* ignore diagnostic errors */ }

        return lines.join('\n');
      }

      default:
        return 'Unknown view.';
    }
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function eventBusListenerCounts(): Record<string, number> | null {
  try {
    const eventBus = getGlobalEventBus();
    return eventBus.getListenerCounts();
  } catch {
    return null;
  }
}
