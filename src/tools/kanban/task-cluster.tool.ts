/**
 * KemdiCode MCP Server - Task Clustering Tool
 * Copyright (C) 2025-2026 Kemdi Sp. z o.o. (Dawid Irzyk <dawid@kemdi.pl>)
 *
 * LLM-driven task clustering with context extraction,
 * checklists, and digest generation for context control.
 *
 * @license GPL-3.0
 */

import { z } from 'zod';
import type { UnifiedTool } from '../registry.js';
import { handleToolError } from '../../utils/errors.js';
import {
  createCluster,
  getCluster,
  listClusters,
  deleteCluster,
  addTasksToCluster,
  removeTasksFromCluster,
  addChecklistItem,
  addChecklistItems,
  toggleChecklistItem,
  extractClusterContext,
  autoClusterTasks,
  getClusterDigest,
} from '../../kanban/cluster-store.js';
import { resolveSessionId } from '../../kanban/resolvers.js';

const schema = z.object({
  action: z.enum([
    'create',
    'get',
    'list',
    'delete',
    'add-tasks',
    'remove-tasks',
    'checklist-add',
    'checklist-toggle',
    'extract-context',
    'auto-cluster',
    'digest',
  ]).describe(
    'Action: create (new cluster), get (by ID), list (browse clusters), delete (remove cluster), add-tasks (add tasks to cluster), remove-tasks (remove from cluster), checklist-add (add checklist item), checklist-toggle (toggle item done), extract-context (LLM context extraction), auto-cluster (LLM-driven automatic grouping), digest (summarize cluster for context control)'
  ),
  clusterId: z.string().optional().describe('Cluster ID (for get, delete, add-tasks, remove-tasks, checklist-*, extract-context, digest)'),
  sessionId: z.string().optional().describe('Session ID (auto-detected from connection if omitted)'),
  boardId: z.string().optional().describe('Board ID (optional filter)'),
  name: z.string().optional().describe('Cluster name (for create)'),
  description: z.string().optional().describe('Cluster description (for create)'),
  taskIds: z.array(z.string()).optional().describe('Task IDs (for create, add-tasks, remove-tasks)'),
  labels: z.array(z.string()).optional().describe('Labels (for create)'),
  createdBy: z.string().optional().describe('Agent ID (for create, checklist-add, auto-cluster)'),
  model: z.string().optional().describe('LLM model for context extraction / auto-clustering'),
  contextModel: z.string().optional().describe('Designated model for this cluster context management'),
  // Checklist fields
  content: z.string().optional().describe('Checklist item content (for checklist-add)'),
  items: z.array(z.object({
    content: z.string(),
    category: z.string().optional(),
  })).optional().describe('Batch checklist items (for checklist-add)'),
  category: z.string().optional().describe('Checklist item category (for checklist-add)'),
  itemId: z.string().optional().describe('Checklist item ID (for checklist-toggle)'),
  checked: z.boolean().optional().describe('Check state (for checklist-toggle)'),
});

