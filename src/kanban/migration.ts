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
 * Migration Module
 *
 * Handles lazy migration of legacy tasks to the multi-board system.
 * Tasks without boardId are automatically assigned to a default board
 * when accessed.
 *
 * @module kanban/migration
 */

import { Redis } from 'ioredis';
import { Logger } from '../utils/logger.js';
import { KanbanTask, KANBAN_KEYS, DEFAULT_TASK_TTL, PRIORITY_SCORES } from './types.js';
import { getOrCreateDefaultBoard, updateBoardTaskCount } from './board-store.js';
import { addBoardMember, isBoardMember } from './membership-store.js';

/** Redis client (lazy init) */
let redis: Redis | null = null;

/** Track migrated sessions to avoid duplicate work */
const migratedSessions = new Set<string>();

/** Track migrated tasks to avoid duplicate work */
const migratedTasks = new Set<string>();

/**
 * Get or create Redis connection
 *
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
 * Migrate a single task to the multi-board system
 *
 * @description Assigns a task to the default board if it doesn't have a boardId.
 *              This is called lazily when a task is accessed.
 * @param {KanbanTask} task - Task to migrate
 * @param {string} [migratingAgentId] - Agent performing the migration (for board creation if needed)
 * @returns {Promise<KanbanTask>} Migrated task with boardId
 *
 * @example
 * ```typescript
 * const task = await getTask(taskId);
 * if (!task.boardId) {
 *   const migratedTask = await migrateTask(task, agentId);
 * }
 * ```
 */
export async function migrateTask(
  task: KanbanTask,
  migratingAgentId?: string
): Promise<KanbanTask> {
  // Skip if already migrated
  if (task.boardId) {
    return task;
  }

  // Skip if already processed in this session
  if (migratedTasks.has(task.id)) {
    return task;
  }

  const client = await getRedis();

  // Get or create default board for the session
  const agentId = migratingAgentId || task.createdBy;
  const defaultBoard = await getOrCreateDefaultBoard(task.sessionId, agentId);

  // Update task with boardId
  task.boardId = defaultBoard.id;

  // Save updated task
  await client.setex(KANBAN_KEYS.task(task.id), DEFAULT_TASK_TTL, JSON.stringify(task));

  // Add task to board's task index
  const priorityScore = PRIORITY_SCORES[task.priority] || 50;
  await client.zadd(KANBAN_KEYS.boardTasks(defaultBoard.id), priorityScore, task.id);
  await client.expire(KANBAN_KEYS.boardTasks(defaultBoard.id), DEFAULT_TASK_TTL);

  // Update board task count
  await updateBoardTaskCount(defaultBoard.id, 1);

  // Mark as migrated
  migratedTasks.add(task.id);

  Logger.debug(`migration: migrated task ${task.id} to board ${defaultBoard.id}`);

  return task;
}

/**
 * Migrate all tasks in a session to the multi-board system
 *
 * @description Batch migrates all legacy tasks in a session to the default board.
 *              This is called once per session when first accessed.
 * @param {string} sessionId - Session to migrate
 * @param {string} agentId - Agent performing the migration
 * @returns {Promise<{ migratedCount: number; boardId: string }>} Migration result
 *
 * @example
 * ```typescript
 * // Called when session is first accessed
 * const result = await migrateSession('session-123', 'agent-1');
 * console.log(`Migrated ${result.migratedCount} tasks to ${result.boardId}`);
 * ```
 */
export async function migrateSession(
  sessionId: string,
  agentId: string
): Promise<{ migratedCount: number; boardId: string }> {
  // Skip if already migrated
  if (migratedSessions.has(sessionId)) {
    const defaultBoard = await getOrCreateDefaultBoard(sessionId, agentId);
    return { migratedCount: 0, boardId: defaultBoard.id };
  }

  const client = await getRedis();

  // Get or create default board
  const defaultBoard = await getOrCreateDefaultBoard(sessionId, agentId);

  // Get all task IDs in the session
  const taskIds = await client.zrange(KANBAN_KEYS.tasks(sessionId), 0, -1);

  let migratedCount = 0;

  for (const taskId of taskIds) {
    const taskData = await client.get(KANBAN_KEYS.task(taskId));
    if (!taskData) continue;

    try {
      const task = JSON.parse(taskData) as KanbanTask;

      // Skip if already has boardId
      if (task.boardId) continue;

      // Migrate task
      await migrateTask(task, agentId);
      migratedCount++;
    } catch (error) {
      Logger.error(`migration: failed to migrate task ${taskId}: ${error}`);
    }
  }

  // Mark session as migrated
  migratedSessions.add(sessionId);

  Logger.info(
    `migration: migrated ${migratedCount} tasks in session ${sessionId} to board ${defaultBoard.id}`
  );

  return { migratedCount, boardId: defaultBoard.id };
}

