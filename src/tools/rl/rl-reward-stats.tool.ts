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
 * RL Reward Stats Tool
 *
 * View reward statistics for an agent.
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import {
  getRewardTracker,
  getStateTracker,
  analyzePotential,
  suggestOptimalAction,
} from '../../rl/index.js';

/**
 * Safely format a stat number, handling NaN/Infinity
 */
function formatStat(value: number): string {
  if (!Number.isFinite(value)) return 'N/A';
  return value.toFixed(3);
}

const schema = z.object({
  agentId: z.string().describe('Agent ID'),
  sessionId: z.string().describe('Session ID'),
  includeHistory: z.boolean().default(false).describe('Include reward history'),
  historyLimit: z.number().int().min(1).max(50).default(10).describe('Max history entries'),
});

export const rlRewardStatsTool: UnifiedTool<typeof schema> = {
  name: 'rl-reward-stats',
  description:
    'View agent reward stats: cumulative rewards, tool performance, trends.',
  zodSchema: schema,
  skipContextShare: true,

  execute: async (args) => {
    const { agentId, sessionId, includeHistory, historyLimit } = args;

    const rewardTracker = getRewardTracker();
    const stateTracker = getStateTracker();

    if (!rewardTracker.isConnected()) {
      await rewardTracker.connect();
    }
    if (!stateTracker.isConnected()) {
      await stateTracker.connect();
    }

    // Get stats
    const stats = await rewardTracker.getStats(agentId, sessionId);
    const state = await stateTracker.getState(agentId);

    if (!stats && !state) {
      return `No reward data found for agent ${agentId} in session ${sessionId}`;
    }

    const lines: string[] = [
      '╔══════════════════════════════════════════════════════════════════╗',
      '║ 📊 RL REWARD STATISTICS                                          ║',
      '╠══════════════════════════════════════════════════════════════════╣',
      `║ Agent ID:     ${agentId.padEnd(50)} ║`,
      `║ Session:      ${sessionId.padEnd(50)} ║`,
    ];

    if (stats) {
      const trendIcon =
        stats.recentTrend === 'improving' ? '📈' : stats.recentTrend === 'declining' ? '📉' : '➡️';

      lines.push(
        '╠══════════════════════════════════════════════════════════════════╣',
        '║ REWARD SUMMARY                                                   ║',
        '╠──────────────────────────────────────────────────────────────────╣',
        `║ Total Rewards:    ${String(stats.rewardCount).padEnd(46)} ║`,
        `║ Cumulative:       ${formatStat(stats.cumulativeReward).padEnd(46)} ║`,
        `║ Average:          ${formatStat(stats.averageReward).padEnd(46)} ║`,
        `║ Max:              ${formatStat(stats.maxReward).padEnd(46)} ║`,
        `║ Min:              ${formatStat(stats.minReward).padEnd(46)} ║`,
        `║ Trend:            ${trendIcon} ${stats.recentTrend.padEnd(44)} ║`
      );

      // Tool performance
      const toolEntries = Object.entries(stats.rewardsByTool);
      if (toolEntries.length > 0) {
        lines.push(
          '╠──────────────────────────────────────────────────────────────────╣',
          '║ TOOL PERFORMANCE                                                 ║',
          '╠──────────────────────────────────────────────────────────────────╣'
        );

        // Sort by average reward
        toolEntries.sort((a, b) => b[1].average - a[1].average);
        for (const [tool, data] of toolEntries.slice(0, 10)) {
          const icon = data.average > 0 ? '✅' : data.average < 0 ? '❌' : '➖';
          lines.push(
            `║ ${icon} ${tool.substring(0, 25).padEnd(25)} avg: ${data.average.toFixed(2).padStart(7)} (n=${String(data.count).padStart(3)}) ║`
          );
        }
      }
    }

    // Current state analysis
    if (state) {
      const analysis = analyzePotential(state);
      const suggestion = suggestOptimalAction(state);

      lines.push(
        '╠══════════════════════════════════════════════════════════════════╣',
        '║ CURRENT STATE ANALYSIS                                           ║',
        '╠──────────────────────────────────────────────────────────────────╣',
        `║ Task Progress:      ${(state.taskProgress * 100).toFixed(1).padEnd(5)}%`.padEnd(67) +
          '║',
        `║ Tool Success Rate:  ${(state.toolSuccessRate * 100).toFixed(1).padEnd(5)}%`.padEnd(67) +
          '║',
        `║ Peer Interactions:  ${String(state.peerInteractions).padEnd(45)} ║`,
        `║ Error Count:        ${String(state.errorCount).padEnd(45)} ║`,
        `║ Consecutive Errors: ${String(state.consecutiveErrors).padEnd(45)} ║`,
        '╠──────────────────────────────────────────────────────────────────╣',
        `║ Current Potential:  ${analysis.total.toFixed(3).padEnd(45)} ║`,
        '║ Components:                                                      ║',
        `║   + Task Progress:     ${analysis.components.taskProgress.toFixed(3).padEnd(42)} ║`,
        `║   + Tool Success:      ${analysis.components.toolSuccessRate.toFixed(3).padEnd(42)} ║`,
        `║   + Peer Interact:     ${analysis.components.peerInteractions.toFixed(3).padEnd(42)} ║`,
        `║   - Error Penalty:     ${analysis.components.errorPenalty.toFixed(3).padEnd(42)} ║`,
        `║   - Consec Errors:     ${analysis.components.consecutiveErrorPenalty.toFixed(3).padEnd(42)} ║`,
        `║   - Age Decay:         ${analysis.components.ageDecay.toFixed(3).padEnd(42)} ║`,
        '╠──────────────────────────────────────────────────────────────────╣',
        '║ SUGGESTION                                                       ║',
        `║ ${suggestion.suggestion.padEnd(64)} ║`,
        `║ ${suggestion.reason.substring(0, 64).padEnd(64)} ║`
      );
    }

    // History
    if (includeHistory && stats) {
      const history = await rewardTracker.getRewardHistory(agentId, historyLimit);
      if (history.length > 0) {
        lines.push(
          '╠══════════════════════════════════════════════════════════════════╣',
          '║ RECENT REWARDS                                                   ║',
          '╠──────────────────────────────────────────────────────────────────╣'
        );
        for (const entry of history) {
          const icon =
            entry.reward.shapedReward > 0 ? '🟢' : entry.reward.shapedReward < 0 ? '🔴' : '⚪';
          const action = (entry.action || 'unknown').substring(0, 25).padEnd(25);
          const shaped = entry.reward.shapedReward.toFixed(3).padStart(8);
          const intrinsic = entry.reward.intrinsicReward.toFixed(1).padStart(5);
          lines.push(`║ ${icon} ${action} shaped: ${shaped} (r=${intrinsic}) ║`);
        }
      }
    }

    lines.push('╚══════════════════════════════════════════════════════════════════╝');

    return lines.join('\n');
  },
};
