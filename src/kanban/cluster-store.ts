/**
 * KemdiCode MCP Server - Cluster Store
 * Copyright (C) 2025-2026 Kemdi Sp. z o.o. (Dawid Irzyk <dawid@kemdi.pl>)
 *
 * Redis-based persistence for LLM-driven task clustering.
 * Clusters group related tasks with context extraction,
 * checklists for project data gathering, and LLM-controlled
 * context management.
 *
 * @license GPL-3.0
 * @module kanban/cluster-store
 */

import { Logger } from '../utils/logger.js';
import { getSharedRedis } from '../infrastructure/redis/connection.js';
import { generateObject } from '../ai/structured-output.js';
import { z } from 'zod';
import {
  TaskCluster,
  ClusterChecklistItem,
  ClusterContext,
  CreateClusterInput,
  KanbanTask,
  KANBAN_KEYS,
  DEFAULT_TASK_TTL,
} from './types.js';
import { getTask, listTasks } from './kanban-store.js';

const getRedis = getSharedRedis;

function generateClusterId(): string {
  return `cluster_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function generateChecklistItemId(): string {
  return `chk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// CLUSTER CRUD
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a new task cluster.
 */
export async function createCluster(input: CreateClusterInput): Promise<TaskCluster> {
  const client = await getRedis();

  const clusterId = generateClusterId();
  const now = Date.now();

  const cluster: TaskCluster = {
    id: clusterId,
    name: input.name,
    description: input.description || '',
    sessionId: input.sessionId,
    boardId: input.boardId,
    taskIds: input.taskIds || [],
    checklist: [],
    labels: input.labels || [],
    createdBy: input.createdBy,
    contextModel: input.contextModel,
    createdAt: now,
    updatedAt: now,
  };

  const pipeline = client.pipeline();

  pipeline.hset(KANBAN_KEYS.cluster(clusterId), {
    id: cluster.id,
    name: cluster.name,
    description: cluster.description,
    sessionId: cluster.sessionId,
    boardId: cluster.boardId || '',
    taskIds: JSON.stringify(cluster.taskIds),
    checklist: JSON.stringify(cluster.checklist),
    labels: JSON.stringify(cluster.labels),
    createdBy: cluster.createdBy,
    contextModel: cluster.contextModel || '',
    createdAt: now.toString(),
    updatedAt: now.toString(),
  });

  pipeline.sadd(KANBAN_KEYS.clustersBySession(input.sessionId), clusterId);
  if (input.boardId) {
    pipeline.sadd(KANBAN_KEYS.clustersByBoard(input.boardId), clusterId);
  }
  pipeline.expire(KANBAN_KEYS.cluster(clusterId), DEFAULT_TASK_TTL);

  // Add task IDs to cluster set and update tasks with clusterId
  for (const taskId of cluster.taskIds) {
    pipeline.sadd(KANBAN_KEYS.clusterTasks(clusterId), taskId);
    pipeline.hset(KANBAN_KEYS.task(taskId), 'clusterId', clusterId);
  }

  await pipeline.exec();

  Logger.debug(`cluster: created ${clusterId} with ${cluster.taskIds.length} tasks`);
  return cluster;
}

/**
 * Get a cluster by ID.
 */
export async function getCluster(clusterId: string): Promise<TaskCluster | null> {
  const client = await getRedis();
  const data = await client.hgetall(KANBAN_KEYS.cluster(clusterId));

  if (!data || Object.keys(data).length === 0) return null;

  return {
    id: data.id,
    name: data.name,
    description: data.description || '',
    sessionId: data.sessionId,
    boardId: data.boardId || undefined,
    taskIds: safeParseArray(data.taskIds),
    checklist: safeParseArray(data.checklist) as ClusterChecklistItem[],
    context: data.context ? safeParseJson<ClusterContext>(data.context) : undefined,
    contextModel: data.contextModel || undefined,
    labels: safeParseArray(data.labels),
    createdBy: data.createdBy,
    createdAt: parseInt(data.createdAt, 10) || 0,
    updatedAt: parseInt(data.updatedAt, 10) || 0,
  };
}

/**
 * List clusters for a session (optionally filtered by boardId).
 */
export async function listClusters(
  sessionId: string,
  boardId?: string,
): Promise<TaskCluster[]> {
  const client = await getRedis();

  const key = boardId
    ? KANBAN_KEYS.clustersByBoard(boardId)
    : KANBAN_KEYS.clustersBySession(sessionId);

  const clusterIds = await client.smembers(key);
  const clusters: TaskCluster[] = [];

  for (const id of clusterIds) {
    const cluster = await getCluster(id);
    if (cluster) clusters.push(cluster);
  }

  return clusters.sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Delete a cluster. Removes clusterId from tasks but does NOT delete the tasks.
 */
export async function deleteCluster(clusterId: string): Promise<boolean> {
  const client = await getRedis();
  const cluster = await getCluster(clusterId);
  if (!cluster) return false;

  const pipeline = client.pipeline();

  // Remove clusterId from all tasks in this cluster
  for (const taskId of cluster.taskIds) {
    pipeline.hdel(KANBAN_KEYS.task(taskId), 'clusterId');
  }

  pipeline.del(KANBAN_KEYS.cluster(clusterId));
  pipeline.del(KANBAN_KEYS.clusterTasks(clusterId));
  pipeline.srem(KANBAN_KEYS.clustersBySession(cluster.sessionId), clusterId);
  if (cluster.boardId) {
    pipeline.srem(KANBAN_KEYS.clustersByBoard(cluster.boardId), clusterId);
  }

  await pipeline.exec();
  Logger.debug(`cluster: deleted ${clusterId}`);
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// TASK ↔ CLUSTER MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Add tasks to an existing cluster.
 */
export async function addTasksToCluster(
  clusterId: string,
  taskIds: string[],
): Promise<TaskCluster | null> {
  const client = await getRedis();
  const cluster = await getCluster(clusterId);
  if (!cluster) return null;

  const newTaskIds = taskIds.filter((id) => !cluster.taskIds.includes(id));
  if (newTaskIds.length === 0) return cluster;

  const pipeline = client.pipeline();

  for (const taskId of newTaskIds) {
    pipeline.sadd(KANBAN_KEYS.clusterTasks(clusterId), taskId);
    pipeline.hset(KANBAN_KEYS.task(taskId), 'clusterId', clusterId);
  }

  cluster.taskIds.push(...newTaskIds);
  const now = Date.now();

  pipeline.hset(KANBAN_KEYS.cluster(clusterId), {
    taskIds: JSON.stringify(cluster.taskIds),
    updatedAt: now.toString(),
  });

  await pipeline.exec();
  cluster.updatedAt = now;

  Logger.debug(`cluster: added ${newTaskIds.length} tasks to ${clusterId}`);
  return cluster;
}

/**
 * Remove tasks from a cluster.
 */
export async function removeTasksFromCluster(
  clusterId: string,
  taskIds: string[],
): Promise<TaskCluster | null> {
  const client = await getRedis();
  const cluster = await getCluster(clusterId);
  if (!cluster) return null;

  const pipeline = client.pipeline();

  for (const taskId of taskIds) {
    pipeline.srem(KANBAN_KEYS.clusterTasks(clusterId), taskId);
    pipeline.hdel(KANBAN_KEYS.task(taskId), 'clusterId');
  }

  cluster.taskIds = cluster.taskIds.filter((id) => !taskIds.includes(id));
  const now = Date.now();

  pipeline.hset(KANBAN_KEYS.cluster(clusterId), {
    taskIds: JSON.stringify(cluster.taskIds),
    updatedAt: now.toString(),
  });

  await pipeline.exec();
  cluster.updatedAt = now;

  return cluster;
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECKLIST (Project Data Gathering)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Add a checklist item to a cluster.
 */
export async function addChecklistItem(
  clusterId: string,
  content: string,
  addedBy: string,
  category?: string,
): Promise<ClusterChecklistItem | null> {
  const client = await getRedis();
  const cluster = await getCluster(clusterId);
  if (!cluster) return null;

  const item: ClusterChecklistItem = {
    id: generateChecklistItemId(),
    content,
    checked: false,
    addedBy,
    addedAt: Date.now(),
    category,
  };

  cluster.checklist.push(item);
  const now = Date.now();

  await client.hset(KANBAN_KEYS.cluster(clusterId), {
    checklist: JSON.stringify(cluster.checklist),
    updatedAt: now.toString(),
  });

  Logger.debug(`cluster: added checklist item ${item.id} to ${clusterId}`);
  return item;
}

/**
 * Toggle a checklist item (check/uncheck).
 */
export async function toggleChecklistItem(
  clusterId: string,
  itemId: string,
  checked: boolean,
): Promise<ClusterChecklistItem | null> {
  const client = await getRedis();
  const cluster = await getCluster(clusterId);
  if (!cluster) return null;

  const item = cluster.checklist.find((i) => i.id === itemId);
  if (!item) return null;

  item.checked = checked;
  item.checkedAt = checked ? Date.now() : undefined;
  const now = Date.now();

  await client.hset(KANBAN_KEYS.cluster(clusterId), {
    checklist: JSON.stringify(cluster.checklist),
    updatedAt: now.toString(),
  });

  return item;
}

/**
 * Add multiple checklist items at once (batch).
 */
export async function addChecklistItems(
  clusterId: string,
  items: Array<{ content: string; category?: string }>,
  addedBy: string,
): Promise<ClusterChecklistItem[]> {
  const client = await getRedis();
  const cluster = await getCluster(clusterId);
  if (!cluster) return [];

  const newItems: ClusterChecklistItem[] = items.map((i) => ({
    id: generateChecklistItemId(),
    content: i.content,
    checked: false,
    addedBy,
    addedAt: Date.now(),
    category: i.category,
  }));

  cluster.checklist.push(...newItems);
  const now = Date.now();

  await client.hset(KANBAN_KEYS.cluster(clusterId), {
    checklist: JSON.stringify(cluster.checklist),
    updatedAt: now.toString(),
  });

  return newItems;
}

// ─────────────────────────────────────────────────────────────────────────────
// LLM-DRIVEN CONTEXT EXTRACTION
// ─────────────────────────────────────────────────────────────────────────────

const contextSchema = z.object({
  summary: z.string().describe('Concise summary of all tasks in the cluster'),
  keyDataPoints: z.array(z.string()).describe('Key data points extracted from task descriptions'),
  risks: z.array(z.string()).describe('Identified risks or blockers across the cluster'),
  sharedDependencies: z.array(z.string()).describe('Shared dependencies between tasks'),
  suggestedOrder: z.array(z.string()).describe('Suggested execution order (task IDs)'),
});

/**
 * Use LLM to extract context from all tasks in a cluster.
 * This is the core "context control" feature - the LLM reads all tasks
 * and produces a structured understanding of the cluster.
 */
export async function extractClusterContext(
  clusterId: string,
  model?: string,
): Promise<ClusterContext | null> {
  const client = await getRedis();
  const cluster = await getCluster(clusterId);
  if (!cluster) return null;

  // Fetch all tasks in the cluster
  const tasks: KanbanTask[] = [];
  for (const taskId of cluster.taskIds) {
    const task = await getTask(taskId);
    if (task) tasks.push(task);
  }

  if (tasks.length === 0) return null;

  const taskDescriptions = tasks.map((t, i) => {
    const parts = [
      `Task ${i + 1} [${t.id}]:`,
      `  Title: ${t.title}`,
      t.description ? `  Description: ${t.description}` : '',
      `  Status: ${t.status}, Priority: ${t.priority}`,
      t.assignee ? `  Assignee: ${t.assignee}` : '  Unassigned',
      t.relatedFiles.length > 0 ? `  Files: ${t.relatedFiles.join(', ')}` : '',
      t.labels.length > 0 ? `  Labels: ${t.labels.join(', ')}` : '',
      t.blockedBy.length > 0 ? `  Blocked by: ${t.blockedBy.join(', ')}` : '',
      t.complexity ? `  Complexity: ${t.complexity.score}/10 - ${t.complexity.reasoning}` : '',
    ];
    return parts.filter(Boolean).join('\n');
  }).join('\n\n');

  const checklistInfo = cluster.checklist.length > 0
    ? `\n\nExisting checklist:\n${cluster.checklist.map((c) =>
        `- [${c.checked ? 'x' : ' '}] ${c.content}${c.category ? ` (${c.category})` : ''}`
      ).join('\n')}`
    : '';

  const prompt = [
    `Analyze this cluster of ${tasks.length} related tasks and extract key context:`,
    ``,
    `Cluster: "${cluster.name}"`,
    cluster.description ? `Description: ${cluster.description}` : '',
    ``,
    `Tasks:`,
    taskDescriptions,
    checklistInfo,
    ``,
    `Extract:`,
    `1. A concise summary capturing what this cluster is about`,
    `2. Key data points that are important across tasks`,
    `3. Risks or blockers that could impact the cluster`,
    `4. Shared dependencies between tasks`,
    `5. Suggested execution order (list task IDs in optimal order)`,
  ].filter(Boolean).join('\n');

  const effectiveModel = model || cluster.contextModel;

  const result = await generateObject({
    model: effectiveModel,
    schema: contextSchema,
    prompt,
    system: 'You are a senior project manager analyzing a cluster of related software tasks. Extract the most important context to help coordinate work efficiently.',
    temperature: 0.3,
    maxTokens: 2048,
  });

  const context: ClusterContext = {
    summary: result.object.summary,
    keyDataPoints: result.object.keyDataPoints,
    risks: result.object.risks,
    sharedDependencies: result.object.sharedDependencies,
    suggestedOrder: result.object.suggestedOrder,
    extractedAt: Date.now(),
    extractedBy: result.model,
  };

  // Store context in cluster
  await client.hset(KANBAN_KEYS.cluster(clusterId), {
    context: JSON.stringify(context),
    updatedAt: Date.now().toString(),
  });

  Logger.debug(`cluster: extracted context for ${clusterId} (${tasks.length} tasks)`);
  return context;
}

// ─────────────────────────────────────────────────────────────────────────────
// LLM-DRIVEN AUTO-CLUSTERING
// ─────────────────────────────────────────────────────────────────────────────

const autoClusterSchema = z.object({
  clusters: z.array(z.object({
    name: z.string().describe('Short cluster name'),
    description: z.string().describe('Why these tasks belong together'),
    taskIds: z.array(z.string()).describe('Task IDs in this cluster'),
    suggestedLabels: z.array(z.string()).optional().describe('Labels for the cluster'),
    checklistSuggestions: z.array(z.string()).optional().describe('Suggested checklist items for project data gathering'),
  })).describe('Task clusters'),
});

/**
 * Use LLM to automatically cluster tasks from a session/board.
 * The LLM analyzes all tasks and groups them into logical clusters.
 */
export async function autoClusterTasks(
  sessionId: string,
  boardId?: string,
  model?: string,
  createdBy: string = 'auto',
): Promise<TaskCluster[]> {
  // Fetch all tasks
  const tasks = await listTasks(sessionId, boardId ? { boardId } : undefined);

  if (tasks.length < 2) return [];

  // Filter out already-clustered tasks
  const unclustered = tasks.filter((t) => !t.clusterId);
  if (unclustered.length < 2) return [];

  const taskDescriptions = unclustered.map((t) => {
    const parts = [
      `[${t.id}] "${t.title}"`,
      t.description ? `  Desc: ${t.description}` : '',
      `  Priority: ${t.priority}, Status: ${t.status}`,
      t.labels.length > 0 ? `  Labels: ${t.labels.join(', ')}` : '',
      t.relatedFiles.length > 0 ? `  Files: ${t.relatedFiles.join(', ')}` : '',
    ];
    return parts.filter(Boolean).join('\n');
  }).join('\n\n');

  const prompt = [
    `Group these ${unclustered.length} tasks into logical clusters based on their relationships:`,
    ``,
    taskDescriptions,
    ``,
    `Rules:`,
    `- Each task should be in exactly ONE cluster`,
    `- Only create clusters with 2+ tasks (leave singletons out)`,
    `- Name clusters clearly (e.g., "Authentication", "UI Refactor", "Database Migration")`,
    `- For each cluster, suggest checklist items that would help gather project-level data`,
    `- Use actual task IDs from the list above`,
  ].join('\n');

  const result = await generateObject({
    model,
    schema: autoClusterSchema,
    prompt,
    system: 'You are an expert project manager organizing tasks into coherent workstreams. Group related tasks that share context, dependencies, or domain.',
    temperature: 0.3,
    maxTokens: 4096,
  });

  const createdClusters: TaskCluster[] = [];

  for (const clusterSpec of result.object.clusters) {
    // Validate that task IDs actually exist
    const validTaskIds = clusterSpec.taskIds.filter((id) =>
      unclustered.some((t) => t.id === id)
    );

    if (validTaskIds.length < 2) continue;

    const cluster = await createCluster({
      sessionId,
      boardId,
      name: clusterSpec.name,
      description: clusterSpec.description,
      taskIds: validTaskIds,
      labels: clusterSpec.suggestedLabels || [],
      createdBy,
      contextModel: model,
    });

    // Add suggested checklist items
    if (clusterSpec.checklistSuggestions && clusterSpec.checklistSuggestions.length > 0) {
      await addChecklistItems(
        cluster.id,
        clusterSpec.checklistSuggestions.map((content) => ({
          content,
          category: 'auto-suggested',
        })),
        createdBy,
      );

      // Re-fetch to get updated checklist
      const updated = await getCluster(cluster.id);
      if (updated) {
        createdClusters.push(updated);
        continue;
      }
    }

    createdClusters.push(cluster);
  }

  Logger.info(`cluster: auto-created ${createdClusters.length} clusters from ${unclustered.length} tasks`);
  return createdClusters;
}

// ─────────────────────────────────────────────────────────────────────────────
// CLUSTER DIGEST (Compressed context for LLMs)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get a compressed digest of a cluster suitable for injecting into LLM context.
 * This is the key "context control" feature - extracts only the most important
 * information so an LLM can understand the cluster without reading every task.
 */
export async function getClusterDigest(clusterId: string): Promise<string | null> {
  const cluster = await getCluster(clusterId);
  if (!cluster) return null;

  const tasks: KanbanTask[] = [];
  for (const taskId of cluster.taskIds) {
    const task = await getTask(taskId);
    if (task) tasks.push(task);
  }

  const lines: string[] = [
    `## Cluster: ${cluster.name}`,
    cluster.description ? cluster.description : '',
    '',
    `Tasks (${tasks.length}):`,
  ];

  for (const t of tasks) {
    const status = t.status === 'done' ? '✓' : t.status === 'in_progress' ? '⟳' : '○';
    lines.push(`  ${status} [${t.priority}] ${t.title}${t.assignee ? ` → ${t.assignee}` : ''}`);
  }

  if (cluster.context) {
    lines.push('', 'Context:', cluster.context.summary);
    if (cluster.context.risks.length > 0) {
      lines.push('Risks:', ...cluster.context.risks.map((r) => `  ⚠ ${r}`));
    }
    if (cluster.context.keyDataPoints.length > 0) {
      lines.push('Key data:', ...cluster.context.keyDataPoints.map((d) => `  • ${d}`));
    }
  }

  if (cluster.checklist.length > 0) {
    const checked = cluster.checklist.filter((c) => c.checked).length;
    lines.push('', `Checklist (${checked}/${cluster.checklist.length}):`);
    for (const item of cluster.checklist) {
      lines.push(`  [${item.checked ? 'x' : ' '}] ${item.content}`);
    }
  }

  return lines.filter((l) => l !== undefined).join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function safeParseArray<T = string>(value: string | undefined): T[] {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function safeParseJson<T>(value: string): T | undefined {
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}
