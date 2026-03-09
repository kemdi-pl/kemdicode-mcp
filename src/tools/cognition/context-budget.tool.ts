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
 * Context Budget Tool
 *
 * Metacognition — estimate context usage, prioritize items by relevance
 * to current goal, and suggest what to evict. Helps agents think about
 * what is worth keeping in their working memory.
 *
 * @module tools/cognition/context-budget
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { getContextBudgetManager } from '../../cognition/context-budget-manager.js';
import { Logger } from '../../utils/logger.js';
import { executeCognitionTool } from './cognition-shared.js';
import { resolveSessionId } from '../../kanban/resolvers.js';
import type { ContextBudgetItem, ContextBudgetEstimate } from '../../cognition/types.js';

const schema = z.object({
  action: z
    .enum(['estimate', 'prioritize', 'evict'])
    .describe('Action: estimate (full budget analysis), prioritize (rank by goal relevance), evict (suggest what to drop)'),
  sessionId: z.string().optional().describe('Session ID (auto-detected from active session if omitted)'),
  currentGoal: z
    .string()
    .min(5)
    .max(500)
    .optional()
    .describe('Current goal for relevance scoring (required for prioritize/evict, recommended for estimate, 5-500 chars)'),
  keepTop: z
    .number()
    .min(1)
    .max(100)
    .default(20)
    .describe('Number of top items to keep when action=evict (1-100)'),
});

type ContextBudgetArgs = z.infer<typeof schema>;

/**
 * Format a relevance score as a percentage string.
 */
function formatRelevance(relevance: number): string {
  return `${Math.round(relevance * 100)}%`;
}

/**
 * Format an age in milliseconds as a human-readable duration.
 */
