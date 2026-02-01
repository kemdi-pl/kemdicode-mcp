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
 * Confidence Store
 *
 * Redis-backed storage for AI self-assessed confidence records.
 * Tracks certainty levels per tool/action, flags low-confidence items
 * for human review, and computes calibration profiles per agent.
 *
 * @module cognition/confidence-store
 */

import { RedisBackedService } from '../infrastructure/redis/redis-backed-service.js';
import { Logger } from '../utils/logger.js';
import type { ConfidenceRecord, ConfidenceProfile } from './types.js';
import { getCognitionEventBus } from './event-bus.js';
import { COGNITION_KEYS, COGNITION_TTL } from './types.js';
import { randomBytes } from 'crypto';

/**
 * Redis key for agent-level confidence index (not in shared types
 * because it is an internal implementation detail of this store).
 */
function confidenceByAgentKey(agentId: string): string {
  return `mcp:cognition:confidence:agent:${agentId}`;
}

/**
 * Safely parse JSON with a fallback value
 */
function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * ConfidenceStore manages confidence records in Redis.
 *
 * Each record is stored as a JSON string keyed by its ID.
 * Two sorted sets index records by session and by agent (scored by timestamp).
 * Low-confidence records are additionally pushed into a review queue list.
 */
export class ConfidenceStore extends RedisBackedService {
  protected get serviceName() {
    return 'ConfidenceStore';
  }

  /**
   * Generate a unique confidence record ID
   */
  generateId(): string {
    return `conf_${Date.now()}_${randomBytes(4).toString('hex')}`;
  }

  /**
   * Record a new confidence assessment.
   *
   * Automatically flags records with confidence < 0.5 for human review
   * and adds them to the review queue.
   */
  async record(
    record: Omit<ConfidenceRecord, 'id' | 'timestamp' | 'flaggedForReview'>
  ): Promise<ConfidenceRecord | null> {
    try {
      await this.connect();
      if (!this.redis) return null;

      const now = Date.now();
      const id = this.generateId();
      const flaggedForReview = record.confidence < 0.5;

      const fullRecord: ConfidenceRecord = {
        ...record,
        id,
        timestamp: now,
        flaggedForReview,
      };

      const key = COGNITION_KEYS.confidence(id);
      const sessionKey = COGNITION_KEYS.confidenceBySession(record.sessionId);
      const agentKey = confidenceByAgentKey(record.agentId);

      const pipeline = this.redis.pipeline();

      // Store the record
      pipeline.set(key, JSON.stringify(fullRecord));
      if (COGNITION_TTL.confidence > 0) {
        pipeline.expire(key, COGNITION_TTL.confidence);
      }

      // Index by session (sorted set, scored by timestamp)
      pipeline.zadd(sessionKey, now, id);
      if (COGNITION_TTL.confidence > 0) {
        pipeline.expire(sessionKey, COGNITION_TTL.confidence);
      }

      // Index by agent (sorted set, scored by timestamp)
      pipeline.zadd(agentKey, now, id);
      if (COGNITION_TTL.confidence > 0) {
        pipeline.expire(agentKey, COGNITION_TTL.confidence);
      }

      // If flagged, add to the review queue
      if (flaggedForReview) {
        const reviewKey = COGNITION_KEYS.confidenceReviewQueue();
        pipeline.zadd(reviewKey, now, id);
        if (COGNITION_TTL.confidence > 0) {
          pipeline.expire(reviewKey, COGNITION_TTL.confidence);
        }
      }

      await pipeline.exec();

      Logger.info(
        `[ConfidenceStore] Recorded ${id} (confidence=${record.confidence}, flagged=${flaggedForReview})`
      );


      // Emit event for cross-tool reactions
      getCognitionEventBus().emit({
        type: fullRecord.confidence < 0.5 ? 'confidence:low' : 'confidence:recorded',
        timestamp: fullRecord.timestamp,
        sessionId: fullRecord.sessionId,
        agentId: fullRecord.agentId,
        sourceId: fullRecord.id,
        sourceType: 'confidence',
        payload: {
          toolName: fullRecord.toolName,
          confidence: fullRecord.confidence,
          domain: fullRecord.domain,
          flaggedForReview: fullRecord.flaggedForReview,
        },
      });
      return fullRecord;
    } catch (error) {
      Logger.error('[ConfidenceStore] Failed to record confidence:', error);
      return null;
    }
  }

