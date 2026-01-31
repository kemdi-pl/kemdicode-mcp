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
 * Task Get Tool
 *
 * Retrieves full details of a single task by ID.
 *
 * @module tools/kanban/task-get
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { Logger } from '../../utils/logger.js';
import { checkRateLimit } from '../../utils/validation.js';
import { getTask } from '../../kanban/index.js';

const schema = z.object({
  taskId: z.string().min(1).describe('Task ID'),
  sessionId: z.string().optional().describe('Session ID (auto-detected from connection if omitted)'),
});

type TaskGetArgs = z.infer<typeof schema>;

export const taskGetTool: UnifiedTool = {
  name: 'task-get',
  description: 'Get full details of a single Kanban task by ID',
  zodSchema: schema,

  metadata: {
    category: 'kanban',
    tags: ['task', 'get', 'detail'],
    examples: [
      { args: { taskId: 'task-abc123' }, description: 'Get full details of a task' },
    ],
    relatedTools: ['task-list', 'task-update'],
  },

  execute: async (args): Promise<string> => {
    const input = args as TaskGetArgs;

    if (!checkRateLimit('kanban-operations', { maxRequests: 100, windowMs: 60000 })) {
      return JSON.stringify({
        success: false,
        error: 'Rate limit exceeded for kanban operations',
        code: 'RATE_LIMIT_EXCEEDED',
      });
    }

    try {
      const task = await getTask(input.taskId);

      if (!task) {
        Logger.debug(`task-get: task ${input.taskId} not found`);
        return JSON.stringify({
          success: false,
          error: `Task ${input.taskId} not found`,
          code: 'TASK_NOT_FOUND',
        });
      }

      Logger.debug(`task-get: retrieved task ${task.id}: ${task.title}`);

      return JSON.stringify({
        success: true,
        task: {
          id: task.id,
          sessionId: task.sessionId,
          boardId: task.boardId,
          title: task.title,
          description: task.description,
          status: task.status,
          priority: task.priority,
          assignee: task.assignee,
          createdBy: task.createdBy,
          blockedBy: task.blockedBy,
          blocks: task.blocks,
          relatedFiles: task.relatedFiles,
          labels: task.labels,
          createdAt: task.createdAt,
          updatedAt: task.updatedAt,
          startedAt: task.startedAt,
          completedAt: task.completedAt,
          estimatedMinutes: task.estimatedMinutes,
          actualMinutes: task.actualMinutes,
          notes: task.notes || [],
          noteCount: (task.notes || []).length,
        },
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      Logger.error(`task-get error: ${errorMessage}`);

      return JSON.stringify({
        success: false,
        error: errorMessage,
        code: 'GET_ERROR',
      });
    }
  },
};
