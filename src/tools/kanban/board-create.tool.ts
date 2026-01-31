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
 * Board Create Tool
 *
 * Creates a new Kanban board in a session or workspace.
 *
 * @module tools/kanban/board-create
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { Logger } from '../../utils/logger.js';
import { checkRateLimit } from '../../utils/validation.js';
import { createBoard, addBoardMember, resolveSessionId, resolveWorkspaceId } from '../../kanban/index.js';

const boardItemSchema = z.object({
  name: z.string().min(1).max(100).describe('Board name'),
  description: z.string().max(500).optional().describe('Board description'),
  workspaceId: z.string().optional().describe('Workspace ID or "name:Workspace Name" for cross-session sharing'),
  visibility: z
    .enum(['private', 'workspace', 'public'])
    .default('private')
    .describe('Visibility level'),
  labels: z.array(z.string()).optional().describe('Board labels'),
});

const schema = z.object({
  boards: z.array(boardItemSchema).min(1).max(10).describe('Boards to create (1-10)'),
  sessionId: z.string().optional().describe('Session ID (auto-detected from connection if omitted)'),
  createdBy: z.string().min(1).describe('Creator agent ID'),
});

type BoardCreateArgs = z.infer<typeof schema>;

export const boardCreateTool: UnifiedTool = {
  name: 'board-create',
  description: 'Create 1-10 Kanban boards. Returns board IDs.',
  zodSchema: schema,

  metadata: {
    category: 'kanban',
    tags: ['board', 'create'],
    examples: [
      { args: { boards: [{ name: 'Sprint 1', visibility: 'private' }], createdBy: 'agent-1' }, description: 'Create a private board' },
      { args: { boards: [{ name: 'Shared Board', workspaceId: 'name:My Workspace', visibility: 'workspace' }], createdBy: 'agent-1' }, description: 'Create a workspace-visible board' },
    ],
    relatedTools: ['board-list', 'board-delete', 'workspace-create'],
  },

  execute: async (args): Promise<string> => {
    const { boards, sessionId: rawSessionId, createdBy } = args as unknown as BoardCreateArgs;

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
      boards.map(async (item) => {
        try {
          // Resolve workspaceId by name if needed
          const resolvedWorkspaceId = item.workspaceId
            ? await resolveWorkspaceId(item.workspaceId, sessionId)
            : undefined;

          const board = await createBoard({
            name: item.name,
            description: item.description,
            sessionId,
            workspaceId: resolvedWorkspaceId,
            visibility: item.visibility,
            createdBy,
            labels: item.labels,
          });

          await addBoardMember(board.id, createdBy, sessionId, 'owner');

          Logger.debug(`board-create: created board ${board.id}: ${board.name}`);

          return {
            id: board.id,
            name: board.name,
            description: board.description,
            workspaceId: board.workspaceId,
            visibility: board.visibility,
            createdAt: board.createdAt,
            success: true,
          };
        } catch (error) {
          return {
            name: item.name,
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
      sessionId,
      createdBy,
      created: successful.length,
      failed: failed.length,
      boards: results,
      boardIds: successful.map((r) => r.id),
    });
  },
};
