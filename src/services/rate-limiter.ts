/**
 * KemdiCode MCP Server - Rate Limiter Service
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
 * Rate Limiter Service
 *
 * Features:
 * - Sliding window rate limiting
 * - Per-key limiting (IP, user, API key)
 * - Distributed rate limiting with Redis
 * - Automatic rate limiting tiers
 * - Rate limit headers (RFC 6585)
 *
 * @module services/rate-limiter
 */

import { getSharedRedis } from '../infrastructure/redis/connection.js';

export interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
  blockDurationMs?: number;
  skipOnSuccess?: boolean;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  resetAt: number;
  retryAfter?: number;
}

export interface RateLimitHeaders {
  'RateLimit-Limit': string;
  'RateLimit-Remaining': string;
  'RateLimit-Reset': string;
  'Retry-After'?: string;
}

export class RateLimiterService {
  private configs: Map<string, RateLimitConfig> = new Map();
  private memoryLimits: Map<string, { count: number; resetAt: number }> = new Map();
  private readonly defaultConfig: RateLimitConfig = {
    windowMs: 60000,
    maxRequests: 100,
  };

  constructor() {
    this.configs.set('default', this.defaultConfig);
  }

  registerTier(tier: string, config: RateLimitConfig): void {
    this.configs.set(tier, config);
  }

  async check(key: string, tier = 'default'): Promise<RateLimitResult> {
    const config = this.configs.get(tier) || this.defaultConfig;

    const redis = await this.tryGetRedis();
    if (redis) {
      return this.checkRedis(key, config, redis);
    }

    return this.checkMemory(key, config);
  }

  private async checkRedis(
    key: string,
    config: RateLimitConfig,
    redis: Awaited<ReturnType<typeof getSharedRedis>>
  ): Promise<RateLimitResult> {
    const now = Date.now();
    const windowStart = Math.floor(now / config.windowMs) * config.windowMs;
    const windowKey = `ratelimit:${key}:${windowStart}`;
    const blockKey = `ratelimit:block:${key}`;

    const isBlocked = await redis.get(blockKey);
    if (isBlocked) {
      const ttl = await redis.ttl(blockKey);
      return {
        allowed: false,
        remaining: 0,
        limit: config.maxRequests,
        resetAt: now + ttl * 1000,
        retryAfter: ttl,
      };
    }

    const current = parseInt((await redis.get(windowKey)) || '0', 10);

    if (current >= config.maxRequests) {
      await redis.set(blockKey, '1', 'PX', config.blockDurationMs || config.windowMs);

      return {
        allowed: false,
        remaining: 0,
        limit: config.maxRequests,
        resetAt: windowStart + config.windowMs,
        retryAfter: Math.ceil((config.blockDurationMs || config.windowMs) / 1000),
      };
    }

    const newCount = await redis.incr(windowKey);
    if (newCount === 1) {
      await redis.pexpire(windowKey, config.windowMs);
    }

    const resetAt = windowStart + config.windowMs;

    return {
      allowed: true,
      remaining: Math.max(0, config.maxRequests - newCount),
      limit: config.maxRequests,
      resetAt,
    };
  }

  private checkMemory(key: string, config: RateLimitConfig): RateLimitResult {
    const now = Date.now();
    const entry = this.memoryLimits.get(key);

    if (!entry || now >= entry.resetAt) {
      this.memoryLimits.set(key, {
        count: 1,
        resetAt: now + config.windowMs,
      });

      return {
        allowed: true,
        remaining: config.maxRequests - 1,
        limit: config.maxRequests,
        resetAt: now + config.windowMs,
      };
    }

    if (entry.count >= config.maxRequests) {
      return {
        allowed: false,
        remaining: 0,
        limit: config.maxRequests,
        resetAt: entry.resetAt,
      };
    }

    entry.count++;

    return {
      allowed: true,
      remaining: config.maxRequests - entry.count,
      limit: config.maxRequests,
      resetAt: entry.resetAt,
    };
  }

  async checkMultiple(
    keys: Array<{ key: string; tier?: string }>
  ): Promise<Map<string, RateLimitResult>> {
    const results = new Map<string, RateLimitResult>();

    for (const { key, tier } of keys) {
      results.set(key, await this.check(key, tier));
    }

    return results;
  }

  headers(result: RateLimitResult): RateLimitHeaders {
    return {
      'RateLimit-Limit': String(result.limit),
      'RateLimit-Remaining': String(result.remaining),
      'RateLimit-Reset': String(Math.ceil(result.resetAt / 1000)),
      ...(result.retryAfter && { 'Retry-After': String(result.retryAfter) }),
    };
  }

  async reset(key: string): Promise<void> {
    const redis = await this.tryGetRedis();
    if (redis) {
      // Use SCAN instead of KEYS to avoid blocking Redis in production
      let cursor = '0';
      do {
        const [nextCursor, batch] = await redis.scan(
          cursor,
          'MATCH',
          `ratelimit:${key}:*`,
          'COUNT',
          100
        );
        cursor = nextCursor;
        if (batch.length > 0) {
          await redis.del(...batch);
        }
      } while (cursor !== '0');
      await redis.del(`ratelimit:block:${key}`);
    }
    this.memoryLimits.delete(key);
  }

  async getStats(): Promise<{
    memoryKeys: number;
    configuredTiers: string[];
  }> {
    return {
      memoryKeys: this.memoryLimits.size,
      configuredTiers: [...this.configs.keys()],
    };
  }

  private async tryGetRedis(): Promise<Awaited<ReturnType<typeof getSharedRedis>> | null> {
    try {
      return await getSharedRedis();
    } catch {
      return null;
    }
  }
}

export const rateLimiter = new RateLimiterService();

rateLimiter.registerTier('strict', {
  windowMs: 60000,
  maxRequests: 10,
  blockDurationMs: 300000,
});

rateLimiter.registerTier('relaxed', {
  windowMs: 60000,
  maxRequests: 500,
  blockDurationMs: 60000,
});

rateLimiter.registerTier('api', {
  windowMs: 1000,
  maxRequests: 10,
  blockDurationMs: 60000,
});
