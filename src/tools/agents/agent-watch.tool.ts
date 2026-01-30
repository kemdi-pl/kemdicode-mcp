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
 * Agent Watch Tool
 *
 * Real-time monitoring of agent conversations via Redis Pub/Sub.
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { getAgentMonitor } from '../../context/agent-monitor.js';

const schema = z.object({
  sessionId: z.string().describe('Session ID to monitor'),
  duration: z
    .number()
    .min(1000)
    .max(60000)
    .default(10000)
    .describe('Watch duration in milliseconds (1-60 seconds)'),
  messageLimit: z
    .number()
    .min(5)
    .max(100)
    .default(30)
    .describe('Number of recent messages to show'),
});

export const agentWatchTool: UnifiedTool = {
  name: 'agent-watch',
  description:
    'Monitor agent conversations in real-time. Shows agents, messages, alerts.',
  zodSchema: schema,
  skipContextShare: true,

  execute: async (args, onProgress) => {
    const { sessionId, duration, messageLimit: _messageLimit } = args as z.infer<typeof schema>;
    const monitor = getAgentMonitor();

    if (!monitor.isConnected()) {
      await monitor.connect();
    }

    // Use watch mode with progress callback
    const result = await monitor.watchSession(sessionId, duration, onProgress);

    return result;
  },
};
