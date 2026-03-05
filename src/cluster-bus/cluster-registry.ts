/**
 * KemdiCode MCP Server - Cluster Registry
 * Copyright (C) 2025-2026 Kemdi Sp. z o.o. (Dawid Irzyk <dawid@kemdi.pl>)
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

/**
 * Cluster Registry
 *
 * Redis-backed registry of active cluster nodes.
 * Tracks cluster metadata, heartbeats, and provides topology queries.
 *
 * @module cluster-bus/cluster-registry
 */

import { v4 as uuidv4 } from 'uuid';
import { Logger } from '../utils/logger.js';
import { getSharedRedis } from '../infrastructure/redis/connection.js';
import type {
  ClusterNode,
  ClusterCustomEndpoint,
  ClusterMetaTag,
  ClusterTopology,
  ClusterEdge,
  ClusterStatus,
  RegisterClusterInput,
} from './types.js';
import { CLUSTER_KEYS, serializeMetaTag, parseMetaTag } from './types.js';

const getRedis = getSharedRedis;

const DEFAULT_NODE_TTL = 300; // seconds — default 5 min, overridable per-node

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/**
 * Register a new cluster node in the registry.
 */
export async function registerCluster(input: RegisterClusterInput): Promise<ClusterNode> {
  const client = await getRedis();
  const now = Date.now();

  const node: ClusterNode = {
    id: input.id || uuidv4().slice(0, 12),
    name: input.name,
    metaTags: input.metaTags || [],
    connectedProviders: input.connectedProviders || [],
    customEndpoints: input.customEndpoints || [],
    capabilities: input.capabilities || [],
    status: 'online',
    lastHeartbeat: now,
    registeredAt: now,
    sessionId: input.sessionId,
  };

  const tx = client.multi();

  const noExpiry = (input.ttlSeconds ?? DEFAULT_NODE_TTL) === 0;

  tx.hset(CLUSTER_KEYS.node(node.id), {
    id: node.id,
    name: node.name,
    metaTags: JSON.stringify(node.metaTags.map(serializeMetaTag)),
    connectedProviders: JSON.stringify(node.connectedProviders),
    customEndpoints: JSON.stringify(node.customEndpoints),
    capabilities: JSON.stringify(node.capabilities),
    status: node.status,
    lastHeartbeat: now.toString(),
    registeredAt: now.toString(),
    sessionId: node.sessionId || '',
    noExpiry: noExpiry ? '1' : '0',
    // virtualLocal: only set by subscribeToCluster() for loopback routing.
    // External clusters registered via API/tool never get virtualLocal=1,
    // so they remain subject to heartbeat-based stale detection.
    virtualLocal: '0',
  });

  const ttl = input.ttlSeconds ?? DEFAULT_NODE_TTL;
  if (ttl > 0) {
    tx.expire(CLUSTER_KEYS.node(node.id), ttl);
  }
  tx.zadd(CLUSTER_KEYS.active(), now.toString(), node.id);

  await tx.exec();

  Logger.debug(`[ClusterRegistry] Registered cluster: ${node.id} (${node.name})`);
  return node;
}

/**
 * Deregister a cluster node.
 */
export async function deregisterCluster(clusterId: string): Promise<boolean> {
  const client = await getRedis();

  // Find associated signal history keys (this cluster as src or tgt)
  // Use SCAN instead of KEYS to avoid blocking Redis on large datasets
  const signalKeysPattern = `mcp:cluster:signals:*${clusterId}*`;
  const associatedKeys: string[] = [];
  try {
    let cursor = '0';
    do {
      const [nextCursor, keys] = await client.scan(cursor, 'MATCH', signalKeysPattern, 'COUNT', 100);
      cursor = nextCursor;
      associatedKeys.push(...keys);
    } while (cursor !== '0');
  } catch {
    // SCAN failure — proceed with basic cleanup
  }

  const tx = client.multi();
  tx.del(CLUSTER_KEYS.node(clusterId));
  tx.del(CLUSTER_KEYS.metrics(clusterId));
  tx.zrem(CLUSTER_KEYS.active(), clusterId);
  // Clean up signal history keys involving this cluster
  for (const key of associatedKeys) {
    tx.del(key);
  }
  await tx.exec();

  Logger.debug(
    `[ClusterRegistry] Deregistered cluster: ${clusterId} (cleaned ${associatedKeys.length + 1} associated keys)`,
  );
  return true;
}

