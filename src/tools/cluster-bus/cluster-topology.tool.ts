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

import { z } from 'zod';
import type { UnifiedTool } from '../registry.js';
import { Logger } from '../../utils/logger.js';
import {
  isClusterBusActive,
  registerCluster,
  deregisterCluster,
  listClusters,
  getTopology,
  topologyToMermaid,
  getClusterBus,
  detectStaleNodes,
  pruneStaleNodes,
} from '../../cluster-bus/index.js';

const schema = z.object({
  action: z
    .enum(['list', 'register', 'deregister', 'mermaid', 'providers', 'history', 'stale', 'prune'])
    .describe('Action: list, register/deregister, mermaid, providers, history, detect stale nodes, or prune stale'),
  clusterId: z
    .string()
    .optional()
    .describe('Cluster ID (for register/deregister)'),
  clusterName: z
    .string()
    .optional()
    .describe('Cluster name (for register)'),
  metaTags: z
    .array(z.string())
    .optional()
    .describe('Meta-tags as "key:value" strings (for register)'),
  capabilities: z
    .array(z.string())
    .optional()
    .describe('Capabilities (for register)'),
  providers: z
    .array(z.string())
    .optional()
    .describe('Connected provider IDs (for register)'),
  ttlSeconds: z
    .number()
    .min(0)
    .max(86400)
    .optional()
    .describe('TTL in seconds for registered cluster (0 = no expiry, default 300)'),
  staleThresholdMs: z
    .number()
    .min(5000)
    .max(3600000)
    .optional()
    .describe('Stale threshold in ms (for stale/prune, default 60000)'),
  limit: z
    .number()
    .min(1)
    .max(200)
    .default(50)
    .describe('Max results (for history)'),
});

