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
 * Board Store
 *
 * Redis-based persistence layer for Kanban Board management.
 * Boards are named task collections that can be standalone (per-session)
 * or shared across sessions via workspaces.
 *
 * @module kanban/board-store
 */

import { v4 as uuidv4 } from 'uuid';
import { Logger } from '../utils/logger.js';
import { getSharedRedis } from '../infrastructure/redis/connection.js';
import {
  KanbanBoard,
  CreateBoardInput,
  BoardVisibility,
  BoardEvent,
  KANBAN_KEYS,
  DEFAULT_TASK_TTL,
} from './types.js';

const getRedis = getSharedRedis;

/** Default board name for backward compatibility */
export const DEFAULT_BOARD_NAME = 'default';

/** Maximum events to keep per board */
const MAX_BOARD_EVENTS = 100;

/**
 * Generate a unique board ID
 *
 * @description Creates a board ID with 'board_' prefix followed by UUID
 * @returns {string} Unique board ID (format: board_xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)
 * @internal
 */
function generateBoardId(): string {
  return `board_${uuidv4()}`;
}

/**
 * Create a new Kanban board
 *
 * @description Creates a board that can hold tasks. Boards can be standalone
 *              (private to a session) or shared via workspaces.
 * @param {CreateBoardInput} input - Board creation parameters
 * @param {string} input.name - Human-readable board name (e.g., "frontend", "backend")
 * @param {string} [input.description] - Optional board description
 * @param {string} input.sessionId - Origin session ID
 * @param {string} [input.workspaceId] - Optional workspace for cross-session sharing
 * @param {BoardVisibility} [input.visibility='private'] - Board visibility level
 * @param {string} input.createdBy - Agent ID creating the board
 * @param {string[]} [input.labels] - Board-level labels
 * @returns {Promise<KanbanBoard>} The created board with generated ID and timestamps
 *
 * @example
 * ```typescript
 * const board = await createBoard({
 *   name: 'frontend',
 *   description: 'Frontend development tasks',
 *   sessionId: 'session-123',
 *   createdBy: 'agent-1',
 *   visibility: 'workspace',
 *   workspaceId: 'ws_abc123',
 * });
 * ```
 */
export async function createBoard(input: CreateBoardInput): Promise<KanbanBoard> {
  const client = await getRedis();
  const id = generateBoardId();
  const now = Date.now();

  const board: KanbanBoard = {
    id,
    name: input.name,
    description: input.description,
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    visibility: input.visibility ?? 'private',
    createdAt: now,
    updatedAt: now,
    createdBy: input.createdBy,
    labels: input.labels,
    taskCount: 0,
    activeAgentCount: 0,
  };

  const pipeline = client.pipeline();

  // Store board data
  pipeline.setex(KANBAN_KEYS.board(id), DEFAULT_TASK_TTL, JSON.stringify(board));

  // Add to session's boards
  pipeline.sadd(KANBAN_KEYS.boardsBySession(input.sessionId), id);
  pipeline.expire(KANBAN_KEYS.boardsBySession(input.sessionId), DEFAULT_TASK_TTL);

  // Add to workspace's boards if workspace specified
  if (input.workspaceId) {
    pipeline.sadd(KANBAN_KEYS.boardsByWorkspace(input.workspaceId), id);
    pipeline.expire(KANBAN_KEYS.boardsByWorkspace(input.workspaceId), DEFAULT_TASK_TTL);
  }

  await pipeline.exec();

  // Emit board-created event
  await emitBoardEvent({
    type: 'board-created',
    boardId: id,
    agentId: input.createdBy,
    sessionId: input.sessionId,
    timestamp: now,
    data: { name: input.name, visibility: board.visibility },
  });

  Logger.debug(`board-store: created board '${input.name}' (${id})`);

  return board;
}

/**
 * Get or create the default board for a session
 *
 * @description Ensures backward compatibility by providing a default board
 *              for sessions that don't use multi-board. Creates one if it
 *              doesn't exist.
 * @param {string} sessionId - Session ID
 * @param {string} createdBy - Agent ID for creation (if needed)
 * @returns {Promise<KanbanBoard>} The default board for the session
 *
 * @example
 * ```typescript
 * // Used during lazy migration
 * const defaultBoard = await getOrCreateDefaultBoard('session-123', 'agent-1');
 * ```
 */
