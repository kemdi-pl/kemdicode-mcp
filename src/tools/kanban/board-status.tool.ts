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
 * Board Status Tool
 *
 * Shows summary of the Kanban board status.
 *
 * @module tools/kanban/board-status
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { Logger } from '../../utils/logger.js';
import { executeWithGuard } from '../tool-shared.js';
import { getBoardSummary, resolveSessionId } from '../../kanban/index.js';
import { isSilent } from '../../config/silent.js';

const schema = z.object({
  sessionId: z.string().optional().describe('Session ID (auto-detected from connection if omitted)'),
});

type BoardStatusArgs = z.infer<typeof schema>;

export const boardStatusTool: UnifiedTool = {
  name: 'board-status',
  description: 'Get Kanban board summary with task counts and activity',
  zodSchema: schema,

  metadata: {
    category: 'kanban',
    tags: ['board', 'status', 'summary'],
    examples: [
      { args: {}, description: 'Get board summary for the current session' },
      { args: { sessionId: 'session-abc123' }, description: 'Get board summary for a specific session' },
    ],
    relatedTools: ['board-list', 'task-list', 'monitor'],
  },

  execute: async (args): Promise<string> => {
    const input = args as BoardStatusArgs;

    return executeWithGuard('board-status', 'kanban-operations', async () => {
      // Resolve sessionId from args or active connection context
      const sessionId = resolveSessionId(input.sessionId);

      const summary = await getBoardSummary(sessionId);

      Logger.debug(`board-status: retrieved summary for session ${sessionId}`);

      // Silent mode: compact stats only
      if (isSilent()) {
        return JSON.stringify({
          total: summary.totalTasks,
          byStatus: summary.byStatus,
          blocked: summary.blockedTasks,
        });
      }

      return JSON.stringify({
        success: true,
        summary: {
          sessionId: summary.sessionId,
          totalTasks: summary.totalTasks,
          byStatus: summary.byStatus,
          byPriority: summary.byPriority,
          blockedTasks: summary.blockedTasks,
          assignedTasks: summary.assignedTasks,
          unassignedTasks: summary.unassignedTasks,
          agents: summary.agents,
          recentActivity: summary.recentActivity.slice(0, 5).map((e) => ({
            type: e.type,
            taskId: e.taskId,
            agentId: e.agentId,
            timestamp: e.timestamp,
          })),
        },
      });
    });
  },
};
