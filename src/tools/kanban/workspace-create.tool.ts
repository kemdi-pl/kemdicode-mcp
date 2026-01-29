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
 * Workspace Create Tool
 *
 * Creates a new workspace for cross-session board sharing.
 *
 * @module tools/kanban/workspace-create
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { Logger } from '../../utils/logger.js';
import { checkRateLimit } from '../../utils/validation.js';
import { createWorkspace } from '../../kanban/index.js';

const schema = z.object({
  name: z.string().min(1).max(100).describe('Workspace name'),
  description: z.string().max(500).optional().describe('Workspace description'),
  ownerSessionId: z.string().min(1).describe('Session ID of the workspace creator'),
  ownerId: z.string().min(1).describe('Agent ID of the workspace creator'),
  initialMemberSessions: z
    .array(z.string())
    .optional()
    .describe('Additional session IDs to invite immediately'),
});

type WorkspaceCreateArgs = z.infer<typeof schema>;

export const workspaceCreateTool: UnifiedTool = {
  name: 'workspace-create',
  description: 'Create a new workspace for cross-session board sharing',
  zodSchema: schema,

  execute: async (args): Promise<string> => {
    const input = args as WorkspaceCreateArgs;

    if (!checkRateLimit('kanban-operations', { maxRequests: 100, windowMs: 60000 })) {
      return JSON.stringify({
        success: false,
        error: 'Rate limit exceeded for kanban operations',
        code: 'RATE_LIMIT_EXCEEDED',
      });
    }

    try {
      const workspace = await createWorkspace({
        name: input.name,
        description: input.description,
        ownerSessionId: input.ownerSessionId,
        ownerId: input.ownerId,
        initialMemberSessions: input.initialMemberSessions,
      });

      Logger.debug(`workspace-create: created workspace ${workspace.id}: ${workspace.name}`);

      return JSON.stringify({
        success: true,
        workspace: {
          id: workspace.id,
          name: workspace.name,
          description: workspace.description,
          ownerId: workspace.ownerId,
          memberSessions: workspace.memberSessions,
          createdAt: workspace.createdAt,
        },
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      Logger.error(`workspace-create error: ${errorMessage}`);

      return JSON.stringify({
        success: false,
        error: errorMessage,
        code: 'CREATE_ERROR',
      });
    }
  },
};
