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
 * Workspace Leave Tool
 *
 * Removes a session from a workspace.
 *
 * @module tools/kanban/workspace-leave
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { Logger } from '../../utils/logger.js';
import { checkRateLimit } from '../../utils/validation.js';
import { leaveWorkspace, resolveSessionId, resolveWorkspaceId } from '../../kanban/index.js';

const schema = z.object({
  workspaceId: z.string().min(1).describe('Workspace ID or "name:Workspace Name"'),
  sessionId: z.string().optional().describe('Session ID leaving (auto-detected from connection if omitted)'),
});

type WorkspaceLeaveArgs = z.infer<typeof schema>;

export const workspaceLeaveTool: UnifiedTool = {
  name: 'workspace-leave',
  description: 'Remove session from workspace',
  zodSchema: schema,

  metadata: {
    category: 'kanban',
    tags: ['workspace', 'leave'],
    examples: [
      { args: { workspaceId: 'ws-abc123' }, description: 'Leave a workspace by ID' },
      { args: { workspaceId: 'name:Platform Team' }, description: 'Leave a workspace by name' },
    ],
    relatedTools: ['workspace-join', 'workspace-list'],
  },

  execute: async (args): Promise<string> => {
    const input = args as WorkspaceLeaveArgs;

    if (!checkRateLimit('kanban-operations', { maxRequests: 100, windowMs: 60000 })) {
      return JSON.stringify({
        success: false,
        error: 'Rate limit exceeded for kanban operations',
        code: 'RATE_LIMIT_EXCEEDED',
      });
    }

    try {
      // Resolve sessionId and workspaceId
      const sessionId = resolveSessionId(input.sessionId);
      const resolvedWorkspaceId = await resolveWorkspaceId(input.workspaceId, sessionId);

      const success = await leaveWorkspace(resolvedWorkspaceId, sessionId);

      if (!success) {
        return JSON.stringify({
          success: false,
          error: 'Cannot leave workspace (not found or owner cannot leave)',
          code: 'LEAVE_FAILED',
        });
      }

      Logger.debug(
        `workspace-leave: session ${sessionId} left workspace ${resolvedWorkspaceId}`
      );

      return JSON.stringify({
        success: true,
        workspaceId: resolvedWorkspaceId,
        sessionId,
        message: 'Successfully left workspace',
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      Logger.error(`workspace-leave error: ${errorMessage}`);

      return JSON.stringify({
        success: false,
        error: errorMessage,
        code: 'LEAVE_ERROR',
      });
    }
  },
};
