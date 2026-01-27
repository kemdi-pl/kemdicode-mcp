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
 * RL State Tracker
 *
 * Captures and persists agent state for reward calculation.
 */

import { Redis } from 'ioredis';
import type { AgentState } from './types.js';
import { RL_KEYS } from './types.js';

/**
 * State Tracker configuration
 */
export interface StateTrackerConfig {
  host?: string;
  port?: number;
  password?: string;
  db?: number;
  /** Maximum state history entries to keep */
  maxHistorySize?: number;
  /** State history TTL in seconds */
  historyTtl?: number;
}

/**
 * State update for capturing post-action state
 */
export interface StateUpdate {
  /** Whether the tool succeeded */
  toolSuccess?: boolean;
  /** Name of tool executed */
  toolName?: string;
  /** Task progress change (0-1) */
  taskProgressDelta?: number;
  /** Whether there was an error */
  hasError?: boolean;
  /** Whether peer interaction occurred */
  peerInteraction?: boolean;
  /** Task description update */
  currentTask?: string;
}

/**
 * RL State Tracker
 */
export class StateTracker {
  private redis: Redis | null = null;
  private connected = false;
  private config: StateTrackerConfig;

  constructor(config: StateTrackerConfig = {}) {
    this.config = {
      host: config.host || process.env.REDIS_HOST || '127.0.0.1',
      port: config.port || parseInt(process.env.REDIS_PORT || '6379', 10),
      password: config.password || process.env.REDIS_PASSWORD,
      db: config.db ?? 2,
      maxHistorySize: config.maxHistorySize || 1000,
      historyTtl: config.historyTtl || 3600, // 1 hour
    };
  }

  /**
   * Connect to Redis
   */
  async connect(): Promise<void> {
    if (this.connected) return;

    try {
      this.redis = new Redis({
        host: this.config.host,
        port: this.config.port,
        password: this.config.password,
        db: this.config.db,
        lazyConnect: true,
        retryStrategy: (times: number) => {
          if (times > 3) return null;
          return Math.min(times * 100, 3000);
        },
      });

      await this.redis.connect();
      this.connected = true;
    } catch (error) {
      console.error('[StateTracker] Failed to connect to Redis:', error);
      this.redis = null;
      throw error;
    }
  }

  /**
   * Disconnect from Redis
   */
  async disconnect(): Promise<void> {
    if (this.redis) {
      await this.redis.quit();
      this.redis = null;
      this.connected = false;
    }
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.connected && this.redis !== null;
  }

  /**
   * Get current state for an agent
   */
  async getState(agentId: string): Promise<AgentState | null> {
    if (!this.isConnected() || !this.redis) return null;

    try {
      const key = RL_KEYS.state(agentId);
      const data = await this.redis.hgetall(key);

      if (!data || Object.keys(data).length === 0) {
        return null;
      }

      return this.parseState(data);
    } catch (error) {
      console.error('[StateTracker] Error getting state:', error);
      return null;
    }
  }

  /**
   * Capture current state (for pre-action snapshot)
   */
  async captureState(agentId: string, sessionId: string): Promise<AgentState> {
    const existing = await this.getState(agentId);

    if (existing) {
      // Update state age
      existing.stateAge = Date.now() - existing.timestamp;
      existing.timestamp = Date.now();
      return existing;
    }

    // Create initial state
    return {
      agentId,
      timestamp: Date.now(),
      taskProgress: 0,
      toolSuccessRate: 1.0, // Start optimistic
      peerInteractions: 0,
      errorCount: 0,
      consecutiveErrors: 0,
      stateAge: 0,
      sessionId,
      totalToolCalls: 0,
      successfulToolCalls: 0,
    };
  }

  /**
   * Update state after action
   */
  async updateState(agentId: string, update: StateUpdate): Promise<AgentState | null> {
    if (!this.isConnected() || !this.redis) return null;

    const currentState = await this.getState(agentId);
    if (!currentState) return null;

    try {
      const now = Date.now();

      // Calculate new values
      const newTotalCalls = currentState.totalToolCalls + 1;
      const newSuccessfulCalls = currentState.successfulToolCalls + (update.toolSuccess ? 1 : 0);
      const newSuccessRate = newTotalCalls > 0 ? newSuccessfulCalls / newTotalCalls : 1.0;

      const newState: AgentState = {
        ...currentState,
        timestamp: now,
        stateAge: now - currentState.timestamp,
        taskProgress: Math.min(
          1.0,
          Math.max(0, currentState.taskProgress + (update.taskProgressDelta || 0))
        ),
        toolSuccessRate: newSuccessRate,
        peerInteractions: currentState.peerInteractions + (update.peerInteraction ? 1 : 0),
        errorCount: currentState.errorCount + (update.hasError ? 1 : 0),
        consecutiveErrors: update.hasError ? currentState.consecutiveErrors + 1 : 0, // Reset on success
        currentTool: update.toolName,
        currentTask: update.currentTask || currentState.currentTask,
        totalToolCalls: newTotalCalls,
        successfulToolCalls: newSuccessfulCalls,
      };

      // Save updated state
      await this.saveState(newState);

      // Add to history
      await this.addToHistory(newState);

      return newState;
    } catch (error) {
      console.error('[StateTracker] Error updating state:', error);
      return null;
    }
  }

