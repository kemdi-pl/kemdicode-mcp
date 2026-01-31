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
 * Workspace Delete Tool (Batch)
 *
 * Deletes 1-N workspaces. Requires ownership verification.
 * Optionally cascade-deletes all boards in the workspace.
 *
 * @module tools/kanban/workspace-delete
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { Logger } from '../../utils/logger.js';
import { checkRateLimit } from '../../utils/validation.js';
import {
  getWorkspace,
  deleteWorkspace,
  listBoardsForWorkspace,
  deleteBoard,
  resolveSessionId,
  resolveWorkspaceId,
} from '../../kanban/index.js';

const schema = z.object({
  workspaceIds: z
    .array(z.string().min(1))
    .min(1)
    .max(5)
    .describe('Workspace IDs or "name:Workspace Name" to delete (1-5)'),
  sessionId: z.string().optional().describe('Session ID (auto-detected from connection if omitted)'),
  ownerId: z.string().min(1).describe('Owner agent ID (must be workspace owner)'),
  deleteBoards: z.boolean().default(false).describe('Also delete all boards in workspace'),
});

type WorkspaceDeleteArgs = z.infer<typeof schema>;

interface WorkspaceDeleteResult {
  workspaceId: string;
  success: boolean;
  boardsDeleted?: number;
  error?: string;
}

export const workspaceDeleteTool: UnifiedTool = {
  name: 'workspace-delete',
  description: 'Batch delete 1-5 workspaces (requires ownership), optionally cascade-deleting boards',
  zodSchema: schema,

  metadata: {
    category: 'kanban',
    tags: ['workspace', 'delete'],
    examples: [
      { args: { workspaceIds: ['ws-abc123'], ownerId: 'agent-1', deleteBoards: false }, description: 'Delete a workspace keeping boards' },
      { args: { workspaceIds: ['name:Platform Team'], ownerId: 'agent-1', deleteBoards: true }, description: 'Delete a workspace and all its boards' },
    ],
    relatedTools: ['workspace-create', 'workspace-list'],
  },

  execute: async (args): Promise<string> => {
    const input = args as unknown as WorkspaceDeleteArgs;

    if (!checkRateLimit('kanban-operations', { maxRequests: 100, windowMs: 60000 })) {
      return JSON.stringify({
        success: false,
        error: 'Rate limit exceeded for kanban operations',
        code: 'RATE_LIMIT_EXCEEDED',
      });
    }

    // Resolve sessionId from args or active connection context
    const sessionId = resolveSessionId(input.sessionId);

    const results: WorkspaceDeleteResult[] = [];

    // Delete workspaces sequentially (ownership checks + cascades)
    for (const rawWorkspaceId of input.workspaceIds) {
      // Resolve workspaceId by name if needed
      const workspaceId = await resolveWorkspaceId(rawWorkspaceId, sessionId);
      try {
        const workspace = await getWorkspace(workspaceId);

        if (!workspace) {
          results.push({
            workspaceId,
            success: false,
            error: 'Workspace not found',
          });
          continue;
        }

        // Verify ownership by ownerId
        if (workspace.ownerId !== input.ownerId) {
          Logger.warn(
            `workspace-delete: agent ${input.ownerId} is not owner of workspace ${workspaceId}`
          );
          results.push({
            workspaceId,
            success: false,
            error: `Not authorized: workspace owned by ${workspace.ownerId}`,
          });
          continue;
        }

        let boardsDeleted = 0;

        // Cascade delete boards if requested
        if (input.deleteBoards) {
          const boards = await listBoardsForWorkspace(workspaceId);
          for (const board of boards) {
            const deleted = await deleteBoard(board.id);
            if (deleted) boardsDeleted++;
          }
        }

        // deleteWorkspace checks ownerSessionId, pass sessionId
        const deleted = await deleteWorkspace(workspaceId, sessionId);

        if (!deleted) {
          results.push({
            workspaceId,
            success: false,
            error: 'Failed to delete workspace (session may not be owner session)',
          });
          continue;
        }

        Logger.debug(
          `workspace-delete: deleted workspace ${workspaceId}${boardsDeleted > 0 ? ` with ${boardsDeleted} boards` : ''}`
        );

        results.push({
          workspaceId,
          success: true,
          boardsDeleted: input.deleteBoards ? boardsDeleted : undefined,
        });
      } catch (error) {
        results.push({
          workspaceId,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const successful = results.filter((r) => r.success);
    const failed = results.filter((r) => !r.success);

    return JSON.stringify({
      success: failed.length === 0,
      sessionId,
      ownerId: input.ownerId,
      deleted: successful.length,
      failed: failed.length,
      results: results.map((r) => ({
        workspaceId: r.workspaceId,
        success: r.success,
        boardsDeleted: r.boardsDeleted,
        error: r.error,
      })),
    });
  },
};