export async function getOrCreateDefaultBoard(
  sessionId: string,
  createdBy: string
): Promise<KanbanBoard> {
  // Check if default board exists
  const boards = await listBoardsForSession(sessionId);
  const defaultBoard = boards.find((b) => b.name === DEFAULT_BOARD_NAME);

  if (defaultBoard) {
    return defaultBoard;
  }

  // Create default board
  return createBoard({
    name: DEFAULT_BOARD_NAME,
    description: 'Default board (auto-created for backward compatibility)',
    sessionId,
    visibility: 'private',
    createdBy,
  });
}

/**
 * Retrieve a board by its ID
 *
 * @description Fetches board data from Redis by ID
 * @param {string} boardId - The board ID to retrieve
 * @returns {Promise<KanbanBoard | null>} The board if found, null otherwise
 *
 * @example
 * ```typescript
 * const board = await getBoard('board_abc123');
 * if (board) {
 *   console.log(`Found: ${board.name}`);
 * }
 * ```
 */
export async function getBoard(boardId: string): Promise<KanbanBoard | null> {
  const client = await getRedis();
  const data = await client.get(KANBAN_KEYS.board(boardId));

  if (!data) {
    return null;
  }

  try {
    return JSON.parse(data) as KanbanBoard;
  } catch {
    Logger.error(`board-store: failed to parse board ${boardId}`);
    return null;
  }
}

/**
 * List all boards for a session
 *
 * @description Retrieves all boards that belong to a session
 * @param {string} sessionId - Session ID to look up
 * @returns {Promise<KanbanBoard[]>} Array of boards belonging to the session
 *
 * @example
 * ```typescript
 * const boards = await listBoardsForSession('session-123');
 * console.log(`Session has ${boards.length} boards`);
 * ```
 */
export async function listBoardsForSession(sessionId: string): Promise<KanbanBoard[]> {
  const client = await getRedis();
  const boardIds = await client.smembers(KANBAN_KEYS.boardsBySession(sessionId));

  if (boardIds.length === 0) {
    return [];
  }

  const boards: KanbanBoard[] = [];
  for (const boardId of boardIds) {
    const board = await getBoard(boardId);
    if (board) {
      boards.push(board);
    }
  }

  return boards;
}

/**
 * List all boards in a workspace
 *
 * @description Retrieves all boards that are shared within a workspace
 * @param {string} workspaceId - Workspace ID to look up
 * @returns {Promise<KanbanBoard[]>} Array of boards in the workspace
 *
 * @example
 * ```typescript
 * const boards = await listBoardsForWorkspace('ws_abc123');
 * ```
 */
export async function listBoardsForWorkspace(workspaceId: string): Promise<KanbanBoard[]> {
  const client = await getRedis();
  const boardIds = await client.smembers(KANBAN_KEYS.boardsByWorkspace(workspaceId));

  if (boardIds.length === 0) {
    return [];
  }

  const boards: KanbanBoard[] = [];
  for (const boardId of boardIds) {
    const board = await getBoard(boardId);
    if (board) {
      boards.push(board);
    }
  }

  return boards;
}

/**
 * List all boards accessible to a session
 *
 * @description Returns boards from the session itself and from any workspaces
 *              the session belongs to. Respects visibility settings.
 * @param {string} sessionId - Session ID
 * @param {string[]} [workspaceIds] - Workspace IDs the session belongs to
 * @returns {Promise<KanbanBoard[]>} Array of all accessible boards
 *
 * @example
 * ```typescript
 * const allBoards = await listAccessibleBoards('session-123', ['ws_abc', 'ws_def']);
 * ```
 */
export async function listAccessibleBoards(
  sessionId: string,
  workspaceIds?: string[]
): Promise<KanbanBoard[]> {
  const boardMap = new Map<string, KanbanBoard>();

  // Get session's own boards
  const sessionBoards = await listBoardsForSession(sessionId);
  for (const board of sessionBoards) {
    boardMap.set(board.id, board);
  }

  // Get boards from workspaces
  if (workspaceIds && workspaceIds.length > 0) {
    for (const wsId of workspaceIds) {
      const wsBoards = await listBoardsForWorkspace(wsId);
      for (const board of wsBoards) {
        // Only include if visible to workspace members
        if (board.visibility === 'workspace' || board.visibility === 'public') {
          boardMap.set(board.id, board);
        }
      }
    }
  }

  return Array.from(boardMap.values());
}

