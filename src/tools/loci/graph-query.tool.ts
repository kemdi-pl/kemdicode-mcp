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
 * Graph Query Tool
 *
 * Query nodes in the knowledge graph.
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { getGraphStorage } from '../../loci/index.js';
import { resolveSessionId } from '../../kanban/resolvers.js';

const schema = z.object({
  sessionId: z.string().optional().describe('Session ID (auto-detected if omitted)'),
  type: z
    .enum(['file', 'error', 'solution', 'tool', 'concept', 'context', 'loci', 'pattern', 'agent'])
    .optional()
    .describe('Filter by node type: file (source files), error (recorded errors), solution (fixes/workarounds), tool (MCP tools), concept (abstract ideas), context (session context), loci (memory palace locations), pattern (recurring patterns), agent (AI agents)'),
  tags: z.array(z.string()).optional().describe('Filter by tags'),
  labelContains: z.string().optional().describe('Label substring filter'),
  minWeight: z.number().min(0).max(1).optional().describe('Min weight threshold'),
  limit: z.number().int().min(1).max(100).default(20).describe('Max results'),
  sortBy: z
    .enum(['weight', 'createdAt', 'accessCount', 'lastAccessedAt'])
    .default('weight')
    .describe('Sort field: weight (importance score), createdAt (creation time), accessCount (how often accessed), lastAccessedAt (last access time)'),
  sortOrder: z.enum(['asc', 'desc']).default('desc').describe('Sort order'),
});

export const graphQueryTool: UnifiedTool<typeof schema> = {
  name: 'graph-query',
  description: 'Query knowledge graph nodes by type, tags, weight. Use when: exploring stored knowledge, finding related errors/solutions.',
  zodSchema: schema,

  metadata: {
    category: 'loci',
    tags: ['graph', 'query', 'knowledge'],
    examples: [
      { args: { sessionId: 'session-1', type: 'error', limit: 10, sortBy: 'weight', sortOrder: 'desc' }, description: 'Query top 10 error nodes by weight' },
      { args: { sessionId: 'session-1', tags: ['authentication'], labelContains: 'login' }, description: 'Search nodes by tags and label' },
    ],
    relatedTools: ['graph-find-path', 'loci-recall'],
  },

  execute: async (args) => {
    const { sessionId: explicitSessionId, type, tags, labelContains, minWeight, limit, sortBy, sortOrder } = args;
    const sessionId = explicitSessionId || resolveSessionId();

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
