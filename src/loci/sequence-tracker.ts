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
 * Sequence Tracker
 *
 * Tracks tool execution sequences and learns effective patterns.
 */

import { RedisBackedService } from '../infrastructure/redis/redis-backed-service.js';
import type { ToolSequence, SequenceRecommendation } from './types.js';
import { LOCI_KEYS } from './types.js';
import { randomBytes } from 'crypto';

/**
 * Sequence Tracker configuration
 */
export interface SequenceTrackerConfig {
  /** Minimum sequence length to track */
  minSequenceLength?: number;
  /** Maximum sequence length to track */
  maxSequenceLength?: number;
  /** Minimum occurrences before creating pattern */
  minOccurrences?: number;
  /** Maximum sequences to store per session */
  maxSequences?: number;
  /** Sequence TTL in seconds */
  sequenceTtl?: number;
}

/**
 * Sequence Tracker
 */
export class SequenceTracker extends RedisBackedService {
  protected get serviceName() { return 'SequenceTracker'; }
  private config: SequenceTrackerConfig;

  constructor(config: SequenceTrackerConfig = {}) {
    super();
    this.config = {
      minSequenceLength: config.minSequenceLength || 2,
      maxSequenceLength: config.maxSequenceLength || 5,
      minOccurrences: config.minOccurrences || 3,
      maxSequences: config.maxSequences || 100,
      sequenceTtl: config.sequenceTtl || 7200,
    };
  }

  /**
   * Record a tool execution
   */
  async recordToolExecution(
    agentId: string,
    sessionId: string,
    toolName: string,
    success: boolean,
    durationMs: number
  ): Promise<void> {
    if (!this.isConnected() || !this.redis) return;

    try {
      const chainKey = LOCI_KEYS.currentChain(agentId);

      // Get current chain
      const chainData = await this.redis.get(chainKey);
      const chain: Array<{ tool: string; success: boolean; duration: number; timestamp: number }> =
        chainData ? JSON.parse(chainData) : [];

      // Add to chain
      chain.push({
        tool: toolName,
        success,
        duration: durationMs,
        timestamp: Date.now(),
      });

      // Trim to max length
      if (chain.length > this.config.maxSequenceLength!) {
        chain.shift();
      }

      // Save chain
      await this.redis.set(chainKey, JSON.stringify(chain));
      await this.redis.expire(chainKey, 3600); // 1 hour TTL for active chains

      // Update transition matrix
      if (chain.length >= 2) {
        const prevTool = chain[chain.length - 2].tool;
        await this.updateTransitionMatrix(prevTool, toolName, success);
      }

      // Check for pattern creation
      if (chain.length >= this.config.minSequenceLength!) {
        await this.checkAndRecordPattern(sessionId, chain);
      }
    } catch (error) {
      console.error('[SequenceTracker] Error recording tool execution:', error);
    }
  }

  /**
   * Update the transition matrix
   */
  private async updateTransitionMatrix(
    fromTool: string,
    toTool: string,
    success: boolean
  ): Promise<void> {
    if (!this.redis) return;

    try {
      const key = LOCI_KEYS.transitions();
      const field = `${fromTool}:${toTool}`;

      const existing = await this.redis.hget(key, field);
      const data = existing ? JSON.parse(existing) : { count: 0, successes: 0, avgDuration: 0 };

      data.count += 1;
      if (success) data.successes += 1;

      await this.redis.hset(key, field, JSON.stringify(data));
    } catch (error) {
      console.error('[SequenceTracker] Error updating transition matrix:', error);
    }
  }

  /**
   * Check if current chain matches a known pattern and record it
   */
  private async checkAndRecordPattern(
    sessionId: string,
    chain: Array<{ tool: string; success: boolean; duration: number; timestamp: number }>
  ): Promise<void> {
    if (!this.redis) return;

    try {
      const tools = chain.map((c) => c.tool);
      const sequenceKey = tools.join('→');

      const sequencesKey = LOCI_KEYS.sequences(sessionId);
      const existing = await this.redis.hget(sequencesKey, sequenceKey);

      if (existing) {
        // Update existing sequence
        const sequence = JSON.parse(existing) as ToolSequence;
        sequence.occurrences += 1;
        sequence.lastObservedAt = Date.now();

        // Update success rate
        const successes = chain.filter((c) => c.success).length;
        const newSuccessRate = successes / chain.length;
        sequence.successRate =
          (sequence.successRate * (sequence.occurrences - 1) + newSuccessRate) /
          sequence.occurrences;

        // Update avg duration
        const totalDuration = chain.reduce((sum, c) => sum + c.duration, 0);
        sequence.avgDurationMs =
          (sequence.avgDurationMs * (sequence.occurrences - 1) + totalDuration) /
          sequence.occurrences;

        await this.redis.hset(sequencesKey, sequenceKey, JSON.stringify(sequence));
      } else {
        // Create new sequence
        const successes = chain.filter((c) => c.success).length;
        const totalDuration = chain.reduce((sum, c) => sum + c.duration, 0);

        const sequence: ToolSequence = {
          id: `seq_${Date.now()}_${randomBytes(4).toString('hex')}`,
          tools,
          occurrences: 1,
          successRate: successes / chain.length,
          avgDurationMs: totalDuration,
          contextTags: [],
          sessionId,
          lastObservedAt: Date.now(),
        };

        await this.redis.hset(sequencesKey, sequenceKey, JSON.stringify(sequence));
        await this.redis.expire(sequencesKey, this.config.sequenceTtl!);
      }
    } catch (error) {
      console.error('[SequenceTracker] Error checking pattern:', error);
    }
  }

