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
 * Board Status Tool
 *
 * Shows summary of the Kanban board status.
 *
 * @module tools/kanban/board-status
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { Logger } from '../../utils/logger.js';
import { checkRateLimit } from '../../utils/validation.js';
import { getBoardSummary } from '../../kanban/index.js';

const schema = z.object({
  sessionId: z.string().min(1).describe('Session ID'),
});

type BoardStatusArgs = z.infer<typeof schema>;

export const boardStatusTool: UnifiedTool = {
  name: 'board-status',
  description: 'Get Kanban board summary (task counts, agents, activity)',
  zodSchema: schema,

  execute: async (args): Promise<string> => {
    const input = args as BoardStatusArgs;

    if (!checkRateLimit('kanban-operations', { maxRequests: 100, windowMs: 60000 })) {
      return JSON.stringify({
        success: false,
        error: 'Rate limit exceeded for kanban operations',
        code: 'RATE_LIMIT_EXCEEDED',
      });
    }

    try {
      const summary = await getBoardSummary(input.sessionId);

      Logger.debug(`board-status: retrieved summary for session ${input.sessionId}`);

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
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      Logger.error(`board-status error: ${errorMessage}`);

      return JSON.stringify({
        success: false,
        error: errorMessage,
        code: 'STATUS_ERROR',
      });
    }
  },
};
