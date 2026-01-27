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
 * Board List Tool
 *
 * Lists Kanban boards accessible to a session.
 *
 * @module tools/kanban/board-list
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { Logger } from '../../utils/logger.js';
import { checkRateLimit } from '../../utils/validation.js';
import {
  listBoardsForSession,
  listBoardsForWorkspace,
  listAccessibleBoards,
  listWorkspacesForSession,
} from '../../kanban/index.js';

const schema = z.object({
  sessionId: z.string().min(1).describe('Session ID to list boards for'),
  workspaceId: z.string().optional().describe('Filter by specific workspace'),
  includeWorkspaces: z
    .boolean()
    .default(true)
    .describe('Include boards from workspaces the session belongs to'),
});

type BoardListArgs = z.infer<typeof schema>;

export const boardListTool: UnifiedTool = {
  name: 'board-list',
  description: 'List Kanban boards accessible to a session',
  zodSchema: schema,

  execute: async (args): Promise<string> => {
    const input = args as BoardListArgs;

    if (!checkRateLimit('kanban-operations', { maxRequests: 100, windowMs: 60000 })) {
      return JSON.stringify({
        success: false,
        error: 'Rate limit exceeded for kanban operations',
        code: 'RATE_LIMIT_EXCEEDED',
      });
    }

    try {
      let boards;

      if (input.workspaceId) {
        // List boards in specific workspace
        boards = await listBoardsForWorkspace(input.workspaceId);
      } else if (input.includeWorkspaces) {
        // List all accessible boards (session + workspaces)
        const workspaces = await listWorkspacesForSession(input.sessionId);
        const workspaceIds = workspaces.map((ws) => ws.id);
        boards = await listAccessibleBoards(input.sessionId, workspaceIds);
      } else {
        // List only session's own boards
        boards = await listBoardsForSession(input.sessionId);
      }

      Logger.debug(`board-list: found ${boards.length} boards`);

      return JSON.stringify({
        success: true,
        count: boards.length,
        boards: boards.map((board) => ({
          id: board.id,
          name: board.name,
          description: board.description,
          sessionId: board.sessionId,
          workspaceId: board.workspaceId,
          visibility: board.visibility,
          taskCount: board.taskCount,
          activeAgentCount: board.activeAgentCount,
          createdAt: board.createdAt,
        })),
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      Logger.error(`board-list error: ${errorMessage}`);

      return JSON.stringify({
        success: false,
        error: errorMessage,
        code: 'LIST_ERROR',
      });
    }
  },
};
