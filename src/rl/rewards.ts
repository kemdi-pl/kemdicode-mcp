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
 * RL Rewards Module
 *
 * Handles intrinsic reward assignment and shaped reward calculation.
 */

import { RedisBackedService } from '../infrastructure/redis/redis-backed-service.js';
import type {
  AgentState,
  ShapedReward,
  IntrinsicRewards,
  RewardHistoryEntry,
  RewardStats,
  PotentialWeights,
} from './types.js';
import { DEFAULT_INTRINSIC_REWARDS, DEFAULT_POTENTIAL_WEIGHTS, RL_KEYS, GAMMA } from './types.js';
import { calculatePotential } from './potential.js';
import { randomBytes } from 'crypto';

/**
 * Reward Tracker configuration
 */
export interface RewardTrackerConfig {
  /** Maximum reward history entries */
  maxHistorySize?: number;
  /** Reward history TTL in seconds */
  historyTtl?: number;
}

/**
 * Get intrinsic reward for an event
 */
export function getIntrinsicReward(
  event: keyof IntrinsicRewards,
  rewards: IntrinsicRewards = DEFAULT_INTRINSIC_REWARDS
): number {
  return rewards[event] || 0;
}

/**
 * Calculate the shaped reward
 */
export function shapeReward(
  intrinsicReward: number,
  preState: AgentState,
  postState: AgentState,
  weights: PotentialWeights = DEFAULT_POTENTIAL_WEIGHTS
): ShapedReward {
  const previousPotential = calculatePotential(preState, weights);
  const currentPotential = calculatePotential(postState, weights);

  // R_shaped = r + γ * Φ(s') - Φ(s)
  const shapedReward = intrinsicReward + GAMMA * currentPotential - previousPotential;

  return {
    intrinsicReward,
    previousPotential,
    currentPotential,
    gamma: GAMMA,
    shapedReward,
    timestamp: Date.now(),
    agentId: postState.agentId,
  };
}

/**
 * Reward Tracker
 */
export class RewardTracker extends RedisBackedService {
  protected get serviceName() { return 'RewardTracker'; }
  private config: RewardTrackerConfig;
  private weights: PotentialWeights;
  private intrinsicRewards: IntrinsicRewards;

  constructor(config: RewardTrackerConfig = {}) {
    super();
    this.config = {
      maxHistorySize: config.maxHistorySize || 1000,
      historyTtl: config.historyTtl || 7200, // 2 hours
    };
    this.weights = { ...DEFAULT_POTENTIAL_WEIGHTS };
    this.intrinsicRewards = { ...DEFAULT_INTRINSIC_REWARDS };
  }

  /**
   * Record a reward
   */
  async recordReward(
    action: string,
    preState: AgentState,
    postState: AgentState,
    intrinsicReward: number
  ): Promise<ShapedReward | null> {
    if (!this.isConnected() || !this.redis) return null;

    try {
      const shaped = shapeReward(intrinsicReward, preState, postState, this.weights);
      shaped.action = action;

      const entry: RewardHistoryEntry = {
        id: `reward_${Date.now()}_${randomBytes(4).toString('hex')}`,
        reward: shaped,
        preState,
        postState,
        action,
        sessionId: postState.sessionId,
      };

      // Store in sorted set by timestamp
      const key = RL_KEYS.rewards(postState.agentId);
      await this.redis.zadd(key, shaped.timestamp, JSON.stringify(entry));

      // Trim to max size
      const count = await this.redis.zcard(key);
      if (count > this.config.maxHistorySize!) {
        await this.redis.zremrangebyrank(key, 0, count - this.config.maxHistorySize! - 1);
      }

      // Update running stats
      await this.updateRunningStats(postState.agentId, shaped, action);

      // Set TTL
      await this.redis.expire(key, this.config.historyTtl!);

      return shaped;
    } catch (error) {
      console.error('[RewardTracker] Error recording reward:', error);
      return null;
    }
  }

  /**
   * Update running statistics
   */
  private async updateRunningStats(
    agentId: string,
    reward: ShapedReward,
    action: string
  ): Promise<void> {
    if (!this.redis) return;

    try {
      const key = RL_KEYS.runningStats(agentId);

      // Get current stats
      const stats = await this.redis.hgetall(key);

      const count = (parseInt(stats.count || '0', 10) || 0) + 1;
      const total = (parseFloat(stats.total || '0') || 0) + reward.shapedReward;
      const max = Math.max(parseFloat(stats.max || '0') || -Infinity, reward.shapedReward);
      const min = Math.min(parseFloat(stats.min || '0') || Infinity, reward.shapedReward);

      await this.redis.hset(key, {
        count: count.toString(),
        total: total.toString(),
        max: max.toString(),
        min: min.toString(),
        lastAction: action,
        lastReward: reward.shapedReward.toString(),
        lastTimestamp: Date.now().toString(),
      });

      // Update tool-specific stats
      const toolKey = RL_KEYS.toolPerformance(agentId);
      const toolStats = await this.redis.hget(toolKey, action);
      const parsed = toolStats ? JSON.parse(toolStats) : { count: 0, total: 0 };
      parsed.count += 1;
      parsed.total += reward.shapedReward;
      await this.redis.hset(toolKey, action, JSON.stringify(parsed));
    } catch (error) {
      console.error('[RewardTracker] Error updating stats:', error);
    }
  }

