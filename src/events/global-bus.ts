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
 * Global Event Bus
 *
 * Singleton in-process EventEmitter for cross-module communication.
 * Supports namespaced events (module:category:action) and optional
 * Redis bridge for cross-session propagation.
 *
 * @module events/global-bus
 */

import { EventEmitter } from 'node:events';
import { Logger } from '../utils/logger.js';
import type {
  GlobalEvent,
  GlobalEventType,
  EventHandler,
  EventSubscription,
  EventMetadata,
  RedisEventOptions,
} from './types.js';

/** Max event chain depth before dropping to prevent cascading storms */
const MAX_EVENT_CHAIN_DEPTH = 8;

/** Default max listeners (env: MCP_EVENT_MAX_LISTENERS, default: 100) */
const DEFAULT_MAX_LISTENERS = (() => {
  const val = process.env.MCP_EVENT_MAX_LISTENERS;
  if (val) { const n = parseInt(val, 10); if (!isNaN(n) && n > 0) return n; }
  return 500;
})();

/** Max retry attempts for Redis bridge (env: MCP_EVENT_REDIS_RETRIES, default: 2) */
const REDIS_BRIDGE_RETRIES = (() => {
  const val = process.env.MCP_EVENT_REDIS_RETRIES;
  if (val) { const n = parseInt(val, 10); if (!isNaN(n) && n >= 0) return n; }
  return 2;
})();

/** Threshold (% of maxListeners) at which a leak warning is emitted */
const LEAK_WARN_THRESHOLD = 0.8;

class GlobalEventBus {
  private emitter = new EventEmitter();
  private _initialized = false;
  private redisBridge: ((event: GlobalEvent, options?: RedisEventOptions) => Promise<void>) | null = null;
  private activeSubscriptions = new Set<EventSubscription>();
  private maxListeners: number;
  /** Current chain depth — set by handler wrapper, read by emit() for propagation */
  _emitDepth = 0;
  /** Track subscription creation times for idle cleanup */
  private subscriptionMeta = new Map<EventSubscription, { createdAt: number; lastInvokedAt: number; eventType: string; permanent: boolean }>();
  /** Periodic cleanup interval for idle subscriptions */
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  /** Idle subscription TTL (env: MCP_EVENT_IDLE_TTL_MS, default: 10 min) */
  private readonly subscriptionIdleTtlMs = parseInt(process.env.MCP_EVENT_IDLE_TTL_MS || String(10 * 60 * 1000), 10);
  /** Cleanup interval (env: MCP_EVENT_CLEANUP_MS, default: 2 min) */
  private readonly cleanupIntervalMs = parseInt(process.env.MCP_EVENT_CLEANUP_MS || String(2 * 60 * 1000), 10);

  constructor(maxListeners?: number) {
    this.maxListeners = maxListeners ?? DEFAULT_MAX_LISTENERS;
    this.emitter.setMaxListeners(this.maxListeners);

    // Start periodic idle subscription cleanup
    this.cleanupInterval = setInterval(() => {
      this.cleanupIdleSubscriptions();
    }, this.cleanupIntervalMs);
  }

  /**
   * Subscribe to an event type. Handlers run asynchronously via queueMicrotask.
   * Returns a subscription that auto-removes from tracking on unsubscribe.
   */
  on<T = unknown>(eventType: GlobalEventType | string, handler: EventHandler<T>, options?: { permanent?: boolean }): EventSubscription {
    // Use a named reference so we can track invocations
    let subscriptionRef: EventSubscription | null = null;
    const wrappedHandler = (event: GlobalEvent) => {
      const runHandler = async () => {
        // Track last invocation time for idle cleanup
        if (subscriptionRef) {
          const meta = this.subscriptionMeta.get(subscriptionRef);
          if (meta) meta.lastInvokedAt = Date.now();
        }
        const prevDepth = this._emitDepth;
        this._emitDepth = (event._chainDepth ?? 0) + 1;
        try {
          await (handler as EventHandler)(event);
        } catch (err) {
          Logger.error(`[GlobalEventBus] Handler error for ${eventType}:`, err);
        } finally {
          this._emitDepth = prevDepth;
        }
      };

      // Priority-aware scheduling with rejection safety:
      // runHandler is async — its returned Promise must be caught to avoid
      // unhandled rejections that can crash the Node.js process.
      const safeRun = () => {
        runHandler().catch((err) => {
          Logger.error(`[GlobalEventBus] Async handler error for ${eventType}:`, err);
        });
      };
      const priority = (event as GlobalEvent & { _priority?: string })._priority;
      if (priority === 'low') {
        setTimeout(safeRun, 0);
      } else {
        queueMicrotask(safeRun);
      }
    };

    this.emitter.on(eventType, wrappedHandler);

    const subscription: EventSubscription = {
      unsubscribe: () => {
        this.emitter.removeListener(eventType, wrappedHandler);
        this.activeSubscriptions.delete(subscription);
        this.subscriptionMeta.delete(subscription);
      },
    };

    this.activeSubscriptions.add(subscription);
    subscriptionRef = subscription;
    this.subscriptionMeta.set(subscription, {
      createdAt: Date.now(),
      lastInvokedAt: Date.now(),
      eventType: String(eventType),
      permanent: options?.permanent ?? false,
    });

    // Warn if approaching maxListeners
    if (this.totalListeners >= this.maxListeners * LEAK_WARN_THRESHOLD) {
      Logger.warn(
        `[GlobalEventBus] Listener count ${this.totalListeners}/${this.maxListeners} approaching limit. ` +
        `Active subscriptions: ${this.activeSubscriptions.size}. Top events: ${JSON.stringify(this.getListenerCounts())}`,
      );
    }

    return subscription;
  }