export const clusterTopologyTool: UnifiedTool<typeof schema> = {
  name: 'cluster-bus-topology',
  description: 'Manage cluster bus topology: register/deregister nodes, list providers, view signal history',
  zodSchema: schema,
  metadata: {
    category: 'system',
    tags: ['cluster', 'topology', 'register', 'providers'],
    examples: [
      { args: { action: 'list' }, description: 'List all registered cluster nodes' },
      {
        args: {
          action: 'register',
          clusterName: 'gpu-cluster-1',
          metaTags: ['provider:openai', 'region:eu-west'],
          capabilities: ['llm', 'embedding'],
          providers: ['openai', 'anthropic'],
        },
        description: 'Register a new cluster node',
      },
      { args: { action: 'mermaid' }, description: 'Get topology as Mermaid diagram' },
      { args: { action: 'providers' }, description: 'List all available providers across clusters' },
      { args: { action: 'history', limit: 20 }, description: 'View recent signal history' },
      { args: { action: 'stale', staleThresholdMs: 60000 }, description: 'Detect stale nodes (>60s without heartbeat)' },
      { args: { action: 'prune', staleThresholdMs: 60000 }, description: 'Remove stale nodes from registry' },
    ],
    relatedTools: ['cluster-bus-status', 'cluster-bus-send'],
  },

  execute: async (args) => {
    switch (args.action) {
      case 'list': {
        const nodes = await listClusters();
        if (nodes.length === 0) return 'No cluster nodes registered.';

        const lines = ['# Cluster Nodes', '', `Total: ${nodes.length}`, ''];
        for (const node of nodes) {
          const tags = node.metaTags.map((t) => `${t.key}:${t.value}`).join(', ');
          lines.push(
            `### ${node.name} (\`${node.id}\`)`,
            `- Status: **${node.status}**`,
            `- Providers: ${node.connectedProviders.join(', ') || 'none'}`,
            `- Capabilities: ${node.capabilities.join(', ') || 'none'}`,
            `- Tags: ${tags || 'none'}`,
            `- Heartbeat: ${new Date(node.lastHeartbeat).toISOString()}`,
            '',
          );
        }
        return lines.join('\n');
      }

      case 'register': {
        if (!args.clusterName) return 'Error: clusterName is required for register.';

        const tagObjects = (args.metaTags || []).map((t) => {
          const idx = t.indexOf(':');
          if (idx === -1) return { key: t, value: '' };
          return { key: t.slice(0, idx), value: t.slice(idx + 1) };
        });

        const node = await registerCluster({
          id: args.clusterId,
          name: args.clusterName,
          metaTags: tagObjects,
          capabilities: args.capabilities,
          connectedProviders: args.providers,
          ttlSeconds: args.ttlSeconds,
        });

        // Subscribe local bus to virtual cluster channel for loopback routing
        const bus = getClusterBus();
        if (bus && bus.isConnected) {
          await bus.subscribeToCluster(node.id);
        }

        return `Cluster registered:\n- ID: ${node.id}\n- Name: ${node.name}\n- Status: ${node.status}`;
      }

      case 'deregister': {
        if (!args.clusterId) return 'Error: clusterId is required for deregister.';

        // Unsubscribe local bus from virtual cluster channel
        const busRef = getClusterBus();
        if (busRef && busRef.isConnected) {
          await busRef.unsubscribeFromCluster(args.clusterId);
        }

        await deregisterCluster(args.clusterId);
        return `Cluster ${args.clusterId} deregistered.`;
      }

      case 'mermaid': {
        const topology = await getTopology();
        const diagram = topologyToMermaid(topology);
        return `# Cluster Topology\n\n\`\`\`mermaid\n${diagram}\n\`\`\`\n\nNodes: ${topology.nodes.length} | Edges: ${topology.edges.length}`;
      }

      case 'providers': {
        const nodes = await listClusters();
        const providerMap = new Map<string, string[]>();

        for (const node of nodes) {
          if (node.status !== 'online') continue;
          for (const p of node.connectedProviders) {
            if (!providerMap.has(p)) providerMap.set(p, []);
            providerMap.get(p)!.push(node.name);
          }
        }

        if (providerMap.size === 0) return 'No providers available across clusters.';

        const lines = ['# Cluster Providers', ''];
        for (const [provider, clusterNames] of providerMap) {
          lines.push(`- **${provider}**: ${clusterNames.join(', ')} (${clusterNames.length} clusters)`);
        }
        return lines.join('\n');
      }

      case 'history': {
        if (!isClusterBusActive()) return 'Cluster bus not active.';
        const bus = getClusterBus();
        if (!bus) return 'Cluster bus not initialized.';

        const history = bus.getHistory(args.limit);
        if (history.length === 0) return 'No signals in history.';

        const lines = ['# Signal History', '', `Showing ${history.length} signals:`, ''];
        for (const signal of history) {
          lines.push(
            `- \`${signal.id.slice(0, 8)}\` ${signal.type} | ${signal.sourceCluster} -> ${signal.targetCluster || 'broadcast'} | P${signal.priority} | ${new Date(signal.timestamp).toISOString()}`,
          );
        }
        return lines.join('\n');
      }

      case 'stale': {
        const threshold = args.staleThresholdMs ?? 60000;
        const stale = await detectStaleNodes(threshold);

        if (stale.length === 0) {
          return `No stale nodes detected (threshold: ${threshold}ms).`;
        }

        const lines = [
          `# Stale Nodes (threshold: ${threshold}ms)`,
          '',
          `Found ${stale.length} stale node(s):`,
          '',
        ];

        for (const node of stale) {
          const idleMs = Date.now() - node.lastHeartbeat;
          lines.push(
            `- **${node.name}** (\`${node.id}\`) — idle ${Math.round(idleMs / 1000)}s, last heartbeat: ${new Date(node.lastHeartbeat).toISOString()}`,
          );
        }

        lines.push('', 'Use `action: prune` to remove these nodes from the registry.');
        return lines.join('\n');
      }

      case 'prune': {
        const threshold = args.staleThresholdMs ?? 60000;
        const pruned = await pruneStaleNodes(threshold);

        if (pruned.length === 0) {
          return `No stale nodes to prune (threshold: ${threshold}ms).`;
        }

        // Unsubscribe local bus from pruned virtual clusters
        const busRef = getClusterBus();
        if (busRef && busRef.isConnected) {
          for (const prunedId of pruned) {
            await busRef.unsubscribeFromCluster(prunedId).catch((err) => {
              Logger.debug(`[ClusterTopology] Unsubscribe from pruned cluster ${prunedId} failed: ${err instanceof Error ? err.message : String(err)}`);
            });
          }
        }

        return `Pruned ${pruned.length} stale node(s): ${pruned.join(', ')}`;
      }
    }
  },
};
