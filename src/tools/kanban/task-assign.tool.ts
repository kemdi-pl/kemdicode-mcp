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
 * Task Assign Tool (Batch)
 *
 * Supervisor tool to assign 1-N tasks to agents in a single call.
 *
 * @module tools/kanban/task-assign
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { Logger } from '../../utils/logger.js';
import { executeWithGuard } from '../tool-shared.js';
import { assignTask } from '../../kanban/index.js';
import { isSilent } from '../../config/silent.js';

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

  metadata: {
    category: 'kanban',
    tags: ['task', 'assign', 'agent'],
    examples: [
      { args: { assignments: [{ taskId: 'task-1', assigneeId: 'agent-2' }], supervisorId: 'agent-1' }, description: 'Assign a single task to an agent' },
      { args: { assignments: [{ taskId: 'task-1', assigneeId: 'agent-2' }, { taskId: 'task-2', assigneeId: 'agent-3' }], supervisorId: 'agent-1' }, description: 'Batch assign tasks to different agents' },
    ],
    relatedTools: ['task-create', 'task-list', 'task-push-multi'],
  },

  execute: async (args): Promise<string> => {
    const input = args as TaskAssignArgs;

    return executeWithGuard('task-assign', 'kanban-operations', async () => {
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

    // Silent mode: return assigned task IDs only
    if (isSilent()) {
      if (failed.length > 0) {
        return JSON.stringify({ assigned: successful.map((r) => r.taskId), errors: failed.map((r) => r.error) });
      }
      return JSON.stringify(successful.map((r) => r.taskId));
    }

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
    });
  },
};
