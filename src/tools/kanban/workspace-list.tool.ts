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
 * Workspace List Tool
 *
 * Lists workspaces for a session or all available workspaces.
 *
 * @module tools/kanban/workspace-list
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { Logger } from '../../utils/logger.js';
import { checkRateLimit } from '../../utils/validation.js';
import { listWorkspacesForSession, listAllWorkspaces } from '../../kanban/index.js';

const schema = z.object({
  sessionId: z.string().optional().describe('Session ID to list workspaces for (omit for all)'),
  limit: z.number().min(1).max(100).default(50).describe('Maximum workspaces to return'),
});

type WorkspaceListArgs = z.infer<typeof schema>;

export const workspaceListTool: UnifiedTool = {
  name: 'workspace-list',
  description: 'List workspaces (for a session or all available)',
  zodSchema: schema,

  execute: async (args): Promise<string> => {
    const input = args as WorkspaceListArgs;

    if (!checkRateLimit('kanban-operations', { maxRequests: 100, windowMs: 60000 })) {
      return JSON.stringify({
        success: false,
        error: 'Rate limit exceeded for kanban operations',
        code: 'RATE_LIMIT_EXCEEDED',
      });
    }

    try {
      const workspaces = input.sessionId
        ? await listWorkspacesForSession(input.sessionId)
        : await listAllWorkspaces({ limit: input.limit });

      Logger.debug(`workspace-list: found ${workspaces.length} workspaces`);

      return JSON.stringify({
        success: true,
        count: workspaces.length,
        workspaces: workspaces.map((ws) => ({
          id: ws.id,
          name: ws.name,
          description: ws.description,
          ownerId: ws.ownerId,
          memberCount: ws.memberSessions.length,
          createdAt: ws.createdAt,
        })),
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      Logger.error(`workspace-list error: ${errorMessage}`);

      return JSON.stringify({
        success: false,
        error: errorMessage,
        code: 'LIST_ERROR',
      });
    }
  },
};
