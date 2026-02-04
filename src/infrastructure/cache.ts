/**
 * KemdiCode MCP Server - Response Cache
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
 * Response Cache for Performance Optimization
 *
 * Features:
 * - LRU eviction with configurable max entries
 * - TTL-based expiration
 * - Configurable key prefix for namespace isolation
 * - Memory-efficient serialization
 * - Cache hit/miss statistics
 *
 * @module infrastructure/cache
 */

import { v4 as _uuidv4 } from 'uuid';

export interface CacheConfig {
  /** Maximum number of entries (default: 1000) */
  maxEntries?: number;
  /** Default TTL in ms (default: 60000 = 1 min) */
  defaultTtl?: number;
  /** Key prefix for namespace isolation */
  prefix?: string;
}

interface CacheEntry<T = unknown> {
  value: T;
  expiresAt: number;
  createdAt: number;
  accessCount: number;
  lastAccessed: number;
  key: string;
}

interface CacheStats {
  hits: number;
  misses: number;
  size: number;
  maxSize: number;
  hitRate: number;
}

export class ResponseCache<T = unknown> {
  private cache = new Map<string, CacheEntry>();
  private config: Required<CacheConfig>;
  private stats = { hits: 0, misses: 0 };
  private readonly cleanupInterval: NodeJS.Timeout;
  private cleaning = false;

  constructor(config: CacheConfig = {}) {
    this.config = {
      maxEntries: config.maxEntries ?? 1000,
      defaultTtl: config.defaultTtl ?? 60000,
      prefix: config.prefix ?? '',
    };

    this.cleanupInterval = setInterval(() => this.cleanup(), 30000);
  }

  private getKey(key: string): string {
    return `${this.config.prefix}${key}`;
  }

  get(key: string): T | null {
    const entry = this.cache.get(this.getKey(key));
    if (!entry) {
      this.stats.misses++;
      return null;
    }

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(entry.key);
      this.stats.misses++;
      return null;
    }

    entry.accessCount++;
    entry.lastAccessed = Date.now();
    this.stats.hits++;
    return entry.value as T;
  }

  getOrCompute(key: string, compute: () => T | Promise<T>, ttl?: number): T | Promise<T> {
    const cached = this.get(key);
    if (cached !== null) {
      return cached;
    }

    const result = compute();
    if (result instanceof Promise) {
      return result.then((value) => {
        this.set(key, value, ttl);
        return value;
      });
    }

    this.set(key, result, ttl);
    return result;
  }

  set(key: string, value: T, ttl?: number): void {
    const fullKey = this.getKey(key);
    const now = Date.now();

    if (this.cache.size >= this.config.maxEntries) {
      this.evictOldest();
    }

    this.cache.set(fullKey, {
      value,
      expiresAt: now + (ttl ?? this.config.defaultTtl),
      createdAt: now,
      accessCount: 0,
      lastAccessed: now,
      key: fullKey,
    });
  }

  delete(key: string): boolean {
    return this.cache.delete(this.getKey(key));
  }

  clear(): void {
    this.cache.clear();
    this.stats = { hits: 0, misses: 0 };
  }

  has(key: string): boolean {
    const entry = this.cache.get(this.getKey(key));
    if (!entry) return false;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(entry.key);
      return false;
    }
    return true;
  }

  invalidate(pattern: RegExp): number {
    let count = 0;
    for (const key of this.cache.keys()) {
      if (pattern.test(key)) {
        this.cache.delete(key);
        count++;
      }
    }
    return count;
  }

  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestAccess = Infinity;

    for (const [key, entry] of this.cache) {
      const score = entry.accessCount * 0.5 + (Date.now() - entry.lastAccessed) * 0.5;
      if (score < oldestAccess) {
        oldestAccess = score;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.cache.delete(oldestKey);
    }
  }

  private cleanup(): void {
    if (this.cleaning) return;
    this.cleaning = true;

    const now = Date.now();
    let cleaned = 0;

    for (const [key, entry] of this.cache) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      const { hits, misses } = this.stats;
      const total = hits + misses;
      const _hitRate = total > 0 ? (hits / total) * 100 : 0;
    }

    this.cleaning = false;
  }

  getStats(): CacheStats {
    const { hits, misses } = this.stats;
    const total = hits + misses;
    return {
      hits,
      misses,
      size: this.cache.size,
      maxSize: this.config.maxEntries,
      hitRate: total > 0 ? (hits / total) * 100 : 0,
    };
  }

  getSize(): number {
    return this.cache.size;
  }

  destroy(): void {
    clearInterval(this.cleanupInterval);
    this.cache.clear();
  }
}

export const toolResultCache = new ResponseCache({
  maxEntries: 500,
  defaultTtl: 30000,
  prefix: 'tool:',
});

export const schemaCache = new ResponseCache({
  maxEntries: 200,
  defaultTtl: 300000,
  prefix: 'schema:',
});

export const contextCache = new ResponseCache({
  maxEntries: 100,
  defaultTtl: 60000,
  prefix: 'context:',
});
