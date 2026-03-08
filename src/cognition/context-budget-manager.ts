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
 * Context Budget Manager
 *
 * Metacognition — thinking about what is worth keeping in context.
 * Scans all cognition data for a session (decisions, intents, models,
 * critiques, handoffs, confidence records), scores relevance against
 * the current goal, and suggests what to evict when context is bloated.
 *
 * @module cognition/context-budget-manager
 */

import { RedisBackedService } from '../infrastructure/redis/redis-backed-service.js';
import { Logger } from '../utils/logger.js';
import type { ContextBudgetItem, ContextBudgetEstimate, CognitionRecordType } from './types.js';
import { COGNITION_KEYS, COGNITION_TTL } from './types.js';
import { informationDensity, rankByPerturbationImpact } from './ctc-math.js';
import { getCrossLinker } from './cross-linker.js';
import { getIntentStore } from './intent-store.js';

/**
 * Category definitions with their type importance weights.
 * Higher weight = more important to keep in context.
 */
const TYPE_IMPORTANCE: Record<string, number> = {
  intent: 1.0,
  decision: 0.9,
  handoff: 0.9,
  model: 0.8,
  critique: 0.7,
  'error-pattern': 0.6,
  confidence: 0.4,
};

/**
 * Legacy relevance scoring weights (3 dimensions).
 * Used when no active intent exists for holographic scoring.
 */
const RELEVANCE_WEIGHTS = {
  goalKeyword: 0.4,
  recency: 0.3,
  typeImportance: 0.3,
} as const;

/**
 * Holographic relevance weights (5 base dimensions + perturbation blend).
 *
 * Inspired by the Holographic Principle from GR:
 * The "boundary" (context budget) should maximize information density
 * about the "bulk" (full session) per unit area (token cost).
 *
 * Base dimensions (computed per-item in loadCategoryItems):
 * - infoDensity (0.25): Jensen-Shannon divergence complement / log₂(1+tokens)
 * - causalScore (0.15): 1 if item is in the causal core, 0 otherwise
 *
 * 6th dimension (Lorenz, computed post-hoc in estimate):
 * - perturbationImpact: JSD(full context, context-without-item)
 *   Items with high perturbation are critical anchors — removing them
 *   changes the information landscape significantly.
 *   Blended at PERTURBATION_BLEND (20%) after base scoring.
 */
const HOLOGRAPHIC_WEIGHTS = {
  goalKeyword: 0.20,
  recency: 0.20,
  typeImportance: 0.20,
  infoDensity: 0.25,
  causalScore: 0.15,
} as const;

/**
 * Maximum number of items to sample from each sorted set.
 * Keeps the estimate operation lightweight.
 */
const SAMPLE_SIZE = 10;

/**
 * Fraction of items (from the bottom of the ranking) to suggest for eviction.
 */
const EVICTION_FRACTION = 0.2;

/**
 * Blend weight for perturbation impact (Lorenz 6th dimension).
 * Final relevance = base * (1 - PERTURBATION_BLEND) + perturbation * PERTURBATION_BLEND
 */
const PERTURBATION_BLEND = 0.20;

/**
 * Mapping from category name to the Redis sorted-set key function
 * and the Redis hash/string key function for individual items.
 */
interface CategoryDef {
  category: string;
  sortedSetKey: (sessionId: string) => string;
  itemKey: (id: string) => string;
}

const CATEGORY_DEFS: CategoryDef[] = [
  {
    category: 'decision',
    sortedSetKey: COGNITION_KEYS.decisionsBySession,
    itemKey: COGNITION_KEYS.decision,
  },
  {
    category: 'confidence',
    sortedSetKey: COGNITION_KEYS.confidenceBySession,
    itemKey: COGNITION_KEYS.confidence,
  },
  {
    category: 'intent',
    sortedSetKey: COGNITION_KEYS.intentsBySession,
    itemKey: COGNITION_KEYS.intent,
  },
  {
    category: 'critique',
    sortedSetKey: COGNITION_KEYS.critiquesBySession,
    itemKey: COGNITION_KEYS.critique,
  },
  {
    category: 'handoff',
    sortedSetKey: COGNITION_KEYS.handoffBySession,
    itemKey: COGNITION_KEYS.handoff,
  },
  {
    category: 'model',
    sortedSetKey: COGNITION_KEYS.modelsBySession,
    itemKey: COGNITION_KEYS.model,
  },
];

