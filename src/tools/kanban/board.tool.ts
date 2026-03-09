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
import { boardCreateTool } from './board-create.tool.js';
import { boardListTool } from './board-list.tool.js';
import { boardDeleteTool } from './board-delete.tool.js';
import { boardStatusTool } from './board-status.tool.js';
import { boardShareTool } from './board-share.tool.js';
import { boardInviteTool } from './board-invite.tool.js';
import { boardMembersTool } from './board-members.tool.js';
import { boardWorkflowTool } from './board-workflow.tool.js';

const schema = z.object({
  action: z.enum([
    'create', 'list', 'delete', 'status',
    'share', 'invite', 'members', 'workflow',
  ]).describe(
    'Action: create (batch 1-10 boards), list (accessible boards), delete (batch 1-10, cascade option), ' +
    'status (board summary/stats), share (share with workspace), invite (invite agents with roles), ' +
    'members (list/update-role/remove), workflow (auto board switching)'
  ),

  // ── Shared params ──────────────────────────────────────────────────────
  sessionId: z.string().optional().describe('Session ID (auto-detected if omitted)'),

  // ── create ─────────────────────────────────────────────────────────────
  boards: z.array(z.object({
    name: z.string().min(1).max(100).describe('Board name'),
    description: z.string().max(500).optional().describe('Board description'),
    workspaceId: z.string().optional().describe('Workspace ID or "name:Workspace Name"'),
    visibility: z.enum(['private', 'workspace', 'public']).default('private').describe('Visibility level'),
    labels: z.array(z.string().max(100)).max(50).optional().describe('Board labels'),
  })).max(10).optional().describe('Boards to create (action=create, 1-10)'),
  createdBy: z.string().optional().describe('Creator agent ID (action=create)'),

  // ── list ───────────────────────────────────────────────────────────────
  workspaceId: z.string().optional().describe('Filter by workspace ID or "name:Workspace Name" (action=list)'),
  includeWorkspaces: z.boolean().optional().describe('Include workspace boards (action=list, default: true)'),

  // ── delete ─────────────────────────────────────────────────────────────
  boardIds: z.array(z.string().min(1)).max(10).optional().describe('Board IDs to delete (action=delete, 1-10)'),
  deleteTasks: z.boolean().optional().describe('Cascade delete tasks (action=delete)'),

  // ── share ──────────────────────────────────────────────────────────────
  shares: z.array(z.object({
    boardId: z.string().min(1).describe('Board ID or "name:Board Name"'),
    workspaceId: z.string().min(1).describe('Target workspace ID or "name:Workspace Name"'),
    visibility: z.enum(['workspace', 'public']).default('workspace').describe('Visibility level'),
  })).max(10).optional().describe('Shares to create (action=share, 1-10)'),
  agentId: z.string().optional().describe('Agent ID (action=share, workflow)'),

  // ── invite ─────────────────────────────────────────────────────────────
  invites: z.array(z.object({
    boardId: z.string().min(1).describe('Board ID or "name:Board Name"'),
    agentId: z.string().min(1).describe('Agent to invite'),
    role: z.enum(['admin', 'member', 'viewer']).default('member').describe('Role'),
  })).max(20).optional().describe('Invitations to send (action=invite, 1-20)'),
  invitingAgentId: z.string().optional().describe('Inviting agent ID (action=invite)'),

  // ── members ────────────────────────────────────────────────────────────
  operations: z.array(z.object({
    boardId: z.string().min(1).describe('Board ID or "name:Board Name"'),
    action: z.enum(['list', 'update-role', 'remove']).default('list').describe('Member action'),
    targetAgentId: z.string().optional().describe('Agent to modify'),
    newRole: z.enum(['owner', 'admin', 'member', 'viewer']).optional().describe('New role'),
  })).max(20).optional().describe('Member operations (action=members, 1-20)'),
  requestingAgentId: z.string().optional().describe('Requesting agent ID (action=members)'),

  // ── workflow ───────────────────────────────────────────────────────────
  workflowAction: z.enum(['create', 'get', 'list', 'check', 'pause', 'resume', 'delete']).optional()
    .describe('Workflow sub-action (action=workflow)'),
  name: z.string().min(1).max(100).optional().describe('Workflow name (workflow: create)'),
  boardSequence: z.array(z.string().min(1)).max(20).optional()
    .describe('Ordered board IDs (workflow: create, min 2)'),
  autoCreateNavigationTask: z.boolean().optional()
    .describe('Auto-create navigation task (workflow: create, default: true)'),
  workflowId: z.string().optional().describe('Workflow ID (workflow: get/check/pause/resume/delete)'),
  boardId: z.string().optional().describe('Board ID (workflow: check)'),
});

export const boardTool: UnifiedTool<typeof schema> = {
  name: 'board',
  description:
    'Unified Kanban board management: create, list, delete, status, share, invite, members, workflow. ' +
    'Use action param to select operation.',
  zodSchema: schema,
  metadata: {
    category: 'kanban',
    tags: ['board', 'kanban', 'create', 'delete', 'share', 'invite', 'members', 'workflow', 'status'],
    examples: [
      { args: { action: 'create', boards: [{ name: 'Sprint 1' }], createdBy: 'agent-1' }, description: 'Create a board' },
      { args: { action: 'list' }, description: 'List all accessible boards' },
      { args: { action: 'status' }, description: 'Get board summary' },
      { args: { action: 'delete', boardIds: ['board-1'], deleteTasks: true }, description: 'Delete board with tasks' },
      { args: { action: 'workflow', workflowAction: 'create', name: 'Pipeline', boardSequence: ['b1', 'b2'], sessionId: 's1', agentId: 'a1' }, description: 'Create workflow' },
    ],
    relatedTools: ['task', 'workspace'],
  },

  execute: async (args) => {
    try {
      const { action } = args;

      switch (action) {
        case 'create':
          return boardCreateTool.execute({
            boards: args.boards || [],
            sessionId: args.sessionId,
            createdBy: args.createdBy || 'system',
          } as never);

        case 'list':
          return boardListTool.execute({
            sessionId: args.sessionId,
            workspaceId: args.workspaceId,
            includeWorkspaces: args.includeWorkspaces ?? true,
          } as never);

        case 'delete':
          return boardDeleteTool.execute({
            boardIds: args.boardIds || [],
            sessionId: args.sessionId,
            deleteTasks: args.deleteTasks ?? false,
          } as never);

        case 'status':
          return boardStatusTool.execute({
            sessionId: args.sessionId,
          } as never);

        case 'share':
          return boardShareTool.execute({
            shares: args.shares || [],
            agentId: args.agentId || 'system',
          } as never);

        case 'invite':
          return boardInviteTool.execute({
            invites: args.invites || [],
            sessionId: args.sessionId,
            invitingAgentId: args.invitingAgentId || 'system',
          } as never);

        case 'members':
          return boardMembersTool.execute({
            operations: args.operations || [],
            requestingAgentId: args.requestingAgentId || 'system',
          } as never);

        case 'workflow':
          return boardWorkflowTool.execute({
            action: args.workflowAction || 'list',
            sessionId: args.sessionId || '',
            agentId: args.agentId || 'default-agent',
            name: args.name,
            boardSequence: args.boardSequence,
            autoCreateNavigationTask: args.autoCreateNavigationTask,
            workflowId: args.workflowId,
            boardId: args.boardId,
          } as never);

        default:
          return JSON.stringify({ success: false, error: `Unknown action: ${action}` });
      }
    } catch (error) {
      return handleToolError('board', error);
    }
  },
};
