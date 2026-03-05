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
 * Agent Ranking System
 *
 * Tracks agent performance and assigns ranks (bronze -> diamond) based on
 * cumulative success. Integrates with RL system for automatic score updates.
 * Rankings persist permanently across sessions.
 *
 * @module cognition/agent-rank-store
 */

import { RedisBackedService } from '../infrastructure/redis/redis-backed-service.js';
import { safeJsonParse } from '../utils/validation.js';
import { Logger } from '../utils/logger.js';

/** Agent rank tiers */
export type AgentRank = 'bronze' | 'silver' | 'gold' | 'platinum' | 'diamond';

/** Complete agent score record */
export interface AgentScore {
  agentId: string;
  score: number;
  rank: AgentRank;
  components: {
    successRate: number;
    avgSpeed: number;
    taskComplexity: number;
    collaborationQuality: number;
  };
  stats: {
    totalTasks: number;
    successfulTasks: number;
    avgDuration: number;
    lastActive: number;
  };
  history: Array<{
    timestamp: number;
    score: number;
    rank: AgentRank;
  }>;
}

/** Rank thresholds (score -> rank) */
const RANK_THRESHOLDS: Record<AgentRank, number> = {
  bronze: 0,
  silver: 200,
  gold: 400,
  platinum: 650,
  diamond: 850,
};

/** Component weights for composite score */
const WEIGHTS = {
  successRate: 0.4,
  avgSpeed: 0.2,
  taskComplexity: 0.3,
  collaborationQuality: 0.1,
};

/** Decay rate per day of inactivity */
const DECAY_RATE = 0.95;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Redis key prefix */
const KEY_PREFIX = 'mcp:agent-rank:';

/** Per-agent lock: prevents lost updates from concurrent read-modify-write */
const LOCK_TTL_MS = 5000;
const LOCK_MAX_RETRIES = 3;
const LOCK_RETRY_DELAY_MS = 50;

/** Lua CAS delete: release lock only if we still own it */
const LOCK_RELEASE_LUA = `if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end`;

/**
 * Agent Rank Store
 */
export class AgentRankStore extends RedisBackedService {
  protected get serviceName(): string {
    return 'AgentRankStore';
  }

  /**
   * Execute a callback with a per-agent Redis lock.
   * Prevents lost updates from concurrent read-modify-write cycles.
   */
  private async withAgentLock<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
    if (!this.redis) throw new Error('Redis not connected');

    const lockKey = `${KEY_PREFIX}lock:${agentId}`;
    const lockValue = `${Date.now()}_${Math.random().toString(36).slice(2)}`;

