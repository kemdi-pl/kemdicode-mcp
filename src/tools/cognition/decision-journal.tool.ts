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
 * Decision Journal Tool
 *
 * Records and queries AI decision reasoning -- the WHY behind choices,
 * not just the WHAT. Supports recording, retrieval, listing, outcome
 * tracking, and keyword search.
 *
 * @module tools/cognition/decision-journal
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { getDecisionStore } from '../../cognition/decision-store.js';
import { Logger } from '../../utils/logger.js';
import { executeCognitionTool } from './cognition-shared.js';
import { resolveSessionId } from '../../kanban/resolvers.js';

const schema = z.object({
  action: z
    .enum(['record', 'get', 'list', 'update-outcome', 'search'])
    .describe('Action to perform'),
  sessionId: z.string().optional().describe('Session ID (auto-detected from active session if omitted)'),
  agentId: z.string().optional().default('default-agent').describe('Agent ID'),

  // For record
  question: z.string().optional().describe('What decision is being made? (action=record)'),
  chosen: z.string().optional().describe('What was chosen? (action=record)'),
  alternatives: z.array(z.string()).optional().describe('Alternatives considered (action=record)'),
  reasoning: z.string().optional().describe('Why this choice? (action=record)'),
  confidence: z.number().min(0).max(1).optional().describe('Confidence 0-1 (action=record)'),
  context: z.string().optional().describe('Decision context (action=record)'),
  tags: z.array(z.string()).optional().describe('Tags (action=record)'),
  relatedFiles: z.array(z.string()).optional().describe('Related files (action=record)'),

  // For get / update-outcome
  decisionId: z.string().optional().describe('Decision ID (action=get, update-outcome)'),
  outcome: z.string().optional().describe('What happened (action=update-outcome)'),

  // For list
  limit: z.number().optional().default(10).describe('Max results (action=list, search)'),

  // For search
  query: z.string().optional().describe('Search query (action=search)'),
});

type DecisionJournalArgs = z.infer<typeof schema>;

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