/**
 * Update board metadata
 *
 * @description Updates board name, description, visibility, or labels
 * @param {string} boardId - Board to update
 * @param {Object} updates - Fields to update
 * @param {string} [updates.name] - New board name
 * @param {string} [updates.description] - New description
 * @param {BoardVisibility} [updates.visibility] - New visibility level
 * @param {string[]} [updates.labels] - New labels
 * @returns {Promise<KanbanBoard | null>} Updated board or null if not found
 *
 * @example
 * ```typescript
 * const updated = await updateBoard('board_abc123', {
 *   name: 'frontend-v2',
 *   visibility: 'workspace',
 * });
 * ```
 */
export async function updateBoard(
  boardId: string,
  updates: {
    name?: string;
    description?: string;
    visibility?: BoardVisibility;
    labels?: string[];
  }
): Promise<KanbanBoard | null> {
  const client = await getRedis();
  const board = await getBoard(boardId);

  if (!board) {
    return null;
  }

  // Apply updates
  if (updates.name !== undefined) {
    board.name = updates.name;
  }
  if (updates.description !== undefined) {
    board.description = updates.description;
  }
  if (updates.visibility !== undefined) {
    board.visibility = updates.visibility;
  }
  if (updates.labels !== undefined) {
    board.labels = updates.labels;
  }
  board.updatedAt = Date.now();

  await client.setex(KANBAN_KEYS.board(boardId), DEFAULT_TASK_TTL, JSON.stringify(board));

  Logger.debug(`board-store: updated board ${boardId}`);

  return board;
}

/**
 * Update board task count
 *
 * @description Increments or decrements the denormalized task count
 * @param {string} boardId - Board to update
 * @param {number} delta - Change amount (+1 for add, -1 for remove)
 * @returns {Promise<void>}
 * @internal
 */
export async function updateBoardTaskCount(boardId: string, delta: number): Promise<void> {
  const board = await getBoard(boardId);
  if (!board) return;

  board.taskCount = Math.max(0, board.taskCount + delta);
  board.updatedAt = Date.now();

  const client = await getRedis();
  await client.setex(KANBAN_KEYS.board(boardId), DEFAULT_TASK_TTL, JSON.stringify(board));
}

/**
 * Update board active agent count
 *
 * @description Updates the denormalized count of agents working on board tasks
 * @param {string} boardId - Board to update
 * @param {number} delta - Change amount
 * @returns {Promise<void>}
 * @internal
 */
export async function updateBoardAgentCount(boardId: string, delta: number): Promise<void> {
  const board = await getBoard(boardId);
  if (!board) return;

  board.activeAgentCount = Math.max(0, board.activeAgentCount + delta);
  board.updatedAt = Date.now();

  const client = await getRedis();
  await client.setex(KANBAN_KEYS.board(boardId), DEFAULT_TASK_TTL, JSON.stringify(board));
}

/**
 * Share a board with a workspace
 *
 * @description Adds a board to a workspace, making it accessible to all
 *              workspace members (according to visibility settings)
 * @param {string} boardId - Board to share
 * @param {string} workspaceId - Workspace to share with
 * @param {BoardVisibility} [visibility='workspace'] - Visibility for workspace members
 * @returns {Promise<KanbanBoard | null>} Updated board or null if not found
 *
 * @example
 * ```typescript
 * await shareBoard('board_abc123', 'ws_xyz789', 'workspace');
 * ```
 */
