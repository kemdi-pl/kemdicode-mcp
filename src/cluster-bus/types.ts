/**
 * KemdiCode MCP Server - Cluster Bus Types
 * Copyright (C) 2025-2026 Kemdi Sp. z o.o. (Dawid Irzyk <dawid@kemdi.pl>)
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

/**
 * Cluster Bus Type Definitions
 *
 * Protocol types, signal envelopes, meta-tags, and topology definitions
 * for full-duplex inter-cluster communication.
 *
 * @module cluster-bus/types
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Signal Types
// ---------------------------------------------------------------------------

/** All supported signal types for inter-cluster communication */
export type SignalType =
  | 'llm:request'
  | 'llm:result'
  | 'llm:stream-chunk'
  | 'llm:error'
  | 'cluster:join'
  | 'cluster:leave'
  | 'cluster:heartbeat'
  | 'data:broadcast'
  | 'data:unicast'
  | 'control:pause'
  | 'control:resume'
  | 'control:config';

/** Signal flow direction */
export type SignalDirection = 'upstream' | 'downstream' | 'duplex';

/** Signal priority levels */
export type SignalPriority = 0 | 1 | 2 | 3;

// ---------------------------------------------------------------------------
// Meta-Tags
// ---------------------------------------------------------------------------

/** Key-value meta-tag for cluster routing and filtering */
export interface ClusterMetaTag {
  key: string;
  value: string;
}

/** Parse meta-tag string "key:value" to object */
export function parseMetaTag(tag: string): ClusterMetaTag {
  const idx = tag.indexOf(':');
  if (idx === -1) return { key: tag, value: '' };
  return { key: tag.slice(0, idx), value: tag.slice(idx + 1) };
}

/** Serialize meta-tag to "key:value" string */
export function serializeMetaTag(tag: ClusterMetaTag): string {
  return `${tag.key}:${tag.value}`;
}

// ---------------------------------------------------------------------------
// Cluster Signal Envelope
// ---------------------------------------------------------------------------

/** Core signal envelope for all inter-cluster messages */
export interface ClusterSignal<T = unknown> {
  /** Unique signal ID (UUID v4) */
  id: string;
  /** Signal type */
  type: SignalType;
  /** Source cluster ID */
  sourceCluster: string;
  /** Target cluster ID (empty string for broadcast) */
  targetCluster: string;
  /** Signal payload (typed per signal type) */
  payload: T;
  /** Meta-tags for routing and filtering */
  metaTags: ClusterMetaTag[];
  /** Correlation ID for tracing signal chains */
  correlationId?: string;
  /** Signal flow direction */
  direction: SignalDirection;
  /** Priority: 0=low, 1=normal, 2=high, 3=critical */
  priority: SignalPriority;
  /** TTL in seconds (0 = no expiry) */
  ttl: number;
  /** Schema version for wire compatibility */
  schemaVersion: number;
  /** Timestamp of creation (epoch ms) */
  timestamp: number;
  /** Origin cluster ID (for loop prevention across bridges) */
  originCluster?: string;
  /** Session ID context */
  sessionId?: string;
  /** Agent ID context */
  agentId?: string;
}

// ---------------------------------------------------------------------------
// Cluster Node
// ---------------------------------------------------------------------------

/** Status of a cluster node */
export type ClusterStatus = 'online' | 'degraded' | 'offline';

/** Serializable custom endpoint info for cluster advertisement */
export interface ClusterCustomEndpoint {
  /** Endpoint name (matches custom:<name> provider ID) */
  name: string;
  /** Display name */
  displayName?: string;
  /** OpenAI-compatible base URL */
  baseURL: string;
  /** Whether this endpoint requires an API key */
  requiresApiKey: boolean;
  /** Default model */
  defaultModel?: string;
  /** Available models */
  models?: string[];
}

