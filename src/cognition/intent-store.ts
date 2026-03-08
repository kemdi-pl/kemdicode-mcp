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
import { safeJsonParse } from '../utils/validation.js';
import type { Intent, IntentStatus, DriftAlert } from './types.js';
import { COGNITION_KEYS, COGNITION_TTL, MAX_COGNITION_JSON_SIZE } from './types.js';
import { getCognitionEventBus } from './event-bus.js';
import { randomBytes } from 'crypto';
import { tokenize } from '../utils/nlp.js';

// ─────────────────────────────────────────────────────────────────────────────
// Drift Detection — TF-IDF weighted term overlap + bigram sequence similarity
// ─────────────────────────────────────────────────────────────────────────────

/** Default drift detection threshold — drift scores above this trigger an alert. */
const DEFAULT_DRIFT_THRESHOLD = 0.5;

/**
 * Build a term-frequency map from a token array.
 */
function termFrequency(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const t of tokens) {
    tf.set(t, (tf.get(t) ?? 0) + 1);
  }
  return tf;
}

/**
 * Compute an IDF-like weight for a term given two documents.
 *
 * Traditional IDF = log(N / df) where N = total docs and df = docs containing term.
 * With only two documents we approximate:
 *   - Term in both docs  → weight 1.0  (common, but still relevant)
 *   - Term in one doc    → weight 2.0  (discriminative, amplify mismatch)
 *
 * This rewards overlap of rare (single-document) terms and prevents
 * shared boilerplate from dominating the score.
 */
function idfWeight(inDoc1: boolean, inDoc2: boolean): number {
  if (inDoc1 && inDoc2) return 1.0;
  return 2.0; // term is unique to one document — more discriminative
}

/**
 * Compute TF-IDF weighted cosine similarity between two term-frequency maps.
 *
 * Each term is weighted by TF * IDF. The cosine of the resulting vectors
 * captures directional similarity regardless of document length.
 *
 * @returns similarity in [0, 1] where 1 = identical direction, 0 = orthogonal
 */
