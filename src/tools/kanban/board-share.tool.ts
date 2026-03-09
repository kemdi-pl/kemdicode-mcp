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
 * Board Share Tool
 *
 * Shares a board with a workspace for cross-session access.
 *
 * @module tools/kanban/board-share
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { Logger } from '../../utils/logger.js';
import { executeWithGuard } from '../tool-shared.js';
import { shareBoard, hasPermission, resolveBoardId, resolveWorkspaceId, resolveSessionId } from '../../kanban/index.js';
import { isSilent } from '../../config/silent.js';

const shareItemSchema = z.object({
  boardId: z.string().min(1).describe('Board ID or "name:Board Name"'),
  workspaceId: z.string().min(1).describe('Target workspace ID or "name:Workspace Name"'),
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

  metadata: {
    category: 'kanban',
    tags: ['board', 'share', 'workspace'],
    examples: [
      { args: { shares: [{ boardId: 'board-abc123', workspaceId: 'ws-xyz', visibility: 'workspace' }], agentId: 'agent-1' }, description: 'Share a board with a workspace' },
      { args: { shares: [{ boardId: 'name:Sprint 1', workspaceId: 'name:My Workspace', visibility: 'public' }], agentId: 'agent-1' }, description: 'Share a board publicly by name' },
    ],
    relatedTools: ['board-invite', 'board-members', 'workspace-join'],
  },

  execute: async (args): Promise<string> => {
    const { shares, agentId } = args as BoardShareArgs;

    return executeWithGuard('board-share', 'kanban-operations', async () => {
    // Resolve sessionId for name lookups
    const sessionId = resolveSessionId();

    const results = await Promise.all(
      shares.map(async (item) => {
        try {
          // Resolve board and workspace by name if needed
          const resolvedBoardId = await resolveBoardId(item.boardId, sessionId);
          const resolvedWorkspaceId = await resolveWorkspaceId(item.workspaceId, sessionId);

          const canManage = await hasPermission(resolvedBoardId, agentId, 'canManageBoard');
          if (!canManage) {
            return {
              boardId: resolvedBoardId,
              success: false,
              error: 'Permission denied',
              code: 'PERMISSION_DENIED',
            };
          }

          const board = await shareBoard(resolvedBoardId, resolvedWorkspaceId, item.visibility);
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

    // Silent mode: return shared count
    if (isSilent()) {
      if (failed.length > 0) {
        return JSON.stringify({ shared: successful.length, errors: failed.map((r) => r.error) });
      }
      return JSON.stringify({ shared: successful.length });
    }

    return JSON.stringify({
      success: failed.length === 0,
      shared: successful.length,
      failed: failed.length,
      results,
    });
    });
  },
};
