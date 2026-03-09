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
 * Agent Init Tool
 *
 * Combines common agent onboarding steps into a single call:
 * 1. Register the agent (agent-register)
 * 2. List available tasks (task-list)
 * 3. Claim next unblocked task (task-claim) — optional
 * 4. Set an intent from task title (intent-tracker set) — optional
 * 5. Record initial confidence (confidence-tracker record) — optional
 *
 * Replaces 5-7 separate tool calls with one atomic onboarding operation.
 *
 * @module tools/agents/agent-init
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { executeWithGuard } from '../tool-shared.js';
import { getAgentMonitor } from '../../context/agent-monitor.js';
import type { AgentRole } from '../../context/types.js';
import { resolveSessionId, resolveBoardId } from '../../kanban/resolvers.js';
import { listTasks, getAvailableTasks, claimTask } from '../../kanban/index.js';
import { getIntentStore } from '../../cognition/intent-store.js';
import { getConfidenceStore } from '../../cognition/confidence-store.js';
import { isSilent } from '../../config/silent.js';
import { Logger } from '../../utils/logger.js';

const schema = z.object({
  name: z.string().min(1).describe('Agent name'),
  role: z
    .enum(['supervisor', 'worker', 'specialist', 'coordinator'])
    .optional()
    .default('worker')
    .describe('Agent role'),
  model: z.string().optional().describe('Model being used'),
  sessionId: z
    .string()
    .optional()
    .describe('Session ID (auto-detected from active session if omitted)'),
  boardId: z
    .string()
    .optional()
    .describe('Board to work on (by ID or "name:Board Name")'),
  autoClaim: z
    .boolean()
    .optional()
    .default(true)
    .describe('Auto-claim next available task'),
  autoIntent: z
    .boolean()
    .optional()
    .default(true)
    .describe('Auto-set intent from claimed task'),
  initialConfidence: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .default(0.7)
    .describe('Initial confidence level (0-1)'),
  metadata: z
    .record(
      z.string().regex(/^(?!__proto__|constructor|prototype$)/, 'Reserved key name'),
      z.unknown()
    )
    .optional()
    .describe('Additional metadata'),
});

type AgentInitArgs = z.infer<typeof schema>;

interface InitResult {
  agentId: string;
  sessionId: string;
  registered: boolean;
  availableTasks: number;
  claimedTask: {
    id: string;
    title: string;
    priority: string;
  } | null;
  intentSet: {
    id: string;
    level: string;
    description: string;
  } | null;
  confidenceRecorded: {
    id: string;
    confidence: number;
    flaggedForReview: boolean;
  } | null;
  errors: string[];
}

