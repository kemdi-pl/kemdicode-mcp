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
 * Sequence Recommend Tool
 *
 * Get tool recommendations based on learned patterns.
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { getSequenceTracker } from '../../loci/index.js';

const schema = z.object({
  agentId: z.string().describe('Agent ID'),
  sessionId: z.string().describe('Session ID'),
  showPatterns: z.boolean().default(false).describe('Include learned patterns'),
  showTransitions: z.boolean().default(false).describe('Include transition stats'),
});

export const sequenceRecommendTool: UnifiedTool<typeof schema> = {
  name: 'sequence-recommend',
  description: 'Get tool recommendations based on learned execution patterns.',
  zodSchema: schema,

  execute: async (args) => {
    const { agentId, sessionId, showPatterns, showTransitions } = args;

    const tracker = getSequenceTracker();
    if (!tracker.isConnected()) {
      await tracker.connect();
    }

    const lines: string[] = [
      '╔══════════════════════════════════════════════════════════════════╗',
      '║ 🔮 SEQUENCE RECOMMENDATION                                       ║',
      '╠══════════════════════════════════════════════════════════════════╣',
      `║ Agent:   ${agentId.padEnd(55)} ║`,
      `║ Session: ${sessionId.padEnd(55)} ║`,
    ];

    // Get recommendation
    const recommendation = await tracker.recommend(agentId, sessionId);

    if (recommendation) {
      const confidenceBar = getConfidenceBar(recommendation.confidence);

      lines.push(
        '╠══════════════════════════════════════════════════════════════════╣',
        '║ RECOMMENDED NEXT TOOL                                           ║',
        '╠──────────────────────────────────────────────────────────────────╣',
        `║ 🎯 ${recommendation.nextTool.padEnd(60)} ║`,
        `║    Confidence: ${confidenceBar} ${(recommendation.confidence * 100).toFixed(0).padStart(3)}%`.padEnd(
          66
        ) + '║'
      );

      if (recommendation.alternatives.length > 0) {
        lines.push(
          '╠──────────────────────────────────────────────────────────────────╣',
          '║ ALTERNATIVES                                                     ║'
        );

        for (const alt of recommendation.alternatives) {
          const altBar = getConfidenceBar(alt.confidence);
          lines.push(
            `║   ${alt.tool.padEnd(30)} ${altBar} ${(alt.confidence * 100).toFixed(0).padStart(3)}% ║`
          );
        }
      }

      if (recommendation.basedOnPatterns.length > 0) {
        lines.push(
          '╠──────────────────────────────────────────────────────────────────╣',
          '║ BASED ON PATTERNS                                                ║'
        );

        for (const pattern of recommendation.basedOnPatterns.slice(0, 3)) {
          lines.push(`║   ${pattern.substring(0, 62).padEnd(62)} ║`);
        }
      }
    } else {
      lines.push(
        '╠──────────────────────────────────────────────────────────────────╣',
        '║ No recommendation available.                                     ║',
        '║ Execute more tools to build pattern history.                     ║'
      );
    }

    // Show learned patterns
    if (showPatterns) {
      const sequences = await tracker.getSequences(sessionId);

      lines.push(
        '╠══════════════════════════════════════════════════════════════════╣',
        `║ LEARNED PATTERNS (${sequences.length})`.padEnd(67) + '║',
        '╠──────────────────────────────────────────────────────────────────╣'
      );

      if (sequences.length === 0) {
        lines.push('║ No patterns learned yet.                                         ║');
      } else {
        for (const seq of sequences.slice(0, 10)) {
          const pattern = seq.tools.join(' → ');
          const successRate = (seq.successRate * 100).toFixed(0);
          lines.push(
            `║ ${pattern.substring(0, 45).padEnd(45)} (${successRate}% ×${seq.occurrences}) ║`
          );
        }
      }
    }

    // Show transition statistics
    if (showTransitions) {
      const stats = await tracker.getTransitionStats();

      lines.push(
        '╠══════════════════════════════════════════════════════════════════╣',
        '║ TRANSITION STATISTICS                                            ║',
        '╠──────────────────────────────────────────────────────────────────╣'
      );

      if (stats.length === 0) {
        lines.push('║ No transitions recorded yet.                                     ║');
      } else {
        lines.push('║ From → To                                  Count  Success Rate  ║');

        for (const stat of stats.slice(0, 15)) {
          const transition = `${stat.from.substring(0, 18)} → ${stat.to.substring(0, 18)}`;
          const successRate = (stat.successRate * 100).toFixed(0).padStart(3);
          lines.push(
            `║ ${transition.padEnd(40)} ${String(stat.count).padStart(5)}  ${successRate}%         ║`
          );
        }
      }
    }

    lines.push('╚══════════════════════════════════════════════════════════════════╝');

    return lines.join('\n');
  },
};

/**
 * Create a visual confidence bar
 */
function getConfidenceBar(confidence: number): string {
  const filled = Math.round(confidence * 10);
  const empty = 10 - filled;
  return '[' + '█'.repeat(filled) + '░'.repeat(empty) + ']';
}
