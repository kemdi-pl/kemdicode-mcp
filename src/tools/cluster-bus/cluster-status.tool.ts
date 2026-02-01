/**
 * KemdiCode MCP Server - Cluster Bus Status Tool
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
  getClusterBusSystemStatus,
  isClusterBusActive,
  listClusters,
  getTopology,
  topologyToMermaid,
} from '../../cluster-bus/index.js';

const schema = z.object({
  view: z
    .enum(['summary', 'topology', 'mermaid', 'nodes'])
    .default('summary')
    .describe('View: summary, topology graph, mermaid diagram, or node list'),
});

export const clusterStatusTool: UnifiedTool<typeof schema> = {
  name: 'cluster-bus-status',
  description: 'View cluster bus status, topology, and connected nodes',
  zodSchema: schema,
  metadata: {
    category: 'cluster-bus',
    tags: ['cluster', 'status', 'topology', 'monitoring'],
    examples: [
      { args: {}, description: 'Quick cluster bus status' },
      { args: { view: 'topology' }, description: 'Full topology graph' },
      { args: { view: 'mermaid' }, description: 'Mermaid diagram of cluster mesh' },
      { args: { view: 'nodes' }, description: 'List all registered cluster nodes' },
    ],
    relatedTools: ['cluster-bus-send', 'cluster-bus-topology', 'cluster-bus-magistrale'],
  },

  execute: async (args) => {
    if (!isClusterBusActive()) {
      return '# Cluster Bus\n\n**Status:** Inactive\n\nCluster bus failed to initialize. Check Redis connectivity and server logs.';
    }

    const status = getClusterBusSystemStatus();

    switch (args.view) {
      case 'summary': {
        const lines = [
          '# Cluster Bus Status',
          '',
          `- **Active:** ${status.active ? 'Yes' : 'No'}`,
          `- **Cluster ID:** ${status.clusterId || 'N/A'}`,
          `- **Health Monitor:** ${status.healthMonitorRunning ? 'Running' : 'Stopped'}`,
          `- **Bridges:** ${status.bridgesConnected ? 'Connected' : 'Disconnected'}`,
        ];

        if (status.busStats) {
          lines.push(
            '',
            '## Bus Stats',
            `- Subscriptions: ${status.busStats.subscriptionCount}`,
            `- History Size: ${status.busStats.historySize}`,
            `- Seen Set: ${status.busStats.seenSetSize}`,
          );

          const flow = status.busStats.flowStats;
          lines.push(
            '',
            '## Flow Control',
            `- Processed: ${flow.totalProcessed}`,
            `- Dropped: ${flow.totalDropped}`,
            `- Queued: ${flow.totalQueued}`,
            `- Under Pressure: ${flow.pressuredChannels.length > 0 ? flow.pressuredChannels.join(', ') : 'None'}`,
          );
        }

        if (status.healthStats) {
          lines.push(
            '',
            '## Health Monitor',
            `- Heartbeats Sent: ${status.healthStats.heartbeatsSent}`,
            `- Online Clusters: ${status.healthStats.onlineClusterCount}`,
            `- Stale Detected: ${status.healthStats.staleNodesDetected}`,
            `- Pruned: ${status.healthStats.staleNodesPruned}`,
          );
        }

        return lines.join('\n');
      }

      case 'topology': {
        const topology = await getTopology();
        const lines = [
          '# Cluster Topology',
          '',
          `**Nodes:** ${topology.nodes.length} | **Edges:** ${topology.edges.length} | **Snapshot:** ${new Date(topology.snapshotAt).toISOString()}`,
          '',
        ];

        for (const node of topology.nodes) {
          const tags = node.metaTags.map((t) => `${t.key}:${t.value}`).join(', ');
          lines.push(
            `## ${node.name} (${node.id})`,
            `- Status: ${node.status}`,
            `- Providers: ${node.connectedProviders.join(', ') || 'none'}`,
            `- Capabilities: ${node.capabilities.join(', ') || 'none'}`,
            `- Tags: ${tags || 'none'}`,
            `- Last Heartbeat: ${new Date(node.lastHeartbeat).toISOString()}`,
            '',
          );
        }

        return lines.join('\n');
      }

      case 'mermaid': {
        const topology = await getTopology();
        const diagram = topologyToMermaid(topology);
        return `# Cluster Topology (Mermaid)\n\n\`\`\`mermaid\n${diagram}\n\`\`\``;
      }

      case 'nodes': {
        const nodes = await listClusters();
        if (nodes.length === 0) {
          return 'No cluster nodes registered.';
        }

        const lines = ['# Cluster Nodes', '', `Total: ${nodes.length}`, ''];
        for (const node of nodes) {
          lines.push(
            `| ${node.id} | ${node.name} | ${node.status} | ${node.connectedProviders.join(',')} | ${new Date(node.lastHeartbeat).toISOString()} |`,
          );
        }

        return lines.join('\n');
      }

      default:
        return 'Unknown view.';
    }
  },
};
