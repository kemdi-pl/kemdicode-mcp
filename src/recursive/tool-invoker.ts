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

/** Current invocation context (per-request) */
const contextStack = new Map<string, InvocationContext>();

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
 * Read and normalize rate limit entry from Redis.
 * Resets the window if expired.
 * Returns default entry if Redis is unavailable.
 */
async function getRateLimitEntry(agentId: string): Promise<RateLimitEntry> {
  const client = await tryGetRedis();
  if (!client) {
    return { count: 0, windowStart: Date.now() };
  }

  const rateLimitKey = RECURSIVE_KEYS.rateLimit(agentId);
  const data = await client.get(rateLimitKey);

  let entry: RateLimitEntry = { count: 0, windowStart: Date.now() };
  if (data) {
    entry = JSON.parse(data);
    if (Date.now() - entry.windowStart > RATE_LIMIT_WINDOW) {
      entry = { count: 0, windowStart: Date.now() };
    }
  }
  return entry;
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

  try {
    // Update rate limit (skip if Redis unavailable)
    if (client) {
      try {
        const rateEntry = await getRateLimitEntry(request.agentId);
        rateEntry.count++;
        const rateLimitKey = RECURSIVE_KEYS.rateLimit(request.agentId);
        await client.setex(rateLimitKey, 120, JSON.stringify(rateEntry));
      } catch {
        redisAvailable = false;
        Logger.warn('invoke-tool: Redis rate limit update failed, continuing without persistence');
      }
    }

    // Set up context
    const parentContext = contextStack.get(request.agentId);
    const context: InvocationContext = {
      rootInvocationId: parentContext?.rootInvocationId || invocationId,
      currentDepth: (parentContext?.currentDepth || 0) + 1,
      chain: [...(parentContext?.chain || []), invocationId],
      startTime,
    };

    contextStack.set(request.agentId, context);

    // Store invocation data (skip if Redis unavailable)
    if (client && redisAvailable) {
      try {
        await client.setex(
          RECURSIVE_KEYS.invocation(invocationId),
          INVOCATION_TTL,
          JSON.stringify({
            ...request,
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

    // Restore context
    const parentContext = contextStack.get(request.agentId);
    if (parentContext && parentContext.currentDepth > 0) {
      contextStack.set(request.agentId, {
        ...parentContext,
        currentDepth: parentContext.currentDepth - 1,
      });
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
    // Snapshot the current depth before launching parallel ops so each
    // operation starts from the same base depth instead of seeing an
    // incrementing depth caused by shared contextStack mutation.
    const baseContexts = new Map<string, InvocationContext | undefined>();
    for (const r of requests) {
      if (!baseContexts.has(r.agentId)) {
        baseContexts.set(r.agentId, contextStack.get(r.agentId));
      }
    }
    const results = await Promise.all(
      requests.map(async (r) => {
        // Reset to the snapshot before each parallel invocation
        const base = baseContexts.get(r.agentId);
        if (base) {
          contextStack.set(r.agentId, { ...base });
        } else {
          contextStack.delete(r.agentId);
        }
        return invokeTool(r, policy);
      })
    );
    // Restore original contexts after parallel batch completes
    for (const [agentId, ctx] of baseContexts) {
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

  await client.lpush(logKey, JSON.stringify(entry));
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
