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
 * Workflow Store
 *
 * Redis-based persistence for board workflows.
 * Handles automatic board switching when all tasks on a board are completed.
 *
 * @module kanban/workflow-store
 */

import { v4 as uuidv4 } from 'uuid';
import { Logger } from '../utils/logger.js';
import { getSharedRedis } from '../infrastructure/redis/connection.js';
import {
  BoardWorkflow,
  CreateWorkflowInput,
  KANBAN_KEYS,
} from './types.js';
import { createTask, listTasks } from './kanban-store.js';
import { getBoard } from './board-store.js';
import { createWorkflowDirective } from './directive-store.js';

const getRedis = getSharedRedis;

/** Workflow TTL: 30 days */
const WORKFLOW_TTL = 30 * 24 * 60 * 60;

/**
 * Create a new board workflow
 */
export async function createWorkflow(input: CreateWorkflowInput): Promise<BoardWorkflow> {
  const client = await getRedis();
  const now = Date.now();
  const id = `wf_${uuidv4().slice(0, 8)}`;

  const workflow: BoardWorkflow = {
    id,
    name: input.name,
    sessionId: input.sessionId,
    boardSequence: input.boardSequence,
    currentIndex: 0,
    status: 'active',
    autoCreateNavigationTask: input.autoCreateNavigationTask ?? true,
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
  };

  const key = KANBAN_KEYS.workflow(id);
  const sessionKey = KANBAN_KEYS.workflowsBySession(input.sessionId);

  const pipeline = client.pipeline();
  pipeline.hset(key, {
    ...workflow,
    boardSequence: JSON.stringify(workflow.boardSequence),
  });
  pipeline.expire(key, WORKFLOW_TTL);
  pipeline.sadd(sessionKey, id);
  pipeline.expire(sessionKey, WORKFLOW_TTL);

  // Map each board to this workflow
  for (const boardId of input.boardSequence) {
    pipeline.set(KANBAN_KEYS.workflowByBoard(boardId), id);
    pipeline.expire(KANBAN_KEYS.workflowByBoard(boardId), WORKFLOW_TTL);
  }

  await pipeline.exec();

  Logger.info(`[WorkflowStore] Created workflow ${id}: ${input.name} with ${input.boardSequence.length} boards`);
  return workflow;
}

/**
 * Get workflow by ID
 */
export async function getWorkflow(workflowId: string): Promise<BoardWorkflow | null> {
  const client = await getRedis();
  const data = await client.hgetall(KANBAN_KEYS.workflow(workflowId));

  if (!data || Object.keys(data).length === 0) {
    return null;
  }

  return {
    id: data.id,
    name: data.name,
    sessionId: data.sessionId,
    boardSequence: JSON.parse(data.boardSequence || '[]'),
    currentIndex: parseInt(data.currentIndex, 10) || 0,
    status: data.status as BoardWorkflow['status'],
    autoCreateNavigationTask: data.autoCreateNavigationTask === 'true',
    createdBy: data.createdBy,
    createdAt: parseInt(data.createdAt, 10) || 0,
    updatedAt: parseInt(data.updatedAt, 10) || 0,
  };
}

/**
 * Get workflow by board ID
 */
export async function getWorkflowByBoard(boardId: string): Promise<BoardWorkflow | null> {
  const client = await getRedis();
  const workflowId = await client.get(KANBAN_KEYS.workflowByBoard(boardId));
  if (!workflowId) return null;
  return getWorkflow(workflowId);
}

/**
 * List workflows for session
 */
export async function listWorkflows(sessionId: string): Promise<BoardWorkflow[]> {
  const client = await getRedis();
  const ids = await client.smembers(KANBAN_KEYS.workflowsBySession(sessionId));

  const workflows: BoardWorkflow[] = [];
  for (const id of ids) {
    const wf = await getWorkflow(id);
    if (wf) workflows.push(wf);
  }

  return workflows;
}

/**
 * Check if all tasks on board are done and advance workflow if needed
 * Returns the next board ID if workflow advanced, null otherwise
 */
