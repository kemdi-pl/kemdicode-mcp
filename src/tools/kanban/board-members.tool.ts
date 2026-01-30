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

const operationSchema = z.object({
  boardId: z.string().min(1).describe('Board ID'),
  action: z.enum(['list', 'update-role', 'remove']).default('list').describe('Action'),
  targetAgentId: z.string().optional().describe('Agent to modify (for update-role/remove)'),
  newRole: z
    .enum(['owner', 'admin', 'member', 'viewer'])
    .optional()
    .describe('New role (for update-role)'),
});

const schema = z.object({
  operations: z.array(operationSchema).min(1).max(20).describe('Member operations (1-20)'),
  requestingAgentId: z.string().min(1).describe('Requesting agent ID'),
});

type BoardMembersArgs = z.infer<typeof schema>;

export const boardMembersTool: UnifiedTool = {
  name: 'board-members',
  description: 'Manage board membership: list, update-role, remove (1-20 ops).',
  zodSchema: schema,

  execute: async (args): Promise<string> => {
    const { operations, requestingAgentId } = args as BoardMembersArgs;

    if (!checkRateLimit('kanban-operations', { maxRequests: 100, windowMs: 60000 })) {
      return JSON.stringify({
        success: false,
        error: 'Rate limit exceeded for kanban operations',
        code: 'RATE_LIMIT_EXCEEDED',
      });
    }

    const results = await Promise.all(
      operations.map(async (op) => {
        try {
          if (op.action === 'list') {
            const members = await listBoardMembers(op.boardId);
            return {
              boardId: op.boardId,
              action: 'list',
              success: true,
              count: members.length,
              members: members.map((m) => ({
                agentId: m.agentId,
                sessionId: m.sessionId,
                role: m.role,
                joinedAt: m.joinedAt,
                invitedBy: m.invitedBy,
                permissions: m.permissions,
              })),
            };
          }

          if (op.action === 'update-role') {
            if (!op.targetAgentId || !op.newRole) {
              return {
                boardId: op.boardId,
                action: 'update-role',
                success: false,
                error: 'targetAgentId and newRole required',
                code: 'MISSING_PARAMS',
              };
            }

            const canManage = await hasPermission(op.boardId, requestingAgentId, 'canManageBoard');
            const canInvite = await hasPermission(op.boardId, requestingAgentId, 'canInviteMembers');
            if (!canManage && !canInvite) {
              return {
                boardId: op.boardId,
                action: 'update-role',
                success: false,
                error: 'Permission denied',
                code: 'PERMISSION_DENIED',
              };
            }

            const updated = await updateMemberRole(
              op.boardId,
              op.targetAgentId,
              op.newRole as BoardRole
            );

            if (!updated) {
              return {
                boardId: op.boardId,
                action: 'update-role',
                success: false,
                error: 'Member not found',
                code: 'NOT_FOUND',
              };
            }

            Logger.debug(`board-members: updated ${op.targetAgentId} role to ${op.newRole}`);
            return {
              boardId: op.boardId,
              action: 'update-role',
              agentId: op.targetAgentId,
              newRole: op.newRole,
              success: true,
            };
          }

          if (op.action === 'remove') {
            if (!op.targetAgentId) {
              return {
                boardId: op.boardId,
                action: 'remove',
                success: false,
                error: 'targetAgentId required',
                code: 'MISSING_PARAMS',
              };
            }

            const canManage = await hasPermission(op.boardId, requestingAgentId, 'canManageBoard');
            if (!canManage) {
              return {
                boardId: op.boardId,
                action: 'remove',
                success: false,
                error: 'Permission denied',
                code: 'PERMISSION_DENIED',
              };
            }

            const removed = await removeBoardMember(op.boardId, op.targetAgentId);
            if (!removed) {
              return {
                boardId: op.boardId,
                action: 'remove',
                success: false,
                error: 'Member not found',
                code: 'NOT_FOUND',
              };
            }

            Logger.debug(`board-members: removed ${op.targetAgentId} from board ${op.boardId}`);
            return {
              boardId: op.boardId,
              action: 'remove',
              agentId: op.targetAgentId,
              success: true,
            };
          }

          return {
            boardId: op.boardId,
            action: op.action,
            success: false,
            error: 'Unknown action',
            code: 'UNKNOWN_ACTION',
          };
        } catch (error) {
          return {
            boardId: op.boardId,
            action: op.action,
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
      processed: successful.length,
      failed: failed.length,
      results,
    });
  },
};
