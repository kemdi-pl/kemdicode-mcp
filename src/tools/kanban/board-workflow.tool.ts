/**
 * KemdiCode MCP Server
 * Copyright (C) 2025-2026 Kemdi Sp. z o.o. (Dawid Irzyk <dawid@kemdi.pl>)
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

/**
 * Board Workflow Tool
 *
 * Manage automatic board switching workflows.
 * When all tasks on a board are done, automatically creates a navigation
 * task on the next board in the sequence.
 *
 * @module tools/kanban/board-workflow
 */

import { z } from 'zod';
import type { UnifiedTool } from '../registry.js';
import {
  createWorkflow,
  getWorkflow,
  listWorkflows,
  pauseWorkflow,
  resumeWorkflow,
  deleteWorkflow,
  checkAndAdvanceWorkflow,
} from '../../kanban/workflow-store.js';
import { getBoard } from '../../kanban/board-store.js';
import { rateLimitGuard } from '../../utils/validation.js';

const schema = z.object({
  action: z
    .enum(['create', 'get', 'list', 'check', 'pause', 'resume', 'delete'])
    .describe('Action: create (new workflow), get (by ID), list (all), check (manually trigger advancement), pause, resume, delete'),
  sessionId: z.string().min(1).describe('Session ID'),
  agentId: z.string().min(1).default('default-agent').describe('Agent ID'),

  // create
  name: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .describe('Workflow name (required for action=create)'),
  boardSequence: z
    .array(z.string().min(1))
    .min(2)
    .max(20)
    .optional()
    .describe('Ordered list of board IDs to process (required for action=create, min 2 boards)'),
  autoCreateNavigationTask: z
    .boolean()
    .default(true)
    .optional()
    .describe('Auto-create navigation task when board completes (default: true)'),

  // get/check/pause/resume/delete
  workflowId: z.string().min(1).optional().describe('Workflow ID'),

  // check - manual trigger
  boardId: z.string().min(1).optional().describe('Board ID to check for completion (action=check)'),
});

type BoardWorkflowArgs = z.infer<typeof schema>;

