/**
 * KemdiCode MCP Server - Cluster Topology Tool
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
  registerCluster,
  deregisterCluster,
  listClusters,
  getTopology,
  topologyToMermaid,
  getClusterBus,
} from '../../cluster-bus/index.js';

const schema = z.object({
  action: z
    .enum(['list', 'register', 'deregister', 'mermaid', 'providers', 'history'])
    .describe('Action: list nodes, register/deregister, get mermaid diagram, list providers, or view signal history'),
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
        });

        return `Cluster registered:\n- ID: ${node.id}\n- Name: ${node.name}\n- Status: ${node.status}`;
      }

      case 'deregister': {
        if (!args.clusterId) return 'Error: clusterId is required for deregister.';
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
    }
  },
};