function formatAge(ageMs: number): string {
  const seconds = Math.floor(ageMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

/**
 * Render the full budget estimate as a Markdown report.
 */
function formatEstimate(
  estimate: ContextBudgetEstimate,
  currentGoal?: string
): string {
  const lines: string[] = [
    '## Context Budget Estimate',
    '',
    `**Goal alignment:** ${formatRelevance(estimate.goalAlignment)}`,
    `**Total items:** ${estimate.totalItems} (~${estimate.totalEstimatedTokens} tokens)`,
  ];

  if (currentGoal) {
    lines.push(`**Current goal:** ${currentGoal}`);
  }

  lines.push('');

  // By Category
  const categories = Object.entries(estimate.byCategory);
  if (categories.length > 0) {
    lines.push('### By Category');
    // Sort by token count descending for visibility
    categories.sort((a, b) => b[1].tokens - a[1].tokens);
    for (const [cat, info] of categories) {
      lines.push(`- **${capitalize(cat)}:** ${info.count} items (~${info.tokens} tokens)`);
    }
    lines.push('');
  }

  // Top Priority Items (show up to 10)
  const topItems = estimate.relevanceRanking.slice(0, 10);
  if (topItems.length > 0) {
    lines.push('### Top Priority Items');
    for (let i = 0; i < topItems.length; i++) {
      const item = topItems[i];
      lines.push(
        `${i + 1}. [${item.category}] "${item.summary}" (relevance: ${formatRelevance(item.relevance)}, age: ${formatAge(item.ageMs)}, ~${item.estimatedTokens} tok)`
      );
    }
    lines.push('');
  }

  // Suggested Evictions
  if (estimate.suggestedEvictions.length > 0) {
    lines.push('### Suggested Evictions');
    lines.push(
      `*${estimate.suggestedEvictions.length} item(s) scored low enough for safe eviction:*`
    );
    lines.push('');
    for (const item of estimate.suggestedEvictions) {
      lines.push(
        `- [${item.category}] "${item.summary}" (relevance: ${formatRelevance(item.relevance)}, age: ${formatAge(item.ageMs)})`
      );
    }
    lines.push('');
  } else {
    lines.push('### Suggested Evictions');
    lines.push('*No evictions suggested -- all items appear relevant.*');
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Render a ranked list of items as Markdown.
 */
function formatPrioritized(
  items: ContextBudgetItem[],
  currentGoal: string
): string {
  const lines: string[] = [
    '## Context Priority Ranking',
    '',
    `**Goal:** ${currentGoal}`,
    `**Total items:** ${items.length}`,
    '',
  ];

  if (items.length === 0) {
    lines.push('*No cognition items found for this session.*');
    return lines.join('\n');
  }

  lines.push(
    '| # | Category | Summary | Relevance | Age | Tokens |',
    '|---|----------|---------|-----------|-----|--------|'
  );

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const summary =
      item.summary.length > 40
        ? item.summary.substring(0, 37) + '...'
        : item.summary;
    lines.push(
      `| ${i + 1} | ${item.category} | ${summary} | ${formatRelevance(item.relevance)} | ${formatAge(item.ageMs)} | ~${item.estimatedTokens} |`
    );
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * Render eviction suggestions as Markdown with reasoning.
 */
function formatEvictions(
  evictions: ContextBudgetItem[],
  currentGoal: string,
  keepTop: number
): string {
  const lines: string[] = [
    '## Eviction Suggestions',
    '',
    `**Goal:** ${currentGoal}`,
    `**Keep top:** ${keepTop} items`,
    `**Candidates for eviction:** ${evictions.length}`,
    '',
  ];

  if (evictions.length === 0) {
    lines.push(
      '*No evictions needed -- total items fit within the keep threshold.*'
    );
    return lines.join('\n');
  }

  lines.push('### Items Safe to Evict');
  lines.push('');

  for (const item of evictions) {
    const reasons: string[] = [];

    if (item.relevance < 0.3) {
      reasons.push('low relevance to current goal');
    }
    if (item.ageMs > 3600000) {
      reasons.push(`old (${formatAge(item.ageMs)})`);
    }
    if (item.category === 'confidence') {
      reasons.push('confidence records are low-priority metadata');
    }
    if (item.category === 'error-pattern') {
      reasons.push('error patterns can be re-discovered if needed');
    }

    const reasonStr =
      reasons.length > 0 ? ` -- ${reasons.join('; ')}` : '';

    lines.push(
      `- [${item.category}] "${item.summary}" (relevance: ${formatRelevance(item.relevance)})${reasonStr}`
    );
  }

  lines.push('');
  lines.push(
    '*These items have the lowest relevance to your current goal and can be dropped from context without significant loss.*'
  );

  return lines.join('\n');
}

/**
 * Capitalize the first letter of a string.
 */
function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export const contextBudgetTool: UnifiedTool<typeof schema> = {
  name: 'context-budget',
  description:
    'Metacognition — estimate context window usage, prioritize by relevance to current goal, suggest what to evict. ' +
    'USE PROACTIVELY: check budget when working on large tasks, before loading many files, ' +
    'or when response quality degrades (sign of context overflow).',
  zodSchema: schema,

  metadata: {
    category: 'cognition' as never,
    tags: ['metacognition', 'context', 'efficiency', 'budget'],
    examples: [
      {
        args: {
          action: 'estimate',
          sessionId: 'session-abc',
          currentGoal: 'Deploy new API with JWT authentication',
        },
        description:
          'Get a full context budget breakdown with relevance scoring against the current goal',
      },
      {
        args: {
          action: 'prioritize',
          sessionId: 'session-abc',
          currentGoal: 'Fix the database connection timeout bug',
        },
        description:
          'Rank all cognition items by relevance to the current debugging goal',
      },
      {
        args: {
          action: 'evict',
          sessionId: 'session-abc',
          currentGoal: 'Refactor user service to use dependency injection',
          keepTop: 15,
        },
        description:
          'Suggest which items can be safely evicted, keeping only the top 15',
      },
    ],
    relatedTools: [
      'decision-journal',
      'confidence-tracker',
      'intent-tracker',
      'mental-model',
      'self-critique',
      'smart-handoff',
    ],
  },

  execute: async (args): Promise<string> => {
    const input = args as unknown as ContextBudgetArgs;

    const sessionId = resolveSessionId(input.sessionId);

    return executeCognitionTool('context-budget', getContextBudgetManager, async (manager) => {
      switch (input.action) {
        // ────────────────────────── ESTIMATE ──────────────────────────
        case 'estimate': {
          const estimate = await manager.estimate(
            sessionId,
            input.currentGoal
          );

          if (estimate.totalItems === 0) {
            return [
              '## Context Budget Estimate',
              '',
              `No cognition items found for session \`${sessionId}\`.`,
              '',
              '*Record decisions, intents, and other cognition data first.*',
            ].join('\n');
          }

          Logger.debug(
            `context-budget: estimated ${estimate.totalItems} items (~${estimate.totalEstimatedTokens} tokens) for session ${sessionId}`
          );

          return formatEstimate(estimate, input.currentGoal);
        }

        // ─────────────────────── PRIORITIZE ──────────────────────────
        case 'prioritize': {
          if (!input.currentGoal) {
            return JSON.stringify({
              success: false,
              error:
                'currentGoal is required for the prioritize action',
              code: 'VALIDATION_ERROR',
            });
          }

          const items = await manager.prioritize(
            sessionId,
            input.currentGoal
          );

          if (items.length === 0) {
            return [
              '## Context Priority Ranking',
              '',
              `No cognition items found for session \`${sessionId}\`.`,
            ].join('\n');
          }

          Logger.debug(
            `context-budget: prioritized ${items.length} items for session ${sessionId}`
          );

          return formatPrioritized(items, input.currentGoal);
        }

        // ──────────────────────── EVICT ──────────────────────────────
        case 'evict': {
          if (!input.currentGoal) {
            return JSON.stringify({
              success: false,
              error: 'currentGoal is required for the evict action',
              code: 'VALIDATION_ERROR',
            });
          }

          const evictions = await manager.suggestEvictions(
            sessionId,
            input.currentGoal,
            input.keepTop
          );

          Logger.debug(
            `context-budget: suggested ${evictions.length} evictions for session ${sessionId}`
          );

          return formatEvictions(
            evictions,
            input.currentGoal,
            input.keepTop
          );
        }

        default:
          return JSON.stringify({
            success: false,
            error: `Unknown action: ${(input as { action: string }).action}`,
            code: 'INVALID_ACTION',
          });
      }
    }, 30);
  },
};
