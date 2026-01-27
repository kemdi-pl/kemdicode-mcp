/**
 * KemdiCode MCP Server
 * Copyright (C) 2025-2026 Kemdi Sp. z o.o.
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
 * Loci Graph Storage
 *
 * Redis-based graph storage for the knowledge graph.
 * Uses sorted sets for edges and hashes for nodes.
 */

import { Redis } from 'ioredis';
import type {
  GraphNode,
  GraphEdge,
  GraphNodeType,
  GraphEdgeType,
  GraphQueryOptions,
} from './types.js';
import { LOCI_KEYS } from './types.js';
import { randomBytes } from 'crypto';

/**
 * Graph Storage configuration
 */
export interface GraphStorageConfig {
  host?: string;
  port?: number;
  password?: string;
  db?: number;
  /** Default TTL for nodes in seconds */
  nodeTtl?: number;
  /** Default TTL for edges in seconds */
  edgeTtl?: number;
}

/**
 * Graph Storage
 */
export class GraphStorage {
  private redis: Redis | null = null;
  private connected = false;
  private config: GraphStorageConfig;

  constructor(config: GraphStorageConfig = {}) {
    this.config = {
      host: config.host || process.env.REDIS_HOST || '127.0.0.1',
      port: config.port || parseInt(process.env.REDIS_PORT || '6379', 10),
      password: config.password || process.env.REDIS_PASSWORD,
      db: config.db ?? 2,
      nodeTtl: config.nodeTtl || 7200, // 2 hours
      edgeTtl: config.edgeTtl || 7200,
    };
  }

  /**
   * Connect to Redis
   */
  async connect(): Promise<void> {
    if (this.connected) return;

    try {
      this.redis = new Redis({
        host: this.config.host,
        port: this.config.port,
        password: this.config.password,
        db: this.config.db,
        lazyConnect: true,
        retryStrategy: (times: number) => {
          if (times > 3) return null;
          return Math.min(times * 100, 3000);
        },
      });

      await this.redis.connect();
      this.connected = true;
    } catch (error) {
      console.error('[GraphStorage] Failed to connect to Redis:', error);
      this.redis = null;
      throw error;
    }
  }

  /**
   * Disconnect from Redis
   */
  async disconnect(): Promise<void> {
    if (this.redis) {
      await this.redis.quit();
      this.redis = null;
      this.connected = false;
    }
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.connected && this.redis !== null;
  }

  /**
   * Generate a unique node ID
   */
  generateNodeId(type: GraphNodeType): string {
    return `node_${type}_${Date.now()}_${randomBytes(4).toString('hex')}`;
  }

  /**
   * Generate a unique edge ID
   */
  generateEdgeId(): string {
    return `edge_${Date.now()}_${randomBytes(4).toString('hex')}`;
  }

  /**
   * Add a node to the graph
   */
  async addNode(
    node: Omit<GraphNode, 'id' | 'createdAt' | 'lastAccessedAt' | 'accessCount'>
  ): Promise<GraphNode | null> {
    if (!this.isConnected() || !this.redis) return null;

    try {
      const now = Date.now();
      const fullNode: GraphNode = {
        ...node,
        id: this.generateNodeId(node.type),
        createdAt: now,
        lastAccessedAt: now,
        accessCount: 0,
      };

      const key = LOCI_KEYS.node(fullNode.id);
      await this.redis.hset(key, this.serializeNode(fullNode));

      // Add to type index
      await this.redis.sadd(LOCI_KEYS.nodesByType(fullNode.type), fullNode.id);

      // Add to session index
      await this.redis.sadd(LOCI_KEYS.nodesBySession(fullNode.sessionId), fullNode.id);

      // Set TTL
      await this.redis.expire(key, this.config.nodeTtl!);

      return fullNode;
    } catch (error) {
      console.error('[GraphStorage] Error adding node:', error);
      return null;
    }
  }