export const agentInitTool: UnifiedTool = {
  name: 'agent-init',
  description:
    'Full single-call agent onboarding: (1) register agent, (2) list available tasks, (3) auto-claim first unclaimed task, (4) set intent, (5) record initial confidence. Replaces 5 separate tool calls. Use for standard onboarding. For bulk registration without task claiming, use agent-register.',
  zodSchema: schema,
  skipContextShare: true,
  metadata: {
    category: 'agents',
    tags: ['init', 'onboarding', 'register', 'lifecycle'],
    examples: [
      {
        args: { name: 'Backend Dev', role: 'worker', model: 'claude-sonnet-4-6' },
        description: 'Quick onboarding: register, claim first task, set intent, record confidence',
      },
      {
        args: {
          name: 'QA Agent',
          role: 'specialist',
          boardId: 'name:Sprint 1',
          autoClaim: true,
          initialConfidence: 0.8,
        },
        description: 'Onboard specialist to a specific board with custom confidence',
      },
      {
        args: {
          name: 'Coordinator',
          role: 'coordinator',
          autoClaim: false,
          autoIntent: false,
        },
        description: 'Register coordinator without claiming tasks or setting intent',
      },
    ],
    relatedTools: ['agent-register', 'task-list', 'task-claim', 'intent-tracker', 'confidence-tracker'],
  },

  execute: async (args): Promise<string> => {
    const input = args as AgentInitArgs;

    return executeWithGuard('agent-init', 'agent-operations', async () => {
      const result: InitResult = {
        agentId: '',
        sessionId: '',
        registered: false,
        availableTasks: 0,
        claimedTask: null,
        intentSet: null,
        confidenceRecorded: null,
        errors: [],
      };

      // ── Step 0: Resolve session ID ──────────────────────────────────────
      const sessionId = resolveSessionId(input.sessionId);
      result.sessionId = sessionId;

      // ── Step 1: Register the agent ──────────────────────────────────────
      try {
        const monitor = getAgentMonitor();
        if (!monitor.isConnected()) {
          await monitor.connect();
        }

        const agent = await monitor.registerAgent(
          input.name,
          input.role as AgentRole,
          sessionId,
          'kemdicode-mcp',
          input.model,
          input.metadata || {}
        );

        if (agent) {
          result.agentId = agent.id;
          result.registered = true;
          Logger.debug(`agent-init: registered agent ${agent.id} (${input.name})`);
        } else {
          result.errors.push('Agent registration returned null');
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        result.errors.push(`Registration failed: ${msg}`);
        Logger.error(`[agent-init] Registration failed: ${msg}`);
      }

      // If registration failed, return early — other steps depend on agentId
      if (!result.agentId) {
        return JSON.stringify({
          success: false,
          ...result,
        });
      }

      // ── Step 2: List available tasks ────────────────────────────────────
      let resolvedBoardId: string | undefined;
      let fetchedTasks: Awaited<ReturnType<typeof getAvailableTasks>> = [];
      try {
        resolvedBoardId = input.boardId
          ? await resolveBoardId(input.boardId, sessionId)
          : undefined;

        fetchedTasks = resolvedBoardId
          ? await listTasks(sessionId, {
              unassigned: true,
              blocked: false,
              status: 'backlog',
              boardId: resolvedBoardId,
            })
          : await getAvailableTasks(sessionId);

        result.availableTasks = fetchedTasks.length;
        Logger.debug(`agent-init: found ${fetchedTasks.length} available tasks`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        result.errors.push(`Task listing failed: ${msg}`);
        Logger.error(`[agent-init] Task listing failed: ${msg}`);
      }

      // ── Step 3: Auto-claim next task (optional) ─────────────────────────
      if (input.autoClaim && fetchedTasks.length > 0) {
        try {
          // Reuse tasks fetched in Step 2 to avoid race condition
          const claimed = await claimTask(fetchedTasks[0].id, result.agentId);

          if (claimed) {
            result.claimedTask = {
              id: claimed.id,
              title: claimed.title,
              priority: claimed.priority,
            };
            Logger.debug(
              `agent-init: claimed task ${claimed.id}: ${claimed.title}`
            );
          }
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          result.errors.push(`Task claim failed: ${msg}`);
          Logger.error(`[agent-init] Task claim failed: ${msg}`);
        }
      }

      // ── Step 4: Auto-set intent from claimed task (optional) ────────────
      if (input.autoIntent && result.claimedTask) {
        try {
          const intentStore = getIntentStore();
          const intent = await intentStore.setIntent({
            sessionId,
            agentId: result.agentId,
            level: 'task',
            description: result.claimedTask.title,
            parentIntentId: undefined,
            tags: ['agent-init', 'auto-generated'],
          });

          if (intent) {
            result.intentSet = {
              id: intent.id,
              level: intent.level,
              description: intent.description,
            };
            Logger.debug(`agent-init: set intent ${intent.id} from task title`);
          }
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          result.errors.push(`Intent setting failed: ${msg}`);
          Logger.error(`[agent-init] Intent setting failed: ${msg}`);
        }
      }

      // ── Step 5: Record initial confidence (optional) ────────────────────
      if (input.initialConfidence !== undefined && input.initialConfidence > 0) {
        try {
          const confidenceStore = getConfidenceStore();
          const domain = result.claimedTask ? 'task-execution' : 'general';
          const toolName = result.claimedTask
            ? `task:${result.claimedTask.id}`
            : 'agent-init';

          const record = await confidenceStore.record({
            sessionId,
            agentId: result.agentId,
            toolName,
            confidence: input.initialConfidence,
            domain,
            reasoning: result.claimedTask
              ? `Initial confidence for task: ${result.claimedTask.title}`
              : `Initial agent confidence at onboarding`,
          });

          if (record) {
            result.confidenceRecorded = {
              id: record.id,
              confidence: record.confidence,
              flaggedForReview: record.flaggedForReview,
            };
            Logger.debug(
              `agent-init: recorded confidence ${record.confidence} (${record.id})`
            );
          }
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          result.errors.push(`Confidence recording failed: ${msg}`);
          Logger.error(`[agent-init] Confidence recording failed: ${msg}`);
        }
      }

      // ── Build response ──────────────────────────────────────────────────
      const success = result.registered && result.errors.length === 0;

      if (isSilent()) {
        return JSON.stringify({
          agentId: result.agentId,
          task: result.claimedTask?.id ?? null,
          intent: result.intentSet?.id ?? null,
          confidence: result.confidenceRecorded?.id ?? null,
          errors: result.errors.length > 0 ? result.errors : undefined,
        });
      }

      return JSON.stringify({
        success,
        summary: buildSummary(result),
        ...result,
      });
    });
  },
};

/**
 * Build a human-readable summary of the init result.
 */
function buildSummary(result: InitResult): string {
  const parts: string[] = [];

  if (result.registered) {
    parts.push(`Registered agent "${result.agentId}"`);
  }

  parts.push(`${result.availableTasks} task(s) available`);

  if (result.claimedTask) {
    parts.push(`Claimed: "${result.claimedTask.title}" (${result.claimedTask.priority})`);
  }

  if (result.intentSet) {
    parts.push(`Intent set: ${result.intentSet.description}`);
  }

  if (result.confidenceRecorded) {
    const pct = (result.confidenceRecorded.confidence * 100).toFixed(0);
    parts.push(`Confidence: ${pct}%`);
  }

  if (result.errors.length > 0) {
    parts.push(`${result.errors.length} warning(s)`);
  }

  return parts.join(' | ');
}
