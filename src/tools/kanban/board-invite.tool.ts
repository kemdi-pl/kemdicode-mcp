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
import { addBoardMember, hasPermission, isBoardMember, BoardRole, resolveBoardId, resolveSessionId } from '../../kanban/index.js';

const inviteItemSchema = z.object({
  boardId: z.string().min(1).describe('Board ID or "name:Board Name"'),
  agentId: z.string().min(1).describe('Agent to invite'),
  role: z
    .enum(['admin', 'member', 'viewer'])
    .default('member')
    .describe('Role (owner cannot be invited)'),
});

const schema = z.object({
  invites: z.array(inviteItemSchema).min(1).max(20).describe('Invitations to send (1-20)'),
  sessionId: z.string().optional().describe('Invited agents session ID (auto-detected from connection if omitted)'),
  invitingAgentId: z.string().min(1).describe('Inviting agent ID'),
});

type BoardInviteArgs = z.infer<typeof schema>;

export const boardInviteTool: UnifiedTool = {
  name: 'board-invite',
  description: 'Invite 1-20 agents to boards with roles. Returns results.',
  zodSchema: schema,

  metadata: {
    category: 'kanban',
    tags: ['board', 'invite', 'members'],
    examples: [
      { args: { invites: [{ boardId: 'board-abc123', agentId: 'agent-2', role: 'member' }], invitingAgentId: 'agent-1' }, description: 'Invite an agent as member to a board' },
      { args: { invites: [{ boardId: 'name:Sprint 1', agentId: 'agent-3', role: 'viewer' }], invitingAgentId: 'agent-1' }, description: 'Invite an agent as viewer by board name' },
    ],
    relatedTools: ['board-members', 'board-share'],
  },

  execute: async (args): Promise<string> => {
    const { invites, sessionId: rawSessionId, invitingAgentId } = args as BoardInviteArgs;

    if (!checkRateLimit('kanban-operations', { maxRequests: 100, windowMs: 60000 })) {
      return JSON.stringify({
        success: false,
        error: 'Rate limit exceeded for kanban operations',
        code: 'RATE_LIMIT_EXCEEDED',
      });
    }

    // Resolve sessionId from args or active connection context
    const sessionId = resolveSessionId(rawSessionId);

    const results = await Promise.all(
      invites.map(async (item) => {
        try {
          // Resolve boardId by name if needed
          const resolvedBoardId = await resolveBoardId(item.boardId, sessionId);

          const canInvite = await hasPermission(
            resolvedBoardId,
            invitingAgentId,
            'canInviteMembers'
          );
          if (!canInvite) {
            return {
              boardId: item.boardId,
              agentId: item.agentId,
              success: false,
              error: 'Permission denied',
              code: 'PERMISSION_DENIED',
            };
          }

          const alreadyMember = await isBoardMember(resolvedBoardId, item.agentId);
          if (alreadyMember) {
            return {
              boardId: resolvedBoardId,
              agentId: item.agentId,
              success: false,
              error: 'Already a member',
              code: 'ALREADY_MEMBER',
            };
          }

          const membership = await addBoardMember(
            resolvedBoardId,
            item.agentId,
            sessionId,
            item.role as BoardRole,
            invitingAgentId
          );

          Logger.debug(
            `board-invite: invited ${item.agentId} to board ${resolvedBoardId} as ${item.role}`
          );

          return {
            boardId: membership.boardId,
            agentId: membership.agentId,
            role: membership.role,
            joinedAt: membership.joinedAt,
            success: true,
          };
        } catch (error) {
          return {
            boardId: item.boardId,
            agentId: item.agentId,
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
      invited: successful.length,
      failed: failed.length,
      results,
    });
  },
};
