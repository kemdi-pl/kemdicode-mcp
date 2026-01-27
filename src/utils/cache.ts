/**
 * KemdiCode MCP Server
 * Copyright (C) 2025-2026 Kemdi Sp. z o.o.
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
 * LRU Cache with TTL Support
 *
 * Simple in-memory cache with Least Recently Used eviction and Time-To-Live expiration.
 * Optimized for caching expensive operations like git commands and file system checks.
 *
 * @module utils/cache
 */

import { config } from '../config/index.js';

/**
 * Cache entry with timestamp and value
 */
interface CacheEntry<T> {
  value: T;
  timestamp: number;
  expiresAt: number;
}

/**
 * Cache options for creating a new cache instance
 */
export interface CacheOptions {
  /** Maximum number of entries (default: 1000) */
  maxEntries?: number;
  /** Default TTL in milliseconds (default: 5 minutes) */
  defaultTTL?: number;
}

/**
 * LRU Cache with TTL support
 *
 * Uses a Map for O(1) access with LRU eviction based on insertion order.
 * Entries expire after TTL and are lazily cleaned up.
 *
 * @example
 * const cache = new LRUCache<string>({ maxEntries: 100, defaultTTL: 60000 });
 * cache.set('key', 'value');
 * const value = cache.get('key');
 */
export class LRUCache<T> {
  private cache: Map<string, CacheEntry<T>>;
  private readonly maxEntries: number;
  private readonly defaultTTL: number;

  constructor(options: CacheOptions = {}) {
    this.cache = new Map();
    const cacheConfig = config.get('cache');
    this.maxEntries = options.maxEntries ?? cacheConfig.maxEntries;
    this.defaultTTL = options.defaultTTL ?? cacheConfig.defaultTtl;
  }

  /**
   * Get a value from the cache
   * Returns undefined if not found or expired
   */
  get(key: string): T | undefined {
    const entry = this.cache.get(key);

    if (!entry) {
      return undefined;
    }

    // Check if expired
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }

    // Move to end (most recently used) by reinserting
    this.cache.delete(key);
    this.cache.set(key, entry);

    return entry.value;
  }

  /**
   * Set a value in the cache
   * @param key - Cache key
   * @param value - Value to cache
   * @param ttl - Optional TTL in milliseconds (overrides default)
   */
  set(key: string, value: T, ttl?: number): void {
    // Remove if exists (for LRU ordering)
    this.cache.delete(key);

    // Evict oldest entries if at capacity
    while (this.cache.size >= this.maxEntries) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
      } else {
        break;
      }
    }

    const now = Date.now();
    this.cache.set(key, {
      value,
      timestamp: now,
      expiresAt: now + (ttl ?? this.defaultTTL),
    });
  }

  /**
   * Check if a key exists and is not expired
   */
  has(key: string): boolean {
    const entry = this.cache.get(key);

    if (!entry) {
      return false;
    }

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return false;
    }

    return true;
  }

  /**
   * Delete a specific key from the cache
   */
  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  /**
   * Clear all entries from the cache
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get the current number of entries (including potentially expired ones)
   */
  get size(): number {
    return this.cache.size;
  }

  /**
   * Get or compute a value
   * If the key exists and is valid, returns cached value.
   * Otherwise, calls the factory function, caches the result, and returns it.
   *
   * @param key - Cache key
   * @param factory - Function to compute the value if not cached
   * @param ttl - Optional TTL in milliseconds
   */
  getOrSet(key: string, factory: () => T, ttl?: number): T {
    const cached = this.get(key);
    if (cached !== undefined) {
      return cached;
    }

    const value = factory();
    this.set(key, value, ttl);
    return value;
  }

  /**
   * Async version of getOrSet
   * If the key exists and is valid, returns cached value.
   * Otherwise, calls the async factory function, caches the result, and returns it.
   *
   * @param key - Cache key
   * @param factory - Async function to compute the value if not cached
   * @param ttl - Optional TTL in milliseconds
   */
  async getOrSetAsync(key: string, factory: () => Promise<T>, ttl?: number): Promise<T> {
    const cached = this.get(key);
    if (cached !== undefined) {
      return cached;
    }

    const value = await factory();
    this.set(key, value, ttl);
    return value;
  }

  /**
   * Remove expired entries (cleanup)
   * Called periodically or manually to free memory
   */
  prune(): number {
    const now = Date.now();
    let pruned = 0;

    for (const [key, entry] of this.cache) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
        pruned++;
      }
    }

    return pruned;
  }

  /**
   * Get cache statistics
   */
  stats(): { size: number; maxEntries: number; defaultTTL: number } {
    return {
      size: this.cache.size,
      maxEntries: this.maxEntries,
      defaultTTL: this.defaultTTL,
    };
  }
}

/**
 * Get cache configuration values
 * Called lazily to allow config to be set up first
 */
function getCacheConfig() {
  return config.get('cache');
}

/**
 * Global cache instances for common use cases
 */

/** Cache for git operations (root detection, repo checks) - uses config TTL */
export const gitCache = new LRUCache<string | boolean | null>({
  maxEntries: getCacheConfig().gitSize,
  defaultTTL: getCacheConfig().gitTtl,
});

/** Cache for file system operations (file exists, file type) - uses config TTL */
export const fsCache = new LRUCache<boolean | string>({
  maxEntries: getCacheConfig().fsSize,
  defaultTTL: getCacheConfig().fsTtl,
});

/** Cache for project detection results - uses config TTL */
export const projectCache = new LRUCache<unknown>({
  maxEntries: getCacheConfig().projectSize,
  defaultTTL: getCacheConfig().projectTtl,
});

/**
 * Clear all global caches
 * Call when project context changes significantly
 */
export function clearAllCaches(): void {
  gitCache.clear();
  fsCache.clear();
  projectCache.clear();
}

/**
 * Prune all global caches
 * Call periodically to free memory from expired entries
 */
export function pruneAllCaches(): number {
  return gitCache.prune() + fsCache.prune() + projectCache.prune();
}