export async function shareBoard(
  boardId: string,
  workspaceId: string,
  visibility: BoardVisibility = 'workspace'
): Promise<KanbanBoard | null> {
  const client = await getRedis();
  const board = await getBoard(boardId);

  if (!board) {
    return null;
  }

  // Update board
  board.workspaceId = workspaceId;
  board.visibility = visibility;
  board.updatedAt = Date.now();

  const pipeline = client.pipeline();

  // Update board data
  pipeline.setex(KANBAN_KEYS.board(boardId), DEFAULT_TASK_TTL, JSON.stringify(board));

  // Add to workspace's boards
  pipeline.sadd(KANBAN_KEYS.boardsByWorkspace(workspaceId), boardId);
  pipeline.expire(KANBAN_KEYS.boardsByWorkspace(workspaceId), DEFAULT_TASK_TTL);

  await pipeline.exec();

  // Emit event
  await emitBoardEvent({
    type: 'board-shared',
    boardId,
    agentId: board.createdBy,
    sessionId: board.sessionId,
    timestamp: board.updatedAt,
    data: { workspaceId, visibility },
  });

  Logger.debug(`board-store: shared board ${boardId} with workspace ${workspaceId}`);

  return board;
}

/**
 * Delete a board
 *
 * @description Permanently deletes a board. Tasks on the board are NOT deleted
 *              but will become orphaned (should be migrated first).
 * @param {string} boardId - Board to delete
 * @returns {Promise<boolean>} True if deleted, false if not found
 *
 * @example
 * ```typescript
 * const deleted = await deleteBoard('board_abc123');
 * ```
 */
export async function deleteBoard(boardId: string): Promise<boolean> {
  const client = await getRedis();
  const board = await getBoard(boardId);

  if (!board) {
    return false;
  }

  const pipeline = client.pipeline();

  // Remove board data
  pipeline.del(KANBAN_KEYS.board(boardId));

  // Remove board tasks index
  pipeline.del(KANBAN_KEYS.boardTasks(boardId));

  // Remove board members
  pipeline.del(KANBAN_KEYS.boardMembers(boardId));

  // Remove board events
  pipeline.del(KANBAN_KEYS.boardEvents(boardId));

  // Remove from session's boards
  pipeline.srem(KANBAN_KEYS.boardsBySession(board.sessionId), boardId);

  // Remove from workspace's boards if applicable
  if (board.workspaceId) {
    pipeline.srem(KANBAN_KEYS.boardsByWorkspace(board.workspaceId), boardId);
  }

  await pipeline.exec();

  Logger.debug(`board-store: deleted board ${boardId}`);

  return true;
}

/**
 * Emit a board event
 *
 * @description Stores an event in the board's event log and publishes to Pub/Sub
 * @param {BoardEvent} event - Event to emit
 * @returns {Promise<void>}
 * @internal
 */
async function emitBoardEvent(event: BoardEvent): Promise<void> {
  const client = await getRedis();
  const eventKey = KANBAN_KEYS.boardEvents(event.boardId);

  const pipeline = client.pipeline();

  // Store event
  pipeline.lpush(eventKey, JSON.stringify(event));
  pipeline.ltrim(eventKey, 0, MAX_BOARD_EVENTS - 1);
  pipeline.expire(eventKey, DEFAULT_TASK_TTL);

  // Publish to board channel
  pipeline.publish(KANBAN_KEYS.boardChannel(event.boardId), JSON.stringify(event));

  await pipeline.exec();
}

/**
 * Get recent board events
 *
 * @description Retrieves recent events from a board's event log
 * @param {string} boardId - Board to query
 * @param {number} [limit=20] - Maximum events to return
 * @returns {Promise<BoardEvent[]>} Array of recent events (newest first)
 *
 * @example
 * ```typescript
 * const events = await getBoardEvents('board_abc123', 10);
 * ```
 */
export async function getBoardEvents(boardId: string, limit: number = 20): Promise<BoardEvent[]> {
  const client = await getRedis();
  const events = await client.lrange(KANBAN_KEYS.boardEvents(boardId), 0, limit - 1);

  return events
    .map((e) => {
      try {
        return JSON.parse(e) as BoardEvent;
      } catch {
        return null;
      }
    })
    .filter((e): e is BoardEvent => e !== null);
}

/**
 * Check if a board exists
 *
 * @description Quick check for board existence without fetching full data
 * @param {string} boardId - Board ID to check
 * @returns {Promise<boolean>} True if board exists
 */
export async function boardExists(boardId: string): Promise<boolean> {
  const client = await getRedis();
  return (await client.exists(KANBAN_KEYS.board(boardId))) === 1;
}
