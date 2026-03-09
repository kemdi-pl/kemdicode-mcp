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
 * Task Subtask Tool
 *
 * Manages subtask hierarchies using parentTaskId and subtaskIds fields.
 * Supports creating subtasks under a parent, listing subtasks, and
 * promoting subtasks to standalone tasks.
 *
 * @module tools/kanban/task-subtask
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { Logger } from '../../utils/logger.js';
import { executeWithGuard } from '../tool-shared.js';
import {
  createTask,
  getTask,
  TaskPriority,
  resolveSessionId,
  KANBAN_KEYS,
} from '../../kanban/index.js';
import { getSharedRedis } from '../../infrastructure/redis/connection.js';
import { isSilent } from '../../config/silent.js';

const schema = z.object({
  action: z
    .enum(['create', 'list', 'promote'])
    .describe('Action: create (subtask under parent), list (subtasks of parent), promote (subtask to standalone)'),
  sessionId: z.string().optional().describe('Session ID (auto-detected)'),
  // create & list
  parentTaskId: z
    .string()
    .optional()
    .describe('Parent task ID (required for create, list)'),
  // create
  title: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe('Subtask title (required for create)'),
  description: z.string().optional().describe('Subtask description (create)'),
  priority: z
    .enum(['critical', 'high', 'normal', 'low'])
    .optional()
    .default('normal')
    .describe('Priority (create)'),
  createdBy: z.string().optional().describe('Creator agent ID (create)'),
  // promote
  taskId: z
    .string()
    .optional()
    .describe('Task ID to promote (required for promote)'),
});

type TaskSubtaskArgs = z.infer<typeof schema>;

export const taskSubtaskTool: UnifiedTool = {
  name: 'task-subtask',
  description:
    'Manage subtask hierarchies: create subtasks under a parent, list subtasks, or promote subtask to standalone',
  zodSchema: schema,

  metadata: {
    category: 'kanban',
    tags: ['task', 'subtask', 'hierarchy', 'parent'],
    examples: [
      {
        args: {
          action: 'create',
          parentTaskId: 'task-abc123',
          title: 'Implement login form',
          priority: 'high',
          createdBy: 'agent-1',
        },
        description: 'Create a subtask under a parent task',
      },
      {
        args: { action: 'list', parentTaskId: 'task-abc123' },
        description: 'List all subtasks of a parent task',
      },
      {
        args: { action: 'promote', taskId: 'task-xyz789' },
        description: 'Promote a subtask to a standalone task',
      },
    ],
    relatedTools: ['task-create', 'task-get', 'task-list', 'task-update'],
  },

  execute: async (args): Promise<string> => {
    const input = args as unknown as TaskSubtaskArgs;

    return executeWithGuard('task-subtask', 'kanban-operations', async () => {
      switch (input.action) {
        case 'create':
          return handleCreate(input);
        case 'list':
          return handleList(input);
        case 'promote':
          return handlePromote(input);
        default:
          return JSON.stringify({
            success: false,
            error: `Unknown action: ${input.action}`,
          });
      }
    });
  },
};

/**
 * Create a subtask under a parent task.
 * Sets parentTaskId on the new task and adds its ID to the parent's subtaskIds[].
 */
