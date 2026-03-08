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
 * Confidence Tracker Tool
 *
 * Track AI self-assessed confidence levels, flag low-confidence actions
 * for human review, and build calibration profiles per agent.
 *
 * Actions:
 *   record         - Record a confidence assessment
 *   get            - Retrieve a single record by ID
 *   list           - List records for a session
 *   update-outcome - Annotate a record with the actual outcome
 *   review-queue   - Get low-confidence items pending review
 *   profile        - Compute calibration profile for an agent
 *
 * @module tools/cognition/confidence-tracker
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { getConfidenceStore } from '../../cognition/confidence-store.js';
import { resolveSessionId } from '../../kanban/resolvers.js';

const schema = z.object({
  action: z
    .enum(['record', 'get', 'list', 'update-outcome', 'review-queue', 'profile'])
    .describe('Action to perform: record (save assessment), get (retrieve by ID), list (browse session), update-outcome (annotate result), review-queue (low-confidence items), profile (calibration analysis)'),
  sessionId: z.string().optional().describe('Session ID (auto-detected from active session if omitted)'),
  agentId: z.string().min(1).optional().default('default-agent').describe('Agent ID'),
  // record
  toolName: z.string().min(1).max(100).optional().describe('Tool/action being assessed (required for action=record)'),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe('Confidence level 0-1, where <0.5 triggers automatic flagging for human review (required for action=record)'),
  domain: z.string().min(1).max(50).optional().describe('Domain area for calibration grouping (action=record)'),
  reasoning: z.string().max(1000).optional().describe('Why this confidence level - helps calibration analysis (action=record)'),
  // get / update-outcome
  recordId: z.string().min(1).optional().describe('Record ID (required for action=get, update-outcome)'),
  outcome: z
    .enum(['correct', 'incorrect', 'partial'])
    .optional()
    .describe('Actual outcome - enables calibration scoring (required for action=update-outcome)'),
  // list / review-queue
  limit: z.number().min(1).max(100).optional().default(10).describe('Max results (1-100)'),
});

/**
 * Format a confidence value as a percentage string
 */
