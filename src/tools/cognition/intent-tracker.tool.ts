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
 * Intent Tracker Tool
 *
 * Tracks the human's goal hierarchy and detects when the AI drifts
 * from the original intent. Supports four levels: mission, goal,
 * sub-goal, and task. Drift detection uses word-overlap scoring
 * to compare current agent actions against the active intent.
 *
 * @module tools/cognition/intent-tracker
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { getIntentStore } from '../../cognition/intent-store.js';
import { Logger } from '../../utils/logger.js';
import { executeCognitionTool } from './cognition-shared.js';
import { resolveSessionId } from '../../kanban/resolvers.js';
import type { Intent } from '../../cognition/types.js';

const schema = z.object({
  action: z
    .enum(['set', 'get', 'check-drift', 'hierarchy', 'list', 'complete', 'abandon'])
    .describe('Action to perform'),
  sessionId: z.string().describe('Session ID'),
  agentId: z.string().default('default-agent').describe('Agent ID'),

  // set
  level: z
    .enum(['mission', 'goal', 'sub-goal', 'task'])
    .optional()
    .describe('Intent level (action=set)'),
  description: z
    .string()
    .optional()
    .describe('What to achieve (action=set)'),
  parentIntentId: z
    .string()
    .optional()
    .describe('Parent intent (action=set)'),
  tags: z
    .array(z.string())
    .optional()
    .describe('Tags (action=set)'),

  // get/update
  intentId: z
    .string()
    .optional()
    .describe('Intent ID'),

  // check-drift
  currentAction: z
    .string()
    .optional()
    .describe('What agent is currently doing (action=check-drift)'),

  // list
  limit: z
    .number()
    .default(10)
    .describe('Max results'),
});

type IntentTrackerArgs = z.infer<typeof schema>;

/** Level emoji indicators for display */
const LEVEL_ICONS: Record<string, string> = {
  mission: '[MISSION]',
  goal: '[GOAL]',
  'sub-goal': '[SUB-GOAL]',
  task: '[TASK]',
};

/** Status indicators for display */
const STATUS_ICONS: Record<string, string> = {
  active: '[ACTIVE]',
  completed: '[DONE]',
  abandoned: '[ABANDONED]',
  drifted: '[DRIFTED]',
};

/**
 * Format an intent for display
 */
function formatIntent(intent: Intent, indent: number = 0): string {
  const pad = '  '.repeat(indent);
  const level = LEVEL_ICONS[intent.level] || intent.level;
  const status = STATUS_ICONS[intent.status] || intent.status;

  const lines: string[] = [];
  lines.push(`${pad}${level} ${status} ${intent.description}`);
  lines.push(`${pad}  ID: ${intent.id}`);
  lines.push(`${pad}  Agent: ${intent.agentId}`);
  lines.push(`${pad}  Created: ${new Date(intent.timestamp).toISOString()}`);

  if (intent.completedAt) {
    lines.push(`${pad}  Completed: ${new Date(intent.completedAt).toISOString()}`);
  }

  if (intent.tags.length > 0) {
    lines.push(`${pad}  Tags: ${intent.tags.join(', ')}`);
  }

  if (intent.driftAlerts.length > 0) {
    lines.push(`${pad}  Drift alerts: ${intent.driftAlerts.length}`);
    for (const alert of intent.driftAlerts.slice(-3)) {
      lines.push(
        `${pad}    - Score ${alert.driftScore.toFixed(2)}: "${alert.currentAction.substring(0, 60)}"`
      );
    }
  }

  if (intent.parentIntentId) {
    lines.push(`${pad}  Parent: ${intent.parentIntentId}`);
  }

  return lines.join('\n');
}

/**
 * Format the hierarchy as a visual tree
 */
function formatHierarchy(intents: Intent[]): string {
  if (intents.length === 0) return 'No intent hierarchy found.';

  const lines: string[] = [];
  lines.push('=== INTENT HIERARCHY ===');
  lines.push('');

  for (let i = 0; i < intents.length; i++) {
    const intent = intents[i];
    const isLast = i === intents.length - 1;
    const connector = i === 0 ? '' : isLast ? '  `-- ' : '  |-- ';
    const level = LEVEL_ICONS[intent.level] || intent.level;
    const status = STATUS_ICONS[intent.status] || intent.status;

    lines.push(`${connector}${level} ${status} ${intent.description}`);
    lines.push(`${'  '.repeat(i + 1)}ID: ${intent.id}`);
  }

  return lines.join('\n');
}

