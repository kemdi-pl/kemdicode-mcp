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
 * Error Pattern Store
 *
 * Redis-backed persistence for the Error Pattern DB.
 * Learns from mistakes across sessions by recording error patterns
 * with root causes and fixes, then matching new errors against
 * known patterns to suggest solutions.
 *
 * @module cognition/error-pattern-store
 */

import { RedisBackedService } from '../infrastructure/redis/redis-backed-service.js';
import { Logger } from '../utils/logger.js';
import type { ErrorPattern, ErrorClassification } from './types.js';
import { COGNITION_KEYS } from './types.js';
import { getCognitionEventBus } from './event-bus.js';
import { randomBytes } from 'crypto';

/**
 * Tokenize a string into lowercase words, removing punctuation.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1);
}

/**
 * Calculate word overlap ratio between two sets of words.
 * Returns a value between 0 and 1.
 */
function wordOverlap(wordsA: Set<string>, wordsB: Set<string>): number {
  if (wordsA.size === 0 && wordsB.size === 0) return 1;
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let overlap = 0;
  for (const word of wordsA) {
    if (wordsB.has(word)) overlap++;
  }

  // Jaccard-like: overlap / min(sizeA, sizeB) so partial subsets count strongly
  return overlap / Math.min(wordsA.size, wordsB.size);
}

/**
 * ErrorPatternStore — Redis-backed CRUD for the Error Pattern DB.
 *
 * Stores error patterns permanently (no TTL) so lessons learned persist
 * across all sessions. Supports duplicate detection via symptom overlap,
 * occurrence tracking, and fuzzy matching of new errors against the DB.
 */
export class ErrorPatternStore extends RedisBackedService {
  protected get serviceName() {
    return 'ErrorPatternStore';
  }

  /**
   * Generate a unique error pattern ID.
   */
  generateId(): string {
    return `errpat_${Date.now()}_${randomBytes(4).toString('hex')}`;
  }

  /**
   * Record a new error pattern, or merge with an existing one if a similar
   * pattern already exists (same errorType + >50% symptom word overlap).
   *
   * @returns The created or updated ErrorPattern, or null on failure.
   */
  async record(
    pattern: Omit<ErrorPattern, 'id' | 'occurrences' | 'lastSeen'>
  ): Promise<ErrorPattern | null> {
    if (!this.isConnected() || !this.redis) {
      try {
        await this.connect();
      } catch {
        Logger.error('[ErrorPatternStore] Cannot connect to Redis');
        return null;
      }
    }

    try {
      // Check for duplicate: same errorType + similar symptoms
      const existing = await this.findSimilar(pattern.errorType, pattern.symptoms);

      if (existing) {
        // Merge: increment occurrences, update lastSeen, merge session IDs
        existing.occurrences += 1;
        existing.lastSeen = Date.now();

        // Merge sessionIds (deduplicate)
        for (const sid of pattern.sessionIds) {
          if (!existing.sessionIds.includes(sid)) {
            existing.sessionIds.push(sid);
          }
        }

        // Merge toolNames (deduplicate)
        for (const tool of pattern.toolNames) {
          if (!existing.toolNames.includes(tool)) {
            existing.toolNames.push(tool);
          }
        }

        // Merge tags (deduplicate)
        for (const tag of pattern.tags) {
          if (!existing.tags.includes(tag)) {
            existing.tags.push(tag);
          }
        }

        // Merge new symptoms that are not yet captured (limit to 50)
        const MAX_SYMPTOMS = 50;
        const existingSymptomWords = new Set(
          existing.symptoms.flatMap((s) => tokenize(s))
        );
        for (const symptom of pattern.symptoms) {
          if (existing.symptoms.length >= MAX_SYMPTOMS) break;
          const newWords = tokenize(symptom);
          const isNew = newWords.some((w) => !existingSymptomWords.has(w));
          if (isNew && !existing.symptoms.includes(symptom)) {
            existing.symptoms.push(symptom);
          }
        }

        // If the new fix is different and possibly more useful, append it
        if (pattern.fix && pattern.fix !== existing.fix) {
          existing.fix = `${existing.fix}\n\nAlternative fix: ${pattern.fix}`;
        }

        const key = COGNITION_KEYS.errorPattern(existing.id);
        await this.redis!.set(key, JSON.stringify(existing));
        // No TTL for error patterns (permanent)

        // Update sorted set indices with new occurrence count
        await this.redis!.zadd(
          COGNITION_KEYS.errorPatternsByType(existing.errorType),
          existing.occurrences,
          existing.id
        );
        await this.redis!.zadd(
          COGNITION_KEYS.errorPatternsAll(),
          existing.occurrences,
          existing.id
        );

        // Emit merge/occurrence event
        getCognitionEventBus().emit({
          type: 'error:occurrence',
          timestamp: Date.now(),
          sessionId: pattern.sessionIds[0] || '',
          sourceId: existing.id,
          sourceType: 'error-pattern',
          payload: { errorType: existing.errorType, occurrences: existing.occurrences },
        });
        return existing;
      }

      // No duplicate found: create new pattern
      const id = this.generateId();
      const now = Date.now();

      const full: ErrorPattern = {
        id,
        occurrences: 1,
        lastSeen: now,
        ...pattern,
      };

      const key = COGNITION_KEYS.errorPattern(id);
      await this.redis!.set(key, JSON.stringify(full));

      // Index by error type (sorted set, score = occurrences for sorting)
      await this.redis!.zadd(
        COGNITION_KEYS.errorPatternsByType(pattern.errorType),
        full.occurrences,
        id
      );

      // Index in all-patterns set (sorted by occurrences)
      await this.redis!.zadd(
        COGNITION_KEYS.errorPatternsAll(),
        full.occurrences,
        id
      );

      // No TTL — error patterns are permanent (COGNITION_TTL.errorPattern === 0)


      // Emit new error event
      getCognitionEventBus().emit({
        type: 'error:recorded',
        timestamp: now,
        sessionId: pattern.sessionIds[0] || '',
        sourceId: full.id,
        sourceType: 'error-pattern',
        payload: {
          errorType: full.errorType,
          context: full.context,
          symptoms: full.symptoms,
          rootCause: full.rootCause,
          fix: full.fix,
        },
      });
      return full;
    } catch (error) {
      Logger.error('[ErrorPatternStore] Error recording pattern:', error);
      return null;
    }
  }

