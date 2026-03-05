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
 * Smart Handoff Tool
 *
 * Creates structured handoff reports for session transitions -- modeled
 * after medical shift handoffs.  A handoff is NOT a data dump; it is a
 * curated briefing document that tells the next agent:
 *
 *   1. What the human wanted (intent)
 *   2. What approach was taken and why
 *   3. What is done, in-progress, and blocked
 *   4. What we know we don't know
 *   5. Warnings and landmines
 *   6. THE single most important first action
 *
 * The "latest" action is designed to be the very first thing a resurrected
 * session loads -- it gives the incoming agent immediate situational awareness.
 *
 * @module tools/cognition/smart-handoff
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { getHandoffStore } from '../../cognition/handoff-store.js';
import { getIntentStore } from '../../cognition/intent-store.js';
import { getDecisionStore } from '../../cognition/decision-store.js';
import { getErrorPatternStore } from '../../cognition/error-pattern-store.js';
import { getSelfCritiqueStore } from '../../cognition/self-critique-store.js';
import { getMentalModelStore } from '../../cognition/mental-model-store.js';
import { Logger } from '../../utils/logger.js';
import { executeCognitionTool } from './cognition-shared.js';
import { resolveSessionId } from '../../kanban/resolvers.js';
import { listChains } from '../../thinking/thinking-store.js';

const schema = z.object({
  action: z.enum(['create', 'get', 'latest', 'list']).describe('Action: create (write handoff), get (by ID), latest (most recent), list (history)'),
  sessionId: z.string().optional().describe('Session ID (auto-detected from active session if omitted)'),
  agentId: z.string().min(1).max(50).optional().default('default-agent').describe('Agent ID'),

  // create
  intent: z.string().min(10).max(1000).optional().describe("The human's original intent (required for action=create, 10-1000 chars)"),
  approach: z.string().max(2000).optional().describe('Approach that was taken (action=create, max 2000 chars)'),
  reasoning: z.string().max(2000).optional().describe('Why this approach (action=create, max 2000 chars)'),
  completed: z.array(z.string().min(1).max(500)).max(50).optional().describe('What is done (action=create, max 50 items)'),
  inProgress: z.array(z.string().min(1).max(500)).max(50).optional().describe('What is in progress (action=create, max 50 items)'),
  blocked: z.array(z.string().min(1).max(500)).max(20).optional().describe('What is blocked and why (action=create, max 20 items)'),
  knownUnknowns: z
    .array(z.string().min(1).max(500))
    .max(20)
    .optional()
    .describe("Things we know we don't know (action=create, max 20 items)"),
  warnings: z.array(z.string().min(1).max(500)).max(20).optional().describe('Warnings for next agent (action=create, max 20 items)'),
  firstAction: z
    .string()
    .min(5)
    .max(500)
    .optional()
    .describe('Single most important first action for next agent (required for action=create, 5-500 chars)'),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe('Confidence in overall state 0-1 (action=create)'),

  // get
  handoffId: z.string().min(1).optional().describe('Handoff ID (required for action=get)'),

  // list
  limit: z.number().min(1).max(50).optional().default(5).describe('Max results (1-50)'),
});

type SmartHandoffArgs = z.infer<typeof schema>;

/**
 * Format confidence as a human-readable percentage string.
 */
function formatConfidence(confidence: number): string {
  return `${Math.round(confidence * 100)}%`;
}

/**
 * Format a timestamp as an ISO date string.
 */
function formatTimestamp(ts: number): string {
  return new Date(ts).toISOString();
}

/**
 * Format a list of items as a bullet list, or a fallback message if empty.
 */
function formatBulletList(items: string[], emptyMessage: string): string[] {
  if (items.length === 0) return [`_${emptyMessage}_`];
  return items.map((item) => `- ${item}`);
}

/**
 * Format a full HandoffReport into a structured briefing document.
 */
