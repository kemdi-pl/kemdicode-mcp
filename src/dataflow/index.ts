/**
 * KemdiCode MCP Server - Data Flow Module
 * Copyright (C) 2025-2026 Kemdi Sp. z o.o. (Dawid Irzyk <dawid@kemdi.pl>)
 *
 * Typed message bus for inter-module communication.
 *
 * @license GPL-3.0
 * @module dataflow
 */

export type {
  DataFlowChannel,
  DataFlowEnvelope,
  DataFlowHandler,
  SubscriptionOptions,
  ChannelPayloadMap,
} from './types.js';

export {
  AICompletionPayload,
  KanbanTaskChangePayload,
  KanbanComplexityPayload,
  CognitionDecisionPayload,
  AgentStatusPayload,
  SystemHealthPayload,
} from './types.js';

export { getDataFlowBus, resetDataFlowBus } from './bus.js';