export async function checkAndAdvanceWorkflow(
  boardId: string,
  sessionId: string,
  _agentId: string
): Promise<{ advanced: boolean; nextBoardId?: string; workflow?: BoardWorkflow; navigationTaskId?: string }> {
  const workflow = await getWorkflowByBoard(boardId);

  if (!workflow || workflow.status !== 'active') {
    return { advanced: false };
  }

  // Check if all tasks on current board are done
  const tasks = await listTasks(sessionId, { boardId });
  const pendingTasks = tasks.filter(t => t.status !== 'done');

  if (pendingTasks.length > 0) {
    Logger.debug(`[WorkflowStore] Board ${boardId} has ${pendingTasks.length} pending tasks`);
    return { advanced: false };
  }

  // All tasks done! Advance to next board
  const currentIdx = workflow.boardSequence.indexOf(boardId);
  if (currentIdx === -1 || currentIdx >= workflow.boardSequence.length - 1) {
    // Last board or board not in sequence - complete workflow
    await updateWorkflowStatus(workflow.id, 'completed');
    Logger.info(`[WorkflowStore] Workflow ${workflow.id} completed (last board)`);
    return { advanced: false, workflow };
  }

  const nextBoardId = workflow.boardSequence[currentIdx + 1];
  await updateWorkflowIndex(workflow.id, currentIdx + 1);

  Logger.info(`[WorkflowStore] Workflow ${workflow.id} advanced: ${boardId} -> ${nextBoardId}`);

  // Get board names for directive message
  const prevBoard = await getBoard(boardId);
  const nextBoard = await getBoard(nextBoardId);
  const prevBoardName = prevBoard?.name ?? boardId;
  const nextBoardName = nextBoard?.name ?? nextBoardId;

  // Auto-create navigation task if enabled
  let navigationTaskId: string | undefined;
  if (workflow.autoCreateNavigationTask) {
    const navTask = await createTask({
      sessionId,
      boardId: nextBoardId,
      title: `[AUTO] Continue work on board`,
      description: `Workflow "${workflow.name}" automatically advanced to this board.\n\nPrevious board: ${boardId}\nAll tasks completed.\n\nCheck the task list and continue work.`,
      priority: 'high',
      createdBy: 'system:workflow',
      labels: ['workflow', 'auto-navigation'],
    });
    navigationTaskId = navTask.id;
    Logger.info(`[WorkflowStore] Created navigation task ${navTask.id} on board ${nextBoardId}`);
  }

  // Create obligatory directive for AI
  await createWorkflowDirective(
    sessionId,
    workflow.name,
    boardId,
    prevBoardName,
    nextBoardId,
    nextBoardName,
    navigationTaskId
  );

  Logger.info(`[WorkflowStore] Created workflow directive for session ${sessionId}`);

  return {
    advanced: true,
    nextBoardId,
    workflow: await getWorkflow(workflow.id) || undefined,
    navigationTaskId,
  };
}

/**
 * Update workflow current index
 */
async function updateWorkflowIndex(workflowId: string, newIndex: number): Promise<void> {
  const client = await getRedis();
  await client.hset(KANBAN_KEYS.workflow(workflowId), {
    currentIndex: newIndex.toString(),
    updatedAt: Date.now().toString(),
  });
}

/**
 * Update workflow status
 */
async function updateWorkflowStatus(
  workflowId: string,
  status: BoardWorkflow['status']
): Promise<void> {
  const client = await getRedis();
  await client.hset(KANBAN_KEYS.workflow(workflowId), {
    status,
    updatedAt: Date.now().toString(),
  });
}

/**
 * Pause workflow
 */
export async function pauseWorkflow(workflowId: string): Promise<boolean> {
  const workflow = await getWorkflow(workflowId);
  if (!workflow) return false;
  await updateWorkflowStatus(workflowId, 'paused');
  return true;
}

/**
 * Resume workflow
 */
export async function resumeWorkflow(workflowId: string): Promise<boolean> {
  const workflow = await getWorkflow(workflowId);
  if (!workflow) return false;
  await updateWorkflowStatus(workflowId, 'active');
  return true;
}

/**
 * Delete workflow
 */
export async function deleteWorkflow(workflowId: string): Promise<boolean> {
  const workflow = await getWorkflow(workflowId);
  if (!workflow) return false;

  const client = await getRedis();
  const pipeline = client.pipeline();

  pipeline.del(KANBAN_KEYS.workflow(workflowId));
  pipeline.srem(KANBAN_KEYS.workflowsBySession(workflow.sessionId), workflowId);

  for (const boardId of workflow.boardSequence) {
    pipeline.del(KANBAN_KEYS.workflowByBoard(boardId));
  }

  await pipeline.exec();
  Logger.info(`[WorkflowStore] Deleted workflow ${workflowId}`);
  return true;
}
