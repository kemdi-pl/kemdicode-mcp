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

/**
 * Tool Invoker
 *
 * Safe recursive tool invocation with rate limiting and depth control.
 *
 * @module recursive/tool-invoker
 */

import { getSharedRedis } from '../infrastructure/redis/connection.js';
import { v4 as uuidv4 } from 'uuid';
import { Logger } from '../utils/logger.js';
import { getToolByName, executeTool, type ToolArguments } from '../tools/registry.js';
import { getGlobalEventBus } from '../events/global-bus.js';
import {
  ToolInvocationRequest,
  ToolInvocationResult,
  InvocationContext,
  InvocationPolicy,
  SafetyCheckResult,
  RateLimitEntry,
  DEFAULT_POLICY,
  RECURSIVE_KEYS,
  INVOCATION_TTL,
  RATE_LIMIT_WINDOW,
  MAX_LOG_ENTRIES,
} from './types.js';

/** Current invocation context (per-request) with LRU eviction */
const contextStack = new Map<string, InvocationContext>();
const MAX_CONTEXT_SIZE = 100;

/** In-memory rate limit fallback when Redis is unavailable */
const memoryRateLimits = new Map<string, { count: number; resetAt: number }>();

/** Reusable Map for batch parallel operations to reduce allocations */
const batchContextCache = new Map<string, InvocationContext | undefined>();

const getRedis = getSharedRedis;

/**
 * Try to get Redis client, returning null if unavailable.
 */
async function tryGetRedis() {
  try {
    return await getRedis();
  } catch {
    return null;
  }
}

/**
 * Atomic rate limiting using Lua script (INCR + EXPIRE in single round-trip).
 * Falls back to in-memory rate limiter when Redis is unavailable.
 */
async function incrementRateLimit(agentId: string): Promise<number> {
  const client = await tryGetRedis();
  if (!client) {
    // In-memory fallback with same window semantics
    const now = Date.now();
    const key = `memory:ratelimit:${agentId}`;
    const entry = memoryRateLimits.get(key);

    if (!entry || now >= entry.resetAt) {
      memoryRateLimits.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
      return 1;
    }
    const newCount = entry.count + 1;
    memoryRateLimits.set(key, { ...entry, count: newCount });
    return newCount;
  }

  const rateLimitKey = RECURSIVE_KEYS.rateLimit(agentId);
  const windowSeconds = Math.ceil(RATE_LIMIT_WINDOW / 1000);

  const luaScript = `
    local current = redis.call('INCR', KEYS[1])
    if current == 1 then
      redis.call('EXPIRE', KEYS[1], ARGV[1])
    end
    return current
  `;

  try {
    const result = await client.eval(luaScript, 1, rateLimitKey, windowSeconds);
    return Number(result);
  } catch {
    Logger.warn('Redis rate limit script failed, falling back to in-memory');
    return incrementRateLimit(agentId);
  }
}

/**
 * Read rate limit entry from Redis or in-memory fallback.
 * Uses atomic INCR-based keys (no JSON parsing needed).
 */
async function getRateLimitEntry(agentId: string): Promise<RateLimitEntry> {
  const client = await tryGetRedis();
  if (!client) {
    // In-memory fallback
    const key = `memory:ratelimit:${agentId}`;
    const entry = memoryRateLimits.get(key);
    const now = Date.now();

    if (!entry || now >= entry.resetAt) {
      return { count: 0, windowStart: now };
    }
    return { count: entry.count, windowStart: entry.resetAt - RATE_LIMIT_WINDOW };
  }

  const rateLimitKey = RECURSIVE_KEYS.rateLimit(agentId);
  const count = await client.get(rateLimitKey);

  if (!count) {
    return { count: 0, windowStart: Date.now() };
  }
  return { count: parseInt(count, 10), windowStart: Date.now() };
}

/**
 * Check if invocation is allowed
 */
export async function checkSafety(
  request: ToolInvocationRequest,
  policy: InvocationPolicy = DEFAULT_POLICY
): Promise<SafetyCheckResult> {
  // Check if tool is blocked
  if (policy.blockedTools.includes(request.toolName)) {
    return {
      allowed: false,
      reason: `Tool '${request.toolName}' cannot be invoked recursively`,
    };
  }

  // Check if tool exists
  const tool = getToolByName(request.toolName);
  if (!tool) {
    return {
      allowed: false,
      reason: `Tool '${request.toolName}' not found`,
    };
  }

  // Check depth
  const context = contextStack.get(request.agentId);
  const currentDepth = context ? context.currentDepth + 1 : 1;

  if (currentDepth > policy.maxDepth) {
    return {
      allowed: false,
      reason: `Maximum invocation depth (${policy.maxDepth}) exceeded`,
      currentDepth,
    };
  }

  // Prevent invoke-tool/invoke-batch from being called recursively more than 2 levels deep
  // This allows: Agent -> invoke-tool -> SubAgent -> invoke-tool -> Tool
  // But prevents: Agent -> invoke-tool -> ... -> invoke-tool (depth 3+)
  if (
    (request.toolName === 'invoke-tool' || request.toolName === 'invoke-batch') &&
    currentDepth > 2
  ) {
    return {
      allowed: false,
      reason: `Recursive tool invocation limited to depth 2 (current: ${currentDepth})`,
      currentDepth,
    };
  }

  // Check rate limit
  const rateEntry = await getRateLimitEntry(request.agentId);
  const resetIn = RATE_LIMIT_WINDOW - (Date.now() - rateEntry.windowStart);

  if (rateEntry.count >= policy.maxInvocationsPerMinute) {
    return {
      allowed: false,
      reason: 'Rate limit exceeded',
      rateLimit: {
        current: rateEntry.count,
        max: policy.maxInvocationsPerMinute,
        resetIn,
      },
    };
  }

  const rateLimit = {
    current: rateEntry.count,
    max: policy.maxInvocationsPerMinute,
    resetIn,
  };

  // Check if approval required
  if (policy.requiresApproval.includes(request.toolName)) {
    return {
      allowed: true,
      requiresSupervisorApproval: true,
      currentDepth,
      rateLimit,
    };
  }

  return {
    allowed: true,
    currentDepth,
    rateLimit,
  };
}

