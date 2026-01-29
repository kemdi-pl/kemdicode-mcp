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
 * Loci Graph Traversal
 *
 * BFS, DFS, and shortest path algorithms for the knowledge graph.
 */

import type {
  GraphNode,
  GraphEdge,
  GraphPath,
  TraversalOptions,
  TraversalResult,
  GraphEdgeType,
} from './types.js';
import { getGraphStorage } from './graph-storage.js';

/**
 * Default traversal options
 */
const DEFAULT_TRAVERSAL_OPTIONS: TraversalOptions = {
  maxDepth: 5,
  maxNodes: 100,
  trackVisited: true,
};

interface TraversalEntry {
  nodeId: string;
  depth: number;
  path: string[];
  edgePath: string[];
}

/**
 * Generic graph traversal (shared logic for BFS and DFS)
 */
async function traverse(
  startNodeId: string,
  strategy: 'bfs' | 'dfs',
  options: TraversalOptions = {}
): Promise<TraversalResult> {
  const opts = { ...DEFAULT_TRAVERSAL_OPTIONS, ...options };
  const storage = getGraphStorage();

  const visited = new Set<string>();
  const frontier: TraversalEntry[] = [];
  const result: TraversalResult = {
    nodes: [],
    edges: [],
    maxDepthReached: 0,
    nodesVisited: 0,
    paths: new Map(),
  };

  const startNode = await storage.getNode(startNodeId);
  if (!startNode) return result;

  frontier.push({ nodeId: startNodeId, depth: 0, path: [startNodeId], edgePath: [] });
  if (strategy === 'bfs') visited.add(startNodeId);

  while (frontier.length > 0 && result.nodesVisited < opts.maxNodes!) {
    // BFS: shift from front, DFS: pop from back
    const current = strategy === 'bfs' ? frontier.shift()! : frontier.pop()!;

    // DFS checks visited on dequeue
    if (strategy === 'dfs') {
      if (visited.has(current.nodeId)) continue;
      visited.add(current.nodeId);
    }

    const node = await storage.getNode(current.nodeId);
    if (!node) continue;

    if (opts.nodeTypes && !opts.nodeTypes.includes(node.type)) continue;

    result.nodes.push(node);
    result.nodesVisited++;
    result.maxDepthReached = Math.max(result.maxDepthReached, current.depth);

    result.paths.set(current.nodeId, {
      nodeIds: current.path,
      edgeIds: current.edgePath,
      totalWeight: 0,
    });

    if (current.depth >= opts.maxDepth!) continue;

    const edges = await storage.getOutgoingEdges(current.nodeId);
    // DFS reverses edge order to process in natural order
    const edgeList = strategy === 'dfs' ? [...edges].reverse() : edges;

    for (const edge of edgeList) {
      if (opts.edgeTypes && !opts.edgeTypes.includes(edge.type)) continue;
      if (opts.minEdgeWeight !== undefined && edge.weight < opts.minEdgeWeight) continue;

      if (!visited.has(edge.to)) {
        if (strategy === 'bfs') visited.add(edge.to);
        result.edges.push(edge);

        frontier.push({
          nodeId: edge.to,
          depth: current.depth + 1,
          path: [...current.path, edge.to],
          edgePath: [...current.edgePath, edge.id],
        });
      }
    }
  }

  return result;
}

/**
 * Breadth-First Search traversal
 */
export async function bfs(
  startNodeId: string,
  options: TraversalOptions = {}
): Promise<TraversalResult> {
  return traverse(startNodeId, 'bfs', options);
}

/**
 * Depth-First Search traversal
 */
export async function dfs(
  startNodeId: string,
  options: TraversalOptions = {}
): Promise<TraversalResult> {
  return traverse(startNodeId, 'dfs', options);
}

/**
 * Find shortest path between two nodes (BFS-based)
 */
export async function findShortestPath(
  fromNodeId: string,
  toNodeId: string,
  options: TraversalOptions = {}
): Promise<GraphPath | null> {
  const opts = { ...DEFAULT_TRAVERSAL_OPTIONS, ...options };
  const storage = getGraphStorage();

  const visited = new Set<string>();
  const queue: Array<{ nodeId: string; path: string[]; edgePath: string[]; weight: number }> = [];

  queue.push({ nodeId: fromNodeId, path: [fromNodeId], edgePath: [], weight: 0 });
  visited.add(fromNodeId);

  while (queue.length > 0) {
    const current = queue.shift()!;

    // Found target
    if (current.nodeId === toNodeId) {
      return {
        nodeIds: current.path,
        edgeIds: current.edgePath,
        totalWeight: current.weight,
        pathType: 'shortest',
      };
    }

    // Don't explore beyond max depth
    if (current.path.length > opts.maxDepth!) continue;

    // Get outgoing edges
    const edges = await storage.getOutgoingEdges(current.nodeId);

    for (const edge of edges) {
      // Apply edge filters
      if (opts.edgeTypes && !opts.edgeTypes.includes(edge.type)) continue;

      if (!visited.has(edge.to)) {
        visited.add(edge.to);

        queue.push({
          nodeId: edge.to,
          path: [...current.path, edge.to],
          edgePath: [...current.edgePath, edge.id],
          weight: current.weight + (1 - edge.weight), // Higher weight = shorter path
        });
      }
    }
  }

  return null; // No path found
}