/** Registered cluster node in the topology */
export interface ClusterNode {
  /** Unique cluster ID */
  id: string;
  /** Human-readable cluster name */
  name: string;
  /** Meta-tags describing this cluster's capabilities */
  metaTags: ClusterMetaTag[];
  /** AI provider IDs available on this cluster (built-in + custom:<name>) */
  connectedProviders: string[];
  /** Custom OpenAI-compatible endpoints on this cluster */
  customEndpoints: ClusterCustomEndpoint[];
  /** General capabilities (e.g., 'llm', 'code-analysis', 'kanban') */
  capabilities: string[];
  /** Current status */
  status: ClusterStatus;
  /** Last heartbeat timestamp (epoch ms) */
  lastHeartbeat: number;
  /** Registration timestamp (epoch ms) */
  registeredAt: number;
  /** Session ID of the cluster owner */
  sessionId?: string;
}

/** Input for registering a new cluster */
export interface RegisterClusterInput {
  id?: string;
  name: string;
  metaTags?: ClusterMetaTag[];
  connectedProviders?: string[];
  customEndpoints?: ClusterCustomEndpoint[];
  capabilities?: string[];
  sessionId?: string;
}

// ---------------------------------------------------------------------------
// Cluster Topology
// ---------------------------------------------------------------------------

/** Edge between two cluster nodes */
export interface ClusterEdge {
  /** Source cluster ID */
  source: string;
  /** Target cluster ID */
  target: string;
  /** Signal flow direction for this edge */
  direction: SignalDirection;
  /** Whether the connection is active */
  active: boolean;
  /** Signal count on this edge (for metrics) */
  signalCount: number;
}

/** Full cluster topology graph */
export interface ClusterTopology {
  /** All registered cluster nodes */
  nodes: ClusterNode[];
  /** Edges (connections) between clusters */
  edges: ClusterEdge[];
  /** Timestamp of topology snapshot */
  snapshotAt: number;
}

// ---------------------------------------------------------------------------
// Signal Payloads (Zod schemas)
// ---------------------------------------------------------------------------

export const LLMRequestPayload = z.object({
  prompt: z.string().describe('LLM prompt text'),
  model: z.string().optional().describe('Target model spec (provider:model:thinking or custom:name:model)'),
  systemPrompt: z.string().optional().describe('System prompt override'),
  maxTokens: z.number().optional().describe('Max completion tokens'),
  temperature: z.number().optional().describe('Sampling temperature'),
  files: z.array(z.string()).optional().describe('Attached file paths'),
  customEndpoint: z.object({
    baseURL: z.string().describe('OpenAI-compatible base URL'),
    apiKey: z.string().optional().describe('API key (omit if not needed)'),
  }).optional().describe('Custom endpoint override for cross-cluster dispatch'),
});

export const LLMResultPayload = z.object({
  requestId: z.string().describe('Correlation to original request signal ID'),
  content: z.string().describe('LLM completion text'),
  model: z.string().describe('Model that produced the result'),
  provider: z.string().describe('Provider that served the request'),
  promptTokens: z.number().optional().describe('Input token count'),
  completionTokens: z.number().optional().describe('Output token count'),
  finishReason: z.string().optional().describe('Why the completion ended'),
  latencyMs: z.number().optional().describe('End-to-end latency in milliseconds'),
});

export const HeartbeatPayload = z.object({
  clusterId: z.string().describe('Reporting cluster ID'),
  status: z.enum(['online', 'degraded', 'offline']).describe('Cluster health status'),
  providers: z.array(z.string()).optional().describe('Currently available provider IDs'),
  load: z.number().min(0).max(1).optional().describe('Current load factor (0-1)'),
  queueDepth: z.number().optional().describe('Pending signal queue depth'),
});

// ---------------------------------------------------------------------------
// Signal Payload Map
// ---------------------------------------------------------------------------

