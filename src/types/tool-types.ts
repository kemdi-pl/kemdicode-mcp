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
 * Shared Tool Argument Types
 *
 * Provides strongly-typed interfaces for tool arguments,
 * replacing loose Record<string, unknown> with specific types.
 *
 * @module types/tool-types
 */

import { z } from 'zod';

/**
 * Base tool argument value types
 * These are the primitive types that can be passed as tool arguments
 */
export type ToolArgumentValue = string | number | boolean | undefined | null;

/**
 * Complex tool argument types (arrays and objects)
 */
export type ToolArgumentComplex =
  | ToolArgumentValue
  | ToolArgumentValue[]
  | Record<string, ToolArgumentValue>
  | Record<string, ToolArgumentValue>[];

/**
 * Base interface for all tool arguments
 * Extends this for specific tool argument types
 */
export interface BaseToolArguments {
  /** Optional prompt text */
  prompt?: string;
  /** Optional model override */
  model?: string;
  /** Optional agent type */
  agent?: string;
  /** Optional file paths */
  files?: string;
  /** Optional current working directory */
  cwd?: string;
  /** Allow any other string keys with specific value types */
  [key: string]: ToolArgumentComplex;
}

/**
 * KemdiCode-specific tool arguments
 */
export interface KemdiCodeToolArguments extends BaseToolArguments {
  prompt: string;
  model?: string;
  agent?: 'plan' | 'build' | 'explore' | 'general';
  files?: string;
  continueSession?: boolean;
  sessionId?: string;
}

/**
 * Batch operation tool arguments
 */
export interface BatchOperationArguments {
  tool: string;
  args: Record<string, unknown>;
  id?: string;
}

export interface BatchToolArguments {
  operations: BatchOperationArguments[];
  parallel?: boolean;
  stopOnError?: boolean;
}

/**
 * Agent tool arguments
 */
export interface AgentRegisterArguments {
  name: string;
  role: 'supervisor' | 'worker' | 'specialist' | 'coordinator';
  sessionId: string;
  serverId?: string;
  model?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentInjectArguments {
  agentId: string;
  sessionId: string;
  type: 'context' | 'directive' | 'query';
  content: string;
  data?: Record<string, unknown>;
}

export interface AgentAlertArguments {
  agentIds: string;
  message: string;
  source?: string;
  priority?: 'low' | 'normal' | 'high' | 'critical';
  interrupt?: boolean;
}

export interface AgentHistoryArguments {
  sessionId?: string;
  agentId?: string;
  type?: 'all' | 'alert' | 'message' | 'status';
  limit?: number;
}

/**
 * Context tool arguments
 */
export interface SharedThoughtsArguments {
  scope?: 'all' | 'kemdicode' | 'external' | 'analysis' | 'code';
  limit?: number;
  format?: 'detailed' | 'summary' | 'timeline';
  includeOutput?: boolean;
}

export interface GetSharedContextArguments {
  serverId?: string;
  toolName?: string;
  limit?: number;
}

/**
 * Discriminated union for tool results
 */
export interface ToolSuccessResult {
  success: true;
  data: unknown;
  message?: string;
}

export interface ToolErrorResult {
  success: false;
  error: string;
  code?: string;
  details?: unknown;
}

export type ToolResult = ToolSuccessResult | ToolErrorResult;

/**
 * Type guard for successful results
 */
export function isToolSuccess(result: ToolResult): result is ToolSuccessResult {
  return result.success === true;
}

/**
 * Type guard for error results
 */
export function isToolError(result: ToolResult): result is ToolErrorResult {
  return result.success === false;
}

/**
 * Helper type to infer argument type from Zod schema
 */
export type InferToolArgs<T extends z.ZodTypeAny> = z.infer<T>;

/**
 * Generic typed tool executor function signature
 */
export type TypedToolExecutor<TArgs, TResult = string> = (
  args: TArgs,
  onProgress?: (output: string) => void
) => Promise<TResult>;
