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
 * Agent Inject Tool
 *
 * Inject context or directives into an agent's conversation stream.
 * Used for real-time guidance and context enrichment.
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { getAgentMonitor } from '../../context/agent-monitor.js';
import { sanitizeTerminalOutput, wrapText } from '../../utils/format-helpers.js';
import { isSilent } from '../../config/silent.js';

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
    "Inject context or instructions directly into a specific agent's session (stored per-agent in Redis). The injected content appears in the agent's next tool response. Use when: providing real-time guidance to a specific running agent. For broadcasting to multiple agents, use queue-message. For persistent directives, use agent-alert with asDirective=true.",
  zodSchema: schema,
  skipContextShare: true,
  metadata: {
    category: 'agents',
    tags: ['inject', 'context', 'directive'],
    examples: [
      { args: { agentId: 'backend-dev', sessionId: 'sess-abc123', type: 'context', content: 'Database schema changed: users table has new email_verified column' }, description: 'Inject context information into agent' },
      { args: { agentId: 'frontend-dev', sessionId: 'sess-abc123', type: 'directive', content: 'Use React hooks instead of class components' }, description: 'Send directive to agent' },
    ],
    relatedTools: ['agent-list', 'agent-alert'],
  },

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

    if (isSilent()) {
      return JSON.stringify({ agentId, type });
    }

    const typeIcon = {
      context: '📋',
      directive: '🎯',
      query: '❓',
    }[type];

    const safeAgentId = sanitizeTerminalOutput(agentId);
    const safeAgentName = sanitizeTerminalOutput(agent.name);
    const safeStatus = sanitizeTerminalOutput(agent.status);
    const safeSessionId = sanitizeTerminalOutput(sessionId);
    const safeContent = sanitizeTerminalOutput(formattedContent);

    const lines = [
      '╔══════════════════════════════════════════════════════════════════╗',
      `║ ${typeIcon} ${type.toUpperCase()} INJECTED`.padEnd(66) + '║',
      '╠══════════════════════════════════════════════════════════════════╣',
      `║ Agent:   ${safeAgentId.padEnd(55)} ║`,
      `║ Name:    ${safeAgentName.padEnd(55)} ║`,
      `║ Status:  ${safeStatus.padEnd(55)} ║`,
      `║ Session: ${safeSessionId.padEnd(55)} ║`,
      '╠──────────────────────────────────────────────────────────────────╣',
      `║ Content:`.padEnd(67) + '║',
      ...wrapText(safeContent, 63).map((line) => `║   ${line.padEnd(62)} ║`),
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