/**
 * ContextBudgetManager — Redis-backed metacognition engine.
 *
 * Scans cognition items for a session, scores their relevance to the
 * current goal, and produces a budget estimate with eviction suggestions.
 */
export class ContextBudgetManager extends RedisBackedService {
  protected get serviceName() {
    return 'ContextBudgetManager';
  }

  /**
   * Ensure Redis is available, connecting if necessary.
   * Returns true if connected, false otherwise.
   */
  private async ensureConnected(): Promise<boolean> {
    if (this.isConnected() && this.redis) return true;
    try {
      await this.connect();
      return this.isConnected() && this.redis !== null;
    } catch {
      Logger.error('[ContextBudgetManager] Cannot connect to Redis');
      return false;
    }
  }

  /**
   * Produce a full context budget estimate for a session.
   *
   * Scans all cognition sorted sets for the given session, samples
   * recent items from each, scores their relevance to the current goal,
   * and returns a ranked list with eviction suggestions.
   *
   * @param sessionId - Session to analyze
   * @param currentGoal - Optional goal string for relevance scoring
   */
  async estimate(
    sessionId: string,
    currentGoal?: string
  ): Promise<ContextBudgetEstimate> {
    const empty: ContextBudgetEstimate = {
      totalItems: 0,
      totalEstimatedTokens: 0,
      byCategory: {},
      relevanceRanking: [],
      suggestedEvictions: [],
      goalAlignment: 0,
    };

    if (!(await this.ensureConnected())) return empty;

    try {
      const allItems: ContextBudgetItem[] = [];
      const byCategory: Record<string, { count: number; tokens: number }> = {};

      const goalKeywords = this.extractKeywords(currentGoal || '');

      // CTC: Attempt to load causal core for holographic scoring
      let causalCoreItems: Set<string> | null = null;
      let goalText = currentGoal || '';

      if (!goalText) {
        // Try to get active intent as goal
        try {
          const intentStore = getIntentStore();
          if (intentStore.isConnected()) {
            const activeIntent = await intentStore.getActiveIntent(sessionId);
            if (activeIntent) {
              goalText = activeIntent.description;
            }
          }
        } catch {
          // Non-critical
        }
      }

      const useHolographic = goalText.length > 0;

      if (useHolographic) {
        try {
          const crossLinker = getCrossLinker();
          if (crossLinker.isConnected()) {
            const intentStore = getIntentStore();
            const activeIntent = await intentStore.getActiveIntent(sessionId);
            if (activeIntent) {
              const coreResult = await crossLinker.findCausalCore(sessionId, activeIntent.id);
              if (coreResult.coreItems.size > 0) {
                causalCoreItems = coreResult.coreItems;
              }

              // Fire-and-forget: apply gravitational TTL
              // (items near intent get extended TTL — time dilation)
              this.triggerGravitationalTtl(sessionId, activeIntent.id).catch(() => {});
            }
          }
        } catch {
          // Fallback to legacy scoring — causalCoreItems stays null
          Logger.debug('[ContextBudgetManager] CTC scoring unavailable, using legacy');
        }
      }

      for (const def of CATEGORY_DEFS) {
        const items = await this.loadCategoryItems(
          sessionId,
          def,
          goalKeywords,
          useHolographic ? goalText : undefined,
          causalCoreItems,
        );

        if (items.length === 0) continue;

        let categoryTokens = 0;
        for (const item of items) {
          categoryTokens += item.estimatedTokens;
        }

        byCategory[def.category] = {
          count: items.length,
          tokens: categoryTokens,
        };

        allItems.push(...items);
      }

      // ── Lorenz: perturbation impact (6th holographic dimension) ──────
      // Computed post-hoc because it requires ALL items at once:
      // JSD(full context, context-without-item) measures each item's
      // contribution to the information landscape.
      if (useHolographic && allItems.length > 1) {
        const itemTexts = allItems.map((item) => item.summary);
        const rankings = rankByPerturbationImpact(itemTexts);

        const impactByIndex = new Map<number, number>();
        for (const r of rankings) {
          impactByIndex.set(r.index, r.impact);
        }

        for (let i = 0; i < allItems.length; i++) {
          const impact = impactByIndex.get(i) ?? 0;
          const base = allItems[i].relevance;
          allItems[i].relevance =
            Math.round(
              (base * (1 - PERTURBATION_BLEND) + impact * PERTURBATION_BLEND) * 100,
            ) / 100;
        }
      }

      // Sort by relevance descending
      allItems.sort((a, b) => b.relevance - a.relevance);

      // Compute goal alignment as average relevance of the top half (or all if few)
      const topCount = Math.max(1, Math.ceil(allItems.length / 2));
      const topItems = allItems.slice(0, topCount);
      const goalAlignment =
        topItems.length > 0
          ? topItems.reduce((sum, item) => sum + item.relevance, 0) /
            topItems.length
          : 0;

      // Mark bottom fraction as suggested evictions
      const evictionCount = Math.max(
        0,
        Math.floor(allItems.length * EVICTION_FRACTION)
      );
      const suggestedEvictions = allItems.slice(
        allItems.length - evictionCount
      );

      const totalEstimatedTokens = allItems.reduce(
        (sum, item) => sum + item.estimatedTokens,
        0
      );

      const result: ContextBudgetEstimate = {
        totalItems: allItems.length,
        totalEstimatedTokens,
        byCategory,
        relevanceRanking: allItems,
        suggestedEvictions,
        goalAlignment: Math.round(goalAlignment * 100) / 100,
      };

      // Store snapshot in Redis for later reference
      await this.storeSnapshot(sessionId, result);

      return result;
    } catch (error) {
      Logger.error('[ContextBudgetManager] Error computing estimate:', error);
      return empty;
    }
  }

