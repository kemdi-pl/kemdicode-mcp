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
 * Graph Query Tool
 *
 * Query nodes in the knowledge graph.
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { getGraphStorage } from '../../loci/index.js';

const schema = z.object({
  sessionId: z.string().describe('Session ID'),
  type: z
    .enum(['file', 'error', 'solution', 'tool', 'concept', 'context', 'loci', 'pattern', 'agent'])
    .optional()
    .describe('Filter by node type'),
  tags: z.array(z.string()).optional().describe('Filter by tags (any match)'),
  labelContains: z.string().optional().describe('Filter by label containing text'),
  minWeight: z.number().min(0).max(1).optional().describe('Minimum weight threshold'),
  limit: z.number().int().min(1).max(100).default(20).describe('Maximum results'),
  sortBy: z
    .enum(['weight', 'createdAt', 'accessCount', 'lastAccessedAt'])
    .default('weight')
    .describe('Sort field'),
  sortOrder: z.enum(['asc', 'desc']).default('desc').describe('Sort order'),
});

export const graphQueryTool: UnifiedTool<typeof schema> = {
  name: 'graph-query',
  description: 'Query nodes in the knowledge graph with filters for type, tags, and weight.',
  zodSchema: schema,

  execute: async (args) => {
    const { sessionId, type, tags, labelContains, minWeight, limit, sortBy, sortOrder } = args;

    const storage = getGraphStorage();
    if (!storage.isConnected()) {
      await storage.connect();
    }

    const nodes = await storage.queryNodes({
      sessionId,
      type: type ? [type] : undefined,
      tags,
      labelContains,
      minWeight,
      limit,
      sortBy,
      sortOrder,
    });

    if (nodes.length === 0) {
      return `No nodes found matching the criteria in session ${sessionId}`;
    }

    const lines: string[] = [
      '╔══════════════════════════════════════════════════════════════════╗',
      '║ 🔍 GRAPH QUERY RESULTS                                           ║',
      '╠══════════════════════════════════════════════════════════════════╣',
      `║ Session:  ${sessionId.padEnd(54)} ║`,
      type ? `║ Type:     ${type.padEnd(54)} ║` : null,
      `║ Found:    ${String(nodes.length)} nodes`.padEnd(66) + '║',
      '╠══════════════════════════════════════════════════════════════════╣',
    ].filter(Boolean) as string[];

    const typeIcons: Record<string, string> = {
      file: '📄',
      error: '❌',
      solution: '✅',
      tool: '🔧',
      concept: '💡',
      context: '📝',
      loci: '🏛️',
      pattern: '🔄',
      agent: '🤖',
    };

    for (const node of nodes) {
      const icon = typeIcons[node.type] || '📌';
      const weight = node.weight.toFixed(2).padStart(5);
      const label = node.label.substring(0, 40).padEnd(40);

      lines.push(`║ ${icon} ${label} [${weight}] ║`);

      if (node.tags.length > 0) {
        const tagsStr = node.tags.slice(0, 5).join(', ');
        lines.push(`║    Tags: ${tagsStr.substring(0, 55).padEnd(55)} ║`);
      }
    }

    lines.push('╚══════════════════════════════════════════════════════════════════╝');

    return lines.join('\n');
  },
};