  /**
   * Get reward history
   */
  async getRewardHistory(agentId: string, limit: number = 50): Promise<RewardHistoryEntry[]> {
    if (!this.isConnected() || !this.redis) return [];

    try {
      const key = RL_KEYS.rewards(agentId);
      const entries = await this.redis.zrevrange(key, 0, limit - 1);

      return entries
        .map((entry: string) => {
          try {
            return JSON.parse(entry) as RewardHistoryEntry;
          } catch {
            return null;
          }
        })
        .filter((e: RewardHistoryEntry | null): e is RewardHistoryEntry => e !== null);
    } catch (error) {
      console.error('[RewardTracker] Error getting history:', error);
      return [];
    }
  }

  /**
   * Get reward statistics
   */
  async getStats(agentId: string, sessionId: string): Promise<RewardStats | null> {
    if (!this.isConnected() || !this.redis) return null;

    try {
      const statsKey = RL_KEYS.runningStats(agentId);
      const toolKey = RL_KEYS.toolPerformance(agentId);

      const [stats, toolStats] = await Promise.all([
        this.redis.hgetall(statsKey),
        this.redis.hgetall(toolKey),
      ]);

      if (!stats || Object.keys(stats).length === 0) {
        return null;
      }

      const count = parseInt(stats.count || '0', 10) || 0;
      const total = parseFloat(stats.total || '0') || 0;
      const max = parseFloat(stats.max || '0') || 0;
      const min = parseFloat(stats.min || '0') || 0;

      // Parse tool stats
      const rewardsByTool: Record<string, { count: number; total: number; average: number }> = {};
      for (const [tool, data] of Object.entries(toolStats)) {
        try {
          const parsed = JSON.parse(data as string);
          rewardsByTool[tool] = {
            count: parsed.count,
            total: parsed.total,
            average: parsed.count > 0 ? parsed.total / parsed.count : 0,
          };
        } catch {
          // Skip malformed entries
        }
      }

      // Calculate trend from recent history
      const history = await this.getRewardHistory(agentId, 20);
      let recentTrend: 'improving' | 'declining' | 'stable' = 'stable';
      if (history.length >= 10) {
        const recent = history.slice(0, 10).reduce((sum, e) => sum + e.reward.shapedReward, 0) / 10;
        const older =
          history.slice(10, 20).reduce((sum, e) => sum + e.reward.shapedReward, 0) /
          Math.max(1, history.slice(10, 20).length);
        if (recent > older * 1.1) recentTrend = 'improving';
        else if (recent < older * 0.9) recentTrend = 'declining';
      }

      return {
        agentId,
        sessionId,
        totalRewards: count,
        averageReward: count > 0 ? total / count : 0,
        maxReward: max,
        minReward: min,
        cumulativeReward: total,
        rewardCount: count,
        rewardsByTool,
        recentTrend,
        timeRange: {
          start: history.length > 0 ? history[history.length - 1].reward.timestamp : Date.now(),
          end: history.length > 0 ? history[0].reward.timestamp : Date.now(),
        },
      };
    } catch (error) {
      console.error('[RewardTracker] Error getting stats:', error);
      return null;
    }
  }

  /**
   * Update potential weights
   */
  setWeights(weights: Partial<PotentialWeights>): void {
    this.weights = { ...this.weights, ...weights };
  }

  /**
   * Update intrinsic rewards
   */
  setIntrinsicRewards(rewards: Partial<IntrinsicRewards>): void {
    this.intrinsicRewards = { ...this.intrinsicRewards, ...rewards };
  }

  /**
   * Get current weights
   */
  getWeights(): PotentialWeights {
    return { ...this.weights };
  }

  /**
   * Get current intrinsic rewards
   */
  getIntrinsicRewards(): IntrinsicRewards {
    return { ...this.intrinsicRewards };
  }

}

// Singleton instance
let rewardTracker: RewardTracker | null = null;

/**
 * Get the global reward tracker
 */
export function getRewardTracker(): RewardTracker {
  if (!rewardTracker) {
    rewardTracker = new RewardTracker();
  }
  return rewardTracker;
}

/**
 * Reset the global reward tracker (for testing)
 */
export function resetRewardTracker(): void {
  if (rewardTracker) {
    rewardTracker.disconnect().catch(console.error);
  }
  rewardTracker = null;
}
