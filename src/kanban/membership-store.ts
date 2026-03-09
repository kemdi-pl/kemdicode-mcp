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
 * Membership Store
 *
 * Redis-based persistence layer for Board Membership management.
 * Handles agent roles and permissions on Kanban boards.
 *
 * @module kanban/membership-store
 */

import { Logger } from '../utils/logger.js';
import { getSharedRedis } from '../infrastructure/redis/connection.js';
import {
  BoardMembership,
  BoardRole,
  BoardPermissions,
  DEFAULT_PERMISSIONS,
  KANBAN_KEYS,
  DEFAULT_TASK_TTL,
} from './types.js';

const getRedis = getSharedRedis;

/**
 * Add an agent as a member of a board
 *
 * @description Creates a membership record for an agent on a board with
 *              the specified role and default permissions for that role
 * @param {string} boardId - Board to add member to
 * @param {string} agentId - Agent to add
 * @param {string} sessionId - Agent's session ID
 * @param {BoardRole} role - Role to assign
 * @param {string} [invitedBy] - Agent ID who invited (for audit)
 * @param {Partial<BoardPermissions>} [customPermissions] - Override default permissions
 * @returns {Promise<BoardMembership>} The created membership
 *
 * @example
 * ```typescript
 * const membership = await addBoardMember(
 *   'board_abc123',
 *   'agent-1',
 *   'session-123',
 *   'member',
 *   'agent-owner'
 * );
 * ```
 */
export async function addBoardMember(
  boardId: string,
  agentId: string,
  sessionId: string,
  role: BoardRole,
  invitedBy?: string,
  customPermissions?: Partial<BoardPermissions>
): Promise<BoardMembership> {
  const client = await getRedis();
  const now = Date.now();

  // Get default permissions for role and apply any overrides
  const permissions: BoardPermissions = {
    ...DEFAULT_PERMISSIONS[role],
    ...customPermissions,
  };

  const membership: BoardMembership = {
    boardId,
    agentId,
    sessionId,
    role,
    joinedAt: now,
    invitedBy,
    permissions,
  };

  const pipeline = client.pipeline();

  // Store membership data
  const membershipKey = KANBAN_KEYS.membership(boardId, agentId);
  pipeline.setex(membershipKey, DEFAULT_TASK_TTL, JSON.stringify(membership));

  // Add agent to board's members set
  pipeline.sadd(KANBAN_KEYS.boardMembers(boardId), agentId);
  pipeline.expire(KANBAN_KEYS.boardMembers(boardId), DEFAULT_TASK_TTL);

  // Add board to agent's boards set
  pipeline.sadd(KANBAN_KEYS.agentBoards(agentId), boardId);
  pipeline.expire(KANBAN_KEYS.agentBoards(agentId), DEFAULT_TASK_TTL);

  await pipeline.exec();

  Logger.debug(`membership-store: added ${agentId} as ${role} on board ${boardId}`);

  return membership;
}

/**
 * Get an agent's membership on a board
 *
 * @description Retrieves the membership record for an agent on a specific board
 * @param {string} boardId - Board to check
 * @param {string} agentId - Agent to look up
 * @returns {Promise<BoardMembership | null>} Membership if found, null otherwise
 *
 * @example
 * ```typescript
 * const membership = await getBoardMember('board_abc123', 'agent-1');
 * if (membership) {
 *   console.log(`Agent has role: ${membership.role}`);
 * }
 * ```
 */
export async function getBoardMember(
  boardId: string,
  agentId: string
): Promise<BoardMembership | null> {
  const client = await getRedis();
  const data = await client.get(KANBAN_KEYS.membership(boardId, agentId));

  if (!data) {
    return null;
  }

  try {
    return JSON.parse(data) as BoardMembership;
  } catch {
    Logger.error(`membership-store: failed to parse membership ${boardId}:${agentId}`);
    return null;
  }
}

/**
 * List all members of a board
 *
 * @description Retrieves all agent memberships for a board
 * @param {string} boardId - Board to query
 * @returns {Promise<BoardMembership[]>} Array of memberships
 *
 * @example
 * ```typescript
 * const members = await listBoardMembers('board_abc123');
 * console.log(`Board has ${members.length} members`);
 * ```
 */
export async function listBoardMembers(boardId: string): Promise<BoardMembership[]> {
  const client = await getRedis();
  const agentIds = await client.smembers(KANBAN_KEYS.boardMembers(boardId));

  if (agentIds.length === 0) {
    return [];
  }

  const memberships: BoardMembership[] = [];
  for (const agentId of agentIds) {
    const membership = await getBoardMember(boardId, agentId);
    if (membership) {
      memberships.push(membership);
    }
  }

  return memberships;
}