export const intentTrackerTool: UnifiedTool<typeof schema> = {
  name: 'intent-tracker',
  description:
    "Track the human's goal hierarchy and detect when AI drifts from the original intent.",
  zodSchema: schema,

  metadata: {
    category: 'cognition' as never,
    tags: ['intent', 'goals', 'drift-detection', 'focus'],
    examples: [
      {
        args: {
          action: 'set',
          sessionId: 'session-1',
          level: 'mission',
          description: 'Refactor authentication module to use JWT tokens',
          tags: ['auth', 'refactor'],
        },
        description: 'Set a mission-level intent',
      },
      {
        args: {
          action: 'set',
          sessionId: 'session-1',
          level: 'task',
          description: 'Create JWT token generation utility',
          parentIntentId: 'intent_123',
        },
        description: 'Set a task-level intent under a parent',
      },
      {
        args: {
          action: 'check-drift',
          sessionId: 'session-1',
          currentAction: 'Updating CSS styles for the login page',
        },
        description: 'Check if current action drifts from the active intent',
      },
      {
        args: {
          action: 'hierarchy',
          sessionId: 'session-1',
          intentId: 'intent_456',
        },
        description: 'Show the full goal hierarchy for an intent',
      },
    ],
    relatedTools: [
      'thinking-chain',
      'decision-journal',
      'write-memory',
      'shared-thoughts',
    ],
  },

  execute: async (args): Promise<string> => {
    const input = args as IntentTrackerArgs;

    return executeCognitionTool('intent-tracker', getIntentStore, async (store) => {
      switch (input.action) {
        // ─────────────────────────── SET ───────────────────────────
        case 'set': {
          if (!input.level) {
            return JSON.stringify({
              success: false,
              error: 'Missing required field: level (mission | goal | sub-goal | task)',
              code: 'MISSING_FIELD',
            });
          }
          if (!input.description) {
            return JSON.stringify({
              success: false,
              error: 'Missing required field: description',
              code: 'MISSING_FIELD',
            });
          }

          const intent = await store.setIntent({
            sessionId: input.sessionId,
            agentId: input.agentId,
            level: input.level,
            description: input.description,
            parentIntentId: input.parentIntentId,
            tags: input.tags || [],
          });

          if (!intent) {
            return JSON.stringify({
              success: false,
              error: 'Failed to create intent (Redis unavailable)',
              code: 'STORE_ERROR',
            });
          }

          Logger.debug(`intent-tracker: created ${intent.level} intent ${intent.id}`);

          // If has parent, show the hierarchy
          let hierarchyInfo = '';
          if (intent.parentIntentId) {
            const hierarchy = await store.getHierarchy(intent.id);
            if (hierarchy.length > 1) {
              hierarchyInfo = '\n\n' + formatHierarchy(hierarchy);
            }
          }

          return JSON.stringify({
            success: true,
            intentId: intent.id,
            level: intent.level,
            description: intent.description,
            status: intent.status,
            isActiveIntent: intent.level === 'mission' || intent.level === 'goal',
            hierarchy: hierarchyInfo || undefined,
          });
        }

        // ─────────────────────────── GET ───────────────────────────
        case 'get': {
          let intent: Intent | null = null;

          if (input.intentId) {
            intent = await store.get(input.intentId);
          } else {
            // Fall back to active intent
            intent = await store.getActiveIntent(input.sessionId);
          }

          if (!intent) {
            return JSON.stringify({
              success: false,
              error: input.intentId
                ? `Intent not found: ${input.intentId}`
                : 'No active intent for this session',
              code: 'NOT_FOUND',
            });
          }

          const output = [
            '=== INTENT DETAILS ===',
            '',
            formatIntent(intent),
          ];

          if (intent.driftAlerts.length > 0) {
            output.push('');
            output.push(`--- Drift History (${intent.driftAlerts.length} alert(s)) ---`);
            for (const alert of intent.driftAlerts) {
              output.push(
                `  [${new Date(alert.timestamp).toISOString()}] Score: ${alert.driftScore.toFixed(2)}`
              );
              output.push(`    Was doing: ${alert.currentAction}`);
              output.push(`    Should be: ${alert.expectedDirection}`);
            }
          }

          return output.join('\n');
        }

        // ────────────────────── CHECK-DRIFT ───────────────────────
        case 'check-drift': {
          if (!input.currentAction) {
            return JSON.stringify({
              success: false,
              error: 'Missing required field: currentAction',
              code: 'MISSING_FIELD',
            });
          }

          const activeIntent = await store.getActiveIntent(input.sessionId);
          if (!activeIntent) {
            return JSON.stringify({
              success: true,
              status: 'NO_ACTIVE_INTENT',
              message: 'No active intent set for this session. Use action=set to define one.',
            });
          }

          const driftAlert = await store.checkDrift(input.sessionId, input.currentAction);

          if (driftAlert) {
            const severity =
              driftAlert.driftScore > 0.7
                ? 'HIGH'
                : driftAlert.driftScore > 0.5
                  ? 'MEDIUM'
                  : 'LOW';

            const lines = [
              '!!! DRIFT DETECTED !!!',
              '',
              `Severity:          ${severity} (score: ${driftAlert.driftScore.toFixed(2)})`,
              `Original intent:   ${activeIntent.description}`,
              `Current action:    ${input.currentAction}`,
              '',
              'RECOMMENDATION: Realign your current work with the original intent.',
              `Intent ID:         ${activeIntent.id}`,
              `Intent level:      ${activeIntent.level}`,
            ];

            if (driftAlert.driftScore > 0.7) {
              lines.push('');
              lines.push(
                'WARNING: Intent has been automatically marked as DRIFTED due to high drift score.'
              );
              lines.push(
                'Consider using action=set to create a new intent if the goal has legitimately changed.'
              );
            }

            return lines.join('\n');
          }

          return [
            'ON TRACK',
            '',
            `Active intent:     ${activeIntent.description}`,
            `Current action:    ${input.currentAction}`,
            `Intent level:      ${activeIntent.level}`,
            `Intent ID:         ${activeIntent.id}`,
            '',
            'Your current action aligns with the active intent. Keep going!',
          ].join('\n');
        }

        // ────────────────────── HIERARCHY ─────────────────────────
        case 'hierarchy': {
          if (!input.intentId) {
            // Try active intent
            const active = await store.getActiveIntent(input.sessionId);
            if (!active) {
              return JSON.stringify({
                success: false,
                error: 'No intentId provided and no active intent found',
                code: 'NOT_FOUND',
              });
            }
            input.intentId = active.id;
          }

          const hierarchy = await store.getHierarchy(input.intentId);

          if (hierarchy.length === 0) {
            return JSON.stringify({
              success: false,
              error: `Intent not found: ${input.intentId}`,
              code: 'NOT_FOUND',
            });
          }

          return formatHierarchy(hierarchy);
        }

        // ─────────────────────── LIST ─────────────────────────────
        case 'list': {
          const intents = await store.listBySession(input.sessionId, input.limit);

          if (intents.length === 0) {
            return JSON.stringify({
              success: true,
              count: 0,
              message: 'No intents found for this session.',
            });
          }

          const activeIntent = await store.getActiveIntent(input.sessionId);
          const activeId = activeIntent?.id;

          const lines: string[] = [];
          lines.push(`=== INTENTS (${intents.length}) ===`);
          lines.push('');

          for (const intent of intents) {
            const isActive = intent.id === activeId ? ' << ACTIVE' : '';
            const level = LEVEL_ICONS[intent.level] || intent.level;
            const status = STATUS_ICONS[intent.status] || intent.status;
            const driftCount =
              intent.driftAlerts.length > 0
                ? ` [${intent.driftAlerts.length} drift(s)]`
                : '';

            lines.push(
              `${level} ${status} ${intent.description.substring(0, 60)}${driftCount}${isActive}`
            );
            lines.push(`  ID: ${intent.id}  |  Agent: ${intent.agentId}`);
            lines.push('');
          }

          return lines.join('\n');
        }

        // ────────────────────── COMPLETE ──────────────────────────
        case 'complete': {
          if (!input.intentId) {
            // Complete active intent
            const active = await store.getActiveIntent(input.sessionId);
            if (!active) {
              return JSON.stringify({
                success: false,
                error: 'No intentId provided and no active intent found',
                code: 'NOT_FOUND',
              });
            }
            input.intentId = active.id;
          }

          const updated = await store.updateStatus(input.intentId, 'completed');
          if (!updated) {
            return JSON.stringify({
              success: false,
              error: `Failed to complete intent: ${input.intentId}`,
              code: 'UPDATE_FAILED',
            });
          }

          Logger.debug(`intent-tracker: completed intent ${input.intentId}`);

          return JSON.stringify({
            success: true,
            intentId: input.intentId,
            status: 'completed',
            message: 'Intent marked as completed.',
          });
        }

        // ────────────────────── ABANDON ──────────────────────────
        case 'abandon': {
          if (!input.intentId) {
            const active = await store.getActiveIntent(input.sessionId);
            if (!active) {
              return JSON.stringify({
                success: false,
                error: 'No intentId provided and no active intent found',
                code: 'NOT_FOUND',
              });
            }
            input.intentId = active.id;
          }

          const updated = await store.updateStatus(input.intentId, 'abandoned');
          if (!updated) {
            return JSON.stringify({
              success: false,
              error: `Failed to abandon intent: ${input.intentId}`,
              code: 'UPDATE_FAILED',
            });
          }

          Logger.debug(`intent-tracker: abandoned intent ${input.intentId}`);

          return JSON.stringify({
            success: true,
            intentId: input.intentId,
            status: 'abandoned',
            message: 'Intent marked as abandoned.',
          });
        }

        default:
          return JSON.stringify({
            success: false,
            error: `Unknown action: ${(input as { action: string }).action}`,
            code: 'INVALID_ACTION',
          });
      }
    });
  },
};
