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
 * Board List Tool
 *
 * Lists Kanban boards accessible to a session.
 *
 * @module tools/kanban/board-list
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { Logger } from '../../utils/logger.js';
import { executeWithGuard } from '../tool-shared.js';
import {
  listBoardsForSession,
  listBoardsForWorkspace,
  listAccessibleBoards,
  listWorkspacesForSession,
  resolveSessionId,
  resolveWorkspaceId,
} from '../../kanban/index.js';
import { isSilent } from '../../config/silent.js';

const schema = z.object({
  sessionId: z.string().optional().describe('Session ID (auto-detected from connection if omitted)'),
  workspaceId: z.string().optional().describe('Filter by workspace ID or "name:Workspace Name"'),
  includeWorkspaces: z
    .boolean()
    .default(true)
    .describe('Include workspace boards'),
});

type BoardListArgs = z.infer<typeof schema>;

export const boardListTool: UnifiedTool = {
  name: 'board-list',
  description: 'List accessible Kanban boards for session',
  zodSchema: schema,

  metadata: {
    category: 'kanban',
    tags: ['board', 'list'],
    examples: [
      { args: { includeWorkspaces: true }, description: 'List all accessible boards including workspace boards' },
      { args: { workspaceId: 'name:My Workspace' }, description: 'List boards in a specific workspace' },
    ],
    relatedTools: ['board-create', 'board-status'],
  },

  execute: async (args): Promise<string> => {
    const input = args as BoardListArgs;

    return executeWithGuard('board-list', 'kanban-operations', async () => {
      // Resolve sessionId from args or active connection context
      const sessionId = resolveSessionId(input.sessionId);

      // Resolve workspaceId by name if needed
      const resolvedWorkspaceId = input.workspaceId
        ? await resolveWorkspaceId(input.workspaceId, sessionId)
        : undefined;

      let boards;

      if (resolvedWorkspaceId) {
        // List boards in specific workspace
        boards = await listBoardsForWorkspace(resolvedWorkspaceId);
      } else if (input.includeWorkspaces) {
        // List all accessible boards (session + workspaces)
        const workspaces = await listWorkspacesForSession(sessionId);
        const workspaceIds = workspaces.map((ws) => ws.id);
        boards = await listAccessibleBoards(sessionId, workspaceIds);
      } else {
        // List only session's own boards
        boards = await listBoardsForSession(sessionId);
      }

      Logger.debug(`board-list: found ${boards.length} boards`);

      // Silent mode: compact board list
      if (isSilent()) {
        return JSON.stringify(boards.map((board) => ({
          id: board.id,
          name: board.name,
          tasks: board.taskCount,
        })));
      }

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
    });
  },
};