  /**
   * Get an error pattern by its ID.
   */
  async get(id: string): Promise<ErrorPattern | null> {
    if (!this.isConnected() || !this.redis) {
      try {
        await this.connect();
      } catch {
        return null;
      }
    }

    try {
      const data = await this.redis!.get(COGNITION_KEYS.errorPattern(id));
      if (!data) return null;
      return JSON.parse(data) as ErrorPattern;
    } catch (error) {
      Logger.error('[ErrorPatternStore] Error getting pattern:', error);
      return null;
    }
  }

  /**
   * List all error patterns, sorted by occurrences descending.
   *
   * @param limit - Maximum number of patterns to return (default: 20)
   */
  async listAll(limit: number = 20): Promise<ErrorPattern[]> {
    if (!this.isConnected() || !this.redis) {
      try {
        await this.connect();
      } catch {
        return [];
      }
    }

    try {
      // Get IDs from the all-patterns sorted set, highest occurrences first
      const ids = await this.redis!.zrevrange(
        COGNITION_KEYS.errorPatternsAll(),
        0,
        limit - 1
      );

      if (ids.length === 0) return [];

      const patterns: ErrorPattern[] = [];
      for (const id of ids) {
        const data = await this.redis!.get(COGNITION_KEYS.errorPattern(id));
        if (data) {
          try {
            patterns.push(JSON.parse(data) as ErrorPattern);
          } catch {
            // Skip malformed entries
          }
        }
      }

      // Re-sort in case Redis scores are stale
      patterns.sort((a, b) => b.occurrences - a.occurrences);

      return patterns.slice(0, limit);
    } catch (error) {
      Logger.error('[ErrorPatternStore] Error listing patterns:', error);
      return [];
    }
  }

  /**
   * List error patterns by type, sorted by occurrences descending.
   *
   * @param errorType - Error classification to filter by
   * @param limit - Maximum number of patterns to return (default: 20)
   */
  async listByType(
    errorType: ErrorClassification,
    limit: number = 20
  ): Promise<ErrorPattern[]> {
    if (!this.isConnected() || !this.redis) {
      try {
        await this.connect();
      } catch {
        return [];
      }
    }

    try {
      const ids = await this.redis!.zrevrange(
        COGNITION_KEYS.errorPatternsByType(errorType),
        0,
        limit - 1
      );

      if (ids.length === 0) return [];

      const patterns: ErrorPattern[] = [];
      for (const id of ids) {
        const data = await this.redis!.get(COGNITION_KEYS.errorPattern(id));
        if (data) {
          try {
            patterns.push(JSON.parse(data) as ErrorPattern);
          } catch {
            // Skip malformed entries
          }
        }
      }

      patterns.sort((a, b) => b.occurrences - a.occurrences);
      return patterns.slice(0, limit);
    } catch (error) {
      Logger.error('[ErrorPatternStore] Error listing patterns by type:', error);
      return [];
    }
  }

