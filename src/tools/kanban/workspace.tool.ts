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

import { z } from 'zod';
import type { UnifiedTool } from '../registry.js';
import { handleToolError } from '../../utils/errors.js';

// Import original tools for delegation
import { workspaceCreateTool } from './workspace-create.tool.js';
import { workspaceListTool } from './workspace-list.tool.js';
import { workspaceJoinTool } from './workspace-join.tool.js';
import { workspaceLeaveTool } from './workspace-leave.tool.js';
import { workspaceDeleteTool } from './workspace-delete.tool.js';

const schema = z.object({
  action: z.enum(['create', 'list', 'join', 'leave', 'delete']).describe(
    'Action: create (batch 1-5 workspaces), list (browse workspaces), ' +
    'join (add session to workspace), leave (remove session from workspace), ' +
    'delete (batch 1-5, requires ownership, cascade option)'
  ),

  // ── Shared params ──────────────────────────────────────────────────────
  sessionId: z.string().optional().describe('Session ID (auto-detected if omitted)'),
  workspaceId: z.string().optional().describe('Workspace ID or "name:Workspace Name" (join, leave)'),

  // ── create ─────────────────────────────────────────────────────────────
  workspaces: z.array(z.object({
    name: z.string().min(1).max(100).describe('Workspace name'),
    description: z.string().max(500).optional().describe('Workspace description'),
    initialMemberSessions: z.array(z.string()).optional().describe('Session IDs to invite immediately'),
  })).optional().describe('Workspaces to create (action=create, 1-5)'),
  ownerId: z.string().optional().describe('Creator agent ID (action=create, delete)'),

  // ── list ───────────────────────────────────────────────────────────────
  limit: z.number().min(1).max(100).optional().describe('Max workspaces to return (action=list)'),

  // ── delete ─────────────────────────────────────────────────────────────
  workspaceIds: z.array(z.string().min(1)).optional()
    .describe('Workspace IDs to delete (action=delete, 1-5)'),
  deleteBoards: z.boolean().optional().describe('Cascade delete boards (action=delete)'),
});

export const workspaceTool: UnifiedTool<typeof schema> = {
  name: 'workspace',
  description:
    'Unified workspace management: create, list, join, leave, delete. ' +
    'Workspaces enable cross-session board sharing. Use action param to select operation.',
  zodSchema: schema,
  metadata: {
    category: 'kanban',
    tags: ['workspace', 'kanban', 'create', 'join', 'leave', 'delete', 'collaboration'],
    examples: [
      { args: { action: 'create', workspaces: [{ name: 'Platform Team' }], ownerId: 'agent-1' }, description: 'Create a workspace' },
      { args: { action: 'list' }, description: 'List all workspaces' },
      { args: { action: 'join', workspaceId: 'ws-abc123' }, description: 'Join a workspace' },
      { args: { action: 'leave', workspaceId: 'ws-abc123' }, description: 'Leave a workspace' },
      { args: { action: 'delete', workspaceIds: ['ws-abc123'], ownerId: 'agent-1' }, description: 'Delete a workspace' },
    ],
    relatedTools: ['board', 'task'],
  },

  execute: async (args) => {
    try {
      const { action } = args;

      switch (action) {
        case 'create':
          return workspaceCreateTool.execute({
            workspaces: args.workspaces || [],
            ownerSessionId: args.sessionId,
            ownerId: args.ownerId || 'system',
          } as never);

        case 'list':
          return workspaceListTool.execute({
            sessionId: args.sessionId,
            limit: args.limit ?? 50,
          } as never);

        case 'join':
          return workspaceJoinTool.execute({
            workspaceId: args.workspaceId || '',
            sessionId: args.sessionId,
          } as never);

        case 'leave':
          return workspaceLeaveTool.execute({
            workspaceId: args.workspaceId || '',
            sessionId: args.sessionId,
          } as never);

        case 'delete':
          return workspaceDeleteTool.execute({
            workspaceIds: args.workspaceIds || [],
            sessionId: args.sessionId,
            ownerId: args.ownerId || 'system',
            deleteBoards: args.deleteBoards ?? false,
          } as never);

        default:
          return JSON.stringify({ success: false, error: `Unknown action: ${action}` });
      }
    } catch (error) {
      return handleToolError('workspace', error);
    }
  },
};
