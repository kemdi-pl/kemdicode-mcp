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
 * RL Dopamine Module
 *
 * Provides immediate "dopamine hit" feedback signals for agent actions.
 * These signals are separate from shaped rewards and provide instant feedback.
 */

import { RedisBackedService } from '../infrastructure/redis/redis-backed-service.js';
import { Logger } from '../utils/logger.js';
import type {
  DopamineSignal,
  DopamineTrigger,
  DopamineStats,
  DopamineSignalType,
} from './types.js';
import { DOPAMINE_TRIGGERS, RL_KEYS } from './types.js';
import { randomBytes } from 'crypto';

/**
 * Dopamine Emitter configuration
 */
export interface DopamineEmitterConfig {
  /** Maximum signals to keep per agent */
  maxSignals?: number;
  /** Signal TTL in seconds */
  signalTtl?: number;
}

/**
 * Dopamine Emitter
 */
export class DopamineEmitter extends RedisBackedService {
  protected get serviceName() { return 'DopamineEmitter'; }
  private config: DopamineEmitterConfig;

  constructor(config: DopamineEmitterConfig = {}) {
    super();
    this.config = {
      maxSignals: config.maxSignals || 500,
      signalTtl: config.signalTtl || 3600, // 1 hour
    };
  }

  /**
   * Emit a dopamine signal
   */
  async emit(
    agentId: string,
    trigger: DopamineTrigger,
    options: {
      intensityMultiplier?: number;
      action?: string;
      customMessage?: string;
      duration?: number;
    } = {}
  ): Promise<DopamineSignal | null> {
    if (!this.isConnected() || !this.redis) return null;

    try {
      const config = DOPAMINE_TRIGGERS[trigger];
      const intensity = config.baseIntensity * (options.intensityMultiplier || 1.0);

      const signal: DopamineSignal = {
        id: `dopa_${Date.now()}_${randomBytes(4).toString('hex')}`,
        agentId,
        type: config.signalType,
        intensity: Math.max(-1, Math.min(1, intensity)), // Clamp to [-1, 1]
        trigger,
        timestamp: Date.now(),
        duration: options.duration,
        action: options.action,
        message: options.customMessage || config.message,
      };

      // Store signal
      const key = RL_KEYS.dopamine(agentId);
      await this.redis.zadd(key, signal.timestamp, JSON.stringify(signal));

      // Trim to max size
      const count = await this.redis.zcard(key);
      if (count > this.config.maxSignals!) {
        await this.redis.zremrangebyrank(key, 0, count - this.config.maxSignals! - 1);
      }

      // Set TTL
      await this.redis.expire(key, this.config.signalTtl!);

      return signal;
    } catch (error) {
      Logger.error('[DopamineEmitter] Error emitting signal:', error);
      return null;
    }
  }

  /**
   * Emit tool success signal
   */
  async toolSuccess(
    agentId: string,
    toolName: string,
    durationMs?: number
  ): Promise<DopamineSignal | null> {
    // Fast success (< 1 second) gets a bigger hit
    if (durationMs !== undefined && durationMs < 1000) {
      return this.emit(agentId, 'tool_fast_success', { action: toolName });
    }
    return this.emit(agentId, 'tool_success', { action: toolName });
  }

  /**
   * Emit tool failure signal
   */
  async toolFailure(agentId: string, toolName: string): Promise<DopamineSignal | null> {
    return this.emit(agentId, 'tool_failure', { action: toolName });
  }

  /**
   * Emit task completed signal
   */
  async taskCompleted(agentId: string, taskName?: string): Promise<DopamineSignal | null> {
    return this.emit(agentId, 'task_completed', {
      action: taskName,
      customMessage: taskName ? `Task completed: ${taskName}` : 'Task completed!',
    });
  }

  /**
   * Emit pattern discovered signal
   */
  async patternDiscovered(agentId: string, patternName?: string): Promise<DopamineSignal | null> {
    return this.emit(agentId, 'pattern_discovered', {
      customMessage: patternName ? `Pattern discovered: ${patternName}` : 'New pattern identified!',
    });
  }

