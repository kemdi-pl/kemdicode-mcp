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
 * Decision Store
 *
 * Redis-backed persistence for the Decision Journal.
 * Records WHY AI agents make choices, not just what they did.
 *
 * @module cognition/decision-store
 */

import { RedisBackedService } from '../infrastructure/redis/redis-backed-service.js';
import { Logger } from '../utils/logger.js';
import { safeJsonParse } from '../utils/validation.js';
import type { Decision } from './types.js';
import { COGNITION_KEYS, COGNITION_TTL, MAX_COGNITION_JSON_SIZE } from './types.js';
import { getCognitionEventBus } from './event-bus.js';
import { randomBytes } from 'crypto';

/**
 * DecisionStore — Redis-backed CRUD for Decision Journal entries.
 */
export class DecisionStore extends RedisBackedService {
  protected get serviceName() { return 'DecisionStore'; }

  /**
   * Generate a unique decision ID.
   */
  generateId(): string {
    return `dec_${Date.now()}_${randomBytes(4).toString('hex')}`;
  }

  /**
   * Record a new decision.
   *
   * Stores the decision as a JSON string, indexes it by session and agent
   * in sorted sets (scored by timestamp), and sets the configured TTL.
   */
  async record(
    decision: Omit<Decision, 'id' | 'timestamp'>
  ): Promise<Decision | null> {
    if (!this.isConnected() || !this.redis) {
      try {
        await this.connect();
      } catch {
        Logger.error('[DecisionStore] Cannot connect to Redis');
        return null;
      }
    }

    try {
      const id = this.generateId();
      const timestamp = Date.now();

      const full: Decision = {
        id,
        timestamp,
        ...decision,
      };

      const key = COGNITION_KEYS.decision(id);
      const sessionKey = COGNITION_KEYS.decisionsBySession(decision.sessionId);
      const agentKey = COGNITION_KEYS.decisionsByAgent(decision.agentId);

      const json = JSON.stringify(full);
      if (json.length > MAX_COGNITION_JSON_SIZE) {
        Logger.error(`[DecisionStore] Payload too large (${json.length} bytes > ${MAX_COGNITION_JSON_SIZE})`);
        return null;
      }

      const tx = this.redis!.multi();
      tx.set(key, json);
      tx.zadd(sessionKey, timestamp, id);
      tx.zadd(agentKey, timestamp, id);

      if (COGNITION_TTL.decision > 0) {
        tx.expire(key, COGNITION_TTL.decision);
        tx.expire(sessionKey, COGNITION_TTL.decision);
        tx.expire(agentKey, COGNITION_TTL.decision);
      }

      await tx.exec();

      // Emit event for cross-tool reactions
      getCognitionEventBus().emit({
        type: 'decision:recorded',
        timestamp: full.timestamp,
        sessionId: full.sessionId,
        agentId: full.agentId,
        sourceId: full.id,
        sourceType: 'decision',
        payload: {
          question: full.question,
          chosen: full.chosen,
          confidence: full.confidence,
          tags: full.tags,
          relatedFiles: full.relatedFiles,
        },
      });

      return full;
    } catch (error) {
      Logger.error('[DecisionStore] Error recording decision:', error);
      return null;
    }
  }

  /**
   * Get a decision by its ID.
   */
  async get(id: string): Promise<Decision | null> {
    if (!this.isConnected() || !this.redis) {
      try {
        await this.connect();
      } catch {
        return null;
      }
    }

    try {
      const data = await this.redis!.get(COGNITION_KEYS.decision(id));
      if (!data) return null;
      return safeJsonParse<Decision | null>(data, null);
    } catch (error) {
      Logger.error('[DecisionStore] Error getting decision:', error);
      return null;
    }
  }