  /**
   * Get recommendation for next tool
   */
  async recommend(agentId: string, sessionId: string): Promise<SequenceRecommendation | null> {
    if (!this.isConnected() || !this.redis) return null;

    try {
      // Get current chain
      const chainKey = LOCI_KEYS.currentChain(agentId);
      const chainData = await this.redis.get(chainKey);

      if (!chainData) {
        return null;
      }

      const chain: Array<{ tool: string }> = JSON.parse(chainData);
      if (chain.length === 0) return null;

      const currentTool = chain[chain.length - 1].tool;

      // Get transitions from current tool
      const transitionsKey = LOCI_KEYS.transitions();
      const allTransitions = await this.redis.hgetall(transitionsKey);

      const candidates: Array<{ tool: string; score: number; count: number }> = [];

      for (const [field, data] of Object.entries(allTransitions)) {
        if (field.startsWith(`${currentTool}:`)) {
          const toTool = field.split(':')[1];
          const parsed = JSON.parse(data as string);
          const successRate = parsed.count > 0 ? parsed.successes / parsed.count : 0;
          const score = successRate * Math.log(parsed.count + 1); // Balance success rate and frequency

          candidates.push({ tool: toTool, score, count: parsed.count });
        }
      }

      if (candidates.length === 0) {
        return null;
      }

      // Sort by score
      candidates.sort((a, b) => b.score - a.score);

      const best = candidates[0];
      const alternatives = candidates.slice(1, 4).map((c) => ({
        tool: c.tool,
        confidence: c.score / (best.score || 1),
      }));

      // Find matching patterns
      const sequencesKey = LOCI_KEYS.sequences(sessionId);
      const allSequences = await this.redis.hgetall(sequencesKey);
      const matchingPatterns: string[] = [];

      for (const [key, value] of Object.entries(allSequences)) {
        const sequence = JSON.parse(value as string) as ToolSequence;
        if (
          sequence.tools.includes(currentTool) &&
          sequence.occurrences >= this.config.minOccurrences!
        ) {
          matchingPatterns.push(key);
        }
      }

      return {
        nextTool: best.tool,
        confidence: Math.min(1, best.score),
        basedOnPatterns: matchingPatterns.slice(0, 5),
        alternatives,
      };
    } catch (error) {
      console.error('[SequenceTracker] Error getting recommendation:', error);
      return null;
    }
  }

  /**
   * Get all learned sequences for a session
   */
  async getSequences(sessionId: string): Promise<ToolSequence[]> {
    if (!this.isConnected() || !this.redis) return [];

    try {
      const key = LOCI_KEYS.sequences(sessionId);
      const allSequences = await this.redis.hgetall(key);

      const sequences: ToolSequence[] = [];
      for (const value of Object.values(allSequences)) {
        try {
          sequences.push(JSON.parse(value as string));
        } catch {
          // Skip malformed entries
        }
      }

      // Sort by occurrences and success rate
      return sequences
        .filter((s) => s.occurrences >= this.config.minOccurrences!)
        .sort((a, b) => {
          const scoreA = a.occurrences * a.successRate;
          const scoreB = b.occurrences * b.successRate;
          return scoreB - scoreA;
        });
    } catch (error) {
      console.error('[SequenceTracker] Error getting sequences:', error);
      return [];
    }
  }

  /**
   * Get transition statistics
   */
  async getTransitionStats(): Promise<
    Array<{ from: string; to: string; count: number; successRate: number }>
  > {
    if (!this.isConnected() || !this.redis) return [];

    try {
      const key = LOCI_KEYS.transitions();
      const allTransitions = await this.redis.hgetall(key);

      const stats: Array<{ from: string; to: string; count: number; successRate: number }> = [];

      for (const [field, data] of Object.entries(allTransitions)) {
        const [from, to] = field.split(':');
        const parsed = JSON.parse(data as string);

        stats.push({
          from,
          to,
          count: parsed.count,
          successRate: parsed.count > 0 ? parsed.successes / parsed.count : 0,
        });
      }

      return stats.sort((a, b) => b.count - a.count);
    } catch (error) {
      console.error('[SequenceTracker] Error getting transition stats:', error);
      return [];
    }
  }

  /**
   * Clear agent's current chain
   */
  async clearChain(agentId: string): Promise<boolean> {
    if (!this.isConnected() || !this.redis) return false;

    try {
      const key = LOCI_KEYS.currentChain(agentId);
      await this.redis.del(key);
      return true;
    } catch (error) {
      console.error('[SequenceTracker] Error clearing chain:', error);
      return false;
    }
  }

}

// Singleton instance
let sequenceTracker: SequenceTracker | null = null;

/**
 * Get the global sequence tracker
 */
export function getSequenceTracker(): SequenceTracker {
  if (!sequenceTracker) {
    sequenceTracker = new SequenceTracker();
  }
  return sequenceTracker;
}

/**
 * Reset the global sequence tracker (for testing)
 */
export function resetSequenceTracker(): void {
  if (sequenceTracker) {
    sequenceTracker.disconnect().catch(console.error);
  }
  sequenceTracker = null;
}
