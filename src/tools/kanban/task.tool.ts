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

// Import all original tools for delegation
import { taskCreateTool } from './task-create.tool.js';
import { taskGetTool } from './task-get.tool.js';
import { taskListTool } from './task-list.tool.js';
import { taskUpdateTool } from './task-update.tool.js';
import { taskDeleteTool } from './task-delete.tool.js';
import { taskCommentTool } from './task-comment.tool.js';
import { taskClaimTool } from './task-claim.tool.js';
import { taskAssignTool } from './task-assign.tool.js';
import { taskSubtaskTool } from './task-subtask.tool.js';

const schema = z.object({
  action: z.enum([
    'create', 'get', 'list', 'update', 'delete',
    'comment', 'claim', 'assign', 'subtask',
  ]).describe(
    'Action: create (batch 1-20 tasks), get (full details by ID), list (filter/paginate), ' +
    'update (batch 1-20), delete (batch 1-20), comment (add notes, batch 1-20), ' +
    'claim (claim next available or specific), assign (batch 1-20), ' +
    'subtask (create/list/promote subtask hierarchies)'
  ),

  // ── Shared params ──────────────────────────────────────────────────────
  sessionId: z.string().optional().describe('Session ID (auto-detected if omitted)'),
  taskId: z.string().optional().describe('Task ID (for get, claim, subtask.promote)'),

  // ── create ─────────────────────────────────────────────────────────────
  tasks: z.array(z.object({
    title: z.string().min(1).max(200).describe('Task title'),
    description: z.string().max(10000).optional().describe('Task description'),
    priority: z.preprocess(
      (v) => {
        // Map common LLM aliases to valid enum values
        const aliases: Record<string, string> = { medium: 'normal', urgent: 'critical', important: 'high', minor: 'low', trivial: 'low' };
        return typeof v === 'string' ? (aliases[v.toLowerCase()] ?? v) : v;
      },
      z.enum(['critical', 'high', 'normal', 'low']).default('normal'),
    ).describe('Priority level'),
    boardId: z.string().optional().describe('Board ID or "name:Board Name"'),
    blockedBy: z.array(z.string()).max(50).optional().describe('Blocking task IDs'),
    relatedFiles: z.array(z.string().max(500)).max(100).optional().describe('Related file paths'),
    labels: z.array(z.string().max(100)).max(50).optional().describe('Labels for categorization'),
    estimatedMinutes: z.number().positive().max(100000).optional().describe('Time estimate in minutes'),
  })).optional().describe('Tasks to create (action=create, 1-20)'),
  createdBy: z.string().optional().describe('Creator agent ID (action=create)'),

  // ── list ───────────────────────────────────────────────────────────────
  boardId: z.string().optional().describe('Filter by board ID or "name:Board Name" (action=list)'),
  status: z.enum(['backlog', 'in_progress', 'review', 'done']).optional().describe('Filter by status (action=list)'),
  priority: z.preprocess(
    (v) => {
      const aliases: Record<string, string> = { medium: 'normal', urgent: 'critical', important: 'high', minor: 'low', trivial: 'low' };
      return typeof v === 'string' ? (aliases[v.toLowerCase()] ?? v) : v;
    },
    z.enum(['critical', 'high', 'normal', 'low']).optional(),
  ).describe('Filter by priority (action=list)'),
  assignee: z.string().optional().describe('Filter by agent (action=list)'),
  unassigned: z.boolean().optional().describe('Only unassigned tasks (action=list)'),
  blocked: z.boolean().optional().describe('Filter blocked tasks (action=list)'),
  labels: z.array(z.string().max(100)).max(50).optional().describe('Filter by labels (action=list)'),
  offset: z.number().int().min(0).optional().describe('Pagination offset (action=list)'),
  limit: z.number().min(1).max(100).optional().describe('Max tasks to return (action=list)'),

  // ── update ─────────────────────────────────────────────────────────────
  updates: z.array(z.object({
    taskId: z.string().min(1).describe('Task ID'),
    title: z.string().min(1).max(200).optional().describe('New title'),
    description: z.string().max(10000).optional().describe('New description'),
    status: z.enum(['backlog', 'in_progress', 'review', 'done']).optional().describe('New status'),
    priority: z.preprocess(
      (v) => {
        const aliases: Record<string, string> = { medium: 'normal', urgent: 'critical', important: 'high', minor: 'low', trivial: 'low' };
        return typeof v === 'string' ? (aliases[v.toLowerCase()] ?? v) : v;
      },
      z.enum(['critical', 'high', 'normal', 'low']).optional(),
    ).describe('New priority'),
    blockedBy: z.array(z.string()).max(50).optional().describe('Blocking task IDs (replaces existing)'),
    addBlockedBy: z.array(z.string()).max(50).optional().describe('Task IDs to add to blockedBy'),
    addBlocks: z.array(z.string()).max(50).optional().describe('Task IDs this task blocks'),
    relatedFiles: z.array(z.string().max(500)).max(100).optional().describe('Related files'),
    labels: z.array(z.string().max(100)).max(50).optional().describe('Labels'),
    estimatedMinutes: z.number().positive().max(100000).optional().describe('Time estimate in minutes'),
  })).optional().describe('Task updates (action=update, 1-20)'),
  agentId: z.string().optional().describe('Agent ID (action=update, claim, subtask)'),

  // ── delete ─────────────────────────────────────────────────────────────
  taskIds: z.array(z.string().min(1)).max(20).optional().describe('Task IDs to delete (action=delete, 1-20)'),

  // ── comment ────────────────────────────────────────────────────────────
  comments: z.array(z.object({
    taskId: z.string().min(1).describe('Task ID'),
    author: z.string().min(1).max(100).describe('Author name or agent ID'),
    content: z.string().min(1).max(5000).describe('Note/comment content'),
  })).optional().describe('Comments to add (action=comment, 1-20)'),

  // ── assign ─────────────────────────────────────────────────────────────
  assignments: z.array(z.object({
    taskId: z.string().min(1).describe('Task ID'),
    assigneeId: z.string().min(1).describe('Target agent ID'),
  })).optional().describe('Task assignments (action=assign, 1-20)'),
  supervisorId: z.string().optional().describe('Supervisor agent ID (action=assign)'),

  // ── subtask ────────────────────────────────────────────────────────────
  subtaskAction: z.enum(['create', 'list', 'promote']).optional()
    .describe('Subtask sub-action (action=subtask): create, list, promote'),
  parentTaskId: z.string().optional().describe('Parent task ID (action=subtask create/list)'),
  title: z.string().min(1).max(200).optional().describe('Subtask title (action=subtask create)'),
  description: z.string().max(10000).optional().describe('Subtask description (action=subtask create)'),
});

