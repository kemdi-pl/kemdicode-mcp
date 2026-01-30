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
 * Board Invite Tool
 *
 * Invites an agent to a board with a specified role.
 *
 * @module tools/kanban/board-invite
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { Logger } from '../../utils/logger.js';
import { checkRateLimit } from '../../utils/validation.js';
import { addBoardMember, hasPermission, isBoardMember, BoardRole } from '../../kanban/index.js';

const schema = z.object({
  boardId: z.string().min(1).describe('Board ID'),
  agentId: z.string().min(1).describe('Agent to invite'),
  sessionId: z.string().min(1).describe('Invited agent session ID'),
  role: z
    .enum(['admin', 'member', 'viewer'])
    .default('member')
    .describe('Role (owner cannot be invited)'),
  invitingAgentId: z.string().min(1).describe('Inviting agent ID'),
});

type BoardInviteArgs = z.infer<typeof schema>;

export const boardInviteTool: UnifiedTool = {
  name: 'board-invite',
  description: 'Invite agent to board with role',
  zodSchema: schema,

  execute: async (args): Promise<string> => {
    const input = args as BoardInviteArgs;

    if (!checkRateLimit('kanban-operations', { maxRequests: 100, windowMs: 60000 })) {
      return JSON.stringify({
        success: false,
        error: 'Rate limit exceeded for kanban operations',
        code: 'RATE_LIMIT_EXCEEDED',
      });
    }

    try {
      // Check inviter permission
      const canInvite = await hasPermission(
        input.boardId,
        input.invitingAgentId,
        'canInviteMembers'
      );
      if (!canInvite) {
        return JSON.stringify({
          success: false,
          error: 'Agent does not have permission to invite members',
          code: 'PERMISSION_DENIED',
        });
      }

      // Check if already a member
      const alreadyMember = await isBoardMember(input.boardId, input.agentId);
      if (alreadyMember) {
        return JSON.stringify({
          success: false,
          error: 'Agent is already a member of this board',
          code: 'ALREADY_MEMBER',
        });
      }

      const membership = await addBoardMember(
        input.boardId,
        input.agentId,
        input.sessionId,
        input.role as BoardRole,
        input.invitingAgentId
      );

      Logger.debug(
        `board-invite: invited ${input.agentId} to board ${input.boardId} as ${input.role}`
      );

      return JSON.stringify({
        success: true,
        membership: {
          boardId: membership.boardId,
          agentId: membership.agentId,
          sessionId: membership.sessionId,
          role: membership.role,
          invitedBy: membership.invitedBy,
          joinedAt: membership.joinedAt,
        },
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      Logger.error(`board-invite error: ${errorMessage}`);

      return JSON.stringify({
        success: false,
        error: errorMessage,
        code: 'INVITE_ERROR',
      });
    }
  },
};
