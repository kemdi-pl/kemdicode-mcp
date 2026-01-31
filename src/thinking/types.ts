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
 * Thinking Chain Type Definitions
 *
 * Types for the thinking chain system that registers, embeds,
 * and manages chains of thought with branching and forward-only constraints.
 *
 * @module thinking/types
 */

/**
 * A single thought in a reasoning chain
 */
export interface Thought {
  /** 0-based position in chain */
  index: number;
  /** The thought content */
  content: string;
  /** Confidence level (0-100) */
  confidence: number;
  /** Reasoning for this confidence level */
  reasoning?: string;
  /** If this revises a previous thought, its index */
  revisedFrom?: number;
  /** Chain IDs that branched from this thought */
  branches?: string[];
  /** Creation timestamp */
  createdAt: number;
}

/**
 * Chain status
 */
export type ChainStatus = 'active' | 'concluded' | 'abandoned';

/**
 * A thinking chain containing ordered thoughts
 */
export interface ThinkingChain {
  /** Unique chain ID */
  id: string;
  /** Human-readable title */
  title: string;
  /** Owner agent ID */
  agentId: string;
  /** Session scope */
  sessionId: string;
  /** If branched from another chain */
  parentChainId?: string;
  /** Fork point in parent chain */
  parentThoughtIndex?: number;
  /** Ordered thought nodes */
  thoughts: Thought[];
  /** Chain status */
  status: ChainStatus;
  /** Final conclusion when concluded */
  conclusion?: string;
  /** Tags for categorization */
  tags: string[];
  /** Creation timestamp */
  createdAt: number;
  /** Last update timestamp */
  updatedAt: number;
}

/**
 * Redis key patterns for thinking chains
 */
export const THINKING_KEYS = {
  /** Chain data: mcp:thinking:chain:{chainId} */
  chain: (chainId: string) => `mcp:thinking:chain:${chainId}`,

  /** Chains by session: mcp:thinking:session:{sessionId} */
  bySession: (sessionId: string) => `mcp:thinking:session:${sessionId}`,

  /** Chains by agent: mcp:thinking:agent:{agentId} */
  byAgent: (agentId: string) => `mcp:thinking:agent:${agentId}`,
} as const;

/** Default TTL for thinking chains: 7 days */
export const THINKING_TTL = 7 * 24 * 60 * 60;
