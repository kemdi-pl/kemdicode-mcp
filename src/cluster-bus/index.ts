/**
 * KemdiCode MCP Server - Cluster Bus Module
 * Copyright (C) 2025-2026 Kemdi Sp. z o.o. (Dawid Irzyk <dawid@kemdi.pl>)
 *
 * Full-duplex inter-cluster communication bus with Redis Pub/Sub,
 * meta-tag routing, parallel LLM magistrale, and health monitoring.
 *
 * @license GPL-3.0
 * @module cluster-bus
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

// Initialization
export {
  initClusterBusSystem,
  shutdownClusterBusSystem,
  getHealthMonitor,
  getBridgeHandle,
  isClusterBusActive,
  getClusterBusSystemStatus,
} from './init.js';
