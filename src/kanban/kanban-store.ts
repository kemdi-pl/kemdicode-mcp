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
 * Kanban Store
 *
 * Redis-based persistence layer for the Kanban system.
 *
 * @module kanban/kanban-store
 */

import { Redis } from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import { Logger } from '../utils/logger.js';
import { getSharedRedis } from '../infrastructure/redis/connection.js';
import {
  KanbanTask,
  TaskStatus,
  TaskPriority,
  CreateTaskInput,
  UpdateTaskInput,
  TaskEvent,
  TaskFilter,
  BoardSummary,
  KANBAN_KEYS,
  PRIORITY_SCORES,
  DEFAULT_TASK_TTL,
  COMPLETED_TASK_TTL,
  MAX_EVENTS,
} from './types.js';

const getRedis = getSharedRedis;

function safeParseJsonArray(value: string | undefined): string[] {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function safeParseInt(value: string | undefined, fallback?: number): number {
  const parsed = parseInt(value || '', 10);
  return isNaN(parsed) ? (fallback ?? 0) : parsed;
}

/**
 * Create a new task on the Kanban board
 *
 * @description Creates a new task with the provided input, stores it in Redis,
 *              sets up blocking relationships, and emits a task-created event
 * @param {CreateTaskInput} input - Task creation parameters
 * @param {string} input.sessionId - Session ID for the task
 * @param {string} input.title - Task title (max 200 chars)
 * @param {string} [input.description] - Detailed task description
 * @param {TaskPriority} [input.priority='normal'] - Task priority level
 * @param {string} input.createdBy - Agent ID creating the task
 * @param {string[]} [input.blockedBy] - Task IDs that block this task
 * @param {string[]} [input.relatedFiles] - Related file paths
 * @param {string[]} [input.labels] - Task labels for categorization
 * @param {number} [input.estimatedMinutes] - Estimated completion time
 * @returns {Promise<KanbanTask>} The created task with generated ID and timestamps
 *
 * @example
 * ```typescript
 * const task = await createTask({
 *   sessionId: 'session-123',
 *   title: 'Implement authentication',
 *   priority: 'high',
 *   createdBy: 'agent-1',
 *   labels: ['feature', 'auth'],
 * });
 * ```
 */
export async function createTask(input: CreateTaskInput): Promise<KanbanTask> {
  const client = await getRedis();

  const taskId = uuidv4();
  const now = Date.now();

  const task: KanbanTask = {
    id: taskId,
    sessionId: input.sessionId,
    boardId: input.boardId,
    title: input.title,
    description: input.description,
    status: 'backlog',
    priority: input.priority || 'normal',
    createdBy: input.createdBy,
    blockedBy: input.blockedBy || [],
    blocks: [],
    relatedFiles: input.relatedFiles || [],
    labels: input.labels || [],
    createdAt: now,
    updatedAt: now,
    estimatedMinutes: input.estimatedMinutes,
  };

  // Calculate score for sorting (priority + time)
  const score = PRIORITY_SCORES[task.priority] * 1000000000 + (1000000000 - now / 1000);

  // Store task data
  await client.hset(KANBAN_KEYS.task(taskId), {
    ...task,
    blockedBy: JSON.stringify(task.blockedBy),
    blocks: JSON.stringify(task.blocks),
    relatedFiles: JSON.stringify(task.relatedFiles),
    labels: JSON.stringify(task.labels),
  });

  // Add to session tasks ZSET
  await client.zadd(KANBAN_KEYS.tasks(input.sessionId), score, taskId);

  // Add to status index
  await client.sadd(KANBAN_KEYS.byStatus(input.sessionId, 'backlog'), taskId);

  // Set TTL
  await client.expire(KANBAN_KEYS.task(taskId), DEFAULT_TASK_TTL);

  // Emit event
  await emitEvent({
    type: 'task-created',
    taskId,
    agentId: input.createdBy,
    sessionId: input.sessionId,
    timestamp: now,
    data: { title: task.title, priority: task.priority },
  });

  // Update blockedBy relationships
  for (const blockingId of task.blockedBy) {
    await addBlocksRelation(blockingId, taskId);
  }

  Logger.debug(`kanban: created task ${taskId}: ${task.title}`);

  return task;
}

/**
 * Retrieve a task by its unique identifier
 *
 * @description Fetches a task from Redis by ID, deserializing JSON fields
 *              (blockedBy, blocks, relatedFiles, labels)
 * @param {string} taskId - Unique task identifier (UUID)
 * @returns {Promise<KanbanTask | null>} The task if found, null otherwise
 *
 * @example
 * ```typescript
 * const task = await getTask('550e8400-e29b-41d4-a716-446655440000');
 * if (task) {
 *   console.log(`Task: ${task.title}, Status: ${task.status}`);
 * }
 * ```
 */
export async function getTask(taskId: string): Promise<KanbanTask | null> {
  const client = await getRedis();

  const data = await client.hgetall(KANBAN_KEYS.task(taskId));

  if (!data || Object.keys(data).length === 0) {
    return null;
  }

  return {
    id: data.id,
    sessionId: data.sessionId,
    title: data.title,
    description: data.description || undefined,
    status: data.status as TaskStatus,
    priority: data.priority as TaskPriority,
    assignee: data.assignee || undefined,
    createdBy: data.createdBy,
    blockedBy: safeParseJsonArray(data.blockedBy),
    blocks: safeParseJsonArray(data.blocks),
    relatedFiles: safeParseJsonArray(data.relatedFiles),
    labels: safeParseJsonArray(data.labels),
    createdAt: safeParseInt(data.createdAt, 0),
    updatedAt: safeParseInt(data.updatedAt, 0),
    startedAt: data.startedAt ? safeParseInt(data.startedAt) : undefined,
    completedAt: data.completedAt ? safeParseInt(data.completedAt) : undefined,
    estimatedMinutes: data.estimatedMinutes ? safeParseInt(data.estimatedMinutes) : undefined,
    actualMinutes: data.actualMinutes ? safeParseInt(data.actualMinutes) : undefined,
  };
}

/**
 * Update an existing task with new values
 *
 * @description Updates task fields, handles status transitions (emitting events),
 *              manages blocking relationships, and persists changes to Redis
 * @param {string} taskId - Unique task identifier
 * @param {UpdateTaskInput} update - Fields to update
 * @param {string} agentId - Agent ID performing the update
 * @returns {Promise<KanbanTask | null>} Updated task or null if not found
 * @throws {Error} Never throws - returns null on failure
 *
 * @example
 * ```typescript
 * const updated = await updateTask('task-123', {
 *   status: 'in_progress',
 *   priority: 'high',
 * }, 'agent-1');
 * ```
 */
export async function updateTask(
  taskId: string,
  update: UpdateTaskInput,
  agentId: string
): Promise<KanbanTask | null> {
  const client = await getRedis();

  const task = await getTask(taskId);
  if (!task) return null;

  const now = Date.now();
  const oldStatus = task.status;

  // Apply updates
  if (update.title !== undefined) task.title = update.title;
  if (update.description !== undefined) task.description = update.description;
  if (update.priority !== undefined) task.priority = update.priority;
  if (update.assignee !== undefined) task.assignee = update.assignee || undefined;
  if (update.relatedFiles !== undefined) task.relatedFiles = update.relatedFiles;
  if (update.labels !== undefined) task.labels = update.labels;
  if (update.estimatedMinutes !== undefined) task.estimatedMinutes = update.estimatedMinutes;

  // Handle status change
  let statusChanged = false;
  if (update.status !== undefined && update.status !== oldStatus) {
    task.status = update.status;
    statusChanged = true;

    // Handle status-specific updates (outside transaction - events should not be rolled back)
    if (update.status === 'in_progress' && !task.startedAt) {
      task.startedAt = now;
      await emitEvent({
        type: 'task-started',
        taskId,
        agentId,
        sessionId: task.sessionId,
        timestamp: now,
      });
    }

    if (update.status === 'done') {
      task.completedAt = now;
      if (task.startedAt) {
        task.actualMinutes = Math.round((now - task.startedAt) / 60000);
      }
    }
  }

  // Handle blockedBy changes (outside transaction - separate task updates)
  if (update.blockedBy !== undefined) {
    const oldBlockedBy = new Set(task.blockedBy);
    const newBlockedBy = new Set(update.blockedBy);

    // Remove old relations
    for (const old of oldBlockedBy) {
      if (!newBlockedBy.has(old)) {
        await removeBlocksRelation(old, taskId);
      }
    }

    // Add new relations
    for (const newId of newBlockedBy) {
      if (!oldBlockedBy.has(newId)) {
        await addBlocksRelation(newId, taskId);
      }
    }

    task.blockedBy = update.blockedBy;
  }

  task.updatedAt = now;

  // ATOMIC UPDATE: Use MULTI/EXEC for status indices and task data
  // This ensures consistency between status indices and task data
  const multi = client.multi();

  if (statusChanged) {
    // Update status indices atomically
    multi.srem(KANBAN_KEYS.byStatus(task.sessionId, oldStatus), taskId);
    multi.sadd(KANBAN_KEYS.byStatus(task.sessionId, task.status), taskId);
  }

  // Store updated task
  multi.hset(KANBAN_KEYS.task(taskId), {
    ...task,
    blockedBy: JSON.stringify(task.blockedBy),
    blocks: JSON.stringify(task.blocks),
    relatedFiles: JSON.stringify(task.relatedFiles),
    labels: JSON.stringify(task.labels),
    assignee: task.assignee || '',
    description: task.description || '',
    startedAt: task.startedAt?.toString() || '',
    completedAt: task.completedAt?.toString() || '',
    estimatedMinutes: task.estimatedMinutes?.toString() || '',
    actualMinutes: task.actualMinutes?.toString() || '',
  });

  // Set shorter TTL for completed tasks
  if (task.status === 'done') {
    multi.expire(KANBAN_KEYS.task(taskId), COMPLETED_TASK_TTL);
  }

  // Execute all operations atomically
  // In ioredis v5 with async/await, exec() returns results directly or throws on error
  await multi.exec();

  // Emit events outside transaction (they shouldn't be rolled back)
  if (statusChanged && task.status === 'done') {
    await emitEvent({
      type: 'task-completed',
      taskId,
      agentId,
      sessionId: task.sessionId,
      timestamp: now,
      data: { actualMinutes: task.actualMinutes },
    });
  }

  await emitEvent({
    type: 'task-updated',
    taskId,
    agentId,
    sessionId: task.sessionId,
    timestamp: now,
    data: update as unknown as Record<string, unknown>,
  });

  Logger.debug(`kanban: updated task ${taskId}`);

  return task;
}

/**
 * Claim a task for an agent (self-assignment)
 *
 * @description Allows an agent to claim an unassigned, unblocked task.
 *              Sets the agent as assignee and transitions status to 'in_progress'.
 *              Verifies blocking tasks are completed before allowing claim.
 *              Uses atomic Lua script to prevent race conditions.
 * @param {string} taskId - Task ID to claim
 * @param {string} agentId - Agent ID claiming the task
 * @returns {Promise<KanbanTask | null>} Claimed task or null if not found
 * @throws {Error} If task is already assigned to another agent
 * @throws {Error} If task is blocked by incomplete tasks
 *
 * @example
 * ```typescript
 * try {
 *   const task = await claimTask('task-123', 'agent-1');
 *   console.log(`Claimed: ${task?.title}`);
 * } catch (error) {
 *   console.error('Cannot claim:', error.message);
 * }
 * ```
 */
export async function claimTask(taskId: string, agentId: string): Promise<KanbanTask | null> {
  const client = await getRedis();

  // First, get task data and validate blocking conditions (non-atomic check)
  const task = await getTask(taskId);
  if (!task) {
    return null;
  }

  // Check if task is already assigned to another agent (early validation)
  if (task.assignee && task.assignee !== agentId) {
    throw new Error(`Task already assigned to ${task.assignee}`);
  }

  // Check blocking tasks (requires reading other tasks - cannot be atomic)
  if (task.blockedBy.length > 0) {
    for (const blockerId of task.blockedBy) {
      const blocker = await getTask(blockerId);
      if (blocker && blocker.status !== 'done') {
        throw new Error(`Task blocked by ${blockerId} (${blocker.title})`);
      }
    }
  }

  const now = Date.now();
  const startedAt = task.startedAt || now;

  // Atomically claim the task only if assignee hasn't changed
  // Using HSETNX pattern: claim only if assignee field is empty or equals current agent
  const luaScript = `
    local taskKey = KEYS[1]
    local byAgentKey = KEYS[2]
    local oldStatusKey = KEYS[3]
    local newStatusKey = KEYS[4]
    local agentId = ARGV[1]
    local taskId = ARGV[2]
    local now = ARGV[3]
    local startedAt = ARGV[4]
    local sessionId = ARGV[5]
    
    -- Check current assignee atomically
    local currentAssignee = redis.call('hget', taskKey, 'assignee')
    
    -- If already assigned to someone else, return error code
    if currentAssignee and currentAssignee ~= '' and currentAssignee ~= agentId then
      return {-1, currentAssignee}
    end
    
    -- If already assigned to this agent, return success (idempotent)
    if currentAssignee == agentId then
      return {1}
    end
    
    -- Atomically update task fields
    redis.call('hset', taskKey, 'assignee', agentId)
    redis.call('hset', taskKey, 'status', 'in_progress')
    redis.call('hset', taskKey, 'updatedAt', now)
    redis.call('hset', taskKey, 'startedAt', startedAt)
    
    -- Update agent index
    redis.call('sadd', byAgentKey, taskId)
    
    -- Update status indices
    redis.call('srem', oldStatusKey, taskId)
    redis.call('sadd', newStatusKey, taskId)
    
    return {0}
  `;

  const taskKey = KANBAN_KEYS.task(taskId);
  const byAgentKey = KANBAN_KEYS.byAgent(agentId);
  const oldStatusKey = KANBAN_KEYS.byStatus(task.sessionId, task.status);
  const newStatusKey = KANBAN_KEYS.byStatus(task.sessionId, 'in_progress');

  const result = (await client.eval(
    luaScript,
    4, // number of keys
    taskKey,
    byAgentKey,
    oldStatusKey,
    newStatusKey,
    agentId,
    taskId,
    now.toString(),
    startedAt.toString(),
    task.sessionId
  )) as [number, string?];

  const statusCode = result[0];

  // Handle results
  if (statusCode === -1) {
    // Task was assigned to someone else during our check
    const otherAssignee = result[1] as string;
    throw new Error(`Task already assigned to ${otherAssignee}`);
  }

  if (statusCode === 0 || statusCode === 1) {
    // Success (0 = newly claimed, 1 = already claimed by this agent)
    if (statusCode === 0) {
      // Emit event only on actual claim (not idempotent re-claim)
      await emitEvent({
        type: 'task-claimed',
        taskId,
        agentId,
        sessionId: task.sessionId,
        timestamp: now,
      });

      Logger.debug(`kanban: agent ${agentId} claimed task ${taskId}`);
    }

    // Return updated task
    return {
      ...task,
      assignee: agentId,
      status: 'in_progress',
      startedAt,
      updatedAt: now,
    };
  }

  // Unexpected result
  throw new Error('Unexpected result from claim operation');
}

/**
 * Assign a task to a specific agent (supervisor action)
 *
 * @description Supervisors can assign tasks to any agent, overriding current assignment.
 *              Updates agent indices and emits task-assigned event.
 * @param {string} taskId - Task ID to assign
 * @param {string} assigneeId - Target agent ID to assign the task to
 * @param {string} supervisorId - Supervisor agent ID making the assignment
 * @returns {Promise<KanbanTask | null>} Assigned task or null if not found
 *
 * @example
 * ```typescript
 * const task = await assignTask('task-123', 'worker-agent', 'supervisor-agent');
 * ```
 */
export async function assignTask(
  taskId: string,
  assigneeId: string,
  supervisorId: string
): Promise<KanbanTask | null> {
  const task = await getTask(taskId);
  if (!task) return null;

  const client = await getRedis();

  // Remove from old assignee
  if (task.assignee) {
    await client.srem(KANBAN_KEYS.byAgent(task.assignee), taskId);
  }

  // Add to new assignee
  await client.sadd(KANBAN_KEYS.byAgent(assigneeId), taskId);

  await emitEvent({
    type: 'task-assigned',
    taskId,
    agentId: supervisorId,
    sessionId: task.sessionId,
    timestamp: Date.now(),
    data: { assignee: assigneeId },
  });

  return updateTask(taskId, { assignee: assigneeId }, supervisorId);
}

/**
 * List tasks from a session with optional filtering
 *
 * @description Retrieves tasks sorted by priority, applying optional filters
 *              for status, priority, assignee, blocked state, and labels
 * @param {string} sessionId - Session ID to list tasks from
 * @param {TaskFilter} [filter] - Optional filter criteria
 * @param {TaskStatus|TaskStatus[]} [filter.status] - Filter by status(es)
 * @param {TaskPriority|TaskPriority[]} [filter.priority] - Filter by priority(ies)
 * @param {string} [filter.assignee] - Filter by assigned agent
 * @param {boolean} [filter.unassigned] - Show only unassigned tasks
 * @param {boolean} [filter.blocked] - Filter by blocked state
 * @param {string[]} [filter.labels] - Filter by labels (any match)
 * @param {number} [limit=50] - Maximum number of tasks to return
 * @returns {Promise<KanbanTask[]>} Array of matching tasks sorted by priority
 *
 * @example
 * ```typescript
 * // Get all high-priority unassigned tasks
 * const tasks = await listTasks('session-123', {
 *   priority: 'high',
 *   unassigned: true,
 *   blocked: false,
 * });
 * ```
 */
export async function listTasks(
  sessionId: string,
  filter?: TaskFilter,
  limit: number = 50
): Promise<KanbanTask[]> {
  const client = await getRedis();

  // Get all task IDs for session (sorted by priority)
  const taskIds = await client.zrevrange(KANBAN_KEYS.tasks(sessionId), 0, limit * 2);

  const tasks: KanbanTask[] = [];

  for (const taskId of taskIds) {
    if (tasks.length >= limit) break;

    const task = await getTask(taskId);
    if (!task) continue;

    // Apply filters
    if (filter) {
      if (filter.status) {
        const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
        if (!statuses.includes(task.status)) continue;
      }

      if (filter.priority) {
        const priorities = Array.isArray(filter.priority) ? filter.priority : [filter.priority];
        if (!priorities.includes(task.priority)) continue;
      }

      if (filter.assignee && task.assignee !== filter.assignee) continue;

      if (filter.unassigned && task.assignee) continue;

      if (filter.blocked !== undefined) {
        const isBlocked = task.blockedBy.length > 0;
        if (filter.blocked !== isBlocked) continue;
      }

      if (filter.labels && filter.labels.length > 0) {
        const hasLabel = filter.labels.some((l) => task.labels.includes(l));
        if (!hasLabel) continue;
      }

      if (filter.createdBy && task.createdBy !== filter.createdBy) continue;

      // Board ID filtering (multi-board support)
      if (filter.boardId && task.boardId !== filter.boardId) continue;

      if (filter.boardIds && filter.boardIds.length > 0) {
        if (!task.boardId || !filter.boardIds.includes(task.boardId)) continue;
      }
    }

    tasks.push(task);
  }

  return tasks;
}

/**
 * Get comprehensive Kanban board summary statistics
 *
 * @description Aggregates task data to provide board overview including
 *              counts by status/priority, agent workload, and recent activity
 * @param {string} sessionId - Session ID to get summary for
 * @returns {Promise<BoardSummary>} Board summary with statistics and recent events
 *
 * @example
 * ```typescript
 * const summary = await getBoardSummary('session-123');
 * console.log(`Total: ${summary.totalTasks}, In Progress: ${summary.byStatus.in_progress}`);
 * console.log(`Blocked: ${summary.blockedTasks}, Unassigned: ${summary.unassignedTasks}`);
 * ```
 */
export async function getBoardSummary(sessionId: string): Promise<BoardSummary> {
  const client = await getRedis();

  const tasks = await listTasks(sessionId, undefined, 1000);

  const byStatus: Record<TaskStatus, number> = {
    backlog: 0,
    in_progress: 0,
    review: 0,
    done: 0,
  };

  const byPriority: Record<TaskPriority, number> = {
    critical: 0,
    high: 0,
    normal: 0,
    low: 0,
  };

  const agentStats = new Map<string, { taskCount: number; inProgress: number }>();

  let blockedTasks = 0;
  let assignedTasks = 0;
  let unassignedTasks = 0;

  for (const task of tasks) {
    byStatus[task.status]++;
    byPriority[task.priority]++;

    if (task.blockedBy.length > 0) blockedTasks++;

    if (task.assignee) {
      assignedTasks++;
      const stats = agentStats.get(task.assignee) || { taskCount: 0, inProgress: 0 };
      stats.taskCount++;
      if (task.status === 'in_progress') stats.inProgress++;
      agentStats.set(task.assignee, stats);
    } else {
      unassignedTasks++;
    }
  }

  // Get recent events
  const eventData = await client.lrange(KANBAN_KEYS.events(sessionId), 0, 9);
  const recentActivity = eventData
    .map((e) => { try { return JSON.parse(e) as TaskEvent; } catch { return null; } })
    .filter((e): e is TaskEvent => e !== null);

  return {
    sessionId,
    totalTasks: tasks.length,
    byStatus,
    byPriority,
    blockedTasks,
    assignedTasks,
    unassignedTasks,
    agents: Array.from(agentStats.entries()).map(([agentId, stats]) => ({
      agentId,
      ...stats,
    })),
    recentActivity,
  };
}

/**
 * Permanently delete a task from the Kanban board
 *
 * @description Removes task data, updates all indices, and cleans up
 *              blocking relationships with other tasks
 * @param {string} taskId - Task ID to delete
 * @returns {Promise<boolean>} True if task was deleted, false if not found
 *
 * @example
 * ```typescript
 * const deleted = await deleteTask('task-123');
 * if (deleted) {
 *   console.log('Task removed');
 * }
 * ```
 */
export async function deleteTask(taskId: string): Promise<boolean> {
  const client = await getRedis();

  const task = await getTask(taskId);
  if (!task) return false;

  // Remove from all indices
  await client.del(KANBAN_KEYS.task(taskId));
  await client.zrem(KANBAN_KEYS.tasks(task.sessionId), taskId);
  await client.srem(KANBAN_KEYS.byStatus(task.sessionId, task.status), taskId);

  if (task.assignee) {
    await client.srem(KANBAN_KEYS.byAgent(task.assignee), taskId);
  }

  // Remove blocking relationships
  for (const blockerId of task.blockedBy) {
    await removeBlocksRelation(blockerId, taskId);
  }

  for (const blockedId of task.blocks) {
    const blockedTask = await getTask(blockedId);
    if (blockedTask) {
      const newBlockedBy = blockedTask.blockedBy.filter((id) => id !== taskId);
      await updateTask(blockedId, { blockedBy: newBlockedBy }, 'system');
    }
  }

  Logger.debug(`kanban: deleted task ${taskId}`);

  return true;
}

/**
 * Add a blocking relationship between two tasks
 *
 * @description Adds blockedId to the blocker task's "blocks" array,
 *              establishing a dependency relationship
 * @param {string} blockerId - Task ID that blocks another task
 * @param {string} blockedId - Task ID that is being blocked
 * @internal
 */
async function addBlocksRelation(blockerId: string, blockedId: string): Promise<void> {
  const client = await getRedis();

  const blocker = await getTask(blockerId);
  if (blocker && !blocker.blocks.includes(blockedId)) {
    blocker.blocks.push(blockedId);
    await client.hset(KANBAN_KEYS.task(blockerId), 'blocks', JSON.stringify(blocker.blocks));
  }
}

/**
 * Remove a blocking relationship between two tasks
 *
 * @description Removes blockedId from the blocker task's "blocks" array
 * @param {string} blockerId - Task ID that was blocking
 * @param {string} blockedId - Task ID that was blocked
 * @internal
 */
async function removeBlocksRelation(blockerId: string, blockedId: string): Promise<void> {
  const client = await getRedis();

  const blocker = await getTask(blockerId);
  if (blocker) {
    blocker.blocks = blocker.blocks.filter((id) => id !== blockedId);
    await client.hset(KANBAN_KEYS.task(blockerId), 'blocks', JSON.stringify(blocker.blocks));
  }
}

/**
 * Emit a task event to Redis
 *
 * @description Stores event in the events list (capped at MAX_EVENTS)
 *              and publishes to the Kanban Pub/Sub channel
 * @param {TaskEvent} event - Event to emit
 * @internal
 */
async function emitEvent(event: TaskEvent): Promise<void> {
  const client = await getRedis();

  // Store in events list
  await client.lpush(KANBAN_KEYS.events(event.sessionId), JSON.stringify(event));
  await client.ltrim(KANBAN_KEYS.events(event.sessionId), 0, MAX_EVENTS - 1);

  // Publish to channel
  await client.publish(KANBAN_KEYS.channel, JSON.stringify(event));
}

/**
 * Subscribe to real-time Kanban board events
 *
 * @description Creates a Redis Pub/Sub subscription for task events.
 *              Returns an unsubscribe function for cleanup.
 * @param {Function} callback - Function called with each TaskEvent
 * @returns {Function} Unsubscribe function to stop receiving events
 *
 * @example
 * ```typescript
 * const unsubscribe = subscribeToEvents((event) => {
 *   console.log(`Event: ${event.type} on task ${event.taskId}`);
 * });
 *
 * // Later, to stop listening:
 * unsubscribe();
 * ```
 */
export function subscribeToEvents(callback: (event: TaskEvent) => void): () => void {
  let subscriber: Redis | null = null;
  let isCleanedUp = false;
  let cleanupTimeout: NodeJS.Timeout | null = null;

  const cleanup = async (): Promise<void> => {
    if (isCleanedUp || !subscriber) return;
    isCleanedUp = true;

    if (cleanupTimeout) {
      clearTimeout(cleanupTimeout);
      cleanupTimeout = null;
    }

    try {
      await subscriber.unsubscribe(KANBAN_KEYS.channel);
    } catch (error) {
      Logger.debug(`kanban: unsubscribe error during cleanup: ${error}`);
    }

    try {
      subscriber.disconnect();
    } catch (error) {
      Logger.debug(`kanban: disconnect error during cleanup: ${error}`);
    }
  };

  const forceCleanup = (): void => {
    if (subscriber && !isCleanedUp) {
      Logger.warn('kanban: forcing Redis subscriber cleanup after timeout');
      try {
        subscriber.disconnect();
      } catch {
        // Ignore errors during forced cleanup
      }
      isCleanedUp = true;
    }
  };

  try {
    subscriber = new Redis({
      host: process.env.REDIS_HOST || '127.0.0.1',
      port: parseInt(process.env.REDIS_PORT || '6379'),
      password: process.env.REDIS_PASSWORD || undefined,
      db: 2,
    });

    // Set up error handler before any async operations
    subscriber.on('error', (error: Error) => {
      Logger.error(`kanban: Redis subscriber error: ${error}`);
      void cleanup();
    });

    // Subscribe with error handling
    subscriber.subscribe(KANBAN_KEYS.channel, (error: Error | null | undefined) => {
      if (error) {
        Logger.error(`kanban: failed to subscribe to channel: ${error}`);
        void cleanup();
        return;
      }
    });

    subscriber.on('message', (_channel: string, message: string) => {
      try {
        const event = JSON.parse(message) as TaskEvent;
        callback(event);
      } catch (error) {
        Logger.error(`kanban: failed to parse event: ${error}`);
      }
    });

    // Set up forced cleanup timeout (30 seconds)
    cleanupTimeout = setTimeout(forceCleanup, 30000);

    return () => {
      void cleanup();
    };
  } catch (error) {
    Logger.error(`kanban: failed to create Redis subscriber: ${error}`);
    void cleanup();

    // Return no-op unsubscribe function
    return () => {
      // No-op - already cleaned up or failed to initialize
    };
  }
}

/**
 * Get all tasks assigned to a specific agent
 *
 * @description Retrieves all tasks currently assigned to the given agent
 *              across all sessions
 * @param {string} agentId - Agent ID to get tasks for
 * @returns {Promise<KanbanTask[]>} Array of tasks assigned to the agent
 *
 * @example
 * ```typescript
 * const myTasks = await getAgentTasks('agent-1');
 * const inProgress = myTasks.filter(t => t.status === 'in_progress');
 * ```
 */
export async function getAgentTasks(agentId: string): Promise<KanbanTask[]> {
  const client = await getRedis();

  const taskIds = await client.smembers(KANBAN_KEYS.byAgent(agentId));
  const tasks: KanbanTask[] = [];

  for (const taskId of taskIds) {
    const task = await getTask(taskId);
    if (task) tasks.push(task);
  }

  return tasks;
}

/**
 * Get tasks available for claiming (unassigned, unblocked, in backlog)
 *
 * @description Convenience method to find tasks that agents can immediately
 *              claim and start working on
 * @param {string} sessionId - Session ID to search in
 * @returns {Promise<KanbanTask[]>} Array of available tasks sorted by priority
 *
 * @example
 * ```typescript
 * const available = await getAvailableTasks('session-123');
 * if (available.length > 0) {
 *   await claimTask(available[0].id, 'agent-1');
 * }
 * ```
 */
export async function getAvailableTasks(sessionId: string): Promise<KanbanTask[]> {
  return listTasks(sessionId, { unassigned: true, blocked: false, status: 'backlog' });
}
