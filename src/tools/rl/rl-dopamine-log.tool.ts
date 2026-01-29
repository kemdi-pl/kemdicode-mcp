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
 * RL Dopamine Log Tool
 *
 * View dopamine signals for an agent.
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { getDopamineEmitter } from '../../rl/index.js';

const schema = z.object({
  agentId: z.string().describe('Agent ID to get dopamine signals for'),
  limit: z.number().int().min(1).max(100).default(20).describe('Number of signals to show'),
  showStats: z.boolean().default(true).describe('Include aggregate statistics'),
});

export const rlDopamineLogTool: UnifiedTool<typeof schema> = {
  name: 'rl-dopamine-log',
  description:
    'View recent dopamine signals for an agent. Shows spikes, dips, and sustained signals.',
  zodSchema: schema,
  skipContextShare: true,

  execute: async (args) => {
    const { agentId, limit, showStats } = args;

    const emitter = getDopamineEmitter();
    if (!emitter.isConnected()) {
      await emitter.connect();
    }

    const signals = await emitter.getRecentSignals(agentId, limit);

    if (signals.length === 0) {
      return `No dopamine signals found for agent ${agentId}`;
    }

    const lines: string[] = [
      '╔══════════════════════════════════════════════════════════════════╗',
      '║ 🧠 DOPAMINE SIGNAL LOG                                           ║',
      '╠══════════════════════════════════════════════════════════════════╣',
      `║ Agent ID: ${agentId.padEnd(54)} ║`,
      `║ Showing:  ${String(signals.length)} most recent signals`.padEnd(66) + '║',
    ];

    // Show stats if requested
    if (showStats) {
      const stats = await emitter.getStats(agentId);
      if (stats) {
        lines.push(
          '╠══════════════════════════════════════════════════════════════════╣',
          '║ STATISTICS                                                       ║',
          '╠──────────────────────────────────────────────────────────────────╣',
          `║ Total Signals:      ${String(stats.totalSignals).padEnd(45)} ║`,
          `║ Avg Intensity:      ${stats.averageIntensity.toFixed(3).padEnd(45)} ║`,
          '║ By Type:                                                         ║',
          `║   📈 Spikes:        ${String(stats.byType.spike).padEnd(45)} ║`,
          `║   📉 Dips:          ${String(stats.byType.dip).padEnd(45)} ║`,
          `║   ➡️  Sustained:     ${String(stats.byType.sustained).padEnd(45)} ║`,
          `║   ⚪ Baseline:      ${String(stats.byType.baseline).padEnd(45)} ║`
        );

        // Top triggers
        const triggers = Object.entries(stats.byTrigger)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5);

        if (triggers.length > 0) {
          lines.push('║ Top Triggers:                                                    ║');
          for (const [trigger, count] of triggers) {
            lines.push(
              `║   ${trigger.padEnd(25)} ${String(count).padStart(5)} times`.padEnd(66) + '║'
            );
          }
        }
      }
    }

    // Signal list
    lines.push(
      '╠══════════════════════════════════════════════════════════════════╣',
      '║ RECENT SIGNALS                                                   ║',
      '╠──────────────────────────────────────────────────────────────────╣'
    );

    for (const signal of signals) {
      const icon =
        signal.type === 'spike'
          ? '📈'
          : signal.type === 'dip'
            ? '📉'
            : signal.type === 'sustained'
              ? '➡️'
              : '⚪';

      const intensityBar = getIntensityBar(signal.intensity);
      const time = new Date(signal.timestamp).toLocaleTimeString();
      const trigger = signal.trigger.substring(0, 18).padEnd(18);

      lines.push(
        `║ ${icon} ${time} ${trigger} ${intensityBar} ${signal.intensity.toFixed(2).padStart(6)} ║`
      );

      // Show message if present
      if (signal.message) {
        const msg = signal.message.substring(0, 60);
        lines.push(`║   └─ ${msg.padEnd(59)} ║`);
      }
    }

    lines.push('╚══════════════════════════════════════════════════════════════════╝');

    // Legend
    lines.push(
      '',
      'Legend:',
      '  📈 Spike (positive burst)   📉 Dip (negative burst)',
      '  ➡️  Sustained (ongoing)      ⚪ Baseline (neutral)'
    );

    return lines.join('\n');
  },
};

/**
 * Create a visual intensity bar
 */
function getIntensityBar(intensity: number): string {
  const normalized = Math.abs(intensity);
  const filled = Math.round(normalized * 8);
  const empty = 8 - filled;

  if (intensity > 0) {
    return '[' + '█'.repeat(filled) + '░'.repeat(empty) + ']';
  } else if (intensity < 0) {
    return '[' + '░'.repeat(empty) + '▓'.repeat(filled) + ']';
  } else {
    return '[' + '░'.repeat(8) + ']';
  }
}