/**
 * List all boards an agent is a member of
 *
 * @description Retrieves all board IDs where the agent has membership
 * @param {string} agentId - Agent to query
 * @returns {Promise<string[]>} Array of board IDs
 *
 * @example
 * ```typescript
 * const boardIds = await listAgentBoards('agent-1');
 * ```
 */
export async function listAgentBoards(agentId: string): Promise<string[]> {
  const client = await getRedis();
  return client.smembers(KANBAN_KEYS.agentBoards(agentId));
}

/**
 * Update an agent's role on a board
 *
 * @description Changes the agent's role and updates permissions accordingly
 * @param {string} boardId - Board to update
 * @param {string} agentId - Agent to update
 * @param {BoardRole} newRole - New role to assign
 * @param {Partial<BoardPermissions>} [customPermissions] - Custom permission overrides
 * @returns {Promise<BoardMembership | null>} Updated membership or null if not found
 *
 * @example
 * ```typescript
 * await updateMemberRole('board_abc123', 'agent-1', 'admin');
 * ```
 */
export async function updateMemberRole(
  boardId: string,
  agentId: string,
  newRole: BoardRole,
  customPermissions?: Partial<BoardPermissions>
): Promise<BoardMembership | null> {
  const client = await getRedis();
  const membership = await getBoardMember(boardId, agentId);

  if (!membership) {
    return null;
  }

  // Prevent escalation to owner role (owner can only be set by board creator)
  if (newRole === 'owner' && membership.role !== 'owner') {
    Logger.warn(`membership-store: blocked escalation to owner for ${agentId} on board ${boardId}`);
    return null;
  }

  // Update role and permissions
  membership.role = newRole;
  membership.permissions = {
    ...DEFAULT_PERMISSIONS[newRole],
    ...customPermissions,
  };

  await client.setex(
    KANBAN_KEYS.membership(boardId, agentId),
    DEFAULT_TASK_TTL,
    JSON.stringify(membership)
  );

  Logger.debug(`membership-store: updated ${agentId} role to ${newRole} on board ${boardId}`);

  return membership;
}

/**
 * Update an agent's specific permissions on a board
 *
 * @description Updates individual permission flags without changing the role
 * @param {string} boardId - Board to update
 * @param {string} agentId - Agent to update
 * @param {Partial<BoardPermissions>} permissionUpdates - Permissions to change
 * @returns {Promise<BoardMembership | null>} Updated membership or null if not found
 *
 * @example
 * ```typescript
 * // Give a member permission to assign tasks
 * await updateMemberPermissions('board_abc123', 'agent-1', {
 *   canAssignTasks: true,
 * });
 * ```
 */
export async function updateMemberPermissions(
  boardId: string,
  agentId: string,
  permissionUpdates: Partial<BoardPermissions>
): Promise<BoardMembership | null> {
  const client = await getRedis();
  const membership = await getBoardMember(boardId, agentId);

  if (!membership) {
    return null;
  }

  // Merge permission updates
  membership.permissions = {
    ...membership.permissions,
    ...permissionUpdates,
  };

  await client.setex(
    KANBAN_KEYS.membership(boardId, agentId),
    DEFAULT_TASK_TTL,
    JSON.stringify(membership)
  );

  Logger.debug(`membership-store: updated permissions for ${agentId} on board ${boardId}`);

  return membership;
}

/**
 * Remove an agent from a board
 *
 * @description Removes the agent's membership, preventing further access
 * @param {string} boardId - Board to remove from
 * @param {string} agentId - Agent to remove
 * @returns {Promise<boolean>} True if removed, false if not found
 *
 * @example
 * ```typescript
 * await removeBoardMember('board_abc123', 'agent-1');
 * ```
 */
export async function removeBoardMember(boardId: string, agentId: string): Promise<boolean> {
  const client = await getRedis();
  const membership = await getBoardMember(boardId, agentId);

  if (!membership) {
    return false;
  }

  const pipeline = client.pipeline();

  // Remove membership data
  pipeline.del(KANBAN_KEYS.membership(boardId, agentId));

  // Remove from board's members set
  pipeline.srem(KANBAN_KEYS.boardMembers(boardId), agentId);

  // Remove from agent's boards set
  pipeline.srem(KANBAN_KEYS.agentBoards(agentId), boardId);

  await pipeline.exec();

  Logger.debug(`membership-store: removed ${agentId} from board ${boardId}`);

  return true;
}