function fmtConf(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/**
 * Return a text-based confidence level label
 */
function confidenceLabel(value: number): string {
  if (value >= 0.9) return 'VERY HIGH';
  if (value >= 0.7) return 'HIGH';
  if (value >= 0.5) return 'MODERATE';
  if (value >= 0.3) return 'LOW';
  return 'VERY LOW';
}

/**
 * Helper to format structured error response for AI clarity
 */
function formatError(
  error: string,
  code: string,
  action: string,
  missingFields?: string[]
): string {
  return JSON.stringify({
    success: false,
    error,
    code,
    action,
    ...(missingFields && { missingFields }),
  });
}

export const confidenceTrackerTool: UnifiedTool<typeof schema> = {
  name: 'confidence-tracker',
  description:
    'Track AI confidence levels and flag low-confidence actions for human review. Confidence <0.5 auto-flags. ' +
    'USE PROACTIVELY: record confidence BEFORE executing risky actions (file writes, refactors, deployments). ' +
    'Check calibration periodically to improve self-assessment accuracy.',
  zodSchema: schema,
  metadata: {
    category: 'cognition',
    tags: ['confidence', 'self-awareness', 'calibration'],
    examples: [
      {
        args: {
          action: 'record',
          sessionId: 'session-123',
          agentId: 'claude-opus',
          toolName: 'file-write',
          confidence: 0.85,
          domain: 'file-operations',
          reasoning: 'Simple file creation with known path and content',
        },
        description: 'Record high confidence assessment for a file operation',
      },
      {
        args: {
          action: 'record',
          sessionId: 'session-123',
          agentId: 'claude-opus',
          toolName: 'refactor',
          confidence: 0.35,
          domain: 'code-modification',
          reasoning: 'Complex legacy code with unclear side effects',
        },
        description: 'Record low confidence - will be auto-flagged for human review',
      },
      {
        args: {
          action: 'update-outcome',
          sessionId: 'session-123',
          recordId: 'conf-abc123',
          outcome: 'correct',
        },
        description: 'Annotate a confidence record with actual outcome for calibration',
      },
      {
        args: {
          action: 'review-queue',
          sessionId: 'session-123',
          limit: 5,
        },
        description: 'Get low-confidence items pending human review',
      },
      {
        args: {
          action: 'profile',
          sessionId: 'session-123',
          agentId: 'claude-opus',
        },
        description: 'Compute calibration profile - shows if confidence matches actual outcomes',
      },
      {
        args: {
          action: 'list',
          sessionId: 'session-123',
          limit: 20,
        },
        description: 'List all confidence records for a session',
      },
    ],
    relatedTools: ['decision-journal', 'self-critique', 'intent-tracker'],
  },

  execute: async (args) => {
    const store = getConfidenceStore();
    const { action } = args;
    const sessionId = resolveSessionId(args.sessionId);

    // ── record ──────────────────────────────────────────────────────────────
    if (action === 'record') {
      const missing: string[] = [];
      if (args.confidence === undefined) missing.push('confidence');
      if (!args.toolName) missing.push('toolName');

      if (missing.length > 0) {
        return formatError(
          `Missing required fields for record: ${missing.join(', ')}`,
          'VALIDATION_ERROR',
          action,
          missing
        );
      }

      const record = await store.record({
        sessionId,
        agentId: args.agentId,
        toolName: args.toolName!,
        confidence: args.confidence!,
        domain: args.domain || 'general',
        reasoning: args.reasoning,
      });

      if (!record) {
        return formatError(
          'Failed to record confidence assessment',
          'REDIS_UNAVAILABLE',
          action
        );
      }

      const lines: string[] = [
        '# Confidence Recorded',
        '',
        `- **ID:** ${record.id}`,
        `- **Tool:** ${record.toolName}`,
        `- **Confidence:** ${fmtConf(record.confidence)} (${confidenceLabel(record.confidence)})`,
        `- **Domain:** ${record.domain}`,
      ];

      if (record.reasoning) {
        lines.push(`- **Reasoning:** ${record.reasoning}`);
      }

      if (record.flaggedForReview) {
        lines.push('', '[FLAGGED FOR REVIEW] Confidence below 50% threshold.');
        lines.push('This action has been added to the human review queue.');
      }

      return lines.join('\n');
    }

    // ── get ──────────────────────────────────────────────────────────────────
    if (action === 'get') {
      if (!args.recordId) {
        return formatError(
          'recordId is required for action=get',
          'VALIDATION_ERROR',
          action,
          ['recordId']
        );
      }

      const record = await store.get(args.recordId);
      if (!record) {
        return formatError(
          `Record not found: ${args.recordId}`,
          'NOT_FOUND',
          action
        );
      }

      const lines: string[] = [
        '# Confidence Record',
        '',
        `- **ID:** ${record.id}`,
        `- **Session:** ${record.sessionId}`,
        `- **Agent:** ${record.agentId}`,
        `- **Tool:** ${record.toolName}`,
        `- **Confidence:** ${fmtConf(record.confidence)} (${confidenceLabel(record.confidence)})`,
        `- **Domain:** ${record.domain}`,
        `- **Timestamp:** ${new Date(record.timestamp).toISOString()}`,
        `- **Flagged:** ${record.flaggedForReview ? 'Yes' : 'No'}`,
      ];

      if (record.reasoning) {
        lines.push(`- **Reasoning:** ${record.reasoning}`);
      }

      if (record.outcome) {
        lines.push(`- **Outcome:** ${record.outcome}`);
      }

      return lines.join('\n');
    }

    // ── list ─────────────────────────────────────────────────────────────────
    if (action === 'list') {
      const records = await store.listBySession(sessionId, args.limit);

      if (!records.length) {
        return 'No confidence records found for this session.';
      }

      const lines: string[] = [
        `# Confidence Records (${records.length})`,
        '',
        '| ID | Tool | Confidence | Domain | Flagged | Outcome |',
        '|---|---|---|---|---|---|',
      ];

      for (const r of records) {
        const flagMarker = r.flaggedForReview ? '[!]' : '';
        lines.push(
          `| ${r.id} | ${r.toolName} | ${fmtConf(r.confidence)} | ${r.domain} | ${flagMarker} | ${r.outcome || '-'} |`
        );
      }

      return lines.join('\n');
    }

    // ── update-outcome ───────────────────────────────────────────────────────
    if (action === 'update-outcome') {
      const missing: string[] = [];
      if (!args.recordId) missing.push('recordId');
      if (!args.outcome) missing.push('outcome');

      if (missing.length > 0) {
        return formatError(
          `Missing required fields for update-outcome: ${missing.join(', ')}`,
          'VALIDATION_ERROR',
          action,
          missing
        );
      }

      const success = await store.updateOutcome(args.recordId!, args.outcome!);
      if (!success) {
        return formatError(
          `Failed to update outcome for ${args.recordId}. Record may not exist.`,
          'UPDATE_FAILED',
          action
        );
      }

      return JSON.stringify({
        success: true,
        recordId: args.recordId,
        outcome: args.outcome,
        message: `Outcome updated: ${args.recordId} -> ${args.outcome}`,
      });
    }

    // ── review-queue ─────────────────────────────────────────────────────────
    if (action === 'review-queue') {
      const records = await store.getReviewQueue(args.limit);

      if (!records.length) {
        return 'Review queue is empty. No low-confidence actions pending review.';
      }

      const lines: string[] = [
        `# Review Queue (${records.length} items)`,
        '',
        'These actions were flagged because confidence was below 50%.',
        '',
      ];

      for (const r of records) {
        lines.push(`### ${r.id}`);
        lines.push(`- **Tool:** ${r.toolName}`);
        lines.push(`- **Confidence:** ${fmtConf(r.confidence)} (${confidenceLabel(r.confidence)})`);
        lines.push(`- **Domain:** ${r.domain}`);
        lines.push(`- **Agent:** ${r.agentId}`);
        lines.push(`- **Time:** ${new Date(r.timestamp).toISOString()}`);
        if (r.reasoning) {
          lines.push(`- **Reasoning:** ${r.reasoning}`);
        }
        if (r.outcome) {
          lines.push(`- **Outcome:** ${r.outcome}`);
        }
        lines.push('');
      }

      return lines.join('\n');
    }

    // ── profile ──────────────────────────────────────────────────────────────
    if (action === 'profile') {
      const profile = await store.getProfile(args.agentId);

      if (profile.totalRecords === 0) {
        return `No confidence records found for agent "${args.agentId}".`;
      }

      const lines: string[] = [
        `# Confidence Profile: ${profile.agentId}`,
        '',
        `- **Total Records:** ${profile.totalRecords}`,
        `- **Calibration Score:** ${fmtConf(profile.calibration)}`,
        `- **Low Confidence Rate:** ${fmtConf(profile.lowConfidenceRate)}`,
        '',
        '## Domain Breakdown',
        '',
        '| Domain | Avg Confidence | Records | Correct Rate |',
        '|---|---|---|---|',
      ];

      const sortedDomains = Object.entries(profile.domainScores).sort(
        ([, a], [, b]) => b.count - a.count
      );

      for (const [domain, scores] of sortedDomains) {
        lines.push(
          `| ${domain} | ${fmtConf(scores.avg)} | ${scores.count} | ${fmtConf(scores.correctRate)} |`
        );
      }

      // ── Calibration interpretation ──
      lines.push('');
      lines.push('## Calibration Analysis');
      lines.push('');

      if (profile.calibration >= 0.9) {
        lines.push(
          'Excellent calibration. Confidence levels closely match actual outcomes.'
        );
      } else if (profile.calibration >= 0.7) {
        lines.push(
          'Good calibration. Confidence predictions are reasonably accurate.'
        );
      } else if (profile.calibration >= 0.5) {
        lines.push(
          'Moderate calibration. There is noticeable divergence between stated confidence and actual outcomes.'
        );
        lines.push(
          'Recommendation: Review high-confidence failures and low-confidence successes to improve self-assessment.'
        );
      } else {
        lines.push(
          '[ATTENTION] Poor calibration. Stated confidence does not reliably predict outcomes.'
        );
        lines.push(
          'Recommendation: Re-evaluate confidence assignment criteria. Consider using narrower confidence ranges.'
        );
      }

      // ── Low confidence analysis ──
      if (profile.lowConfidenceRate > 0.3) {
        lines.push('');
        lines.push(
          `[ATTENTION] High low-confidence rate (${fmtConf(profile.lowConfidenceRate)}). ` +
            'Over 30% of actions are assessed with low certainty.'
        );
        lines.push(
          'Recommendation: Identify recurring low-confidence domains and consider additional training or tool improvements.'
        );
      }

      // ── Domain-specific warnings ──
      const weakDomains = sortedDomains.filter(
        ([, scores]) => scores.avg < 0.5 && scores.count >= 3
      );
      if (weakDomains.length > 0) {
        lines.push('');
        lines.push('## Weak Domains');
        lines.push('');
        lines.push(
          'The following domains consistently show low confidence (avg < 50%, 3+ records):'
        );
        for (const [domain, scores] of weakDomains) {
          lines.push(
            `- **${domain}**: avg ${fmtConf(scores.avg)} across ${scores.count} records`
          );
        }
      }

      return lines.join('\n');
    }

    return formatError(
      `Unknown action "${action}"`,
      'INVALID_ACTION',
      action
    );
  },
};