export type SignalPayloadMap = {
  'llm:request': z.infer<typeof LLMRequestPayload>;
  'llm:result': z.infer<typeof LLMResultPayload>;
  'llm:stream-chunk': { requestId: string; chunk: string; index: number };
  'llm:error': { requestId: string; error: string; code?: string };
  'cluster:join': { node: ClusterNode };
  'cluster:leave': { clusterId: string; reason?: string };
  'cluster:heartbeat': z.infer<typeof HeartbeatPayload>;
  'data:broadcast': Record<string, unknown>;
  'data:unicast': Record<string, unknown>;
  'control:pause': { reason?: string };
  'control:resume': { reason?: string };
  'control:config': { key: string; value: unknown };
};

// ---------------------------------------------------------------------------
// Redis Key Schema
// ---------------------------------------------------------------------------

/** Redis key helpers for cluster-bus persistence */
export const CLUSTER_KEYS = {
  /** Cluster metadata hash: mcp:cluster:{id} */
  node: (id: string) => `mcp:cluster:${id}`,
  /** Sorted set of active clusters (score = heartbeat timestamp) */
  active: () => 'mcp:clusters:active',
  /** Capped signal history between two clusters */
  signals: (src: string, tgt: string) => `mcp:cluster:signals:${src}:${tgt}`,
  /** Broadcast signal history */
  broadcastHistory: () => 'mcp:cluster:signals:broadcast',
  /** Metrics hash per cluster */
  metrics: (id: string) => `mcp:cluster:metrics:${id}`,
  /** Dead-letter list for undeliverable signals */
  deadLetter: () => 'mcp:cluster:deadletter',
  /** Topology adjacency hash */
  topology: () => 'mcp:cluster:topology',
  /** Pub/Sub channel: unicast */
  channelUnicast: (src: string, tgt: string) => `mcp:cluster:${src}:${tgt}`,
  /** Pub/Sub channel: broadcast */
  channelBroadcast: () => 'mcp:cluster:broadcast',
} as const;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** ClusterBus configuration from environment */
export interface ClusterBusConfig {
  /** Enable cluster bus (env: MCP_CLUSTER_ENABLED) */
  enabled: boolean;
  /** This node's cluster ID (env: MCP_CLUSTER_ID) */
  clusterId: string;
  /** Human-readable name (env: MCP_CLUSTER_NAME) */
  clusterName: string;
  /** Comma-separated meta-tags (env: MCP_CLUSTER_TAGS) */
  metaTags: ClusterMetaTag[];
  /**
   * Custom OpenAI-compatible endpoints (env: MCP_CLUSTER_CUSTOM_ENDPOINTS).
   * JSON array or semicolon-separated entries: name=url[,key=...][,model=...]
   *
   * Examples:
   *   JSON: [{"name":"vllm","baseURL":"http://gpu:8000/v1","apiKey":"","defaultModel":"llama3"}]
   *   Short: vllm=http://gpu:8000/v1,model=llama3;lmstudio=http://localhost:1234/v1
   */
  customEndpoints: ClusterCustomEndpoint[];
  /** Heartbeat interval in ms (env: MCP_CLUSTER_HEARTBEAT_MS, default: 5000) */
  heartbeatIntervalMs: number;
  /** Stale threshold in ms (env: MCP_CLUSTER_STALE_MS, default: 15000) */
  staleThresholdMs: number;
  /** Max signal history per channel (env: MCP_CLUSTER_HISTORY_CAP, default: 500) */
  historyCap: number;
  /** Signal history TTL in seconds (env: MCP_CLUSTER_HISTORY_TTL, default: 3600) */
  historyTtlSeconds: number;
}

/**
 * Parse custom endpoints from environment variable.
 *
 * Supports two formats:
 * 1. JSON array: [{"name":"vllm","baseURL":"http://gpu:8000/v1","apiKey":"","defaultModel":"llama3"}]
 * 2. Short syntax (semicolon-separated entries):
 *    vllm=http://gpu:8000/v1,model=llama3;lmstudio=http://localhost:1234/v1,key=sk-xxx
 */
