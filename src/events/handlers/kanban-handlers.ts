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
 * Kanban Event Handlers
 *
 * Reactive handlers for kanban events:
 * - Critical task alerts
 * - Completion metrics logging
 *
 * @module events/handlers/kanban-handlers
 */

import { getGlobalEventBus } from '../global-bus.js';
import { Logger } from '../../utils/logger.js';

export function initKanbanHandlers(): void {
  const bus = getGlobalEventBus();

  // Log warning for critical priority tasks
  bus.on('kanban:task:created', (event) => {
    const { priority, title } = event.payload as { priority?: string; title?: string };
    if (priority === 'critical') {
      Logger.warn(`[KanbanHandler] Critical task created: ${title || 'untitled'}`);
    }
  });

  // Log completion metrics
  bus.on('kanban:task:completed', (event) => {
    const { actualMinutes } = event.payload as { actualMinutes?: number };
    const taskId = (event.payload as Record<string, unknown>).taskId;
    Logger.info(
      `[KanbanHandler] Task ${taskId || 'unknown'} completed` +
        (actualMinutes ? ` in ${actualMinutes} minutes` : ''),
    );
  });
}
