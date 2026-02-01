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
 * Board Members Tool
 *
 * Lists and manages board membership.
 *
 * @module tools/kanban/board-members
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { Logger } from '../../utils/logger.js';
import { executeWithGuard } from '../tool-shared.js';
import {
  listBoardMembers,
  updateMemberRole,
  removeBoardMember,
  hasPermission,
  BoardRole,
  resolveBoardId,
  resolveSessionId,
} from '../../kanban/index.js';
import { isSilent } from '../../config/silent.js';

const operationSchema = z.object({
  boardId: z.string().min(1).describe('Board ID or "name:Board Name"'),
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

  metadata: {
    category: 'kanban',
    tags: ['board', 'members', 'roles'],
    examples: [
      { args: { operations: [{ boardId: 'board-abc123', action: 'list' }], requestingAgentId: 'agent-1' }, description: 'List all members of a board' },
      { args: { operations: [{ boardId: 'board-abc123', action: 'update-role', targetAgentId: 'agent-2', newRole: 'admin' }], requestingAgentId: 'agent-1' }, description: 'Promote an agent to admin role' },
    ],
    relatedTools: ['board-invite', 'board-share'],
  },

  execute: async (args): Promise<string> => {
    const { operations, requestingAgentId } = args as BoardMembersArgs;

    return executeWithGuard('board-members', 'kanban-operations', async () => {
    // Resolve sessionId for name lookups
    const sessionId = resolveSessionId();

    const results = await Promise.all(
      operations.map(async (op) => {
        try {
          // Resolve boardId by name if needed
          const resolvedBoardId = await resolveBoardId(op.boardId, sessionId);

          if (op.action === 'list') {
            const members = await listBoardMembers(resolvedBoardId);
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

            const canManage = await hasPermission(resolvedBoardId, requestingAgentId, 'canManageBoard');
            const canInvite = await hasPermission(resolvedBoardId, requestingAgentId, 'canInviteMembers');
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
              resolvedBoardId,
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

            const canManage = await hasPermission(resolvedBoardId, requestingAgentId, 'canManageBoard');
            if (!canManage) {
              return {
                boardId: resolvedBoardId,
                action: 'remove',
                success: false,
                error: 'Permission denied',
                code: 'PERMISSION_DENIED',
              };
            }

            const removed = await removeBoardMember(resolvedBoardId, op.targetAgentId);
            if (!removed) {
              return {
                boardId: op.boardId,
                action: 'remove',
                success: false,
                error: 'Member not found',
                code: 'NOT_FOUND',
              };
            }

            Logger.debug(`board-members: removed ${op.targetAgentId} from board ${resolvedBoardId}`);
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

    // Silent mode: compact results
    if (isSilent()) {
      return JSON.stringify(results.map((r) => {
        if (r.action === 'list' && r.success && 'members' in r) {
          return { action: 'list', members: (r as { members: Array<{ agentId: string; role: string }> }).members.map((m) => ({ id: m.agentId, role: m.role })) };
        }
        return { action: r.action, success: r.success, error: 'error' in r ? r.error : undefined };
      }));
    }

    return JSON.stringify({
      success: failed.length === 0,
      processed: successful.length,
      failed: failed.length,
      results,
    });
    });
  },
};
