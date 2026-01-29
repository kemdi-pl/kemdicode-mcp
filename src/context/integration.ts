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
 * Context Integration Module
 *
 * Provides high-level functions for context sharing in the kemdicode-mcp server.
 * Handles session management, auto-sharing, and cross-server context retrieval.
 */

import { v4 as uuidv4 } from 'uuid';
import { Logger } from '../utils/logger.js';
import { getContextStorage } from './storage.js';
import { McpContextEntry, ServerIdentifier, RedisConfig, TTL } from './types.js';

// Current session state
let currentSessionId: string | null = null;
let contextEnabled = false;

/**
 * Initialize context sharing
 */
export async function initContext(config?: RedisConfig): Promise<boolean> {
  try {
    const storage = getContextStorage(config);
    const connected = await storage.connect();

    if (connected) {
      contextEnabled = true;
      Logger.debug('Context sharing initialized');
    } else {
      Logger.warn('Context sharing disabled (Redis unavailable)');
      contextEnabled = false;
    }

    return contextEnabled;
  } catch (error) {
    Logger.error('Failed to initialize context:', error);
    contextEnabled = false;
    return false;
  }
}

/**
 * Check if context sharing is enabled
 */
export function isContextEnabled(): boolean {
  return contextEnabled && getContextStorage().isConnected();
}

/**
 * Get or generate the current session ID
 */
export function getSessionId(): string {
  if (!currentSessionId) {
    currentSessionId = `sess_${uuidv4().replace(/-/g, '').slice(0, 24)}`;
    Logger.debug(`New session created: ${currentSessionId}`);
  }
  return currentSessionId;
}

/**
 * Set the session ID explicitly
 */
export function setSessionId(sessionId: string): void {
  currentSessionId = sessionId;
  Logger.debug(`Session set: ${sessionId}`);
}

/**
 * Clear the current session
 */
export function clearSession(): void {
  currentSessionId = null;
}

/**
 * Get the current session ID (alias for getSessionId)
 */
export function getCurrentSessionId(): string | null {
  return currentSessionId;
}

/**
 * Set the current session (alias for setSessionId)
 */
export function setCurrentSession(sessionId: string): void {
  setSessionId(sessionId);
}

/**
 * Clear the current session (alias for clearSession)
 */
export function clearCurrentSession(): void {
  clearSession();
}

/**
 * Infer tags based on tool name
 */
function inferTags(toolName: string): string[] {
  const tags: string[] = [];

  if (toolName.includes('model') || toolName.includes('Model')) {
    tags.push('model');
  }
  if (toolName.includes('table') || toolName.includes('query') || toolName.includes('database')) {
    tags.push('database');
  }
  if (toolName.includes('endpoint') || toolName.includes('schema') || toolName.includes('api')) {
    tags.push('api');
  }
  if (toolName.includes('review') || toolName.includes('analyze') || toolName.includes('explain')) {
    tags.push('analysis');
  }
  if (toolName.includes('test') || toolName.includes('Test')) {
    tags.push('testing');
  }
  if (toolName.includes('refactor') || toolName.includes('fix')) {
    tags.push('refactoring');
  }

  return tags.length > 0 ? tags : ['general'];
}

/**
 * Infer TTL based on tool name
 */
function inferTtl(toolName: string): number {
  if (toolName.includes('schema') || toolName.includes('model') || toolName.includes('describe')) {
    return TTL.SCHEMA;
  }
  if (toolName.includes('endpoint') || toolName.includes('api')) {
    return TTL.API_DOCS;
  }
  if (toolName.includes('query') || toolName.includes('execute')) {
    return TTL.QUERY;
  }
  if (toolName.includes('review') || toolName.includes('analyze') || toolName.includes('explain')) {
    return TTL.ANALYSIS;
  }
  return TTL.DEFAULT;
}

/**
 * Generate a summary from tool output
 */