async function handleCreate(input: TaskSubtaskArgs): Promise<string> {
  if (!input.parentTaskId) {
    return JSON.stringify({
      success: false,
      error: 'parentTaskId is required for create action',
      code: 'MISSING_PARENT_TASK_ID',
    });
  }

  if (!input.title) {
    return JSON.stringify({
      success: false,
      error: 'title is required for create action',
      code: 'MISSING_TITLE',
    });
  }

  // Resolve session ID
  const sessionId = resolveSessionId(input.sessionId);

  // Verify parent task exists
  const parentTask = await getTask(input.parentTaskId);
  if (!parentTask) {
    return JSON.stringify({
      success: false,
      error: `Parent task ${input.parentTaskId} not found`,
      code: 'PARENT_NOT_FOUND',
    });
  }

  // Create the subtask using existing createTask (which already handles parentTaskId)
  const subtask = await createTask({
    sessionId,
    boardId: parentTask.boardId,
    title: input.title,
    description: input.description,
    priority: (input.priority as TaskPriority) || 'normal',
    createdBy: input.createdBy || 'system',
    parentTaskId: input.parentTaskId,
  });

  // Update parent task's subtaskIds array in Redis
  // If this fails, rollback by deleting the subtask to maintain atomicity
  const client = await getSharedRedis();
  const currentSubtaskIds = parentTask.subtaskIds || [];
  if (!currentSubtaskIds.includes(subtask.id)) {
    currentSubtaskIds.push(subtask.id);
    try {
      await client.hset(
        KANBAN_KEYS.task(input.parentTaskId),
        'subtaskIds',
        JSON.stringify(currentSubtaskIds),
        'updatedAt',
        Date.now().toString()
      );
    } catch (parentUpdateError) {
      // Rollback: delete the orphaned subtask
      Logger.error(
        `task-subtask: failed to update parent ${input.parentTaskId}, rolling back subtask ${subtask.id}: ${parentUpdateError}`
      );
      try {
        const { deleteTask } = await import('../../kanban/index.js');
        await deleteTask(subtask.id);
      } catch (rollbackError) {
        Logger.error(
          `task-subtask: rollback failed for subtask ${subtask.id}: ${rollbackError}`
        );
      }
      return JSON.stringify({
        success: false,
        error: `Failed to link subtask to parent: ${parentUpdateError instanceof Error ? parentUpdateError.message : String(parentUpdateError)}`,
        code: 'PARENT_UPDATE_FAILED',
      });
    }
  }

  Logger.debug(
    `task-subtask: created subtask ${subtask.id} under parent ${input.parentTaskId}`
  );

  if (isSilent()) {
    return JSON.stringify({
      subtaskId: subtask.id,
      parentTaskId: input.parentTaskId,
    });
  }

  return JSON.stringify({
    success: true,
    action: 'create',
    subtask: {
      id: subtask.id,
      title: subtask.title,
      description: subtask.description,
      status: subtask.status,
      priority: subtask.priority,
      boardId: subtask.boardId,
      parentTaskId: subtask.parentTaskId,
      createdBy: subtask.createdBy,
      createdAt: subtask.createdAt,
    },
    parentTaskId: input.parentTaskId,
    parentTitle: parentTask.title,
    totalSubtasks: currentSubtaskIds.length,
  });
}

/**
 * List all subtasks of a given parent task.
 * Reads parent's subtaskIds and fetches each subtask.
 */
