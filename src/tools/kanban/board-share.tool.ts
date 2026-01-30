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

const shareItemSchema = z.object({
  boardId: z.string().min(1).describe('Board ID'),
  workspaceId: z.string().min(1).describe('Target workspace ID'),
  visibility: z
    .enum(['workspace', 'public'])
    .default('workspace')
    .describe('Visibility level'),
});

const schema = z.object({
  shares: z.array(shareItemSchema).min(1).max(10).describe('Shares to create (1-10)'),
  agentId: z.string().min(1).describe('Agent ID (must have permission)'),
});

type BoardShareArgs = z.infer<typeof schema>;

export const boardShareTool: UnifiedTool = {
  name: 'board-share',
  description: 'Share 1-10 boards with workspaces. Returns results.',
  zodSchema: schema,

  execute: async (args): Promise<string> => {
    const { shares, agentId } = args as BoardShareArgs;

    if (!checkRateLimit('kanban-operations', { maxRequests: 100, windowMs: 60000 })) {
      return JSON.stringify({
        success: false,
        error: 'Rate limit exceeded for kanban operations',
        code: 'RATE_LIMIT_EXCEEDED',
      });
    }

    const results = await Promise.all(
      shares.map(async (item) => {
        try {
          const canManage = await hasPermission(item.boardId, agentId, 'canManageBoard');
          if (!canManage) {
            return {
              boardId: item.boardId,
              success: false,
              error: 'Permission denied',
              code: 'PERMISSION_DENIED',
            };
          }

          const board = await shareBoard(item.boardId, item.workspaceId, item.visibility);
          if (!board) {
            return {
              boardId: item.boardId,
              success: false,
              error: 'Board not found',
              code: 'NOT_FOUND',
            };
          }

          Logger.debug(
            `board-share: shared board ${item.boardId} with workspace ${item.workspaceId}`
          );

          return {
            boardId: board.id,
            name: board.name,
            workspaceId: board.workspaceId,
            visibility: board.visibility,
            success: true,
          };
        } catch (error) {
          return {
            boardId: item.boardId,
            success: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      })
    );

    const successful = results.filter((r) => r.success);
    const failed = results.filter((r) => !r.success);

    return JSON.stringify({
      success: failed.length === 0,
      shared: successful.length,
      failed: failed.length,
      results,
    });
  },
};