/**
 * Get a cluster node by ID.
 */
export async function getCluster(clusterId: string): Promise<ClusterNode | null> {
  const client = await getRedis();
  const data = await client.hgetall(CLUSTER_KEYS.node(clusterId));

  if (!data || !data.id) return null;
  return deserializeNode(data);
}

/**
 * List all active cluster nodes.
 */
export async function listClusters(): Promise<ClusterNode[]> {
  const client = await getRedis();
  const ids = await client.zrevrange(CLUSTER_KEYS.active(), 0, -1);

  if (!ids.length) return [];

  const pipeline = client.pipeline();
  for (const id of ids) {
    pipeline.hgetall(CLUSTER_KEYS.node(id));
  }
  const results = await pipeline.exec();
  if (!results) return [];

  const nodes: ClusterNode[] = [];
  const orphanedIds: string[] = [];

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (!result) { orphanedIds.push(ids[i]); continue; }
    const [err, data] = result as [Error | null, unknown];
    if (err || !data || typeof data !== 'object') { orphanedIds.push(ids[i]); continue; }
    const record = data as Record<string, string>;
    if (!record.id) { orphanedIds.push(ids[i]); continue; }
    nodes.push(deserializeNode(record));
  }

  // Clean up orphaned sorted set entries (hash expired but zadd entry remains)
  if (orphanedIds.length > 0) {
    const cleanPipeline = client.pipeline();
    for (const id of orphanedIds) {
      cleanPipeline.zrem(CLUSTER_KEYS.active(), id);
    }
    cleanPipeline.exec().catch((err) => {
      Logger.warn(`[ClusterRegistry] Failed to clean orphaned entries: ${err instanceof Error ? err.message : String(err)}`);
    });
    Logger.debug(`[ClusterRegistry] Cleaned ${orphanedIds.length} orphaned sorted set entries`);
  }

  return nodes;
}

/**
 * Find clusters matching a meta-tag query.
 * Supports exact match: { key: 'provider', value: 'anthropic' }
 */
export async function findByMetaTag(tag: ClusterMetaTag): Promise<ClusterNode[]> {
  const all = await listClusters();
  return all.filter((node) =>
    node.metaTags.some((t) => t.key === tag.key && (tag.value === '*' || t.value === tag.value)),
  );
}

/**
 * Find clusters by capability.
 */
export async function findByCapability(capability: string): Promise<ClusterNode[]> {
  const all = await listClusters();
  return all.filter((node) => node.capabilities.includes(capability));
}

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

/**
 * Update heartbeat for a cluster node.
 * Refreshes TTL and updates status/providers.
 */
export async function updateHeartbeat(
  clusterId: string,
  status: ClusterStatus = 'online',
  providers?: string[],
  load?: number,
): Promise<boolean> {
  const client = await getRedis();
  const now = Date.now();

  const exists = await client.exists(CLUSTER_KEYS.node(clusterId));
  if (!exists) return false;

  const tx = client.multi();

  const updates: Record<string, string> = {
    lastHeartbeat: now.toString(),
    status,
  };
  if (providers) {
    updates.connectedProviders = JSON.stringify(providers);
  }
  if (load !== undefined) {
    updates.load = load.toString();
  }

  tx.hset(CLUSTER_KEYS.node(clusterId), updates);
  tx.expire(CLUSTER_KEYS.node(clusterId), DEFAULT_NODE_TTL);
  tx.zadd(CLUSTER_KEYS.active(), now.toString(), clusterId);

  await tx.exec();
  return true;
}

/**
 * Mark a cluster node as a local virtual cluster (loopback routing).
 * Virtual local clusters are exempt from heartbeat-based stale detection
 * because they don't send real heartbeats — they share the host process.
 */
