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

import { z } from 'zod';
import type { UnifiedTool } from '../registry.js';
import { handleToolError } from '../../utils/errors.js';
import { getTask, listTasks } from '../../kanban/kanban-store.js';
import type { TaskComplexity, KanbanTask } from '../../kanban/types.js';
import { generateObject } from '../../ai/structured-output.js';

const complexityResultSchema = z.object({
  score: z.number().min(1).max(10).describe('Complexity score 1-10'),
  recommendedSubtasks: z.number().min(0).max(20).describe('How many subtasks to split into'),
  reasoning: z.string().describe('Brief explanation of complexity score'),
  suggestedLabels: z.array(z.string()).optional().describe('Suggested labels based on analysis'),
});

const schema = z.object({
  action: z.enum(['analyze', 'analyze-board', 'get']).describe(
    'Action: analyze (single task), analyze-board (all tasks on board), get (retrieve stored complexity)'
  ),
  taskId: z.string().optional().describe('Task ID (for analyze, get)'),
  sessionId: z.string().optional().describe('Session ID (for analyze-board)'),
  boardId: z.string().optional().describe('Board ID (for analyze-board)'),
  model: z.string().optional().describe('Model to use for analysis (default: configured main model)'),
});

async function analyzeTaskComplexity(
  task: KanbanTask,
  model?: string,
): Promise<TaskComplexity> {
  const prompt = [
    `Analyze the complexity of this software task:`,
    ``,
    `Title: ${task.title}`,
    task.description ? `Description: ${task.description}` : '',
    `Priority: ${task.priority}`,
    `Status: ${task.status}`,
    task.relatedFiles.length > 0 ? `Related files: ${task.relatedFiles.join(', ')}` : '',
    task.labels.length > 0 ? `Labels: ${task.labels.join(', ')}` : '',
    task.blockedBy.length > 0 ? `Blocked by: ${task.blockedBy.length} tasks` : '',
    task.blocks.length > 0 ? `Blocks: ${task.blocks.length} tasks` : '',
    ``,
    `Score the complexity 1-10:`,
    `1-2: Trivial (config change, typo fix)`,
    `3-4: Simple (single file change, clear implementation)`,
    `5-6: Moderate (multi-file, some design decisions)`,
    `7-8: Complex (architectural changes, multiple systems)`,
    `9-10: Very complex (cross-service, high risk, novel problems)`,
    ``,
    `Also recommend how many subtasks to break this into (0 means no splitting needed).`,
  ].filter(Boolean).join('\n');

  const result = await generateObject({
    model,
    schema: complexityResultSchema,
    prompt,
    system: 'You are a senior software engineer assessing task complexity. Be precise and practical.',
    temperature: 0.3,
    maxTokens: 512,
  });

  return {
    score: result.object.score,
    recommendedSubtasks: result.object.recommendedSubtasks,
    reasoning: result.object.reasoning,
    suggestedLabels: result.object.suggestedLabels,
    analyzedAt: Date.now(),
    analyzedBy: result.model,
  };
}

export const taskComplexityTool: UnifiedTool<typeof schema> = {
  name: 'task-complexity',
  description: 'LLM-scored complexity analysis (1-10) with subtask recommendations for Kanban tasks',
  zodSchema: schema,
  metadata: {
    category: 'kanban',
    tags: ['complexity', 'analysis', 'ai', 'planning'],
    aiRequired: true,
    annotations: {
      title: 'Task Complexity Analysis',
      readOnlyHint: false,
      openWorldHint: true,
    },
  },

  execute: async (args) => {
    try {
      const { action, taskId, sessionId, boardId, model } = args;

      if (action === 'get') {
        if (!taskId) return JSON.stringify({ success: false, error: 'taskId required for get' });
        const task = await getTask(taskId);
        if (!task) return JSON.stringify({ success: false, error: `Task not found: ${taskId}` });
        return JSON.stringify({
          success: true,
          taskId,
          complexity: task.complexity || null,
          hasAnalysis: !!task.complexity,
        });
      }

      if (action === 'analyze') {
        if (!taskId) return JSON.stringify({ success: false, error: 'taskId required for analyze' });
        const task = await getTask(taskId);
        if (!task) return JSON.stringify({ success: false, error: `Task not found: ${taskId}` });

        const complexity = await analyzeTaskComplexity(task, model);

        // Store complexity in task
        const { getSharedRedis: getRedis } = await import('../../infrastructure/redis/connection.js');
        const client = await getRedis();
        const KANBAN_KEYS = (await import('../../kanban/types.js')).KANBAN_KEYS;
        await client.hset(KANBAN_KEYS.task(taskId), 'complexity', JSON.stringify(complexity));

        return JSON.stringify({
          success: true,
          taskId,
          title: task.title,
          complexity,
        });
      }

      if (action === 'analyze-board') {
        if (!sessionId) return JSON.stringify({ success: false, error: 'sessionId required for analyze-board' });

        const tasks = await listTasks(sessionId, boardId ? { boardId } : undefined);
        const results: Array<{ taskId: string; title: string; complexity: TaskComplexity }> = [];

        for (const task of tasks) {
          // Skip already-analyzed tasks
          if (task.complexity) {
            results.push({ taskId: task.id, title: task.title, complexity: task.complexity });
            continue;
          }

          try {
            const complexity = await analyzeTaskComplexity(task, model);

            // Store
            const { getSharedRedis: getRedis } = await import('../../infrastructure/redis/connection.js');
            const client = await getRedis();
            const KANBAN_KEYS = (await import('../../kanban/types.js')).KANBAN_KEYS;
            await client.hset(KANBAN_KEYS.task(task.id), 'complexity', JSON.stringify(complexity));

            results.push({ taskId: task.id, title: task.title, complexity });
          } catch (err) {
            results.push({
              taskId: task.id,
              title: task.title,
              complexity: {
                score: 0,
                recommendedSubtasks: 0,
                reasoning: `Analysis failed: ${err instanceof Error ? err.message : String(err)}`,
                analyzedAt: Date.now(),
              },
            });
          }
        }

        // Sort by complexity score (highest first)
        results.sort((a, b) => b.complexity.score - a.complexity.score);

        return JSON.stringify({
          success: true,
          sessionId,
          boardId,
          totalTasks: results.length,
          averageComplexity: results.length > 0
            ? Math.round((results.reduce((sum, r) => sum + r.complexity.score, 0) / results.length) * 10) / 10
            : 0,
          results,
        });
      }

      return JSON.stringify({ success: false, error: `Unknown action: ${action}` });
    } catch (error) {
      return handleToolError('task-complexity', error);
    }
  },
};
