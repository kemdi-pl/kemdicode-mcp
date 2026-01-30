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
import { createBoard, addBoardMember } from '../../kanban/index.js';

const schema = z.object({
  name: z.string().min(1).max(100).describe('Board name'),
  description: z.string().max(500).optional().describe('Board description'),
  sessionId: z.string().min(1).describe('Session ID'),
  workspaceId: z.string().optional().describe('Workspace ID for cross-session sharing'),
  visibility: z
    .enum(['private', 'workspace', 'public'])
    .default('private')
    .describe('Visibility level'),
  createdBy: z.string().min(1).describe('Creator agent ID'),
  labels: z.array(z.string()).optional().describe('Board labels'),
});

type BoardCreateArgs = z.infer<typeof schema>;

export const boardCreateTool: UnifiedTool = {
  name: 'board-create',
  description: 'Create Kanban board in session or workspace',
  zodSchema: schema,

  execute: async (args): Promise<string> => {
    const input = args as BoardCreateArgs;

    if (!checkRateLimit('kanban-operations', { maxRequests: 100, windowMs: 60000 })) {
      return JSON.stringify({
        success: false,
        error: 'Rate limit exceeded for kanban operations',
        code: 'RATE_LIMIT_EXCEEDED',
      });
    }

    try {
      const board = await createBoard({
        name: input.name,
        description: input.description,
        sessionId: input.sessionId,
        workspaceId: input.workspaceId,
        visibility: input.visibility,
        createdBy: input.createdBy,
        labels: input.labels,
      });

      // Add creator as owner
      await addBoardMember(board.id, input.createdBy, input.sessionId, 'owner');

      Logger.debug(`board-create: created board ${board.id}: ${board.name}`);

      return JSON.stringify({
        success: true,
        board: {
          id: board.id,
          name: board.name,
          description: board.description,
          sessionId: board.sessionId,
          workspaceId: board.workspaceId,
          visibility: board.visibility,
          createdBy: board.createdBy,
          createdAt: board.createdAt,
        },
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      Logger.error(`board-create error: ${errorMessage}`);

      return JSON.stringify({
        success: false,
        error: errorMessage,
        code: 'CREATE_ERROR',
      });
    }
  },
};