/**
 * Invoke a tool
 */
export async function invokeTool(
  request: ToolInvocationRequest,
  policy: InvocationPolicy = DEFAULT_POLICY
): Promise<ToolInvocationResult> {
  const startTime = Date.now();
  const invocationId = request.invocationId || uuidv4();

  // Safety check
  const safety = await checkSafety(request, policy);

  if (!safety.allowed) {
    return {
      invocationId,
      success: false,
      error: safety.reason,
      duration: Date.now() - startTime,
      depth: safety.currentDepth || 0,
    };
  }

  if (safety.requiresSupervisorApproval) {
    // For now, we'll allow but log a warning
    Logger.warn(`invoke-tool: ${request.toolName} requires approval, proceeding anyway`);
  }

  const client = await tryGetRedis();
  let redisAvailable = !!client;

  // Save parent context before modification so it can be restored on error
  const parentContext = contextStack.get(request.agentId);

  try {
    // Atomic rate limit increment (works with Redis or in-memory fallback)
    try {
      await incrementRateLimit(request.agentId);
    } catch {
      redisAvailable = false;
      Logger.warn('invoke-tool: Rate limit update failed, continuing without persistence');
    }

    // Set up context with LRU eviction
    const context: InvocationContext = {
      rootInvocationId: parentContext?.rootInvocationId || invocationId,
      currentDepth: (parentContext?.currentDepth || 0) + 1,
      chain: [...(parentContext?.chain || []), invocationId],
      startTime,
    };

    // LRU eviction — delete oldest entry when at capacity
    if (contextStack.size >= MAX_CONTEXT_SIZE && !contextStack.has(request.agentId)) {
      const firstKey = contextStack.keys().next().value;
      if (firstKey) contextStack.delete(firstKey);
    }
    contextStack.set(request.agentId, context);

    // Store invocation data (skip if Redis unavailable)
    // Sanitize toolName to prevent log injection (CR/LF)
    if (client && redisAvailable) {
      try {
        const sanitizedToolName = request.toolName.replace(/[\n\r]/g, ' ');
        await client.setex(
          RECURSIVE_KEYS.invocation(invocationId),
          INVOCATION_TTL,
          JSON.stringify({
            ...request,
            toolName: sanitizedToolName,
            invocationId,
            depth: context.currentDepth,
            startTime,
          })
        );
      } catch {
        Logger.warn('invoke-tool: Redis invocation storage failed, continuing without persistence');
      }
    }

    // Get and execute tool
    const tool = getToolByName(request.toolName);
    if (!tool) {
      throw new Error(`Tool '${request.toolName}' not found`);
    }

    getGlobalEventBus().emit(
      'recursive:invocation:started',
      { toolName: request.toolName, depth: context.currentDepth, invocationId },
      { sessionId: request.sessionId || 'unknown', agentId: request.agentId, sourceModule: 'recursive' },
    );

    const result = await executeTool(request.toolName, request.args as ToolArguments);

    const duration = Date.now() - startTime;

    // Log invocation (best-effort)
    await logInvocation(request.agentId, {
      invocationId,
      toolName: request.toolName,
      success: true,
      duration,
      depth: context.currentDepth,
      timestamp: startTime,
    });

    // Restore parent context
    if (parentContext) {
      contextStack.set(request.agentId, parentContext);
    } else {
      contextStack.delete(request.agentId);
    }

    getGlobalEventBus().emit(
      'recursive:invocation:completed',
      { toolName: request.toolName, duration, depth: context.currentDepth, invocationId },
      { sessionId: request.sessionId || 'unknown', agentId: request.agentId, sourceModule: 'recursive' },
    );

    Logger.debug(
      `invoke-tool: ${request.toolName} completed in ${duration}ms at depth ${context.currentDepth}`
    );

    // Try to parse as JSON, otherwise return as string
    let parsedResult: unknown;
    try {
      parsedResult = JSON.parse(result);
    } catch {
      // Result is not JSON (e.g., ping returns plain text)
      parsedResult = result;
    }

    const invocationResult: ToolInvocationResult = {
      invocationId,
      success: true,
      result: parsedResult,
      duration,
      depth: context.currentDepth,
    };

    if (!redisAvailable) {
      invocationResult.warning = 'Redis unavailable - rate limiting and logging degraded';
    }

    return invocationResult;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const duration = Date.now() - startTime;

    getGlobalEventBus().emit(
      'recursive:invocation:failed',
      { toolName: request.toolName, error: errorMessage, duration, invocationId },
      { sessionId: request.sessionId || 'unknown', agentId: request.agentId, sourceModule: 'recursive' },
    );

    // Log failed invocation (best-effort, do not throw)
    try {
      await logInvocation(request.agentId, {
        invocationId,
        toolName: request.toolName,
        success: false,
        error: errorMessage,
        duration,
        depth: safety.currentDepth || 0,
        timestamp: startTime,
      });
    } catch {
      Logger.warn('invoke-tool: Failed to log invocation error to Redis');
    }

    // Restore parent context (same logic as success path)
    if (parentContext) {
      contextStack.set(request.agentId, parentContext);
    } else {
      contextStack.delete(request.agentId);
    }

    Logger.error(`invoke-tool error: ${errorMessage}`);

    return {
      invocationId,
      success: false,
      error: errorMessage,
      duration,
      depth: safety.currentDepth || 0,
    };
  }
}