async function handleList(input: TaskSubtaskArgs): Promise<string> {
  if (!input.parentTaskId) {
    return JSON.stringify({
      success: false,
      error: 'parentTaskId is required for list action',
      code: 'MISSING_PARENT_TASK_ID',
    });
  }

  // Verify parent task exists
  const parentTask = await getTask(input.parentTaskId);
  if (!parentTask) {
    return JSON.stringify({
      success: false,
      error: `Parent task ${input.parentTaskId} not found`,
      code: 'PARENT_NOT_FOUND',
    });
  }

  const subtaskIds = parentTask.subtaskIds || [];

  if (subtaskIds.length === 0) {
    if (isSilent()) {
      return JSON.stringify([]);
    }

    return JSON.stringify({
      success: true,
      action: 'list',
      parentTaskId: input.parentTaskId,
      parentTitle: parentTask.title,
      subtasks: [],
      totalSubtasks: 0,
    });
  }

  // Fetch all subtasks in parallel
  const subtaskPromises = subtaskIds.map((id) => getTask(id));
  const subtaskResults = await Promise.all(subtaskPromises);
  const subtasks = subtaskResults.filter(
    (t): t is NonNullable<typeof t> => t !== null
  );

  Logger.debug(
    `task-subtask: listed ${subtasks.length} subtasks for parent ${input.parentTaskId}`
  );

  if (isSilent()) {
    return JSON.stringify(
      subtasks.map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        priority: t.priority,
        assignee: t.assignee,
      }))
    );
  }

  const statusIcon = (s: string) =>
    ({
      backlog: '📋',
      in_progress: '🔄',
      review: '👀',
      done: '✅',
    })[s] || '📋';

  const priorityIcon = (p: string) =>
    ({
      critical: '🔴',
      high: '🟠',
      normal: '🟢',
      low: '⚪',
    })[p] || '⚪';

  return JSON.stringify({
    success: true,
    action: 'list',
    parentTaskId: input.parentTaskId,
    parentTitle: parentTask.title,
    parentStatus: parentTask.status,
    totalSubtasks: subtasks.length,
    byStatus: {
      backlog: subtasks.filter((t) => t.status === 'backlog').length,
      in_progress: subtasks.filter((t) => t.status === 'in_progress').length,
      review: subtasks.filter((t) => t.status === 'review').length,
      done: subtasks.filter((t) => t.status === 'done').length,
    },
    subtasks: subtasks.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      statusIcon: statusIcon(t.status),
      priority: t.priority,
      priorityIcon: priorityIcon(t.priority),
      assignee: t.assignee,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    })),
  });
}

/**
 * Promote a subtask to a standalone task.
 * Removes parentTaskId from the subtask and removes its ID from the parent's subtaskIds[].
 */
async function handlePromote(input: TaskSubtaskArgs): Promise<string> {
  if (!input.taskId) {
    return JSON.stringify({
      success: false,
      error: 'taskId is required for promote action',
      code: 'MISSING_TASK_ID',
    });
  }

  // Get the subtask
  const subtask = await getTask(input.taskId);
  if (!subtask) {
    return JSON.stringify({
      success: false,
      error: `Task ${input.taskId} not found`,
      code: 'TASK_NOT_FOUND',
    });
  }

  if (!subtask.parentTaskId) {
    return JSON.stringify({
      success: false,
      error: `Task ${input.taskId} is not a subtask (no parentTaskId)`,
      code: 'NOT_A_SUBTASK',
    });
  }

  const parentTaskId = subtask.parentTaskId;
  const client = await getSharedRedis();

  // Remove parentTaskId from the subtask
  await client.hset(
    KANBAN_KEYS.task(input.taskId),
    'parentTaskId',
    '',
    'updatedAt',
    Date.now().toString()
  );

  // Remove from parent's subtaskIds array
  const parentTask = await getTask(parentTaskId);
  if (parentTask) {
    const updatedSubtaskIds = (parentTask.subtaskIds || []).filter(
      (id) => id !== input.taskId
    );
    await client.hset(
      KANBAN_KEYS.task(parentTaskId),
      'subtaskIds',
      JSON.stringify(updatedSubtaskIds),
      'updatedAt',
      Date.now().toString()
    );
  }

  // Also remove from the subtasks SET (used by createTask pipeline)
  await client.srem(KANBAN_KEYS.subtasks(parentTaskId), input.taskId!);

  Logger.debug(
    `task-subtask: promoted subtask ${input.taskId} from parent ${parentTaskId}`
  );

  if (isSilent()) {
    return JSON.stringify({
      taskId: input.taskId,
      promoted: true,
    });
  }

  return JSON.stringify({
    success: true,
    action: 'promote',
    task: {
      id: subtask.id,
      title: subtask.title,
      status: subtask.status,
      priority: subtask.priority,
    },
    previousParentTaskId: parentTaskId,
    previousParentTitle: parentTask?.title,
    message: `Task "${subtask.title}" promoted to standalone (removed from parent "${parentTask?.title || parentTaskId}")`,
  });
}