/**
 * Check if an agent is a member of a board
 *
 * @description Quick membership check without fetching full data
 * @param {string} boardId - Board to check
 * @param {string} agentId - Agent to check
 * @returns {Promise<boolean>} True if agent is a member
 *
 * @example
 * ```typescript
 * if (await isBoardMember('board_abc123', 'agent-1')) {
 *   // Allow access
 * }
 * ```
 */
export async function isBoardMember(boardId: string, agentId: string): Promise<boolean> {
  const client = await getRedis();
  return (await client.sismember(KANBAN_KEYS.boardMembers(boardId), agentId)) === 1;
}

/**
 * Check if an agent has a specific permission on a board
 *
 * @description Verifies that an agent has a particular permission
 * @param {string} boardId - Board to check
 * @param {string} agentId - Agent to check
 * @param {keyof BoardPermissions} permission - Permission to verify
 * @returns {Promise<boolean>} True if agent has the permission
 *
 * @example
 * ```typescript
 * if (await hasPermission('board_abc123', 'agent-1', 'canAssignTasks')) {
 *   // Allow task assignment
 * }
 * ```
 */
export async function hasPermission(
  boardId: string,
  agentId: string,
  permission: keyof BoardPermissions
): Promise<boolean> {
  const membership = await getBoardMember(boardId, agentId);

  if (!membership) {
    return false;
  }

  return membership.permissions[permission] === true;
}

/**
 * Get all permissions for an agent on a board
 *
 * @description Returns the full permission set for the agent
 * @param {string} boardId - Board to check
 * @param {string} agentId - Agent to check
 * @returns {Promise<BoardPermissions | null>} Permissions or null if not a member
 *
 * @example
 * ```typescript
 * const perms = await getAgentPermissions('board_abc123', 'agent-1');
 * if (perms?.canDeleteTasks) {
 *   // Allow task deletion
 * }
 * ```
 */
export async function getAgentPermissions(
  boardId: string,
  agentId: string
): Promise<BoardPermissions | null> {
  const membership = await getBoardMember(boardId, agentId);
  return membership?.permissions ?? null;
}

/**
 * Count members on a board
 *
 * @description Quick count without fetching full member data
 * @param {string} boardId - Board to count
 * @returns {Promise<number>} Number of members
 *
 * @example
 * ```typescript
 * const count = await countBoardMembers('board_abc123');
 * ```
 */
export async function countBoardMembers(boardId: string): Promise<number> {
  const client = await getRedis();
  return client.scard(KANBAN_KEYS.boardMembers(boardId));
}

/**
 * Get members by role on a board
 *
 * @description Lists members filtered by their role
 * @param {string} boardId - Board to query
 * @param {BoardRole} role - Role to filter by
 * @returns {Promise<BoardMembership[]>} Members with the specified role
 *
 * @example
 * ```typescript
 * const admins = await getMembersByRole('board_abc123', 'admin');
 * ```
 */
export async function getMembersByRole(
  boardId: string,
  role: BoardRole
): Promise<BoardMembership[]> {
  const allMembers = await listBoardMembers(boardId);
  return allMembers.filter((m) => m.role === role);
}

/**
 * Transfer board ownership
 *
 * @description Transfers the 'owner' role to a new agent. The previous owner
 *              is demoted to 'admin'.
 * @param {string} boardId - Board to transfer
 * @param {string} currentOwnerId - Current owner's agent ID
 * @param {string} newOwnerId - New owner's agent ID
 * @param {string} newOwnerSessionId - New owner's session ID
 * @returns {Promise<boolean>} True if transferred, false if failed
 *
 * @example
 * ```typescript
 * await transferOwnership('board_abc123', 'agent-old', 'agent-new', 'session-new');
 * ```
 */
export async function transferOwnership(
  boardId: string,
  currentOwnerId: string,
  newOwnerId: string,
  newOwnerSessionId: string
): Promise<boolean> {
  const currentOwner = await getBoardMember(boardId, currentOwnerId);

  if (!currentOwner || currentOwner.role !== 'owner') {
    Logger.warn(`membership-store: ${currentOwnerId} is not the owner of board ${boardId}`);
    return false;
  }

  // Check if new owner is already a member
  const existingMembership = await getBoardMember(boardId, newOwnerId);

  if (!existingMembership) {
    // Add new owner as member first
    await addBoardMember(
      boardId,
      newOwnerId,
      newOwnerSessionId,
      'owner',
      currentOwnerId
    );
  } else {
    // Upgrade to owner
    await updateMemberRole(boardId, newOwnerId, 'owner');
  }

  // Demote current owner to admin
  await updateMemberRole(boardId, currentOwnerId, 'admin');

  Logger.debug(
    `membership-store: transferred ownership of ${boardId} from ${currentOwnerId} to ${newOwnerId}`
  );

  return true;
}