export const taskClusterTool: UnifiedTool<typeof schema> = {
  name: 'task-cluster',
  description: 'LLM-driven task clustering: auto-group tasks, extract context, manage checklists for project data gathering, and generate digests for context control',
  zodSchema: schema,
  metadata: {
    category: 'kanban',
    tags: ['cluster', 'grouping', 'context', 'checklist', 'ai', 'planning'],
    aiRequired: false, // Only auto-cluster and extract-context need AI
    annotations: {
      title: 'Task Clustering',
      readOnlyHint: false,
      openWorldHint: true,
    },
  },

  execute: async (args) => {
    try {
      const { action } = args;

      // ── CREATE ──────────────────────────────────────────────────────
      if (action === 'create') {
        const { boardId, name, description, taskIds, labels, createdBy, contextModel } = args;
        const sessionId = resolveSessionId(args.sessionId);
        if (!name) return err('name required');

        const cluster = await createCluster({
          sessionId,
          boardId,
          name,
          description,
          taskIds: taskIds || [],
          labels: labels || [],
          createdBy: createdBy || 'system',
          contextModel,
        });

        return ok({ cluster });
      }

      // ── GET ─────────────────────────────────────────────────────────
      if (action === 'get') {
        if (!args.clusterId) return err('clusterId required');
        const cluster = await getCluster(args.clusterId);
        if (!cluster) return err(`Cluster not found: ${args.clusterId}`);
        return ok({ cluster });
      }

      // ── LIST ────────────────────────────────────────────────────────
      if (action === 'list') {
        const sessionId = resolveSessionId(args.sessionId);
        const clusters = await listClusters(sessionId, args.boardId);
        return ok({
          total: clusters.length,
          clusters: clusters.map((c) => ({
            id: c.id,
            name: c.name,
            taskCount: c.taskIds.length,
            checklistProgress: c.checklist.length > 0
              ? `${c.checklist.filter((i) => i.checked).length}/${c.checklist.length}`
              : '0/0',
            hasContext: !!c.context,
            labels: c.labels,
            updatedAt: c.updatedAt,
          })),
        });
      }

      // ── DELETE ──────────────────────────────────────────────────────
      if (action === 'delete') {
        if (!args.clusterId) return err('clusterId required');
        const deleted = await deleteCluster(args.clusterId);
        return ok({ deleted, clusterId: args.clusterId });
      }

      // ── ADD TASKS ──────────────────────────────────────────────────
      if (action === 'add-tasks') {
        if (!args.clusterId) return err('clusterId required');
        if (!args.taskIds || args.taskIds.length === 0) return err('taskIds required');
        const cluster = await addTasksToCluster(args.clusterId, args.taskIds);
        if (!cluster) return err(`Cluster not found: ${args.clusterId}`);
        return ok({ clusterId: cluster.id, taskCount: cluster.taskIds.length });
      }

      // ── REMOVE TASKS ───────────────────────────────────────────────
      if (action === 'remove-tasks') {
        if (!args.clusterId) return err('clusterId required');
        if (!args.taskIds || args.taskIds.length === 0) return err('taskIds required');
        const cluster = await removeTasksFromCluster(args.clusterId, args.taskIds);
        if (!cluster) return err(`Cluster not found: ${args.clusterId}`);
        return ok({ clusterId: cluster.id, taskCount: cluster.taskIds.length });
      }

      // ── CHECKLIST ADD ──────────────────────────────────────────────
      if (action === 'checklist-add') {
        if (!args.clusterId) return err('clusterId required');
        const by = args.createdBy || 'system';

        // Batch mode
        if (args.items && args.items.length > 0) {
          const items = await addChecklistItems(args.clusterId, args.items, by);
          return ok({ clusterId: args.clusterId, added: items.length, items });
        }

        // Single mode
        if (!args.content) return err('content or items required');
        const item = await addChecklistItem(args.clusterId, args.content, by, args.category);
        if (!item) return err(`Cluster not found: ${args.clusterId}`);
        return ok({ clusterId: args.clusterId, item });
      }

      // ── CHECKLIST TOGGLE ───────────────────────────────────────────
      if (action === 'checklist-toggle') {
        if (!args.clusterId) return err('clusterId required');
        if (!args.itemId) return err('itemId required');
        if (args.checked === undefined) return err('checked required');
        const item = await toggleChecklistItem(args.clusterId, args.itemId, args.checked);
        if (!item) return err('Item or cluster not found');
        return ok({ clusterId: args.clusterId, item });
      }

      // ── EXTRACT CONTEXT ────────────────────────────────────────────
      if (action === 'extract-context') {
        if (!args.clusterId) return err('clusterId required');
        const context = await extractClusterContext(args.clusterId, args.model);
        if (!context) return err('Cluster not found or no tasks');
        return ok({ clusterId: args.clusterId, context });
      }

      // ── AUTO-CLUSTER ───────────────────────────────────────────────
      if (action === 'auto-cluster') {
        const sessionId = resolveSessionId(args.sessionId);
        const clusters = await autoClusterTasks(
          sessionId,
          args.boardId,
          args.model,
          args.createdBy || 'auto',
        );
        return ok({
          created: clusters.length,
          clusters: clusters.map((c) => ({
            id: c.id,
            name: c.name,
            taskCount: c.taskIds.length,
            checklistItems: c.checklist.length,
            labels: c.labels,
          })),
        });
      }

      // ── DIGEST ─────────────────────────────────────────────────────
      if (action === 'digest') {
        if (!args.clusterId) return err('clusterId required');
        const digest = await getClusterDigest(args.clusterId);
        if (!digest) return err(`Cluster not found: ${args.clusterId}`);
        return ok({ clusterId: args.clusterId, digest });
      }

      return err(`Unknown action: ${action}`);
    } catch (error) {
      return handleToolError('task-cluster', error);
    }
  },
};

function ok(data: Record<string, unknown>): string {
  return JSON.stringify({ success: true, ...data });
}

function err(error: string): string {
  return JSON.stringify({ success: false, error });
}
