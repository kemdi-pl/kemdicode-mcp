/**
 * KemdiCode MCP Server
 * Copyright (C) 2025-2026 Kemdi Sp. z o.o. (Dawid Irzyk <dawid@kemdi.pl>)
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

/**
 * Cognition Cross-Linker
 *
 * Redis-backed bidirectional link manager between cognition records.
 * Enables querying "what is linked to this decision?" or
 * "what caused this error pattern to be created?"
 *
 * Links are stored as sorted sets (scored by timestamp) for temporal ordering.
 * TTL is computed as min(source_ttl, target_ttl).
 *
 * @module cognition/cross-linker
 */

import { RedisBackedService } from '../infrastructure/redis/redis-backed-service.js';
import { Logger } from '../utils/logger.js';
import type { CognitionRecordType, CognitionLink, CausalCoreResult, ConsistencyViolation } from './types.js';
import { COGNITION_LINK_KEYS, COGNITION_KEYS, COGNITION_TTL } from './types.js';
import {
  findCausalCore as computeCausalCore,
  gravitationalTtl,
  type CognitionItemRef,
  type CausalEdge,
} from './ctc-math.js';

export class CognitionCrossLinker extends RedisBackedService {
  protected get serviceName() {
    return 'CognitionCrossLinker';
  }

  /**
   * Create a bidirectional link between two cognition records.
   */
  async link(
    sourceType: CognitionRecordType,
    sourceId: string,
    targetType: CognitionRecordType,
    targetId: string,
    reason: string,
  ): Promise<boolean> {
    try {
      await this.connect();
      if (!this.redis) return false;

      const now = Date.now();
      const forwardKey = COGNITION_LINK_KEYS.links(sourceType, sourceId);
      const backwardKey = COGNITION_LINK_KEYS.backlinks(targetType, targetId);
      const detailKey = COGNITION_LINK_KEYS.detail(sourceType, sourceId, targetType, targetId);

      const linkValue = JSON.stringify({
        sourceType,
        sourceId,
        targetType,
        targetId,
        reason,
        createdAt: now,
      } satisfies CognitionLink);

      const forwardMember = `${targetType}:${targetId}`;
      const backwardMember = `${sourceType}:${sourceId}`;

      const tx = this.redis.multi();
      tx.zadd(forwardKey, now, forwardMember);
      tx.zadd(backwardKey, now, backwardMember);
      tx.set(detailKey, linkValue);

      const ttl = this.computeLinkTtl(
        this.getTtlForType(sourceType),
        this.getTtlForType(targetType),
      );

      if (ttl > 0) {
        tx.expire(forwardKey, ttl);
        tx.expire(backwardKey, ttl);
        tx.expire(detailKey, ttl);
      }

      await tx.exec();
      Logger.debug(
        `[CrossLinker] Linked ${sourceType}:${sourceId} -> ${targetType}:${targetId} (${reason})`,
      );
      return true;
    } catch (error) {
      Logger.error('[CrossLinker] Link error:', error);
      return false;
    }
  }

  /**
   * Get all records linked FROM a given record.
   */
  async getLinks(
    sourceType: CognitionRecordType,
    sourceId: string,
  ): Promise<Array<{ type: CognitionRecordType; id: string }>> {
    try {
      await this.connect();
      if (!this.redis) return [];

      const key = COGNITION_LINK_KEYS.links(sourceType, sourceId);
      const members = await this.redis.zrevrange(key, 0, -1);

      return members.map((m) => {
        const colonIdx = m.lastIndexOf(':');
        return {
          type: m.substring(0, colonIdx) as CognitionRecordType,
          id: m.substring(colonIdx + 1),
        };
      });
    } catch (error) {
      Logger.error('[CrossLinker] getLinks error:', error);
      return [];
    }
  }

