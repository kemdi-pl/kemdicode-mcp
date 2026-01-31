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
 * Cognition Event Bus
 *
 * Lightweight in-process EventEmitter for cross-tool communication.
 * NOT Redis Pub/Sub — purely for intra-process coordination between
 * cognition stores within the same server process.
 *
 * Handlers run asynchronously via queueMicrotask so they never block
 * the emitting store. Errors in handlers are caught and logged.
 *
 * @module cognition/event-bus
 */

import { EventEmitter } from 'node:events';
import { Logger } from '../utils/logger.js';
import type { CognitionEvent, CognitionEventType } from './types.js';

type CognitionEventHandler = (event: CognitionEvent) => void | Promise<void>;

class CognitionEventBus {
  private emitter = new EventEmitter();
  private _initialized = false;

  constructor() {
    // 8 stores + cross-linker + event-handlers + future subscribers
    this.emitter.setMaxListeners(30);
  }

  /**
   * Subscribe to a cognition event type.
   * Handlers are invoked asynchronously (fire-and-forget) to avoid
   * blocking the emitting store.
   */
  on(eventType: CognitionEventType, handler: CognitionEventHandler): void {
    this.emitter.on(eventType, (event: CognitionEvent) => {
      queueMicrotask(async () => {
        try {
          await handler(event);
        } catch (err) {
          Logger.error(`[CognitionEventBus] Handler error for ${eventType}:`, err);
        }
      });
    });
  }

  /**
   * Emit a cognition event. Returns immediately; handlers run async.
   */
  emit(event: CognitionEvent): void {
    Logger.debug(`[CognitionEventBus] ${event.type} from ${event.sourceType}:${event.sourceId}`);
    this.emitter.emit(event.type, event);
  }

  /**
   * Remove all listeners (for testing / shutdown).
   */
  reset(): void {
    this.emitter.removeAllListeners();
    this._initialized = false;
  }

  get isInitialized(): boolean {
    return this._initialized;
  }

  markInitialized(): void {
    this._initialized = true;
  }
}

// Singleton
let bus: CognitionEventBus | null = null;

export function getCognitionEventBus(): CognitionEventBus {
  if (!bus) bus = new CognitionEventBus();
  return bus;
}

export function resetCognitionEventBus(): void {
  if (bus) bus.reset();
  bus = null;
}

export { CognitionEventBus };