function formatHandoffReport(report: {
  id: string;
  sessionId: string;
  agentId: string;
  timestamp: number;
  intent: string;
  approach: string;
  reasoning: string;
  completed: string[];
  inProgress: string[];
  blocked: string[];
  knownUnknowns: string[];
  warnings: string[];
  firstAction: string;
  confidence: number;
}): string {
  const lines: string[] = [
    '## Handoff Report',
    '',
    `**ID:** \`${report.id}\``,
    `**Session:** \`${report.sessionId}\``,
    `**Agent:** ${report.agentId}`,
    `**Timestamp:** ${formatTimestamp(report.timestamp)}`,
    '',
    '### Intent',
    report.intent,
    '',
    '### Approach & Reasoning',
    `${report.approach} -- ${report.reasoning}`,
    '',
    '### Status',
    '',
    '**Completed:**',
    ...formatBulletList(report.completed, 'Nothing completed yet'),
    '',
    '**In Progress:**',
    ...formatBulletList(report.inProgress, 'Nothing in progress'),
    '',
    '**Blocked:**',
    ...formatBulletList(report.blocked, 'Nothing blocked'),
    '',
    '### Known Unknowns',
    ...formatBulletList(report.knownUnknowns, 'No known unknowns identified'),
    '',
    '### Warnings',
    ...formatBulletList(report.warnings, 'No warnings'),
    '',
    '### FIRST ACTION FOR NEXT AGENT',
    `>>> ${report.firstAction} <<<`,
    '',
    `**Confidence:** ${formatConfidence(report.confidence)}`,
  ];

  return lines.join('\n');
}

