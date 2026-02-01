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
 * Task Get Tool
 *
 * Retrieves full details of a single task by ID.
 *
 * @module tools/kanban/task-get
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { Logger } from '../../utils/logger.js';
import { executeWithGuard } from '../tool-shared.js';
import { getTask } from '../../kanban/index.js';
import { isSilent } from '../../config/silent.js';

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

    return executeWithGuard('task-get', 'kanban-operations', async () => {
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

      // Silent mode: core fields only
      if (isSilent()) {
        return JSON.stringify({
          id: task.id,
          title: task.title,
          description: task.description,
          status: task.status,
          priority: task.priority,
          assignee: task.assignee,
          blockedBy: task.blockedBy?.length ? task.blockedBy : undefined,
        });
      }

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
    });
  },
};
