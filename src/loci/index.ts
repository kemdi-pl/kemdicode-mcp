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
 * Loci Palace Memory Graph Module
 *
 * Provides a knowledge graph connecting files, errors, solutions,
 * and tools with mnemonic associations using the Method of Loci.
 */

// Types
export type {
  GraphNodeType,
  GraphEdgeType,
  GraphNode,
  GraphEdge,
  Loci,
  LociCategory,
  LociTemplate,
  ToolSequence,
  GraphPath,
  GraphQueryOptions,
  TraversalOptions,
  TraversalResult,
  LociRecall,
  SequenceRecommendation,
  AutoPopulationEvent,
  AutoPopulationConfig,
} from './types.js';

export { LOCI_KEYS, LOCI_TEMPLATES, DEFAULT_AUTO_POPULATION_CONFIG } from './types.js';

// Graph storage
export {
  GraphStorage,
  getGraphStorage,
  resetGraphStorage,
  type GraphStorageConfig,
} from './graph-storage.js';

// Graph traversal
export {
  bfs,
  dfs,
  findShortestPath,
  findErrorToSolutionPath,
  findAllPaths,
  getSubgraph,
  findByRelationship,
} from './graph-traversal.js';

// Loci manager
export {
  LociManager,
  getLociManager,
  resetLociManager,
  type LociManagerConfig,
} from './loci-manager.js';

// Sequence tracker
export {
  SequenceTracker,
  getSequenceTracker,
  resetSequenceTracker,
  type SequenceTrackerConfig,
} from './sequence-tracker.js';
