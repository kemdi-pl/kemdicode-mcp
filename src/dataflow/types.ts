/**
 * KemdiCode MCP Server - Data Flow Bus Types
 * Copyright (C) 2025-2026 Kemdi Sp. z o.o. (Dawid Irzyk <dawid@kemdi.pl>)
 *
 * Typed message bus protocol for structured data flow between
 * AI, kanban, cognition, and agent modules.
 *
 * @license GPL-3.0
 * @module dataflow/types
 */

import { z } from 'zod';

/**
 * Data flow channels - typed topics for inter-module communication.
 * Each channel has a strongly-typed payload schema.
 */
export type DataFlowChannel =
  | 'ai:completion'       // AI completion results
  | 'ai:structured'       // Structured output results
  | 'ai:research'         // Research model results
  | 'kanban:task-change'  // Task state changes
  | 'kanban:complexity'   // Complexity analysis results
  | 'cognition:decision'  // Decision journal entries
  | 'cognition:intent'    // Intent changes
  | 'cognition:error'     // Error pattern matches
  | 'agent:status'        // Agent status updates
  | 'agent:message'       // Inter-agent messages
  | 'system:health'       // System health events
  | 'system:config';      // Configuration changes

/**
 * Envelope for all data flow messages.
 * Provides tracing, routing, and schema metadata.
 */
export interface DataFlowEnvelope<T = unknown> {
  /** Unique message ID */
  id: string;
  /** Channel this message belongs to */
  channel: DataFlowChannel;
  /** Message payload (typed per channel) */
  payload: T;
  /** Source module that produced this message */
  source: string;
  /** Optional target module (for directed messages) */
  target?: string;
  /** Session ID for context */
  sessionId?: string;
  /** Agent ID if applicable */
  agentId?: string;
  /** Timestamp of creation */
  timestamp: number;
  /** Correlation ID for tracing message chains */
  correlationId?: string;
  /** Schema version for payload compatibility */
  schemaVersion: number;
  /** Priority: 0=low, 1=normal, 2=high, 3=critical */
  priority: 0 | 1 | 2 | 3;
  /** TTL in seconds (0 = no expiry) */
  ttl: number;
}

/**
 * Handler function for data flow messages.
 */
export type DataFlowHandler<T = unknown> = (
  envelope: DataFlowEnvelope<T>,
) => void | Promise<void>;

/**
 * Subscription options for data flow listeners.
 */
export interface SubscriptionOptions {
  /** Only receive messages from specific source modules */
  sourceFilter?: string[];
  /** Only receive messages with specific priority or higher */
  minPriority?: 0 | 1 | 2 | 3;
  /** Process messages sequentially (default: parallel) */
  sequential?: boolean;
}

// ─── Channel Payload Schemas ─────────────────────────────────────────────────

export const AICompletionPayload = z.object({
  model: z.string(),
  promptTokens: z.number().optional(),
  completionTokens: z.number().optional(),
  content: z.string(),
  finishReason: z.string().optional(),
  tier: z.enum(['main', 'research', 'fallback']).optional(),
});

export const KanbanTaskChangePayload = z.object({
  taskId: z.string(),
  action: z.enum(['created', 'updated', 'completed', 'claimed', 'deleted'] as const),
  previousStatus: z.string().optional(),
  newStatus: z.string().optional(),
  assignee: z.string().optional(),
  boardId: z.string().optional(),
});

export const KanbanComplexityPayload = z.object({
  taskId: z.string(),
  score: z.number().min(1).max(10),
  recommendedSubtasks: z.number(),
  reasoning: z.string(),
});

export const CognitionDecisionPayload = z.object({
  decisionId: z.string(),
  question: z.string(),
  chosen: z.string(),
  confidence: z.number().min(0).max(1),
  tags: z.array(z.string()).optional(),
});

export const AgentStatusPayload = z.object({
  agentId: z.string(),
  status: z.enum(['online', 'busy', 'idle', 'offline']),
  currentTask: z.string().optional(),
  capabilities: z.array(z.string()).optional(),
});

export const SystemHealthPayload = z.object({
  component: z.string(),
  status: z.enum(['healthy', 'degraded', 'down']),
  details: z.string().optional(),
  metrics: z.record(z.string(), z.number()).optional(),
});

/** Map of channel to its payload type */
export type ChannelPayloadMap = {
  'ai:completion': z.infer<typeof AICompletionPayload>;
  'ai:structured': z.infer<typeof AICompletionPayload>;
  'ai:research': z.infer<typeof AICompletionPayload>;
  'kanban:task-change': z.infer<typeof KanbanTaskChangePayload>;
  'kanban:complexity': z.infer<typeof KanbanComplexityPayload>;
  'cognition:decision': z.infer<typeof CognitionDecisionPayload>;
  'cognition:intent': Record<string, unknown>;
  'cognition:error': Record<string, unknown>;
  'agent:status': z.infer<typeof AgentStatusPayload>;
  'agent:message': Record<string, unknown>;
  'system:health': z.infer<typeof SystemHealthPayload>;
  'system:config': Record<string, unknown>;
};