  /**
   * Get all records linked TO a given record (backlinks).
   */
  async getBacklinks(
    targetType: CognitionRecordType,
    targetId: string,
  ): Promise<Array<{ type: CognitionRecordType; id: string }>> {
    try {
      await this.connect();
      if (!this.redis) return [];

      const key = COGNITION_LINK_KEYS.backlinks(targetType, targetId);
      const members = await this.redis.zrevrange(key, 0, -1);

      return members.map((m) => {
        const colonIdx = m.lastIndexOf(':');
        return {
          type: m.substring(0, colonIdx) as CognitionRecordType,
          id: m.substring(colonIdx + 1),
        };
      });
    } catch (error) {
      Logger.error('[CrossLinker] getBacklinks error:', error);
      return [];
    }
  }

  /**
   * Get link detail (reason, timestamp).
   */
  async getLinkDetail(
    sourceType: CognitionRecordType,
    sourceId: string,
    targetType: CognitionRecordType,
    targetId: string,
  ): Promise<CognitionLink | null> {
    try {
      await this.connect();
      if (!this.redis) return null;

      const key = COGNITION_LINK_KEYS.detail(sourceType, sourceId, targetType, targetId);
      const raw = await this.redis.get(key);
      return raw ? (JSON.parse(raw) as CognitionLink) : null;
    } catch (error) {
      Logger.error('[CrossLinker] getLinkDetail error:', error);
      return null;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // CTC Extensions — Causal Structure, Gravitational TTL, Consistency
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Build adjacency list from all cross-links for a set of items.
   * Reads forward links from Redis for each item.
   */
  async buildAdjacencyList(
    items: Array<{ type: CognitionRecordType; id: string }>,
  ): Promise<CausalEdge[]> {
    try {
      await this.connect();
      if (!this.redis) return [];

      const edges: CausalEdge[] = [];
      for (const item of items) {
        const links = await this.getLinks(item.type, item.id);
        for (const link of links) {
          edges.push({
            from: { type: item.type, id: item.id },
            to: { type: link.type, id: link.id },
          });
        }
      }
      return edges;
    } catch (error) {
      Logger.error('[CrossLinker] buildAdjacencyList error:', error);
      return [];
    }
  }

  /**
   * Find the causal core — minimal set of items preserving all causal
   * paths from ancestors to the active intent.
   *
   * Uses reverse BFS + transitive reduction from ctc-math.
   * Result is cached in Redis for 1 hour.
   */
  async findCausalCore(
    sessionId: string,
    activeIntentId: string,
  ): Promise<CausalCoreResult> {
    const empty: CausalCoreResult = {
      coreItems: new Set(),
      totalItems: 0,
      sessionId,
      computedAt: Date.now(),
    };

    try {
      await this.connect();
      if (!this.redis) return empty;

      // Check cache first
      const cacheKey = COGNITION_KEYS.causalCore(sessionId);
      const cached = await this.redis.smembers(cacheKey);
      if (cached.length > 0) {
        return {
          coreItems: new Set(cached),
          totalItems: cached.length,
          sessionId,
          computedAt: Date.now(),
        };
      }

      // Collect all items from cognition stores for this session
      const allItems: CognitionItemRef[] = [];
      const categories: Array<{ type: CognitionRecordType; key: string }> = [
        { type: 'decision', key: COGNITION_KEYS.decisionsBySession(sessionId) },
        { type: 'confidence', key: COGNITION_KEYS.confidenceBySession(sessionId) },
        { type: 'intent', key: COGNITION_KEYS.intentsBySession(sessionId) },
        { type: 'critique', key: COGNITION_KEYS.critiquesBySession(sessionId) },
        { type: 'handoff', key: COGNITION_KEYS.handoffBySession(sessionId) },
        { type: 'model', key: COGNITION_KEYS.modelsBySession(sessionId) },
      ];

      for (const cat of categories) {
        const ids = await this.redis.zrevrange(cat.key, 0, 49); // max 50 per category
        for (const id of ids) {
          allItems.push({ type: cat.type, id });
        }
      }

      if (allItems.length === 0) return empty;

      // Build edge list from cross-links
      const edges = await this.buildAdjacencyList(
        allItems as Array<{ type: CognitionRecordType; id: string }>,
      );

      // Active intent is the root
      const activeIntents: CognitionItemRef[] = [{ type: 'intent', id: activeIntentId }];

      // Compute causal core
      const result = computeCausalCore(allItems, edges, activeIntents);

      // Cache result
      if (result.coreItems.size > 0) {
        const pipeline = this.redis.pipeline();
        pipeline.sadd(cacheKey, ...result.coreItems);
        pipeline.expire(cacheKey, COGNITION_TTL.causalCore);
        await pipeline.exec();
      }

      return {
        coreItems: result.coreItems,
        totalItems: allItems.length,
        sessionId,
        computedAt: Date.now(),
      };
    } catch (error) {
      Logger.error('[CrossLinker] findCausalCore error:', error);
      return empty;
    }
  }

  /**
   * Compute graph proximity between two items via BFS.
   *
   *   proximity = 1 / (1 + shortestPathLength)
   *
   * Returns 0 if items are not connected within maxDepth.
   */
  async computeProximity(
    sourceType: CognitionRecordType,
    sourceId: string,
    targetType: CognitionRecordType,
    targetId: string,
    maxDepth: number = 10,
  ): Promise<number> {
    try {
      await this.connect();
      if (!this.redis) return 0;

      const targetKey = `${targetType}:${targetId}`;
      const sourceKey = `${sourceType}:${sourceId}`;

      if (sourceKey === targetKey) return 1; // self-proximity

      // BFS from source
      const visited = new Set<string>([sourceKey]);
      let frontier: Array<{ type: CognitionRecordType; id: string }> = [
        { type: sourceType, id: sourceId },
      ];
      let depth = 0;

      while (frontier.length > 0 && depth < maxDepth) {
        depth++;
        const nextFrontier: Array<{ type: CognitionRecordType; id: string }> = [];

        for (const node of frontier) {
          // Check forward links
          const links = await this.getLinks(node.type, node.id);
          // Check backward links too (undirected search)
          const backlinks = await this.getBacklinks(node.type, node.id);
          const allNeighbors = [...links, ...backlinks];

          for (const neighbor of allNeighbors) {
            const key = `${neighbor.type}:${neighbor.id}`;
            if (key === targetKey) {
              return 1 / (1 + depth);
            }
            if (!visited.has(key)) {
              visited.add(key);
              nextFrontier.push(neighbor);
            }
          }
        }

        frontier = nextFrontier;
      }

      return 0; // Not reachable within maxDepth
    } catch (error) {
      Logger.error('[CrossLinker] computeProximity error:', error);
      return 0;
    }
  }

  /**
   * Validate cross-link consistency for a session.
   *
   * Checks whether all link targets still exist in Redis.
   * Broken links are "paradoxes" — they reference expired state.
   */
  async validateConsistency(sessionId: string): Promise<ConsistencyViolation[]> {
    const violations: ConsistencyViolation[] = [];

    try {
      await this.connect();
      if (!this.redis) return violations;

      // Collect all items from session
      const categories: Array<{ type: CognitionRecordType; keyFn: (id: string) => string; sessionKey: string }> = [
        { type: 'decision', keyFn: COGNITION_KEYS.decision, sessionKey: COGNITION_KEYS.decisionsBySession(sessionId) },
        { type: 'confidence', keyFn: COGNITION_KEYS.confidence, sessionKey: COGNITION_KEYS.confidenceBySession(sessionId) },
        { type: 'intent', keyFn: COGNITION_KEYS.intent, sessionKey: COGNITION_KEYS.intentsBySession(sessionId) },
        { type: 'critique', keyFn: COGNITION_KEYS.critique, sessionKey: COGNITION_KEYS.critiquesBySession(sessionId) },
        { type: 'handoff', keyFn: COGNITION_KEYS.handoff, sessionKey: COGNITION_KEYS.handoffBySession(sessionId) },
        { type: 'model', keyFn: COGNITION_KEYS.model, sessionKey: COGNITION_KEYS.modelsBySession(sessionId) },
      ];

      // Key function map for checking target existence
      const keyFnMap: Record<string, (id: string) => string> = {
        decision: COGNITION_KEYS.decision,
        confidence: COGNITION_KEYS.confidence,
        intent: COGNITION_KEYS.intent,
        critique: COGNITION_KEYS.critique,
        handoff: COGNITION_KEYS.handoff,
        model: COGNITION_KEYS.model,
        'error-pattern': COGNITION_KEYS.errorPattern,
      };

      for (const cat of categories) {
        const ids = await this.redis.zrevrange(cat.sessionKey, 0, 49);

        for (const id of ids) {
          const links = await this.getLinks(cat.type, id);

          for (const link of links) {
            const targetKeyFn = keyFnMap[link.type];
            if (!targetKeyFn) continue;

            const targetRedisKey = targetKeyFn(link.id);
            const exists = await this.redis.exists(targetRedisKey);

            if (!exists) {
              const detail = await this.getLinkDetail(cat.type, id, link.type, link.id);
              violations.push({
                link: detail || {
                  sourceType: cat.type,
                  sourceId: id,
                  targetType: link.type,
                  targetId: link.id,
                  reason: 'unknown',
                  createdAt: 0,
                },
                missingTarget: true,
              });
            }
          }
        }
      }

      return violations;
    } catch (error) {
      Logger.error('[CrossLinker] validateConsistency error:', error);
      return violations;
    }
  }

  /**
   * Apply gravitational TTL dilation to cognition items.
   *
   * Items closer to the active intent receive longer TTLs,
   * like clocks running slower near a massive object.
   *
   * Formula: TTL_eff = TTL_base × (1 + γ / (1 + distance))
   */
  async applyGravitationalTtl(
    sessionId: string,
    activeIntentId: string,
    items: Array<{ type: CognitionRecordType; id: string; redisKey: string }>,
  ): Promise<{ updated: number; skipped: number }> {
    let updated = 0;
    let skipped = 0;

    try {
      await this.connect();
      if (!this.redis) return { updated, skipped };

      for (const item of items) {
        const baseTtl = this.getTtlForType(item.type);
        if (baseTtl === 0) {
          skipped++; // permanent items stay permanent
          continue;
        }

        const proximity = await this.computeProximity(
          item.type, item.id,
          'intent', activeIntentId,
          6, // max 6 hops for TTL computation
        );

        if (proximity === 0) {
          skipped++; // not connected, keep base TTL
          continue;
        }

        const distance = proximity > 0 ? (1 / proximity) - 1 : Infinity;
        const effectiveTtl = gravitationalTtl(baseTtl, distance);

        if (effectiveTtl > baseTtl) {
          await this.redis.expire(item.redisKey, effectiveTtl);
          updated++;
        } else {
          skipped++;
        }
      }

      Logger.debug(
        `[CrossLinker] Gravitational TTL applied: ${updated} updated, ${skipped} skipped`,
      );
      return { updated, skipped };
    } catch (error) {
      Logger.error('[CrossLinker] applyGravitationalTtl error:', error);
      return { updated, skipped };
    }
  }

  private getTtlForType(type: CognitionRecordType): number {
    const map: Record<CognitionRecordType, number> = {
      decision: COGNITION_TTL.decision,
      confidence: COGNITION_TTL.confidence,
      'error-pattern': COGNITION_TTL.errorPattern,
      intent: COGNITION_TTL.intent,
      critique: COGNITION_TTL.critique,
      handoff: COGNITION_TTL.handoff,
      model: COGNITION_TTL.model,
    };
    return map[type] ?? 604800;
  }

  private computeLinkTtl(a: number, b: number): number {
    if (a === 0 && b === 0) return 0;
    if (a === 0) return b;
    if (b === 0) return a;
    return Math.min(a, b);
  }
}

// Singleton
let linker: CognitionCrossLinker | null = null;

export function getCrossLinker(): CognitionCrossLinker {
  if (!linker) linker = new CognitionCrossLinker();
  return linker;
}

export function resetCrossLinker(): void {
  if (linker) linker.disconnect().catch((err) => Logger.error(err));
  linker = null;
}
