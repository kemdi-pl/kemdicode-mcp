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
 * Tool Registry Module
 *
 * Centralized registry for all MCP tools. Handles tool registration,
 * schema conversion to JSON Schema, execution with validation, and
 * automatic context sharing to Redis.
 *
 * @module tools/registry
 */

import { Tool, Prompt } from '@modelcontextprotocol/sdk/types.js';
import { z, ZodError } from 'zod';
import { shareContext, isContextEnabled } from '../context/index.js';
import { Logger } from '../utils/logger.js';
import { McpError, InputValidationError, ToolExecutionError } from '../utils/errors.js';
import { recordToolExecution } from '../rl/middleware.js';
import type { BaseToolArguments } from '../types/tool-types.js';

/**
 * Type alias for tool arguments
 * Uses the strongly-typed BaseToolArguments from types module
 */
export type ToolArguments = BaseToolArguments;

/**
 * Sensitive argument keys that should be masked in logs
 */
const SENSITIVE_KEYS = new Set([
  'password',
  'token',
  'secret',
  'apiKey',
  'api_key',
  'apikey',
  'auth',
  'authorization',
  'credential',
  'credentials',
  'key',
  'privateKey',
  'private_key',
]);

/**
 * Mask sensitive keys for logging
 */
function maskSensitiveKeys(keys: string[]): string[] {
  return keys.map((k) => (SENSITIVE_KEYS.has(k.toLowerCase()) ? '[REDACTED]' : k));
}

/**
 * Mask sensitive data from stack traces before logging
 */
