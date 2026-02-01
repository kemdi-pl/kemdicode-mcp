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
 * Intent Store
 *
 * Redis-backed storage for the human's goal hierarchy.
 * Tracks intents at multiple levels (mission, goal, sub-goal, task)
 * and detects when the AI drifts from the original intent.
 *
 * @module cognition/intent-store
 */

import { RedisBackedService } from '../infrastructure/redis/redis-backed-service.js';
import { Logger } from '../utils/logger.js';
import type { Intent, IntentStatus, DriftAlert } from './types.js';
import { COGNITION_KEYS, COGNITION_TTL } from './types.js';
import { getCognitionEventBus } from './event-bus.js';
import { randomBytes } from 'crypto';

/**
 * Extract significant words from text for drift comparison.
 * Filters out common stop words and returns lowercase tokens.
 */
function extractWords(text: string): Set<string> {
  const stopWords = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'shall', 'can', 'need', 'must', 'to', 'of',
    'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into', 'about',
    'and', 'or', 'but', 'not', 'no', 'if', 'then', 'than', 'so', 'that',
    'this', 'it', 'its', 'i', 'we', 'you', 'he', 'she', 'they', 'me',
    'my', 'our', 'your', 'his', 'her', 'their', 'what', 'which', 'who',
    'how', 'when', 'where', 'why', 'all', 'each', 'some', 'any', 'just',
    'also', 'very', 'up', 'out', 'now', 'get', 'make', 'go', 'see',
  ]);

  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !stopWords.has(w))
  );
}

/**
 * Compute word-overlap drift score between two texts.
 * Returns 0 (fully aligned) to 1 (completely divergent).
 */
function computeDriftScore(intentDescription: string, currentAction: string): number {
  const intentWords = extractWords(intentDescription);
  const actionWords = extractWords(currentAction);

  if (intentWords.size === 0 || actionWords.size === 0) {
    return 0.5; // Uncertain when insufficient data
  }

  let overlap = 0;
  for (const word of actionWords) {
    if (intentWords.has(word)) {
      overlap++;
    }
  }

  // Jaccard-like similarity: overlap / union
  const union = new Set([...intentWords, ...actionWords]).size;
  const similarity = union > 0 ? overlap / union : 0;

  // Drift is the inverse of similarity
  return Math.round((1 - similarity) * 100) / 100;
}

/**
 * IntentStore — Redis-backed storage for the human's goal hierarchy.
 *
 * Tracks intents at four levels:
 *   mission > goal > sub-goal > task
 *
 * Detects drift by comparing the current agent action against the
 * active intent's description using word-overlap scoring.
 */
export class IntentStore extends RedisBackedService {
  protected get serviceName(): string {
    return 'IntentStore';
  }

  /**
   * Generate a unique intent ID
   */
  generateId(): string {
    return `intent_${Date.now()}_${randomBytes(4).toString('hex')}`;
  }

