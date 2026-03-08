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
import { formatDirectivesPrefix } from '../kanban/directive-store.js';
import { Logger } from '../utils/logger.js';
import { isSilent } from '../config/silent.js';
import { McpError, InputValidationError, ToolExecutionError } from '../utils/errors.js';
import { recordToolExecution } from './tool-tracking.js';
import type { BaseToolArguments } from '../types/tool-types.js';
import { getAvailabilityChecker, type AIRequirementConfig } from './availability-checker.js';
import { getToolAnnotations } from './annotations-map.js';

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
 * Deep-clone args and replace sensitive values with [REDACTED]
 * to prevent leaking tokens/passwords/secrets to logs and tracking.
 */
function redactSensitiveArgs(args: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) {
      redacted[key] = '[REDACTED]';
    } else if (Array.isArray(value)) {
      redacted[key] = value.map((item) =>
        typeof item === 'object' && item !== null
          ? redactSensitiveArgs(item as Record<string, unknown>)
          : item
      );
    } else if (typeof value === 'object' && value !== null) {
      redacted[key] = redactSensitiveArgs(value as Record<string, unknown>);
    } else {
      redacted[key] = value;
    }
  }
  return redacted;
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
/** Tool category for discovery and grouping */
export type ToolCategory =
  | 'code'
  | 'edit'
  | 'file'
  | 'git'
  | 'kanban'
  | 'context'
  | 'agents'
  | 'project'
  | 'system'
  | 'specialized'
  | 'recursive'
  | 'multi-llm'
  | 'memory'
  | 'loci'
  | 'session'
  | 'thinking'
  | 'cognition'
  | 'client'
  | 'cluster-bus';

/**
 * MCP Tool Annotations (Protocol-level hints for LLM safety awareness)
 * See: https://modelcontextprotocol.io/docs/concepts/tools#annotations
 */
export interface ToolAnnotations {
  /** Human-readable title shown in UI */
  title?: string;
  /** Hint: this tool only reads data, does not modify state */
  readOnlyHint?: boolean;
  /** Hint: this tool may perform destructive operations (delete, overwrite) */
  destructiveHint?: boolean;
  /** Hint: this tool may perform operations that are not reversible */
  idempotentHint?: boolean;
  /** Hint: this tool interacts with external services outside the local environment */
  openWorldHint?: boolean;
}

/** Tool metadata for discovery, categorization and search */
export interface ToolMetadata {
  /** Tool category for grouping */
  category: ToolCategory;
  /** Searchable tags */
  tags?: string[];
  /** Whether this tool is long-running (useful for progress reporting) */
  longRunning?: boolean;
  /** Example usage for discovery */
  examples?: Array<{ args: Record<string, unknown>; description: string }>;
  /** Related tools that are commonly used together */
  relatedTools?: string[];
  /** AI requirement: true = any provider, object = specific requirements */
  aiRequired?: AIRequirementConfig;
  /** Availability check mode override for this tool (soft=guidance, force=block) */
  availabilityMode?: 'soft' | 'force';
  /** AI routing strategy: local, external, or hybrid */
  aiRouting?: 'local' | 'external' | 'hybrid';
  /** MCP protocol-level annotations for safety hints */
  annotations?: ToolAnnotations;
}

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
  /** Tool metadata for discovery and categorization */
  metadata?: ToolMetadata;
  /** MCP-level annotations (shortcut - also available via metadata.annotations) */
  annotations?: ToolAnnotations;
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
 * Lazy tool loader entry
 * Stores metadata and a loader function for deferred tool loading
 */
export interface LazyToolEntry {
  /** Tool name (unique identifier) */
  name: string;
  /** Tool description (shown in ListTools) */
  description: string;
  /** Lazy loader function that imports and returns the tool */
  loader: () => Promise<UnifiedTool>;
  /** Whether the tool has been loaded yet */
  loaded: boolean;
  /** Cached tool instance (populated after first load) */
  tool?: UnifiedTool;
  /** MCP-level annotations (available before tool is loaded) */
  annotations?: ToolAnnotations;
}

