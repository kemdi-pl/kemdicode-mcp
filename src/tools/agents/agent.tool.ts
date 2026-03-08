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
 * Unified Agent Tool
 *
 * Consolidates 5 agent management tools into a single action-based tool:
 * - register: Register 1-N agents (was agent-register)
 * - list: List active agents (was agent-list)
 * - init: Full onboarding flow (was agent-init)
 * - summary: Update agent summaries (was agent-summary)
 * - rank: View/manage agent rankings (was agent-rank)
 */

import { z } from 'zod';
import type { UnifiedTool } from '../registry.js';
import { agentRegisterTool } from './agent-register.tool.js';
import { agentListTool } from './agent-list.tool.js';
import { agentInitTool } from './agent-init.tool.js';
import { agentSummaryTool } from './agent-summary.tool.js';
import { agentRankTool } from './agent-rank.tool.js';

const schema = z.object({
  action: z
    .enum(['register', 'list', 'init', 'summary', 'rank'])
    .describe('Action: register (bulk 1-20), list (active agents), init (full onboarding), summary (update status), rank (leaderboard/promote/demote)'),

  // ── register params ──────────────────────────────────────────────────────
  agents: z
    .array(
      z.object({
        name: z.string().min(1).describe('Human-readable agent name'),
        role: z
          .enum(['supervisor', 'worker', 'specialist', 'coordinator'])
          .default('worker')
          .describe('Agent role'),
        model: z.string().optional().describe('Model being used'),
        metadata: z
          .record(
            z.string().regex(/^(?!__proto__|constructor|prototype$)/, 'Reserved key name'),
            z.unknown()
          )
          .optional()
          .describe('Additional metadata'),
      })
    )
    .min(1)
    .max(20)
    .optional()
    .describe('Agents to register (action=register, max 20)'),
  serverId: z
    .string()
    .default('kemdicode-mcp')
    .describe('Server running these agents (action=register)'),

  // ── list params ──────────────────────────────────────────────────────────
  includeIdle: z.boolean().default(true).describe('Include idle agents (action=list)'),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .default(0)
    .describe('Pagination offset (action=list)'),
  limit: z
    .number()
    .min(1)
    .max(100)
    .default(50)
    .describe('Max items to return (action=list, rank)'),

  // ── init params ──────────────────────────────────────────────────────────
  name: z.string().optional().describe('Agent name (action=init)'),
  role: z
    .enum(['supervisor', 'worker', 'specialist', 'coordinator'])
    .optional()
    .default('worker')
    .describe('Agent role (action=init)'),
  model: z.string().optional().describe('Model being used (action=init)'),
  boardId: z
    .string()
    .optional()
    .describe('Board to work on (action=init, by ID or "name:Board Name")'),
  autoClaim: z
    .boolean()
    .optional()
    .default(true)
    .describe('Auto-claim next available task (action=init)'),
  autoIntent: z
    .boolean()
    .optional()
    .default(true)
    .describe('Auto-set intent from claimed task (action=init)'),
  initialConfidence: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .default(0.7)
    .describe('Initial confidence level 0-1 (action=init)'),
  metadata: z
    .record(
      z.string().regex(/^(?!__proto__|constructor|prototype$)/, 'Reserved key name'),
      z.unknown()
    )
    .optional()
    .describe('Additional metadata (action=init, register)'),

  // ── summary params ───────────────────────────────────────────────────────
  summaries: z
    .array(
      z.object({
        agentId: z.string().min(1).describe('Agent ID'),
        activity: z.string().min(1).describe('Current activity description'),
        progress: z.number().min(0).max(100).optional().describe('Progress percentage'),
        taskId: z.string().optional().describe('Current task ID'),
        lastAction: z.string().optional().describe('Last completed action'),
      })
    )
    .min(1)
    .max(20)
    .optional()
    .describe('Agent summaries to update (action=summary, max 20)'),

  // ── rank params ──────────────────────────────────────────────────────────
  rankAction: z
    .enum(['get-rank', 'leaderboard', 'promote', 'demote', 'history'])
    .optional()
    .default('leaderboard')
    .describe('Rank sub-action (action=rank)'),
  agentId: z
    .string()
    .optional()
    .describe('Agent ID (action=rank for get-rank/promote/demote/history)'),

  // ── shared params ────────────────────────────────────────────────────────
  sessionId: z
    .string()
    .optional()
    .describe('Session ID (required for register/summary, optional for list/init)'),
});