export const boardWorkflowTool: UnifiedTool<typeof schema> = {
  name: 'board-workflow',
  description:
    'Manage automatic board switching. When all tasks on a board are done, automatically creates a navigation task on the next board.',
  zodSchema: schema,

  metadata: {
    category: 'kanban' as never,
    tags: ['workflow', 'automation', 'boards', 'navigation'],
    examples: [
      {
        args: {
          action: 'create',
          sessionId: 'session-123',
          agentId: 'claude-opus',
          name: 'Feature Development Pipeline',
          boardSequence: ['board-planning', 'board-development', 'board-review', 'board-deploy'],
          autoCreateNavigationTask: true,
        },
        description: 'Create workflow: planning -> development -> review -> deploy',
      },
      {
        args: {
          action: 'check',
          sessionId: 'session-123',
          boardId: 'board-planning',
          agentId: 'claude-opus',
        },
        description: 'Manually check if board is complete and advance workflow',
      },
      {
        args: {
          action: 'list',
          sessionId: 'session-123',
        },
        description: 'List all workflows for session',
      },
    ],
    relatedTools: ['board-create', 'task-list', 'task-update'],
  },

  execute: async (args): Promise<string> => {
    const input = args as unknown as BoardWorkflowArgs;

    const blocked = rateLimitGuard('kanban-workflow', { maxRequests: 60, windowMs: 60000 });
    if (blocked) return blocked;

    switch (input.action) {
      // ─────────────────────────── CREATE ───────────────────────────────
      case 'create': {
        if (!input.name) {
          return JSON.stringify({
            success: false,
            error: 'name is required for action=create',
            code: 'VALIDATION_ERROR',
          });
        }
        if (!input.boardSequence || input.boardSequence.length < 2) {
          return JSON.stringify({
            success: false,
            error: 'boardSequence with at least 2 boards is required for action=create',
            code: 'VALIDATION_ERROR',
          });
        }

        // Validate all boards exist
        const boardNames: string[] = [];
        for (const boardId of input.boardSequence) {
          const board = await getBoard(boardId);
          if (!board) {
            return JSON.stringify({
              success: false,
              error: `Board not found: ${boardId}`,
              code: 'NOT_FOUND',
            });
          }
          boardNames.push(board.name);
        }

        const workflow = await createWorkflow({
          name: input.name,
          sessionId: input.sessionId,
          boardSequence: input.boardSequence,
          createdBy: input.agentId,
          autoCreateNavigationTask: input.autoCreateNavigationTask ?? true,
        });

        const lines: string[] = [
          '## Workflow Created',
          '',
          `**ID:** \`${workflow.id}\``,
          `**Name:** ${workflow.name}`,
          `**Status:** ${workflow.status}`,
          `**Auto-navigation:** ${workflow.autoCreateNavigationTask ? 'Yes' : 'No'}`,
          '',
          '### Board Sequence',
          '',
        ];

        for (let i = 0; i < workflow.boardSequence.length; i++) {
          const marker = i === 0 ? '[CURRENT]' : '';
          lines.push(`${i + 1}. \`${workflow.boardSequence[i]}\` - ${boardNames[i]} ${marker}`);
        }

        lines.push('');
        lines.push('*When all tasks on current board are done, workflow automatically advances to next board.*');

        return lines.join('\n');
      }

      // ─────────────────────────── GET ──────────────────────────────────
      case 'get': {
        if (!input.workflowId) {
          return JSON.stringify({
            success: false,
            error: 'workflowId is required for action=get',
            code: 'VALIDATION_ERROR',
          });
        }

        const workflow = await getWorkflow(input.workflowId);
        if (!workflow) {
          return JSON.stringify({
            success: false,
            error: `Workflow not found: ${input.workflowId}`,
            code: 'NOT_FOUND',
          });
        }

        const currentBoard = workflow.boardSequence[workflow.currentIndex];
        const lines: string[] = [
          '## Workflow Details',
          '',
          `**ID:** \`${workflow.id}\``,
          `**Name:** ${workflow.name}`,
          `**Status:** ${workflow.status}`,
          `**Current Board:** \`${currentBoard}\` (${workflow.currentIndex + 1}/${workflow.boardSequence.length})`,
          `**Auto-navigation:** ${workflow.autoCreateNavigationTask ? 'Yes' : 'No'}`,
          '',
          '### Board Sequence',
          '',
        ];

        for (let i = 0; i < workflow.boardSequence.length; i++) {
          let marker = '';
          if (i < workflow.currentIndex) marker = '[DONE]';
          else if (i === workflow.currentIndex) marker = '[CURRENT]';
          lines.push(`${i + 1}. \`${workflow.boardSequence[i]}\` ${marker}`);
        }

        return lines.join('\n');
      }

      // ─────────────────────────── LIST ─────────────────────────────────
      case 'list': {
        const workflows = await listWorkflows(input.sessionId);

        if (workflows.length === 0) {
          return 'No workflows found for this session. Use action=create to start one.';
        }

        const lines: string[] = [
          `## Workflows (${workflows.length})`,
          '',
          '| ID | Name | Status | Progress | Auto-Nav |',
          '|---|---|---|---|---|',
        ];

        for (const wf of workflows) {
          const progress = `${wf.currentIndex + 1}/${wf.boardSequence.length}`;
          const autoNav = wf.autoCreateNavigationTask ? 'Yes' : 'No';
          lines.push(`| \`${wf.id}\` | ${wf.name} | ${wf.status} | ${progress} | ${autoNav} |`);
        }

        return lines.join('\n');
      }

      // ─────────────────────────── CHECK ────────────────────────────────
      case 'check': {
        if (!input.boardId) {
          return JSON.stringify({
            success: false,
            error: 'boardId is required for action=check',
            code: 'VALIDATION_ERROR',
          });
        }

        const result = await checkAndAdvanceWorkflow(
          input.boardId,
          input.sessionId,
          input.agentId
        );

        if (result.advanced) {
          return JSON.stringify({
            success: true,
            advanced: true,
            previousBoardId: input.boardId,
            nextBoardId: result.nextBoardId,
            navigationTaskId: result.navigationTaskId,
            message: `Workflow advanced! All tasks on ${input.boardId} done. Now on ${result.nextBoardId}.`,
          });
        } else {
          return JSON.stringify({
            success: true,
            advanced: false,
            boardId: input.boardId,
            message: result.workflow?.status === 'completed'
              ? 'Workflow completed (last board reached).'
              : 'Board has pending tasks or no active workflow.',
          });
        }
      }

      // ─────────────────────────── PAUSE ────────────────────────────────
      case 'pause': {
        if (!input.workflowId) {
          return JSON.stringify({
            success: false,
            error: 'workflowId is required for action=pause',
            code: 'VALIDATION_ERROR',
          });
        }

        const success = await pauseWorkflow(input.workflowId);
        if (!success) {
          return JSON.stringify({
            success: false,
            error: `Workflow not found: ${input.workflowId}`,
            code: 'NOT_FOUND',
          });
        }

        return JSON.stringify({
          success: true,
          workflowId: input.workflowId,
          status: 'paused',
          message: 'Workflow paused. Auto-advancement disabled until resumed.',
        });
      }

      // ─────────────────────────── RESUME ───────────────────────────────
      case 'resume': {
        if (!input.workflowId) {
          return JSON.stringify({
            success: false,
            error: 'workflowId is required for action=resume',
            code: 'VALIDATION_ERROR',
          });
        }

        const success = await resumeWorkflow(input.workflowId);
        if (!success) {
          return JSON.stringify({
            success: false,
            error: `Workflow not found: ${input.workflowId}`,
            code: 'NOT_FOUND',
          });
        }

        return JSON.stringify({
          success: true,
          workflowId: input.workflowId,
          status: 'active',
          message: 'Workflow resumed. Auto-advancement enabled.',
        });
      }

      // ─────────────────────────── DELETE ───────────────────────────────
      case 'delete': {
        if (!input.workflowId) {
          return JSON.stringify({
            success: false,
            error: 'workflowId is required for action=delete',
            code: 'VALIDATION_ERROR',
          });
        }

        const success = await deleteWorkflow(input.workflowId);
        if (!success) {
          return JSON.stringify({
            success: false,
            error: `Workflow not found: ${input.workflowId}`,
            code: 'NOT_FOUND',
          });
        }

        return JSON.stringify({
          success: true,
          workflowId: input.workflowId,
          message: 'Workflow deleted.',
        });
      }

      default:
        return JSON.stringify({
          success: false,
          error: `Unknown action: ${(input as { action: string }).action}`,
          code: 'INVALID_ACTION',
        });
    }
  },
};
