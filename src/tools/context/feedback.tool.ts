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
 * Feedback & Learning Tool
 *
 * Provides access to the feedback loop and iteration tracking systems.
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import {
  checkAppliedSuggestions,
  getFeedbackStats,
  getLearningInsights,
  provideFeedback,
  getSuggestionsForFile,
} from '../../context/feedback-loop.js';
import { isSilent } from '../../config/silent.js';
import {
  getIterationContext,
  getIterationSummary,
  getSuggestionsForError,
  startIteration,
  completeIteration,
} from '../../context/iteration-tracker.js';

const schema = z.object({
  action: z
    .enum([
      'stats', // Get feedback statistics
      'insights', // Get learning insights
      'check', // Check if suggestions were applied
      'iteration', // Get current iteration status
      'start', // Start new iteration
      'complete', // Complete current iteration
      'suggest-fix', // Get fix suggestions for error
      'file-history', // Get suggestions for a file
      'rate', // Rate a suggestion
    ])
    .describe('Action to perform'),

  // Optional parameters depending on action
  error: z.string().optional().describe('Error message (for suggest-fix)'),
  file: z.string().optional().describe('File path (for file-history)'),
  suggestionId: z.string().optional().describe('Suggestion ID (for rate)'),
  rating: z.enum(['helpful', 'not_helpful', 'partial']).optional().describe('Rating (for rate)'),
  task: z.string().optional().describe('Task description (for start)'),
  result: z.string().optional().describe('Final result (for complete)'),
  lessons: z.string().optional().describe('Lessons learned, comma separated (for complete)'),
});

export const feedbackTool: UnifiedTool = {
  name: 'feedback',
  description:
    'Access feedback loop. Get stats, insights, track iterations, suggest fixes.',
  zodSchema: schema,
  skipContextShare: true,
  metadata: {
    category: 'context',
    tags: ['feedback', 'learning'],
    examples: [
      { args: { action: 'stats' }, description: 'Get feedback statistics' },
      { args: { action: 'suggest-fix', error: 'TypeError: Cannot read property of undefined' }, description: 'Get fix suggestions for an error' },
      { args: { action: 'start', task: 'Implement user authentication' }, description: 'Start tracking a new iteration' },
    ],
    relatedTools: ['code-review', 'auto-fix'],
  },

  execute: async (args) => {
    const { action, error, file, suggestionId, rating, task, result, lessons } = args as z.infer<
      typeof schema
    >;

    switch (action) {
      case 'stats': {
        const stats = await getFeedbackStats();
        if (isSilent()) return JSON.stringify(stats);
        return formatStats(stats);
      }

      case 'insights': {
        const insights = await getLearningInsights();
        return insights.join('\n');
      }

      case 'check': {
        const { newlyApplied, stillPending } = await checkAppliedSuggestions();
        const lines: string[] = [];

        if (newlyApplied.length > 0) {
          lines.push('✅ **Newly Applied Suggestions:**');
          for (const s of newlyApplied) {
            lines.push(`   • ${s.description} (${s.filePath})`);
          }
        }

        if (stillPending.length > 0) {
          lines.push('\n⏳ **Pending Suggestions:**');
          for (const s of stillPending.slice(0, 5)) {
            lines.push(`   • ${s.description} (${s.filePath})`);
          }
          if (stillPending.length > 5) {
            lines.push(`   ... and ${stillPending.length - 5} more`);
          }
        }

        return lines.length > 0 ? lines.join('\n') : 'No suggestions tracked yet.';
      }

      case 'iteration': {
        return await getIterationSummary();
      }

      case 'start': {
        if (!task) {
          return 'Error: Task description required. Use task="description"';
        }
        const iterationId = await startIteration(task);
        return iterationId
          ? `Started new iteration: ${iterationId}\nTask: ${task}`
          : 'Failed to start iteration. Check storage connection.';
      }

      case 'complete': {
        const context = await getIterationContext();
        if (!context.currentIteration) {
          return 'No active iteration to complete.';
        }

        const lessonsArray = lessons?.split(',').map((l) => l.trim()) || [];
        await completeIteration(context.currentIteration.id, result || 'Completed', lessonsArray);

        return `Iteration ${context.currentIteration.id} completed.\nAttempts: ${context.currentIteration.attempts.length}\nLessons: ${lessonsArray.join(', ') || 'None recorded'}`;
      }

      case 'suggest-fix': {
        if (!error) {
          return 'Error: Error message required. Use error="your error message"';
        }
        const fixes = await getSuggestionsForError(error);
        if (fixes.length === 0) {
          return 'No historical fixes found for this error pattern.';
        }
        return (
          '🔧 **Suggested Fixes (based on history):**\n' +
          fixes.map((f, i) => `${i + 1}. ${f}`).join('\n')
        );
      }

      case 'file-history': {
        if (!file) {
          return 'Error: File path required. Use file="path/to/file"';
        }
        const suggestions = await getSuggestionsForFile(file);
        if (suggestions.length === 0) {
          return `No suggestions recorded for ${file}`;
        }
        const lines = [`📁 **Suggestions for ${file}:**`];
        for (const s of suggestions) {
          const status = s.applied ? '✅' : '⏳';
          const date = new Date(s.timestamp).toLocaleDateString();
          lines.push(`${status} [${s.suggestionType}] ${s.description} (${date})`);
        }
        return lines.join('\n');
      }

      case 'rate': {
        if (!suggestionId || !rating) {
          return 'Error: Both suggestionId and rating required.';
        }
        const success = await provideFeedback(suggestionId, rating);
        return success
          ? `Feedback recorded: ${suggestionId} → ${rating}`
          : `Failed to record feedback for ${suggestionId}`;
      }

      default:
        return `Unknown action: ${action}`;
    }
  },
};

function formatStats(stats: {
  totalSuggestions: number;
  applied: number;
  notApplied: number;
  pending: number;
  applicationRate: number;
  byType: Record<string, { total: number; applied: number }>;
  byTool: Record<string, { total: number; applied: number }>;
}): string {
  const lines = [
    '📊 **Feedback Statistics**',
    '',
    `Total Suggestions: ${stats.totalSuggestions}`,
    `├─ Applied:    ${stats.applied} ✅`,
    `├─ Not Applied: ${stats.notApplied} ❌`,
    `└─ Pending:    ${stats.pending} ⏳`,
    '',
    `Application Rate: ${stats.applicationRate}%`,
    '',
  ];

  if (Object.keys(stats.byType).length > 0) {
    lines.push('**By Type:**');
    for (const [type, data] of Object.entries(stats.byType)) {
      const rate = data.total > 0 ? Math.round((data.applied / data.total) * 100) : 0;
      lines.push(`  ${type}: ${data.applied}/${data.total} (${rate}%)`);
    }
    lines.push('');
  }

  if (Object.keys(stats.byTool).length > 0) {
    lines.push('**By Tool:**');
    for (const [tool, data] of Object.entries(stats.byTool)) {
      const rate = data.total > 0 ? Math.round((data.applied / data.total) * 100) : 0;
      lines.push(`  ${tool}: ${data.applied}/${data.total} (${rate}%)`);
    }
  }

  return lines.join('\n');
}
