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
 * Task List Tool
 *
 * Lists tasks from the Kanban board with filters.
 *
 * @module tools/kanban/task-list
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { Logger } from '../../utils/logger.js';
import { executeWithGuard } from '../tool-shared.js';
import { listTasks, TaskStatus, TaskPriority, resolveSessionId, resolveBoardId } from '../../kanban/index.js';
import { isSilent } from '../../config/silent.js';

const schema = z.object({
  sessionId: z.string().optional().describe('Session ID (auto-detected from connection if omitted)'),
  boardId: z.string().optional().describe('Filter by board ID or "name:Board Name"'),
  status: z
    .enum(['backlog', 'in_progress', 'review', 'done'])
    .optional()
    .describe('Filter by status: backlog (not started), in_progress (being worked on), review (awaiting review), done (completed)'),
  priority: z.enum(['critical', 'high', 'normal', 'low']).optional().describe('Filter by priority: critical (urgent blocker), high (important), normal (standard), low (nice-to-have)'),
  assignee: z.string().optional().describe('Filter by agent'),
  unassigned: z.boolean().optional().describe('Only unassigned tasks'),
  blocked: z.boolean().optional().describe('Filter blocked tasks'),
  labels: z.array(z.string()).optional().describe('Filter by labels'),
  offset: z.number().int().min(0).optional().default(0).describe('Number of items to skip (for pagination)'),
  limit: z.number().min(1).max(100).default(50).describe('Max tasks to return'),
});

type TaskListArgs = z.infer<typeof schema>;

export const taskListTool: UnifiedTool = {
  name: 'task-list',
  description: 'List Kanban tasks with filters',
  zodSchema: schema,

  metadata: {
    category: 'kanban',
    tags: ['task', 'list', 'filter'],
    examples: [
      { args: { status: 'in_progress' }, description: 'List in-progress tasks' },
      { args: { assignee: 'agent-1', priority: 'high' }, description: 'List high-priority tasks assigned to an agent' },
      { args: { boardId: 'name:Sprint 1', unassigned: true }, description: 'List unassigned tasks on a board' },
    ],
    relatedTools: ['task-create', 'task-get', 'board-status'],
  },

  execute: async (args): Promise<string> => {
    const input = args as TaskListArgs;

    return executeWithGuard('task-list', 'kanban-operations', async () => {
      // Resolve sessionId from args or active connection context
      const sessionId = resolveSessionId(input.sessionId);

      // Resolve boardId by name if needed
      const resolvedBoardId = input.boardId
        ? await resolveBoardId(input.boardId, sessionId)
        : undefined;

      // Fetch enough tasks to cover offset + limit
      const fetchLimit = input.offset + input.limit;
      const allTasks = await listTasks(
        sessionId,
        {
          status: input.status as TaskStatus | undefined,
          priority: input.priority as TaskPriority | undefined,
          assignee: input.assignee,
          unassigned: input.unassigned,
          blocked: input.blocked,
          labels: input.labels,
          boardId: resolvedBoardId,
        },
        fetchLimit
      );

      // Apply pagination: slice after filtering/sorting (done in listTasks)
      const total = allTasks.length;
      const tasks = allTasks.slice(input.offset, input.offset + input.limit);
      const hasMore = input.offset + input.limit < total;

      Logger.debug(`task-list: found ${total} tasks, returning ${tasks.length} (offset=${input.offset}) for session ${sessionId}`);

      // Silent mode: minimal task objects
      if (isSilent()) {
        return JSON.stringify(tasks.map((t) => ({
          id: t.id, title: t.title, status: t.status, priority: t.priority, assignee: t.assignee ?? '',
        })));
      }

      return JSON.stringify({
        success: true,
        total,
        offset: input.offset,
        limit: input.limit,
        hasMore,
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
    });
  },
};