  /**
   * Return cognition items ranked by relevance to the current goal.
   *
   * @param sessionId - Session to analyze
   * @param currentGoal - Goal string for relevance scoring
   */
  async prioritize(
    sessionId: string,
    currentGoal: string
  ): Promise<ContextBudgetItem[]> {
    const est = await this.estimate(sessionId, currentGoal);
    return est.relevanceRanking;
  }

  /**
   * Return items that can be safely evicted from context.
   *
   * @param sessionId - Session to analyze
   * @param currentGoal - Goal string for relevance scoring
   * @param keepTop - Number of top items guaranteed to be kept (default 20)
   */
  async suggestEvictions(
    sessionId: string,
    currentGoal: string,
    keepTop: number = 20
  ): Promise<ContextBudgetItem[]> {
    const est = await this.estimate(sessionId, currentGoal);

    if (est.relevanceRanking.length <= keepTop) {
      // Nothing to evict -- everything fits within the keep threshold
      return [];
    }

    // Everything beyond the keepTop threshold is a candidate for eviction
    return est.relevanceRanking.slice(keepTop);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Load and score items from a single cognition category.
   *
   * Reads the most recent SAMPLE_SIZE IDs from the sorted set, fetches
   * each item's JSON, and produces scored ContextBudgetItem entries.
   */
  private async loadCategoryItems(
    sessionId: string,
    def: CategoryDef,
    goalKeywords: string[],
    goalText?: string,
    causalCoreItems?: Set<string> | null,
  ): Promise<ContextBudgetItem[]> {
    const items: ContextBudgetItem[] = [];

    try {
      const setKey = def.sortedSetKey(sessionId);

      // Get the most recent items (highest score = most recent timestamp)
      const ids = await this.redis!.zrevrange(setKey, 0, SAMPLE_SIZE - 1);

      if (ids.length === 0) return items;

      const now = Date.now();

      for (const id of ids) {
        const data = await this.redis!.get(def.itemKey(id));
        if (!data) continue;

        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(data) as Record<string, unknown>;
        } catch {
          // Skip malformed entries
          continue;
        }

        const summary = this.extractSummary(parsed, def.category);
        const timestamp =
          typeof parsed.timestamp === 'number' ? parsed.timestamp : now;
        const ageMs = now - timestamp;
        const dataLength = data.length;
        const estimatedTokens = Math.ceil(dataLength / 4);

        // Score relevance
        const keywordScore = this.scoreKeywordMatch(
          summary,
          data,
          goalKeywords
        );
        const recencyScore = this.scoreRecency(ageMs);
        const typeScore = TYPE_IMPORTANCE[def.category] ?? 0.5;

        let relevance: number;

        if (goalText && causalCoreItems) {
          // Holographic scoring (CTC-enhanced)
          const infoDensityScore = this.computeInfoDensity(
            summary + ' ' + data.substring(0, 500),
            goalText,
            estimatedTokens,
          );
          const causalScore = this.computeCausalScore(
            id,
            def.category,
            causalCoreItems,
          );

          relevance = Math.min(
            1,
            Math.max(
              0,
              keywordScore * HOLOGRAPHIC_WEIGHTS.goalKeyword +
                recencyScore * HOLOGRAPHIC_WEIGHTS.recency +
                typeScore * HOLOGRAPHIC_WEIGHTS.typeImportance +
                infoDensityScore * HOLOGRAPHIC_WEIGHTS.infoDensity +
                causalScore * HOLOGRAPHIC_WEIGHTS.causalScore,
            ),
          );
        } else {
          // Legacy scoring (fallback)
          relevance = Math.min(
            1,
            Math.max(
              0,
              keywordScore * RELEVANCE_WEIGHTS.goalKeyword +
                recencyScore * RELEVANCE_WEIGHTS.recency +
                typeScore * RELEVANCE_WEIGHTS.typeImportance,
            ),
          );
        }

        items.push({
          id: typeof parsed.id === 'string' ? parsed.id : id,
          category: def.category,
          summary,
          relevance: Math.round(relevance * 100) / 100,
          ageMs,
          accessCount: 1, // Default; Redis does not track reads
          estimatedTokens,
        });
      }
    } catch (error) {
      Logger.error(
        `[ContextBudgetManager] Error loading category ${def.category}:`,
        error
      );
    }

    return items;
  }

