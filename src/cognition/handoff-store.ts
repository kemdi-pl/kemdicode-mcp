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
 * Handoff Store
 *
 * Redis-backed persistence for Smart Handoff reports.
 * Creates structured context transfer documents for session transitions,
 * modeled after medical shift handoffs -- structured, actionable, not a data dump.
 *
 * @module cognition/handoff-store
 */

import { RedisBackedService } from '../infrastructure/redis/redis-backed-service.js';
import { Logger } from '../utils/logger.js';
import type { HandoffReport } from './types.js';
import { COGNITION_KEYS, COGNITION_TTL, MAX_COGNITION_JSON_SIZE } from './types.js';
import { getCognitionEventBus } from './event-bus.js';
import { randomBytes } from 'crypto';
import { informationDensity } from './ctc-math.js';

/**
 * HandoffStore -- Redis-backed CRUD for Smart Handoff reports.
 *
 * Each handoff is stored as a JSON string keyed by its ID.
 * A sorted set per session (scored by timestamp) enables listing.
 * A separate key tracks the latest handoff per session for fast retrieval.
 */
export class HandoffStore extends RedisBackedService {
  protected get serviceName() {
    return 'HandoffStore';
  }

  /**
   * Generate a unique handoff ID.
   */
  generateId(): string {
    return `handoff_${Date.now()}_${randomBytes(4).toString('hex')}`;
  }

  /**
   * Create a new handoff report.
   *
   * Stores the report as JSON, indexes it in the session sorted set
   * (scored by timestamp), and records it as the latest handoff for
   * the session. Sets the configured TTL on all keys.
   *
   * @param report - Handoff data without id and timestamp (auto-generated)
   * @returns The full HandoffReport with id and timestamp, or null on failure
   */
  async create(
    report: Omit<HandoffReport, 'id' | 'timestamp'>
  ): Promise<HandoffReport | null> {
    if (!this.isConnected() || !this.redis) {
      try {
        await this.connect();
      } catch {
        Logger.error('[HandoffStore] Cannot connect to Redis');
        return null;
      }
    }

    try {
      const id = this.generateId();
      const timestamp = Date.now();

      const full: HandoffReport = {
        id,
        timestamp,
        ...report,
      };

      const key = COGNITION_KEYS.handoff(id);
      const sessionSetKey = COGNITION_KEYS.handoffBySession(report.sessionId);
      const latestKey = COGNITION_KEYS.latestHandoff(report.sessionId);

      const json = JSON.stringify(full);
      if (json.length > MAX_COGNITION_JSON_SIZE) {
        Logger.error(`[HandoffStore] Payload too large (${json.length} bytes > ${MAX_COGNITION_JSON_SIZE})`);
        return null;
      }

      const tx = this.redis!.multi();
      tx.set(key, json);
      tx.zadd(sessionSetKey, timestamp, id);
      tx.set(latestKey, id);

      if (COGNITION_TTL.handoff > 0) {
        tx.expire(key, COGNITION_TTL.handoff);
        tx.expire(sessionSetKey, COGNITION_TTL.handoff);
        tx.expire(latestKey, COGNITION_TTL.handoff);
      }

      await tx.exec();

      // CTC: Compute holographic boundary encoding
      // Information density of each field relative to the intent.
      // Higher density = more useful information per token for reconstruction.
      try {
        const encoding = this.computeBoundaryEncoding(full);
        if (Object.keys(encoding).length > 0) {
          const boundaryKey = COGNITION_KEYS.handoffBoundary(id);
          await this.redis!.set(boundaryKey, JSON.stringify(encoding));
          if (COGNITION_TTL.handoff > 0) {
            await this.redis!.expire(boundaryKey, COGNITION_TTL.handoff);
          }
          full.boundaryEncoding = encoding;
        }
      } catch (err) {
        // Non-critical: boundary encoding is an optimization, not a requirement
        Logger.debug(`[HandoffStore] Boundary encoding error: ${err instanceof Error ? err.message : String(err)}`);
      }

      // Emit event for cross-tool reactions
      getCognitionEventBus().emit({
        type: 'handoff:created',
        timestamp: full.timestamp,
        sessionId: full.sessionId,
        agentId: full.agentId,
        sourceId: full.id,
        sourceType: 'handoff',
        payload: { intent: full.intent, confidence: full.confidence },
      });
      return full;
    } catch (error) {
      Logger.error('[HandoffStore] Error creating handoff:', error);
      return null;
    }
  }