/**
 * Find path from error to solution
 * Specialized search that follows 'fixes' edges
 */
export async function findErrorToSolutionPath(
  errorNodeId: string,
  options: TraversalOptions = {}
): Promise<GraphPath | null> {
  const storage = getGraphStorage();
  const opts = { ...DEFAULT_TRAVERSAL_OPTIONS, ...options };

  // Start from error node
  const errorNode = await storage.getNode(errorNodeId);
  if (!errorNode || errorNode.type !== 'error') {
    return null;
  }

  const visited = new Set<string>();
  const queue: Array<{ nodeId: string; path: string[]; edgePath: string[] }> = [];

  queue.push({ nodeId: errorNodeId, path: [errorNodeId], edgePath: [] });
  visited.add(errorNodeId);

  // Prefer 'fixes' edges, but also follow 'similar' to find related solutions
  const preferredEdges: GraphEdgeType[] = ['fixes', 'similar', 'related_to'];

  while (queue.length > 0) {
    const current = queue.shift()!;

    // Check if this is a solution node
    const node = await storage.getNode(current.nodeId);
    if (node && node.type === 'solution') {
      return {
        nodeIds: current.path,
        edgeIds: current.edgePath,
        totalWeight: current.path.length,
        pathType: 'error-to-solution',
      };
    }

    if (current.path.length > opts.maxDepth!) continue;

    // Get edges - check both directions for 'fixes' (solution fixes error)
    const outEdges = await storage.getOutgoingEdges(current.nodeId);
    const inEdges = await storage.getIncomingEdges(current.nodeId);

    // Check incoming 'fixes' edges (solution -> this error)
    for (const edge of inEdges) {
      if (edge.type === 'fixes' && !visited.has(edge.from)) {
        const sourceNode = await storage.getNode(edge.from);
        if (sourceNode && sourceNode.type === 'solution') {
          return {
            nodeIds: [...current.path, edge.from],
            edgeIds: [...current.edgePath, edge.id],
            totalWeight: current.path.length + 1,
            pathType: 'error-to-solution',
          };
        }
      }
    }

    // Follow outgoing edges
    for (const edge of outEdges) {
      if (preferredEdges.includes(edge.type) && !visited.has(edge.to)) {
        visited.add(edge.to);
        queue.push({
          nodeId: edge.to,
          path: [...current.path, edge.to],
          edgePath: [...current.edgePath, edge.id],
        });
      }
    }
  }

  return null;
}

/**
 * Find all paths between two nodes (up to a limit)
 */
export async function findAllPaths(
  fromNodeId: string,
  toNodeId: string,
  maxPaths: number = 5,
  options: TraversalOptions = {}
): Promise<GraphPath[]> {
  const opts = { ...DEFAULT_TRAVERSAL_OPTIONS, ...options };
  const storage = getGraphStorage();
  const paths: GraphPath[] = [];

  async function explore(
    currentId: string,
    visited: Set<string>,
    path: string[],
    edgePath: string[]
  ): Promise<void> {
    if (paths.length >= maxPaths) return;
    if (path.length > opts.maxDepth!) return;

    if (currentId === toNodeId) {
      paths.push({
        nodeIds: path,
        edgeIds: edgePath,
        totalWeight: path.length,
      });
      return;
    }

    const edges = await storage.getOutgoingEdges(currentId);

    for (const edge of edges) {
      if (opts.edgeTypes && !opts.edgeTypes.includes(edge.type)) continue;
      if (visited.has(edge.to)) continue;

      visited.add(edge.to);
      await explore(edge.to, visited, [...path, edge.to], [...edgePath, edge.id]);
      visited.delete(edge.to);
    }
  }

  const visited = new Set<string>([fromNodeId]);
  await explore(fromNodeId, visited, [fromNodeId], []);

  return paths;
}

/**
 * Get subgraph around a node
 */
export async function getSubgraph(
  centerNodeId: string,
  radius: number = 2
): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
  const result = await bfs(centerNodeId, { maxDepth: radius });

  return {
    nodes: result.nodes,
    edges: result.edges,
  };
}

/**
 * Find nodes connected by specific relationship
 */
export async function findByRelationship(
  nodeId: string,
  relationshipType: GraphEdgeType,
  direction: 'out' | 'in' | 'both' = 'out'
): Promise<GraphNode[]> {
  const storage = getGraphStorage();
  const nodes: GraphNode[] = [];
  const seenIds = new Set<string>();

  if (direction === 'out' || direction === 'both') {
    const outEdges = await storage.getOutgoingEdges(nodeId);
    for (const edge of outEdges) {
      if (edge.type === relationshipType && !seenIds.has(edge.to)) {
        const node = await storage.getNode(edge.to);
        if (node) {
          nodes.push(node);
          seenIds.add(edge.to);
        }
      }
    }
  }

  if (direction === 'in' || direction === 'both') {
    const inEdges = await storage.getIncomingEdges(nodeId);
    for (const edge of inEdges) {
      if (edge.type === relationshipType && !seenIds.has(edge.from)) {
        const node = await storage.getNode(edge.from);
        if (node) {
          nodes.push(node);
          seenIds.add(edge.from);
        }
      }
    }
  }

  return nodes;
}
