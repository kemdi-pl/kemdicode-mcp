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
 * Board Share Tool
 *
 * Shares a board with a workspace for cross-session access.
 *
 * @module tools/kanban/board-share
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { Logger } from '../../utils/logger.js';
import { checkRateLimit } from '../../utils/validation.js';
import { shareBoard, hasPermission } from '../../kanban/index.js';

const schema = z.object({
  boardId: z.string().min(1).describe('Board ID'),
  workspaceId: z.string().min(1).describe('Target workspace ID'),
  visibility: z
    .enum(['workspace', 'public'])
    .default('workspace')
    .describe('Visibility level'),
  agentId: z.string().min(1).describe('Agent ID (must have permission)'),
});

type BoardShareArgs = z.infer<typeof schema>;

export const boardShareTool: UnifiedTool = {
  name: 'board-share',
  description: 'Share board with workspace for cross-session access',
  zodSchema: schema,

  execute: async (args): Promise<string> => {
    const input = args as BoardShareArgs;

    if (!checkRateLimit('kanban-operations', { maxRequests: 100, windowMs: 60000 })) {
      return JSON.stringify({
        success: false,
        error: 'Rate limit exceeded for kanban operations',
        code: 'RATE_LIMIT_EXCEEDED',
      });
    }

    try {
      // Check permission
      const canManage = await hasPermission(input.boardId, input.agentId, 'canManageBoard');
      if (!canManage) {
        return JSON.stringify({
          success: false,
          error: 'Agent does not have permission to manage this board',
          code: 'PERMISSION_DENIED',
        });
      }

      const board = await shareBoard(input.boardId, input.workspaceId, input.visibility);

      if (!board) {
        return JSON.stringify({
          success: false,
          error: 'Board not found',
          code: 'NOT_FOUND',
        });
      }

      Logger.debug(
        `board-share: shared board ${input.boardId} with workspace ${input.workspaceId}`
      );

      return JSON.stringify({
        success: true,
        board: {
          id: board.id,
          name: board.name,
          workspaceId: board.workspaceId,
          visibility: board.visibility,
        },
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      Logger.error(`board-share error: ${errorMessage}`);

      return JSON.stringify({
        success: false,
        error: errorMessage,
        code: 'SHARE_ERROR',
      });
    }
  },
};
