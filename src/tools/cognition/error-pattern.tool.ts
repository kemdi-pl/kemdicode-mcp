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
 * Error Pattern Tool
 *
 * MCP tool for learning from mistakes across sessions.
 * Records error patterns with root causes and fixes, matches new errors
 * against known patterns to suggest solutions, and provides aggregate
 * statistics on error trends.
 *
 * @module tools/cognition/error-pattern
 */

import { z } from 'zod';
import type { UnifiedTool } from '../registry.js';
import { getErrorPatternStore } from '../../cognition/error-pattern-store.js';

const errorTypeEnum = z.enum([
  'type-error',
  'reference-error',
  'file-not-found',
  'permission',
  'timeout',
  'logic-error',
  'syntax-error',
  'dependency',
  'config',
  'network',
  'unknown',
]);

const schema = z.object({
  action: z
    .enum(['record', 'get', 'list', 'match', 'stats'])
    .describe('Action to perform'),

  // record
  errorType: errorTypeEnum
    .optional()
    .describe('Error classification (action=record)'),
  context: z
    .string()
    .optional()
    .describe('When does this error happen? (action=record)'),
  symptoms: z
    .array(z.string())
    .optional()
    .describe('What does it look like? Error messages, stack traces, behaviors (action=record)'),
  rootCause: z
    .string()
    .optional()
    .describe('Root cause explanation (action=record)'),
  fix: z
    .string()
    .optional()
    .describe('What fixed the error (action=record)'),
  toolNames: z
    .array(z.string())
    .optional()
    .describe('Tools involved when error occurred (action=record)'),
  sessionId: z
    .string()
    .optional()
    .describe('Session ID where error was observed'),
  tags: z
    .array(z.string())
    .optional()
    .describe('Tags for categorization'),

  // get
  patternId: z
    .string()
    .optional()
    .describe('Pattern ID to retrieve (action=get)'),

  // match
  errorMessage: z
    .string()
    .optional()
    .describe('Error message to match against known patterns (action=match)'),
  toolName: z
    .string()
    .optional()
    .describe('Tool that produced the error, boosts matching relevance (action=match)'),

  // list
  limit: z
    .number()
    .default(10)
    .describe('Max results to return'),
  filterType: errorTypeEnum
    .optional()
    .describe('Filter by error type (action=list)'),
});