  /**
   * Save state to Redis
   */
  async saveState(state: AgentState): Promise<boolean> {
    if (!this.isConnected() || !this.redis) return false;

    try {
      const key = RL_KEYS.state(state.agentId);
      await this.redis.hset(key, this.serializeState(state));
      return true;
    } catch (error) {
      console.error('[StateTracker] Error saving state:', error);
      return false;
    }
  }

  /**
   * Add state to history
   */
  private async addToHistory(state: AgentState): Promise<void> {
    if (!this.redis) return;

    try {
      const key = RL_KEYS.stateHistory(state.agentId);
      const serialized = JSON.stringify(state);

      // Add to sorted set with timestamp as score
      await this.redis.zadd(key, state.timestamp, serialized);

      // Trim to max size
      const count = await this.redis.zcard(key);
      if (count > this.config.maxHistorySize!) {
        await this.redis.zremrangebyrank(key, 0, count - this.config.maxHistorySize! - 1);
      }

      // Set TTL
      await this.redis.expire(key, this.config.historyTtl!);
    } catch (error) {
      console.error('[StateTracker] Error adding to history:', error);
    }
  }

  /**
   * Get state history
   */
  async getHistory(agentId: string, limit: number = 100): Promise<AgentState[]> {
    if (!this.isConnected() || !this.redis) return [];

    try {
      const key = RL_KEYS.stateHistory(agentId);
      const entries = await this.redis.zrevrange(key, 0, limit - 1);

      return entries
        .map((entry: string) => {
          try {
            return JSON.parse(entry) as AgentState;
          } catch {
            return null;
          }
        })
        .filter((s: AgentState | null): s is AgentState => s !== null);
    } catch (error) {
      console.error('[StateTracker] Error getting history:', error);
      return [];
    }
  }

  /**
   * Initialize state for a new agent
   */
  async initializeState(agentId: string, sessionId: string): Promise<AgentState> {
    const initialState: AgentState = {
      agentId,
      timestamp: Date.now(),
      taskProgress: 0,
      toolSuccessRate: 1.0,
      peerInteractions: 0,
      errorCount: 0,
      consecutiveErrors: 0,
      stateAge: 0,
      sessionId,
      totalToolCalls: 0,
      successfulToolCalls: 0,
    };

    await this.saveState(initialState);
    return initialState;
  }

  /**
   * Reset state for an agent
   */
  async resetState(agentId: string): Promise<boolean> {
    if (!this.isConnected() || !this.redis) return false;

    try {
      const stateKey = RL_KEYS.state(agentId);
      const historyKey = RL_KEYS.stateHistory(agentId);

      await this.redis.del(stateKey, historyKey);
      return true;
    } catch (error) {
      console.error('[StateTracker] Error resetting state:', error);
      return false;
    }
  }

  /**
   * Serialize state for Redis
   */
  private serializeState(state: AgentState): Record<string, string | number> {
    return {
      agentId: state.agentId,
      timestamp: state.timestamp,
      taskProgress: state.taskProgress,
      toolSuccessRate: state.toolSuccessRate,
      peerInteractions: state.peerInteractions,
      errorCount: state.errorCount,
      consecutiveErrors: state.consecutiveErrors,
      stateAge: state.stateAge,
      currentTool: state.currentTool || '',
      currentTask: state.currentTask || '',
      sessionId: state.sessionId,
      totalToolCalls: state.totalToolCalls,
      successfulToolCalls: state.successfulToolCalls,
    };
  }

  /**
   * Parse state from Redis data
   */
  private parseState(data: Record<string, string>): AgentState {
    return {
      agentId: data.agentId,
      timestamp: parseInt(data.timestamp, 10),
      taskProgress: parseFloat(data.taskProgress),
      toolSuccessRate: parseFloat(data.toolSuccessRate),
      peerInteractions: parseInt(data.peerInteractions, 10),
      errorCount: parseInt(data.errorCount, 10),
      consecutiveErrors: parseInt(data.consecutiveErrors, 10),
      stateAge: parseInt(data.stateAge, 10),
      currentTool: data.currentTool || undefined,
      currentTask: data.currentTask || undefined,
      sessionId: data.sessionId,
      totalToolCalls: parseInt(data.totalToolCalls, 10),
      successfulToolCalls: parseInt(data.successfulToolCalls, 10),
    };
  }

  /**
   * Inject Redis instance (for testing)
   */
  injectRedis(redis: Redis): void {
    this.redis = redis;
    this.connected = true;
  }
}

// Singleton instance
let stateTracker: StateTracker | null = null;

/**
 * Get the global state tracker
 */
export function getStateTracker(): StateTracker {
  if (!stateTracker) {
    stateTracker = new StateTracker();
  }
  return stateTracker;
}

/**
 * Reset the global state tracker (for testing)
 */
export function resetStateTracker(): void {
  if (stateTracker) {
    stateTracker.disconnect().catch(console.error);
  }
  stateTracker = null;
}
