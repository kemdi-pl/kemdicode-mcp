/**
 * KemdiCode MCP Server - Session Server
 * Copyright (C) 2025-2026 Kemdi Sp. z o.o. (Dawid Irzyk <dawid@kemdi.pl>)
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

/**
 * Session Server Module
 *
 * MCP session management, transport handling, and CWD resolution.
 *
 * @module server/session-server
 */

import type { IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  type Tool,
  type Prompt,
} from '@modelcontextprotocol/sdk/types.js';
import { Logger } from '../utils/logger.js';
import {
  getToolDefinitions,
  getPromptDefinitions,
  executeTool,
  toolExists,
  getPromptMessage,
} from '../tools/index.js';
import { setActiveSessionId, runWithSessionId } from '../kanban/resolvers.js';
import { startProgress, stopProgress, updateProgressOutput } from './progress.js';
import { VERSION, type SessionConfig } from './types.js';
import type { ToolArguments } from '../tools/registry.js';

/** Map of session IDs to their configurations */
const sessionConfigs = new Map<string, SessionConfig>();

/** Map of session IDs to their MCP Server instances (for notifications) */
const sessionServers = new Map<string, Server>();

/** Session activity tracking for resume info */
interface SessionActivity {
  lastTool: string;
  lastToolArgs?: string;
  lastToolAt: number;
  toolCount: number;
}

/** Map of session IDs to their last activity */
const sessionActivity = new Map<string, SessionActivity>();

/**
 * Record tool execution activity for a session
 */
export function recordSessionActivity(sessionId: string, toolName: string, args?: Record<string, unknown>): void {
  const existing = sessionActivity.get(sessionId);
  const argsSummary = args
    ? Object.entries(args)
        .filter(([, v]) => v !== undefined && v !== null && v !== '' && v !== false)
        .slice(0, 3)
        .map(([k, v]) => `${k}: ${typeof v === 'string' ? v.slice(0, 50) : v}`)
        .join(', ')
    : undefined;

  sessionActivity.set(sessionId, {
    lastTool: toolName,
    lastToolArgs: argsSummary || undefined,
    lastToolAt: Date.now(),
    toolCount: (existing?.toolCount ?? 0) + 1,
  });
}

/**
 * Get activity for a specific session
 */
export function getSessionActivity(sessionId: string): SessionActivity | undefined {
  return sessionActivity.get(sessionId);
}

/**
 * Get all session activities
 */
export function getAllSessionActivity(): Map<string, SessionActivity> {
  return sessionActivity;
}

/**
 * Delete session activity
 */
export function deleteSessionActivity(sessionId: string): void {
  sessionActivity.delete(sessionId);
}

/**
 * Get all active MCP server instances
 * Used for broadcasting notifications like tools/list_changed
 */
export function getAllSessionServers(): Map<string, Server> {
  return sessionServers;
}

/**
 * Broadcast a notification to all connected MCP sessions
 * @param method - Notification method name
 * @param params - Notification parameters
 */
