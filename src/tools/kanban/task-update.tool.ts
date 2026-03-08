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
 * Task Update Tool (Batch)
 *
 * Updates 1-N tasks on the Kanban board in a single call.
 *
 * @module tools/kanban/task-update
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { Logger } from '../../utils/logger.js';
import { executeWithGuard } from '../tool-shared.js';
import { updateTask, getTask, TaskStatus, TaskPriority } from '../../kanban/index.js';
import { isSilent } from '../../config/silent.js';

const updateSchema = z.object({
  taskId: z.string().min(1).describe('Task ID'),
  title: z.string().min(1).max(200).optional().describe('New title'),
  description: z.string().optional().describe('New description'),
  status: z
    .enum(['backlog', 'in_progress', 'review', 'done'])
    .optional()
    .describe('New status: backlog (not started), in_progress (being worked on), review (awaiting review), done (completed)'),
  priority: z.enum(['critical', 'high', 'normal', 'low']).optional().describe('New priority: critical (urgent blocker), high (important), normal (standard), low (nice-to-have)'),
  blockedBy: z
    .array(z.string())
    .optional()
    .describe('Blocking task IDs (replaces existing)'),
  addBlockedBy: z.array(z.string()).optional().describe('Task IDs to add to blockedBy'),
  addBlocks: z.array(z.string()).optional().describe('Task IDs this task blocks'),
  relatedFiles: z.array(z.string()).optional().describe('Related files'),
  labels: z.array(z.string()).optional().describe('Labels'),
  estimatedMinutes: z.number().positive().optional().describe('Time estimate in minutes'),
});

const schema = z.object({
  updates: z.array(updateSchema).min(1).max(20).describe('Task updates (1-20)'),
  agentId: z.string().min(1).describe('Agent ID'),
});

type TaskUpdateArgs = z.infer<typeof schema>;

interface UpdateResult {
  taskId: string;
  title?: string;
  status?: string;
  success: boolean;
  error?: string;
}

export const taskUpdateTool: UnifiedTool = {
  name: 'task-update',
  description: 'Batch update 1-20 tasks with taskId and fields to change',
  zodSchema: schema,

  metadata: {
    category: 'kanban',
    tags: ['task', 'update', 'status'],
    examples: [
      { args: { updates: [{ taskId: 'task-1', status: 'in_progress' }], agentId: 'agent-1' }, description: 'Move a task to in-progress' },
      { args: { updates: [{ taskId: 'task-1', status: 'done' }, { taskId: 'task-2', priority: 'critical' }], agentId: 'agent-1' }, description: 'Batch update status and priority' },
    ],
    relatedTools: ['task-get', 'task-list', 'task-create'],
  },

  execute: async (args): Promise<string> => {
    const input = args as unknown as TaskUpdateArgs;

    return executeWithGuard('task-update', 'kanban-operations', async () => {
    const results: UpdateResult[] = [];

    // Update all tasks in parallel
    const updatePromises = input.updates.map(async (upd) => {
      try {
        // Check if any update is provided
        const hasUpdate =
          upd.title !== undefined ||
          upd.description !== undefined ||
          upd.status !== undefined ||
          upd.priority !== undefined ||
          upd.blockedBy !== undefined ||
          upd.addBlockedBy !== undefined ||
          upd.addBlocks !== undefined ||
          upd.relatedFiles !== undefined ||
          upd.labels !== undefined ||
          upd.estimatedMinutes !== undefined;

        if (!hasUpdate) {
          return {
            taskId: upd.taskId,
            success: false,
            error: 'No update fields provided',
          };
        }

        // Handle addBlockedBy - merge with existing blockedBy
        let finalBlockedBy = upd.blockedBy;
        if (upd.addBlockedBy && upd.addBlockedBy.length > 0) {
          const currentTask = await getTask(upd.taskId);
          if (!currentTask) {
            return {
              taskId: upd.taskId,
              success: false,
              error: 'Task not found',
            };
          }
          const existingBlockedBy = new Set(currentTask.blockedBy);
          for (const id of upd.addBlockedBy) {
            existingBlockedBy.add(id);
          }
          finalBlockedBy = Array.from(existingBlockedBy);
        }

        // Handle addBlocks - update other tasks' blockedBy to include this task
        if (upd.addBlocks && upd.addBlocks.length > 0) {
          for (const blockedTaskId of upd.addBlocks) {
            const blockedTask = await getTask(blockedTaskId);
            if (blockedTask) {
              const newBlockedBy = new Set(blockedTask.blockedBy);
              newBlockedBy.add(upd.taskId);
              await updateTask(
                blockedTaskId,
                { blockedBy: Array.from(newBlockedBy) },
                input.agentId
              );
            }
          }
        }

        const task = await updateTask(
          upd.taskId,
          {
            title: upd.title,
            description: upd.description,
            status: upd.status as TaskStatus | undefined,
            priority: upd.priority as TaskPriority | undefined,
            blockedBy: finalBlockedBy,
            relatedFiles: upd.relatedFiles,
            labels: upd.labels,
            estimatedMinutes: upd.estimatedMinutes,
          },
          input.agentId
        );

        if (!task) {
          return {
            taskId: upd.taskId,
            success: false,
            error: 'Task not found',
          };
        }

        Logger.debug(`task-update: updated task ${task.id}`);

        return {
          taskId: task.id,
          title: task.title,
          status: task.status,
          success: true,
        };
      } catch (error) {
        return {
          taskId: upd.taskId,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });

    const updateResults = await Promise.all(updatePromises);
    results.push(...updateResults);

    const successful = results.filter((r) => r.success);
    const failed = results.filter((r) => !r.success);

    // Silent mode: return only updated IDs
    if (isSilent()) {
      if (failed.length > 0) {
        return JSON.stringify({ updated: successful.map((r) => r.taskId), errors: failed.map((r) => ({ id: r.taskId, error: r.error })) });
      }
      return JSON.stringify(successful.map((r) => r.taskId));
    }

    const getStatusIcon = (s?: string) =>
      ({
        backlog: '📋',
        in_progress: '🔄',
        review: '👀',
        done: '✅',
      })[s || ''] || '📋';

    return JSON.stringify({
      success: failed.length === 0,
      agentId: input.agentId,
      updated: successful.length,
      failed: failed.length,
      results: results.map((r) => ({
        taskId: r.taskId,
        title: r.title,
        status: r.status || undefined,
        statusIcon: r.status ? getStatusIcon(r.status) : undefined,
        success: r.success,
        error: r.error,
      })),
    });
    });
  },
};