export const decisionJournalTool: UnifiedTool<typeof schema> = {
  name: 'decision-journal',
  description:
    'Record and query AI decision reasoning — the WHY behind choices, not just the WHAT. ' +
    'USE PROACTIVELY: record decisions when choosing between architectures, libraries, or approaches. ' +
    'Search past decisions before making similar choices. Record outcomes to build a learning feedback loop.',
  zodSchema: schema,

  metadata: {
    category: 'cognition' as never, // cognition category — typed via ToolCategory union
    tags: ['decision', 'reasoning', 'journal'],
    examples: [
      {
        args: {
          action: 'record',
          sessionId: 'session-abc',
          agentId: 'backend-dev',
          question: 'Which database to use for the user service?',
          chosen: 'PostgreSQL',
          alternatives: ['MongoDB', 'MySQL', 'SQLite'],
          reasoning:
            'PostgreSQL supports JSONB for flexible schema, has strong ACID guarantees, and the team has existing expertise.',
          confidence: 0.85,
          context: 'New microservice for user management with mixed structured/unstructured data',
          tags: ['architecture', 'database'],
          relatedFiles: ['src/services/user-service.ts'],
        },
        description: 'Record a database selection decision with alternatives and reasoning',
      },
      {
        args: {
          action: 'get',
          sessionId: 'session-abc',
          decisionId: 'dec_1234567890_abcd1234',
        },
        description: 'Retrieve a specific decision by ID',
      },
      {
        args: {
          action: 'list',
          sessionId: 'session-abc',
          limit: 5,
        },
        description: 'List the 5 most recent decisions in a session',
      },
      {
        args: {
          action: 'update-outcome',
          sessionId: 'session-abc',
          decisionId: 'dec_1234567890_abcd1234',
          outcome: 'PostgreSQL performed well. JSONB queries are fast. Good choice.',
        },
        description: 'Record the outcome of a previous decision',
      },
      {
        args: {
          action: 'search',
          sessionId: 'session-abc',
          query: 'database',
          limit: 10,
        },
        description: 'Search decisions by keyword',
      },
    ],
    relatedTools: ['confidence-tracker', 'intent-tracker'],
  },

  execute: async (args): Promise<string> => {
    const input = args as unknown as DecisionJournalArgs;

    const sessionId = resolveSessionId(input.sessionId);

    return executeCognitionTool('decision-journal', getDecisionStore, async (store) => {
      switch (input.action) {
        // ─────────────────────────── RECORD ───────────────────────────
        case 'record': {
          const missing: string[] = [];
          if (!input.question) missing.push('question');
          if (!input.chosen) missing.push('chosen');
          if (!input.reasoning) missing.push('reasoning');

          if (missing.length > 0) {
            return JSON.stringify({
              success: false,
              error: `Missing required fields for record: ${missing.join(', ')}`,
              code: 'VALIDATION_ERROR',
              missingFields: missing,
            });
          }

          const decision = await store.record({
            sessionId,
            agentId: input.agentId,
            question: input.question!,
            chosen: input.chosen!,
            alternatives: input.alternatives || [],
            reasoning: input.reasoning!,
            confidence: input.confidence ?? 0.5,
            context: input.context || '',
            tags: input.tags || [],
            relatedFiles: input.relatedFiles,
          });

          if (!decision) {
            return JSON.stringify({
              success: false,
              error: 'Failed to record decision (Redis unavailable)',
              code: 'STORE_ERROR',
            });
          }

          Logger.debug(`decision-journal: recorded ${decision.id}`);

          const lines: string[] = [
            '## Decision Recorded',
            '',
            `**ID:** \`${decision.id}\``,
            `**Timestamp:** ${formatTimestamp(decision.timestamp)}`,
            `**Agent:** ${decision.agentId}`,
            `**Confidence:** ${formatConfidence(decision.confidence)}`,
            '',
            `### Question`,
            decision.question,
            '',
            `### Chosen`,
            decision.chosen,
            '',
          ];

          if (decision.alternatives.length > 0) {
            lines.push('### Alternatives Considered');
            for (const alt of decision.alternatives) {
              lines.push(`- ${alt}`);
            }
            lines.push('');
          }

          lines.push('### Reasoning', decision.reasoning, '');

          if (decision.context) {
            lines.push('### Context', decision.context, '');
          }

          if (decision.tags.length > 0) {
            lines.push(`**Tags:** ${decision.tags.map((t) => `\`${t}\``).join(', ')}`, '');
          }

          if (decision.relatedFiles && decision.relatedFiles.length > 0) {
            lines.push(
              `**Related files:** ${decision.relatedFiles.map((f) => `\`${f}\``).join(', ')}`,
              ''
            );
          }

          return lines.join('\n');
        }

        // ─────────────────────────── GET ──────────────────────────────
        case 'get': {
          if (!input.decisionId) {
            return JSON.stringify({
              success: false,
              error: 'Missing required field: decisionId',
              code: 'VALIDATION_ERROR',
            });
          }

          const decision = await store.get(input.decisionId);
          if (!decision) {
            return JSON.stringify({
              success: false,
              error: `Decision not found: ${input.decisionId}`,
              code: 'NOT_FOUND',
            });
          }

          const lines: string[] = [
            '## Decision Details',
            '',
            `**ID:** \`${decision.id}\``,
            `**Session:** \`${decision.sessionId}\``,
            `**Agent:** ${decision.agentId}`,
            `**Timestamp:** ${formatTimestamp(decision.timestamp)}`,
            `**Confidence:** ${formatConfidence(decision.confidence)}`,
            '',
            '### Question',
            decision.question,
            '',
            '### Chosen',
            decision.chosen,
            '',
          ];

          if (decision.alternatives.length > 0) {
            lines.push('### Alternatives Considered');
            for (const alt of decision.alternatives) {
              lines.push(`- ${alt}`);
            }
            lines.push('');
          }

          lines.push('### Reasoning', decision.reasoning, '');

          if (decision.context) {
            lines.push('### Context', decision.context, '');
          }

          if (decision.outcome) {
            lines.push('### Outcome', decision.outcome, '');
          }

          if (decision.tags.length > 0) {
            lines.push(`**Tags:** ${decision.tags.map((t) => `\`${t}\``).join(', ')}`, '');
          }

          if (decision.relatedFiles && decision.relatedFiles.length > 0) {
            lines.push(
              `**Related files:** ${decision.relatedFiles.map((f) => `\`${f}\``).join(', ')}`,
              ''
            );
          }

          if (decision.graphNodeId) {
            lines.push(`**Graph node:** \`${decision.graphNodeId}\``, '');
          }

          return lines.join('\n');
        }

        // ─────────────────────────── LIST ─────────────────────────────
        case 'list': {
          const decisions = await store.listBySession(sessionId, input.limit);

          if (decisions.length === 0) {
            return [
              '## Decision Journal',
              '',
              `No decisions found for session \`${sessionId}\`.`,
            ].join('\n');
          }

          const lines: string[] = [
            '## Decision Journal',
            '',
            `**Session:** \`${sessionId}\` | **Showing:** ${decisions.length} decision(s)`,
            '',
            '| # | Timestamp | Confidence | Question | Chosen | Tags |',
            '|---|-----------|------------|----------|--------|------|',
          ];

          for (let i = 0; i < decisions.length; i++) {
            const d = decisions[i];
            const ts = formatTimestamp(d.timestamp).substring(0, 19);
            const conf = formatConfidence(d.confidence);
            const question =
              d.question.length > 40 ? d.question.substring(0, 37) + '...' : d.question;
            const chosen = d.chosen.length > 30 ? d.chosen.substring(0, 27) + '...' : d.chosen;
            const tags = d.tags.join(', ');
            lines.push(`| ${i + 1} | ${ts} | ${conf} | ${question} | ${chosen} | ${tags} |`);
          }

          lines.push('');
          lines.push('*Use `action: "get"` with a specific `decisionId` for full details.*');

          // Append the IDs for reference
          lines.push('', '### Decision IDs');
          for (const d of decisions) {
            lines.push(`- \`${d.id}\` - ${d.question.substring(0, 60)}`);
          }

          return lines.join('\n');
        }

        // ─────────────────────── UPDATE-OUTCOME ──────────────────────
        case 'update-outcome': {
          const missing: string[] = [];
          if (!input.decisionId) missing.push('decisionId');
          if (!input.outcome) missing.push('outcome');

          if (missing.length > 0) {
            return JSON.stringify({
              success: false,
              error: `Missing required fields for update-outcome: ${missing.join(', ')}`,
              code: 'VALIDATION_ERROR',
              missingFields: missing,
            });
          }

          const updated = await store.updateOutcome(input.decisionId!, input.outcome!);

          if (!updated) {
            return JSON.stringify({
              success: false,
              error: `Decision not found or update failed: ${input.decisionId}`,
              code: 'NOT_FOUND',
            });
          }

          Logger.debug(`decision-journal: updated outcome for ${input.decisionId}`);

          return [
            '## Outcome Updated',
            '',
            `**Decision:** \`${input.decisionId}\``,
            '',
            '### Outcome',
            input.outcome,
            '',
            '*The decision now has a recorded outcome for future reference and calibration.*',
          ].join('\n');
        }

        // ─────────────────────────── SEARCH ──────────────────────────
        case 'search': {
          if (!input.query) {
            return JSON.stringify({
              success: false,
              error: 'Missing required field for search: query',
              code: 'VALIDATION_ERROR',
            });
          }

          const results = await store.search(input.query, sessionId);

          // Apply limit
          const limited = results.slice(0, input.limit);

          if (limited.length === 0) {
            return [
              '## Decision Search',
              '',
              `No decisions found matching **"${input.query}"** in session \`${sessionId}\`.`,
            ].join('\n');
          }

          const lines: string[] = [
            '## Decision Search Results',
            '',
            `**Query:** "${input.query}" | **Found:** ${limited.length} result(s)${results.length > limited.length ? ` (showing ${limited.length} of ${results.length})` : ''}`,
            '',
          ];

          for (const d of limited) {
            lines.push(
              `### \`${d.id}\``,
              `**${formatTimestamp(d.timestamp)}** | Agent: ${d.agentId} | Confidence: ${formatConfidence(d.confidence)}`,
              '',
              `**Q:** ${d.question}`,
              `**Chosen:** ${d.chosen}`,
              `**Why:** ${d.reasoning}`,
              ''
            );

            if (d.outcome) {
              lines.push(`**Outcome:** ${d.outcome}`, '');
            }

            if (d.tags.length > 0) {
              lines.push(`Tags: ${d.tags.map((t) => `\`${t}\``).join(', ')}`, '');
            }

            lines.push('---', '');
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
