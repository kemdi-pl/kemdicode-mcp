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
 * Task Claim Tool
 *
 * Allows an agent to claim and start working on a task.
 *
 * @module tools/kanban/task-claim
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { Logger } from '../../utils/logger.js';
import { checkRateLimit } from '../../utils/validation.js';
import { claimTask, getAvailableTasks } from '../../kanban/index.js';

const schema = z.object({
  taskId: z
    .string()
    .optional()
    .describe('Specific task ID to claim (if not provided, claims next available)'),
  agentId: z.string().min(1).describe('Agent ID claiming the task'),
  sessionId: z.string().optional().describe('Session ID (required if no taskId)'),
});

type TaskClaimArgs = z.infer<typeof schema>;

export const taskClaimTool: UnifiedTool = {
  name: 'task-claim',
  description: 'Claim a task to start working on it',
  zodSchema: schema,

  execute: async (args): Promise<string> => {
    const input = args as TaskClaimArgs;

    if (!checkRateLimit('kanban-operations', { maxRequests: 100, windowMs: 60000 })) {
      return JSON.stringify({
        success: false,
        error: 'Rate limit exceeded for kanban operations',
        code: 'RATE_LIMIT_EXCEEDED',
      });
    }

    try {
      let taskId = input.taskId;

      // If no specific task, get next available
      if (!taskId) {
        if (!input.sessionId) {
          return JSON.stringify({
            success: false,
            error: 'Either taskId or sessionId is required',
            code: 'MISSING_PARAM',
          });
        }

        const available = await getAvailableTasks(input.sessionId);
        if (available.length === 0) {
          return JSON.stringify({
            success: false,
            error: 'No available tasks to claim',
            code: 'NO_TASKS',
          });
        }

        taskId = available[0].id;
      }

      const task = await claimTask(taskId, input.agentId);

      if (!task) {
        return JSON.stringify({
          success: false,
          error: 'Task not found',
          code: 'TASK_NOT_FOUND',
        });
      }

      Logger.debug(`task-claim: agent ${input.agentId} claimed task ${task.id}: ${task.title}`);

      return JSON.stringify({
        success: true,
        task: {
          id: task.id,
          title: task.title,
          description: task.description,
          status: task.status,
          priority: task.priority,
          assignee: task.assignee,
          blockedBy: task.blockedBy,
          relatedFiles: task.relatedFiles,
          labels: task.labels,
          estimatedMinutes: task.estimatedMinutes,
        },
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      Logger.error(`task-claim error: ${errorMessage}`);

      return JSON.stringify({
        success: false,
        error: errorMessage,
        code: 'CLAIM_ERROR',
      });
    }
  },
};
