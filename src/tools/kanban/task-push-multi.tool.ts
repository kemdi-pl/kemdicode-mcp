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
 * Task Push Multi Tool
 *
 * Pushes a task to multiple agents (assign, clone, or notify).
 * Enables supervisor to distribute work across agents.
 *
 * @module tools/kanban/task-push-multi
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { Logger } from '../../utils/logger.js';
import { checkRateLimit } from '../../utils/validation.js';
import { getTask, createTask, assignTask, TaskPriority } from '../../kanban/index.js';

/** Target agent specification */
const targetAgentSchema = z.object({
  agentId: z.string().min(1).describe('Target agent ID'),
  sessionId: z.string().min(1).describe("Target agent's session ID"),
});

const schema = z.object({
  taskId: z.string().optional().describe('Existing task ID to push (for assign/notify modes)'),
  taskData: z
    .object({
      title: z.string().min(1).max(200).describe('Task title'),
      description: z.string().optional().describe('Task description'),
      priority: z.enum(['critical', 'high', 'normal', 'low']).default('normal'),
      labels: z.array(z.string()).optional(),
      relatedFiles: z.array(z.string()).optional(),
      estimatedMinutes: z.number().positive().optional(),
    })
    .optional()
    .describe('Task data for clone mode (creates new tasks)'),
  targetAgents: z
    .array(targetAgentSchema)
    .min(1)
    .max(20)
    .describe('Target agents to receive the task'),
  mode: z
    .enum(['assign', 'clone', 'notify'])
    .describe(
      'Push mode: assign (assign single task to one agent), clone (create copies for each agent), notify (alert agents about task)'
    ),
  supervisorId: z.string().min(1).describe('Supervisor agent ID making the push'),
  sessionId: z.string().min(1).describe("Supervisor's session ID"),
  boardId: z.string().optional().describe('Board ID for new tasks (clone mode)'),
});

type TaskPushMultiArgs = z.infer<typeof schema>;

/** Helper to notify agents about a task */
async function notifyAgents(
  input: TaskPushMultiArgs,
  taskId: string,
  results: Array<{
    agentId: string;
    sessionId: string;
    success: boolean;
    taskId?: string;
    error?: string;
  }>
): Promise<void> {
  for (const target of input.targetAgents) {
    results.push({
      agentId: target.agentId,
      sessionId: target.sessionId,
      success: true,
      taskId,
    });
  }
}

