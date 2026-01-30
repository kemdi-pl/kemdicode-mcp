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
 * Board Members Tool
 *
 * Lists and manages board membership.
 *
 * @module tools/kanban/board-members
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { Logger } from '../../utils/logger.js';
import { checkRateLimit } from '../../utils/validation.js';
import {
  listBoardMembers,
  updateMemberRole,
  removeBoardMember,
  hasPermission,
  BoardRole,
} from '../../kanban/index.js';

const schema = z.object({
  boardId: z.string().min(1).describe('Board ID'),
  action: z.enum(['list', 'update-role', 'remove']).default('list').describe('Action'),
  targetAgentId: z.string().optional().describe('Agent to modify (for update-role/remove)'),
  newRole: z
    .enum(['owner', 'admin', 'member', 'viewer'])
    .optional()
    .describe('New role (for update-role)'),
  requestingAgentId: z.string().min(1).describe('Requesting agent ID'),
});

type BoardMembersArgs = z.infer<typeof schema>;

export const boardMembersTool: UnifiedTool = {
  name: 'board-members',
  description: 'Manage board membership and roles',
  zodSchema: schema,

  execute: async (args): Promise<string> => {
    const input = args as BoardMembersArgs;

    if (!checkRateLimit('kanban-operations', { maxRequests: 100, windowMs: 60000 })) {
      return JSON.stringify({
        success: false,
        error: 'Rate limit exceeded for kanban operations',
        code: 'RATE_LIMIT_EXCEEDED',
      });
    }

    try {
      if (input.action === 'list') {
        const members = await listBoardMembers(input.boardId);

        return JSON.stringify({
          success: true,
          boardId: input.boardId,
          count: members.length,
          members: members.map((m) => ({
            agentId: m.agentId,
            sessionId: m.sessionId,
            role: m.role,
            joinedAt: m.joinedAt,
            invitedBy: m.invitedBy,
            permissions: m.permissions,
          })),
        });
      }

      if (input.action === 'update-role') {
        if (!input.targetAgentId || !input.newRole) {
          return JSON.stringify({
            success: false,
            error: 'targetAgentId and newRole required for update-role',
            code: 'MISSING_PARAMS',
          });
        }

        // Check permission
        const canManage = await hasPermission(
          input.boardId,
          input.requestingAgentId,
          'canManageBoard'
        );
        const canInvite = await hasPermission(
          input.boardId,
          input.requestingAgentId,
          'canInviteMembers'
        );
        if (!canManage && !canInvite) {
          return JSON.stringify({
            success: false,
            error: 'Agent does not have permission to update roles',
            code: 'PERMISSION_DENIED',
          });
        }

        const updated = await updateMemberRole(
          input.boardId,
          input.targetAgentId,
          input.newRole as BoardRole
        );

        if (!updated) {
          return JSON.stringify({
            success: false,
            error: 'Member not found',
            code: 'NOT_FOUND',
          });
        }

        Logger.debug(`board-members: updated ${input.targetAgentId} role to ${input.newRole}`);

        return JSON.stringify({
          success: true,
          action: 'update-role',
          agentId: input.targetAgentId,
          newRole: input.newRole,
        });
      }

      if (input.action === 'remove') {
        if (!input.targetAgentId) {
          return JSON.stringify({
            success: false,
            error: 'targetAgentId required for remove',
            code: 'MISSING_PARAMS',
          });
        }

        // Check permission
        const canManage = await hasPermission(
          input.boardId,
          input.requestingAgentId,
          'canManageBoard'
        );
        if (!canManage) {
          return JSON.stringify({
            success: false,
            error: 'Agent does not have permission to remove members',
            code: 'PERMISSION_DENIED',
          });
        }

        const removed = await removeBoardMember(input.boardId, input.targetAgentId);

        if (!removed) {
          return JSON.stringify({
            success: false,
            error: 'Member not found',
            code: 'NOT_FOUND',
          });
        }

        Logger.debug(`board-members: removed ${input.targetAgentId} from board ${input.boardId}`);

        return JSON.stringify({
          success: true,
          action: 'remove',
          agentId: input.targetAgentId,
          boardId: input.boardId,
        });
      }

      return JSON.stringify({
        success: false,
        error: 'Unknown action',
        code: 'UNKNOWN_ACTION',
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      Logger.error(`board-members error: ${errorMessage}`);

      return JSON.stringify({
        success: false,
        error: errorMessage,
        code: 'MEMBER_ERROR',
      });
    }
  },
};
