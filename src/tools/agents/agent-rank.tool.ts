/**
 * KemdiCode MCP Server
 * Copyright (C) 2025-2026 Kemdi Sp. z o.o. (Dawid Irzyk <dawid@kemdi.pl>)
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

/**
 * Agent Ranking Tool
 *
 * Manage agent performance rankings and view leaderboards.
 *
 * @module tools/agents/agent-rank
 */

import { z } from 'zod';
import type { UnifiedTool } from '../registry.js';
import { getAgentRankStore, type AgentScore } from '../../cognition/agent-rank-store.js';
import { isSilent } from '../../config/silent.js';
import { Logger } from '../../utils/logger.js';

const schema = z.object({
  action: z
    .enum(['get-rank', 'leaderboard', 'promote', 'demote', 'history'])
    .default('leaderboard')
    .describe('Action: get-rank, leaderboard, promote, demote, history'),
  agentId: z
    .string()
    .optional()
    .describe('Agent ID (required for get-rank, promote, demote, history)'),
  limit: z.number().int().min(1).max(50).default(10).describe('Max entries for leaderboard'),
});

function formatScore(s: AgentScore): string {
  const rankIcon: Record<string, string> = {
    bronze: '[Bronze]',
    silver: '[Silver]',
    gold: '[Gold]',
    platinum: '[Platinum]',
    diamond: '[Diamond]',
  };
  return (
    `${rankIcon[s.rank] || s.rank} ${s.agentId}\n` +
    `  Score: ${s.score}/1000\n` +
    `  Success rate: ${(s.components.successRate * 100).toFixed(1)}%\n` +
    `  Speed: ${(s.components.avgSpeed * 100).toFixed(1)}%\n` +
    `  Complexity: ${(s.components.taskComplexity * 100).toFixed(1)}%\n` +
    `  Tasks: ${s.stats.totalTasks} (${s.stats.successfulTasks} successful)\n` +
    `  Avg duration: ${(s.stats.avgDuration / 1000).toFixed(1)}s\n` +
    `  Last active: ${new Date(s.stats.lastActive).toISOString()}`
  );
}

export const agentRankTool: UnifiedTool<typeof schema> = {
  name: 'agent-rank',
  description: 'View and manage agent performance rankings with bronze-to-diamond tier system. USE PROACTIVELY: check rankings to select the best agent for a task.',
  zodSchema: schema,
  skipContextShare: true,
  metadata: {
    category: 'agents',
    tags: ['ranking', 'performance', 'leaderboard'],
    examples: [
      { args: { action: 'leaderboard' }, description: 'View top agents by score' },
      { args: { action: 'get-rank', agentId: 'backend-dev' }, description: 'Get specific agent rank' },
      { args: { action: 'promote', agentId: 'backend-dev' }, description: 'Manually promote agent' },
    ],
    relatedTools: ['agent-list', 'agent-summary', 'task-push-multi'],
  },

  execute: async (args) => {
    const { action, agentId, limit } = args;

    try {
      const store = getAgentRankStore();

      if (!store.isConnected()) {
        await store.connect();
      }

      switch (action) {
        case 'get-rank': {
          if (!agentId) {
            return JSON.stringify({ success: false, error: 'agentId required for get-rank action', code: 'VALIDATION_ERROR' });
          }
          const score = await store.getScore(agentId);
          if (!score) {
            return JSON.stringify({ success: false, error: `No ranking data found for agent "${agentId}"`, code: 'NOT_FOUND' });
          }
          if (isSilent()) {
            return JSON.stringify({ agentId: score.agentId, score: score.score, rank: score.rank, components: score.components, stats: score.stats });
          }
          return `# Agent Ranking\n\n${formatScore(score)}`;
        }

        case 'leaderboard': {
          const board = await store.getLeaderboard(limit);
          if (board.length === 0) {
            if (isSilent()) return JSON.stringify([]);
            return 'No agents ranked yet. Rankings update automatically as agents execute tools.';
          }
          if (isSilent()) {
            return JSON.stringify(board.map((s) => ({ agentId: s.agentId, score: s.score, rank: s.rank })));
          }
          let output = `# Agent Leaderboard (Top ${board.length})\n\n`;
          for (let i = 0; i < board.length; i++) {
            output += `${i + 1}. ${formatScore(board[i])}\n\n`;
          }
          return output;
        }

        case 'promote': {
          if (!agentId) {
            return JSON.stringify({ success: false, error: 'agentId required for promote action', code: 'VALIDATION_ERROR' });
          }
          const promoted = await store.promote(agentId);
          if (!promoted) {
            return JSON.stringify({ success: false, error: `Agent "${agentId}" not found`, code: 'NOT_FOUND' });
          }
          if (isSilent()) {
            return JSON.stringify({ agentId: promoted.agentId, rank: promoted.rank, score: promoted.score });
          }
          return `Agent "${agentId}" promoted to ${promoted.rank}.\n\n${formatScore(promoted)}`;
        }

        case 'demote': {
          if (!agentId) {
            return JSON.stringify({ success: false, error: 'agentId required for demote action', code: 'VALIDATION_ERROR' });
          }
          const demoted = await store.demote(agentId);
          if (!demoted) {
            return JSON.stringify({ success: false, error: `Agent "${agentId}" not found`, code: 'NOT_FOUND' });
          }
          if (isSilent()) {
            return JSON.stringify({ agentId: demoted.agentId, rank: demoted.rank, score: demoted.score });
          }
          return `Agent "${agentId}" demoted to ${demoted.rank}.\n\n${formatScore(demoted)}`;
        }

        case 'history': {
          if (!agentId) {
            return JSON.stringify({ success: false, error: 'agentId required for history action', code: 'VALIDATION_ERROR' });
          }
          const score = await store.getScore(agentId);
          if (!score) {
            return JSON.stringify({ success: false, error: `No ranking data found for agent "${agentId}"`, code: 'NOT_FOUND' });
          }
          if (score.history.length === 0) {
            if (isSilent()) return JSON.stringify({ agentId, rank: score.rank, score: score.score, history: [] });
            return `No rank changes recorded for agent "${agentId}".`;
          }
          if (isSilent()) {
            return JSON.stringify({ agentId, rank: score.rank, score: score.score, history: score.history.slice(-20) });
          }
          let output = `# Rank History: ${agentId}\n\nCurrent: ${score.rank} (${score.score}/1000)\n\n`;
          for (const h of score.history.slice(-20)) {
            output += `  ${new Date(h.timestamp).toISOString()} - ${h.rank} (score: ${h.score})\n`;
          }
          return output;
        }

        default:
          return `Unknown action: ${action}`;
      }
    } catch (error) {
      Logger.error('[agent-rank] Error:', error);
      return JSON.stringify({
        success: false,
        error: `Agent rank operation failed: ${error instanceof Error ? error.message : String(error)}`,
        code: 'RANK_ERROR',
      });
    }
  },
};