export const taskPushMultiTool: UnifiedTool = {
  name: 'task-push-multi',
  description: 'Push a task to multiple agents (assign single task, clone for each, or notify all)',
  zodSchema: schema,

  execute: async (args): Promise<string> => {
    const validated = schema.safeParse(args);
    if (!validated.success) {
      const errors = validated.error.flatten().fieldErrors;
      const messages = Object.values(errors).flat().filter(Boolean);
      return JSON.stringify({
        success: false,
        error: 'Invalid input',
        code: 'INVALID_INPUT',
        details: messages,
      });
    }
    const input = validated.data;

    if (!checkRateLimit('kanban-operations', { maxRequests: 50, windowMs: 60000 })) {
      return JSON.stringify({
        success: false,
        error: 'Rate limit exceeded for multi-push operations',
        code: 'RATE_LIMIT_EXCEEDED',
      });
    }

    try {
      const results: Array<{
        agentId: string;
        sessionId: string;
        success: boolean;
        taskId?: string;
        error?: string;
      }> = [];

      if (input.mode === 'assign') {
        // Assign mode: assign existing task to first agent, others get notified
        if (!input.taskId) {
          return JSON.stringify({
            success: false,
            error: 'taskId required for assign mode',
            code: 'MISSING_TASK_ID',
          });
        }

        const task = await getTask(input.taskId);
        if (!task) {
          return JSON.stringify({
            success: false,
            error: 'Task not found',
            code: 'NOT_FOUND',
          });
        }

        // Assign to first agent
        const primaryTarget = input.targetAgents[0];
        const primaryResult: {
          agentId: string;
          sessionId: string;
          success: boolean;
          taskId?: string;
          error?: string;
        } = {
          agentId: primaryTarget.agentId,
          sessionId: primaryTarget.sessionId,
          success: false,
          error: undefined,
        };
        try {
          await assignTask(input.taskId, primaryTarget.agentId, input.supervisorId);
          primaryResult.success = true;
          primaryResult.taskId = input.taskId;
          results.push(primaryResult);
        } catch (error) {
          primaryResult.error = error instanceof Error ? error.message : String(error);
          primaryResult.success = false;
          results.push(primaryResult);
        }

        // Notify other agents
        await notifyAgents(input, input.taskId, results);
        if (primaryResult.success) {
          Logger.debug(
            `task-push-multi: assigned task ${input.taskId} to ${primaryTarget.agentId}`
          );
        }
      } else if (input.mode === 'clone') {
        // Clone mode: create a copy of the task for each agent
        if (!input.taskData && !input.taskId) {
          return JSON.stringify({
            success: false,
            error: 'taskData or taskId required for clone mode',
            code: 'MISSING_TASK_DATA',
          });
        }

        // Get base task data
        let baseTask = input.taskData;
        if (input.taskId && !baseTask) {
          const existingTask = await getTask(input.taskId);
          if (!existingTask) {
            return JSON.stringify({
              success: false,
              error: 'Source task not found',
              code: 'NOT_FOUND',
            });
          }
          baseTask = {
            title: existingTask.title,
            description: existingTask.description,
            priority: existingTask.priority,
            labels: existingTask.labels,
            relatedFiles: existingTask.relatedFiles,
            estimatedMinutes: existingTask.estimatedMinutes,
          };
        }

        if (!baseTask) {
          return JSON.stringify({
            success: false,
            error: 'Could not determine task data for cloning',
            code: 'NO_TASK_DATA',
          });
        }

        // Create a task for each target agent
        for (const target of input.targetAgents) {
          try {
            const newTask = await createTask({
              sessionId: target.sessionId,
              boardId: input.boardId,
              title: baseTask.title,
              description: baseTask.description,
              priority: baseTask.priority as TaskPriority,
              createdBy: input.supervisorId,
              labels: [...(baseTask.labels || []), 'multi-push', `from:${input.supervisorId}`],
              relatedFiles: baseTask.relatedFiles,
              estimatedMinutes: baseTask.estimatedMinutes,
            });

            // Assign to target agent
            await assignTask(newTask.id, target.agentId, input.supervisorId);

            results.push({
              agentId: target.agentId,
              sessionId: target.sessionId,
              success: true,
              taskId: newTask.id,
            });
          } catch (error) {
            results.push({
              agentId: target.agentId,
              sessionId: target.sessionId,
              success: false,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        Logger.debug(
          `task-push-multi: cloned task to ${results.filter((r) => r.success).length} agents`
        );
      } else if (input.mode === 'notify') {
        // Notify mode: just record that agents were notified about a task
        if (!input.taskId) {
          return JSON.stringify({
            success: false,
            error: 'taskId required for notify mode',
            code: 'MISSING_TASK_ID',
          });
        }

        const task = await getTask(input.taskId);
        if (!task) {
          return JSON.stringify({
            success: false,
            error: 'Task not found',
            code: 'NOT_FOUND',
          });
        }

        await notifyAgents(input, input.taskId, results);
        Logger.debug(
          `task-push-multi: notified ${input.targetAgents.length} agents about task ${input.taskId}`
        );
      } else {
        // Notify mode: just record that agents were notified about a task
        if (!input.taskId) {
          return JSON.stringify({
            success: false,
            error: 'taskId required for notify mode',
            code: 'MISSING_TASK_ID',
          });
        }

        const task = await getTask(input.taskId);
        if (!task) {
          return JSON.stringify({
            success: false,
            error: 'Task not found',
            code: 'NOT_FOUND',
          });
        }

        await notifyAgents(input, input.taskId, results);
        Logger.debug(
          `task-push-multi: notified ${input.targetAgents.length} agents about task ${input.taskId}`
        );
      }

      const successCount = results.filter((r) => r.success).length;
      const failCount = results.filter((r) => !r.success).length;

      return JSON.stringify({
        success: failCount === 0,
        mode: input.mode,
        summary: {
          total: results.length,
          success: successCount,
          failed: failCount,
        },
        results,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      Logger.error(`task-push-multi error: ${errorMessage}`);

      return JSON.stringify({
        success: false,
        error: errorMessage,
        code: 'PUSH_ERROR',
      });
    }
  },
};
