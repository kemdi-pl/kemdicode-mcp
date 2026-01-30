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
 * Agent Inject Tool
 *
 * Inject context or directives into an agent's conversation stream.
 * Used for real-time guidance and context enrichment.
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { getAgentMonitor } from '../../context/agent-monitor.js';

const schema = z.object({
  agentId: z.string().describe('Target agent ID'),
  sessionId: z.string().describe('Session ID'),
  type: z
    .enum(['context', 'directive', 'query'])
    .default('context')
    .describe('Injection type: context=info, directive=instruction, query=question'),
  content: z.string().min(1).describe('Content to inject'),
  data: z.record(z.string(), z.unknown()).optional().describe('Structured data (JSON)'),
});

export const agentInjectTool: UnifiedTool<typeof schema> = {
  name: 'agent-inject',
  description:
    "Inject context, directives, or queries into agent's conversation for real-time guidance.",
  zodSchema: schema,
  skipContextShare: true,

  execute: async (args) => {
    // args is now properly typed via the generic
    const { agentId, sessionId, type, content, data } = args;
    const monitor = getAgentMonitor();

    if (!monitor.isConnected()) {
      await monitor.connect();
    }

    // Verify agent exists
    const agent = await monitor.getAgent(agentId);
    if (!agent) {
      return `Error: Agent ${agentId} not found.`;
    }

    let success = false;
    let formattedContent = content;

    switch (type) {
      case 'context':
        success = await monitor.injectContext(agentId, sessionId, content, data);
        formattedContent = `[CONTEXT] ${content}`;
        break;

      case 'directive':
        success = await monitor.sendDirective(agentId, sessionId, content, data);
        formattedContent = `[DIRECTIVE] ${content}`;
        break;

      case 'query': {
        const message = await monitor.sendMessage(
          'supervisor',
          agentId,
          sessionId,
          `[QUERY] ${content}`,
          'query',
          'high',
          data
        );
        success = message !== null;
        formattedContent = `[QUERY] ${content}`;
        break;
      }
    }

    if (!success) {
      return `Failed to inject ${type} into agent ${agentId}.`;
    }

    const typeIcon = {
      context: '📋',
      directive: '🎯',
      query: '❓',
    }[type];

    const lines = [
      '╔══════════════════════════════════════════════════════════════════╗',
      `║ ${typeIcon} ${type.toUpperCase()} INJECTED`.padEnd(66) + '║',
      '╠══════════════════════════════════════════════════════════════════╣',
      `║ Agent:   ${agentId.padEnd(55)} ║`,
      `║ Name:    ${agent.name.padEnd(55)} ║`,
      `║ Status:  ${agent.status.padEnd(55)} ║`,
      `║ Session: ${sessionId.padEnd(55)} ║`,
      '╠──────────────────────────────────────────────────────────────────╣',
      `║ Content:`.padEnd(67) + '║',
      ...wrapText(formattedContent, 63).map((line) => `║   ${line.padEnd(62)} ║`),
    ];

    if (data && Object.keys(data).length > 0) {
      lines.push('╠──────────────────────────────────────────────────────────────────╣');
      lines.push(`║ Data:`.padEnd(67) + '║');
      const dataStr = JSON.stringify(data, null, 2);
      for (const line of dataStr.split('\n').slice(0, 5)) {
        lines.push(`║   ${line.slice(0, 62).padEnd(62)} ║`);
      }
    }

    lines.push('╚══════════════════════════════════════════════════════════════════╝');

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
