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
 * Global Event Bus Type Definitions
 *
 * Namespaced event types for all server modules:
 * cognition, kanban, loop (recursive), session.
 *
 * @module events/types
 */

// ---------------------------------------------------------------------------
// Base Event Structure
// ---------------------------------------------------------------------------

export interface GlobalEvent {
  type: string;
  timestamp: number;
  sessionId: string;
  agentId?: string;
  sourceModule: string;
  payload: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Module Event Types (namespaced: module:category:action)
// ---------------------------------------------------------------------------

export type CognitionEventType =
  | 'cognition:decision:recorded'
  | 'cognition:confidence:recorded'
  | 'cognition:confidence:low'
  | 'cognition:confidence:outcome-updated'
  | 'cognition:error:recorded'
  | 'cognition:error:matched'
  | 'cognition:error:occurrence'
  | 'cognition:critique:recorded'
  | 'cognition:critique:lesson-learned'
  | 'cognition:intent:set'
  | 'cognition:intent:drifted'
  | 'cognition:handoff:created'
  | 'cognition:model:created'
  | 'cognition:model:stale'
  | 'cognition:model:updated';

export type KanbanEventType =
  | 'kanban:task:created'
  | 'kanban:task:updated'
  | 'kanban:task:claimed'
  | 'kanban:task:assigned'
  | 'kanban:task:started'
  | 'kanban:task:completed'
  | 'kanban:task:blocked'
  | 'kanban:task:unblocked'
  | 'kanban:board:created'
  | 'kanban:board:deleted';

export type LoopEventType =
  | 'loop:started'
  | 'loop:iteration'
  | 'loop:tool-called'
  | 'loop:tool-result'
  | 'loop:sub-agent-spawned'
  | 'loop:completed'
  | 'loop:error';

export type SessionEventType =
  | 'session:created'
  | 'session:switched'
  | 'session:deleted';

export type GlobalEventType =
  | CognitionEventType
  | KanbanEventType
  | LoopEventType
  | SessionEventType;

// ---------------------------------------------------------------------------
// Handler & Subscription Types
// ---------------------------------------------------------------------------

export type EventHandler<T = unknown> = (
  event: GlobalEvent & { payload: T extends Record<string, unknown> ? T : Record<string, unknown> },
) => void | Promise<void>;

export interface EventSubscription {
  unsubscribe: () => void;
}

export interface EventMetadata {
  sessionId: string;
  agentId?: string;
  sourceModule: string;
}

export interface RedisEventOptions {
  publishToRedis?: boolean;
  channel?: string;
  ttl?: number;
}
