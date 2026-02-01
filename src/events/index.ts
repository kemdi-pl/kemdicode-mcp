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
 * Global Event System
 *
 * Exports and initialization for the cross-module event bus.
 *
 * @module events
 */

// Types
export type {
  GlobalEvent,
  GlobalEventType,
  CognitionEventType,
  KanbanEventType,
  LoopEventType,
  SessionEventType,
  EventHandler,
  EventSubscription,
  EventMetadata,
  RedisEventOptions,
} from './types.js';

// Global Bus
export { GlobalEventBus, getGlobalEventBus, resetGlobalEventBus } from './global-bus.js';

// Redis Bridge
export { publishToRedis, subscribeToRedisEvents, getEventHistory } from './redis-bridge.js';

// Handlers
export { initKanbanHandlers } from './handlers/kanban-handlers.js';
export { initLoopHandlers } from './handlers/loop-handlers.js';

import { getGlobalEventBus } from './global-bus.js';
import { publishToRedis } from './redis-bridge.js';
import { initCognitionEventHandlers } from '../cognition/event-handlers.js';
import { initKanbanHandlers } from './handlers/kanban-handlers.js';
import { initLoopHandlers } from './handlers/loop-handlers.js';
import { Logger } from '../utils/logger.js';

/**
 * Initialize the global event system.
 * Registers all cross-module handlers and sets up the Redis bridge.
 * Safe to call multiple times — only registers once.
 */
export function initGlobalEventSystem(): void {
  const bus = getGlobalEventBus();
  if (bus.isInitialized) return;

  // Wire up Redis bridge
  bus.setRedisBridge(publishToRedis);

  // Register all handler groups
  initCognitionEventHandlers();
  initKanbanHandlers();
  initLoopHandlers();

  bus.markInitialized();
  Logger.info('[GlobalEventSystem] All cross-module handlers registered');
}