/**
 * Ensure agent membership on default board
 *
 * @description When an agent accesses a board, ensure they have membership.
 *              For backward compatibility, agents accessing the default board
 *              are automatically added as members.
 * @param {string} boardId - Board ID
 * @param {string} agentId - Agent ID
 * @param {string} sessionId - Session ID
 * @returns {Promise<void>}
 *
 * @example
 * ```typescript
 * await ensureBoardMembership(defaultBoard.id, agentId, sessionId);
 * ```
 */
export async function ensureBoardMembership(
  boardId: string,
  agentId: string,
  sessionId: string
): Promise<void> {
  const isMember = await isBoardMember(boardId, agentId);

  if (!isMember) {
    // Auto-add as member (for backward compatibility)
    await addBoardMember(boardId, agentId, sessionId, 'member');
    Logger.debug(`migration: auto-added ${agentId} as member of board ${boardId}`);
  }
}

/**
 * Check if a session needs migration
 *
 * @description Determines if a session has legacy tasks that need migration
 * @param {string} sessionId - Session to check
 * @returns {Promise<boolean>} True if migration is needed
 *
 * @example
 * ```typescript
 * if (await needsMigration('session-123')) {
 *   await migrateSession('session-123', agentId);
 * }
 * ```
 */
export async function needsMigration(sessionId: string): Promise<boolean> {
  // Already migrated in this process
  if (migratedSessions.has(sessionId)) {
    return false;
  }

  const client = await getRedis();

  // Check if any task lacks boardId
  const taskIds = await client.zrange(KANBAN_KEYS.tasks(sessionId), 0, 10);

  for (const taskId of taskIds) {
    const taskData = await client.get(KANBAN_KEYS.task(taskId));
    if (!taskData) continue;

    try {
      const task = JSON.parse(taskData) as KanbanTask;
      if (!task.boardId) {
        return true;
      }
    } catch {
      // Ignore parse errors
    }
  }

  return false;
}

/**
 * Get migration status for a session
 *
 * @description Returns statistics about migrated vs legacy tasks
 * @param {string} sessionId - Session to check
 * @returns {Promise<{ total: number; migrated: number; legacy: number }>} Migration stats
 *
 * @example
 * ```typescript
 * const status = await getMigrationStatus('session-123');
 * console.log(`${status.migrated}/${status.total} tasks migrated`);
 * ```
 */
export async function getMigrationStatus(
  sessionId: string
): Promise<{ total: number; migrated: number; legacy: number }> {
  const client = await getRedis();

  const taskIds = await client.zrange(KANBAN_KEYS.tasks(sessionId), 0, -1);
  let migrated = 0;
  let legacy = 0;

  for (const taskId of taskIds) {
    const taskData = await client.get(KANBAN_KEYS.task(taskId));
    if (!taskData) continue;

    try {
      const task = JSON.parse(taskData) as KanbanTask;
      if (task.boardId) {
        migrated++;
      } else {
        legacy++;
      }
    } catch {
      // Ignore parse errors
    }
  }

  return {
    total: taskIds.length,
    migrated,
    legacy,
  };
}

/**
 * Reset migration state (for testing)
 *
 * @description Clears the in-memory migration tracking sets.
 *              Only use in tests.
 * @internal
 */
export function resetMigrationState(): void {
  migratedSessions.clear();
  migratedTasks.clear();
  Logger.debug('migration: reset migration state');
}

/**
 * Wrap a task getter with automatic migration
 *
 * @description Higher-order function that wraps task retrieval with automatic
 *              lazy migration. Use this to transparently migrate tasks on access.
 * @param {Function} getTaskFn - Original getTask function
 * @returns {Function} Wrapped function with migration
 *
 * @example
 * ```typescript
 * const getTaskWithMigration = withMigration(originalGetTask);
 * const task = await getTaskWithMigration(taskId, agentId);
 * // Task is automatically migrated if needed
 * ```
 */
export function withMigration<
  T extends (taskId: string, ...args: unknown[]) => Promise<KanbanTask | null>,
>(
  getTaskFn: T
): (taskId: string, agentId?: string, ...args: unknown[]) => Promise<KanbanTask | null> {
  return async (
    taskId: string,
    agentId?: string,
    ...args: unknown[]
  ): Promise<KanbanTask | null> => {
    const task = await getTaskFn(taskId, ...args);

    if (!task) {
      return null;
    }

    // Lazy migration
    if (!task.boardId) {
      return migrateTask(task, agentId);
    }

    return task;
  };
}