export async function broadcastNotification(method: string, params: Record<string, unknown> = {}): Promise<void> {
  const servers = sessionServers;
  if (servers.size === 0) return;

  Logger.debug(`Broadcasting ${method} to ${servers.size} session(s)`);

  const promises: Promise<void>[] = [];
  for (const [sessionId, server] of servers) {
    promises.push(
      server.notification({ method, params }).catch((err: unknown) => {
        Logger.warn(`Failed to notify session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
      })
    );
  }
  await Promise.allSettled(promises);
}

/**
 * Resolve CWD for a request using priority order:
 * 1. X-Project-Path header
 * 2. cwd in tool arguments
 * 3. KEMDICODE_PROJECT_PATH env variable
 * 4. Session stored CWD
 * 5. process.cwd() fallback
 */
export function resolveCwd(req: IncomingMessage, sessionId?: string, args?: ToolArguments): string {
  // Priority 1: X-Project-Path header
  const headerPath = req.headers['x-project-path'];
  if (headerPath && typeof headerPath === 'string') {
    return headerPath;
  }

  // Priority 2: cwd in tool arguments
  if (args?.cwd && typeof args.cwd === 'string') {
    return args.cwd;
  }

  // Priority 3: Environment variable
  if (process.env.KEMDICODE_PROJECT_PATH) {
    return process.env.KEMDICODE_PROJECT_PATH;
  }

  // Priority 4: Session stored CWD
  if (sessionId) {
    const sessionConfig = sessionConfigs.get(sessionId);
    if (sessionConfig?.cwd) {
      return sessionConfig.cwd;
    }
  }

  // Priority 5: Fallback
  return process.cwd();
}

/**
 * Get session configuration by ID
 * @param sessionId - Session identifier
 * @returns Session configuration if exists
 */
export function getSessionConfig(sessionId: string): SessionConfig | undefined {
  return sessionConfigs.get(sessionId);
}

/**
 * Set session configuration
 * @param sessionId - Session identifier
 * @param config - Session configuration
 */
export function setSessionConfig(sessionId: string, config: SessionConfig): void {
  sessionConfigs.set(sessionId, config);
}

/**
 * Delete session configuration
 * @param sessionId - Session identifier
 */
export function deleteSessionConfig(sessionId: string): void {
  sessionConfigs.delete(sessionId);
}

/**
 * Get all session configurations (for health check)
 * @returns Map of session configs
 */
export function getAllSessionConfigs(): Map<string, SessionConfig> {
  return sessionConfigs;
}

/**
 * Create and configure a session-specific MCP server
 * This function encapsulates the session server setup to avoid code duplication
 * @param _sessionId - Unique session identifier
 * @returns Configured MCP server instance
 */
export function createSessionServer(_sessionId: string): Server {
  const sessionServer = new Server(
    { name: 'kemdicode-mcp', version: VERSION },
    { capabilities: { tools: {}, prompts: {}, logging: {} } }
  );

  // Log client capabilities after initialization completes
  sessionServer.oninitialized = () => {
    const caps = sessionServer.getClientCapabilities();
    const clientInfo = sessionServer.getClientVersion();
    const clientName = clientInfo?.name || 'unknown';
    const clientVer = clientInfo?.version || '';
    Logger.info(
      `Session ${_sessionId} — Client: ${clientName} ${clientVer}, ` +
        `capabilities: sampling=${!!caps?.sampling}, elicitation=${!!caps?.elicitation}, roots=${!!caps?.roots}`,
    );
  };

  // Handler: List available tools
  sessionServer.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: getToolDefinitions() as unknown as Tool[],
  }));

  // Handler: Execute tool
  sessionServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;
    if (!toolExists(name)) throw new Error(`Unknown tool: ${name}`);

    const progressToken = (request.params as { _meta?: { progressToken?: string | number } })._meta
      ?.progressToken;
    const progressData = startProgress(name, progressToken, sessionServer);

    try {
      const args = (rawArgs as ToolArguments) || {};

      // Inject active session ID for kanban tools auto-resolution
      setActiveSessionId(_sessionId);

      // Inject session CWD so file tools resolve relative paths correctly
      const sessionConfig = sessionConfigs.get(_sessionId);
      if (sessionConfig?.cwd && !args._sessionCwd) {
        args._sessionCwd = sessionConfig.cwd;
      }

      Logger.toolInvocation(name, args);
      recordSessionActivity(_sessionId, name, rawArgs as Record<string, unknown>);

      // Run tool within AsyncLocalStorage scope for concurrent-safe session resolution
      const result = await runWithSessionId(_sessionId, () =>
        executeTool(name, args, (output) => {
          updateProgressOutput(progressData.requestId, output);
        })
      );
      stopProgress(progressData, true);

      return { content: [{ type: 'text', text: result }], isError: false };
    } catch (error) {
      stopProgress(progressData, false);
      Logger.error(`Tool '${name}' error:`, error);
      return {
        content: [
          {
            type: 'text',
            text: `Error: ${error instanceof Error ? error.message : error}`,
          },
        ],
        isError: true,
      };
    }
  });

  // Handler: List prompts
  sessionServer.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: getPromptDefinitions() as unknown as Prompt[],
  }));

  // Handler: Get prompt message
  sessionServer.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const message = getPromptMessage(request.params.name, request.params.arguments || {});
    if (!message) throw new Error(`Unknown prompt: ${request.params.name}`);
    return {
      messages: [{ role: 'user' as const, content: { type: 'text' as const, text: message } }],
    };
  });

  return sessionServer;
}

/**
 * Create or get transport for a session
 * @param sessionId - Session identifier
 * @param transports - Map of active transports
 * @param req - HTTP request for CWD resolution
 * @returns Transport and whether it was newly created
 */
export async function getOrCreateTransport(
  sessionId: string,
  transports: Map<string, StreamableHTTPServerTransport>,
  req: IncomingMessage
): Promise<{ transport: StreamableHTTPServerTransport; isNew: boolean }> {
  let transport = transports.get(sessionId);
  let isNew = false;

  if (!transport) {
    isNew = true;
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => sessionId,
    });

    const sessionServer = createSessionServer(sessionId);
    await sessionServer.connect(transport);
    sessionServers.set(sessionId, sessionServer);

    // Store session config with resolved CWD
    const cwd = resolveCwd(req, sessionId);
    sessionConfigs.set(sessionId, {
      sessionId,
      cwd,
    });

    transports.set(sessionId, transport);
    Logger.debug(`New session: ${sessionId} (cwd: ${cwd})`);
  } else {
    // Update CWD if X-Project-Path header is present
    const headerPath = req.headers['x-project-path'];
    if (headerPath && typeof headerPath === 'string') {
      const config = sessionConfigs.get(sessionId);
      if (config) {
        config.cwd = headerPath;
        Logger.debug(`Updated session ${sessionId} cwd: ${headerPath}`);
      }
    }
  }

  return { transport, isNew };
}

/**
 * Generate a new session ID
 * @returns New session ID
 */
export function generateSessionId(): string {
  return randomUUID();
}
