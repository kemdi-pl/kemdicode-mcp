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
 * Cognition Event Bus — Backward Compatibility Wrapper
 *
 * Thin wrapper that delegates to the Global Event Bus while maintaining
 * the existing CognitionEventBus API. Cognition stores continue calling
 * getCognitionEventBus().emit() without changes.
 *
 * Old event types (e.g. 'decision:recorded') are automatically prefixed
 * with 'cognition:' for the global bus.
 *
 * @module cognition/event-bus
 */

import { getGlobalEventBus } from '../events/global-bus.js';
import type { CognitionEvent, CognitionEventType } from './types.js';

type CognitionEventHandler = (event: CognitionEvent) => void | Promise<void>;

class CognitionEventBus {
  /**
   * Subscribe to a cognition event type.
   * Delegates to global bus with 'cognition:' prefix.
   */
  on(eventType: CognitionEventType, handler: CognitionEventHandler): void {
    const globalBus = getGlobalEventBus();
    const globalType = `cognition:${eventType}`;

    globalBus.on(globalType, (globalEvent) => {
      // Convert GlobalEvent back to CognitionEvent for existing handlers
      const cognitionEvent: CognitionEvent = {
        type: eventType,
        timestamp: globalEvent.timestamp,
        sessionId: globalEvent.sessionId,
        agentId: globalEvent.agentId,
        sourceId: (globalEvent.payload.sourceId as string) || '',
        sourceType: (globalEvent.payload.sourceType as string) || '',
        payload: globalEvent.payload,
      };
      return handler(cognitionEvent);
    });
  }

  /**
   * Emit a cognition event. Delegates to global bus with 'cognition:' prefix.
   */
  emit(event: CognitionEvent): void {
    const globalBus = getGlobalEventBus();
    const globalType = `cognition:${event.type}`;

    globalBus.emit(
      globalType,
      {
        sourceId: event.sourceId,
        sourceType: event.sourceType,
        ...event.payload as Record<string, unknown>,
      },
      {
        sessionId: event.sessionId,
        agentId: event.agentId,
        sourceModule: 'cognition',
      },
    );
  }

  /**
   * Remove all listeners (for testing / shutdown).
   */
  reset(): void {
    // Resetting is handled by the global bus
  }

  get isInitialized(): boolean {
    return getGlobalEventBus().isInitialized;
  }

  markInitialized(): void {
    // Initialization is handled by the global event system
  }
}

// Singleton
let bus: CognitionEventBus | null = null;

export function getCognitionEventBus(): CognitionEventBus {
  if (!bus) bus = new CognitionEventBus();
  return bus;
}

export function resetCognitionEventBus(): void {
  bus = null;
}

export { CognitionEventBus };
