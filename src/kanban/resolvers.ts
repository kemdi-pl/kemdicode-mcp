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
 * Kanban Resolvers
 *
 * Provides session ID auto-injection and board/workspace name-based lookup.
 * These utilities reduce boilerplate in kanban tools by:
 * 1. Auto-resolving sessionId from the active MCP connection context
 * 2. Allowing board/workspace lookup by name (e.g., "name:Frontend Sprint")
 *
 * @module kanban/resolvers
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { Logger } from '../utils/logger.js';
import { listAccessibleBoards } from './board-store.js';
import { listWorkspacesForSession, listAllWorkspaces } from './workspace-store.js';

/**
 * AsyncLocalStorage for request-scoped session ID.
 * Prevents race conditions when multiple concurrent requests set different session IDs.
 */
const sessionStorage = new AsyncLocalStorage<string>();

/**
 * Module-level fallback active session ID.
 * Used when AsyncLocalStorage context is not available (backward compat).
 */
let _activeSessionId: string | undefined;

/**
 * Set the active session ID for the current tool execution context.
 * Called from session-server.ts before executing each tool.
 *
 * @param sessionId - The MCP connection session ID
 */
export function setActiveSessionId(sessionId: string | undefined): void {
  _activeSessionId = sessionId;
}

/**
 * Get the current active session ID.
 *
 * @returns The active session ID if set, undefined otherwise
 */
export function getActiveSessionId(): string | undefined {
  return sessionStorage.getStore() || _activeSessionId;
}

/**
 * Run a function within a request-scoped session context.
 * All calls to resolveSessionId() within the callback will use this sessionId
 * without risk of concurrent request interference.
 *
 * @param sessionId - The session ID for this request scope
 * @param fn - Function to execute within the session context
 * @returns The return value of fn
 */
export function runWithSessionId<T>(sessionId: string, fn: () => T): T {
  return sessionStorage.run(sessionId, fn);
}

/**
 * Resolve a session ID from explicit argument or active context.
 *
 * Priority:
 * 1. Explicitly provided sessionId (from tool args)
 * 2. AsyncLocalStorage session ID (request-scoped, concurrent-safe)
 * 3. Module-level fallback (backward compat)
 * 4. Throws error if none available
 *
 * @param explicitSessionId - Explicitly provided session ID (from tool args)
 * @returns Resolved session ID
 * @throws {Error} If no session ID can be determined
 */
export function resolveSessionId(explicitSessionId?: string): string {
  if (explicitSessionId) {
    return explicitSessionId;
  }

  const alsSessionId = sessionStorage.getStore();
  if (alsSessionId) {
    Logger.debug(`kanban-resolvers: auto-injected sessionId (ALS): ${alsSessionId}`);
    return alsSessionId;
  }

  if (_activeSessionId) {
    Logger.debug(`kanban-resolvers: auto-injected sessionId (fallback): ${_activeSessionId}`);
    return _activeSessionId;
  }

  throw new Error(
    'sessionId is required but was not provided and no active session context is available. ' +
      'Provide sessionId explicitly or ensure the tool is called via an MCP connection.'
  );
}

/**
 * UUID v4 pattern for detection
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Check if a string looks like a board ID (starts with board_ prefix or is a UUID)
 */
function isBoardIdFormat(value: string): boolean {
  return value.startsWith('board_') || UUID_PATTERN.test(value);
}

/**
 * Check if a string looks like a workspace ID (starts with ws_ prefix or is a UUID)
 */
function isWorkspaceIdFormat(value: string): boolean {
  return value.startsWith('ws_') || UUID_PATTERN.test(value);
}

/**
 * Resolve a board identifier to a board ID.
 *
 * Accepts:
 * - Board ID directly (starts with 'board_' or is UUID) - returned as-is
 * - Name with prefix: "name:Board Name" - searches by name
 * - Plain name (if not matching ID format) - searches by name
 *
 * @param boardIdOrName - Board ID or name to resolve
 * @param sessionId - Session ID for board lookup context
 * @returns Resolved board ID
 * @throws {Error} If board not found by name
 */
export async function resolveBoardId(
  boardIdOrName: string,
  sessionId: string
): Promise<string> {
  // Direct ID: return as-is
  if (isBoardIdFormat(boardIdOrName)) {
    return boardIdOrName;
  }

  // Strip "name:" prefix if present
  const name = boardIdOrName.startsWith('name:')
    ? boardIdOrName.slice(5).trim()
    : boardIdOrName;

  // Search boards accessible to the session
  const boards = await listAccessibleBoards(sessionId);
  const match = boards.find(
    (b) => b.name.toLowerCase() === name.toLowerCase()
  );

  if (!match) {
    const availableNames = boards.map((b) => b.name).join(', ');
    throw new Error(
      `Board not found by name: "${name}". Available boards: ${availableNames || '(none)'}`
    );
  }

  Logger.debug(
    `kanban-resolvers: resolved board name "${name}" -> ${match.id}`
  );
  return match.id;
}

/**
 * Resolve a workspace identifier to a workspace ID.
 *
 * Accepts:
 * - Workspace ID directly (starts with 'ws_' or is UUID) - returned as-is
 * - Name with prefix: "name:Workspace Name" - searches by name
 * - Plain name (if not matching ID format) - searches by name
 *
 * @param workspaceIdOrName - Workspace ID or name to resolve
 * @param sessionId - Optional session ID for scoped lookup
 * @returns Resolved workspace ID
 * @throws {Error} If workspace not found by name
 */
export async function resolveWorkspaceId(
  workspaceIdOrName: string,
  sessionId?: string
): Promise<string> {
  // Direct ID: return as-is
  if (isWorkspaceIdFormat(workspaceIdOrName)) {
    return workspaceIdOrName;
  }

  // Strip "name:" prefix if present
  const name = workspaceIdOrName.startsWith('name:')
    ? workspaceIdOrName.slice(5).trim()
    : workspaceIdOrName;

  // Search workspaces - prefer session-scoped, fall back to all
  const workspaces = sessionId
    ? await listWorkspacesForSession(sessionId)
    : await listAllWorkspaces();

  const match = workspaces.find(
    (ws) => ws.name.toLowerCase() === name.toLowerCase()
  );

  if (!match) {
    const availableNames = workspaces.map((ws) => ws.name).join(', ');
    throw new Error(
      `Workspace not found by name: "${name}". Available workspaces: ${availableNames || '(none)'}`
    );
  }

  Logger.debug(
    `kanban-resolvers: resolved workspace name "${name}" -> ${match.id}`
  );
  return match.id;
}
