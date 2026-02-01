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

class GlobalEventBus {
  private emitter = new EventEmitter();
  private _initialized = false;
  private redisBridge: ((event: GlobalEvent, options?: RedisEventOptions) => Promise<void>) | null = null;

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  /**
   * Subscribe to an event type. Handlers run asynchronously via queueMicrotask.
   */
  on<T = unknown>(eventType: GlobalEventType | string, handler: EventHandler<T>): EventSubscription {
    const wrappedHandler = (event: GlobalEvent) => {
      queueMicrotask(async () => {
        try {
          await (handler as EventHandler)(event);
        } catch (err) {
          Logger.error(`[GlobalEventBus] Handler error for ${eventType}:`, err);
        }
      });
    };

    this.emitter.on(eventType, wrappedHandler);

    return {
      unsubscribe: () => {
        this.emitter.removeListener(eventType, wrappedHandler);
      },
    };
  }

  /**
   * Emit an event. Local handlers run async. Optionally publishes to Redis.
   */
  emit(
    eventType: GlobalEventType | string,
    payload: Record<string, unknown>,
    metadata: EventMetadata,
    options?: RedisEventOptions,
  ): void {
    const event: GlobalEvent = {
      type: eventType,
      timestamp: Date.now(),
      sessionId: metadata.sessionId,
      agentId: metadata.agentId,
      sourceModule: metadata.sourceModule,
      payload,
    };

    Logger.debug(`[GlobalEventBus] ${eventType} from ${metadata.sourceModule}`);
    this.emitter.emit(eventType, event);

    if (options?.publishToRedis && this.redisBridge) {
      this.redisBridge(event, options).catch((err) => {
        Logger.warn(`[GlobalEventBus] Redis bridge error for ${eventType}: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
  }

  /**
   * Set the Redis bridge function (called from initGlobalEventSystem).
   */
  setRedisBridge(bridge: (event: GlobalEvent, options?: RedisEventOptions) => Promise<void>): void {
    this.redisBridge = bridge;
  }

  /**
   * Remove all listeners (for testing / shutdown).
   */
  reset(): void {
    this.emitter.removeAllListeners();
    this._initialized = false;
    this.redisBridge = null;
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
