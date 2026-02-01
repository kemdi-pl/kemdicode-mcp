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
 * Shared Thoughts Tool
 *
 * Reads collective knowledge base from all agents in the current session.
 * Provides a unified view of what all KemdiCode agents have learned and analyzed.
 *
 * @module tools/context/shared-thoughts
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import {
  getSessionId,
  getSessionContext,
  getExternalServersContext,
  isContextEnabled,
} from '../../context/index.js';
import { getContextStorage } from '../../context/storage.js';
import { isSilent } from '../../config/silent.js';

const schema = z.object({
  scope: z
    .enum(['all', 'kemdicode', 'external', 'analysis', 'code'])
    .default('all')
    .describe('Scope: all, kemdicode, external, analysis, code'),
  limit: z.number().min(1).max(100).default(20).describe('Max entries to return'),
  format: z.enum(['detailed', 'summary', 'timeline']).default('summary').describe('Output format'),
  includeOutput: z.boolean().default(false).describe('Include full outputs (can be large)'),
});

type SharedThoughtsArgs = z.infer<typeof schema>;

/**
 * Format timestamp to relative time
 */
function formatRelativeTime(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

/**
 * Format entries as timeline
 */
function formatTimeline(
  entries: Array<{
    toolName: string;
    serverId: string;
    timestamp: number;
    summary: string;
    tags: string[];
  }>
): string {
  const lines = ['## 📅 Agent Activity Timeline\n'];

  for (const entry of entries) {
    const time = formatRelativeTime(entry.timestamp);
    const serverIcon = entry.serverId === 'kemdicode-mcp' ? '⚡' : '🔗';
    lines.push(`**${time}** ${serverIcon} \`${entry.serverId}\` → \`${entry.toolName}\``);
    lines.push(`> ${entry.summary}`);
    if (entry.tags.length > 0) {
      lines.push(`> 🏷️ ${entry.tags.join(', ')}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Format entries as summary
 */
function formatSummary(
  entries: Array<{
    toolName: string;
    serverId: string;
    timestamp: number;
    summary: string;
    tags: string[];
  }>,
  sessionId: string
): string {
  const byServer = new Map<string, number>();
  const byTool = new Map<string, number>();
  const allTags = new Set<string>();

  for (const entry of entries) {
    byServer.set(entry.serverId, (byServer.get(entry.serverId) || 0) + 1);
    byTool.set(entry.toolName, (byTool.get(entry.toolName) || 0) + 1);
    entry.tags.forEach((t) => allTags.add(t));
  }

  const lines = [
    '## 🧠 Shared Knowledge Base\n',
    `**Session:** \`${sessionId}\``,
    `**Total Entries:** ${entries.length}`,
    '',
    '### Agents Contributing:',
  ];

  for (const [server, count] of byServer) {
    const icon = server === 'kemdicode-mcp' ? '⚡' : '🔗';
    lines.push(`- ${icon} \`${server}\`: ${count} entries`);
  }

  lines.push('', '### Tools Used:');
  const sortedTools = [...byTool.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  for (const [tool, count] of sortedTools) {
    lines.push(`- \`${tool}\`: ${count}x`);
  }

  lines.push('', '### Knowledge Tags:');
  lines.push([...allTags].map((t) => `\`${t}\``).join(' '));

  lines.push('', '### Recent Insights:');
  for (const entry of entries.slice(0, 5)) {
    lines.push(`- **${entry.toolName}**: ${entry.summary}`);
  }

  return lines.join('\n');
}

/**
 * Format entries with full details
 */
function formatDetailed(
  entries: Array<{
    id: string;
    toolName: string;
    serverId: string;
    timestamp: number;
    summary: string;
    tags: string[];
    input?: unknown;
    output?: unknown;
  }>,
  includeOutput: boolean
): string {
  const lines = ['## 📚 Detailed Knowledge Base\n'];

  for (const entry of entries) {
    lines.push(`### ${entry.toolName} (${entry.serverId})`);
    lines.push(`- **ID:** \`${entry.id}\``);
    lines.push(`- **Time:** ${formatRelativeTime(entry.timestamp)}`);
    lines.push(`- **Tags:** ${entry.tags.join(', ')}`);
    lines.push(`- **Summary:** ${entry.summary}`);

    if (includeOutput && entry.output) {
      const output =
        typeof entry.output === 'string' ? entry.output : JSON.stringify(entry.output, null, 2);
      const truncated = output.length > 500 ? output.slice(0, 500) + '...' : output;
      lines.push('', '```', truncated, '```');
    }

    lines.push('---', '');
  }

  return lines.join('\n');
}

export const sharedThoughtsTool: UnifiedTool = {
  name: 'shared-thoughts',
  description:
    'Read collective knowledge from all agents. Shows analyzed data for multi-agent coordination.',
  zodSchema: schema,
  skipContextShare: true, // Don't create infinite loop
  metadata: {
    category: 'context',
    tags: ['thoughts', 'knowledge', 'sharing'],
    examples: [
      { args: { scope: 'all', format: 'summary' }, description: 'Get summary of all shared knowledge' },
      { args: { scope: 'code', format: 'timeline', limit: 10 }, description: 'View timeline of recent code-related insights' },
    ],
    relatedTools: ['get-shared-context', 'agent-list'],
  },

  execute: async (args): Promise<string> => {
    const { scope, limit, format, includeOutput } = args as SharedThoughtsArgs;

    if (!isContextEnabled()) {
      return '❌ Context sharing is disabled. Start server with Redis to enable multi-agent knowledge sharing.';
    }

    const sessionId = getSessionId();

    // Gather entries based on scope
    let entries: Array<{
      id: string;
      toolName: string;
      serverId: string;
      timestamp: number;
      summary: string;
      tags: string[];
      input?: unknown;
      output?: unknown;
    }> = [];

    // Helper to normalize entries (ensure summary is always string)
    const normalizeEntries = (
      rawEntries: Array<{
        id: string;
        toolName: string;
        serverId: string;
        timestamp: number;
        summary?: string;
        tags: string[];
        input?: unknown;
        output?: unknown;
      }>
    ) =>
      rawEntries.map((e) => ({
        ...e,
        summary: e.summary || `${e.toolName} completed`,
      }));

    try {
      if (scope === 'all' || scope === 'kemdicode') {
        const kemdicodeEntries = await getSessionContext(limit);
        entries.push(...normalizeEntries(kemdicodeEntries));
      }

      if (scope === 'all' || scope === 'external') {
        const externalEntries = await getExternalServersContext(limit);
        entries.push(...normalizeEntries(externalEntries));
      }

      if (scope === 'analysis') {
        const allEntries = await getSessionContext(limit * 2);
        const filtered = allEntries.filter(
          (e) =>
            e.tags.includes('analysis') ||
            e.toolName.includes('review') ||
            e.toolName.includes('explain') ||
            e.toolName.includes('analyze')
        );
        entries = normalizeEntries(filtered);
      }

      if (scope === 'code') {
        const allEntries = await getSessionContext(limit * 2);
        const filtered = allEntries.filter(
          (e) =>
            e.tags.includes('refactoring') ||
            e.tags.includes('testing') ||
            e.toolName.includes('fix') ||
            e.toolName.includes('refactor') ||
            e.toolName.includes('test')
        );
        entries = normalizeEntries(filtered);
      }

      // Sort by timestamp (most recent first)
      entries.sort((a, b) => b.timestamp - a.timestamp);
      entries = entries.slice(0, limit);

      if (entries.length === 0) {
        if (isSilent()) return '[]';
        const storage = getContextStorage();
        const stats = await storage.getStats();
        return `## 🧠 Shared Knowledge Base

**Session:** \`${sessionId}\`
**Status:** No shared thoughts yet in this session.

**Redis Stats:** ${stats.totalKeys || 0} total keys

💡 **Tip:** Run some analysis tools (code-review, explain-code, etc.) to start building the shared knowledge base.`;
      }

      if (isSilent()) {
        return JSON.stringify(entries.map((e) => ({ tool: e.toolName, summary: e.summary, tags: e.tags })));
      }

      // Format output
      switch (format) {
        case 'timeline':
          return formatTimeline(entries);
        case 'detailed':
          return formatDetailed(entries, includeOutput);
        case 'summary':
        default:
          return formatSummary(entries, sessionId);
      }
    } catch (error) {
      return `❌ Error reading shared thoughts: ${error instanceof Error ? error.message : error}`;
    }
  },
};