  /**
   * Extract a human-readable summary (first 100 chars) from a parsed
   * cognition item. Uses category-specific fields for the best summary.
   */
  private extractSummary(
    parsed: Record<string, unknown>,
    category: string
  ): string {
    let raw: string;

    switch (category) {
      case 'decision':
        raw =
          (parsed.question as string) ||
          (parsed.chosen as string) ||
          '';
        break;
      case 'intent':
        raw = (parsed.description as string) || '';
        break;
      case 'model':
        raw =
          (parsed.name as string) ||
          (parsed.description as string) ||
          '';
        break;
      case 'critique':
        raw =
          Array.isArray(parsed.lessonsLearned) && parsed.lessonsLearned.length > 0
            ? String(parsed.lessonsLearned[0])
            : Array.isArray(parsed.wentWell) && parsed.wentWell.length > 0
              ? String(parsed.wentWell[0])
              : '';
        break;
      case 'handoff':
        raw = (parsed.intent as string) || (parsed.approach as string) || '';
        break;
      case 'confidence':
        raw = `${parsed.toolName || 'unknown'} confidence ${parsed.confidence ?? '?'}`;
        break;
      case 'error-pattern':
        raw =
          (parsed.rootCause as string) ||
          (parsed.context as string) ||
          '';
        break;
      default:
        raw = JSON.stringify(parsed).substring(0, 100);
    }

    if (raw.length > 100) {
      return raw.substring(0, 97) + '...';
    }
    return raw || `[${category} item]`;
  }

