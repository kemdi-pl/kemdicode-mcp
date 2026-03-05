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
 * Agentic Loop Event Handlers
 *
 * Reactive handlers for loop lifecycle events:
 * - Failure → error-pattern cross-module reaction
 * - Tool usage frequency tracking
 *
 * @module events/handlers/loop-handlers
 */

import { getGlobalEventBus } from '../global-bus.js';
import { Logger } from '../../utils/logger.js';

// Track tool call frequency per loop
const toolCallCounts = new Map<string, Map<string, number>>();

export function initLoopHandlers(): void {
  const bus = getGlobalEventBus();

  // Track tool call frequency and warn on excessive use
  bus.on('loop:tool-called', (event) => {
    const { loopId, toolName } = event.payload as { loopId?: string; toolName?: string };
    if (!loopId || !toolName) return;

    if (!toolCallCounts.has(loopId)) {
      toolCallCounts.set(loopId, new Map());
    }
    const counts = toolCallCounts.get(loopId)!;
    const current = (counts.get(toolName) || 0) + 1;
    counts.set(toolName, current);

    if (current === 20) {
      Logger.warn(
        `[LoopHandler] Tool '${toolName}' called ${current} times in loop ${loopId} — possible loop`,
      );
    }
  }, { permanent: true });

  // On loop failure, emit cognition error event (cross-module reaction)
  bus.on('loop:completed', (event) => {
    const { success, stopReason, loopId, duration } = event.payload as {
      success?: boolean;
      stopReason?: string;
      loopId?: string;
      duration?: number;
    };

    // Clean up tool call tracking
    if (loopId) {
      toolCallCounts.delete(loopId);
    }

    if (success === false && stopReason === 'error') {
      bus.emit(
        'cognition:error:recorded',
        {
          sourceId: loopId || 'unknown',
          sourceType: 'agentic-loop',
          errorType: 'logic-error',
          context: `Agentic loop failed (reason: ${stopReason}, duration: ${duration}ms)`,
          symptoms: [`Loop ended with stopReason=${stopReason}`],
          rootCause: 'unknown',
          fix: 'unknown',
        },
        {
          sessionId: event.sessionId,
          agentId: event.agentId,
          sourceModule: 'recursive',
        },
      );
    }
  }, { permanent: true });
}