  /**
   * Create and store a new intent.
   *
   * If the intent level is 'mission' or 'goal', it is also set as the
   * active intent for the session (overwriting any previous active intent).
   */
  async setIntent(
    intent: Omit<Intent, 'id' | 'timestamp' | 'driftAlerts' | 'status'>
  ): Promise<Intent | null> {
    if (!this.redis) await this.connect();
    if (!this.redis) return null;

    try {
      const now = Date.now();
      const fullIntent: Intent = {
        ...intent,
        id: this.generateId(),
        timestamp: now,
        status: 'active',
        driftAlerts: [],
      };

      const key = COGNITION_KEYS.intent(fullIntent.id);
      const sessionKey = COGNITION_KEYS.intentsBySession(fullIntent.sessionId);
      const ttl = COGNITION_TTL.intent;

      const pipeline = this.redis.pipeline();

      // Store intent as JSON string
      pipeline.set(key, JSON.stringify(fullIntent));
      if (ttl > 0) {
        pipeline.expire(key, ttl);
      }

      // Add to session sorted set (score = timestamp for ordering)
      pipeline.zadd(sessionKey, now, fullIntent.id);
      if (ttl > 0) {
        pipeline.expire(sessionKey, ttl);
      }

      // Set as active intent if mission or goal level
      if (fullIntent.level === 'mission' || fullIntent.level === 'goal') {
        const activeKey = COGNITION_KEYS.activeIntent(fullIntent.sessionId);
        pipeline.set(activeKey, fullIntent.id);
        if (ttl > 0) {
          pipeline.expire(activeKey, ttl);
        }
      }

      await pipeline.exec();

      Logger.debug(`IntentStore: created intent ${fullIntent.id} (${fullIntent.level})`);

      // Emit event
      getCognitionEventBus().emit({
        type: 'intent:set',
        timestamp: fullIntent.timestamp,
        sessionId: fullIntent.sessionId,
        agentId: fullIntent.agentId,
        sourceId: fullIntent.id,
        sourceType: 'intent',
        payload: { level: fullIntent.level, description: fullIntent.description },
      });
      return fullIntent;
    } catch (error) {
      Logger.error('[IntentStore] Failed to set intent:', error);
      return null;
    }
  }

  /**
   * Retrieve an intent by ID
   */
  async get(id: string): Promise<Intent | null> {
    if (!this.redis) await this.connect();
    if (!this.redis) return null;

    try {
      const data = await this.redis.get(COGNITION_KEYS.intent(id));
      if (!data) return null;
      return JSON.parse(data) as Intent;
    } catch (error) {
      Logger.error(`[IntentStore] Failed to get intent ${id}:`, error);
      return null;
    }
  }

  /**
   * Get the current active intent for a session
   */
  async getActiveIntent(sessionId: string): Promise<Intent | null> {
    if (!this.redis) await this.connect();
    if (!this.redis) return null;

    try {
      const activeKey = COGNITION_KEYS.activeIntent(sessionId);
      const intentId = await this.redis.get(activeKey);
      if (!intentId) return null;
      return this.get(intentId);
    } catch (error) {
      Logger.error(`[IntentStore] Failed to get active intent for session ${sessionId}:`, error);
      return null;
    }
  }

  /**
   * List all intents for a session, ordered by timestamp descending
   */
  async listBySession(sessionId: string, limit?: number): Promise<Intent[]> {
    if (!this.redis) await this.connect();
    if (!this.redis) return [];

    try {
      const sessionKey = COGNITION_KEYS.intentsBySession(sessionId);
      const maxResults = limit || 20;

      // Get IDs from sorted set, most recent first
      const intentIds = await this.redis.zrevrange(sessionKey, 0, maxResults - 1);

      const intents: Intent[] = [];
      for (const id of intentIds) {
        const intent = await this.get(id);
        if (intent) {
          intents.push(intent);
        }
      }

      return intents;
    } catch (error) {
      Logger.error(`[IntentStore] Failed to list intents for session ${sessionId}:`, error);
      return [];
    }
  }

  /**
   * Walk up the parentIntentId chain from a given intent,
   * returning the full hierarchy from mission down to the given intent.
   */
  async getHierarchy(intentId: string): Promise<Intent[]> {
    if (!this.redis) await this.connect();
    if (!this.redis) return [];

    try {
      const chain: Intent[] = [];
      let currentId: string | undefined = intentId;
      const visited = new Set<string>();

      // Walk up
      while (currentId && !visited.has(currentId)) {
        visited.add(currentId);
        const intent = await this.get(currentId);
        if (!intent) break;
        chain.unshift(intent); // prepend so mission is first
        currentId = intent.parentIntentId;
      }

      return chain;
    } catch (error) {
      Logger.error(`[IntentStore] Failed to get hierarchy for ${intentId}:`, error);
      return [];
    }
  }

