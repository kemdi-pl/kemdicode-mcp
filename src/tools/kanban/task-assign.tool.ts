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
 * Task Assign Tool (Batch)
 *
 * Supervisor tool to assign 1-N tasks to agents in a single call.
 *
 * @module tools/kanban/task-assign
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { Logger } from '../../utils/logger.js';
import { checkRateLimit } from '../../utils/validation.js';
import { assignTask } from '../../kanban/index.js';

const assignmentSchema = z.object({
  taskId: z.string().min(1).describe('Task ID'),
  assigneeId: z.string().min(1).describe('Target agent ID'),
});

const schema = z.object({
  assignments: z
    .array(assignmentSchema)
    .min(1)
    .max(20)
    .describe('Task assignments (1-20)'),
  supervisorId: z.string().min(1).describe('Supervisor agent ID'),
});

type TaskAssignArgs = z.infer<typeof schema>;

interface AssignResult {
  taskId: string;
  assigneeId: string;
  title?: string;
  success: boolean;
  error?: string;
}

export const taskAssignTool: UnifiedTool = {
  name: 'task-assign',
  description: 'Batch assign 1-20 tasks to agents',
  zodSchema: schema,

  execute: async (args): Promise<string> => {
    const input = args as TaskAssignArgs;

    if (!checkRateLimit('kanban-operations', { maxRequests: 100, windowMs: 60000 })) {
      return JSON.stringify({
        success: false,
        error: 'Rate limit exceeded for kanban operations',
        code: 'RATE_LIMIT_EXCEEDED',
      });
    }

    const results: AssignResult[] = [];

    // Assign all tasks in parallel
    const assignPromises = input.assignments.map(async (assignment) => {
      try {
        const task = await assignTask(assignment.taskId, assignment.assigneeId, input.supervisorId);

        if (!task) {
          return {
            taskId: assignment.taskId,
            assigneeId: assignment.assigneeId,
            success: false,
            error: 'Task not found',
          };
        }

        Logger.debug(
          `task-assign: supervisor ${input.supervisorId} assigned task ${task.id} to ${assignment.assigneeId}`
        );

        return {
          taskId: task.id,
          assigneeId: assignment.assigneeId,
          title: task.title,
          success: true,
        };
      } catch (error) {
        return {
          taskId: assignment.taskId,
          assigneeId: assignment.assigneeId,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });

    const assignResults = await Promise.all(assignPromises);
    results.push(...assignResults);

    const successful = results.filter((r) => r.success);
    const failed = results.filter((r) => !r.success);

    return JSON.stringify({
      success: failed.length === 0,
      supervisorId: input.supervisorId,
      assigned: successful.length,
      failed: failed.length,
      results: results.map((r) => ({
        taskId: r.taskId,
        assigneeId: r.assigneeId,
        title: r.title,
        success: r.success,
        error: r.error,
      })),
    });
  },
};