  /**
   * Match a given error message against known patterns.
   *
   * Tokenizes the error message, compares against each pattern's symptoms,
   * and scores by (word match count * occurrences). If toolName is provided,
   * patterns with a matching tool get a 2x boost.
   *
   * @param errorMessage - The error message to match
   * @param toolName - Optional tool that produced the error (boosts matching)
   * @returns Matching patterns sorted by relevance score (descending)
   */
  async match(
    errorMessage: string,
    toolName?: string
  ): Promise<ErrorPattern[]> {
    if (!this.isConnected() || !this.redis) {
      try {
        await this.connect();
      } catch {
        return [];
      }
    }

    try {
      const errorWords = new Set(tokenize(errorMessage));
      if (errorWords.size === 0) return [];

      // Load patterns (bounded to prevent excessive memory use)
      const MAX_MATCH_CANDIDATES = 200;
      const allIds = await this.redis!.zrevrange(
        COGNITION_KEYS.errorPatternsAll(),
        0,
        MAX_MATCH_CANDIDATES - 1
      );

      if (allIds.length === 0) return [];

      const scored: Array<{ pattern: ErrorPattern; score: number }> = [];

      // Batch-fetch all patterns at once
      const keys = allIds.map((id) => COGNITION_KEYS.errorPattern(id));
      const allData = await this.redis!.mget(...keys);

      for (const data of allData) {
        if (!data) continue;

        let pattern: ErrorPattern;
        try {
          pattern = JSON.parse(data) as ErrorPattern;
        } catch {
          continue;
        }

        // Compute word match count across all symptoms
        let matchCount = 0;
        for (const symptom of pattern.symptoms) {
          const symptomWords = tokenize(symptom);
          for (const word of symptomWords) {
            if (errorWords.has(word)) {
              matchCount++;
            }
          }
        }

        // Also check context for matches
        if (pattern.context) {
          const contextWords = tokenize(pattern.context);
          for (const word of contextWords) {
            if (errorWords.has(word)) {
              matchCount += 0.5; // Context matches count less
            }
          }
        }

        // Also check rootCause for matches
        if (pattern.rootCause) {
          const causeWords = tokenize(pattern.rootCause);
          for (const word of causeWords) {
            if (errorWords.has(word)) {
              matchCount += 0.3; // Root cause matches count even less
            }
          }
        }

        if (matchCount === 0) continue;

        // Score = matchCount * occurrences
        let score = matchCount * pattern.occurrences;

        // Tool name boost: 2x if tool matches
        if (toolName && pattern.toolNames.includes(toolName)) {
          score *= 2;
        }

        scored.push({ pattern, score });
      }

      // Sort by score descending
      scored.sort((a, b) => b.score - a.score);


      // Emit match event if results found
      if (scored.length > 0) {
        getCognitionEventBus().emit({
          type: 'error:matched',
          timestamp: Date.now(),
          sessionId: '',
          sourceId: scored[0].pattern.id,
          sourceType: 'error-pattern',
          payload: {
            matchedPatternId: scored[0].pattern.id,
            fix: scored[0].pattern.fix,
            matchCount: scored.length,
          },
        });
      }
      return scored.map((s) => s.pattern);
    } catch (error) {
      Logger.error('[ErrorPatternStore] Error matching patterns:', error);
      return [];
    }
  }