export const errorPatternTool: UnifiedTool<typeof schema> = {
  name: 'error-pattern',
  description:
    'Learn from mistakes across sessions. Record error patterns with root causes and fixes, match new errors against known patterns.',
  zodSchema: schema,
  metadata: {
    category: 'cognition' as never, // Category will be added to ToolCategory union
    tags: ['errors', 'learning', 'patterns', 'cross-session'],
    examples: [
      {
        args: {
          action: 'record',
          errorType: 'type-error',
          context: 'Building TypeScript project after adding new dependency',
          symptoms: [
            "TS2345: Argument of type 'string' is not assignable to parameter of type 'number'",
            'Build fails with type mismatch in service layer',
          ],
          rootCause: 'New library returns string IDs but our code expects numeric IDs',
          fix: 'Add parseInt() wrapper or update interface to accept string | number',
          toolNames: ['check-types', 'build'],
          sessionId: 'session-123',
          tags: ['typescript', 'types'],
        },
        description: 'Record a type error pattern with root cause and fix',
      },
      {
        args: {
          action: 'match',
          errorMessage:
            "TypeError: Cannot read properties of undefined (reading 'map')",
          toolName: 'run-tests',
        },
        description: 'Match an error against known patterns to find a fix',
      },
      {
        args: { action: 'stats' },
        description: 'Get aggregate statistics on all error patterns',
      },
    ],
    relatedTools: ['fix-bug', 'auto-fix', 'run-tests', 'check-types'],
  },

  execute: async (args) => {
    const store = getErrorPatternStore();

    switch (args.action) {
      // ─────────────────────────────────────────────────────────────────────
      // RECORD
      // ─────────────────────────────────────────────────────────────────────
      case 'record': {
        if (!args.errorType) {
          return 'Error: errorType is required for action=record';
        }
        if (!args.context) {
          return 'Error: context is required for action=record';
        }
        if (!args.symptoms || args.symptoms.length === 0) {
          return 'Error: symptoms (non-empty array) is required for action=record';
        }
        if (!args.rootCause) {
          return 'Error: rootCause is required for action=record';
        }
        if (!args.fix) {
          return 'Error: fix is required for action=record';
        }

        const pattern = await store.record({
          errorType: args.errorType,
          context: args.context,
          symptoms: args.symptoms,
          rootCause: args.rootCause,
          fix: args.fix,
          toolNames: args.toolNames || [],
          sessionIds: args.sessionId ? [args.sessionId] : [],
          tags: args.tags || [],
        });

        if (!pattern) {
          return 'Error: Failed to record error pattern (Redis unavailable)';
        }

        const isMerged = pattern.occurrences > 1;
        const lines: string[] = [];

        if (isMerged) {
          lines.push(`Merged with existing pattern (occurrence #${pattern.occurrences})`);
          lines.push(`Pattern ID: ${pattern.id}`);
          lines.push(`Type: ${pattern.errorType}`);
          lines.push(`Total occurrences: ${pattern.occurrences}`);
          lines.push(`Sessions affected: ${pattern.sessionIds.length}`);
          lines.push('');
          lines.push('This error has been seen before. The existing pattern was updated.');
        } else {
          lines.push('New error pattern recorded');
          lines.push(`Pattern ID: ${pattern.id}`);
          lines.push(`Type: ${pattern.errorType}`);
          lines.push(`Context: ${pattern.context}`);
          lines.push(`Symptoms: ${pattern.symptoms.length}`);
          lines.push(`Fix: ${pattern.fix}`);
        }

        return lines.join('\n');
      }

      // ─────────────────────────────────────────────────────────────────────
      // GET
      // ─────────────────────────────────────────────────────────────────────
      case 'get': {
        if (!args.patternId) {
          return 'Error: patternId is required for action=get';
        }

        const pattern = await store.get(args.patternId);
        if (!pattern) {
          return `Error: Pattern not found: ${args.patternId}`;
        }

        const lines: string[] = [];
        lines.push(`Error Pattern: ${pattern.id}`);
        lines.push(`Type: ${pattern.errorType}`);
        lines.push(`Occurrences: ${pattern.occurrences}`);
        lines.push(`Last seen: ${new Date(pattern.lastSeen).toISOString()}`);
        lines.push('');
        lines.push(`Context: ${pattern.context}`);
        lines.push('');
        lines.push('Symptoms:');
        for (const symptom of pattern.symptoms) {
          lines.push(`  - ${symptom}`);
        }
        lines.push('');
        lines.push(`Root cause: ${pattern.rootCause}`);
        lines.push('');
        lines.push(`Fix: ${pattern.fix}`);

        if (pattern.toolNames.length > 0) {
          lines.push('');
          lines.push(`Tools involved: ${pattern.toolNames.join(', ')}`);
        }

        if (pattern.sessionIds.length > 0) {
          lines.push('');
          lines.push(`Sessions affected (${pattern.sessionIds.length}): ${pattern.sessionIds.join(', ')}`);
        }

        if (pattern.tags.length > 0) {
          lines.push('');
          lines.push(`Tags: ${pattern.tags.join(', ')}`);
        }

        return lines.join('\n');
      }

      // ─────────────────────────────────────────────────────────────────────
      // LIST
      // ─────────────────────────────────────────────────────────────────────
      case 'list': {
        const limit = args.limit || 10;

        const patterns = args.filterType
          ? await store.listByType(args.filterType, limit)
          : await store.listAll(limit);

        if (patterns.length === 0) {
          const filterNote = args.filterType
            ? ` (type: ${args.filterType})`
            : '';
          return `No error patterns found${filterNote}. Use action=record to start learning from mistakes.`;
        }

        const lines: string[] = [];
        const filterNote = args.filterType
          ? ` (type: ${args.filterType})`
          : '';
        lines.push(`Error Patterns${filterNote} (${patterns.length} results):`);
        lines.push('');

        for (const pattern of patterns) {
          const fixPreview =
            pattern.fix.length > 80
              ? pattern.fix.substring(0, 80) + '...'
              : pattern.fix;
          lines.push(
            `[${pattern.occurrences}x] ${pattern.errorType} | ${pattern.id}`
          );
          lines.push(`  Context: ${pattern.context}`);
          lines.push(`  Fix: ${fixPreview}`);
          lines.push(
            `  Last seen: ${new Date(pattern.lastSeen).toISOString()}`
          );
          lines.push('');
        }

        return lines.join('\n');
      }

      // ─────────────────────────────────────────────────────────────────────
      // MATCH — the most important action
      // ─────────────────────────────────────────────────────────────────────
      case 'match': {
        if (!args.errorMessage) {
          return 'Error: errorMessage is required for action=match';
        }

        const matches = await store.match(args.errorMessage, args.toolName);

        if (matches.length === 0) {
          const lines: string[] = [];
          lines.push('No matching error patterns found.');
          lines.push('');
          lines.push(
            'This appears to be a new error. After you fix it, use action=record to save the pattern for future reference.'
          );
          return lines.join('\n');
        }

        const lines: string[] = [];
        const topMatches = matches.slice(0, 5); // Show top 5 matches
        lines.push(
          `Found ${matches.length} matching pattern(s). Top ${topMatches.length}:`
        );
        lines.push('');

        for (let i = 0; i < topMatches.length; i++) {
          const pattern = topMatches[i];
          lines.push(`--- Match #${i + 1} (seen ${pattern.occurrences}x) ---`);
          lines.push(`Known pattern: [${pattern.errorType}] ${pattern.context}`);
          lines.push(`Root cause: ${pattern.rootCause}`);
          lines.push(`Fix: ${pattern.fix}`);

          if (pattern.toolNames.length > 0) {
            lines.push(`Tools: ${pattern.toolNames.join(', ')}`);
          }

          lines.push(`Pattern ID: ${pattern.id}`);
          lines.push('');
        }

        if (matches.length > 5) {
          lines.push(
            `... and ${matches.length - 5} more. Use action=list to browse all patterns.`
          );
        }

        return lines.join('\n');
      }

      // ─────────────────────────────────────────────────────────────────────
      // STATS
      // ─────────────────────────────────────────────────────────────────────
      case 'stats': {
        const stats = await store.getStats();

        if (stats.total === 0) {
          return 'No error patterns recorded yet. Use action=record to start learning from mistakes.';
        }

        const lines: string[] = [];
        lines.push('Error Pattern Database Statistics');
        lines.push('================================');
        lines.push(`Total patterns: ${stats.total}`);
        lines.push('');

        lines.push('By type:');
        const sortedTypes = Object.entries(stats.byType).sort(
          ([, a], [, b]) => b - a
        );
        for (const [type, count] of sortedTypes) {
          lines.push(`  ${type}: ${count} pattern(s)`);
        }

        if (stats.topPatterns.length > 0) {
          lines.push('');
          lines.push('Most frequent patterns:');
          for (const p of stats.topPatterns) {
            lines.push(
              `  [${p.occurrences}x] ${p.errorType} | ${p.id}`
            );
            lines.push(`    Fix: ${p.fix}`);
          }
        }

        return lines.join('\n');
      }

      default:
        return `Error: Unknown action '${args.action}'. Valid actions: record, get, list, match, stats`;
    }
  },
};
