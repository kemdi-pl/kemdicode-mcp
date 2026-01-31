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
 * Task Delete Tool (Batch)
 *
 * Deletes 1-N tasks from the Kanban board in a single call.
 *
 * @module tools/kanban/task-delete
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { Logger } from '../../utils/logger.js';
import { checkRateLimit } from '../../utils/validation.js';
import { deleteTask, resolveSessionId } from '../../kanban/index.js';
import { isSilent } from '../../config/silent.js';

const schema = z.object({
  taskIds: z.array(z.string().min(1)).min(1).max(20).describe('Task IDs to delete (1-20)'),
  sessionId: z.string().optional().describe('Session ID (auto-detected from connection if omitted)'),
});

type TaskDeleteArgs = z.infer<typeof schema>;

interface DeleteResult {
  taskId: string;
  success: boolean;
  error?: string;
}

export const taskDeleteTool: UnifiedTool = {
  name: 'task-delete',
  description: 'Batch delete 1-20 tasks from Kanban board',
  zodSchema: schema,

  metadata: {
    category: 'kanban',
    tags: ['task', 'delete'],
    examples: [
      { args: { taskIds: ['task-abc123'] }, description: 'Delete a single task' },
      { args: { taskIds: ['task-1', 'task-2', 'task-3'] }, description: 'Batch delete multiple tasks' },
    ],
    relatedTools: ['task-create', 'task-list'],
  },

  execute: async (args): Promise<string> => {
    const input = args as unknown as TaskDeleteArgs;

    if (!checkRateLimit('kanban-operations', { maxRequests: 100, windowMs: 60000 })) {
      return JSON.stringify({
        success: false,
        error: 'Rate limit exceeded for kanban operations',
        code: 'RATE_LIMIT_EXCEEDED',
      });
    }

    // Resolve sessionId from args or active connection context
    const sessionId = resolveSessionId(input.sessionId);

    const results: DeleteResult[] = [];

    // Delete all tasks in parallel
    const deletePromises = input.taskIds.map(async (taskId) => {
      try {
        const deleted = await deleteTask(taskId);

        if (!deleted) {
          Logger.debug(`task-delete: task ${taskId} not found`);
          return {
            taskId,
            success: false,
            error: 'Task not found',
          };
        }

        Logger.debug(`task-delete: deleted task ${taskId}`);

        return {
          taskId,
          success: true,
        };
      } catch (error) {
        return {
          taskId,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });

    const deleteResults = await Promise.all(deletePromises);
    results.push(...deleteResults);

    const successful = results.filter((r) => r.success);
    const failed = results.filter((r) => !r.success);

    // Silent mode: return only count
    if (isSilent()) {
      if (failed.length > 0) {
        return JSON.stringify({ deleted: successful.length, errors: failed.map((r) => r.error) });
      }
      return JSON.stringify({ deleted: successful.length });
    }

    return JSON.stringify({
      success: failed.length === 0,
      sessionId,
      deleted: successful.length,
      failed: failed.length,
      results: results.map((r) => ({
        taskId: r.taskId,
        success: r.success,
        error: r.error,
      })),
    });
  },
};