function weightedCosineSimilarity(
  tfA: Map<string, number>,
  tfB: Map<string, number>
): number {
  const allTerms = new Set([...tfA.keys(), ...tfB.keys()]);
  if (allTerms.size === 0) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (const term of allTerms) {
    const rawA = tfA.get(term) ?? 0;
    const rawB = tfB.get(term) ?? 0;
    const w = idfWeight(rawA > 0, rawB > 0);

    const wA = rawA * w;
    const wB = rawB * w;

    dotProduct += wA * wB;
    normA += wA * wA;
    normB += wB * wB;
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator > 0 ? dotProduct / denominator : 0;
}

/**
 * Extract ordered bigrams (consecutive word pairs) from a token array.
 */
function extractBigrams(tokens: string[]): Set<string> {
  const bigrams = new Set<string>();
  for (let i = 0; i < tokens.length - 1; i++) {
    bigrams.add(`${tokens[i]}|${tokens[i + 1]}`);
  }
  return bigrams;
}

/**
 * Compute bigram-overlap similarity to capture word-order information.
 * Uses Dice coefficient: 2 * |A ∩ B| / (|A| + |B|).
 *
 * @returns similarity in [0, 1] where 1 = identical ordering, 0 = no shared bigrams
 */
function bigramSimilarity(tokensA: string[], tokensB: string[]): number {
  const bigramsA = extractBigrams(tokensA);
  const bigramsB = extractBigrams(tokensB);

  if (bigramsA.size === 0 && bigramsB.size === 0) return 0;
  if (bigramsA.size === 0 || bigramsB.size === 0) return 0;

  let overlap = 0;
  for (const bg of bigramsA) {
    if (bigramsB.has(bg)) overlap++;
  }

  // Dice coefficient — symmetric and handles size differences well
  return (2 * overlap) / (bigramsA.size + bigramsB.size);
}

/**
 * Detailed drift analysis result (internal).
 */
interface DriftAnalysis {
  /** Combined drift score 0 (aligned) to 1 (divergent) */
  driftScore: number;
  /** TF-IDF weighted term similarity 0-1 */
  termSimilarity: number;
  /** Bigram sequence similarity 0-1 */
  sequenceSimilarity: number;
  /** Human-readable reason explaining the drift score */
  reason: string;
}

/** Weight for TF-IDF term similarity in the combined score */
const TERM_WEIGHT = 0.7;
/** Weight for bigram sequence similarity in the combined score */
const SEQUENCE_WEIGHT = 0.3;

/**
 * Compute a multi-signal drift score between an intent description and a current action.
 *
 * Combines two complementary similarity signals:
 *   1. **TF-IDF weighted cosine similarity** (70%) — captures whether the same
 *      significant terms appear, with IDF weighting to amplify rare/discriminative terms.
 *   2. **Bigram sequence similarity** (30%) — captures whether terms appear in
 *      similar order, detecting cases where the same words are used in a
 *      completely different context.
 *
 * Returns a {@link DriftAnalysis} with the combined score and a human-readable reason.
 */
function computeDriftScore(intentDescription: string, currentAction: string): DriftAnalysis {
  const intentTokens = tokenize(intentDescription);
  const actionTokens = tokenize(currentAction);

  // Insufficient data — return neutral score
  if (intentTokens.length === 0 || actionTokens.length === 0) {
    return {
      driftScore: 0.5,
      termSimilarity: 0,
      sequenceSimilarity: 0,
      reason: 'Insufficient significant terms to compare — defaulting to uncertain (0.5)',
    };
  }

  // Signal 1: TF-IDF weighted cosine similarity
  const tfIntent = termFrequency(intentTokens);
  const tfAction = termFrequency(actionTokens);
  const termSim = weightedCosineSimilarity(tfIntent, tfAction);

  // Signal 2: Bigram (word-order) similarity
  const seqSim = bigramSimilarity(intentTokens, actionTokens);

  // Combined similarity → drift score
  const combinedSimilarity = TERM_WEIGHT * termSim + SEQUENCE_WEIGHT * seqSim;
  const driftScore = Math.round((1 - combinedSimilarity) * 100) / 100;

  // Build human-readable reason
  const reason = buildDriftReason(driftScore, termSim, seqSim, intentTokens, actionTokens, tfIntent, tfAction);

  return { driftScore, termSimilarity: termSim, sequenceSimilarity: seqSim, reason };
}

/**
 * Build a human-readable explanation of the drift score.
 */
function buildDriftReason(
  driftScore: number,
  termSim: number,
  seqSim: number,
  intentTokens: string[],
  actionTokens: string[],
  tfIntent: Map<string, number>,
  tfAction: Map<string, number>
): string {
  const parts: string[] = [];

  // Overall assessment
  if (driftScore <= 0.2) {
    parts.push('Action is well-aligned with intent.');
  } else if (driftScore <= 0.5) {
    parts.push('Action shows moderate alignment with intent.');
  } else if (driftScore <= 0.7) {
    parts.push('Action is drifting from the original intent.');
  } else {
    parts.push('Action has significantly diverged from the original intent.');
  }

  // Term overlap detail
  const intentSet = new Set(intentTokens);
  const actionSet = new Set(actionTokens);
  const sharedTerms: string[] = [];
  const missingFromAction: string[] = [];
  const newInAction: string[] = [];

  for (const t of intentSet) {
    if (actionSet.has(t)) sharedTerms.push(t);
    else missingFromAction.push(t);
  }
  for (const t of actionSet) {
    if (!intentSet.has(t)) newInAction.push(t);
  }

  // Sort by frequency (most frequent first) to highlight the most important terms
  const sortByFreq = (terms: string[], tf: Map<string, number>) =>
    terms.sort((a, b) => (tf.get(b) ?? 0) - (tf.get(a) ?? 0));

  sortByFreq(sharedTerms, tfIntent);
  sortByFreq(missingFromAction, tfIntent);
  sortByFreq(newInAction, tfAction);

  const cap = 5; // max terms to show in reason

  if (sharedTerms.length > 0) {
    parts.push(`Shared terms: ${sharedTerms.slice(0, cap).join(', ')}${sharedTerms.length > cap ? ` (+${sharedTerms.length - cap} more)` : ''}.`);
  }
  if (missingFromAction.length > 0) {
    parts.push(`Intent terms absent from action: ${missingFromAction.slice(0, cap).join(', ')}${missingFromAction.length > cap ? ` (+${missingFromAction.length - cap} more)` : ''}.`);
  }
  if (newInAction.length > 0) {
    parts.push(`New terms in action: ${newInAction.slice(0, cap).join(', ')}${newInAction.length > cap ? ` (+${newInAction.length - cap} more)` : ''}.`);
  }

  // Signal breakdown
  parts.push(`Scores: term=${Math.round(termSim * 100)}%, sequence=${Math.round(seqSim * 100)}%.`);

  return parts.join(' ');
}

/**
 * IntentStore — Redis-backed storage for the human's goal hierarchy.
 *
 * Tracks intents at four levels:
 *   mission > goal > sub-goal > task
 *
 * Detects drift by comparing the current agent action against the
 * active intent's description using TF-IDF weighted cosine similarity
 * (70% weight) combined with bigram sequence similarity (30% weight).
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

      const json = JSON.stringify(fullIntent);
      if (json.length > MAX_COGNITION_JSON_SIZE) {
        Logger.error(`[IntentStore] Payload too large (${json.length} bytes > ${MAX_COGNITION_JSON_SIZE})`);
        return null;
      }

      const pipeline = this.redis.pipeline();

      // Store intent as JSON string
      pipeline.set(key, json);
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
      return safeJsonParse<Intent | null>(data, null);
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

      // Limit drift alerts to prevent unbounded growth (keep last 100)
      const MAX_DRIFT_ALERTS = 100;
      if (intent.driftAlerts.length > MAX_DRIFT_ALERTS) {
        intent.driftAlerts = intent.driftAlerts.slice(-MAX_DRIFT_ALERTS);
      }

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
   * Compares the currentAction against the active intent's description using
   * a combined TF-IDF weighted term similarity (70%) and bigram sequence
   * similarity (30%). If the combined drift score exceeds the threshold,
   * a DriftAlert is created, recorded on the intent, and returned.
   *
   * @param sessionId — session to check
   * @param currentAction — description of what the agent is currently doing
   * @param threshold — drift score above which an alert fires (default 0.5)
   * @returns the alert if drift is detected, null otherwise
   */
  async checkDrift(
    sessionId: string,
    currentAction: string,
    threshold: number = DEFAULT_DRIFT_THRESHOLD
  ): Promise<DriftAlert | null> {
    if (!this.redis) await this.connect();
    if (!this.redis) return null;

    try {
      const activeIntent = await this.getActiveIntent(sessionId);
      if (!activeIntent) return null;

      const analysis = computeDriftScore(activeIntent.description, currentAction);

      if (analysis.driftScore > threshold) {
        const alert: Omit<DriftAlert, 'timestamp'> = {
          currentAction,
          expectedDirection: activeIntent.description,
          driftScore: analysis.driftScore,
          reason: analysis.reason,
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