export const agentTool: UnifiedTool = {
  name: 'agent',
  description:
    'Unified agent management. Actions: register (bulk 1-20 agents), list (active agents), init (full onboarding: register + claim task + set intent + record confidence), summary (update activity/progress), rank (leaderboard, get-rank, promote, demote, history).',
  zodSchema: schema,
  skipContextShare: true,
  metadata: {
    category: 'agents',
    tags: ['agent', 'register', 'list', 'init', 'summary', 'rank'],
    examples: [
      {
        args: { action: 'list' },
        description: 'List all active agents',
      },
      {
        args: {
          action: 'register',
          agents: [{ name: 'Backend Dev', role: 'worker' }],
          sessionId: 'sess-abc123',
        },
        description: 'Register a single agent',
      },
      {
        args: { action: 'init', name: 'Backend Dev', role: 'worker' },
        description: 'Full onboarding with auto-claim',
      },
      {
        args: {
          action: 'summary',
          summaries: [{ agentId: 'backend-dev', activity: 'Writing tests', progress: 50 }],
          sessionId: 'sess-abc123',
        },
        description: 'Update agent progress',
      },
      {
        args: { action: 'rank', rankAction: 'leaderboard' },
        description: 'View agent leaderboard',
      },
    ],
    relatedTools: ['agent-comm', 'monitor', 'task-list'],
  },

  execute: async (args) => {
    const parsed = args as unknown as z.infer<typeof schema>;

    switch (parsed.action) {
      case 'register': {
        if (!parsed.agents || parsed.agents.length === 0) {
          return JSON.stringify({
            success: false,
            error: 'agents array is required for action=register',
            code: 'VALIDATION_ERROR',
          });
        }
        if (!parsed.sessionId) {
          return JSON.stringify({
            success: false,
            error: 'sessionId is required for action=register',
            code: 'VALIDATION_ERROR',
          });
        }
        return agentRegisterTool.execute({
          agents: parsed.agents,
          sessionId: parsed.sessionId,
          serverId: parsed.serverId,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any);
      }

      case 'list': {
        return agentListTool.execute({
          sessionId: parsed.sessionId,
          includeIdle: parsed.includeIdle,
          offset: parsed.offset ?? 0,
          limit: parsed.limit,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any);
      }

      case 'init': {
        if (!parsed.name) {
          return JSON.stringify({
            success: false,
            error: 'name is required for action=init',
            code: 'VALIDATION_ERROR',
          });
        }
        return agentInitTool.execute({
          name: parsed.name,
          role: parsed.role,
          model: parsed.model,
          sessionId: parsed.sessionId,
          boardId: parsed.boardId,
          autoClaim: parsed.autoClaim,
          autoIntent: parsed.autoIntent,
          initialConfidence: parsed.initialConfidence,
          metadata: parsed.metadata,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any);
      }

      case 'summary': {
        if (!parsed.summaries || parsed.summaries.length === 0) {
          return JSON.stringify({
            success: false,
            error: 'summaries array is required for action=summary',
            code: 'VALIDATION_ERROR',
          });
        }
        if (!parsed.sessionId) {
          return JSON.stringify({
            success: false,
            error: 'sessionId is required for action=summary',
            code: 'VALIDATION_ERROR',
          });
        }
        return agentSummaryTool.execute({
          summaries: parsed.summaries,
          sessionId: parsed.sessionId,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any);
      }

      case 'rank': {
        return agentRankTool.execute({
          action: parsed.rankAction ?? 'leaderboard',
          agentId: parsed.agentId,
          limit: parsed.limit,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any);
      }

      default:
        return JSON.stringify({
          success: false,
          error: `Unknown action: ${parsed.action}`,
          code: 'UNKNOWN_ACTION',
        });
    }
  },
};
