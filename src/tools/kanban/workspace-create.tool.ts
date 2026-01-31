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
import { createWorkspace, resolveSessionId } from '../../kanban/index.js';
import { isSilent } from '../../config/silent.js';

const wsItemSchema = z.object({
  name: z.string().min(1).max(100).describe('Workspace name'),
  description: z.string().max(500).optional().describe('Workspace description'),
  initialMemberSessions: z
    .array(z.string())
    .optional()
    .describe('Session IDs to invite immediately'),
});

const schema = z.object({
  workspaces: z.array(wsItemSchema).min(1).max(5).describe('Workspaces to create (1-5)'),
  ownerSessionId: z.string().optional().describe('Creator session ID (auto-detected from connection if omitted)'),
  ownerId: z.string().min(1).describe('Creator agent ID'),
});

type WorkspaceCreateArgs = z.infer<typeof schema>;

export const workspaceCreateTool: UnifiedTool = {
  name: 'workspace-create',
  description: 'Create 1-5 workspaces for cross-session board sharing. Returns IDs.',
  zodSchema: schema,

  metadata: {
    category: 'kanban',
    tags: ['workspace', 'create'],
    examples: [
      { args: { workspaces: [{ name: 'Platform Team' }], ownerId: 'agent-1' }, description: 'Create a workspace' },
      { args: { workspaces: [{ name: 'Shared Project', description: 'Cross-team collaboration', initialMemberSessions: ['session-2'] }], ownerId: 'agent-1' }, description: 'Create a workspace with initial members' },
    ],
    relatedTools: ['workspace-list', 'workspace-join', 'board-create'],
  },

  execute: async (args): Promise<string> => {
    const { workspaces, ownerSessionId: rawOwnerSessionId, ownerId } = args as unknown as WorkspaceCreateArgs;

    // Resolve sessionId from args or active connection context
    const ownerSessionId = resolveSessionId(rawOwnerSessionId);

    if (!checkRateLimit('kanban-operations', { maxRequests: 100, windowMs: 60000 })) {
      return JSON.stringify({
        success: false,
        error: 'Rate limit exceeded for kanban operations',
        code: 'RATE_LIMIT_EXCEEDED',
      });
    }

    const results = await Promise.all(
      workspaces.map(async (item) => {
        try {
          const workspace = await createWorkspace({
            name: item.name,
            description: item.description,
            ownerSessionId,
            ownerId,
            initialMemberSessions: item.initialMemberSessions,
          });

          Logger.debug(`workspace-create: created workspace ${workspace.id}: ${workspace.name}`);

          return {
            id: workspace.id,
            name: workspace.name,
            description: workspace.description,
            memberSessions: workspace.memberSessions,
            createdAt: workspace.createdAt,
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

    // Silent mode: return only workspace IDs
    if (isSilent()) {
      if (failed.length > 0) {
        return JSON.stringify({ created: successful.map((r) => r.id), errors: failed.map((r) => r.error) });
      }
      return JSON.stringify(successful.map((r) => r.id));
    }

    return JSON.stringify({
      success: failed.length === 0,
      ownerSessionId,
      ownerId,
      created: successful.length,
      failed: failed.length,
      workspaces: results,
      workspaceIds: successful.map((r) => r.id),
    });
  },
};