  /**
   * Emit repeated error signal
   */
  async repeatedError(agentId: string, errorType?: string): Promise<DopamineSignal | null> {
    return this.emit(agentId, 'repeated_error', {
      customMessage: errorType ? `Repeated error: ${errorType}` : 'Repeated error detected',
    });
  }

  /**
   * Emit collaboration success signal
   */
  async collaborationSuccess(agentId: string, peerId?: string): Promise<DopamineSignal | null> {
    return this.emit(agentId, 'collaboration_success', {
      customMessage: peerId
        ? `Successful collaboration with ${peerId}`
        : 'Successful collaboration',
    });
  }

  /**
   * Get recent signals for an agent
   */
  async getRecentSignals(agentId: string, limit: number = 20): Promise<DopamineSignal[]> {
    if (!this.isConnected() || !this.redis) return [];

    try {
      const key = RL_KEYS.dopamine(agentId);
      const entries = await this.redis.zrevrange(key, 0, limit - 1);

      return entries
        .map((entry: string) => {
          try {
            return JSON.parse(entry) as DopamineSignal;
          } catch {
            return null;
          }
        })
        .filter((s: DopamineSignal | null): s is DopamineSignal => s !== null);
    } catch (error) {
      Logger.error('[DopamineEmitter] Error getting signals:', error);
      return [];
    }
  }

  /**
   * Get dopamine statistics
   */
  async getStats(agentId: string): Promise<DopamineStats | null> {
    if (!this.isConnected() || !this.redis) return null;

    try {
      const key = RL_KEYS.dopamine(agentId);
      const allSignals = await this.redis.zrange(key, 0, -1);

      if (allSignals.length === 0) {
        return null;
      }

      const signals = allSignals
        .map((s: string) => {
          try {
            return JSON.parse(s) as DopamineSignal;
          } catch {
            return null;
          }
        })
        .filter((s: DopamineSignal | null): s is DopamineSignal => s !== null);

      // Count by type
      const byType: Record<DopamineSignalType, number> = {
        spike: 0,
        dip: 0,
        sustained: 0,
        baseline: 0,
      };
      const byTrigger: Partial<Record<DopamineTrigger, number>> = {};
      let totalIntensity = 0;

      for (const signal of signals) {
        byType[signal.type]++;
        byTrigger[signal.trigger] = (byTrigger[signal.trigger] || 0) + 1;
        totalIntensity += signal.intensity;
      }

      // Get recent signals
      const recentSignals = signals.slice(-20).reverse();

      return {
        agentId,
        totalSignals: signals.length,
        byType,
        byTrigger: byTrigger as Record<DopamineTrigger, number>,
        averageIntensity: signals.length > 0 ? totalIntensity / signals.length : 0,
        recentSignals,
      };
    } catch (error) {
      Logger.error('[DopamineEmitter] Error getting stats:', error);
      return null;
    }
  }

  /**
   * Clear all signals for an agent
   */
  async clearSignals(agentId: string): Promise<boolean> {
    if (!this.isConnected() || !this.redis) return false;

    try {
      const key = RL_KEYS.dopamine(agentId);
      await this.redis.del(key);
      return true;
    } catch (error) {
      Logger.error('[DopamineEmitter] Error clearing signals:', error);
      return false;
    }
  }

}

// Singleton instance
let dopamineEmitter: DopamineEmitter | null = null;

/**
 * Get the global dopamine emitter
 */
export function getDopamineEmitter(): DopamineEmitter {
  if (!dopamineEmitter) {
    dopamineEmitter = new DopamineEmitter();
  }
  return dopamineEmitter;
}

/**
 * Reset the global dopamine emitter (for testing)
 */
export async function resetDopamineEmitter(): Promise<void> {
  if (dopamineEmitter) {
    try {
      await dopamineEmitter.disconnect();
    } catch (error) {
      Logger.error('[DopamineEmitter] Error during disconnect:', error);
    }
  }
  dopamineEmitter = null;
}
