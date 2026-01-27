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
 * Loci Recall Tool
 *
 * Walk the memory palace and recall memories from a loci.
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { getLociManager, LOCI_TEMPLATES } from '../../loci/index.js';

const schema = z.object({
  lociId: z.string().optional().describe('Specific loci ID to recall from'),
  lociName: z.string().optional().describe('Loci name (alternative to ID)'),
  sessionId: z.string().describe('Session ID'),
  walkAll: z.boolean().default(false).describe('Walk all loci in the palace'),
});

export const lociRecallTool: UnifiedTool<typeof schema> = {
  name: 'loci-recall',
  description:
    'Recall memories from a loci in the memory palace. ' +
    'Use vivid associations to trigger memory recall.',
  zodSchema: schema,

  execute: async (args) => {
    const { lociId, lociName, sessionId, walkAll } = args;

    const manager = getLociManager();
    if (!manager.isConnected()) {
      await manager.connect();
    }

    if (walkAll) {
      const recalls = await manager.walkPalace(sessionId);

      if (recalls.length === 0) {
        return `No loci found in session ${sessionId}. Create loci first with loci-create.`;
      }

      const lines: string[] = [
        '╔══════════════════════════════════════════════════════════════════╗',
        '║ 🏛️  WALKING THE MEMORY PALACE                                    ║',
        '╠══════════════════════════════════════════════════════════════════╣',
        `║ Session: ${sessionId.padEnd(55)} ║`,
        `║ Loci:    ${String(recalls.length)} locations`.padEnd(66) + '║',
        '╠══════════════════════════════════════════════════════════════════╣',
      ];

      for (const recall of recalls) {
        const icon = recall.loci.icon || '📍';
        lines.push(
          `║ ${icon} ${recall.loci.name.substring(0, 60).padEnd(60)} ║`,
          `║   ${recall.loci.description.substring(0, 60).padEnd(60)} ║`,
          `║   Memories: ${String(recall.nodes.length).padEnd(52)} ║`
        );

        if (recall.associationsTriggered.length > 0) {
          lines.push(`║   💭 ${recall.associationsTriggered[0].substring(0, 58).padEnd(58)} ║`);
        }

        lines.push('║                                                                  ║');
      }

      lines.push('╚══════════════════════════════════════════════════════════════════╝');
      return lines.join('\n');
    }

    // Recall from specific loci
    let targetLociId = lociId;

    if (!targetLociId && lociName) {
      const loci = await manager.getLociByName(lociName);
      if (loci) {
        targetLociId = loci.id;
      } else {
        return `Loci not found: ${lociName}`;
      }
    }

    if (!targetLociId) {
      // List available loci
      const lociList = await manager.getSessionLoci(sessionId);

      if (lociList.length === 0) {
        const templateList = Object.entries(LOCI_TEMPLATES)
          .map(([key, t]) => `  ${t.icon} ${key}: ${t.name}`)
          .join('\n');

        return [
          `No loci found in session ${sessionId}.`,
          '',
          'Create loci using templates:',
          templateList,
          '',
          'Or create custom loci with loci-create.',
        ].join('\n');
      }

      const lines: string[] = [
        '╔══════════════════════════════════════════════════════════════════╗',
        '║ 🏛️  AVAILABLE LOCI                                               ║',
        '╠══════════════════════════════════════════════════════════════════╣',
      ];

      for (const loci of lociList) {
        const icon = loci.icon || '📍';
        lines.push(
          `║ ${icon} ${loci.name.padEnd(40)} [${loci.nodeIds.length} memories] ║`,
          `║   ID: ${loci.id.padEnd(58)} ║`
        );
      }

      lines.push(
        '╠──────────────────────────────────────────────────────────────────╣',
        '║ Specify lociId or lociName to recall from a specific location.  ║',
        '╚══════════════════════════════════════════════════════════════════╝'
      );

      return lines.join('\n');
    }

    // Recall from specific loci
    const recall = await manager.recall(targetLociId);

    if (!recall) {
      return `Loci not found: ${targetLociId}`;
    }

    const lines: string[] = [
      '╔══════════════════════════════════════════════════════════════════╗',
      `║ ${recall.loci.icon || '📍'} RECALLING FROM: ${recall.loci.name.substring(0, 44).padEnd(44)} ║`,
      '╠══════════════════════════════════════════════════════════════════╣',
      `║ ${recall.loci.description.substring(0, 64).padEnd(64)} ║`,
      '╠══════════════════════════════════════════════════════════════════╣',
      '║ 💭 ASSOCIATIONS (Visualization Triggers)                         ║',
      '╠──────────────────────────────────────────────────────────────────╣',
    ];

    for (const assoc of recall.associationsTriggered.slice(0, 5)) {
      lines.push(`║   • ${assoc.substring(0, 60).padEnd(60)} ║`);
    }

    lines.push(
      '╠══════════════════════════════════════════════════════════════════╣',
      `║ 🧠 MEMORIES (${recall.nodes.length} nodes)`.padEnd(67) + '║',
      '╠──────────────────────────────────────────────────────────────────╣'
    );

    const typeIcons: Record<string, string> = {
      file: '📄',
      error: '❌',
      solution: '✅',
      tool: '🔧',
      concept: '💡',
      context: '📝',
      pattern: '🔄',
    };

    for (const node of recall.nodes.slice(0, 10)) {
      const icon = typeIcons[node.type] || '📌';
      lines.push(`║   ${icon} ${node.label.substring(0, 57).padEnd(57)} ║`);
    }

    if (recall.nodes.length > 10) {
      lines.push(`║   ... and ${recall.nodes.length - 10} more`.padEnd(66) + '║');
    }

    if (recall.connectedMemories.length > 0) {
      lines.push(
        '╠──────────────────────────────────────────────────────────────────╣',
        `║ 🔗 CONNECTED MEMORIES (${recall.connectedMemories.length})`.padEnd(67) + '║'
      );

      for (const node of recall.connectedMemories.slice(0, 5)) {
        const icon = typeIcons[node.type] || '📌';
        lines.push(`║   ${icon} ${node.label.substring(0, 57).padEnd(57)} ║`);
      }
    }

    if (recall.suggestedNext.length > 0) {
      lines.push(
        '╠──────────────────────────────────────────────────────────────────╣',
        '║ 👉 SUGGESTED NEXT                                                ║'
      );

      for (const next of recall.suggestedNext.slice(0, 3)) {
        lines.push(`║   ${next.icon || '📍'} ${next.name.padEnd(58)} ║`);
      }
    }

    lines.push('╚══════════════════════════════════════════════════════════════════╝');

    return lines.join('\n');
  },
};
