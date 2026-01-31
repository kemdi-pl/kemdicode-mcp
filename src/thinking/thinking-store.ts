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
 * Thinking Chain Store
 *
 * Redis-backed storage for thinking chains.
 * Uses hash storage with JSON-serialized thoughts array.
 *
 * @module thinking/thinking-store
 */

import { getSharedRedis } from '../infrastructure/redis/connection.js';
import type { ThinkingChain, Thought, ChainStatus } from './types.js';
import { THINKING_KEYS, THINKING_TTL } from './types.js';
import { randomBytes } from 'crypto';

/**
 * Get Redis client
 */
async function getRedis() {
  return getSharedRedis();
}

/**
 * Generate a unique chain ID
 */
function generateChainId(): string {
  return `chain_${Date.now()}_${randomBytes(4).toString('hex')}`;
}

/**
 * Safely parse JSON with fallback
 */
function safeJsonParse<T>(value: string | undefined | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * Serialize chain for Redis storage
 */
function serializeChain(chain: ThinkingChain): Record<string, string> {
  return {
    id: chain.id,
    title: chain.title,
    agentId: chain.agentId,
    sessionId: chain.sessionId,
    parentChainId: chain.parentChainId || '',
    parentThoughtIndex: chain.parentThoughtIndex !== undefined ? String(chain.parentThoughtIndex) : '',
    thoughts: JSON.stringify(chain.thoughts),
    status: chain.status,
    conclusion: chain.conclusion || '',
    tags: JSON.stringify(chain.tags),
    createdAt: String(chain.createdAt),
    updatedAt: String(chain.updatedAt),
  };
}

/**
 * Parse chain from Redis data
 */
function parseChain(data: Record<string, string>): ThinkingChain {
  return {
    id: data.id,
    title: data.title,
    agentId: data.agentId,
    sessionId: data.sessionId,
    parentChainId: data.parentChainId || undefined,
    parentThoughtIndex: data.parentThoughtIndex ? parseInt(data.parentThoughtIndex, 10) : undefined,
    thoughts: safeJsonParse(data.thoughts, []),
    status: (data.status as ChainStatus) || 'active',
    conclusion: data.conclusion || undefined,
    tags: safeJsonParse(data.tags, []),
    createdAt: parseInt(data.createdAt, 10) || 0,
    updatedAt: parseInt(data.updatedAt, 10) || 0,
  };
}

/**
 * Create a new thinking chain with its first thought
 */
export async function createChain(params: {
  title: string;
  agentId: string;
  sessionId: string;
  content: string;
  confidence: number;
  reasoning?: string;
  tags?: string[];
}): Promise<ThinkingChain> {
  const client = await getRedis();
  const now = Date.now();

  const firstThought: Thought = {
    index: 0,
    content: params.content,
    confidence: Math.max(0, Math.min(100, params.confidence)),
    reasoning: params.reasoning,
    createdAt: now,
  };

  const chain: ThinkingChain = {
    id: generateChainId(),
    title: params.title,
    agentId: params.agentId,
    sessionId: params.sessionId,
    thoughts: [firstThought],
    status: 'active',
    tags: params.tags || [],
    createdAt: now,
    updatedAt: now,
  };

  const key = THINKING_KEYS.chain(chain.id);
  await client.hset(key, serializeChain(chain));
  await client.expire(key, THINKING_TTL);

  // Add to indexes
  await client.sadd(THINKING_KEYS.bySession(chain.sessionId), chain.id);
  await client.sadd(THINKING_KEYS.byAgent(chain.agentId), chain.id);

  return chain;
}

/**
 * Get a chain by ID
 */
export async function getChain(chainId: string): Promise<ThinkingChain | null> {
  const client = await getRedis();
  const data = await client.hgetall(THINKING_KEYS.chain(chainId));

  if (!data || Object.keys(data).length === 0) {
    return null;
  }

  return parseChain(data);
}

/**
 * Add a new thought to the end of a chain (forward-only)
 */
export async function addThought(
  chainId: string,
  params: { content: string; confidence: number; reasoning?: string }
): Promise<Thought> {
  const client = await getRedis();
  const chain = await getChain(chainId);

  if (!chain) throw new Error(`Chain not found: ${chainId}`);
  if (chain.status !== 'active') throw new Error(`Chain is ${chain.status}, cannot add thoughts`);

  const now = Date.now();
  const thought: Thought = {
    index: chain.thoughts.length,
    content: params.content,
    confidence: Math.max(0, Math.min(100, params.confidence)),
    reasoning: params.reasoning,
    createdAt: now,
  };

  chain.thoughts.push(thought);
  const key = THINKING_KEYS.chain(chainId);
  await client.hset(key, {
    thoughts: JSON.stringify(chain.thoughts),
    updatedAt: String(now),
  });

  return thought;
}

/**
 * Revise a thought in the chain.
 * Only allowed if:
 * - thoughtIndex is the last thought's index (revising latest), OR
 * - The latest thought has confidence >= 90
 */
export async function reviseThought(
  chainId: string,
  params: { thoughtIndex: number; content: string; confidence: number; reasoning?: string }
): Promise<Thought> {
  const client = await getRedis();
  const chain = await getChain(chainId);

  if (!chain) throw new Error(`Chain not found: ${chainId}`);
  if (chain.status !== 'active') throw new Error(`Chain is ${chain.status}, cannot revise thoughts`);

  const lastThought = chain.thoughts[chain.thoughts.length - 1];
  const isLastThought = params.thoughtIndex === lastThought.index;
  const highConfidence = lastThought.confidence >= 90;

  if (!isLastThought && !highConfidence) {
    throw new Error(
      `Cannot revise thought #${params.thoughtIndex}: backtracking blocked. ` +
      `Latest thought confidence is ${lastThought.confidence}% (need ≥90%) ` +
      `or revise the latest thought (#${lastThought.index}).`
    );
  }

  if (params.thoughtIndex < 0 || params.thoughtIndex >= chain.thoughts.length) {
    throw new Error(`Thought index ${params.thoughtIndex} out of range (0-${chain.thoughts.length - 1})`);
  }

  const now = Date.now();
  // Append a new thought that marks itself as a revision
  const revisedThought: Thought = {
    index: chain.thoughts.length,
    content: params.content,
    confidence: Math.max(0, Math.min(100, params.confidence)),
    reasoning: params.reasoning,
    revisedFrom: params.thoughtIndex,
    createdAt: now,
  };

  chain.thoughts.push(revisedThought);
  const key = THINKING_KEYS.chain(chainId);
  await client.hset(key, {
    thoughts: JSON.stringify(chain.thoughts),
    updatedAt: String(now),
  });

  return revisedThought;
}

/**
 * Branch a new chain from a specific thought in an existing chain
 */
export async function branchChain(params: {
  sourceChainId: string;
  thoughtIndex: number;
  title: string;
  content: string;
  confidence: number;
  reasoning?: string;
}): Promise<ThinkingChain> {
  const client = await getRedis();
  const sourceChain = await getChain(params.sourceChainId);

  if (!sourceChain) throw new Error(`Source chain not found: ${params.sourceChainId}`);

  if (params.thoughtIndex < 0 || params.thoughtIndex >= sourceChain.thoughts.length) {
    throw new Error(
      `Thought index ${params.thoughtIndex} out of range (0-${sourceChain.thoughts.length - 1})`
    );
  }

  const now = Date.now();

  const firstThought: Thought = {
    index: 0,
    content: params.content,
    confidence: Math.max(0, Math.min(100, params.confidence)),
    reasoning: params.reasoning,
    createdAt: now,
  };

  const newChain: ThinkingChain = {
    id: generateChainId(),
    title: params.title,
    agentId: sourceChain.agentId,
    sessionId: sourceChain.sessionId,
    parentChainId: params.sourceChainId,
    parentThoughtIndex: params.thoughtIndex,
    thoughts: [firstThought],
    status: 'active',
    tags: [...sourceChain.tags],
    createdAt: now,
    updatedAt: now,
  };

  // Save new chain
  const key = THINKING_KEYS.chain(newChain.id);
  await client.hset(key, serializeChain(newChain));
  await client.expire(key, THINKING_TTL);

  // Add to indexes
  await client.sadd(THINKING_KEYS.bySession(newChain.sessionId), newChain.id);
  await client.sadd(THINKING_KEYS.byAgent(newChain.agentId), newChain.id);

  // Record branch in source chain's thought
  const sourceThought = sourceChain.thoughts[params.thoughtIndex];
  if (!sourceThought.branches) sourceThought.branches = [];
  sourceThought.branches.push(newChain.id);

  await client.hset(THINKING_KEYS.chain(params.sourceChainId), {
    thoughts: JSON.stringify(sourceChain.thoughts),
    updatedAt: String(now),
  });

  return newChain;
}

/**
 * Conclude a chain with a final conclusion
 */
export async function concludeChain(
  chainId: string,
  conclusion: string
): Promise<ThinkingChain> {
  const client = await getRedis();
  const chain = await getChain(chainId);

  if (!chain) throw new Error(`Chain not found: ${chainId}`);
  if (chain.status !== 'active') throw new Error(`Chain is already ${chain.status}`);

  const now = Date.now();
  const key = THINKING_KEYS.chain(chainId);
  await client.hset(key, {
    status: 'concluded',
    conclusion,
    updatedAt: String(now),
  });

  chain.status = 'concluded';
  chain.conclusion = conclusion;
  chain.updatedAt = now;
  return chain;
}

/**
 * List chains with optional filters
 */
export async function listChains(params: {
  sessionId?: string;
  agentId?: string;
  status?: ChainStatus;
  limit?: number;
}): Promise<ThinkingChain[]> {
  const client = await getRedis();

  let chainIds: string[] = [];

  if (params.agentId) {
    chainIds = await client.smembers(THINKING_KEYS.byAgent(params.agentId));
  } else if (params.sessionId) {
    chainIds = await client.smembers(THINKING_KEYS.bySession(params.sessionId));
  } else {
    return [];
  }

  const chains: ThinkingChain[] = [];
  for (const id of chainIds) {
    const chain = await getChain(id);
    if (!chain) continue;
    if (params.status && chain.status !== params.status) continue;
    chains.push(chain);
  }

  // Sort by updatedAt desc
  chains.sort((a, b) => b.updatedAt - a.updatedAt);

  const limit = params.limit || 20;
  return chains.slice(0, limit);
}