  /**
   * Record an additional occurrence of a known pattern.
   *
   * Increments the occurrences counter, updates lastSeen, and adds
   * the sessionId if not already tracked.
   *
   * @param id - Pattern ID
   * @param sessionId - Session where the occurrence happened
   * @returns true if updated, false if pattern not found or error
   */
  async recordOccurrence(id: string, sessionId: string): Promise<boolean> {
    if (!this.isConnected() || !this.redis) {
      try {
        await this.connect();
      } catch {
        return false;
      }
    }

    try {
      const key = COGNITION_KEYS.errorPattern(id);
      const data = await this.redis!.get(key);
      if (!data) return false;

      const pattern = JSON.parse(data) as ErrorPattern;
      pattern.occurrences += 1;
      pattern.lastSeen = Date.now();

      if (!pattern.sessionIds.includes(sessionId)) {
        pattern.sessionIds.push(sessionId);
      }

      await this.redis!.set(key, JSON.stringify(pattern));

      // Update sorted set scores to reflect new occurrence count
      await this.redis!.zadd(
        COGNITION_KEYS.errorPatternsByType(pattern.errorType),
        pattern.occurrences,
        id
      );
      await this.redis!.zadd(
        COGNITION_KEYS.errorPatternsAll(),
        pattern.occurrences,
        id
      );

      return true;
    } catch (error) {
      Logger.error('[ErrorPatternStore] Error recording occurrence:', error);
      return false;
    }
  }

  /**
   * Get aggregate statistics about all error patterns.
   */
  async getStats(): Promise<{
    total: number;
    byType: Record<string, number>;
    topPatterns: Array<{
      id: string;
      errorType: string;
      occurrences: number;
      fix: string;
    }>;
  }> {
    if (!this.isConnected() || !this.redis) {
      try {
        await this.connect();
      } catch {
        return { total: 0, byType: {}, topPatterns: [] };
      }
    }

    try {
      const allIds = await this.redis!.zrevrange(
        COGNITION_KEYS.errorPatternsAll(),
        0,
        -1
      );

      const byType: Record<string, number> = {};
      const allPatterns: ErrorPattern[] = [];

      for (const id of allIds) {
        const data = await this.redis!.get(COGNITION_KEYS.errorPattern(id));
        if (!data) continue;

        try {
          const pattern = JSON.parse(data) as ErrorPattern;
          allPatterns.push(pattern);
          byType[pattern.errorType] = (byType[pattern.errorType] || 0) + 1;
        } catch {
          // Skip malformed entries
        }
      }

      // Sort by occurrences descending, take top 10
      allPatterns.sort((a, b) => b.occurrences - a.occurrences);
      const topPatterns = allPatterns.slice(0, 10).map((p) => ({
        id: p.id,
        errorType: p.errorType,
        occurrences: p.occurrences,
        fix: p.fix.length > 200 ? p.fix.substring(0, 200) + '...' : p.fix,
      }));

      return {
        total: allPatterns.length,
        byType,
        topPatterns,
      };
    } catch (error) {
      Logger.error('[ErrorPatternStore] Error getting stats:', error);
      return { total: 0, byType: {}, topPatterns: [] };
    }
  }

  /**
   * Find a similar existing pattern by errorType and symptom word overlap.
   *
   * @param errorType - The error classification to match
   * @param symptoms - Symptoms to compare against
   * @returns The matching pattern if >50% symptom overlap, null otherwise
   */
  private async findSimilar(
    errorType: ErrorClassification,
    symptoms: string[]
  ): Promise<ErrorPattern | null> {
    if (!this.redis) return null;

    try {
      const ids = await this.redis.zrevrange(
        COGNITION_KEYS.errorPatternsByType(errorType),
        0,
        -1
      );

      if (ids.length === 0) return null;

      // Build word set from new symptoms (normalized)
      const newWords = new Set(symptoms.flatMap((s) => tokenize(s)));
      if (newWords.size === 0) return null;

      for (const id of ids) {
        const data = await this.redis.get(COGNITION_KEYS.errorPattern(id));
        if (!data) continue;

        let existing: ErrorPattern;
        try {
          existing = JSON.parse(data) as ErrorPattern;
        } catch {
          continue;
        }

        const existingWords = new Set(
          existing.symptoms.flatMap((s) => tokenize(s))
        );

        const overlap = wordOverlap(newWords, existingWords);
        if (overlap > 0.5) {
          return existing;
        }
      }

      return null;
    } catch (error) {
      Logger.error('[ErrorPatternStore] Error finding similar:', error);
      return null;
    }
  }
}

// Singleton
let store: ErrorPatternStore | null = null;

export function getErrorPatternStore(): ErrorPatternStore {
  if (!store) store = new ErrorPatternStore();
  return store;
}

export function resetErrorPatternStore(): void {
  if (store) store.disconnect().catch((err) => Logger.error(err));
  store = null;
}
