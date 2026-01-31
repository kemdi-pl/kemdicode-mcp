/**
 * KemdiCode MCP Server
 * Copyright (C) 2025-2026 Kemdi Sp. z o.o.
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
 * Graph Find Path Tool
 *
 * Find paths between nodes, especially error → solution paths.
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import {
  getGraphStorage,
  findShortestPath,
  findErrorToSolutionPath,
  findAllPaths,
} from '../../loci/index.js';

const schema = z.object({
  fromNodeId: z.string().describe('Starting node ID'),
  toNodeId: z.string().optional().describe('Target node ID, optional for error-to-solution'),
  mode: z
    .enum(['shortest', 'error-to-solution', 'all'])
    .default('shortest')
    .describe('Path finding mode'),
  maxPaths: z
    .number()
    .int()
    .min(1)
    .max(10)
    .default(5)
    .describe('Max paths for "all" mode'),
  maxDepth: z.number().int().min(1).max(10).default(5).describe('Max path depth'),
});

export const graphFindPathTool: UnifiedTool<typeof schema> = {
  name: 'graph-find-path',
  description: 'Find paths between knowledge graph nodes. Use error-to-solution mode for fixes.',
  zodSchema: schema,

  metadata: {
    category: 'loci',
    tags: ['graph', 'path', 'navigation'],
    examples: [
      { args: { fromNodeId: 'error-123', mode: 'error-to-solution', maxDepth: 5 }, description: 'Find solution path for an error node' },
      { args: { fromNodeId: 'node-a', toNodeId: 'node-b', mode: 'shortest' }, description: 'Find shortest path between two nodes' },
    ],
    relatedTools: ['graph-query', 'loci-recall'],
  },

  execute: async (args) => {
    const { fromNodeId, toNodeId, mode, maxPaths, maxDepth } = args;

    const storage = getGraphStorage();
    if (!storage.isConnected()) {
      await storage.connect();
    }

    // Verify from node exists
    const fromNode = await storage.getNode(fromNodeId);
    if (!fromNode) {
      return `Node not found: ${fromNodeId}`;
    }

    const lines: string[] = [
      '╔══════════════════════════════════════════════════════════════════╗',
      '║ 🛤️  PATH FINDING RESULTS                                         ║',
      '╠══════════════════════════════════════════════════════════════════╣',
      `║ From: ${fromNode.label.substring(0, 58).padEnd(58)} ║`,
      `║ Mode: ${mode.padEnd(58)} ║`,
    ];

    if (mode === 'error-to-solution') {
      if (fromNode.type !== 'error') {
        return `Node ${fromNodeId} is not an error node. Use error-to-solution mode with error nodes.`;
      }

      const path = await findErrorToSolutionPath(fromNodeId, { maxDepth });

      if (!path) {
        lines.push(
          '╠──────────────────────────────────────────────────────────────────╣',
          '║ No solution path found for this error.                          ║',
          '║ Consider adding solution nodes with "fixes" edges.              ║',
          '╚══════════════════════════════════════════════════════════════════╝'
        );
        return lines.join('\n');
      }

      lines.push(
        '╠──────────────────────────────────────────────────────────────────╣',
        '║ ✅ SOLUTION PATH FOUND                                           ║',
        '╠──────────────────────────────────────────────────────────────────╣'
      );

      for (let i = 0; i < path.nodeIds.length; i++) {
        const node = await storage.getNode(path.nodeIds[i]);
        const prefix = i === 0 ? '🔴' : i === path.nodeIds.length - 1 ? '🟢' : '  ';
        const arrow = i < path.nodeIds.length - 1 ? ' →' : '';
        lines.push(
          `║ ${prefix} ${(node?.label || path.nodeIds[i]).substring(0, 55).padEnd(55)}${arrow} ║`
        );
      }
    } else if (mode === 'shortest') {
      if (!toNodeId) {
        return 'Error: toNodeId is required for shortest path mode';
      }

      const toNode = await storage.getNode(toNodeId);
      if (!toNode) {
        return `Target node not found: ${toNodeId}`;
      }

      lines.push(`║ To:   ${toNode.label.substring(0, 58).padEnd(58)} ║`);

      const path = await findShortestPath(fromNodeId, toNodeId, { maxDepth });

      if (!path) {
        lines.push(
          '╠──────────────────────────────────────────────────────────────────╣',
          '║ No path found between these nodes.                              ║',
          '╚══════════════════════════════════════════════════════════════════╝'
        );
        return lines.join('\n');
      }

      lines.push(
        '╠──────────────────────────────────────────────────────────────────╣',
        '║ SHORTEST PATH                                                    ║',
        '╠──────────────────────────────────────────────────────────────────╣',
        `║ Length: ${String(path.nodeIds.length)} nodes`.padEnd(66) + '║'
      );

      for (let i = 0; i < path.nodeIds.length; i++) {
        const node = await storage.getNode(path.nodeIds[i]);
        const prefix = i === 0 ? '▶' : i === path.nodeIds.length - 1 ? '◀' : '│';
        lines.push(`║ ${prefix} ${(node?.label || path.nodeIds[i]).substring(0, 60).padEnd(60)} ║`);
      }
    } else if (mode === 'all') {
      if (!toNodeId) {
        return 'Error: toNodeId is required for all paths mode';
      }

      const toNode = await storage.getNode(toNodeId);
      if (!toNode) {
        return `Target node not found: ${toNodeId}`;
      }

      lines.push(`║ To:   ${toNode.label.substring(0, 58).padEnd(58)} ║`);

      const paths = await findAllPaths(fromNodeId, toNodeId, maxPaths, { maxDepth });

      if (paths.length === 0) {
        lines.push(
          '╠──────────────────────────────────────────────────────────────────╣',
          '║ No paths found between these nodes.                             ║',
          '╚══════════════════════════════════════════════════════════════════╝'
        );
        return lines.join('\n');
      }

      lines.push(
        '╠──────────────────────────────────────────────────────────────────╣',
        `║ Found ${paths.length} path(s)`.padEnd(67) + '║',
        '╠──────────────────────────────────────────────────────────────────╣'
      );

      for (let p = 0; p < paths.length; p++) {
        const path = paths[p];
        lines.push(`║ Path ${p + 1} (${path.nodeIds.length} nodes):`.padEnd(67) + '║');

        const nodeLabels: string[] = [];
        for (const nodeId of path.nodeIds) {
          const node = await storage.getNode(nodeId);
          nodeLabels.push(node?.label.substring(0, 15) || nodeId.substring(0, 15));
        }
        const pathStr = nodeLabels.join(' → ');
        lines.push(`║   ${pathStr.substring(0, 62).padEnd(62)} ║`);
      }
    }

    lines.push('╚══════════════════════════════════════════════════════════════════╝');

    return lines.join('\n');
  },
};
