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
 * Workspace Store
 *
 * Redis-based persistence layer for Workspace management.
 * Workspaces enable cross-session collaboration by grouping sessions
 * that can share Kanban boards.
 *
 * @module kanban/workspace-store
 */

import { Redis } from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import { Logger } from '../utils/logger.js';
import { Workspace, CreateWorkspaceInput, KANBAN_KEYS, DEFAULT_TASK_TTL } from './types.js';

/** Redis client (lazy init) */
let redis: Redis | null = null;

/**
 * Get or create Redis connection for Workspace storage
 *
 * @description Lazily initializes and returns a Redis client connection
 *              configured for the MCP context database (DB 2)
 * @returns {Promise<Redis>} Connected Redis client instance
 * @throws {Error} If Redis connection fails
 * @internal
 */
async function getRedis(): Promise<Redis> {
  if (!redis) {
    redis = new Redis({
      host: process.env.REDIS_HOST || '127.0.0.1',
      port: parseInt(process.env.REDIS_PORT || '6379'),
      password: process.env.REDIS_PASSWORD || undefined,
      db: 2,
      lazyConnect: true,
    });
    await redis.connect();
  }
  return redis;
}

/**
 * Generate a unique workspace ID
 *
 * @description Creates a workspace ID with 'ws_' prefix followed by UUID
 * @returns {string} Unique workspace ID (format: ws_xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)
 * @internal
 */
function generateWorkspaceId(): string {
  return `ws_${uuidv4()}`;
}

/**
 * Create a new workspace for cross-session collaboration
 *
 * @description Creates a workspace that can group multiple sessions together,
 *              enabling them to share Kanban boards. The creating session
 *              automatically becomes a member.
 * @param {CreateWorkspaceInput} input - Workspace creation parameters
 * @param {string} input.name - Human-readable workspace name
 * @param {string} [input.description] - Optional workspace description
 * @param {string} input.ownerSessionId - Session ID of the workspace creator
 * @param {string} input.ownerId - Agent ID of the workspace creator
 * @param {string[]} [input.initialMemberSessions] - Additional sessions to invite
 * @returns {Promise<Workspace>} The created workspace with generated ID and timestamps
 *
 * @example
 * ```typescript
 * const workspace = await createWorkspace({
 *   name: 'Frontend Team',
 *   description: 'Shared workspace for frontend developers',
 *   ownerSessionId: 'session-123',
 *   ownerId: 'agent-1',
 *   initialMemberSessions: ['session-456'],
 * });
 * ```
 */
export async function createWorkspace(input: CreateWorkspaceInput): Promise<Workspace> {
  const client = await getRedis();
  const id = generateWorkspaceId();
  const now = Date.now();

  const memberSessions = [input.ownerSessionId, ...(input.initialMemberSessions || [])];
  // Deduplicate sessions
  const uniqueSessions = [...new Set(memberSessions)];

  const workspace: Workspace = {
    id,
    name: input.name,
    description: input.description,
    ownerId: input.ownerId,
    ownerSessionId: input.ownerSessionId,
    memberSessions: uniqueSessions,
    createdAt: now,
    updatedAt: now,
  };

  const pipeline = client.pipeline();

  // Store workspace data
  pipeline.setex(KANBAN_KEYS.workspace(id), DEFAULT_TASK_TTL, JSON.stringify(workspace));

  // Add to global workspace list
  pipeline.sadd(KANBAN_KEYS.allWorkspaces, id);

  // Add sessions to workspace
  for (const sessionId of uniqueSessions) {
    pipeline.sadd(KANBAN_KEYS.workspaceSessions(id), sessionId);
    pipeline.sadd(KANBAN_KEYS.workspacesBySession(sessionId), id);
    pipeline.expire(KANBAN_KEYS.workspacesBySession(sessionId), DEFAULT_TASK_TTL);
  }

  pipeline.expire(KANBAN_KEYS.workspaceSessions(id), DEFAULT_TASK_TTL);

  await pipeline.exec();

  Logger.debug(`workspace-store: created workspace '${input.name}' (${id})`);

  return workspace;
}

/**
 * Retrieve a workspace by its ID
 *
 * @description Fetches workspace data from Redis by ID
 * @param {string} workspaceId - The workspace ID to retrieve
 * @returns {Promise<Workspace | null>} The workspace if found, null otherwise
 *
 * @example
 * ```typescript
 * const workspace = await getWorkspace('ws_abc123');
 * if (workspace) {
 *   console.log(`Found: ${workspace.name}`);
 * }
 * ```
 */
export async function getWorkspace(workspaceId: string): Promise<Workspace | null> {
  const client = await getRedis();
  const data = await client.get(KANBAN_KEYS.workspace(workspaceId));

  if (!data) {
    return null;
  }

  try {
    return JSON.parse(data) as Workspace;
  } catch {
    Logger.error(`workspace-store: failed to parse workspace ${workspaceId}`);
    return null;
  }
}

