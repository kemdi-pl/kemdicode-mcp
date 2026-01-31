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
 * Task Create Tool (Batch)
 *
 * Creates 1-N tasks on the Kanban board in a single call.
 *
 * @module tools/kanban/task-create
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { Logger } from '../../utils/logger.js';
import { checkRateLimit } from '../../utils/validation.js';
import { createTask, TaskPriority, resolveSessionId, resolveBoardId } from '../../kanban/index.js';
import { isSilent } from '../../config/silent.js';

const taskSchema = z.object({
  title: z.string().min(1).max(200).describe('Task title'),
  description: z.string().optional().describe('Task description'),
  priority: z
    .enum(['critical', 'high', 'normal', 'low'])
    .default('normal')
    .describe('Priority level'),
  boardId: z.string().optional().describe('Board ID or "name:Board Name" (default board if omitted)'),
  blockedBy: z.array(z.string()).optional().describe('Blocking task IDs'),
  relatedFiles: z.array(z.string()).optional().describe('Related file paths'),
  labels: z.array(z.string()).optional().describe('Labels for categorization'),
  estimatedMinutes: z.number().positive().optional().describe('Time estimate in minutes'),
});

const schema = z.object({
  tasks: z.array(taskSchema).min(1).max(20).describe('Tasks to create (1-20)'),
  sessionId: z.string().optional().describe('Session ID (auto-detected from connection if omitted)'),
  createdBy: z.string().min(1).describe('Creator agent ID'),
});

type TaskCreateArgs = z.infer<typeof schema>;

interface CreateResult {
  title: string;
  taskId?: string;
  boardId?: string;
  priority: string;
  success: boolean;
  error?: string;
}

export const taskCreateTool: UnifiedTool = {
  name: 'task-create',
  description: 'Batch create 1-20 tasks on Kanban board',
  zodSchema: schema,
  metadata: {
    category: 'kanban',
    tags: ['task', 'create', 'batch'],
    examples: [
      { args: { tasks: [{ title: 'Implement auth', priority: 'high' }] }, description: 'Create a single high-priority task' },
      { args: { tasks: [{ title: 'Task A' }, { title: 'Task B' }], boardId: 'board-1' }, description: 'Create multiple tasks on a specific board' },
    ],
    relatedTools: ['task-list', 'task-update', 'task-assign'],
  },

  execute: async (args): Promise<string> => {
    const input = args as unknown as TaskCreateArgs;

    if (!checkRateLimit('kanban-operations', { maxRequests: 100, windowMs: 60000 })) {
      return JSON.stringify({
        success: false,
        error: 'Rate limit exceeded for kanban operations',
        code: 'RATE_LIMIT_EXCEEDED',
      });
    }

    // Resolve sessionId from args or active connection context
    const sessionId = resolveSessionId(input.sessionId);

    const results: CreateResult[] = [];

    // Create all tasks in parallel
    const createPromises = input.tasks.map(async (taskDef) => {
      try {
        // Resolve boardId by name if needed
        const resolvedBoardId = taskDef.boardId
          ? await resolveBoardId(taskDef.boardId, sessionId)
          : undefined;

        const task = await createTask({
          sessionId,
          boardId: resolvedBoardId,
          title: taskDef.title,
          description: taskDef.description,
          priority: taskDef.priority as TaskPriority,
          createdBy: input.createdBy,
          blockedBy: taskDef.blockedBy,
          relatedFiles: taskDef.relatedFiles,
          labels: taskDef.labels,
          estimatedMinutes: taskDef.estimatedMinutes,
        });

        Logger.debug(`task-create: created task ${task.id}: ${task.title}`);

        return {
          title: taskDef.title,
          taskId: task.id,
          boardId: task.boardId,
          priority: taskDef.priority,
          success: true,
        };
      } catch (error) {
        return {
          title: taskDef.title,
          priority: taskDef.priority,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });

    const createResults = await Promise.all(createPromises);
    results.push(...createResults);

    const successful = results.filter((r) => r.success);
    const failed = results.filter((r) => !r.success);

    // Silent mode: return only task IDs
    if (isSilent()) {
      if (failed.length > 0) {
        return JSON.stringify({ created: successful.map((r) => r.taskId), errors: failed.map((r) => r.error) });
      }
      return JSON.stringify(successful.map((r) => r.taskId));
    }

    const priorityIcon = (p: string) =>
      ({
        critical: '🔴',
        high: '🟠',
        normal: '🟢',
        low: '⚪',
      })[p] || '⚪';

    return JSON.stringify({
      success: failed.length === 0,
      sessionId,
      createdBy: input.createdBy,
      created: successful.length,
      failed: failed.length,
      tasks: results.map((r) => ({
        taskId: r.taskId,
        title: r.title,
        boardId: r.boardId,
        priority: r.priority,
        priorityIcon: priorityIcon(r.priority),
        success: r.success,
        error: r.error,
      })),
      // Quick reference for task IDs
      taskIds: successful.map((r) => r.taskId),
    });
  },
};
