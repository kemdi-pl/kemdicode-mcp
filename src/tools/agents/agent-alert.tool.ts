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
 * Agent Alert Tool
 *
 * Send alerts/directives to agents from supervisor (Claude Opus 4.5).
 * Format: [ALERT: Source] Message
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { getAgentMonitor } from '../../context/agent-monitor.js';
import { MessagePriority } from '../../context/types.js';
import { sanitizeTerminalOutput, wrapText } from '../../utils/format-helpers.js';

const schema = z.object({
  agentIds: z.string().describe('Comma-separated agent IDs or "*" for broadcast'),
  message: z.string().min(1).describe('Alert message content'),
  source: z.string().default('Claude Opus 4.5').describe('Alert source name'),
  priority: z
    .enum(['low', 'normal', 'high', 'critical'])
    .default('high')
    .describe('Message priority'),
  interrupt: z.boolean().default(false).describe('Whether to interrupt current agent processing'),
  sessionId: z.string().optional().describe('Target session ID'),
});

export const agentAlertTool: UnifiedTool = {
  name: 'agent-alert',
  description:
    'Send alert to agents. Use for guidance, corrections, or notifications during multi-agent execution.',
  zodSchema: schema,
  skipContextShare: true,

  execute: async (args) => {
    const { agentIds, message, source, priority, interrupt, sessionId } = args as z.infer<
      typeof schema
    >;
    const monitor = getAgentMonitor();

    if (!monitor.isConnected()) {
      await monitor.connect();
    }

    // Parse agent IDs
    const targets =
      agentIds === '*'
        ? '*'
        : agentIds
            .split(',')
            .map((id) => id.trim())
            .filter(Boolean);

    if (Array.isArray(targets) && targets.length === 0) {
      return 'Error: No valid agent IDs provided.';
    }

    const alert = await monitor.sendAlert(
      targets as string[] | '*',
      message,
      source,
      priority as MessagePriority,
      interrupt,
      sessionId
    );

    if (!alert) {
      return 'Failed to send alert. Check Redis connection.';
    }

    const targetCount = targets === '*' ? 'all agents' : `${(targets as string[]).length} agent(s)`;
    const priorityIcon = {
      low: '⚪',
      normal: '🟢',
      high: '🟠',
      critical: '🔴',
    }[priority];

    const safeId = sanitizeTerminalOutput(alert.id);
    const safeSource = sanitizeTerminalOutput(source);
    const safeMessage = sanitizeTerminalOutput(message);

    return [
      '╔══════════════════════════════════════════════════════════════════╗',
      '║                    ALERT SENT                                    ║',
      '╠══════════════════════════════════════════════════════════════════╣',
      `║ ID:       ${safeId.padEnd(54)} ║`,
      `║ To:       ${targetCount.padEnd(54)} ║`,
      `║ Priority: ${priorityIcon} ${priority.padEnd(51)} ║`,
      `║ Source:   ${safeSource.padEnd(54)} ║`,
      `║ Interrupt: ${interrupt ? 'Yes' : 'No'}`.padEnd(67) + '║',
      '╠──────────────────────────────────────────────────────────────────╣',
      `║ Message:`.padEnd(67) + '║',
      ...wrapText(safeMessage, 63).map((line) => `║   ${line.padEnd(62)} ║`),
      '╚══════════════════════════════════════════════════════════════════╝',
    ].join('\n');
  },
};

