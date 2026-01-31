/**
 * KemdiCode MCP Server
 * Copyright (C) 2025-2026 Kemdi Sp. z o.o.
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
import type { CognitionRecordType, CognitionLink } from './types.js';
import { COGNITION_LINK_KEYS, COGNITION_TTL } from './types.js';

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

      const pipeline = this.redis.pipeline();
      pipeline.zadd(forwardKey, now, forwardMember);
      pipeline.zadd(backwardKey, now, backwardMember);
      pipeline.set(detailKey, linkValue);

      const ttl = this.computeLinkTtl(
        this.getTtlForType(sourceType),
        this.getTtlForType(targetType),
      );

      if (ttl > 0) {
        pipeline.expire(forwardKey, ttl);
        pipeline.expire(backwardKey, ttl);
        pipeline.expire(detailKey, ttl);
      }

      await pipeline.exec();
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
        const colonIdx = m.indexOf(':');
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
        const colonIdx = m.indexOf(':');
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
