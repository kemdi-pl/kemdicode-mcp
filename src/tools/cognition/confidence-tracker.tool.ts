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

const schema = z.object({
  action: z
    .enum(['record', 'get', 'list', 'update-outcome', 'review-queue', 'profile'])
    .describe('Action'),
  sessionId: z.string().describe('Session ID'),
  agentId: z.string().default('default-agent').describe('Agent ID'),
  // record
  toolName: z.string().optional().describe('Tool/action being assessed (action=record)'),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe('Confidence 0-1 (action=record)'),
  domain: z.string().optional().describe('Domain area (action=record)'),
  reasoning: z.string().optional().describe('Why this confidence level (action=record)'),
  // get / update-outcome
  recordId: z.string().optional().describe('Record ID (action=get, update-outcome)'),
  outcome: z
    .enum(['correct', 'incorrect', 'partial'])
    .optional()
    .describe('Outcome (action=update-outcome)'),
  // list / review-queue
  limit: z.number().default(10).describe('Max results'),
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

export const confidenceTrackerTool: UnifiedTool<typeof schema> = {
  name: 'confidence-tracker',
  description:
    'Track AI confidence levels, flag low-confidence actions for human review, build calibration profiles.',
  zodSchema: schema,
  metadata: {
    category: 'cognition',
    tags: ['confidence', 'self-awareness', 'calibration'],
  },

  execute: async (args) => {
    const store = getConfidenceStore();
    const { action } = args;

    // ── record ──────────────────────────────────────────────────────────────
    if (action === 'record') {
      if (args.confidence === undefined) {
        return 'Error: confidence is required for action=record';
      }
      if (!args.toolName) {
        return 'Error: toolName is required for action=record';
      }

      const record = await store.record({
        sessionId: args.sessionId,
        agentId: args.agentId,
        toolName: args.toolName,
        confidence: args.confidence,
        domain: args.domain || 'general',
        reasoning: args.reasoning,
      });

      if (!record) {
        return 'Error: Failed to record confidence assessment (Redis unavailable)';
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
        return 'Error: recordId is required for action=get';
      }

      const record = await store.get(args.recordId);
      if (!record) {
        return `Error: Record not found: ${args.recordId}`;
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
      const records = await store.listBySession(args.sessionId, args.limit);

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
      if (!args.recordId) {
        return 'Error: recordId is required for action=update-outcome';
      }
      if (!args.outcome) {
        return 'Error: outcome is required for action=update-outcome';
      }

      const success = await store.updateOutcome(args.recordId, args.outcome);
      if (!success) {
        return `Error: Failed to update outcome for ${args.recordId}. Record may not exist.`;
      }

      return `Outcome updated: ${args.recordId} -> ${args.outcome}`;
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

    return `Error: Unknown action "${action}". Valid actions: record, get, list, update-outcome, review-queue, profile`;
  },
};