  /**
   * Update the status of an intent.
   * If status is 'completed', also sets completedAt.
   */
  async updateStatus(id: string, status: IntentStatus): Promise<boolean> {
    if (!this.redis) await this.connect();
    if (!this.redis) return false;

    try {
      const intent = await this.get(id);
      if (!intent) return false;

      intent.status = status;
      if (status === 'completed') {
        intent.completedAt = Date.now();
      }

      const key = COGNITION_KEYS.intent(id);
      await this.redis.set(key, JSON.stringify(intent));

      // Preserve existing TTL
      const ttl = COGNITION_TTL.intent;
      if (ttl > 0) {
        await this.redis.expire(key, ttl);
      }

      Logger.debug(`IntentStore: updated status of ${id} to ${status}`);
      return true;
    } catch (error) {
      Logger.error(`[IntentStore] Failed to update status for ${id}:`, error);
      return false;
    }
  }

  /**
   * Record a drift alert on an intent.
   * If driftScore > 0.7, automatically sets the intent status to 'drifted'.
   */
  async recordDrift(
    intentId: string,
    alert: Omit<DriftAlert, 'timestamp'>
  ): Promise<boolean> {
    if (!this.redis) await this.connect();
    if (!this.redis) return false;

    try {
      const intent = await this.get(intentId);
      if (!intent) return false;

      const fullAlert: DriftAlert = {
        ...alert,
        timestamp: Date.now(),
      };

      intent.driftAlerts.push(fullAlert);

      // Auto-mark as drifted if drift score exceeds threshold
      if (alert.driftScore > 0.7) {
        intent.status = 'drifted';
        getCognitionEventBus().emit({
          type: 'intent:drifted',
          timestamp: fullAlert.timestamp,
          sessionId: intent.sessionId,
          agentId: intent.agentId,
          sourceId: intentId,
          sourceType: 'intent',
          payload: {
            driftScore: alert.driftScore,
            currentAction: alert.currentAction,
            expectedDirection: alert.expectedDirection,
          },
        });
      }

      const key = COGNITION_KEYS.intent(intentId);
      await this.redis.set(key, JSON.stringify(intent));

      const ttl = COGNITION_TTL.intent;
      if (ttl > 0) {
        await this.redis.expire(key, ttl);
      }

      Logger.debug(
        `IntentStore: recorded drift on ${intentId} (score=${alert.driftScore})`
      );
      return true;
    } catch (error) {
      Logger.error(`[IntentStore] Failed to record drift for ${intentId}:`, error);
      return false;
    }
  }

  /**
   * Check whether the current action drifts from the active intent.
   *
   * Compares the currentAction words against the active intent's description
   * using a simple word-overlap score. If the score exceeds 0.5, a DriftAlert
   * is created, recorded on the intent, and returned.
   *
   * Returns the alert if drift is detected, null otherwise.
   */
  async checkDrift(
    sessionId: string,
    currentAction: string
  ): Promise<DriftAlert | null> {
    if (!this.redis) await this.connect();
    if (!this.redis) return null;

    try {
      const activeIntent = await this.getActiveIntent(sessionId);
      if (!activeIntent) return null;

      const driftScore = computeDriftScore(activeIntent.description, currentAction);

      if (driftScore > 0.5) {
        const alert: Omit<DriftAlert, 'timestamp'> = {
          currentAction,
          expectedDirection: activeIntent.description,
          driftScore,
        };

        await this.recordDrift(activeIntent.id, alert);

        return {
          ...alert,
          timestamp: Date.now(),
        };
      }

      return null;
    } catch (error) {
      Logger.error(`[IntentStore] Failed to check drift for session ${sessionId}:`, error);
      return null;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton
// ─────────────────────────────────────────────────────────────────────────────

let instance: IntentStore | null = null;

/**
 * Get the singleton IntentStore instance
 */
export function getIntentStore(): IntentStore {
  if (!instance) {
    instance = new IntentStore();
  }
  return instance;
}

/**
 * Reset the singleton (for testing)
 */
export function resetIntentStore(): void {
  if (instance) {
    instance.disconnect().catch(() => {});
  }
  instance = null;
}