export async function markVirtualLocal(clusterId: string, isVirtual: boolean): Promise<boolean> {
  const client = await getRedis();
  const exists = await client.exists(CLUSTER_KEYS.node(clusterId));
  if (!exists) return false;
  await client.hset(CLUSTER_KEYS.node(clusterId), 'virtualLocal', isVirtual ? '1' : '0');
  return true;
}

/**
 * Detect stale cluster nodes (heartbeat older than threshold).
 */
export async function detectStaleNodes(thresholdMs: number): Promise<ClusterNode[]> {
  const client = await getRedis();
  const all = await listClusters();
  const cutoff = Date.now() - thresholdMs;
  const stale: ClusterNode[] = [];

  for (const node of all) {
    if (node.lastHeartbeat >= cutoff) continue;
    // Only skip truly local virtual clusters (loopback routing on the same node).
    // External clusters with noExpiry (TTL=0) are still subject to heartbeat-based
    // stale detection — they must prove liveness via heartbeats regardless of TTL.
    const virtualLocal = await client.hget(CLUSTER_KEYS.node(node.id), 'virtualLocal');
    if (virtualLocal === '1') continue;
    stale.push(node);
  }

  return stale;
}

/**
 * Remove stale nodes from registry.
 */
export async function pruneStaleNodes(thresholdMs: number): Promise<string[]> {
  const stale = await detectStaleNodes(thresholdMs);
  const pruned: string[] = [];

  for (const node of stale) {
    await deregisterCluster(node.id);
    pruned.push(node.id);
  }

  if (pruned.length > 0) {
    Logger.info(`[ClusterRegistry] Pruned ${pruned.length} stale nodes: ${pruned.join(', ')}`);
  }
  return pruned;
}

// ---------------------------------------------------------------------------
// Topology
// ---------------------------------------------------------------------------

/**
 * Get full cluster topology snapshot.
 */
export async function getTopology(): Promise<ClusterTopology> {
  const nodes = await listClusters();

  // Build edges: every online node pair has a potential duplex edge
  const edges: ClusterEdge[] = [];
  const onlineNodes = nodes.filter((n) => n.status === 'online');

  for (let i = 0; i < onlineNodes.length; i++) {
    for (let j = i + 1; j < onlineNodes.length; j++) {
      edges.push({
        source: onlineNodes[i].id,
        target: onlineNodes[j].id,
        direction: 'duplex',
        active: true,
        signalCount: 0,
      });
    }
  }

  return {
    nodes,
    edges,
    snapshotAt: Date.now(),
  };
}

/**
 * Get topology as Mermaid diagram string.
 */
export function topologyToMermaid(topology: ClusterTopology): string {
  const lines = ['graph LR'];

  for (const node of topology.nodes) {
    const label = `${node.name}\\n[${node.status}]`;
    const shape = node.status === 'online' ? `${node.id}[${label}]` : `${node.id}((${label}))`;
    lines.push(`  ${shape}`);
  }

  for (const edge of topology.edges) {
    const arrow = edge.direction === 'duplex' ? '<-->' : '-->';
    lines.push(`  ${edge.source} ${arrow} ${edge.target}`);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deserializeNode(data: Record<string, string>): ClusterNode {
  return {
    id: data.id,
    name: data.name || data.id,
    metaTags: safeParseArray(data.metaTags).map(parseMetaTag),
    connectedProviders: safeParseArray(data.connectedProviders),
    customEndpoints: safeParseJson<ClusterCustomEndpoint[]>(data.customEndpoints, []),
    capabilities: safeParseArray(data.capabilities),
    status: (data.status as ClusterStatus) || 'offline',
    lastHeartbeat: parseInt(data.lastHeartbeat || '0', 10),
    registeredAt: parseInt(data.registeredAt || '0', 10),
    sessionId: data.sessionId || undefined,
    load: data.load !== undefined ? parseFloat(data.load) : undefined,
  };
}

function safeParseArray(value: string | undefined): string[] {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function safeParseJson<T>(value: string | undefined, fallback: T): T {
  try {
    return JSON.parse(value || JSON.stringify(fallback)) as T;
  } catch {
    return fallback;
  }
}
