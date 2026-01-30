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
 * Task List Tool
 *
 * Lists tasks from the Kanban board with filters.
 *
 * @module tools/kanban/task-list
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { Logger } from '../../utils/logger.js';
import { checkRateLimit } from '../../utils/validation.js';
import { listTasks, TaskStatus, TaskPriority } from '../../kanban/index.js';

const schema = z.object({
  sessionId: z.string().min(1).describe('Session ID'),
  boardId: z.string().optional().describe('Filter by board'),
  status: z
    .enum(['backlog', 'in_progress', 'review', 'done'])
    .optional()
    .describe('Filter by status'),
  priority: z.enum(['critical', 'high', 'normal', 'low']).optional().describe('Filter by priority'),
  assignee: z.string().optional().describe('Filter by agent'),
  unassigned: z.boolean().optional().describe('Only unassigned tasks'),
  blocked: z.boolean().optional().describe('Filter blocked tasks'),
  labels: z.array(z.string()).optional().describe('Filter by labels'),
  limit: z.number().min(1).max(100).default(50).describe('Max tasks to return'),
});

type TaskListArgs = z.infer<typeof schema>;

export const taskListTool: UnifiedTool = {
  name: 'task-list',
  description: 'List Kanban tasks with filters',
  zodSchema: schema,

  execute: async (args): Promise<string> => {
    const input = args as TaskListArgs;

    if (!checkRateLimit('kanban-operations', { maxRequests: 100, windowMs: 60000 })) {
      return JSON.stringify({
        success: false,
        error: 'Rate limit exceeded for kanban operations',
        code: 'RATE_LIMIT_EXCEEDED',
      });
    }

    try {
      const tasks = await listTasks(
        input.sessionId,
        {
          status: input.status as TaskStatus | undefined,
          priority: input.priority as TaskPriority | undefined,
          assignee: input.assignee,
          unassigned: input.unassigned,
          blocked: input.blocked,
          labels: input.labels,
          boardId: input.boardId,
        },
        input.limit
      );

      Logger.debug(`task-list: found ${tasks.length} tasks for session ${input.sessionId}`);

      return JSON.stringify({
        success: true,
        count: tasks.length,
        tasks: tasks.map((t) => ({
          id: t.id,
          boardId: t.boardId,
          title: t.title,
          status: t.status,
          priority: t.priority,
          assignee: t.assignee,
          blockedBy: t.blockedBy,
          labels: t.labels,
          createdAt: t.createdAt,
          updatedAt: t.updatedAt,
        })),
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      Logger.error(`task-list error: ${errorMessage}`);

      return JSON.stringify({
        success: false,
        error: errorMessage,
        code: 'LIST_ERROR',
      });
    }
  },
};