    for (let attempt = 0; attempt < LOCK_MAX_RETRIES; attempt++) {
      const acquired = await this.redis.set(lockKey, lockValue, 'PX', LOCK_TTL_MS, 'NX');
      if (acquired === 'OK') {
        try {
          return await fn();
        } finally {
          await this.redis.eval(LOCK_RELEASE_LUA, 1, lockKey, lockValue).catch(() => {});
        }
      }
      await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_DELAY_MS * (attempt + 1)));
    }

    Logger.warn(`[AgentRankStore] Lock contention on agent ${agentId}, proceeding without lock`);
    return fn();
  }

  /**
   * Update agent score based on a tool execution.
   */
  async updateScore(
    agentId: string,
    success: boolean,
    durationMs: number,
    taskComplexity: number = 0.5
  ): Promise<AgentScore> {
    if (!this.redis) throw new Error('Redis not connected');

    return this.withAgentLock(agentId, async () => {
      let score = await this.getScore(agentId);
      if (!score) score = this.initScore(agentId);

      // Update stats
      score.stats.totalTasks++;
      if (success) score.stats.successfulTasks++;
      score.stats.avgDuration =
        (score.stats.avgDuration * (score.stats.totalTasks - 1) + durationMs) /
        score.stats.totalTasks;
      score.stats.lastActive = Date.now();

      // Update components
      score.components.successRate =
        score.stats.successfulTasks / score.stats.totalTasks;

      // Speed: normalized 0-1 (faster = higher; 10s baseline)
      score.components.avgSpeed = Math.max(
        0,
        Math.min(1, 1 - (score.stats.avgDuration - 1000) / 10000)
      );

      // Task complexity: rolling average
      score.components.taskComplexity =
        score.components.taskComplexity * 0.9 + taskComplexity * 0.1;

      // Composite score
      const composite = this.computeComposite(score.components);
      const oldRank = score.rank;
      score.score = composite;
      score.rank = this.scoreToRank(composite);

      // Record rank change
      if (score.rank !== oldRank) {
        score.history.push({
          timestamp: Date.now(),
          score: composite,
          rank: score.rank,
        });
        if (score.history.length > 50) score.history.shift();
      }

      await this.save(score);
      return score;
    });
  }

  /**
   * Get agent score (with decay applied).
   */
  async getScore(agentId: string): Promise<AgentScore | null> {
    if (!this.redis) return null;
    const data = await this.redis.get(`${KEY_PREFIX}${agentId}`);
    if (!data) return null;

    const score = safeJsonParse<AgentScore | null>(data, null);
    if (!score) return null;
    return this.applyDecay(score);
  }

  /**
   * Get leaderboard of top N agents.
   */
  async getLeaderboard(limit: number = 10): Promise<AgentScore[]> {
    if (!this.redis) return [];

    const keys = await this.redis.keys(`${KEY_PREFIX}*`);
    const scores: AgentScore[] = [];

    for (const key of keys) {
      const data = await this.redis.get(key);
      if (data) {
        const parsed = safeJsonParse<AgentScore | null>(data, null);
        if (parsed) {
          scores.push(this.applyDecay(parsed));
        }
      }
    }

    scores.sort((a, b) => b.score - a.score);
    return scores.slice(0, limit);
  }

  /**
   * Suggest best agent for a task type based on ranking.
   */
  async suggestAgent(requiredRank?: AgentRank): Promise<AgentScore | null> {
    const board = await this.getLeaderboard(50);
    let candidates = board;

    if (requiredRank) {
      const minValue = this.rankValue(requiredRank);
      candidates = candidates.filter((a) => this.rankValue(a.rank) >= minValue);
    }

    return candidates.length > 0 ? candidates[0] : null;
  }

  /**
   * Manually promote an agent.
   */
  async promote(agentId: string): Promise<AgentScore | null> {
    if (!this.redis) return null;

    return this.withAgentLock(agentId, async () => {
      const score = await this.getScore(agentId);
      if (!score) return null;

      const ranks: AgentRank[] = ['bronze', 'silver', 'gold', 'platinum', 'diamond'];
      const idx = ranks.indexOf(score.rank);
      if (idx >= ranks.length - 1) return score;

      score.rank = ranks[idx + 1];
      // Set score to at least the new rank's threshold to prevent decay from reverting
      score.score = Math.max(score.score, RANK_THRESHOLDS[score.rank]);
      score.history.push({ timestamp: Date.now(), score: score.score, rank: score.rank });
      if (score.history.length > 50) score.history.shift();

      await this.save(score);
      return score;
    });
  }

  /**
   * Manually demote an agent.
   */
  async demote(agentId: string): Promise<AgentScore | null> {
    if (!this.redis) return null;

    return this.withAgentLock(agentId, async () => {
      const score = await this.getScore(agentId);
      if (!score) return null;

      const ranks: AgentRank[] = ['bronze', 'silver', 'gold', 'platinum', 'diamond'];
      const idx = ranks.indexOf(score.rank);
      if (idx <= 0) return score;

      score.rank = ranks[idx - 1];
      // Cap score to below the old rank's threshold to prevent decay from reverting
      score.score = Math.min(score.score, RANK_THRESHOLDS[ranks[idx]] - 1);
      score.history.push({ timestamp: Date.now(), score: score.score, rank: score.rank });
      if (score.history.length > 50) score.history.shift();

      await this.save(score);
      return score;
    });
  }

  // --- Private helpers ---

  private initScore(agentId: string): AgentScore {
    return {
      agentId,
      score: 0,
      rank: 'bronze',
      components: {
        successRate: 0,
        avgSpeed: 0.5,
        taskComplexity: 0.5,
        collaborationQuality: 0.5,
      },
      stats: {
        totalTasks: 0,
        successfulTasks: 0,
        avgDuration: 2000,
        lastActive: Date.now(),
      },
      history: [],
    };
  }

  private computeComposite(c: AgentScore['components']): number {
    const raw =
      c.successRate * WEIGHTS.successRate * 1000 +
      c.avgSpeed * WEIGHTS.avgSpeed * 1000 +
      c.taskComplexity * WEIGHTS.taskComplexity * 1000 +
      c.collaborationQuality * WEIGHTS.collaborationQuality * 1000;
    return Math.round(Math.max(0, Math.min(1000, raw)));
  }

  private scoreToRank(score: number): AgentRank {
    if (score >= RANK_THRESHOLDS.diamond) return 'diamond';
    if (score >= RANK_THRESHOLDS.platinum) return 'platinum';
    if (score >= RANK_THRESHOLDS.gold) return 'gold';
    if (score >= RANK_THRESHOLDS.silver) return 'silver';
    return 'bronze';
  }

  private applyDecay(score: AgentScore): AgentScore {
    const daysSinceActive = (Date.now() - score.stats.lastActive) / DAY_MS;
    if (daysSinceActive < 1) return score;

    const factor = Math.pow(DECAY_RATE, daysSinceActive);
    score.score = Math.round(score.score * factor);
    score.rank = this.scoreToRank(score.score);
    return score;
  }

  private rankValue(rank: AgentRank): number {
    const vals: Record<AgentRank, number> = {
      bronze: 1, silver: 2, gold: 3, platinum: 4, diamond: 5,
    };
    return vals[rank];
  }

  private async save(score: AgentScore): Promise<void> {
    if (!this.redis) return;
    await this.redis.set(`${KEY_PREFIX}${score.agentId}`, JSON.stringify(score));
  }
}

// --- Singleton ---

let instance: AgentRankStore | null = null;

export function getAgentRankStore(): AgentRankStore {
  if (!instance) {
    instance = new AgentRankStore();
  }
  return instance;
}
