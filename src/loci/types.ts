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
 * Loci Palace Memory Graph Type Definitions
 *
 * Types for the knowledge graph connecting files, errors, solutions,
 * and tools with mnemonic associations using the Method of Loci.
 */

/**
 * Node types in the knowledge graph
 */
export type GraphNodeType =
  | 'file'
  | 'error'
  | 'solution'
  | 'tool'
  | 'concept'
  | 'context'
  | 'loci'
  | 'pattern'
  | 'agent';

/**
 * Edge types (relationships) in the graph
 */
export type GraphEdgeType =
  | 'causes'
  | 'fixes'
  | 'requires'
  | 'follows'
  | 'contains'
  | 'similar'
  | 'references'
  | 'produces'
  | 'located_in'
  | 'uses'
  | 'learned_from'
  | 'related_to';

/**
 * Graph node structure
 */
export interface GraphNode {
  /** Unique node ID */
  id: string;
  /** Node type */
  type: GraphNodeType;
  /** Human-readable label */
  label: string;
  /** Importance weight (0-1) */
  weight: number;
  /** Session this node belongs to */
  sessionId: string;
  /** Creation timestamp */
  createdAt: number;
  /** Last accessed timestamp */
  lastAccessedAt: number;
  /** Access count (for importance decay) */
  accessCount: number;
  /** Arbitrary data payload */
  data: Record<string, unknown>;
  /** Tags for categorization */
  tags: string[];
  /** Optional embedding vector for semantic search */
  embedding?: number[];
}

/**
 * Graph edge structure
 */