/**
 * Tool Registry Manager Class
 *
 * Encapsulates tool storage with controlled access methods.
 * Provides a singleton pattern for centralized tool management.
 * Supports both eager and lazy tool registration for optimized startup.
 *
 * @class ToolRegistryManager
 * @example
 * ```typescript
 * // Tools are registered via registerTool() or registerLazyTool() functions
 * registerTool(myTool);
 * registerLazyTool({ name: 'my-tool', description: '...', loader: () => import('...') });
 *
 * // Access tools via exported functions
 * const tools = getToolDefinitions();
 * ```
 */
class ToolRegistryManager {
  private readonly tools: UnifiedTool[] = [];
  private readonly lazyTools = new Map<string, LazyToolEntry>();

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
   * Register a lazy-loaded tool
   *
   * @description Registers tool metadata without loading the full module.
   *              The tool will be loaded on first execution.
   * @param {LazyToolEntry} entry - Lazy tool registration entry
   * @returns {void}
   */
  registerLazy(entry: Omit<LazyToolEntry, 'loaded' | 'tool'>): void {
    if (this.exists(entry.name)) {
      Logger.warn(`Tool '${entry.name}' already registered, skipping duplicate`);
      return;
    }
    this.lazyTools.set(entry.name, { ...entry, loaded: false });
  }