function maskStackTrace(stack: string | undefined): string | undefined {
  if (!stack) return undefined;
  // Remove potential secrets from stack trace
  return stack
    .replace(/password[=:]["']?[^"'\s]+["']?/gi, 'password=[REDACTED]')
    .replace(/token[=:]["']?[^"'\s]+["']?/gi, 'token=[REDACTED]')
    .replace(/apikey[=:]["']?[^"'\s]+["']?/gi, 'apiKey=[REDACTED]')
    .replace(/secret[=:]["']?[^"'\s]+["']?/gi, 'secret=[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/g, 'Bearer [REDACTED]');
}

// Re-export error types for tool implementations
export {
  McpError,
  InputValidationError,
  ToolExecutionError,
  TimeoutError,
  FileNotFoundError,
  PermissionError,
  CommandError,
  DangerousOperationError,
  formatErrorResponse,
  fromNodeError,
  errorToJsonString,
} from '../utils/errors.js';

/**
 * Generic Zod schema type
 * Using z.ZodTypeAny which is the proper Zod 4 type for any schema
 */
type ZodSchema = z.ZodTypeAny;

/**
 * Progress callback function type
 */
export type ProgressCallback = (output: string) => void;

/**
 * Tool executor function type
 * Uses ToolArguments by default for backward compatibility
 */
export type ToolExecutor<T = ToolArguments> = (
  args: T,
  onProgress?: ProgressCallback
) => Promise<string>;

/**
 * Unified tool interface for MCP tool registration
 *
 * When using the generic parameter (UnifiedTool<typeof schema>), the execute
 * function will receive properly typed arguments. Without the generic parameter,
 * args will be typed as ToolArguments for backward compatibility.
 *
 * @interface UnifiedTool
 * @template TSchema - Zod schema type for input validation (defaults to ZodSchema)
 *
 * @example
 * ```typescript
 * // Typed tool (recommended for new tools)
 * const schema = z.object({ files: z.string() });
 * const typedTool: UnifiedTool<typeof schema> = {
 *   name: 'my-tool',
 *   zodSchema: schema,
 *   execute: async (args) => args.files  // args.files is typed as string
 * };
 *
 * // Untyped tool (backward compatible)
 * const untypedTool: UnifiedTool = {
 *   name: 'old-tool',
 *   zodSchema: schema,
 *   execute: async (args) => String(args.files)  // args has ToolArguments type
 * };
 * ```
 */
export interface UnifiedTool<TSchema extends ZodSchema = ZodSchema> {
  /** Unique tool name (used in MCP protocol) */
  name: string;
  /** Human-readable tool description */
  description: string;
  /** Zod schema for input validation */
  zodSchema: TSchema;
  /** Optional prompt configuration for prompt-based invocation */
  prompt?: { description: string };
  /** Set to true to skip auto-sharing context for this tool */
  skipContextShare?: boolean;
  /**
   * Tool execution function
   * When TSchema is explicitly provided, args is typed as z.infer<TSchema>
   * Otherwise, args defaults to ToolArguments for backward compatibility
   */
  execute: TSchema extends ZodSchema
    ? ToolExecutor<
        z.infer<TSchema> extends infer U ? (unknown extends U ? ToolArguments : U) : ToolArguments
      >
    : ToolExecutor<ToolArguments>;
}

/**
 * Helper type to create a typed tool definition
 * This allows TypeScript to infer the argument type from the Zod schema
 *
 * @example
 * ```typescript
 * const mySchema = z.object({ files: z.string() });
 * type MyTool = TypedTool<typeof mySchema>;
 * // MyTool.execute receives { files: string } as first argument
 * ```
 */
export type TypedTool<TSchema extends ZodSchema> = UnifiedTool<TSchema>;

/**
 * Helper function to create a typed tool with proper type inference
 *
 * @description Creates a tool definition with full TypeScript type inference
 *              for the execute function's arguments based on the Zod schema
 * @param definition - Tool definition with Zod schema
 * @returns Typed UnifiedTool
 * @example
 * ```typescript
 * const myTool = createTypedTool({
 *   name: 'my-tool',
 *   description: 'My tool',
 *   zodSchema: z.object({ files: z.string() }),
 *   execute: async (args) => {
 *     // args.files is correctly typed as string
 *     return args.files;
 *   }
 * });
 * ```
 */
export function createTypedTool<TSchema extends ZodSchema>(
  definition: UnifiedTool<TSchema>
): UnifiedTool<TSchema> {
  return definition;
}

/**
 * Tool Registry Manager Class
 *
 * Encapsulates tool storage with controlled access methods.
 * Provides a singleton pattern for centralized tool management.
 *
 * @class ToolRegistryManager
 * @example
 * ```typescript
 * // Tools are registered via registerTool() function
 * registerTool(myTool);
 *
 * // Access tools via exported functions
 * const tools = getToolDefinitions();
 * ```
 */
class ToolRegistryManager {
  private readonly tools: UnifiedTool[] = [];

  /**
   * Register a new tool in the registry
   *
   * @description Adds a tool to the registry if it doesn't already exist.
   *              Duplicate tools (same name) are silently skipped with a warning.
   * @param {UnifiedTool} tool - The tool to register
   * @returns {void}
   * @example
   * ```typescript
   * registry.register({
   *   name: 'my-tool',
   *   description: 'My custom tool',
   *   zodSchema: z.object({ input: z.string() }),
   *   execute: async (args) => 'result'
   * });
   * ```
   */
  register(tool: UnifiedTool): void {
    if (this.exists(tool.name)) {
      Logger.warn(`Tool '${tool.name}' already registered, skipping duplicate`);
      return;
    }
    this.tools.push(tool);
  }

  /**
   * Check if a tool exists in the registry
   *
   * @description Searches the registry for a tool with the given name
   * @param {string} name - Tool name to check
   * @returns {boolean} True if tool exists, false otherwise
   */
  exists(name: string): boolean {
    return this.tools.some((t) => t.name === name);
  }

  /**
   * Find a tool by name
   *
   * @description Retrieves a tool from the registry by its unique name
   * @param {string} name - Tool name to find
   * @returns {UnifiedTool | undefined} The tool if found, undefined otherwise
   */
  find(name: string): UnifiedTool | undefined {
    return this.tools.find((t) => t.name === name);
  }

  /**
   * Get all registered tools
   *
   * @description Returns a readonly array of all registered tools
   * @returns {readonly UnifiedTool[]} Readonly array of all tools
   */
  getAll(): readonly UnifiedTool[] {
    return this.tools;
  }

  /**
   * Get tools with prompt support
   *
   * @description Filters and returns only tools that have prompt configuration
   * @returns {readonly UnifiedTool[]} Readonly array of tools with prompt support
   */
  getWithPrompts(): readonly UnifiedTool[] {
    return this.tools.filter((t) => t.prompt);
  }

  /**
   * Get the total number of registered tools
   *
   * @description Returns the count of tools in the registry
   * @returns {number} Number of registered tools
   */
  get count(): number {
    return this.tools.length;
  }
}

/** Singleton tool registry instance */
const registryManager = new ToolRegistryManager();

/**
 * @deprecated Use registryManager methods instead. Kept for backward compatibility.
 * @description Direct access to the tool registry array
 */
export const toolRegistry: readonly UnifiedTool[] = registryManager.getAll();

/**
 * Register a tool in the registry
 *
 * @description Adds a new tool to the central registry. This is the primary
 *              way to register tools during server initialization.
 * @param {UnifiedTool} tool - The tool to register
 * @returns {void}
 * @example
 * ```typescript
 * import { registerTool } from './registry.js';
 * import { myCustomTool } from './my-tool.js';
 *
 * registerTool(myCustomTool);
 * ```
 */
export const registerTool = (tool: UnifiedTool): void => registryManager.register(tool);

/**
 * Check if a tool exists in the registry
 *
 * @description Checks whether a tool with the given name is already registered
 * @param {string} name - Tool name to check
 * @returns {boolean} True if tool exists, false otherwise
 * @example
 * ```typescript
 * if (toolExists('code-review')) {
 *   console.log('Code review tool is available');
 * }
 * ```
 */
export const toolExists = (name: string): boolean => registryManager.exists(name);

/**
 * Get a tool by name from the registry
 *
 * @description Retrieves a tool definition by its unique name
 * @param {string} name - Tool name to find
 * @returns {UnifiedTool | undefined} The tool if found, undefined otherwise
 * @example
 * ```typescript
 * const tool = getToolByName('code-review');
 * if (tool) {
 *   console.log(tool.description);
 * }
 * ```
 */
export const getToolByName = (name: string): UnifiedTool | undefined => registryManager.find(name);

/**
 * Internal tool names that should skip context sharing
 * @enum {string}
 */
export enum InternalToolName {
  PING = 'ping',
  HELP = 'help',
  TIMEOUT_TEST = 'timeout-test',
  GET_SHARED_CONTEXT = 'get-shared-context',
  AGENT_LIST = 'agent-list',
  AGENT_REGISTER = 'agent-register',
  AGENT_WATCH = 'agent-watch',
  AGENT_ALERT = 'agent-alert',
  AGENT_INJECT = 'agent-inject',
  AGENT_HISTORY = 'agent-history',
}

/** Tools that should not auto-share their results */
const SKIP_SHARE_TOOLS: ReadonlySet<string> = new Set([
  InternalToolName.PING,
  InternalToolName.HELP,
  InternalToolName.TIMEOUT_TEST,
  InternalToolName.GET_SHARED_CONTEXT, // Avoid recursive context
  // Agent monitoring tools (internal)
  InternalToolName.AGENT_LIST,
  InternalToolName.AGENT_REGISTER,
  InternalToolName.AGENT_WATCH,
  InternalToolName.AGENT_ALERT,
  InternalToolName.AGENT_INJECT,
  InternalToolName.AGENT_HISTORY,
]);

/**
 * Schema shape returned by Zod's toJSONSchema
 * @interface JsonSchemaShape
 */
interface JsonSchemaShape {
  /** Object properties mapping */
  properties?: Record<string, object>;
  /** Array of required property names */
  required?: string[];
}

/**
 * Validate that an object conforms to JsonSchemaShape
 *
 * @description Type guard to verify an unknown object matches the expected
 *              JSON Schema structure with optional properties and required arrays
 * @param {unknown} obj - Object to validate
 * @returns {boolean} True if object is a valid JsonSchemaShape
 */
function isJsonSchemaShape(obj: unknown): obj is JsonSchemaShape {
  if (typeof obj !== 'object' || obj === null) return false;
  const schema = obj as Record<string, unknown>;
  const hasValidProperties =
    schema.properties === undefined ||
    (typeof schema.properties === 'object' && schema.properties !== null);
  const hasValidRequired =
    schema.required === undefined ||
    (Array.isArray(schema.required) && schema.required.every((r) => typeof r === 'string'));
  return hasValidProperties && hasValidRequired;
}

/**
 * Get MCP tool definitions for protocol registration
 *
 * @description Converts all registered tools to MCP Tool format by transforming
 *              Zod schemas to JSON Schema format. Used during server initialization
 *              to expose available tools to MCP clients.
 * @returns {Tool[]} Array of MCP Tool definitions with inputSchema
 * @example
 * ```typescript
 * const tools = getToolDefinitions();
 * // Returns: [{ name: 'code-review', description: '...', inputSchema: {...} }, ...]
 * ```
 */
export function getToolDefinitions(): Tool[] {
  return toolRegistry.map((tool) => {
    // Use native Zod 4 toJSONSchema with runtime validation
    const rawSchema = z.toJSONSchema(tool.zodSchema, { target: 'draft-07' });

    if (!isJsonSchemaShape(rawSchema)) {
      Logger.warn(`Invalid schema shape for tool '${tool.name}', using empty schema`);
      return {
        name: tool.name,
        description: tool.description,
        inputSchema: { type: 'object' as const, properties: {}, required: [] },
      };
    }

    return {
      name: tool.name,
      description: tool.description,
      inputSchema: {
        type: 'object' as const,
        properties: rawSchema.properties || {},
        required: rawSchema.required || [],
      },
    };
  });
}

/**
 * Get MCP prompt definitions for tools with prompt support
 *
 * @description Filters tools that have prompt configuration and returns them
 *              as MCP Prompt definitions. Used for prompt-based tool invocation.
 * @returns {Prompt[]} Array of MCP Prompt definitions with name and description
 * @example
 * ```typescript
 * const prompts = getPromptDefinitions();
 * // Returns: [{ name: 'plan', description: 'Structured analysis mode' }, ...]
 * ```
 */
export function getPromptDefinitions(): Prompt[] {
  return toolRegistry
    .filter((t) => t.prompt)
    .map((t) => ({ name: t.name, description: t.prompt!.description }));
}

/**
 * Execute a tool by name with validated arguments
 *
 * @description Main entry point for tool execution. Validates arguments against
 *              the tool's Zod schema, executes the tool, and automatically shares
 *              results to Redis context for cross-server collaboration.
 * @param {string} name - Tool name to execute (must match registered tool name)
 * @param {ToolArguments} args - Tool arguments (will be validated against Zod schema)
 * @param {Function} [onProgress] - Optional callback for streaming output during execution
 * @returns {Promise<string>} Tool execution result as a string
 * @throws {Error} If tool not found (Unknown tool: {name})
 * @throws {Error} If arguments fail Zod validation (Invalid arguments: {details})
 * @example
 * ```typescript
 * const result = await executeTool('code-review', {
 *   files: '@src/index.ts',
 *   focus: 'security'
 * }, (output) => console.log(output));
 * ```
 */
export async function executeTool(
  name: string,
  args: ToolArguments,
  onProgress?: (output: string) => void
): Promise<string> {
  const tool = toolRegistry.find((t) => t.name === name);
  if (!tool)
    throw new ToolExecutionError(name, `Unknown tool: ${name}`, {
      availableTools: toolRegistry.map((t) => t.name).slice(0, 10),
    });

  // Start timing and log tool execution start
  const startTime = Date.now();
  Logger.toolExecution('start', name, undefined, {
    argsKeys: maskSensitiveKeys(Object.keys(args)),
    hasProgress: !!onProgress,
  });

  let result: string;
  let isError = false;

  try {
    // Validate arguments against schema
    const validatedArgs = tool.zodSchema.parse(args) as ToolArguments;
    Logger.debug(() => `Tool ${name}: arguments validated`, { tool: name });

    result = await tool.execute(validatedArgs, onProgress);

    // Log successful completion with timing
    const duration = Date.now() - startTime;
    Logger.toolExecution('end', name, duration, {
      resultLength: result.length,
      success: true,
    });

    // RL tracking (async, fire-and-forget — never blocks response)
    recordToolExecution(name, args as Record<string, unknown>, true, duration).catch(() => {});
  } catch (error) {
    isError = true;
    const duration = Date.now() - startTime;

    // RL tracking for failures (fire-and-forget)
    recordToolExecution(name, args as Record<string, unknown>, false, duration).catch(() => {});

    // Handle Zod validation errors
    if (error instanceof ZodError) {
      Logger.toolExecution('error', name, duration, {
        errorType: 'validation',
        issues: error.issues.length,
      });
      throw InputValidationError.fromZodIssues(error.issues);
    }

    // Re-throw McpError subclasses as-is (they already have proper context)
    if (error instanceof McpError) {
      // Add tool name to context if not already present
      if (!error.context.toolName) {
        error.context.toolName = name;
      }
      Logger.toolExecution('error', name, duration, {
        errorType: error.code,
        errorMessage: error.message,
      });
      throw error;
    }

    // Wrap unknown errors in ToolExecutionError
    if (error instanceof Error) {
      Logger.toolExecution('error', name, duration, {
        errorType: 'unknown',
        errorMessage: error.message,
      });
      throw new ToolExecutionError(name, error.message, {}, error);
    }

    // Handle non-Error throws
    Logger.toolExecution('error', name, duration, {
      errorType: 'non-error',
      errorValue: String(error),
    });
    throw new ToolExecutionError(name, String(error));
  }

  // Auto-share context (async, don't block response)
  if (isContextEnabled() && !tool.skipContextShare && !SKIP_SHARE_TOOLS.has(name)) {
    shareContext(name, args as Record<string, unknown>, result, {
      errorState: isError,
    }).catch((err: unknown) => {
      // Log with full context for debugging
      const errorMessage = err instanceof Error ? err.message : String(err);
      const errorStack = err instanceof Error ? err.stack : undefined;

      // Use error level for connection issues, warn for others
      const isConnectionError =
        errorMessage.includes('ECONNREFUSED') || errorMessage.includes('ETIMEDOUT');

      if (isConnectionError) {
        Logger.error(
          `Context sharing failed for ${name} (Redis connection issue): ${errorMessage}`
        );
      } else {
        Logger.warn(`Context sharing failed for ${name}: ${errorMessage}`, {
          tool: name,
          error: errorMessage,
          stack: maskStackTrace(errorStack),
        });
      }
    });
  }

  return result;
}

/**
 * Generate a human-readable prompt message for a tool invocation
 *
 * @description Creates a formatted string representing a tool invocation with
 *              its parameters. Used for logging and prompt-based tool usage.
 * @param {string} name - Tool name
 * @param {Record<string, unknown>} args - Tool arguments
 * @returns {string} Formatted prompt message (e.g., "Use code-review tool: (files: @src/index.ts) [verbose]")
 * @throws {Error} If tool has no prompt configuration (No prompt for: {name})
 * @example
 * ```typescript
 * const message = getPromptMessage('code-review', { files: '@src/index.ts', verbose: true });
 * // Returns: "Use code-review tool: (files: @src/index.ts) [verbose]"
 * ```
 */
export function getPromptMessage(name: string, args: Record<string, unknown>): string {
  const tool = toolRegistry.find((t) => t.name === name);
  if (!tool?.prompt) throw new Error(`No prompt for: ${name}`);

  const params = Object.entries(args)
    .filter(([, v]) => v !== undefined && v !== null && v !== false)
    .map(([k, v]) => (typeof v === 'boolean' ? `[${k}]` : `(${k}: ${v})`))
    .join(' ');

  return `Use ${name} tool${params ? ': ' + params : ''}`;
}
