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
 * Workspace Join Tool
 *
 * Adds a session to a workspace.
 *
 * @module tools/kanban/workspace-join
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { Logger } from '../../utils/logger.js';
import { executeWithGuard } from '../tool-shared.js';
import { joinWorkspace, getWorkspace, resolveSessionId, resolveWorkspaceId } from '../../kanban/index.js';
import { isSilent } from '../../config/silent.js';

const schema = z.object({
  workspaceId: z.string().min(1).describe('Workspace ID or "name:Workspace Name"'),
  sessionId: z.string().optional().describe('Session ID joining (auto-detected from connection if omitted)'),
});

type WorkspaceJoinArgs = z.infer<typeof schema>;

export const workspaceJoinTool: UnifiedTool = {
  name: 'workspace-join',
  description: 'Join session to workspace for cross-session collaboration',
  zodSchema: schema,

  metadata: {
    category: 'kanban',
    tags: ['workspace', 'join', 'collaboration'],
    examples: [
      { args: { workspaceId: 'ws-abc123' }, description: 'Join a workspace by ID' },
      { args: { workspaceId: 'name:Platform Team' }, description: 'Join a workspace by name' },
    ],
    relatedTools: ['workspace-list', 'workspace-leave'],
  },

  execute: async (args): Promise<string> => {
    const input = args as WorkspaceJoinArgs;

    return executeWithGuard('workspace-join', 'kanban-operations', async () => {
      // Resolve sessionId and workspaceId
      const sessionId = resolveSessionId(input.sessionId);
      const resolvedWorkspaceId = await resolveWorkspaceId(input.workspaceId, sessionId);

      const success = await joinWorkspace(resolvedWorkspaceId, sessionId);

      if (!success) {
        return JSON.stringify({
          success: false,
          error: 'Workspace not found',
          code: 'NOT_FOUND',
        });
      }

      const workspace = await getWorkspace(resolvedWorkspaceId);

      Logger.debug(
        `workspace-join: session ${sessionId} joined workspace ${resolvedWorkspaceId}`
      );

      // Silent mode: return workspace ID only
      if (isSilent()) {
        return JSON.stringify({ id: resolvedWorkspaceId });
      }

      return JSON.stringify({
        success: true,
        workspaceId: resolvedWorkspaceId,
        sessionId,
        workspaceName: workspace?.name,
        memberCount: workspace?.memberSessions.length || 0,
      });
    });
  },
};
