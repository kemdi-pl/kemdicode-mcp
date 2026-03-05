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
 * Recursive Tool Types
 *
 * TypeScript interfaces for recursive tool invocation system.
 *
 * @module recursive/types
 */

/** Tool invocation request */
export interface ToolInvocationRequest {
  invocationId: string;
  agentId: string;
  sessionId: string;
  toolName: string;
  args: Record<string, unknown>;
  parentInvocationId?: string;
  reason?: string;
  timestamp: number;
}

/** Tool invocation result */
export interface ToolInvocationResult {
  invocationId: string;
  success: boolean;
  result?: unknown;
  error?: string;
  warning?: string;
  duration: number;
  depth: number;
}

/** Invocation policy */
export interface InvocationPolicy {
  /** Maximum nesting depth (default: 5) */
  maxDepth: number;
  /** Max invocations per minute per agent */
  maxInvocationsPerMinute: number;
  /** Tools requiring supervisor approval */
  requiresApproval: string[];
  /** Blocked tools (cannot be invoked recursively) */
  blockedTools: string[];
  /** Whether workers can invoke tools */
  allowWorkerInvocation: boolean;
}

/**
 * Read an integer from environment variable with a fallback default.
 */
function envInt(key: string, fallback: number): number {
  const val = process.env[key];
  if (val !== undefined) {
    const parsed = parseInt(val, 10);
    if (!isNaN(parsed)) return parsed;
  }
  return fallback;
}

/**
 * Default policy for recursive tool invocation.
 *
 * All numeric limits can be overridden via environment variables:
 *   - MCP_INVOKE_MAX_DEPTH (default: 5)
 *   - MCP_INVOKE_RATE_LIMIT (default: 30 per minute)
 *
 * @description Allows multi-level agent invocation with safety limits:
 *   - Agent -> invoke-tool -> Tool (depth 1) ✅
 *   - Agent -> invoke-tool -> invoke-tool -> Tool (depth 2) ✅
 *   - Deeper recursive invoke-tool chains are blocked in tool-invoker.ts
 */
export const DEFAULT_POLICY: InvocationPolicy = {
  maxDepth: envInt('MCP_INVOKE_MAX_DEPTH', 5),
  maxInvocationsPerMinute: envInt('MCP_INVOKE_RATE_LIMIT', 30),
  requiresApproval: ['file-write'],
  blockedTools: [],
  allowWorkerInvocation: true,
};

/** Safety check result */
export interface SafetyCheckResult {
  allowed: boolean;
  reason?: string;
  requiresSupervisorApproval?: boolean;
  currentDepth?: number;
  rateLimit?: {
    current: number;
    max: number;
    resetIn: number;
  };
}

/** Invocation context (tracks call chain) */
export interface InvocationContext {
  rootInvocationId: string;
  currentDepth: number;
  chain: string[]; // invocation IDs from root to current
  startTime: number;
}

/** Rate limit entry */
export interface RateLimitEntry {
  count: number;
  windowStart: number;
}

/** Redis key prefixes */
export const RECURSIVE_KEYS = {
  /** Invocation data - mcp:invoke:{invocationId} */
  invocation: (id: string) => `mcp:invoke:${id}`,
  /** Agent rate limit - mcp:invoke:rate:{agentId} */
  rateLimit: (agentId: string) => `mcp:invoke:rate:${agentId}`,
  /** Invocation chain - mcp:invoke:chain:{rootId} */
  chain: (rootId: string) => `mcp:invoke:chain:${rootId}`,
  /** Agent invocation log - mcp:invoke:log:{agentId} */
  log: (agentId: string) => `mcp:invoke:log:${agentId}`,
};

/** Invocation TTL in seconds (env: MCP_INVOKE_TTL, default: 3600 = 1 hour) */
export const INVOCATION_TTL = envInt('MCP_INVOKE_TTL', 3600);

/** Rate limit window in ms (env: MCP_INVOKE_RATE_WINDOW, default: 60000 = 1 minute) */
export const RATE_LIMIT_WINDOW = envInt('MCP_INVOKE_RATE_WINDOW', 60_000);

/** Max log entries per agent (env: MCP_INVOKE_MAX_LOG, default: 100) */
export const MAX_LOG_ENTRIES = envInt('MCP_INVOKE_MAX_LOG', 100);
