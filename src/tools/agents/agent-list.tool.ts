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
 * Agent List Tool
 *
 * Lists all active agents in the system or filtered by session.
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { getAgentMonitor } from '../../context/agent-monitor.js';

const schema = z.object({
  sessionId: z.string().optional().describe('Filter by session ID (optional)'),
  includeIdle: z.boolean().default(true).describe('Include idle agents'),
});

export const agentListTool: UnifiedTool = {
  name: 'agent-list',
  description: 'List active agents with IDs, roles, status, and tasks.',
  zodSchema: schema,
  skipContextShare: true,
  metadata: {
    category: 'agents',
    tags: ['list', 'discovery'],
    examples: [
      { args: {}, description: 'List all active agents in the system' },
      { args: { sessionId: 'sess-abc123', includeIdle: false }, description: 'List only busy agents in a session' },
    ],
    relatedTools: ['agent-register', 'agent-watch', 'monitor'],
  },

  execute: async (args) => {
    const { sessionId, includeIdle } = args as z.infer<typeof schema>;
    const monitor = getAgentMonitor();

    if (!monitor.isConnected()) {
      await monitor.connect();
    }

    const agents = await monitor.listAgents(sessionId);
    const filtered = includeIdle ? agents : agents.filter((a) => a.status !== 'idle');

    if (filtered.length === 0) {
      return sessionId
        ? `No active agents found in session: ${sessionId}`
        : 'No active agents found in the system.';
    }

    const lines: string[] = [
      '╔══════════════════════════════════════════════════════════════════╗',
      '║                    ACTIVE AGENTS                                 ║',
      '╠══════════════════════════════════════════════════════════════════╣',
    ];

    for (const agent of filtered) {
      const statusIcon = {
        active: '🟢',
        processing: '🔄',
        idle: '💤',
        terminated: '⛔',
      }[agent.status];

      const roleIcon = {
        supervisor: '👑',
        coordinator: '🎯',
        worker: '⚙️',
        specialist: '🔬',
      }[agent.role];

      lines.push(
        `║ ${statusIcon} ${agent.id.padEnd(15)} ${roleIcon} ${agent.role.padEnd(12)} @ ${agent.serverId.padEnd(18)} ║`
      );
      lines.push(`║   Name: ${agent.name.padEnd(54)} ║`);

      if (agent.model) {
        lines.push(`║   Model: ${agent.model.padEnd(53)} ║`);
      }

      if (agent.currentTask) {
        const task =
          agent.currentTask.length > 50
            ? agent.currentTask.slice(0, 47) + '...'
            : agent.currentTask;
        lines.push(`║   Task: ${task.padEnd(54)} ║`);
      }

      const lastSeen = Math.floor((Date.now() - agent.lastHeartbeat) / 1000);
      lines.push(`║   Last seen: ${lastSeen}s ago`.padEnd(67) + '║');
      lines.push('╠──────────────────────────────────────────────────────────────────╣');
    }

    lines.pop(); // Remove last separator
    lines.push('╚══════════════════════════════════════════════════════════════════╝');
    lines.push(`\nTotal: ${filtered.length} agent(s)`);

    return lines.join('\n');
  },
};
