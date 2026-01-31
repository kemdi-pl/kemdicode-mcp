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
 * Board Delete Tool (Batch)
 *
 * Deletes 1-N boards from the Kanban system in a single call.
 * Optionally cascade-deletes all tasks on those boards.
 *
 * @module tools/kanban/board-delete
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { Logger } from '../../utils/logger.js';
import { checkRateLimit } from '../../utils/validation.js';
import { deleteBoard, getBoard, listTasks, deleteTask, resolveSessionId, resolveBoardId } from '../../kanban/index.js';

const schema = z.object({
  boardIds: z.array(z.string().min(1)).min(1).max(10).describe('Board IDs or "name:Board Name" to delete (1-10)'),
  sessionId: z.string().optional().describe('Session ID (auto-detected from connection if omitted)'),
  deleteTasks: z.boolean().default(false).describe('Also delete all tasks on the board'),
});

type BoardDeleteArgs = z.infer<typeof schema>;

interface BoardDeleteResult {
  boardId: string;
  success: boolean;
  tasksDeleted?: number;
  error?: string;
}

export const boardDeleteTool: UnifiedTool = {
  name: 'board-delete',
  description: 'Batch delete 1-10 boards, optionally cascade-deleting their tasks',
  zodSchema: schema,

  metadata: {
    category: 'kanban',
    tags: ['board', 'delete'],
    examples: [
      { args: { boardIds: ['board-abc123'], deleteTasks: false }, description: 'Delete a board keeping its tasks' },
      { args: { boardIds: ['name:Sprint 1'], deleteTasks: true }, description: 'Delete a board by name and cascade-delete all tasks' },
    ],
    relatedTools: ['board-create', 'board-list'],
  },

  execute: async (args): Promise<string> => {
    const input = args as unknown as BoardDeleteArgs;

    if (!checkRateLimit('kanban-operations', { maxRequests: 100, windowMs: 60000 })) {
      return JSON.stringify({
        success: false,
        error: 'Rate limit exceeded for kanban operations',
        code: 'RATE_LIMIT_EXCEEDED',
      });
    }

    // Resolve sessionId from args or active connection context
    const sessionId = resolveSessionId(input.sessionId);

    const results: BoardDeleteResult[] = [];

    // Delete all boards in parallel
    const deletePromises = input.boardIds.map(async (rawBoardId) => {
      // Resolve boardId by name if needed
      const boardId = await resolveBoardId(rawBoardId, sessionId);
      try {
        const board = await getBoard(boardId);

        if (!board) {
          Logger.debug(`board-delete: board ${boardId} not found`);
          return {
            boardId,
            success: false,
            error: 'Board not found',
          };
        }

        let tasksDeleted = 0;

        // Cascade delete tasks if requested
        if (input.deleteTasks) {
          const tasks = await listTasks(sessionId, { boardId }, 1000);
          for (const task of tasks) {
            const deleted = await deleteTask(task.id);
            if (deleted) tasksDeleted++;
          }
        }

        const deleted = await deleteBoard(boardId);

        if (!deleted) {
          return {
            boardId,
            success: false,
            error: 'Failed to delete board',
          };
        }

        Logger.debug(
          `board-delete: deleted board ${boardId}${tasksDeleted > 0 ? ` with ${tasksDeleted} tasks` : ''}`
        );

        return {
          boardId,
          success: true,
          tasksDeleted: input.deleteTasks ? tasksDeleted : undefined,
        };
      } catch (error) {
        return {
          boardId,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });

    const deleteResults = await Promise.all(deletePromises);
    results.push(...deleteResults);

    const successful = results.filter((r) => r.success);
    const failed = results.filter((r) => !r.success);

    return JSON.stringify({
      success: failed.length === 0,
      sessionId,
      deleted: successful.length,
      failed: failed.length,
      results: results.map((r) => ({
        boardId: r.boardId,
        success: r.success,
        tasksDeleted: r.tasksDeleted,
        error: r.error,
      })),
    });
  },
};