export interface GraphEdge {
  /** Unique edge ID */
  id: string;
  /** Source node ID */
  from: string;
  /** Target node ID */
  to: string;
  /** Relationship type */
  type: GraphEdgeType;
  /** Edge weight/strength (0-1) */
  weight: number;
  /** Session this edge belongs to */
  sessionId: string;
  /** Creation timestamp */
  createdAt: number;
  /** Traversal count */
  traversalCount: number;
  /** Optional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Loci (mnemonic location) structure
 */
export interface Loci {
  /** Unique loci ID */
  id: string;
  /** Vivid name for the location */
  name: string;
  /** Rich description for visualization */
  description: string;
  /** Category of this loci */
  category: LociCategory;
  /** Visual/sensory associations */
  associations: string[];
  /** Node IDs placed in this loci */
  nodeIds: string[];
  /** Parent loci ID (for nested palaces) */
  parentLociId?: string;
  /** Child loci IDs */
  childLociIds: string[];
  /** Order in the palace walk */
  order: number;
  /** Session ID */
  sessionId: string;
  /** Creation timestamp */
  createdAt: number;
  /** Icon/emoji for quick recognition */
  icon?: string;
  /** Color theme */
  color?: string;
}

/**
 * Loci categories
 */
export type LociCategory =
  | 'error'
  | 'solution'
  | 'tool'
  | 'pattern'
  | 'dependency'
  | 'concept'
  | 'custom';

/**
 * Predefined loci templates
 */
export interface LociTemplate {
  name: string;
  description: string;
  category: LociCategory;
  associations: string[];
  icon: string;
  color: string;
}

/**
 * Default loci templates
 */
export const LOCI_TEMPLATES: Record<string, LociTemplate> = {
  'error-volcano': {
    name: 'The Error Volcano',
    description: 'An active volcano that erupts with stack traces and error messages',
    category: 'error',
    associations: [
      'Red TypeError lava flows down the slopes',
      'Green ReferenceError gas rises from vents',
      'Blue SyntaxError crystals form in caves',
      'The rumbling sound of uncaught exceptions',
    ],
    icon: '🌋',
    color: '#e74c3c',
  },
  'solution-library': {
    name: 'The Solution Library',
    description: 'An infinite library with books containing fixes and solutions',
    category: 'solution',
    associations: [
      'Golden shelves organized by error type',
      'Glowing books that open when you approach',
      'Whispered hints from ancient scrolls',
      'A wise librarian who knows all patterns',
    ],
    icon: '📚',
    color: '#3498db',
  },
  'dependency-dungeon': {
    name: 'The Dependency Dungeon',
    description: 'A dark dungeon where npm packages are kept in cages',
    category: 'dependency',
    associations: [
      'Rusty chains connecting package versions',
      'Torches showing peer dependency paths',
      'Guards checking semver compatibility',
      'A map of the node_modules labyrinth',
    ],
    icon: '⛓️',
    color: '#9b59b6',
  },
  'tool-workshop': {
    name: 'The Tool Workshop',
    description: 'A craftsman workshop filled with powerful tools',
    category: 'tool',
    associations: [
      'Sparkling code-review magnifying glass',
      'Refactoring hammer that reshapes code',
      'Testing anvil that finds weaknesses',
      'Git time machine in the corner',
    ],
    icon: '🛠️',
    color: '#f39c12',
  },
  'pattern-garden': {
    name: 'The Pattern Garden',
    description: 'A serene garden where design patterns grow as plants',
    category: 'pattern',
    associations: [
      'Factory trees producing object fruits',
      'Singleton rose that blooms once',
      'Observer vines that notice everything',
      'Strategy flowers that adapt to weather',
    ],
    icon: '🌸',
    color: '#2ecc71',
  },
  'concept-cloud': {
    name: 'The Concept Cloud',
    description: 'Floating platforms in the sky holding abstract concepts',
    category: 'concept',
    associations: [
      'Async clouds that float on promises',
      'Type bridges connecting platforms',
      'Rainbow streams of data flow',
      'Thunder of breaking changes',
    ],
    icon: '☁️',
    color: '#1abc9c',
  },
};

/**
 * Tool sequence pattern
 */
export interface ToolSequence {
  /** Sequence ID */
  id: string;
  /** Ordered list of tool names */
  tools: string[];
  /** Times this sequence was observed */
  occurrences: number;
  /** Success rate when following this sequence */
  successRate: number;
  /** Average time to complete sequence */
  avgDurationMs: number;
  /** Context tags when this sequence works */
  contextTags: string[];
  /** Session ID */
  sessionId: string;
  /** Last observed timestamp */
  lastObservedAt: number;
}

/**
 * Path result from graph traversal
 */
export interface GraphPath {
  /** Ordered list of node IDs */
  nodeIds: string[];
  /** Edges traversed */
  edgeIds: string[];
  /** Total path weight */
  totalWeight: number;
  /** Path type (e.g., "error-to-solution") */
  pathType?: string;
}

/**
 * Query options for node search
 */
export interface GraphQueryOptions {
  /** Filter by node type */
  type?: GraphNodeType | GraphNodeType[];
  /** Filter by session */
  sessionId?: string;
  /** Filter by tags (any match) */
  tags?: string[];
  /** Minimum weight threshold */
  minWeight?: number;
  /** Maximum results */
  limit?: number;
  /** Sort by field */
  sortBy?: 'weight' | 'createdAt' | 'accessCount' | 'lastAccessedAt';
  /** Sort direction */
  sortOrder?: 'asc' | 'desc';
  /** Text search in label */
  labelContains?: string;
}

/**
 * Traversal options for graph algorithms
 */
export interface TraversalOptions {
  /** Maximum depth to traverse */
  maxDepth?: number;
  /** Edge types to follow */
  edgeTypes?: GraphEdgeType[];
  /** Node types to include */
  nodeTypes?: GraphNodeType[];
  /** Minimum edge weight to traverse */
  minEdgeWeight?: number;
  /** Maximum nodes to visit */
  maxNodes?: number;
  /** Whether to track visited nodes */
  trackVisited?: boolean;
}

/**
 * BFS/DFS traversal result
 */
export interface TraversalResult {
  /** Nodes in traversal order */
  nodes: GraphNode[];
  /** Edges traversed */
  edges: GraphEdge[];
  /** Depth reached */
  maxDepthReached: number;
  /** Total nodes visited */
  nodesVisited: number;
  /** Path from start to each node */
  paths: Map<string, GraphPath>;
}

/**
 * Recall result from walking the memory palace
 */
export interface LociRecall {
  /** Loci walked */
  loci: Loci;
  /** Nodes recalled from this loci */
  nodes: GraphNode[];
  /** Associations triggered */
  associationsTriggered: string[];
  /** Connected memories from edges */
  connectedMemories: GraphNode[];
  /** Suggested next loci to walk */
  suggestedNext: Loci[];
}

/**
 * Sequence recommendation
 */
export interface SequenceRecommendation {
  /** Recommended next tool */
  nextTool: string;
  /** Confidence score (0-1) */
  confidence: number;
  /** Based on which patterns */
  basedOnPatterns: string[];
  /** Alternative tools ranked */
  alternatives: Array<{ tool: string; confidence: number }>;
}

/**
 * Redis key patterns for Loci/Graph
 */
export const LOCI_KEYS = {
  /** Node: mcp:graph:node:{nodeId} */
  node: (nodeId: string) => `mcp:graph:node:${nodeId}`,

  /** Nodes by type: mcp:graph:type:{nodeType} */
  nodesByType: (nodeType: GraphNodeType) => `mcp:graph:type:${nodeType}`,

  /** Nodes by session: mcp:graph:session:{sessionId} */
  nodesBySession: (sessionId: string) => `mcp:graph:session:${sessionId}`,

  /** Outgoing edges: mcp:graph:edges:out:{nodeId} */
  edgesOut: (nodeId: string) => `mcp:graph:edges:out:${nodeId}`,

  /** Incoming edges: mcp:graph:edges:in:{nodeId} */
  edgesIn: (nodeId: string) => `mcp:graph:edges:in:${nodeId}`,

  /** Edge data: mcp:graph:edge:{edgeId} */
  edge: (edgeId: string) => `mcp:graph:edge:${edgeId}`,

  /** Loci: mcp:loci:{lociId} */
  loci: (lociId: string) => `mcp:loci:${lociId}`,

  /** Loci by name: mcp:loci:name:{normalizedName} */
  lociByName: (name: string) => `mcp:loci:name:${name.toLowerCase().replace(/\s+/g, '-')}`,

  /** Loci by category: mcp:loci:category:{category} */
  lociByCategory: (category: LociCategory) => `mcp:loci:category:${category}`,

  /** Loci by session: mcp:loci:session:{sessionId} */
  lociBySession: (sessionId: string) => `mcp:loci:session:${sessionId}`,

  /** Tool sequences: mcp:sequences:{sessionId} */
  sequences: (sessionId: string) => `mcp:sequences:${sessionId}`,

  /** Current tool chain: mcp:chain:{agentId} */
  currentChain: (agentId: string) => `mcp:chain:${agentId}`,

  /** Tool transition matrix: mcp:transitions */
  transitions: () => `mcp:transitions`,
} as const;

/**
 * Auto-population event types
 */
export type AutoPopulationEvent =
  | 'tool_executed'
  | 'error_detected'
  | 'fix_applied'
  | 'pattern_learned'
  | 'file_accessed'
  | 'context_saved';

/**
 * Configuration for auto-population
 */
export interface AutoPopulationConfig {
  /** Whether auto-population is enabled */
  enabled: boolean;
  /** Events to track */
  events: AutoPopulationEvent[];
  /** Default edge weight for auto-created edges */
  defaultEdgeWeight: number;
  /** Default node weight for auto-created nodes */
  defaultNodeWeight: number;
  /** Whether to create loci associations automatically */
  autoLociAssociation: boolean;
  /** Minimum occurrences before creating sequence pattern */
  minSequenceOccurrences: number;
}

/**
 * Default auto-population configuration
 */
export const DEFAULT_AUTO_POPULATION_CONFIG: AutoPopulationConfig = {
  enabled: true,
  events: ['tool_executed', 'error_detected', 'fix_applied', 'pattern_learned'],
  defaultEdgeWeight: 0.5,
  defaultNodeWeight: 0.5,
  autoLociAssociation: true,
  minSequenceOccurrences: 3,
};
