/**
 * KemdiCode MCP Server
 * Copyright (C) 2025-2026 Kemdi Sp. z o.o.
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
 * Self-Critique Tool
 *
 * Post-session reflection — the AI reviews its own process.
 * Records what went well, what went poorly, extracts lessons,
 * and tracks efficiency trends across sessions.
 *
 * @module tools/cognition/self-critique
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { getSelfCritiqueStore } from '../../cognition/self-critique-store.js';
import { Logger } from '../../utils/logger.js';
import { checkRateLimit } from '../../utils/validation.js';

const schema = z.object({
  action: z.enum(['reflect', 'get', 'list', 'lessons', 'trend']).describe('Action'),
  sessionId: z.string().describe('Session ID'),
  agentId: z.string().default('default-agent').describe('Agent ID'),
  // reflect
  scope: z.enum(['session', 'task', 'decision']).optional().describe('What is being critiqued (action=reflect)'),
  targetId: z.string().optional().describe('ID of session/task/decision being reviewed (action=reflect)'),
  wentWell: z.array(z.string()).optional().describe('What went well (action=reflect)'),
  wentPoorly: z.array(z.string()).optional().describe('What went poorly (action=reflect)'),
  wouldChange: z.array(z.string()).optional().describe('What would be done differently (action=reflect)'),
  lessonsLearned: z.array(z.string()).optional().describe('Extracted lessons (action=reflect)'),
  efficiency: z.number().min(0).max(1).optional().describe('Self-assessed efficiency 0-1 (action=reflect)'),
  // get
  critiqueId: z.string().optional().describe('Critique ID (action=get)'),
  // list/lessons
  limit: z.number().default(10).describe('Max results'),
});

type SelfCritiqueArgs = z.infer<typeof schema>;

/**
 * Format a timestamp as a human-readable date string
 */
function formatTimestamp(ts: number): string {
  return new Date(ts).toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');
}

/**
 * Format efficiency as a percentage with a visual bar
 */
function formatEfficiency(efficiency: number): string {
  const pct = Math.round(efficiency * 100);
  const filled = Math.round(efficiency * 20);
  const empty = 20 - filled;
  const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(empty);
  return `${bar} ${pct}%`;
}

/**
 * Format a full critique for display with box-drawing characters
 */
function formatCritiqueDisplay(critique: {
  id: string;
  sessionId: string;
  agentId: string;
  timestamp: number;
  scope: string;
  targetId?: string;
  wentWell: string[];
  wentPoorly: string[];
  wouldChange: string[];
  lessonsLearned: string[];
  efficiency: number;
}): string {
  const lines: string[] = [];
  const w = 72;
  const hr = '\u2500'.repeat(w);

  lines.push(`\u250C${hr}\u2510`);
  lines.push(`\u2502 ${'SELF-CRITIQUE'.padEnd(w - 1)}\u2502`);
  lines.push(`\u251C${hr}\u2524`);
  lines.push(`\u2502 ${'ID:'.padEnd(14)}${critique.id.substring(0, w - 15).padEnd(w - 15)}\u2502`);
  lines.push(`\u2502 ${'Session:'.padEnd(14)}${critique.sessionId.substring(0, w - 15).padEnd(w - 15)}\u2502`);
  lines.push(`\u2502 ${'Agent:'.padEnd(14)}${critique.agentId.substring(0, w - 15).padEnd(w - 15)}\u2502`);
  lines.push(`\u2502 ${'Scope:'.padEnd(14)}${critique.scope.toUpperCase().padEnd(w - 15)}\u2502`);
  if (critique.targetId) {
    lines.push(`\u2502 ${'Target:'.padEnd(14)}${critique.targetId.substring(0, w - 15).padEnd(w - 15)}\u2502`);
  }
  lines.push(`\u2502 ${'Time:'.padEnd(14)}${formatTimestamp(critique.timestamp).padEnd(w - 15)}\u2502`);
  lines.push(`\u2502 ${'Efficiency:'.padEnd(14)}${formatEfficiency(critique.efficiency).padEnd(w - 15)}\u2502`);

  // What went well
  if (critique.wentWell.length > 0) {
    lines.push(`\u251C${hr}\u2524`);
    lines.push(`\u2502 ${'WENT WELL'.padEnd(w - 1)}\u2502`);
    for (const item of critique.wentWell) {
      const wrapped = wrapText(`  + ${item}`, w - 3);
      for (const line of wrapped) {
        lines.push(`\u2502 ${line.padEnd(w - 1)}\u2502`);
      }
    }
  }

  // What went poorly
  if (critique.wentPoorly.length > 0) {
    lines.push(`\u251C${hr}\u2524`);
    lines.push(`\u2502 ${'WENT POORLY'.padEnd(w - 1)}\u2502`);
    for (const item of critique.wentPoorly) {
      const wrapped = wrapText(`  - ${item}`, w - 3);
      for (const line of wrapped) {
        lines.push(`\u2502 ${line.padEnd(w - 1)}\u2502`);
      }
    }
  }

  // Would change
  if (critique.wouldChange.length > 0) {
    lines.push(`\u251C${hr}\u2524`);
    lines.push(`\u2502 ${'WOULD CHANGE'.padEnd(w - 1)}\u2502`);
    for (const item of critique.wouldChange) {
      const wrapped = wrapText(`  ~ ${item}`, w - 3);
      for (const line of wrapped) {
        lines.push(`\u2502 ${line.padEnd(w - 1)}\u2502`);
      }
    }
  }

  // Lessons learned
  if (critique.lessonsLearned.length > 0) {
    lines.push(`\u251C${hr}\u2524`);
    lines.push(`\u2502 ${'LESSONS LEARNED'.padEnd(w - 1)}\u2502`);
    for (let i = 0; i < critique.lessonsLearned.length; i++) {
      const wrapped = wrapText(`  ${i + 1}. ${critique.lessonsLearned[i]}`, w - 3);
      for (const line of wrapped) {
        lines.push(`\u2502 ${line.padEnd(w - 1)}\u2502`);
      }
    }
  }

  lines.push(`\u2514${hr}\u2518`);

  return lines.join('\n');
}

