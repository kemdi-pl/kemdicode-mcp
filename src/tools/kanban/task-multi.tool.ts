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
import { taskPushMultiTool } from './task-push-multi.tool.js';
import { taskClusterTool } from './task-cluster.tool.js';
import { taskComplexityTool } from './task-complexity.tool.js';

const schema = z.object({
  action: z.enum(['push', 'cluster', 'complexity']).describe(
    'Action: push (distribute task to N agents via assign/clone/notify), ' +
    'cluster (LLM-driven task grouping, context extraction, checklists, digests), ' +
    'complexity (LLM-scored complexity analysis 1-10 with subtask recommendations)'
  ),

  // ── push (task-push-multi) ─────────────────────────────────────────────
  taskId: z.string().optional().describe('Existing task ID (push: assign/notify; complexity: analyze/get)'),
  taskData: z.object({
    title: z.string().min(1).max(200).describe('Task title'),
    description: z.string().optional().describe('Description'),
    priority: z.preprocess(
      (v) => {
        const aliases: Record<string, string> = { medium: 'normal', urgent: 'critical', important: 'high', minor: 'low', trivial: 'low' };
        return typeof v === 'string' ? (aliases[v.toLowerCase()] ?? v) : v;
      },
      z.enum(['critical', 'high', 'normal', 'low']).default('normal'),
    ),
    labels: z.array(z.string()).optional(),
    relatedFiles: z.array(z.string()).optional(),
    estimatedMinutes: z.number().positive().optional(),
  }).optional().describe('Task data for clone mode (action=push)'),
  targetAgents: z.array(z.object({
    agentId: z.string().min(1).describe('Target agent ID'),
    sessionId: z.string().min(1).describe('Target agent session ID'),
  })).optional().describe('Target agents (action=push, 1-20)'),
  mode: z.enum(['assign', 'clone', 'notify']).optional()
    .describe('Push mode (action=push): assign=single task to one agent, clone=copy per agent, notify=alert only'),
  supervisorId: z.string().optional().describe('Supervisor agent ID (action=push)'),
  boardId: z.string().optional().describe('Board ID or "name:Board Name" (push: clone mode; cluster: filter)'),

  // ── cluster (task-cluster) ─────────────────────────────────────────────
  clusterAction: z.enum([
    'create', 'get', 'list', 'delete', 'add-tasks', 'remove-tasks',
    'checklist-add', 'checklist-toggle', 'extract-context', 'auto-cluster', 'digest',
  ]).optional().describe('Cluster sub-action (action=cluster)'),
  clusterId: z.string().optional().describe('Cluster ID (action=cluster)'),
  sessionId: z.string().optional().describe('Session ID (auto-detected if omitted)'),
  name: z.string().optional().describe('Cluster name (cluster: create)'),
  description: z.string().optional().describe('Cluster description (cluster: create)'),
  taskIds: z.array(z.string()).optional().describe('Task IDs (cluster: create/add-tasks/remove-tasks)'),
  labels: z.array(z.string()).optional().describe('Labels (cluster: create)'),
  createdBy: z.string().optional().describe('Agent ID (cluster: create/checklist-add/auto-cluster)'),
  model: z.string().optional().describe('LLM model (cluster: extract-context/auto-cluster; complexity: analysis)'),
  contextModel: z.string().optional().describe('Designated model for cluster context management'),
  content: z.string().optional().describe('Checklist item content (cluster: checklist-add)'),
  items: z.array(z.object({
    content: z.string(),
    category: z.string().optional(),
  })).optional().describe('Batch checklist items (cluster: checklist-add)'),
  category: z.string().optional().describe('Checklist item category (cluster: checklist-add)'),
  itemId: z.string().optional().describe('Checklist item ID (cluster: checklist-toggle)'),
  checked: z.boolean().optional().describe('Check state (cluster: checklist-toggle)'),

  // ── complexity (task-complexity) ───────────────────────────────────────
  complexityAction: z.enum(['analyze', 'analyze-board', 'get']).optional()
    .describe('Complexity sub-action (action=complexity): analyze (single task), analyze-board (all tasks), get (stored)'),
});

export const taskMultiTool: UnifiedTool<typeof schema> = {
  name: 'task-multi',
  description:
    'Bulk task operations: push (distribute to agents), cluster (LLM-driven grouping/context/checklists), ' +
    'complexity (LLM-scored analysis 1-10). Use action param to select operation.',
  zodSchema: schema,
  metadata: {
    category: 'kanban',
    tags: ['task', 'multi', 'push', 'cluster', 'complexity', 'ai', 'batch'],
    examples: [
      {
        args: {
          action: 'push', taskId: 'task-1', mode: 'assign',
          targetAgents: [{ agentId: 'agent-2', sessionId: 'session-1' }],
          supervisorId: 'agent-1',
        },
        description: 'Assign a task to an agent',
      },
      {
        args: { action: 'cluster', clusterAction: 'auto-cluster', sessionId: 'session-1' },
        description: 'Auto-cluster all tasks in session',
      },
      {
        args: { action: 'complexity', complexityAction: 'analyze', taskId: 'task-1' },
        description: 'Analyze task complexity',
      },
    ],
    relatedTools: ['task', 'board'],
  },

  execute: async (args) => {
    try {
      const { action } = args;

      switch (action) {
        case 'push':
          return taskPushMultiTool.execute({
            taskId: args.taskId,
            taskData: args.taskData,
            targetAgents: args.targetAgents || [],
            mode: args.mode || 'assign',
            supervisorId: args.supervisorId || 'system',
            sessionId: args.sessionId,
            boardId: args.boardId,
          } as never);

        case 'cluster':
          return taskClusterTool.execute({
            action: args.clusterAction || 'list',
            clusterId: args.clusterId,
            sessionId: args.sessionId,
            boardId: args.boardId,
            name: args.name,
            description: args.description,
            taskIds: args.taskIds,
            labels: args.labels,
            createdBy: args.createdBy,
            model: args.model,
            contextModel: args.contextModel,
            content: args.content,
            items: args.items,
            category: args.category,
            itemId: args.itemId,
            checked: args.checked,
          } as never);

        case 'complexity':
          return taskComplexityTool.execute({
            action: args.complexityAction || 'analyze',
            taskId: args.taskId,
            sessionId: args.sessionId,
            boardId: args.boardId,
            model: args.model,
          } as never);

        default:
          return JSON.stringify({ success: false, error: `Unknown action: ${action}` });
      }
    } catch (error) {
      return handleToolError('task-multi', error);
    }
  },
};