  /**
   * Get a single confidence record by ID
   */
  async get(id: string): Promise<ConfidenceRecord | null> {
    try {
      await this.connect();
      if (!this.redis) return null;

      const raw = await this.redis.get(COGNITION_KEYS.confidence(id));
      if (!raw) return null;

      return safeJsonParse<ConfidenceRecord | null>(raw, null);
    } catch (error) {
      Logger.error(`[ConfidenceStore] Failed to get record ${id}:`, error);
      return null;
    }
  }

  /**
   * List confidence records for a session, newest first.
   *
   * @param sessionId - Session identifier
   * @param limit - Maximum number of records to return (default 20)
   */
  async listBySession(sessionId: string, limit: number = 20): Promise<ConfidenceRecord[]> {
    try {
      await this.connect();
      if (!this.redis) return [];

      const sessionKey = COGNITION_KEYS.confidenceBySession(sessionId);
      // ZREVRANGE returns highest scores first (newest timestamps)
      const ids = await this.redis.zrevrange(sessionKey, 0, limit - 1);

      if (!ids.length) return [];

      const records: ConfidenceRecord[] = [];
      for (const id of ids) {
        const record = await this.get(id);
        if (record) records.push(record);
      }

      return records;
    } catch (error) {
      Logger.error(`[ConfidenceStore] Failed to list by session ${sessionId}:`, error);
      return [];
    }
  }

  /**
   * Update the outcome of a previously recorded confidence assessment.
   *
   * @param id - Confidence record ID
   * @param outcome - Actual outcome: correct, incorrect, or partial
   * @returns true if updated successfully, false otherwise
   */
  async updateOutcome(id: string, outcome: 'correct' | 'incorrect' | 'partial'): Promise<boolean> {
    try {
      await this.connect();
      if (!this.redis) return false;

      const key = COGNITION_KEYS.confidence(id);
      const raw = await this.redis.get(key);
      if (!raw) return false;

      const record = safeJsonParse<ConfidenceRecord | null>(raw, null);
      if (!record) return false;

      record.outcome = outcome;
      await this.redis.set(key, JSON.stringify(record));

      // Preserve existing TTL
      const ttl = await this.redis.ttl(key);
      if (ttl > 0) {
        await this.redis.expire(key, ttl);
      }

      Logger.info(`[ConfidenceStore] Updated outcome for ${id}: ${outcome}`);

      // Emit outcome update event
      getCognitionEventBus().emit({
        type: 'confidence:outcome-updated',
        timestamp: Date.now(),
        sessionId: record.sessionId,
        agentId: record.agentId,
        sourceId: id,
        sourceType: 'confidence',
        payload: { outcome, confidenceId: id },
      });
      return true;
    } catch (error) {
      Logger.error(`[ConfidenceStore] Failed to update outcome for ${id}:`, error);
      return false;
    }
  }

  /**
   * Get records flagged for human review, newest first.
   *
   * @param limit - Maximum records to return (default 10)
   */
  async getReviewQueue(limit: number = 10): Promise<ConfidenceRecord[]> {
    try {
      await this.connect();
      if (!this.redis) return [];

      const reviewKey = COGNITION_KEYS.confidenceReviewQueue();
      const ids = await this.redis.zrevrange(reviewKey, 0, limit - 1);

      if (!ids.length) return [];

      const records: ConfidenceRecord[] = [];
      for (const id of ids) {
        const record = await this.get(id);
        if (record) records.push(record);
      }

      return records;
    } catch (error) {
      Logger.error('[ConfidenceStore] Failed to get review queue:', error);
      return [];
    }
  }