function generateSummary(toolName: string, output: unknown): string {
  if (typeof output === 'string') {
    // Take first 200 chars as summary
    const clean = output.replace(/\n/g, ' ').trim();
    return clean.length > 200 ? clean.slice(0, 197) + '...' : clean;
  }

  if (typeof output === 'object' && output !== null) {
    const keys = Object.keys(output);
    return `${toolName} returned object with keys: ${keys.slice(0, 5).join(', ')}${keys.length > 5 ? '...' : ''}`;
  }

  return `${toolName} completed`;
}

/**
 * Share context after tool execution (auto-share)
 */
export async function shareContext(
  toolName: string,
  input: Record<string, unknown>,
  output: unknown,
  options: {
    summary?: string;
    tags?: string[];
    relatedFiles?: string[];
    ttl?: number;
    errorState?: boolean;
  } = {}
): Promise<McpContextEntry | null> {
  if (!isContextEnabled()) {
    return null;
  }

  try {
    const storage = getContextStorage();
    const sessionId = getSessionId();

    const entry: McpContextEntry = {
      id: uuidv4(),
      sessionId,
      serverId: 'kemdicode-mcp',
      toolName,
      timestamp: Date.now(),
      ttl: options.ttl ?? inferTtl(toolName),
      input,
      output,
      summary: options.summary ?? generateSummary(toolName, output),
      tags: options.tags ?? inferTags(toolName),
      relatedFiles: options.relatedFiles,
      errorState: options.errorState ?? false,
    };

    const saved = await storage.saveContext(entry);
    if (saved) {
      Logger.debug(`Context shared: ${entry.id} (${toolName})`);
    }

    return saved ? entry : null;
  } catch (error) {
    Logger.error('Failed to share context:', error);
    return null;
  }
}

/**
 * Get context from a specific server
 */
export async function getContextFromServer(
  serverId: ServerIdentifier,
  limit = 5
): Promise<McpContextEntry[]> {
  if (!isContextEnabled()) {
    return [];
  }

  const storage = getContextStorage();
  return storage.getLatestFromServer(getSessionId(), serverId, limit);
}

/**
 * Get all context from current session
 */
export async function getSessionContext(limit = 20): Promise<McpContextEntry[]> {
  if (!isContextEnabled()) {
    return [];
  }

  const storage = getContextStorage();
  return storage.getSessionHistory(getSessionId(), limit);
}

/**
 * Get context from external MCP servers (configured via MCP_EXTERNAL_SERVERS env)
 * @param limit Maximum entries to return
 * @returns Context entries from external servers
 */
export async function getExternalServersContext(limit = 10): Promise<McpContextEntry[]> {
  if (!isContextEnabled()) {
    return [];
  }

  // Get external servers from environment (comma-separated)
  const externalServersEnv = process.env.MCP_EXTERNAL_SERVERS;
  if (!externalServersEnv) {
    return [];
  }

  const externalServers = externalServersEnv
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (externalServers.length === 0) {
    return [];
  }

  const storage = getContextStorage();
  const entries: McpContextEntry[] = [];
  const perServerLimit = Math.ceil(limit / externalServers.length);

  for (const server of externalServers) {
    const serverEntries = await storage.getLatestFromServer(getSessionId(), server, perServerLimit);
    entries.push(...serverEntries);
  }

  // Sort by timestamp (most recent first)
  entries.sort((a, b) => b.timestamp - a.timestamp);

  return entries.slice(0, limit);
}

/**
 * Format context entries for inclusion in prompts
 */
export function formatContextForPrompt(entries: McpContextEntry[]): string {
  if (entries.length === 0) {
    return '';
  }

  const lines = ['## Shared Context from Other MCP Servers\n'];

  for (const entry of entries) {
    const age = Math.round((Date.now() - entry.timestamp) / 1000);
    lines.push(`### ${entry.toolName} (${entry.serverId})`);
    lines.push(`- Age: ${age}s ago`);
    lines.push(`- Tags: ${entry.tags.join(', ')}`);
    if (entry.summary) {
      lines.push(`- Summary: ${entry.summary}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Clear all context for current session
 */
export async function clearSessionContext(): Promise<boolean> {
  if (!isContextEnabled()) {
    return false;
  }

  const storage = getContextStorage();
  return storage.clearSession(getSessionId());
}