function parseCustomEndpoints(raw: string): ClusterCustomEndpoint[] {
  if (!raw.trim()) return [];

  // Try JSON first
  if (raw.trim().startsWith('[')) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.map((ep: Record<string, unknown>) => ({
          name: String(ep.name || ''),
          displayName: ep.displayName ? String(ep.displayName) : undefined,
          baseURL: String(ep.baseURL || ''),
          requiresApiKey: Boolean(ep.apiKey),
          defaultModel: ep.defaultModel ? String(ep.defaultModel) : undefined,
          models: Array.isArray(ep.models) ? ep.models.map(String) : undefined,
        })).filter((ep) => ep.name && ep.baseURL);
      }
    } catch {
      // Fall through to short syntax
    }
  }

  // Short syntax: name=url,key=xxx,model=yyy;name2=url2,...
  const endpoints: ClusterCustomEndpoint[] = [];
  for (const entry of raw.split(';')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;

    const parts = trimmed.split(',').map((p) => p.trim());
    if (parts.length === 0) continue;

    // First part: name=baseURL
    const firstPart = parts[0];
    const eqIdx = firstPart.indexOf('=');
    if (eqIdx === -1) continue;

    const name = firstPart.slice(0, eqIdx).trim();
    const baseURL = firstPart.slice(eqIdx + 1).trim();
    if (!name || !baseURL) continue;

    const ep: ClusterCustomEndpoint = { name, baseURL, requiresApiKey: false };

    // Parse remaining key=value pairs
    for (let i = 1; i < parts.length; i++) {
      const kv = parts[i];
      const kvIdx = kv.indexOf('=');
      if (kvIdx === -1) continue;
      const key = kv.slice(0, kvIdx).trim().toLowerCase();
      const value = kv.slice(kvIdx + 1).trim();

      if (key === 'model') ep.defaultModel = value;
      else if (key === 'key') ep.requiresApiKey = Boolean(value);
      else if (key === 'display') ep.displayName = value;
      else if (key === 'models') ep.models = value.split('|').map((m) => m.trim());
    }

    endpoints.push(ep);
  }

  return endpoints;
}

/** Load cluster bus config from environment */
export function loadClusterBusConfig(): ClusterBusConfig {
  const enabled = process.env.MCP_CLUSTER_ENABLED === '1' || process.env.MCP_CLUSTER_ENABLED === 'true';
  const clusterId = process.env.MCP_CLUSTER_ID || `cluster_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const clusterName = process.env.MCP_CLUSTER_NAME || clusterId;
  const tagsRaw = process.env.MCP_CLUSTER_TAGS || '';
  const metaTags = tagsRaw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .map(parseMetaTag);

  const customEndpoints = parseCustomEndpoints(process.env.MCP_CLUSTER_CUSTOM_ENDPOINTS || '');

  const envInt = (key: string, def: number): number => {
    const v = process.env[key];
    if (v) { const n = parseInt(v, 10); if (!isNaN(n) && n > 0) return n; }
    return def;
  };

  return {
    enabled,
    clusterId,
    clusterName,
    metaTags,
    customEndpoints,
    heartbeatIntervalMs: envInt('MCP_CLUSTER_HEARTBEAT_MS', 5000),
    staleThresholdMs: envInt('MCP_CLUSTER_STALE_MS', 15000),
    historyCap: envInt('MCP_CLUSTER_HISTORY_CAP', 500),
    historyTtlSeconds: envInt('MCP_CLUSTER_HISTORY_TTL', 3600),
  };
}

// ---------------------------------------------------------------------------
// Handler Types
// ---------------------------------------------------------------------------

/** Handler for incoming cluster signals */
export type ClusterSignalHandler<T = unknown> = (
  signal: ClusterSignal<T>,
) => void | Promise<void>;

/** Subscription to cluster signals */
export interface ClusterSubscription {
  id: string;
  unsubscribe: () => void;
}