/**
 * Invoke multiple tools in batch
 */
export async function invokeBatch(
  requests: ToolInvocationRequest[],
  policy: InvocationPolicy = DEFAULT_POLICY,
  parallel: boolean = true
): Promise<ToolInvocationResult[]> {
  if (parallel) {
    // Snapshot the current depth before launching parallel ops.
    // To avoid race conditions on the shared contextStack (all concurrent
    // invokeTool calls read/write the same agentId key), we give each
    // parallel operation a unique synthetic agentId so they don't interfere.
    // Reuse Map to reduce allocations
    batchContextCache.clear();
    for (const r of requests) {
      if (!batchContextCache.has(r.agentId)) {
        batchContextCache.set(r.agentId, contextStack.get(r.agentId));
      }
    }
    const results = await Promise.all(
      requests.map(async (r, idx) => {
        // Use a unique context key so parallel invocations don't race
        const isolatedAgentId = `${r.agentId}::batch-${idx}`;
        const base = batchContextCache.get(r.agentId);
        if (base) {
          contextStack.set(isolatedAgentId, { ...base });
        }
        try {
          const result = await invokeTool(
            { ...r, agentId: isolatedAgentId },
            policy
          );
          return result;
        } finally {
          contextStack.delete(isolatedAgentId);
        }
      })
    );
    // Restore original contexts after parallel batch completes
    for (const [agentId, ctx] of batchContextCache) {
      if (ctx) {
        contextStack.set(agentId, ctx);
      } else {
        contextStack.delete(agentId);
      }
    }
    return results;
  } else {
    const results: ToolInvocationResult[] = [];
    for (const request of requests) {
      const result = await invokeTool(request, policy);
      results.push(result);
      // Stop on first error if sequential
      if (!result.success) break;
    }
    return results;
  }
}

/**
 * Log an invocation
 */
async function logInvocation(
  agentId: string,
  entry: {
    invocationId: string;
    toolName: string;
    success: boolean;
    error?: string;
    duration: number;
    depth: number;
    timestamp: number;
  }
): Promise<void> {
  const client = await tryGetRedis();
  if (!client) {
    Logger.debug('invoke-tool: Redis unavailable, skipping invocation log');
    return;
  }

  const logKey = RECURSIVE_KEYS.log(agentId);

  // Sanitize to prevent log injection via CR/LF
  const sanitizedEntry = {
    ...entry,
    toolName: entry.toolName.replace(/[\n\r]/g, ' '),
    error: entry.error?.replace(/[\n\r]/g, ' '),
  };

  await client.lpush(logKey, JSON.stringify(sanitizedEntry));
  await client.ltrim(logKey, 0, MAX_LOG_ENTRIES - 1);
  await client.expire(logKey, INVOCATION_TTL);
}

/**
 * Get invocation log for an agent
 */
export async function getInvocationLog(
  agentId: string,
  limit: number = 20
): Promise<
  Array<{
    invocationId: string;
    toolName: string;
    success: boolean;
    error?: string;
    duration: number;
    depth: number;
    timestamp: number;
  }>
> {
  const client = await tryGetRedis();
  if (!client) {
    Logger.debug('invoke-tool: Redis unavailable, returning empty invocation log');
    return [];
  }

  const logKey = RECURSIVE_KEYS.log(agentId);

  const entries = await client.lrange(logKey, 0, limit - 1);
  return entries.map((e) => JSON.parse(e));
}

/**
 * Get current invocation context for an agent
 */
export function getCurrentContext(agentId: string): InvocationContext | null {
  return contextStack.get(agentId) || null;
}

/**
 * Clear invocation context (for cleanup)
 */
export function clearContext(agentId: string): void {
  contextStack.delete(agentId);
}
