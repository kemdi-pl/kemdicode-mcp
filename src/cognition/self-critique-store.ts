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
 * Self-Critique Store
 *
 * Redis-backed persistence for post-session reflection.
 * Enables AI agents to review their own process: what went well,
 * what went poorly, and what lessons to carry forward.
 *
 * @module cognition/self-critique-store
 */

import { RedisBackedService } from '../infrastructure/redis/redis-backed-service.js';
import { Logger } from '../utils/logger.js';
import type { SelfCritique, CritiqueScope } from './types.js';
import { COGNITION_KEYS, COGNITION_TTL } from './types.js';
import { getCognitionEventBus } from './event-bus.js';
import { randomBytes } from 'crypto';

/**
 * SelfCritiqueStore — Redis-backed CRUD for Self-Critique Log entries.
 *
 * Stores reflections indexed by session in sorted sets (scored by timestamp)
 * so that agents can review their process and extract cross-session lessons.
 */
export class SelfCritiqueStore extends RedisBackedService {
  protected get serviceName() { return 'SelfCritiqueStore'; }

  /**
   * Generate a unique critique ID.
   */
  generateId(): string {
    return `critique_${Date.now()}_${randomBytes(4).toString('hex')}`;
  }

  /**
   * Record a new self-critique.
   *
   * Stores the critique as a JSON string, indexes it by session
   * in a sorted set (scored by timestamp), and sets the configured TTL.
   *
   * @param critique - Critique data without id and timestamp (auto-generated)
   * @returns The full critique record, or null on failure
   */
  async record(
    critique: Omit<SelfCritique, 'id' | 'timestamp'>
  ): Promise<SelfCritique | null> {
    if (!this.isConnected() || !this.redis) {
      try {
        await this.connect();
      } catch {
        Logger.error('[SelfCritiqueStore] Cannot connect to Redis');
        return null;
      }
    }

    try {
      const id = this.generateId();
      const timestamp = Date.now();

      const full: SelfCritique = {
        id,
        timestamp,
        ...critique,
      };

      const key = COGNITION_KEYS.critique(id);
      await this.redis!.set(key, JSON.stringify(full));

      // Index by session (sorted set, score = timestamp)
      const sessionKey = COGNITION_KEYS.critiquesBySession(critique.sessionId);
      await this.redis!.zadd(sessionKey, timestamp, id);

      // Set TTL on the critique key and session index
      if (COGNITION_TTL.critique > 0) {
        await this.redis!.expire(key, COGNITION_TTL.critique);
        await this.redis!.expire(sessionKey, COGNITION_TTL.critique);
      }

      // Emit events for cross-tool reactions
      const bus = getCognitionEventBus();
      bus.emit({
        type: 'critique:recorded',
        timestamp: full.timestamp,
        sessionId: full.sessionId,
        agentId: full.agentId,
        sourceId: full.id,
        sourceType: 'critique',
        payload: { scope: full.scope, lessonsLearned: full.lessonsLearned },
      });
      if (full.lessonsLearned.length > 0) {
        bus.emit({
          type: 'critique:lesson-learned',
          timestamp: full.timestamp,
          sessionId: full.sessionId,
          agentId: full.agentId,
          sourceId: full.id,
          sourceType: 'critique',
          payload: { lessons: full.lessonsLearned },
        });
      }
      return full;
    } catch (error) {
      Logger.error('[SelfCritiqueStore] Error recording critique:', error);
      return null;
    }
  }

  /**
   * Get a critique by its ID.
   *
   * @param id - Critique ID
   * @returns The critique record, or null if not found
   */
  async get(id: string): Promise<SelfCritique | null> {
    if (!this.isConnected() || !this.redis) {
      try {
        await this.connect();
      } catch {
        return null;
      }
    }

    try {
      const data = await this.redis!.get(COGNITION_KEYS.critique(id));
      if (!data) return null;
      return JSON.parse(data) as SelfCritique;
    } catch (error) {
      Logger.error('[SelfCritiqueStore] Error getting critique:', error);
      return null;
    }
  }

  /**
   * List critiques for a session, newest first.
   *
   * @param sessionId - Session to query
   * @param limit - Maximum number of critiques to return (default: 10)
   */
  async listBySession(sessionId: string, limit: number = 10): Promise<SelfCritique[]> {
    if (!this.isConnected() || !this.redis) {
      try {
        await this.connect();
      } catch {
        return [];
      }
    }

    try {
      const key = COGNITION_KEYS.critiquesBySession(sessionId);
      const ids = await this.redis!.zrevrange(key, 0, limit - 1);

      if (ids.length === 0) return [];

      const critiques: SelfCritique[] = [];
      for (const id of ids) {
        const data = await this.redis!.get(COGNITION_KEYS.critique(id));
        if (data) {
          try {
            critiques.push(JSON.parse(data) as SelfCritique);
          } catch {
            // Skip malformed entries
          }
        }
      }

      return critiques;
    } catch (error) {
      Logger.error('[SelfCritiqueStore] Error listing critiques by session:', error);
      return [];
    }
  }

