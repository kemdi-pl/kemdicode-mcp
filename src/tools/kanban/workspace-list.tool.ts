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
 * Workspace List Tool
 *
 * Lists workspaces for a session or all available workspaces.
 *
 * @module tools/kanban/workspace-list
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { Logger } from '../../utils/logger.js';
import { executeWithGuard } from '../tool-shared.js';
import { listWorkspacesForSession, listAllWorkspaces } from '../../kanban/index.js';
import { isSilent } from '../../config/silent.js';

const schema = z.object({
  sessionId: z.string().optional().describe('Session ID filter, omit for all'),
  limit: z.number().min(1).max(100).default(50).describe('Max workspaces'),
});

type WorkspaceListArgs = z.infer<typeof schema>;

export const workspaceListTool: UnifiedTool = {
  name: 'workspace-list',
  description: 'List workspaces for session or all available',
  zodSchema: schema,

  metadata: {
    category: 'kanban',
    tags: ['workspace', 'list'],
    examples: [
      { args: {}, description: 'List all available workspaces' },
      { args: { sessionId: 'session-abc123', limit: 10 }, description: 'List workspaces for a specific session' },
    ],
    relatedTools: ['workspace-create', 'workspace-join'],
  },

  execute: async (args): Promise<string> => {
    const input = args as WorkspaceListArgs;

    return executeWithGuard('workspace-list', 'kanban-operations', async () => {
      const workspaces = input.sessionId
        ? await listWorkspacesForSession(input.sessionId)
        : await listAllWorkspaces({ limit: input.limit });

      Logger.debug(`workspace-list: found ${workspaces.length} workspaces`);

      // Silent mode: compact format
      if (isSilent()) {
        return JSON.stringify(workspaces.map((ws) => ({ id: ws.id, name: ws.name })));
      }

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
    });
  },
};