  /**
   * Get a node by ID
   */
  async getNode(nodeId: string): Promise<GraphNode | null> {
    if (!this.isConnected() || !this.redis) return null;

    try {
      const key = LOCI_KEYS.node(nodeId);
      const data = await this.redis.hgetall(key);

      if (!data || Object.keys(data).length === 0) {
        return null;
      }

      // Update access time and count
      await this.redis.hset(key, {
        lastAccessedAt: Date.now(),
        accessCount: parseInt(data.accessCount || '0', 10) + 1,
      });

      return this.parseNode(data);
    } catch (error) {
      console.error('[GraphStorage] Error getting node:', error);
      return null;
    }
  }

  /**
   * Update a node
   */
  async updateNode(nodeId: string, updates: Partial<GraphNode>): Promise<boolean> {
    if (!this.isConnected() || !this.redis) return false;

    try {
      const key = LOCI_KEYS.node(nodeId);
      const exists = await this.redis.exists(key);
      if (!exists) return false;

      const updateData: Record<string, string | number> = {};
      if (updates.label !== undefined) updateData.label = updates.label;
      if (updates.weight !== undefined) updateData.weight = updates.weight;
      if (updates.data !== undefined) updateData.data = JSON.stringify(updates.data);
      if (updates.tags !== undefined) updateData.tags = JSON.stringify(updates.tags);
      updateData.lastAccessedAt = Date.now();

      await this.redis.hset(key, updateData);
      return true;
    } catch (error) {
      console.error('[GraphStorage] Error updating node:', error);
      return false;
    }
  }

  /**
   * Delete a node and its edges
   */
  async deleteNode(nodeId: string): Promise<boolean> {
    if (!this.isConnected() || !this.redis) return false;

    try {
      const node = await this.getNode(nodeId);
      if (!node) return false;

      // Delete outgoing edges
      const outEdges = await this.redis.zrange(LOCI_KEYS.edgesOut(nodeId), 0, -1);
      for (const edgeId of outEdges) {
        await this.deleteEdge(edgeId);
      }

      // Delete incoming edges
      const inEdges = await this.redis.zrange(LOCI_KEYS.edgesIn(nodeId), 0, -1);
      for (const edgeId of inEdges) {
        await this.deleteEdge(edgeId);
      }

      // Remove from indices
      await this.redis.srem(LOCI_KEYS.nodesByType(node.type), nodeId);
      await this.redis.srem(LOCI_KEYS.nodesBySession(node.sessionId), nodeId);

      // Delete node
      await this.redis.del(LOCI_KEYS.node(nodeId));

      return true;
    } catch (error) {
      console.error('[GraphStorage] Error deleting node:', error);
      return false;
    }
  }

  /**
   * Add an edge between nodes
   */
  async addEdge(
    fromNodeId: string,
    toNodeId: string,
    type: GraphEdgeType,
    weight: number = 0.5,
    metadata?: Record<string, unknown>
  ): Promise<GraphEdge | null> {
    if (!this.isConnected() || !this.redis) return null;

    try {
      // Verify nodes exist
      const [fromExists, toExists] = await Promise.all([
        this.redis.exists(LOCI_KEYS.node(fromNodeId)),
        this.redis.exists(LOCI_KEYS.node(toNodeId)),
      ]);

      if (!fromExists || !toExists) {
        console.error('[GraphStorage] Cannot add edge: one or both nodes do not exist');
        return null;
      }

      // Get session from source node
      const fromNode = await this.getNode(fromNodeId);
      if (!fromNode) return null;

      const edge: GraphEdge = {
        id: this.generateEdgeId(),
        from: fromNodeId,
        to: toNodeId,
        type,
        weight: Math.max(0, Math.min(1, weight)),
        sessionId: fromNode.sessionId,
        createdAt: Date.now(),
        traversalCount: 0,
        metadata,
      };

      // Store edge data
      const edgeKey = LOCI_KEYS.edge(edge.id);
      await this.redis.hset(edgeKey, this.serializeEdge(edge));

      // Add to adjacency lists (sorted by weight)
      await this.redis.zadd(LOCI_KEYS.edgesOut(fromNodeId), weight, edge.id);
      await this.redis.zadd(LOCI_KEYS.edgesIn(toNodeId), weight, edge.id);

      // Set TTL
      await this.redis.expire(edgeKey, this.config.edgeTtl!);

      return edge;
    } catch (error) {
      console.error('[GraphStorage] Error adding edge:', error);
      return null;
    }
  }