  /**
   * List decisions for a session, newest first.
   *
   * @param sessionId - Session to query
   * @param limit - Maximum number of decisions to return (default: 20)
   */
  async listBySession(sessionId: string, limit: number = 20): Promise<Decision[]> {
    if (!this.isConnected() || !this.redis) {
      try {
        await this.connect();
      } catch {
        return [];
      }
    }

    try {
      const key = COGNITION_KEYS.decisionsBySession(sessionId);
      const ids = await this.redis!.zrevrange(key, 0, limit - 1);

      if (ids.length === 0) return [];

      const keys = ids.map((id) => COGNITION_KEYS.decision(id));
      const results = await this.redis!.mget(...keys);

      const decisions: Decision[] = [];
      for (const data of results) {
        if (data) {
          try {
            decisions.push(JSON.parse(data) as Decision);
          } catch {
            // Skip malformed entries
          }
        }
      }

      return decisions;
    } catch (error) {
      Logger.error('[DecisionStore] Error listing decisions:', error);
      return [];
    }
  }

  /**
   * Update the outcome field of an existing decision.
   *
   * @param id - Decision ID
   * @param outcome - What actually happened
   * @returns true if the decision was found and updated
   */
  async updateOutcome(id: string, outcome: string): Promise<boolean> {
    if (!this.isConnected() || !this.redis) {
      try {
        await this.connect();
      } catch {
        return false;
      }
    }

    try {
      const key = COGNITION_KEYS.decision(id);
      const data = await this.redis!.get(key);
      if (!data) return false;

      const decision = safeJsonParse<Decision | null>(data, null);
      if (!decision) return false;
      decision.outcome = outcome;

      await this.redis!.set(key, JSON.stringify(decision));

      // Preserve original TTL
      if (COGNITION_TTL.decision > 0) {
        await this.redis!.expire(key, COGNITION_TTL.decision);
      }

      return true;
    } catch (error) {
      Logger.error('[DecisionStore] Error updating outcome:', error);
      return false;
    }
  }

  /**
   * Search decisions by keyword in question, chosen, and reasoning fields.
   *
   * @param query - Search keyword (case-insensitive)
   * @param sessionId - Optional session scope; if omitted, searches all known sessions
   */
  async search(query: string, sessionId?: string): Promise<Decision[]> {
    if (!this.isConnected() || !this.redis) {
      try {
        await this.connect();
      } catch {
        return [];
      }
    }

    try {
      const lowerQuery = query.toLowerCase();
      let ids: string[];

      if (sessionId) {
        // Scoped to a single session
        ids = await this.redis!.zrevrange(
          COGNITION_KEYS.decisionsBySession(sessionId),
          0,
          -1
        );
      } else {
        // Scan for all session sorted-set keys and collect IDs
        ids = [];
        let cursor = '0';
        do {
          const [nextCursor, keys] = await this.redis!.scan(
            cursor,
            'MATCH',
            'mcp:cognition:decisions:session:*',
            'COUNT',
            100
          );
          cursor = nextCursor;
          for (const key of keys) {
            const sessionIds = await this.redis!.zrevrange(key, 0, -1);
            ids.push(...sessionIds);
          }
        } while (cursor !== '0');
      }

      const results: Decision[] = [];
      const seen = new Set<string>();

      for (const id of ids) {
        if (seen.has(id)) continue;
        seen.add(id);

        const data = await this.redis!.get(COGNITION_KEYS.decision(id));
        if (!data) continue;

        try {
          const decision = JSON.parse(data) as Decision;
          const searchable = [
            decision.question,
            decision.chosen,
            decision.reasoning,
          ]
            .join(' ')
            .toLowerCase();

          if (searchable.includes(lowerQuery)) {
            results.push(decision);
          }
        } catch {
          // Skip malformed entries
        }
      }

      return results;
    } catch (error) {
      Logger.error('[DecisionStore] Error searching decisions:', error);
      return [];
    }
  }
}

// Singleton
let store: DecisionStore | null = null;

export function getDecisionStore(): DecisionStore {
  if (!store) store = new DecisionStore();
  return store;
}

export function resetDecisionStore(): void {
  if (store) store.disconnect().catch(err => Logger.error(err));
  store = null;
}