/**
 * List all workspaces a session belongs to
 *
 * @description Retrieves all workspaces that include the given session as a member
 * @param {string} sessionId - Session ID to look up
 * @returns {Promise<Workspace[]>} Array of workspaces the session belongs to
 *
 * @example
 * ```typescript
 * const workspaces = await listWorkspacesForSession('session-123');
 * console.log(`Session belongs to ${workspaces.length} workspaces`);
 * ```
 */
export async function listWorkspacesForSession(sessionId: string): Promise<Workspace[]> {
  const client = await getRedis();
  const workspaceIds = await client.smembers(KANBAN_KEYS.workspacesBySession(sessionId));

  if (workspaceIds.length === 0) {
    return [];
  }

  const workspaces: Workspace[] = [];
  for (const wsId of workspaceIds) {
    const workspace = await getWorkspace(wsId);
    if (workspace) {
      workspaces.push(workspace);
    }
  }

  return workspaces;
}

/**
 * List all available workspaces
 *
 * @description Retrieves all workspaces in the system. Useful for discovery.
 * @param {Object} [options] - Listing options
 * @param {number} [options.limit=50] - Maximum number of workspaces to return
 * @returns {Promise<Workspace[]>} Array of all workspaces
 *
 * @example
 * ```typescript
 * const allWorkspaces = await listAllWorkspaces({ limit: 10 });
 * ```
 */
export async function listAllWorkspaces(options?: { limit?: number }): Promise<Workspace[]> {
  const client = await getRedis();
  const limit = options?.limit ?? 50;

  const workspaceIds = await client.smembers(KANBAN_KEYS.allWorkspaces);
  const idsToFetch = workspaceIds.slice(0, limit);

  const workspaces: Workspace[] = [];
  for (const wsId of idsToFetch) {
    const workspace = await getWorkspace(wsId);
    if (workspace) {
      workspaces.push(workspace);
    }
  }

  return workspaces;
}

/**
 * Add a session to a workspace
 *
 * @description Adds a session as a member of the workspace, enabling it to
 *              access shared boards within the workspace
 * @param {string} workspaceId - Workspace to join
 * @param {string} sessionId - Session to add
 * @returns {Promise<boolean>} True if session was added, false if workspace not found
 *
 * @example
 * ```typescript
 * const success = await joinWorkspace('ws_abc123', 'session-456');
 * if (success) {
 *   console.log('Session joined workspace');
 * }
 * ```
 */
export async function joinWorkspace(workspaceId: string, sessionId: string): Promise<boolean> {
  const client = await getRedis();
  const workspace = await getWorkspace(workspaceId);

  if (!workspace) {
    return false;
  }

  // Check if already a member
  if (workspace.memberSessions.includes(sessionId)) {
    return true; // Already a member
  }

  // Update workspace data
  workspace.memberSessions.push(sessionId);
  workspace.updatedAt = Date.now();

  const pipeline = client.pipeline();

  // Update workspace
  pipeline.setex(KANBAN_KEYS.workspace(workspaceId), DEFAULT_TASK_TTL, JSON.stringify(workspace));

  // Add session to workspace members
  pipeline.sadd(KANBAN_KEYS.workspaceSessions(workspaceId), sessionId);

  // Add workspace to session's list
  pipeline.sadd(KANBAN_KEYS.workspacesBySession(sessionId), workspaceId);
  pipeline.expire(KANBAN_KEYS.workspacesBySession(sessionId), DEFAULT_TASK_TTL);

  await pipeline.exec();

  Logger.debug(`workspace-store: session ${sessionId} joined workspace ${workspaceId}`);

  return true;
}

/**
 * Remove a session from a workspace
 *
 * @description Removes a session's membership from the workspace. The owner
 *              cannot leave their own workspace (must delete it instead).
 * @param {string} workspaceId - Workspace to leave
 * @param {string} sessionId - Session to remove
 * @returns {Promise<boolean>} True if session was removed, false if not found or is owner
 *
 * @example
 * ```typescript
 * const success = await leaveWorkspace('ws_abc123', 'session-456');
 * ```
 */
export async function leaveWorkspace(workspaceId: string, sessionId: string): Promise<boolean> {
  const client = await getRedis();
  const workspace = await getWorkspace(workspaceId);

  if (!workspace) {
    return false;
  }

  // Owner cannot leave their own workspace
  if (workspace.ownerSessionId === sessionId) {
    Logger.warn(
      `workspace-store: owner session ${sessionId} cannot leave workspace ${workspaceId}`
    );
    return false;
  }

  // Check if member
  const index = workspace.memberSessions.indexOf(sessionId);
  if (index === -1) {
    return true; // Not a member, consider success
  }

  // Update workspace data
  workspace.memberSessions.splice(index, 1);
  workspace.updatedAt = Date.now();

  const pipeline = client.pipeline();

  // Update workspace
  pipeline.setex(KANBAN_KEYS.workspace(workspaceId), DEFAULT_TASK_TTL, JSON.stringify(workspace));

  // Remove session from workspace members
  pipeline.srem(KANBAN_KEYS.workspaceSessions(workspaceId), sessionId);

  // Remove workspace from session's list
  pipeline.srem(KANBAN_KEYS.workspacesBySession(sessionId), workspaceId);

  await pipeline.exec();

  Logger.debug(`workspace-store: session ${sessionId} left workspace ${workspaceId}`);

  return true;
}

