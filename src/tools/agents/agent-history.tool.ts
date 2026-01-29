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
 * Agent History Tool
 *
 * View conversation history between agents in a session.
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { getAgentMonitor } from '../../context/agent-monitor.js';

const schema = z.object({
  sessionId: z.string().describe('Session ID'),
  agentId: z.string().optional().describe('Filter by specific agent ID'),
  limit: z.number().min(1).max(200).default(50).describe('Maximum number of messages to return'),
  since: z.number().optional().describe('Only show messages after this timestamp (Unix ms)'),
  type: z
    .enum(['all', 'chat', 'alert', 'directive', 'context', 'query', 'response', 'status', 'system'])
    .default('all')
    .describe('Filter by message type'),
});

export const agentHistoryTool: UnifiedTool = {
  name: 'agent-history',
  description:
    'View conversation history between agents. Shows messages, alerts, directives, and context injections. Filter by agent, type, or time.',
  zodSchema: schema,
  skipContextShare: true,

  execute: async (args) => {
    const { sessionId, agentId, limit, since, type } = args as z.infer<typeof schema>;
    const monitor = getAgentMonitor();

    if (!monitor.isConnected()) {
      await monitor.connect();
    }

    let messages = agentId
      ? await monitor.getAgentMessages(agentId, sessionId, limit * 2)
      : await monitor.getMessageHistory(sessionId, limit * 2, since);

    // Filter by type
    if (type !== 'all') {
      messages = messages.filter((m) => m.type === type);
    }

    // Limit results
    messages = messages.slice(0, limit);

    if (messages.length === 0) {
      return agentId
        ? `No messages found for agent ${agentId} in session ${sessionId}.`
        : `No messages found in session ${sessionId}.`;
    }

    const lines: string[] = [
      '╔══════════════════════════════════════════════════════════════════════════════╗',
      `║ 📜 MESSAGE HISTORY - Session: ${sessionId.slice(0, 40).padEnd(40)}  ║`,
      '╠══════════════════════════════════════════════════════════════════════════════╣',
    ];

    for (const msg of messages) {
      const time = new Date(msg.timestamp).toLocaleTimeString('pl-PL', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });

      const typeIconMap: Record<string, string> = {
        chat: '💬',
        alert: '🚨',
        directive: '🎯',
        context: '📋',
        query: '❓',
        response: '💡',
        status: '📊',
        system: '⚙️',
        'mpc-share-request': '🔐',
        'mpc-share-response': '🔑',
        'mpc-share-delivery': '📦',
        'mpc-share-acknowledgment': '✅',
        'mpc-reconstruct-request': '🔓',
        'mpc-reconstruct-contribution': '🧩',
      };
      const typeIcon = typeIconMap[msg.type] || '📝';

      const priorityColorMap: Record<string, string> = {
        low: '⚪',
        normal: '🟢',
        high: '🟠',
        critical: '🔴',
      };
      const priorityColor = priorityColorMap[msg.priority] || '⚪';

      const from = msg.fromAgentId.slice(0, 12).padEnd(12);
      const to = msg.toAgentId.slice(0, 12).padEnd(12);

      lines.push(
        `║ [${time}] ${priorityColor} ${typeIcon} ${msg.type.padEnd(9)} ${from} → ${to}`.padEnd(
          79
        ) + '║'
      );

      // Wrap content to multiple lines if needed
      const contentLines = wrapText(msg.content, 73);
      for (const line of contentLines.slice(0, 3)) {
        lines.push(`║   ${line.padEnd(75)} ║`);
      }
      if (contentLines.length > 3) {
        lines.push(`║   ... (${contentLines.length - 3} more lines)`.padEnd(79) + '║');
      }

      lines.push(
        '╟──────────────────────────────────────────────────────────────────────────────╢'
      );
    }

    lines.pop(); // Remove last separator
    lines.push('╠══════════════════════════════════════════════════════════════════════════════╣');
    lines.push(`║ Total: ${messages.length} message(s)`.padEnd(79) + '║');
    lines.push('╚══════════════════════════════════════════════════════════════════════════════╝');

    return lines.join('\n');
  },
};

function wrapText(text: string, maxWidth: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let currentLine = '';

  for (const word of words) {
    if (currentLine.length + word.length + 1 <= maxWidth) {
      currentLine += (currentLine ? ' ' : '') + word;
    } else {
      if (currentLine) lines.push(currentLine);
      currentLine = word;
    }
  }
  if (currentLine) lines.push(currentLine);

  return lines.length > 0 ? lines : [''];
}