export const taskTool: UnifiedTool<typeof schema> = {
  name: 'task',
  description:
    'Unified Kanban task management: create, get, list, update, delete, comment, claim, assign, subtask. ' +
    'Use action param to select operation.',
  zodSchema: schema,
  metadata: {
    category: 'kanban',
    tags: ['task', 'kanban', 'create', 'update', 'delete', 'list', 'assign', 'claim', 'subtask', 'comment'],
    examples: [
      { args: { action: 'create', tasks: [{ title: 'Implement auth', priority: 'high' }], createdBy: 'agent-1' }, description: 'Create a task' },
      { args: { action: 'get', taskId: 'task-abc123' }, description: 'Get full task details' },
      { args: { action: 'list', status: 'in_progress' }, description: 'List in-progress tasks' },
      { args: { action: 'update', updates: [{ taskId: 'task-1', status: 'done' }], agentId: 'agent-1' }, description: 'Mark task as done' },
      { args: { action: 'delete', taskIds: ['task-abc123'] }, description: 'Delete a task' },
      { args: { action: 'claim', agentId: 'agent-1' }, description: 'Claim next available task' },
      { args: { action: 'assign', assignments: [{ taskId: 'task-1', assigneeId: 'agent-2' }], supervisorId: 'agent-1' }, description: 'Assign task' },
      { args: { action: 'subtask', subtaskAction: 'create', parentTaskId: 'task-1', title: 'Sub-item', createdBy: 'agent-1' }, description: 'Create subtask' },
    ],
    relatedTools: ['task-multi', 'board'],
  },

  execute: async (args) => {
    try {
      const { action } = args;

      switch (action) {
        case 'create':
          return taskCreateTool.execute({
            tasks: args.tasks || [],
            sessionId: args.sessionId,
            createdBy: args.createdBy || 'system',
          } as never);

        case 'get':
          return taskGetTool.execute({
            taskId: args.taskId || '',
            sessionId: args.sessionId,
          } as never);

        case 'list':
          return taskListTool.execute({
            sessionId: args.sessionId,
            boardId: args.boardId,
            status: args.status,
            priority: args.priority,
            assignee: args.assignee,
            unassigned: args.unassigned,
            blocked: args.blocked,
            labels: args.labels,
            offset: args.offset ?? 0,
            limit: args.limit ?? 50,
          } as never);

        case 'update':
          return taskUpdateTool.execute({
            updates: args.updates || [],
            agentId: args.agentId || 'system',
          } as never);

        case 'delete':
          return taskDeleteTool.execute({
            taskIds: args.taskIds || [],
            sessionId: args.sessionId,
          } as never);

        case 'comment': {
          // Support shorthand: single comment via taskId/content fields
          const comments = args.comments;
          if (!comments || comments.length === 0) {
            return JSON.stringify({ success: false, error: 'comments array is required for action=comment' });
          }
          return taskCommentTool.execute({ comments } as never);
        }

        case 'claim':
          return taskClaimTool.execute({
            taskId: args.taskId,
            agentId: args.agentId || 'system',
            sessionId: args.sessionId,
          } as never);

        case 'assign':
          return taskAssignTool.execute({
            assignments: args.assignments || [],
            supervisorId: args.supervisorId || 'system',
          } as never);

        case 'subtask':
          return taskSubtaskTool.execute({
            action: args.subtaskAction || 'list',
            sessionId: args.sessionId,
            parentTaskId: args.parentTaskId,
            title: args.title,
            description: args.description,
            priority: args.priority,
            createdBy: args.createdBy,
            taskId: args.taskId,
          } as never);

        default:
          return JSON.stringify({ success: false, error: `Unknown action: ${action}` });
      }
    } catch (error) {
      return handleToolError('task', error);
    }
  },
};