/**
 * Update workspace metadata
 *
 * @description Updates workspace name, description, or metadata
 * @param {string} workspaceId - Workspace to update
 * @param {Object} updates - Fields to update
 * @param {string} [updates.name] - New workspace name
 * @param {string} [updates.description] - New description
 * @param {Record<string, unknown>} [updates.metadata] - Additional metadata
 * @returns {Promise<Workspace | null>} Updated workspace or null if not found
 *
 * @example
 * ```typescript
 * const updated = await updateWorkspace('ws_abc123', {
 *   name: 'Updated Team Name',
 *   description: 'New description',
 * });
 * ```
 */
export async function updateWorkspace(
  workspaceId: string,
  updates: {
    name?: string;
    description?: string;
    metadata?: Record<string, unknown>;
  }
): Promise<Workspace | null> {
  const client = await getRedis();
  const workspace = await getWorkspace(workspaceId);

  if (!workspace) {
    return null;
  }

  // Apply updates
  if (updates.name !== undefined) {
    workspace.name = updates.name;
  }
  if (updates.description !== undefined) {
    workspace.description = updates.description;
  }
  if (updates.metadata !== undefined) {
    workspace.metadata = { ...workspace.metadata, ...updates.metadata };
  }
  workspace.updatedAt = Date.now();

  await client.setex(
    KANBAN_KEYS.workspace(workspaceId),
    DEFAULT_TASK_TTL,
    JSON.stringify(workspace)
  );

  Logger.debug(`workspace-store: updated workspace ${workspaceId}`);

  return workspace;
}

/**
 * Delete a workspace
 *
 * @description Permanently deletes a workspace and removes all session associations.
 *              Only the workspace owner can delete a workspace.
 * @param {string} workspaceId - Workspace to delete
 * @param {string} requestingSessionId - Session requesting deletion (must be owner)
 * @returns {Promise<boolean>} True if deleted, false if not found or unauthorized
 *
 * @example
 * ```typescript
 * const deleted = await deleteWorkspace('ws_abc123', 'session-owner');
 * ```
 */
export async function deleteWorkspace(
  workspaceId: string,
  requestingSessionId: string
): Promise<boolean> {
  const client = await getRedis();
  const workspace = await getWorkspace(workspaceId);

  if (!workspace) {
    return false;
  }

  // Only owner can delete
  if (workspace.ownerSessionId !== requestingSessionId) {
    Logger.warn(
      `workspace-store: session ${requestingSessionId} not authorized to delete workspace ${workspaceId}`
    );
    return false;
  }

  const pipeline = client.pipeline();

  // Remove workspace data
  pipeline.del(KANBAN_KEYS.workspace(workspaceId));

  // Remove from global list
  pipeline.srem(KANBAN_KEYS.allWorkspaces, workspaceId);

  // Remove workspace sessions set
  pipeline.del(KANBAN_KEYS.workspaceSessions(workspaceId));

  // Remove workspace from all member sessions
  for (const sessionId of workspace.memberSessions) {
    pipeline.srem(KANBAN_KEYS.workspacesBySession(sessionId), workspaceId);
  }

  await pipeline.exec();

  Logger.debug(`workspace-store: deleted workspace ${workspaceId}`);

  return true;
}

/**
 * Check if a session is a member of a workspace
 *
 * @description Verifies workspace membership for authorization checks
 * @param {string} workspaceId - Workspace to check
 * @param {string} sessionId - Session to verify
 * @returns {Promise<boolean>} True if session is a member
 *
 * @example
 * ```typescript
 * if (await isWorkspaceMember('ws_abc123', 'session-456')) {
 *   // Allow access to workspace boards
 * }
 * ```
 */
export async function isWorkspaceMember(workspaceId: string, sessionId: string): Promise<boolean> {
  const client = await getRedis();
  return (await client.sismember(KANBAN_KEYS.workspaceSessions(workspaceId), sessionId)) === 1;
}

/**
 * Get all sessions in a workspace
 *
 * @description Lists all session IDs that are members of the workspace
 * @param {string} workspaceId - Workspace to query
 * @returns {Promise<string[]>} Array of member session IDs
 *
 * @example
 * ```typescript
 * const sessions = await getWorkspaceSessions('ws_abc123');
 * console.log(`${sessions.length} sessions in workspace`);
 * ```
 */
export async function getWorkspaceSessions(workspaceId: string): Promise<string[]> {
  const client = await getRedis();
  return client.smembers(KANBAN_KEYS.workspaceSessions(workspaceId));
}