/**
 * Wrap text to a maximum line width
 */
function wrapText(text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let currentLine = '';

  for (const word of words) {
    if (currentLine.length + word.length + 1 > maxWidth) {
      if (currentLine) lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = currentLine ? `${currentLine} ${word}` : word;
    }
  }
  if (currentLine) lines.push(currentLine);

  return lines.length > 0 ? lines : [''];
}

export const selfCritiqueTool: UnifiedTool<typeof schema> = {
  name: 'self-critique',
  description:
    'Post-session reflection \u2014 review what went well, what went poorly, and extract lessons for future sessions.',
  zodSchema: schema,

  metadata: {
    category: 'cognition',
    tags: ['reflection', 'learning', 'process-improvement'],
    examples: [
      {
        args: {
          action: 'reflect',
          sessionId: 'session-123',
          agentId: 'backend-dev',
          scope: 'session',
          wentWell: [
            'Identified the root cause quickly using git-blame',
            'Good test coverage for the fix',
          ],
          wentPoorly: [
            'Spent 15 minutes on a wrong hypothesis about CORS',
            'Did not check existing tests before writing new ones',
          ],
          wouldChange: [
            'Run existing tests first before investigating',
            'Check error logs before forming hypotheses',
          ],
          lessonsLearned: [
            'Always run existing tests before writing new ones',
            'Check server logs before debugging client-side',
          ],
          efficiency: 0.7,
        },
        description: 'Record a post-session reflection',
      },
      {
        args: {
          action: 'lessons',
          sessionId: 'any',
          limit: 10,
        },
        description: 'Get aggregated lessons learned across all sessions',
      },
      {
        args: {
          action: 'trend',
          sessionId: 'session-123',
        },
        description: 'View efficiency trend for a session',
      },
    ],
    relatedTools: ['thinking-chain', 'decision-journal', 'write-memory', 'feedback'],
  },

  execute: async (args): Promise<string> => {
    const input = args as unknown as SelfCritiqueArgs;

    if (!checkRateLimit('self-critique', { maxRequests: 60, windowMs: 60000 })) {
      return JSON.stringify({
        success: false,
        error: 'Rate limit exceeded for self-critique operations',
        code: 'RATE_LIMIT_EXCEEDED',
      });
    }

    const store = getSelfCritiqueStore();

    try {
      switch (input.action) {
        // ───────────────────────────────────────────────────────── reflect
        case 'reflect': {
          // Validate required fields for reflect
          if (!input.scope) {
            return JSON.stringify({
              success: false,
              error: 'Field "scope" is required for action=reflect',
              code: 'MISSING_FIELD',
            });
          }

          const wentWell = input.wentWell || [];
          const wentPoorly = input.wentPoorly || [];

          if (wentWell.length === 0 && wentPoorly.length === 0) {
            return JSON.stringify({
              success: false,
              error: 'At least one item in "wentWell" or "wentPoorly" is required for action=reflect',
              code: 'MISSING_FIELD',
            });
          }

          const efficiency = input.efficiency !== undefined ? input.efficiency : 0.5;

          const critique = await store.record({
            sessionId: input.sessionId,
            agentId: input.agentId,
            scope: input.scope,
            targetId: input.targetId,
            wentWell,
            wentPoorly,
            wouldChange: input.wouldChange || [],
            lessonsLearned: input.lessonsLearned || [],
            efficiency,
          });

          if (!critique) {
            return JSON.stringify({
              success: false,
              error: 'Failed to record critique (Redis unavailable)',
              code: 'STORAGE_ERROR',
            });
          }

          Logger.debug(`self-critique: recorded ${critique.id} for session ${input.sessionId}`);

          return formatCritiqueDisplay(critique);
        }

        // ───────────────────────────────────────────────────────── get
        case 'get': {
          if (!input.critiqueId) {
            return JSON.stringify({
              success: false,
              error: 'Field "critiqueId" is required for action=get',
              code: 'MISSING_FIELD',
            });
          }

          const critique = await store.get(input.critiqueId);
          if (!critique) {
            return JSON.stringify({
              success: false,
              error: `Critique not found: ${input.critiqueId}`,
              code: 'NOT_FOUND',
            });
          }

          return formatCritiqueDisplay(critique);
        }

        // ───────────────────────────────────────────────────────── list
        case 'list': {
          const limit = input.limit || 10;

          // If a scope filter is provided, list by scope; otherwise by session
          let critiques;
          if (input.scope) {
            critiques = await store.listByScope(input.scope, limit);
          } else {
            critiques = await store.listBySession(input.sessionId, limit);
          }

          if (critiques.length === 0) {
            return JSON.stringify({
              success: true,
              count: 0,
              critiques: [],
              message: 'No critiques found.',
            });
          }

          const lines: string[] = [];
          const w = 72;
          const hr = '\u2500'.repeat(w);

          lines.push(`\u250C${hr}\u2510`);
          lines.push(`\u2502 ${`SELF-CRITIQUES (${critiques.length})`.padEnd(w - 1)}\u2502`);
          lines.push(`\u251C${hr}\u2524`);

          for (let i = 0; i < critiques.length; i++) {
            const c = critiques[i];
            const effPct = Math.round(c.efficiency * 100);
            const topLesson = c.lessonsLearned.length > 0
              ? c.lessonsLearned[0].substring(0, w - 20)
              : '(no lessons)';

            lines.push(`\u2502 ${`#${i + 1} [${c.scope.toUpperCase()}] ${formatTimestamp(c.timestamp)}`.padEnd(w - 1)}\u2502`);
            lines.push(`\u2502 ${'  ID:'.padEnd(14)}${c.id.substring(0, w - 15).padEnd(w - 15)}\u2502`);
            lines.push(`\u2502 ${'  Efficiency:'.padEnd(14)}${`${effPct}%`.padEnd(w - 15)}\u2502`);
            lines.push(`\u2502 ${'  Well:'.padEnd(14)}${`${c.wentWell.length} item(s)`.padEnd(w - 15)}\u2502`);
            lines.push(`\u2502 ${'  Poorly:'.padEnd(14)}${`${c.wentPoorly.length} item(s)`.padEnd(w - 15)}\u2502`);
            lines.push(`\u2502 ${'  Lesson:'.padEnd(14)}${topLesson.padEnd(w - 15)}\u2502`);

            if (i < critiques.length - 1) {
              lines.push(`\u251C${hr}\u2524`);
            }
          }

          lines.push(`\u2514${hr}\u2518`);

          return lines.join('\n');
        }

        // ───────────────────────────────────────────────────────── lessons
        case 'lessons': {
          const limit = input.limit || 20;
          const lessons = await store.getLessonsLearned(limit);

          if (lessons.length === 0) {
            return JSON.stringify({
              success: true,
              count: 0,
              lessons: [],
              message: 'No lessons learned yet. Use action=reflect to record critiques first.',
            });
          }

          const lines: string[] = [];
          const w = 72;
          const hr = '\u2500'.repeat(w);

          lines.push(`\u250C${hr}\u2510`);
          lines.push(`\u2502 ${`LESSONS LEARNED (${lessons.length})`.padEnd(w - 1)}\u2502`);
          lines.push(`\u2502 ${'Aggregated across all sessions and agents'.padEnd(w - 1)}\u2502`);
          lines.push(`\u251C${hr}\u2524`);

          for (let i = 0; i < lessons.length; i++) {
            const wrapped = wrapText(`  ${i + 1}. ${lessons[i]}`, w - 3);
            for (const line of wrapped) {
              lines.push(`\u2502 ${line.padEnd(w - 1)}\u2502`);
            }
          }

          lines.push(`\u2514${hr}\u2518`);

          return lines.join('\n');
        }

        // ───────────────────────────────────────────────────────── trend
        case 'trend': {
          const trend = await store.getEfficiencyTrend(input.sessionId);

          if (trend.length === 0) {
            return JSON.stringify({
              success: true,
              count: 0,
              trend: [],
              message: `No efficiency data for session ${input.sessionId}.`,
            });
          }

          // Calculate summary statistics
          const efficiencies = trend.map(t => t.efficiency);
          const avg = efficiencies.reduce((sum, e) => sum + e, 0) / efficiencies.length;
          const min = Math.min(...efficiencies);
          const max = Math.max(...efficiencies);
          const latest = efficiencies[efficiencies.length - 1];
          const first = efficiencies[0];
          const delta = latest - first;

          const lines: string[] = [];
          const w = 72;
          const hr = '\u2500'.repeat(w);

          lines.push(`\u250C${hr}\u2510`);
          lines.push(`\u2502 ${`EFFICIENCY TREND (${trend.length} data points)`.padEnd(w - 1)}\u2502`);
          lines.push(`\u2502 ${`Session: ${input.sessionId}`.substring(0, w - 1).padEnd(w - 1)}\u2502`);
          lines.push(`\u251C${hr}\u2524`);

          // Summary
          lines.push(`\u2502 ${'Average:'.padEnd(14)}${formatEfficiency(avg).padEnd(w - 15)}\u2502`);
          lines.push(`\u2502 ${'Min:'.padEnd(14)}${formatEfficiency(min).padEnd(w - 15)}\u2502`);
          lines.push(`\u2502 ${'Max:'.padEnd(14)}${formatEfficiency(max).padEnd(w - 15)}\u2502`);
          lines.push(`\u2502 ${'Latest:'.padEnd(14)}${formatEfficiency(latest).padEnd(w - 15)}\u2502`);

          const deltaStr = delta >= 0 ? `+${Math.round(delta * 100)}%` : `${Math.round(delta * 100)}%`;
          const trendDirection = delta > 0.05 ? 'IMPROVING' : delta < -0.05 ? 'DECLINING' : 'STABLE';
          lines.push(`\u2502 ${'Change:'.padEnd(14)}${`${deltaStr} (${trendDirection})`.padEnd(w - 15)}\u2502`);

          lines.push(`\u251C${hr}\u2524`);
          lines.push(`\u2502 ${'TIMELINE'.padEnd(w - 1)}\u2502`);

          // Timeline entries
          for (const entry of trend) {
            const time = formatTimestamp(entry.timestamp);
            const pct = Math.round(entry.efficiency * 100);
            const barLen = Math.round(entry.efficiency * 30);
            const bar = '\u2588'.repeat(barLen) + '\u2591'.repeat(30 - barLen);
            const line = `  ${time}  [${entry.scope.padEnd(8)}] ${bar} ${pct}%`;
            lines.push(`\u2502 ${line.substring(0, w - 1).padEnd(w - 1)}\u2502`);
          }

          lines.push(`\u2514${hr}\u2518`);

          return lines.join('\n');
        }

        default:
          return JSON.stringify({
            success: false,
            error: `Unknown action: ${(input as { action: string }).action}`,
            code: 'INVALID_ACTION',
          });
      }
    } catch (error) {
      Logger.error('[self-critique] Execution error:', error);
      return JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : String(error),
        code: 'EXECUTION_ERROR',
      });
    }
  },
};
