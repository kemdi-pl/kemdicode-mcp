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
 * Default policy for recursive tool invocation
 *
 * @description Allows multi-level agent invocation with safety limits:
 *   - Agent -> invoke-tool -> Tool (depth 1) ✅
 *   - Agent -> invoke-tool -> invoke-tool -> Tool (depth 2) ✅
 *   - Deeper recursive invoke-tool chains are blocked in tool-invoker.ts
 *   - Overall max depth: 5 (for any tool)
 *   - Rate limit: 30 invocations/min per agent
 */
export const DEFAULT_POLICY: InvocationPolicy = {
  maxDepth: 5,
  maxInvocationsPerMinute: 30,
  requiresApproval: ['shell-exec', 'file-write'],
  blockedTools: [], // Recursive invoke-tool limited to depth 2 in tool-invoker.ts
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

/** Invocation TTL (1 hour) */
export const INVOCATION_TTL = 60 * 60;

/** Rate limit window (1 minute) */
export const RATE_LIMIT_WINDOW = 60 * 1000;

/** Max log entries per agent */
export const MAX_LOG_ENTRIES = 100;