  /**
   * Load a lazy tool if not already loaded
   *
   * @description Executes the loader function and caches the result
   * @param {string} name - Tool name to load
   * @returns {Promise<UnifiedTool>} The loaded tool
   * @throws {Error} If tool is not found in lazy registry
   */
  async loadLazy(name: string): Promise<UnifiedTool> {
    const entry = this.lazyTools.get(name);
    if (!entry) {
      throw new Error(`Lazy tool '${name}' not found in registry`);
    }

    if (!entry.loaded) {
      const tool = await entry.loader();
      entry.tool = tool;
      entry.loaded = true;

      // Cache JSON schema for ListTools
      if (!schemaCache.has(name) && tool.zodSchema) {
        try {
          const rawSchema = z.toJSONSchema(tool.zodSchema, { target: 'draft-07' });
          if (isJsonSchemaShape(rawSchema)) {
            schemaCache.set(name, toMcpInputSchema(rawSchema));
          }
        } catch (err) {
          Logger.warn(`Schema generation failed for '${name}': ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // Invalidate tool definitions cache so next ListTools picks up real schema
      toolDefinitionsCache = null;

      Logger.debug(`Lazy-loaded tool: ${name}`);
    }

    return entry.tool!;
  }

  /**
   * Get all lazy tool names for background schema warmup
   */
  getLazyToolNames(): string[] {
    return Array.from(this.lazyTools.keys());
  }

  /**
   * Check if a tool exists in the registry
   *
   * @description Searches both eager and lazy registries for a tool with the given name
   * @param {string} name - Tool name to check
   * @returns {boolean} True if tool exists, false otherwise
   */
  exists(name: string): boolean {
    return this.tools.some((t) => t.name === name) || this.lazyTools.has(name);
  }

  /**
   * Find a tool by name (async for lazy loading)
   *
   * @description Retrieves a tool from the registry by its unique name.
   *              If the tool is lazy-loaded, it will be loaded on first access.
   * @param {string} name - Tool name to find
   * @returns {Promise<UnifiedTool | undefined>} The tool if found, undefined otherwise
   */
  async findAsync(name: string): Promise<UnifiedTool | undefined> {
    // Check eager tools first
    const eagerTool = this.tools.find((t) => t.name === name);
    if (eagerTool) return eagerTool;

    // Check lazy tools
    if (this.lazyTools.has(name)) {
      return await this.loadLazy(name);
    }

    return undefined;
  }

  /**
   * Find a tool by name (synchronous, for backward compatibility)
   *
   * @description Retrieves a tool from eager registry only.
   *              For lazy tools, returns undefined. Use findAsync instead.
   * @param {string} name - Tool name to find
   * @returns {UnifiedTool | undefined} The tool if found, undefined otherwise
   * @deprecated Use findAsync for full support including lazy tools
   */
  find(name: string): UnifiedTool | undefined {
    return this.tools.find((t) => t.name === name);
  }

  /**
   * Get all registered tools (eager only)
   *
   * @description Returns a readonly array of eagerly loaded tools only.
   *              Lazy tools are not included until they are loaded.
   * @returns {readonly UnifiedTool[]} Readonly array of all tools
   */
  getAll(): readonly UnifiedTool[] {
    return this.tools;
  }

  /**
   * Get all tool metadata (both eager and lazy)
   *
   * @description Returns metadata for all registered tools without loading lazy ones.
   *              Useful for ListTools MCP call.
   * @returns {Array<{ name: string; description: string }>} Array of tool metadata
   */
  getAllMetadata(): Array<{ name: string; description: string }> {
    const eager = this.tools.map((t) => ({ name: t.name, description: t.description }));
    const lazy = Array.from(this.lazyTools.values()).map((e) => ({
      name: e.name,
      description: e.description,
    }));
    return [...eager, ...lazy];
  }

  /**
   * Search tools by category, tag, or name substring
   */
  search(query: { category?: ToolCategory; tag?: string; name?: string }): readonly UnifiedTool[] {
    return this.tools.filter((tool) => {
      if (query.category && tool.metadata?.category !== query.category) return false;
      if (query.tag && !tool.metadata?.tags?.includes(query.tag)) return false;
      if (query.name && !tool.name.includes(query.name)) return false;
      return true;
    });
  }

  /**
   * Get all unique categories from registered tools
   */
  getCategories(): ToolCategory[] {
    const categories = new Set<ToolCategory>();
    for (const tool of this.tools) {
      if (tool.metadata?.category) categories.add(tool.metadata.category);
    }
    return Array.from(categories);
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
 * Get all registered tools.
 * @returns Readonly array of all registered UnifiedTool instances
 */
export function getAllTools(): readonly UnifiedTool[] {
  return registryManager.getAll();
}

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
/**
 * Notify connected MCP clients that the tool list has changed.
 * Lazy-imported to avoid circular dependency with server module.
 */
let broadcastToolsChanged: (() => Promise<void>) | null = null;

export const registerTool = (tool: UnifiedTool): void => {
  const isNew = !registryManager.exists(tool.name);
  registryManager.register(tool);

  // Invalidate tool definitions cache on new registration
  if (isNew) {
    invalidateToolDefinitionsCache();

    // Broadcast to connected clients if this is a newly registered tool (not during startup)
    if (broadcastToolsChanged) {
      broadcastToolsChanged().catch((err: unknown) => {
        Logger.warn(`Failed to broadcast tools/list_changed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
  }
};

/**
 * Register a lazy-loaded tool in the registry
 *
 * @description Registers tool metadata for lazy loading. The actual tool module
 *              will only be loaded when the tool is first executed.
 * @param {Omit<LazyToolEntry, 'loaded' | 'tool'>} entry - Lazy tool registration entry
 * @returns {void}
 * @example
 * ```typescript
 * registerLazyTool({
 *   name: 'my-tool',
 *   description: 'My lazy-loaded tool',
 *   loader: async () => (await import('./my-tool.js')).myTool
 * });
 * ```
 */
export const registerLazyTool = (entry: Omit<LazyToolEntry, 'loaded' | 'tool'>): void => {
  const isNew = !registryManager.exists(entry.name);
  registryManager.registerLazy(entry);

  // Invalidate tool definitions cache on new registration
  if (isNew) {
    invalidateToolDefinitionsCache();

    // Broadcast to connected clients if this is a newly registered tool (not during startup)
    if (broadcastToolsChanged) {
      broadcastToolsChanged().catch((err: unknown) => {
        Logger.warn(`Failed to broadcast tools/list_changed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
  }
};

/**
 * Background warmup: load all lazy tool schemas so ListTools returns full schemas.
 * Called once after server startup. Does not block startup.
 */
export async function warmupLazySchemas(): Promise<void> {
  const names = registryManager.getLazyToolNames();
  const toLoad = names.filter((name) => !schemaCache.has(name));

  if (toLoad.length === 0) return;

  // Parallel warmup with concurrency limit to avoid overwhelming I/O
  const BATCH_SIZE = 20;
  let loaded = 0;

  for (let i = 0; i < toLoad.length; i += BATCH_SIZE) {
    const batch = toLoad.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map((name) => registryManager.loadLazy(name))
    );
    for (let j = 0; j < results.length; j++) {
      const result = results[j];
      if (result.status === 'fulfilled') {
        loaded++;
      } else {
        Logger.warn(`Schema warmup failed for '${batch[j]}': ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
      }
    }
  }

  if (loaded > 0) {
    invalidateToolDefinitionsCache();
    Logger.info(`Schema warmup: loaded ${loaded} lazy tool schemas`);
    // Notify clients that tool schemas are now available
    if (broadcastToolsChanged) {
      broadcastToolsChanged().catch((err) => {
        Logger.debug(`[Registry] broadcastToolsChanged failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
  }
}

/**
 * Initialize the tools changed broadcast function.
 * Called after server startup to enable runtime tool registration notifications.
 */
export function initToolsBroadcast(broadcastFn: () => Promise<void>): void {
  broadcastToolsChanged = broadcastFn;
}

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
  GET_SHARED_CONTEXT = 'get-shared-context',
  AGENT = 'agent',
  AGENT_COMM = 'agent-comm',
}

/** Tools that should not auto-share their results */
const SKIP_SHARE_TOOLS: ReadonlySet<string> = new Set([
  InternalToolName.PING,
  InternalToolName.HELP,
  InternalToolName.GET_SHARED_CONTEXT, // Avoid recursive context
  // Agent tools (internal)
  InternalToolName.AGENT,
  InternalToolName.AGENT_COMM,
]);

/** Tools that should not trigger auto-save (meta/read-only tools) */
const AUTO_SAVE_SKIP_TOOLS: ReadonlySet<string> = new Set([
  'ping', 'help', 'memory', 'checkpoint',
  'session', 'smart-handoff', 'tool-health', 'env-info',
  'memory-usage', 'ai-config', 'ai-models', 'config',
  'get-shared-context', 'agent', 'agent-comm', 'invocation-log',
  'sequence-recommend', 'loci-recall',
  'graph-query', 'graph-find-path',
]);

/** Auto-save state per session: call count and last save timestamp */
const autoSaveState = new Map<string, { count: number; lastSave: number; recentTools: string[] }>();

/** Auto-save interval: every 10 tool calls, at least 60s apart */
const AUTO_SAVE_INTERVAL = 10;
const AUTO_SAVE_MIN_GAP_MS = 60_000;

/**
 * Periodically auto-save session state to 'active-session' memory.
 * Fire-and-forget — never blocks tool execution.
 */
async function maybeAutoSave(sessionId: string | undefined, toolName: string): Promise<void> {
  if (!sessionId) return;

  const state = autoSaveState.get(sessionId) ?? { count: 0, lastSave: 0, recentTools: [] };
  state.count++;
  state.recentTools.push(toolName);
  if (state.recentTools.length > 10) state.recentTools.shift();
  autoSaveState.set(sessionId, state);

  const now = Date.now();
  if (state.count % AUTO_SAVE_INTERVAL !== 0) return;
  if (now - state.lastSave < AUTO_SAVE_MIN_GAP_MS) return;

  state.lastSave = now;

  try {
    const { getSessionActivity } = await import('../server/session-server.js');
    const activity = getSessionActivity(sessionId);

    const snapshot = JSON.stringify({
      sessionId,
      timestamp: new Date(now).toISOString(),
      toolCount: activity?.toolCount ?? state.count,
      lastTool: activity?.lastTool ?? toolName,
      recentTools: state.recentTools,
    });

    // Use the registry's own executeTool — the tool handles overwrite
    const tool = await registryManager.findAsync('memory');
    if (tool) {
      const args = { action: 'write', name: 'active-session', content: snapshot, overwrite: true };
      const validated = tool.zodSchema.parse(args) as ToolArguments;
      await tool.execute(validated);
      Logger.debug(`[AutoSave] Saved active-session snapshot for ${sessionId} (call #${state.count})`);
    }
  } catch (err) {
    Logger.debug(() => `[AutoSave] Failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Schema shape returned by Zod's toJSONSchema
 * @interface JsonSchemaShape
 */
interface JsonSchemaShape {
  /** Object properties mapping */
  properties?: Record<string, object>;
  /** Array of required property names */
  required?: string[];
  /** Union variants (from discriminatedUnion / z.union) */
  oneOf?: object[];
  /** Union variants (alternative) */
  anyOf?: object[];
}

/** MCP input schema */
type McpInputSchema = {
  type: 'object';
  properties: Record<string, object>;
  required: string[];
};

/**
 * Cache for JSON Schema conversions (computed once per tool)
 * Key: tool name, Value: JSON Schema
 */
const schemaCache = new Map<string, McpInputSchema>();

/**
 * Cache for complete tool definitions array (invalidated on tool registration)
 * This avoids regenerating the entire array on every ListTools request
 */
let toolDefinitionsCache: Tool[] | null = null;

/**
 * Invalidate the tool definitions cache (called when tools are registered/unregistered)
 */
export function invalidateToolDefinitionsCache(): void {
  toolDefinitionsCache = null;
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
 * Convert raw JSON Schema to MCP inputSchema, handling union (oneOf/anyOf) schemas.
 * Flattens discriminated unions into a single object with all properties merged
 * (common fields required, variant-specific fields optional) for MCP client compatibility.
 */
function toMcpInputSchema(rawSchema: JsonSchemaShape): McpInputSchema {
  const variants = rawSchema.oneOf || rawSchema.anyOf;
  if (variants && variants.length > 0 && !rawSchema.properties) {
    // Flatten oneOf/anyOf variants into a merged object schema
    const allProperties: Record<string, object> = {};
    const requiredSets: Set<string>[] = [];

    // Collect discriminator values to build an enum for the discriminator field
    const discriminatorValues: string[] = [];

    for (const variant of variants) {
      const v = variant as { properties?: Record<string, object>; required?: string[] };
      if (v.properties) {
        for (const [key, val] of Object.entries(v.properties)) {
          const valObj = val as Record<string, unknown>;
          // Track discriminator const values
          if (valObj.const && typeof valObj.const === 'string') {
            discriminatorValues.push(valObj.const);
          }
          if (!allProperties[key]) {
            allProperties[key] = val;
          }
        }
      }
      requiredSets.push(new Set(v.required || []));
    }

    // Replace const with enum for discriminator fields (e.g. action: {const:"start"} → {enum:["start","list",...]})
    if (discriminatorValues.length > 1) {
      for (const [key, val] of Object.entries(allProperties)) {
        const valObj = val as Record<string, unknown>;
        if (valObj.const && typeof valObj.const === 'string' && discriminatorValues.includes(valObj.const as string)) {
          allProperties[key] = { type: 'string', enum: discriminatorValues, description: valObj.description };
          break; // Only one discriminator field
        }
      }
    }

    // Only fields required in ALL variants are truly required
    const commonRequired = requiredSets.length > 0
      ? [...requiredSets[0]].filter((field) => requiredSets.every((s) => s.has(field)))
      : [];

    return {
      type: 'object' as const,
      properties: allProperties,
      required: commonRequired,
    };
  }
  return {
    type: 'object' as const,
    properties: rawSchema.properties || {},
    required: rawSchema.required || [],
  };
}

/**
 * Get MCP tool definitions for protocol registration
 *
 * @description Returns metadata for all tools (both eager and lazy) without loading.
 *              This is used for the ListTools MCP call. Lazy tools use a permissive
 *              schema that accepts any object - the actual validation happens when
 *              the tool is executed and loaded. Results are cached until tools are
 *              registered/unregistered.
 * @returns {Tool[]} Array of MCP Tool definitions with inputSchema
 * @example
 * ```typescript
 * const tools = getToolDefinitions();
 * // Returns: [{ name: 'code-review', description: '...', inputSchema: {...} }, ...]
 * ```
 */
export function getToolDefinitions(): Tool[] {
  // Return cached definitions if available (common case - tools rarely change at runtime)
  if (toolDefinitionsCache) {
    return toolDefinitionsCache;
  }

  const definitions: Tool[] = [];

  // Add eager tools with full schemas
  for (const tool of registryManager.getAll()) {
    // Check cache first to avoid recomputing JSON Schema
    let inputSchema = schemaCache.get(tool.name);

    if (!inputSchema) {
      // Use native Zod 4 toJSONSchema with runtime validation
      const rawSchema = z.toJSONSchema(tool.zodSchema, { target: 'draft-07' });

      if (!isJsonSchemaShape(rawSchema)) {
        Logger.warn(`Invalid schema shape for tool '${tool.name}', using empty schema`);
        inputSchema = { type: 'object' as const, properties: {}, required: [] };
      } else {
        inputSchema = toMcpInputSchema(rawSchema);
      }

      // Cache the result
      schemaCache.set(tool.name, inputSchema);
    }

    // Merge annotations: tool-level > metadata-level > annotations-map
    const annotations = tool.annotations || tool.metadata?.annotations || getToolAnnotations(tool.name);

    const toolDef: Tool = {
      name: tool.name,
      description: tool.description,
      inputSchema,
    };

    if (annotations) {
      (toolDef as Record<string, unknown>).annotations = annotations;
    }

    definitions.push(toolDef);
  }

  // Add lazy tools - load schemas on first ListTools call (one-time cost)
  const metadata = registryManager.getAllMetadata();
  for (const meta of metadata) {
    // Skip if already added as eager tool
    if (definitions.some((d) => d.name === meta.name)) continue;

    // Check if tool was loaded (has cached schema)
    const cachedSchema = schemaCache.get(meta.name);
    const lazyAnnotations = getToolAnnotations(meta.name);

    if (!cachedSchema) {
      Logger.warn(`Lazy tool '${meta.name}' schema not loaded — returning empty schema. Run warmupLazySchemas() first.`);
    }

    const lazyDef: Tool = {
      name: meta.name,
      description: meta.description,
      inputSchema: cachedSchema || {
        type: 'object' as const,
        properties: {},
        additionalProperties: true,
      },
    };

    if (lazyAnnotations) {
      (lazyDef as Record<string, unknown>).annotations = lazyAnnotations;
    }

    definitions.push(lazyDef);
  }

  // Cache the complete array
  toolDefinitionsCache = definitions;
  return definitions;
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
  return registryManager.getAll()
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
  // Load tool (handles both eager and lazy tools)
  const tool = await registryManager.findAsync(name);
  if (!tool) {
    const allTools = registryManager.getAllMetadata().map((m) => m.name);
    throw new ToolExecutionError(name, `Unknown tool: ${name}`, {
      availableTools: allTools.slice(0, 10),
    });
  }

  // Pre-execution AI availability check
  if (tool.metadata?.aiRequired) {
    const checker = getAvailabilityChecker();
    if (!checker.isConnected()) {
      await checker.connect().catch((err) => {
        Logger.debug(`[Registry] Availability checker connect failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
    const mode = tool.metadata.availabilityMode || 'soft';
    const result = await checker.check(name, tool.metadata.aiRequired, mode);
    if (!result.available) {
      if (mode === 'force') {
        throw new ToolExecutionError(name, result.message || 'AI provider unavailable');
      }
      // Soft mode: return guidance message
      return result.message || 'AI provider unavailable. Configure a provider via ai-config.';
    }
  }

  const silent = isSilent();

  // Start timing - skip logging overhead in silent mode
  const startTime = silent ? 0 : Date.now();
  if (!silent) {
    Logger.toolExecution('start', name, undefined, {
      argsKeys: maskSensitiveKeys(Object.keys(args)),
      hasProgress: !!onProgress,
    });
  }

  let result: string;
  let isError = false;

  try {
    // Always validate - Zod applies defaults and coercion needed for correct execution
    const validatedArgs = tool.zodSchema.parse(args) as ToolArguments;

    result = await tool.execute(validatedArgs, onProgress);

    if (!silent) {
      // Log successful completion with timing
      const duration = Date.now() - startTime;
      Logger.toolExecution('end', name, duration, {
        resultLength: result.length,
        success: true,
      });

      // Tool tracking (async, fire-and-forget — never blocks response) - skip in silent mode
      // Redact sensitive argument values before passing to tracking
      const redactedArgs = redactSensitiveArgs(args as Record<string, unknown>);
      recordToolExecution(name, redactedArgs, true, duration).catch((err) => {
        Logger.debug(`[Registry] Tool tracking failed for ${name}: ${err instanceof Error ? err.message : String(err)}`);
      });
    }

    // Auto-save session state periodically (async, fire-and-forget)
    if (!AUTO_SAVE_SKIP_TOOLS.has(name)) {
      const { getActiveSessionId } = await import('../kanban/resolvers.js');
      const autoSaveSessionId = (args as Record<string, unknown>).sessionId as string | undefined
        || getActiveSessionId();
      maybeAutoSave(autoSaveSessionId, name).catch((err) => {
        Logger.debug(`[Registry] Auto-save failed after ${name}: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
  } catch (error) {
    isError = true;
    const duration = silent ? 0 : Date.now() - startTime;

    // Tool tracking for failures (fire-and-forget) - skip in silent mode
    if (!silent) {
      const redactedArgs = redactSensitiveArgs(args as Record<string, unknown>);
      recordToolExecution(name, redactedArgs, false, duration).catch((err) => {
        Logger.debug(`[Registry] Tool tracking (failure) failed for ${name}: ${err instanceof Error ? err.message : String(err)}`);
      });
    }

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

  // Auto-share context (async, don't block response) with retry for transient errors
  // Silent mode only affects output formatting, not context sharing
  if (isContextEnabled() && !tool.skipContextShare && !SKIP_SHARE_TOOLS.has(name)) {
    const shareWithRetry = async (attempt = 1): Promise<void> => {
      try {
        await shareContext(name, args as Record<string, unknown>, result, {
          errorState: isError,
        });
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        const isTransient =
          errorMessage.includes('ECONNREFUSED') || errorMessage.includes('ETIMEDOUT') || errorMessage.includes('ECONNRESET');

        if (isTransient && attempt < 3) {
          await new Promise((r) => setTimeout(r, attempt * 500));
          return shareWithRetry(attempt + 1);
        }

        const errorStack = err instanceof Error ? err.stack : undefined;
        if (isTransient) {
          Logger.error(`Context sharing failed for ${name} after ${attempt} attempts (Redis connection issue): ${errorMessage}`);
        } else {
          Logger.warn(`Context sharing failed for ${name}: ${errorMessage}`, {
            tool: name,
            error: errorMessage,
            stack: maskStackTrace(errorStack),
          });
        }
      }
    };
    shareWithRetry().catch((err) => {
      Logger.debug(`[Registry] Context sharing retry exhausted for ${name}: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  // Inject pending directives as prefix to response
  // Extract sessionId from args if present (many tools have it)
  const sessionId = (args as Record<string, unknown>).sessionId as string | undefined;
  if (sessionId) {
    try {
      const directivePrefix = await formatDirectivesPrefix(sessionId, name);
      if (directivePrefix) {
        result = directivePrefix + result;
      }
    } catch (err) {
      // Don't fail tool execution if directive lookup fails
      Logger.debug(`[executeTool] Failed to fetch directives for session ${sessionId}: ${err}`);
    }
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
  const tool = registryManager.getAll().find((t) => t.name === name);
  if (!tool?.prompt) throw new Error(`No prompt for: ${name}`);

  const params = Object.entries(args)
    .filter(([, v]) => v !== undefined && v !== null && v !== false)
    .map(([k, v]) => (typeof v === 'boolean' ? `[${k}]` : `(${k}: ${v})`))
    .join(' ');

  return `Use ${name} tool${params ? ': ' + params : ''}`;
}