  /**
   * Get an edge by ID
   */
  async getEdge(edgeId: string): Promise<GraphEdge | null> {
    if (!this.isConnected() || !this.redis) return null;

    try {
      const key = LOCI_KEYS.edge(edgeId);
      const data = await this.redis.hgetall(key);

      if (!data || Object.keys(data).length === 0) {
        return null;
      }

      // Update traversal count
      await this.redis.hincrby(key, 'traversalCount', 1);

      return this.parseEdge(data);
    } catch (error) {
      console.error('[GraphStorage] Error getting edge:', error);
      return null;
    }
  }

  /**
   * Delete an edge
   */
  async deleteEdge(edgeId: string): Promise<boolean> {
    if (!this.isConnected() || !this.redis) return false;

    try {
      const edge = await this.getEdge(edgeId);
      if (!edge) return false;

      // Remove from adjacency lists
      await this.redis.zrem(LOCI_KEYS.edgesOut(edge.from), edgeId);
      await this.redis.zrem(LOCI_KEYS.edgesIn(edge.to), edgeId);

      // Delete edge data
      await this.redis.del(LOCI_KEYS.edge(edgeId));

      return true;
    } catch (error) {
      console.error('[GraphStorage] Error deleting edge:', error);
      return false;
    }
  }

  /**
   * Get outgoing edges from a node
   */
  async getOutgoingEdges(nodeId: string): Promise<GraphEdge[]> {
    if (!this.isConnected() || !this.redis) return [];

    try {
      const edgeIds = await this.redis.zrevrange(LOCI_KEYS.edgesOut(nodeId), 0, -1);
      const edges: GraphEdge[] = [];

      for (const edgeId of edgeIds) {
        const edge = await this.getEdge(edgeId);
        if (edge) edges.push(edge);
      }

      return edges;
    } catch (error) {
      console.error('[GraphStorage] Error getting outgoing edges:', error);
      return [];
    }
  }

  /**
   * Get incoming edges to a node
   */
  async getIncomingEdges(nodeId: string): Promise<GraphEdge[]> {
    if (!this.isConnected() || !this.redis) return [];

    try {
      const edgeIds = await this.redis.zrevrange(LOCI_KEYS.edgesIn(nodeId), 0, -1);
      const edges: GraphEdge[] = [];

      for (const edgeId of edgeIds) {
        const edge = await this.getEdge(edgeId);
        if (edge) edges.push(edge);
      }

      return edges;
    } catch (error) {
      console.error('[GraphStorage] Error getting incoming edges:', error);
      return [];
    }
  }

  /**
   * Query nodes with filters
   */
  async queryNodes(options: GraphQueryOptions): Promise<GraphNode[]> {
    if (!this.isConnected() || !this.redis) return [];

    try {
      let nodeIds: string[] = [];

      // Start with type filter if specified
      if (options.type) {
        const types = Array.isArray(options.type) ? options.type : [options.type];
        for (const type of types) {
          const typeNodeIds = await this.redis.smembers(LOCI_KEYS.nodesByType(type));
          nodeIds.push(...typeNodeIds);
        }
        nodeIds = [...new Set(nodeIds)]; // Dedupe
      } else if (options.sessionId) {
        nodeIds = await this.redis.smembers(LOCI_KEYS.nodesBySession(options.sessionId));
      } else {
        // No filter - need to scan (expensive, avoid in production)
        console.warn('[GraphStorage] Query without type or session filter - scanning all nodes');
        return [];
      }

      // Load nodes
      const nodes: GraphNode[] = [];
      for (const nodeId of nodeIds) {
        const node = await this.getNode(nodeId);
        if (node) {
          // Apply additional filters
          if (options.sessionId && node.sessionId !== options.sessionId) continue;
          if (options.minWeight !== undefined && node.weight < options.minWeight) continue;
          if (options.tags && !options.tags.some((tag) => node.tags.includes(tag))) continue;
          if (
            options.labelContains &&
            !node.label.toLowerCase().includes(options.labelContains.toLowerCase())
          )
            continue;

          nodes.push(node);
        }
      }

      // Sort
      const sortBy = options.sortBy || 'weight';
      const sortOrder = options.sortOrder || 'desc';
      nodes.sort((a, b) => {
        const aVal = a[sortBy] as number;
        const bVal = b[sortBy] as number;
        return sortOrder === 'desc' ? bVal - aVal : aVal - bVal;
      });

      // Limit
      if (options.limit) {
        return nodes.slice(0, options.limit);
      }

      return nodes;
    } catch (error) {
      console.error('[GraphStorage] Error querying nodes:', error);
      return [];
    }
  }