  /**
   * Emit an event. Local handlers run async. Optionally publishes to Redis.
   */
  emit(
    eventType: GlobalEventType | string,
    payload: Record<string, unknown>,
    metadata: EventMetadata & { priority?: 'high' | 'normal' | 'low' },
    options?: RedisEventOptions,
  ): void {
    const chainDepth = this._emitDepth;

    if (chainDepth >= MAX_EVENT_CHAIN_DEPTH) {
      Logger.warn(`[GlobalEventBus] Event chain depth limit (${MAX_EVENT_CHAIN_DEPTH}) reached for ${eventType} from ${metadata.sourceModule} — dropping event`);
      return;
    }

    const event: GlobalEvent & { _priority?: string } = {
      type: eventType,
      timestamp: Date.now(),
      sessionId: metadata.sessionId,
      agentId: metadata.agentId,
      sourceModule: metadata.sourceModule,
      payload,
      _chainDepth: chainDepth,
      _priority: metadata.priority,
    };

    Logger.debug(`[GlobalEventBus] ${eventType} from ${metadata.sourceModule} (depth=${chainDepth})`);
    this.emitter.emit(eventType, event);

    if (options?.publishToRedis && this.redisBridge) {
      this.publishWithRetry(event, eventType, options).catch((err) => {
        Logger.warn(`[GlobalEventBus] Redis bridge error for ${eventType}: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
  }

  /**
   * Publish event to Redis with retry on transient failures.
   */
  private async publishWithRetry(
    event: GlobalEvent,
    eventType: string,
    options: RedisEventOptions,
  ): Promise<void> {
    for (let attempt = 0; attempt <= REDIS_BRIDGE_RETRIES; attempt++) {
      try {
        await this.redisBridge!(event, options);
        return;
      } catch (err) {
        if (attempt < REDIS_BRIDGE_RETRIES) {
          Logger.debug(`[GlobalEventBus] Redis retry ${attempt + 1}/${REDIS_BRIDGE_RETRIES} for ${eventType}`);
          await new Promise((r) => setTimeout(r, (attempt + 1) * 200));
        } else {
          throw err;
        }
      }
    }
  }

  /**
   * Set the Redis bridge function (called from initGlobalEventSystem).
   */
  setRedisBridge(bridge: (event: GlobalEvent, options?: RedisEventOptions) => Promise<void>): void {
    this.redisBridge = bridge;
  }

  /**
   * Get listener count per event type (for diagnostics).
   */
  getListenerCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const name of this.emitter.eventNames()) {
      counts[String(name)] = this.emitter.listenerCount(name);
    }
    return counts;
  }

  /**
   * Total number of listeners across all event types.
   */
  get totalListeners(): number {
    let total = 0;
    for (const name of this.emitter.eventNames()) {
      total += this.emitter.listenerCount(name);
    }
    return total;
  }

  /**
   * Remove all listeners (for testing / shutdown).
   */
  reset(): void {
    this.emitter.removeAllListeners();
    this.activeSubscriptions.clear();
    this.subscriptionMeta.clear();
    this._initialized = false;
    this.redisBridge = null;
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /**
   * Cleanup idle subscriptions that haven't been invoked within TTL.
   * Prevents listener accumulation and memory leaks from orphaned handlers.
   */
  private cleanupIdleSubscriptions(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [subscription, meta] of this.subscriptionMeta) {
      if (meta.permanent) continue; // Never clean up permanent (core) subscriptions
      const idleMs = now - meta.lastInvokedAt;
      if (idleMs > this.subscriptionIdleTtlMs) {
        Logger.info(
          `[GlobalEventBus] Cleaning up idle subscription for '${meta.eventType}' (idle ${Math.round(idleMs / 60000)}min)`,
        );
        subscription.unsubscribe();
        cleaned++;
      }
    }

    if (cleaned > 0) {
      Logger.info(
        `[GlobalEventBus] Cleaned ${cleaned} idle subscriptions. Active: ${this.activeSubscriptions.size}`,
      );
    }
  }

  /**
   * Get subscription diagnostics for monitoring.
   */
  getSubscriptionDiagnostics(): {
    total: number;
    byEventType: Record<string, number>;
    oldestIdleMs: number;
  } {
    const byType: Record<string, number> = {};
    let oldestIdleMs = 0;
    const now = Date.now();

    for (const [, meta] of this.subscriptionMeta) {
      byType[meta.eventType] = (byType[meta.eventType] || 0) + 1;
      const idleMs = now - meta.lastInvokedAt;
      if (idleMs > oldestIdleMs) oldestIdleMs = idleMs;
    }

    return {
      total: this.activeSubscriptions.size,
      byEventType: byType,
      oldestIdleMs,
    };
  }

  /**
   * Number of tracked active subscriptions.
   */
  get activeSubscriptionCount(): number {
    return this.activeSubscriptions.size;
  }

  get isInitialized(): boolean {
    return this._initialized;
  }

  markInitialized(): void {
    this._initialized = true;
  }
}

// Singleton
let bus: GlobalEventBus | null = null;

export function getGlobalEventBus(): GlobalEventBus {
  if (!bus) bus = new GlobalEventBus();
  return bus;
}

export function resetGlobalEventBus(): void {
  if (bus) bus.reset();
  bus = null;
}

export { GlobalEventBus };