  /**
   * List critiques filtered by scope across all sessions, newest first.
   *
   * Scans all session sorted-set keys, loads critiques, and filters by scope.
   *
   * @param scope - Critique scope to filter by ('session' | 'task' | 'decision')
   * @param limit - Maximum number of critiques to return (default: 10)
   */
  async listByScope(scope: CritiqueScope, limit: number = 10): Promise<SelfCritique[]> {
    if (!this.isConnected() || !this.redis) {
      try {
        await this.connect();
      } catch {
        return [];
      }
    }

    try {
      // Scan for all session sorted-set keys
      const allIds: string[] = [];
      let cursor = '0';

      do {
        const [nextCursor, keys] = await this.redis!.scan(
          cursor,
          'MATCH',
          'mcp:cognition:critiques:session:*',
          'COUNT',
          100
        );
        cursor = nextCursor;

        for (const key of keys) {
          const ids = await this.redis!.zrevrange(key, 0, -1);
          allIds.push(...ids);
        }
      } while (cursor !== '0');

      // Deduplicate IDs
      const uniqueIds = [...new Set(allIds)];

      // Load and filter by scope
      const critiques: SelfCritique[] = [];
      for (const id of uniqueIds) {
        if (critiques.length >= limit) break;

        const data = await this.redis!.get(COGNITION_KEYS.critique(id));
        if (!data) continue;

        try {
          const critique = JSON.parse(data) as SelfCritique;
          if (critique.scope === scope) {
            critiques.push(critique);
          }
        } catch {
          // Skip malformed entries
        }
      }

      // Sort newest first
      critiques.sort((a, b) => b.timestamp - a.timestamp);

      return critiques.slice(0, limit);
    } catch (error) {
      Logger.error('[SelfCritiqueStore] Error listing critiques by scope:', error);
      return [];
    }
  }

  /**
   * Aggregate all lessonsLearned from all critiques across all sessions.
   *
   * Scans all session indices, loads every critique, collects unique lessons.
   *
   * @param limit - Maximum number of unique lessons to return (default: 20)
   * @returns Deduplicated list of lessons learned
   */
  async getLessonsLearned(limit: number = 20): Promise<string[]> {
    if (!this.isConnected() || !this.redis) {
      try {
        await this.connect();
      } catch {
        return [];
      }
    }

    try {
      const allIds: string[] = [];
      let cursor = '0';

      do {
        const [nextCursor, keys] = await this.redis!.scan(
          cursor,
          'MATCH',
          'mcp:cognition:critiques:session:*',
          'COUNT',
          100
        );
        cursor = nextCursor;

        for (const key of keys) {
          const ids = await this.redis!.zrevrange(key, 0, -1);
          allIds.push(...ids);
        }
      } while (cursor !== '0');

      // Deduplicate IDs
      const uniqueIds = [...new Set(allIds)];

      // Collect all lessons, deduplicate by normalized string
      const lessonsSet = new Map<string, string>();

      for (const id of uniqueIds) {
        const data = await this.redis!.get(COGNITION_KEYS.critique(id));
        if (!data) continue;

        try {
          const critique = JSON.parse(data) as SelfCritique;
          for (const lesson of critique.lessonsLearned) {
            const normalized = lesson.trim().toLowerCase();
            if (normalized && !lessonsSet.has(normalized)) {
              lessonsSet.set(normalized, lesson.trim());
            }
          }
        } catch {
          // Skip malformed entries
        }
      }

      // Return original-case lessons, up to limit
      return Array.from(lessonsSet.values()).slice(0, limit);
    } catch (error) {
      Logger.error('[SelfCritiqueStore] Error aggregating lessons learned:', error);
      return [];
    }
  }

  /**
   * Get efficiency trend for a session.
   *
   * Returns chronological efficiency scores for all critiques in a session,
   * useful for tracking whether the agent is improving over time.
   *
   * @param sessionId - Session to analyze
   * @returns Array of {timestamp, efficiency, scope} in chronological order
   */
  async getEfficiencyTrend(
    sessionId: string
  ): Promise<Array<{ timestamp: number; efficiency: number; scope: string }>> {
    if (!this.isConnected() || !this.redis) {
      try {
        await this.connect();
      } catch {
        return [];
      }
    }

    try {
      const key = COGNITION_KEYS.critiquesBySession(sessionId);
      // Get all IDs in chronological order (oldest first)
      const ids = await this.redis!.zrange(key, 0, -1);

      if (ids.length === 0) return [];

      const trend: Array<{ timestamp: number; efficiency: number; scope: string }> = [];

      for (const id of ids) {
        const data = await this.redis!.get(COGNITION_KEYS.critique(id));
        if (!data) continue;

        try {
          const critique = JSON.parse(data) as SelfCritique;
          trend.push({
            timestamp: critique.timestamp,
            efficiency: critique.efficiency,
            scope: critique.scope,
          });
        } catch {
          // Skip malformed entries
        }
      }

      return trend;
    } catch (error) {
      Logger.error('[SelfCritiqueStore] Error getting efficiency trend:', error);
      return [];
    }
  }
}

// Singleton
let store: SelfCritiqueStore | null = null;

export function getSelfCritiqueStore(): SelfCritiqueStore {
  if (!store) store = new SelfCritiqueStore();
  return store;
}

export function resetSelfCritiqueStore(): void {
  if (store) store.disconnect().catch(err => Logger.error(err));
  store = null;
}