  /**
   * Get a handoff report by its ID.
   *
   * @param id - Handoff report ID
   * @returns The HandoffReport or null if not found
   */
  async get(id: string): Promise<HandoffReport | null> {
    if (!this.isConnected() || !this.redis) {
      try {
        await this.connect();
      } catch {
        return null;
      }
    }

    try {
      const data = await this.redis!.get(COGNITION_KEYS.handoff(id));
      if (!data) return null;
      return JSON.parse(data) as HandoffReport;
    } catch (error) {
      Logger.error('[HandoffStore] Error getting handoff:', error);
      return null;
    }
  }

  /**
   * Get the most recent handoff report for a session.
   *
   * This is the primary method for session resurrection -- the incoming
   * agent should load the latest handoff first to understand where
   * things stand.
   *
   * @param sessionId - Session to query
   * @returns The latest HandoffReport or null if none exists
   */
  async getLatest(sessionId: string): Promise<HandoffReport | null> {
    if (!this.isConnected() || !this.redis) {
      try {
        await this.connect();
      } catch {
        return null;
      }
    }

    try {
      const latestKey = COGNITION_KEYS.latestHandoff(sessionId);
      const latestId = await this.redis!.get(latestKey);

      if (!latestId) {
        // Fallback: try the sorted set in case the latest key was evicted
        const sessionSetKey = COGNITION_KEYS.handoffBySession(sessionId);
        const ids = await this.redis!.zrevrange(sessionSetKey, 0, 0);
        if (ids.length === 0) return null;
        return this.get(ids[0]);
      }

      return this.get(latestId);
    } catch (error) {
      Logger.error('[HandoffStore] Error getting latest handoff:', error);
      return null;
    }
  }

  /**
   * List handoff reports for a session, newest first.
   *
   * @param sessionId - Session to query
   * @param limit - Maximum number of reports to return (default: 5)
   * @returns Array of HandoffReports sorted newest-first
   */
  async listBySession(
    sessionId: string,
    limit: number = 5
  ): Promise<HandoffReport[]> {
    if (!this.isConnected() || !this.redis) {
      try {
        await this.connect();
      } catch {
        return [];
      }
    }

    try {
      const sessionSetKey = COGNITION_KEYS.handoffBySession(sessionId);
      const ids = await this.redis!.zrevrange(sessionSetKey, 0, limit - 1);

      if (ids.length === 0) return [];

      const reports: HandoffReport[] = [];
      for (const id of ids) {
        const data = await this.redis!.get(COGNITION_KEYS.handoff(id));
        if (data) {
          try {
            reports.push(JSON.parse(data) as HandoffReport);
          } catch {
            // Skip malformed entries
          }
        }
      }

      return reports;
    } catch (error) {
      Logger.error('[HandoffStore] Error listing handoffs:', error);
      return [];
    }
  }
  /**
   * Compute holographic boundary encoding for a handoff report.
   *
   * Measures the information density of each text field relative to
   * the stated intent. Fields with higher density carry more useful
   * information per token — these are the "boundary elements" that
   * best encode the session state.
   *
   * Inspired by the Holographic Principle: the boundary (handoff)
   * should encode maximum information about the bulk (full session).
   */
  private computeBoundaryEncoding(report: HandoffReport): Record<string, number> {
    const goalText = report.intent;
    if (!goalText || goalText.trim().length === 0) return {};

    const fields: Record<string, string> = {
      approach: report.approach || '',
      reasoning: report.reasoning || '',
      completed: (report.completed || []).join(' '),
      inProgress: (report.inProgress || []).join(' '),
      blocked: (report.blocked || []).join(' '),
      knownUnknowns: (report.knownUnknowns || []).join(' '),
      warnings: (report.warnings || []).join(' '),
      firstAction: report.firstAction || '',
    };

    const encoding: Record<string, number> = {};
    for (const [field, text] of Object.entries(fields)) {
      if (text.trim().length > 0) {
        const tokens = Math.ceil(text.length / 4);
        const density = informationDensity(text, goalText, tokens);
        encoding[field] = Math.round(density * 1000) / 1000;
      }
    }
    return encoding;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton
// ─────────────────────────────────────────────────────────────────────────────

let store: HandoffStore | null = null;

export function getHandoffStore(): HandoffStore {
  if (!store) store = new HandoffStore();
  return store;
}

export function resetHandoffStore(): void {
  if (store) store.disconnect().catch(err => Logger.error(err));
  store = null;
}