  /**
   * Compute a calibration profile for an agent.
   *
   * Aggregates all confidence records for the agent, calculates:
   * - Per-domain average confidence, record count, and correct rate
   * - Calibration score: 1 - mean |confidence - actual_correct_rate| across bins
   * - Low confidence rate: fraction of records with confidence < 0.5
   */
  async getProfile(agentId: string): Promise<ConfidenceProfile> {
    const emptyProfile: ConfidenceProfile = {
      agentId,
      domainScores: {},
      calibration: 0,
      lowConfidenceRate: 0,
      totalRecords: 0,
    };

    try {
      await this.connect();
      if (!this.redis) return emptyProfile;

      const agentKey = confidenceByAgentKey(agentId);
      const ids = await this.redis.zrange(agentKey, 0, -1);

      if (!ids.length) return emptyProfile;

      // Collect all records for this agent
      const records: ConfidenceRecord[] = [];
      for (const id of ids) {
        const record = await this.get(id);
        if (record) records.push(record);
      }

      if (!records.length) return emptyProfile;

      // ── Domain scores ──
      const domainMap = new Map<
        string,
        { totalConf: number; count: number; correctCount: number; outcomeCount: number }
      >();

      let lowConfCount = 0;

      for (const r of records) {
        const domain = r.domain || 'general';
        const entry = domainMap.get(domain) || {
          totalConf: 0,
          count: 0,
          correctCount: 0,
          outcomeCount: 0,
        };

        entry.totalConf += r.confidence;
        entry.count += 1;

        if (r.outcome && r.outcome !== 'unknown') {
          entry.outcomeCount += 1;
          if (r.outcome === 'correct') {
            entry.correctCount += 1;
          } else if (r.outcome === 'partial') {
            entry.correctCount += 0.5;
          }
        }

        domainMap.set(domain, entry);

        if (r.confidence < 0.5) {
          lowConfCount += 1;
        }
      }

      const domainScores: ConfidenceProfile['domainScores'] = {};
      for (const [domain, entry] of domainMap) {
        domainScores[domain] = {
          avg: entry.count > 0 ? entry.totalConf / entry.count : 0,
          count: entry.count,
          correctRate: entry.outcomeCount > 0 ? entry.correctCount / entry.outcomeCount : 0,
        };
      }

      // ── Calibration score ──
      // Bucket records by confidence decile (0.0-0.1, 0.1-0.2, ..., 0.9-1.0)
      // For each bucket, compare average confidence to actual correct rate.
      // Calibration = 1 - mean absolute error across non-empty buckets.
      const BUCKET_COUNT = 10;
      const buckets: { totalConf: number; correctCount: number; outcomeCount: number }[] =
        Array.from({ length: BUCKET_COUNT }, () => ({
          totalConf: 0,
          correctCount: 0,
          outcomeCount: 0,
        }));

      for (const r of records) {
        if (!r.outcome || r.outcome === 'unknown') continue;

        const bucketIdx = Math.min(Math.floor(r.confidence * BUCKET_COUNT), BUCKET_COUNT - 1);
        buckets[bucketIdx].totalConf += r.confidence;
        buckets[bucketIdx].outcomeCount += 1;
        if (r.outcome === 'correct') {
          buckets[bucketIdx].correctCount += 1;
        } else if (r.outcome === 'partial') {
          buckets[bucketIdx].correctCount += 0.5;
        }
      }

      let calibrationErrorSum = 0;
      let nonEmptyBuckets = 0;

      for (const bucket of buckets) {
        if (bucket.outcomeCount === 0) continue;
        const avgConf = bucket.totalConf / bucket.outcomeCount;
        const actualRate = bucket.correctCount / bucket.outcomeCount;
        calibrationErrorSum += Math.abs(avgConf - actualRate);
        nonEmptyBuckets += 1;
      }

      const calibration =
        nonEmptyBuckets > 0
          ? Math.max(0, Math.min(1, 1 - calibrationErrorSum / nonEmptyBuckets))
          : 0;

      const lowConfidenceRate = records.length > 0 ? lowConfCount / records.length : 0;

      return {
        agentId,
        domainScores,
        calibration: Math.round(calibration * 1000) / 1000,
        lowConfidenceRate: Math.round(lowConfidenceRate * 1000) / 1000,
        totalRecords: records.length,
      };
    } catch (error) {
      Logger.error(`[ConfidenceStore] Failed to compute profile for ${agentId}:`, error);
      return emptyProfile;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton
// ─────────────────────────────────────────────────────────────────────────────

let confidenceStore: ConfidenceStore | null = null;

/**
 * Get the global ConfidenceStore instance
 */
export function getConfidenceStore(): ConfidenceStore {
  if (!confidenceStore) {
    confidenceStore = new ConfidenceStore();
  }
  return confidenceStore;
}

/**
 * Reset the global ConfidenceStore (for testing)
 */
export function resetConfidenceStore(): void {
  if (confidenceStore) {
    confidenceStore.disconnect().catch((err) => Logger.error(err));
    confidenceStore = null;
  }
}
