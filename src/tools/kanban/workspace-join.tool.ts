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
 * Workspace Join Tool
 *
 * Adds a session to a workspace.
 *
 * @module tools/kanban/workspace-join
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { Logger } from '../../utils/logger.js';
import { checkRateLimit } from '../../utils/validation.js';
import { joinWorkspace, getWorkspace } from '../../kanban/index.js';

const schema = z.object({
  workspaceId: z.string().min(1).describe('Workspace ID'),
  sessionId: z.string().min(1).describe('Session ID joining'),
});

type WorkspaceJoinArgs = z.infer<typeof schema>;

export const workspaceJoinTool: UnifiedTool = {
  name: 'workspace-join',
  description: 'Join session to workspace for cross-session collaboration',
  zodSchema: schema,

  execute: async (args): Promise<string> => {
    const input = args as WorkspaceJoinArgs;

    if (!checkRateLimit('kanban-operations', { maxRequests: 100, windowMs: 60000 })) {
      return JSON.stringify({
        success: false,
        error: 'Rate limit exceeded for kanban operations',
        code: 'RATE_LIMIT_EXCEEDED',
      });
    }

    try {
      const success = await joinWorkspace(input.workspaceId, input.sessionId);

      if (!success) {
        return JSON.stringify({
          success: false,
          error: 'Workspace not found',
          code: 'NOT_FOUND',
        });
      }

      const workspace = await getWorkspace(input.workspaceId);

      Logger.debug(
        `workspace-join: session ${input.sessionId} joined workspace ${input.workspaceId}`
      );

      return JSON.stringify({
        success: true,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        workspaceName: workspace?.name,
        memberCount: workspace?.memberSessions.length || 0,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      Logger.error(`workspace-join error: ${errorMessage}`);

      return JSON.stringify({
        success: false,
        error: errorMessage,
        code: 'JOIN_ERROR',
      });
    }
  },
};