export const smartHandoffTool: UnifiedTool<typeof schema> = {
  name: 'smart-handoff',
  description:
    'Create structured handoff reports for session transitions — like a medical shift handoff, not a data dump. ' +
    'USE PROACTIVELY: "create" a handoff before session ends or when task is paused. ' +
    '"latest" at session start to resume previous work. Captures progress, blockers, and next steps.',
  zodSchema: schema,

  metadata: {
    category: 'cognition' as never,
    tags: ['handoff', 'continuity', 'session-transfer'],
    examples: [
      {
        args: {
          action: 'create',
          sessionId: 'session-abc',
          agentId: 'backend-dev',
          intent: 'Implement JWT authentication for the user service',
          approach: 'Added passport-jwt strategy with RS256 signing, refresh token rotation',
          reasoning:
            'RS256 allows key rotation without redeploying; refresh tokens improve UX without compromising security',
          completed: [
            'JWT middleware with RS256 verification',
            'Refresh token endpoint with rotation',
            'Unit tests for token validation',
          ],
          inProgress: ['Integration tests with the API gateway'],
          blocked: ['CORS configuration needs DevOps input -- ticket INFRA-342 opened'],
          knownUnknowns: [
            'Token revocation strategy not decided -- blacklist vs short-lived tokens',
            'Rate limiting on auth endpoints not scoped yet',
          ],
          warnings: [
            'Do NOT change the JWT secret in .env.production -- it will invalidate all existing tokens',
            'The refresh token table has no index on expires_at yet -- add before production',
          ],
          firstAction: 'Run integration tests: npm run test:integration -- --grep auth',
          confidence: 0.8,
        },
        description: 'Create a detailed handoff report for JWT authentication work',
      },
      {
        args: {
          action: 'latest',
          sessionId: 'session-abc',
        },
        description:
          'Load the latest handoff for session resurrection -- this is what a new agent should read first',
      },
      {
        args: {
          action: 'get',
          sessionId: 'session-abc',
          handoffId: 'handoff_1234567890_abcd1234',
        },
        description: 'Retrieve a specific handoff report by ID',
      },
      {
        args: {
          action: 'list',
          sessionId: 'session-abc',
          limit: 3,
        },
        description: 'List the 3 most recent handoff reports for a session',
      },
    ],
    relatedTools: ['decision-journal', 'intent-tracker', 'thinking-chain', 'session-info'],
  },

  execute: async (args): Promise<string> => {
    const input = args as unknown as SmartHandoffArgs;

    const sessionId = resolveSessionId(input.sessionId);

    return executeCognitionTool('smart-handoff', getHandoffStore, async (store) => {
      switch (input.action) {
        // ─────────────────────────── CREATE ──────────────────────────────
        case 'create': {
          const missing: string[] = [];
          if (!input.intent) missing.push('intent');
          if (!input.firstAction) missing.push('firstAction');

          if (missing.length > 0) {
            return JSON.stringify({
              success: false,
              error: `Missing required fields for create: ${missing.join(', ')}`,
              code: 'VALIDATION_ERROR',
              missingFields: missing,
            });
          }

          const report = await store.create({
            sessionId,
            agentId: input.agentId,
            intent: input.intent!,
            approach: input.approach || '',
            reasoning: input.reasoning || '',
            completed: input.completed || [],
            inProgress: input.inProgress || [],
            blocked: input.blocked || [],
            knownUnknowns: input.knownUnknowns || [],
            warnings: input.warnings || [],
            firstAction: input.firstAction!,
            confidence: input.confidence ?? 0.5,
          });

          if (!report) {
            return JSON.stringify({
              success: false,
              error: 'Failed to create handoff report (Redis unavailable)',
              code: 'STORE_ERROR',
            });
          }

          Logger.debug(`smart-handoff: created ${report.id}`);

          // Auto-enrich with cognition snapshot
          const enrichmentSections: string[] = [];
          try {
            // Active intent hierarchy
            const intentStore = getIntentStore();
            const activeIntent = await intentStore.getActiveIntent(sessionId);
            if (activeIntent) {
              const hierarchy = await intentStore.getHierarchy(activeIntent.id);
              enrichmentSections.push('### Active Intent Hierarchy');
              for (const intent of hierarchy) {
                const indent = '  '.repeat(
                  ['mission', 'goal', 'sub-goal', 'task'].indexOf(intent.level)
                );
                const drift =
                  intent.driftAlerts.length > 0
                    ? ` (${intent.driftAlerts.length} drift alerts)`
                    : '';
                enrichmentSections.push(
                  `${indent}- [${intent.level.toUpperCase()}] ${intent.description}${drift}`
                );
              }
              enrichmentSections.push('');
            }

            // Recent decisions with outcomes
            const decisionStore = getDecisionStore();
            const decisions = await decisionStore.listBySession(sessionId, 5);
            if (decisions.length > 0) {
              enrichmentSections.push('### Recent Decisions');
              for (const d of decisions) {
                const outcome = d.outcome ? ` -> Outcome: ${d.outcome}` : ' -> (pending outcome)';
                enrichmentSections.push(
                  `- **${d.question}**: ${d.chosen} (conf=${d.confidence})${outcome}`
                );
              }
              enrichmentSections.push('');
            }

            // Recurring error patterns
            const errorStore = getErrorPatternStore();
            const patterns = await errorStore.listAll(5);
            const recurring = patterns.filter((p) => p.occurrences > 1);
            if (recurring.length > 0) {
              enrichmentSections.push('### Recurring Error Patterns');
              for (const p of recurring) {
                enrichmentSections.push(
                  `- [${p.errorType}] ${p.context} (${p.occurrences}x) -- Fix: ${p.fix.substring(0, 100)}`
                );
              }
              enrichmentSections.push('');
            }

            // Applicable lessons
            const critiqueStore = getSelfCritiqueStore();
            const lessons = await critiqueStore.getLessonsLearned(5);
            if (lessons.length > 0) {
              enrichmentSections.push('### Lessons Learned (apply these!)');
              for (const lesson of lessons) {
                enrichmentSections.push(`- ${lesson}`);
              }
              enrichmentSections.push('');
            }

            // Stale mental models
            const modelStore = getMentalModelStore();
            const models = await modelStore.listBySession(sessionId);
            const staleModels = models.filter((m) => m.staleSince);
            if (staleModels.length > 0) {
              enrichmentSections.push('### Stale Mental Models');
              for (const m of staleModels) {
                enrichmentSections.push(
                  `- "${m.name}" stale since ${new Date(m.staleSince!).toISOString()}`
                );
              }
              enrichmentSections.push('');
            }

            // Active thinking chains
            const activeChains = await listChains({ sessionId, status: 'active', limit: 5 });
            if (activeChains.length > 0) {
              enrichmentSections.push('### Active Thinking Chains');
              for (const chain of activeChains) {
                const lastThought = chain.thoughts[chain.thoughts.length - 1];
                const conf = lastThought ? `${lastThought.confidence}%` : 'N/A';
                const content = lastThought
                  ? lastThought.content.length > 80
                    ? lastThought.content.substring(0, 77) + '...'
                    : lastThought.content
                  : '';
                enrichmentSections.push(
                  `- "${chain.title}" — ${chain.thoughts.length} thoughts, confidence: ${conf}`
                );
                if (content) {
                  enrichmentSections.push(`  Last: ${content}`);
                }
              }
              enrichmentSections.push('');
            }
          } catch (enrichErr) {
            Logger.warn(
              `[smart-handoff] Non-critical enrichment error: ${enrichErr instanceof Error ? enrichErr.message : String(enrichErr)}`
            );
          }

          const baseReport = formatHandoffReport(report);
          if (enrichmentSections.length > 0) {
            return (
              baseReport +
              '\n\n---\n## Cognition Snapshot (auto-generated)\n\n' +
              enrichmentSections.join('\n')
            );
          }
          return baseReport;
        }

        // ─────────────────────────── GET ─────────────────────────────────
        case 'get': {
          if (!input.handoffId) {
            return JSON.stringify({
              success: false,
              error: 'Missing required field: handoffId',
              code: 'VALIDATION_ERROR',
            });
          }

          const report = await store.get(input.handoffId);
          if (!report) {
            return JSON.stringify({
              success: false,
              error: `Handoff report not found: ${input.handoffId}`,
              code: 'NOT_FOUND',
            });
          }

          return formatHandoffReport(report);
        }

        // ─────────────────────────── LATEST ─────────────────────────────
        case 'latest': {
          const report = await store.getLatest(sessionId);

          if (!report) {
            return [
              '## Handoff Report',
              '',
              `No handoff reports found for session \`${sessionId}\`.`,
              '',
              'This is either a fresh session or no previous agent created a handoff.',
              "Proceed by understanding the human's intent directly.",
            ].join('\n');
          }

          const lines: string[] = [
            '# SESSION RESURRECTION -- READ THIS FIRST',
            '',
            formatHandoffReport(report),
            '',
            '---',
            `_This is the latest handoff from agent \`${report.agentId}\` at ${formatTimestamp(report.timestamp)}._`,
            '_Use `action: "list"` to see previous handoffs for full context history._',
          ];

          return lines.join('\n');
        }

        // ─────────────────────────── LIST ────────────────────────────────
        case 'list': {
          const reports = await store.listBySession(sessionId, input.limit);

          if (reports.length === 0) {
            return [
              '## Handoff History',
              '',
              `No handoff reports found for session \`${sessionId}\`.`,
            ].join('\n');
          }

          const lines: string[] = [
            '## Handoff History',
            '',
            `**Session:** \`${sessionId}\` | **Showing:** ${reports.length} report(s)`,
            '',
            '| # | Timestamp | Agent | Intent | Confidence | First Action |',
            '|---|-----------|-------|--------|------------|--------------|',
          ];

          for (let i = 0; i < reports.length; i++) {
            const r = reports[i];
            const ts = formatTimestamp(r.timestamp).substring(0, 19);
            const intent = r.intent.length > 40 ? r.intent.substring(0, 37) + '...' : r.intent;
            const firstAction =
              r.firstAction.length > 35 ? r.firstAction.substring(0, 32) + '...' : r.firstAction;
            const conf = formatConfidence(r.confidence);

            lines.push(
              `| ${i + 1} | ${ts} | ${r.agentId} | ${intent} | ${conf} | ${firstAction} |`
            );
          }

          lines.push('');
          lines.push('*Use `action: "get"` with a specific `handoffId` for the full briefing.*');

          // Append IDs for reference
          lines.push('', '### Handoff IDs');
          for (const r of reports) {
            const intentPreview = r.intent.substring(0, 60);
            lines.push(`- \`${r.id}\` -- ${intentPreview}`);
          }

          return lines.join('\n');
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