  /**
   * Get neighbors of a node
   */
  async getNeighbors(
    nodeId: string,
    direction: 'out' | 'in' | 'both' = 'both'
  ): Promise<GraphNode[]> {
    const neighbors: GraphNode[] = [];
    const seenIds = new Set<string>();

    if (direction === 'out' || direction === 'both') {
      const outEdges = await this.getOutgoingEdges(nodeId);
      for (const edge of outEdges) {
        if (!seenIds.has(edge.to)) {
          const node = await this.getNode(edge.to);
          if (node) {
            neighbors.push(node);
            seenIds.add(edge.to);
          }
        }
      }
    }

    if (direction === 'in' || direction === 'both') {
      const inEdges = await this.getIncomingEdges(nodeId);
      for (const edge of inEdges) {
        if (!seenIds.has(edge.from)) {
          const node = await this.getNode(edge.from);
          if (node) {
            neighbors.push(node);
            seenIds.add(edge.from);
          }
        }
      }
    }

    return neighbors;
  }

  /**
   * Serialize node for Redis
   */
  private serializeNode(node: GraphNode): Record<string, string | number> {
    return {
      id: node.id,
      type: node.type,
      label: node.label,
      weight: node.weight,
      sessionId: node.sessionId,
      createdAt: node.createdAt,
      lastAccessedAt: node.lastAccessedAt,
      accessCount: node.accessCount,
      data: JSON.stringify(node.data),
      tags: JSON.stringify(node.tags),
      embedding: node.embedding ? JSON.stringify(node.embedding) : '',
    };
  }

  /**
   * Parse node from Redis data
   */
  private parseNode(data: Record<string, string>): GraphNode {
    return {
      id: data.id,
      type: data.type as GraphNodeType,
      label: data.label,
      weight: parseFloat(data.weight),
      sessionId: data.sessionId,
      createdAt: parseInt(data.createdAt, 10),
      lastAccessedAt: parseInt(data.lastAccessedAt, 10),
      accessCount: parseInt(data.accessCount, 10),
      data: JSON.parse(data.data || '{}'),
      tags: JSON.parse(data.tags || '[]'),
      embedding: data.embedding ? JSON.parse(data.embedding) : undefined,
    };
  }

  /**
   * Serialize edge for Redis
   */
  private serializeEdge(edge: GraphEdge): Record<string, string | number> {
    return {
      id: edge.id,
      from: edge.from,
      to: edge.to,
      type: edge.type,
      weight: edge.weight,
      sessionId: edge.sessionId,
      createdAt: edge.createdAt,
      traversalCount: edge.traversalCount,
      metadata: edge.metadata ? JSON.stringify(edge.metadata) : '',
    };
  }

  /**
   * Parse edge from Redis data
   */
  private parseEdge(data: Record<string, string>): GraphEdge {
    return {
      id: data.id,
      from: data.from,
      to: data.to,
      type: data.type as GraphEdgeType,
      weight: parseFloat(data.weight),
      sessionId: data.sessionId,
      createdAt: parseInt(data.createdAt, 10),
      traversalCount: parseInt(data.traversalCount, 10),
      metadata: data.metadata ? JSON.parse(data.metadata) : undefined,
    };
  }

  /**
   * Inject Redis instance (for testing)
   */
  injectRedis(redis: Redis): void {
    this.redis = redis;
    this.connected = true;
  }
}

// Singleton instance
let graphStorage: GraphStorage | null = null;

/**
 * Get the global graph storage
 */
export function getGraphStorage(): GraphStorage {
  if (!graphStorage) {
    graphStorage = new GraphStorage();
  }
  return graphStorage;
}

/**
 * Reset the global graph storage (for testing)
 */
export function resetGraphStorage(): void {
  if (graphStorage) {
    graphStorage.disconnect().catch(console.error);
  }
  graphStorage = null;
}
