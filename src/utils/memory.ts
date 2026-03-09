/**
 * KemdiCode MCP Server - Memory Optimization Utilities
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
 * Memory Optimization Utilities
 *
 * Features:
 * - Object pooling to reduce GC pressure
 * - String interning for repeated strings
 * - Memory pressure detection
 * - WeakRef-based caching for large objects
 *
 * @module utils/memory
 */

export interface MemoryStats {
  heapUsed: number;
  heapTotal: number;
  external: number;
  rss: number;
  arrayBuffers: number;
  usagePercent: number;
}

export interface PoolConfig {
  maxSize: number;
  initialSize: number;
  ttl: number;
}

interface PooledObject<T> {
  object: T;
  lastUsed: number;
  inUse: boolean;
}

/**
 * Object Pool for reducing GC pressure
 */
export class ObjectPool<T extends object> {
  private pool: PooledObject<T>[] = [];
  private factory: () => T;
  private reset: (obj: T) => void;
  private config: PoolConfig;
  private created = 0;

  constructor(factory: () => T, reset: (obj: T) => void, config: Partial<PoolConfig> = {}) {
    this.factory = factory;
    this.reset = reset;
    this.config = {
      maxSize: config.maxSize ?? 100,
      initialSize: config.initialSize ?? 10,
      ttl: config.ttl ?? 60000,
    };

    for (let i = 0; i < this.config.initialSize; i++) {
      this.pool.push({
        object: this.factory(),
        lastUsed: Date.now(),
        inUse: false,
      });
    }
  }

  acquire(): T {
    const now = Date.now();

    for (let i = 0; i < this.pool.length; i++) {
      const item = this.pool[i];
      if (!item.inUse && now - item.lastUsed < this.config.ttl) {
        item.inUse = true;
        item.lastUsed = now;
        this.reset(item.object);
        return item.object;
      }
    }

    if (this.pool.length < this.config.maxSize) {
      const obj = this.factory();
      this.pool.push({ object: obj, lastUsed: now, inUse: true });
      this.created++;
      return obj;
    }

    const oldest = this.pool.reduce((min, item) => (item.lastUsed < min.lastUsed ? item : min));
    oldest.inUse = true;
    oldest.lastUsed = now;
    this.reset(oldest.object);
    return oldest.object;
  }

  release(obj: T): void {
    const item = this.pool.find((i) => i.object === obj);
    if (item) {
      item.inUse = false;
      item.lastUsed = Date.now();
    }
  }

  getStats(): { size: number; inUse: number; created: number } {
    const inUse = this.pool.filter((i) => i.inUse).length;
    return {
      size: this.pool.length,
      inUse,
      created: this.created,
    };
  }

  clear(): void {
    this.pool = [];
    this.created = 0;
  }
}

/**
 * String intern pool for repeated strings
 */
export class StringInternPool {
  private interned = new Map<string, string>();
  private maxSize = 10000;
  private hits = 0;
  private misses = 0;
  private accessOrder: string[] = [];

  constructor(maxSize = 10000) {
    this.maxSize = maxSize;
  }

  intern(str: string): string {
    const existing = this.interned.get(str);
    if (existing) {
      this.hits++;
      this.updateAccessOrder(str);
      return existing;
    }

    this.misses++;
    if (this.interned.size >= this.maxSize) {
      this.evictLeastUsed();
    }

    this.interned.set(str, str);
    this.accessOrder.push(str);
    return str;
  }

  private updateAccessOrder(str: string): void {
    const idx = this.accessOrder.indexOf(str);
    if (idx > -1) {
      this.accessOrder.splice(idx, 1);
      this.accessOrder.push(str);
    }
  }

  private evictLeastUsed(): void {
    if (this.accessOrder.length === 0) return;
    const lru = this.accessOrder.shift()!;
    this.interned.delete(lru);
  }

  getStats(): { size: number; hits: number; misses: number; hitRate: number } {
    const total = this.hits + this.misses;
    return {
      size: this.interned.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? (this.hits / total) * 100 : 0,
    };
  }
}

/**
 * Memory pressure detector
 */
export class MemoryPressureDetector {
  private thresholds = {
    warning: 0.7,
    critical: 0.85,
    emergency: 0.95,
  };
  private callbacks: Array<() => void> = [];
  private interval: NodeJS.Timeout | null = null;
  private lastStatus: 'normal' | 'warning' | 'critical' | 'emergency' = 'normal';

  constructor(config?: { warning?: number; critical?: number; emergency?: number }) {
    if (config) {
      this.thresholds = {
        warning: config.warning ?? 0.7,
        critical: config.critical ?? 0.85,
        emergency: config.emergency ?? 0.95,
      };
    }
  }

  start(checkIntervalMs = 5000): void {
    if (this.interval) return;
    this.interval = setInterval(() => this.check(), checkIntervalMs);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  onPressure(callback: () => void): void {
    this.callbacks.push(callback);
  }

  getMemoryStats(): MemoryStats {
    const usage = process.memoryUsage();
    const total = usage.heapTotal;
    const used = usage.heapUsed;
    const usagePercent = total > 0 ? used / total : 0;

    return {
      heapUsed: used,
      heapTotal: total,
      external: usage.external,
      rss: usage.rss,
      arrayBuffers: usage.arrayBuffers || 0,
      usagePercent,
    };
  }

  private check(): void {
    const stats = this.getMemoryStats();
    let status: 'normal' | 'warning' | 'critical' | 'emergency' = 'normal';

    if (stats.usagePercent >= this.thresholds.emergency) {
      status = 'emergency';
    } else if (stats.usagePercent >= this.thresholds.critical) {
      status = 'critical';
    } else if (stats.usagePercent >= this.thresholds.warning) {
      status = 'warning';
    }

    if (status !== this.lastStatus) {
      this.lastStatus = status;
      for (const cb of this.callbacks) {
        try {
          cb();
        } catch {
          /* ignore callback errors */
        }
      }
    }
  }

  getStatus(): typeof this.lastStatus {
    return this.lastStatus;
  }
}

/**
 * Weak cache for large objects that shouldn't prevent GC
 */
export class WeakCache<K extends object, V> {
  private cache = new WeakMap<K, V>();
  private finalizers: WeakRef<object>[] = [];
  private maxFinalizers = 100;

  set(key: K, value: V, onEvicted?: (value: V) => void): void {
    if (onEvicted) {
      const ref = new WeakRef(key);
      this.finalizers.push(ref);
      if (this.finalizers.length > this.maxFinalizers) {
        this.finalizers.shift();
      }
    }
    this.cache.set(key, value);
  }

  get(key: K): V | undefined {
    return this.cache.get(key);
  }

  has(key: K): boolean {
    return this.cache.has(key);
  }

  delete(key: K): boolean {
    return this.cache.delete(key);
  }

  gc(): void {
    const alive = new Set<WeakRef<object>>();
    for (const ref of this.finalizers) {
      if (ref.deref()) {
        alive.add(ref);
      }
    }
    this.finalizers = [...alive];
  }
}

/**
 * Shared pools for common types
 */
export const stringPool = new StringInternPool(5000);

export const memoryDetector = new MemoryPressureDetector();

memoryDetector.start();

export function getMemoryStats(): MemoryStats {
  return memoryDetector.getMemoryStats();
}