  /**
   * Extract lowercase keywords from a goal string.
   * Splits on whitespace and punctuation, filters short tokens.
   */
  private extractKeywords(goal: string): string[] {
    if (!goal) return [];
    return goal
      .toLowerCase()
      .split(/[\s,;.:!?()[\]{}"'`]+/)
      .filter((w) => w.length >= 3)
      .filter(
        (w) =>
          !['the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'will', 'have', 'has'].includes(w)
      );
  }

  /**
   * Score how well an item's text matches the goal keywords.
   * Returns a value in [0, 1].
   */
  private scoreKeywordMatch(
    summary: string,
    fullData: string,
    goalKeywords: string[]
  ): number {
    if (goalKeywords.length === 0) return 0.5; // Neutral when no goal specified

    const lowerSummary = summary.toLowerCase();
    const lowerData = fullData.toLowerCase();

    let matchCount = 0;
    for (const keyword of goalKeywords) {
      // Summary matches are stronger signals
      if (lowerSummary.includes(keyword)) {
        matchCount += 2;
      } else if (lowerData.includes(keyword)) {
        matchCount += 1;
      }
    }

    // Normalize: max possible score = keywords * 2 (all in summary)
    const maxScore = goalKeywords.length * 2;
    return Math.min(1, matchCount / maxScore);
  }

  /**
   * Score recency of an item. More recent items score higher.
   * Uses an exponential decay with a half-life of 1 hour.
   *
   * @param ageMs - Age of the item in milliseconds
   * @returns Score in [0, 1]
   */
  private scoreRecency(ageMs: number): number {
    const halfLifeMs = 60 * 60 * 1000; // 1 hour
    return Math.exp((-Math.LN2 * ageMs) / halfLifeMs);
  }

  /**
   * Compute information density of item text relative to goal.
   * Uses Jensen-Shannon divergence complement / log₂(1 + tokens).
   * (Holographic Principle: maximize info per boundary area)
   */
  private computeInfoDensity(
    itemText: string,
    goalText: string,
    tokenCount: number,
  ): number {
    try {
      return informationDensity(itemText, goalText, tokenCount);
    } catch {
      return 0;
    }
  }

  /**
   * Check if an item is in the causal core.
   * Returns 1.0 if yes, 0.0 if no.
   */
  private computeCausalScore(
    itemId: string,
    itemType: string,
    coreItems: Set<string>,
  ): number {
    return coreItems.has(`${itemType}:${itemId}`) ? 1.0 : 0.0;
  }

  /**
   * Fire-and-forget: apply gravitational TTL dilation.
   * Items near the active intent get extended TTLs.
   */
  private async triggerGravitationalTtl(
    sessionId: string,
    activeIntentId: string,
  ): Promise<void> {
    try {
      const crossLinker = getCrossLinker();
      if (!crossLinker.isConnected()) return;

      // Collect items with their Redis keys
      const items: Array<{ type: CognitionRecordType; id: string; redisKey: string }> = [];
      for (const def of CATEGORY_DEFS) {
        const setKey = def.sortedSetKey(sessionId);
        const ids = await this.redis!.zrevrange(setKey, 0, SAMPLE_SIZE - 1);
        for (const id of ids) {
          items.push({ type: def.category as CognitionRecordType, id, redisKey: def.itemKey(id) });
        }
      }

      if (items.length > 0) {
        await crossLinker.applyGravitationalTtl(sessionId, activeIntentId, items);
      }
    } catch (error) {
      Logger.debug(`[ContextBudgetManager] Gravitational TTL error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Store a budget snapshot in Redis for later reference.
   */
  private async storeSnapshot(
    sessionId: string,
    estimate: ContextBudgetEstimate
  ): Promise<void> {
    try {
      const key = COGNITION_KEYS.budgetSnapshot(sessionId);
      const snapshot = JSON.stringify({
        timestamp: Date.now(),
        ...estimate,
      });
      await this.redis!.set(key, snapshot);
      if (COGNITION_TTL.budget > 0) {
        await this.redis!.expire(key, COGNITION_TTL.budget);
      }
    } catch (error) {
      // Non-critical: log but do not propagate
      Logger.error(
        '[ContextBudgetManager] Error storing snapshot:',
        error
      );
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton
// ─────────────────────────────────────────────────────────────────────────────

let manager: ContextBudgetManager | null = null;

export function getContextBudgetManager(): ContextBudgetManager {
  if (!manager) manager = new ContextBudgetManager();
  return manager;
}

export function resetContextBudgetManager(): void {
  if (manager) manager.disconnect().catch((err) => Logger.error(err));
  manager = null;
}
