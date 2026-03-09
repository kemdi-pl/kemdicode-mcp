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

// Types
export type {
  SignalType,
  SignalDirection,
  SignalPriority,
  ClusterMetaTag,
  ClusterSignal,
  ClusterNode,
  ClusterCustomEndpoint,
  ClusterStatus,
  ClusterEdge,
  ClusterTopology,
  RegisterClusterInput,
  ClusterBusConfig,
  ClusterSignalHandler,
  ClusterSubscription,
  SignalPayloadMap,
} from './types.js';

export {
  CLUSTER_KEYS,
  parseMetaTag,
  serializeMetaTag,
  loadClusterBusConfig,
  LLMRequestPayload,
  LLMResultPayload,
  HeartbeatPayload,
  PassConfigSchema,
  PassReportSchema,
  PassRecordSchema,
} from './types.js';

// Pass Controller
export { PassController } from './pass-controller.js';
export type { PassConfig, PassRecord, PassReport } from './pass-controller.js';

// Cluster Registry
export {
  registerCluster,
  deregisterCluster,
  getCluster,
  listClusters,
  findByMetaTag,
  findByCapability,
  updateHeartbeat,
  detectStaleNodes,
  pruneStaleNodes,
  getTopology,
  topologyToMermaid,
} from './cluster-registry.js';

// Cluster Bus
export {
  ClusterBus,
  getClusterBus,
  initClusterBus,
  shutdownClusterBus,
} from './bus.js';

// MetaTag Router
export {
  MetaTagRouter,
  routeByProvider,
  routeByCapability,
  routeByRegion,
  routeToAnyLLM,
} from './meta-router.js';

export type {
  MatchMode,
  TagPredicate,
  RouteRule,
  RouteResult,
} from './meta-router.js';

// Signal Flow Controller
export {
  SignalFlowController,
  defaultLLMPolicy,
  defaultControlPolicy,
  defaultHeartbeatPolicy,
} from './signal-flow.js';

export type {
  FlowPolicy,
  FlowStats,
} from './signal-flow.js';

// LLM Magistrale
export { LLMMagistrale } from './llm-magistrale.js';

export type {
  AggregationStrategy,
  MagistraleConfig,
  MagistraleResult,
  MagistraleResponse,
} from './llm-magistrale.js';

// Cluster Provider Pool
export { ClusterProviderPool } from './provider-pool.js';

export type {
  PooledProvider,
  PoolSnapshot,
  SelectionCriteria,
} from './provider-pool.js';

// Bridges
export { connectBridges } from './bridges.js';

export type {
  BridgeConfig,
  BridgeHandle,
  BridgeStats,
} from './bridges.js';

// Health Monitor
export { ClusterHealthMonitor } from './health-monitor.js';

export type {
  HealthMonitorStats,
  HealthEvent,
  HealthEventHandler,
} from './health-monitor.js';

// Fan-In Aggregator
export {
  startAggregation,
  addResult,
  getAggregation,
  getPendingAggregations,
  getAllAggregations,
  cleanupStaleAggregations,
  registerCustomRule,
  unregisterCustomRule,
  reset as resetAggregator,
} from './fan-in-aggregator.js';

export type {
  AggregationMode,
  AggregationState,
  AggregationResult,
  CustomAggregationRule,
} from './fan-in-aggregator.js';

// Agent Iteration Loop
export { AgentIterationLoop } from './agent-iteration.js';
export type { AgentIterationConfig, AgentIterationResult } from './agent-iteration.js';

// Audit Scheduler
export { AuditScheduler, getAuditScheduler, resetAuditScheduler } from './audit-scheduler.js';
export type { AuditSchedule, AuditHistoryEntry, CreateScheduleInput } from './audit-schedule-store.js';
export {
  createSchedule,
  getSchedule,
  updateSchedule,
  deleteSchedule,
  listSchedules,
  addHistoryEntry,
  getHistory,
  getLastRunTime,
} from './audit-schedule-store.js';

// Initialization
export {
  initClusterBusSystem,
  shutdownClusterBusSystem,
  getHealthMonitor,
  getBridgeHandle,
  isClusterBusActive,
  getClusterBusSystemStatus,
} from './init.js';
