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
import { executeWithGuard } from '../tool-shared.js';
import { getTask, createTask, assignTask, TaskPriority, resolveSessionId, resolveBoardId } from '../../kanban/index.js';
import { isSilent } from '../../config/silent.js';
import { getAgentRankStore } from '../../cognition/agent-rank-store.js';

/** Target agent specification */
const targetAgentSchema = z.object({
  agentId: z.string().min(1).describe('Target agent ID'),
  sessionId: z.string().min(1).describe('Target agent session ID'),
});

const schema = z.object({
  taskId: z.string().optional().describe('Existing task ID (required for assign/notify)'),
  taskData: z
    .object({
      title: z.string().min(1).max(200).describe('Task title'),
      description: z.string().optional().describe('Description'),
      priority: z.preprocess(
        (v) => {
          const aliases: Record<string, string> = { medium: 'normal', urgent: 'critical', important: 'high', minor: 'low', trivial: 'low' };
          return typeof v === 'string' ? (aliases[v.toLowerCase()] ?? v) : v;
        },
        z.enum(['critical', 'high', 'normal', 'low']).default('normal'),
      ),
      labels: z.array(z.string()).optional(),
      relatedFiles: z.array(z.string()).optional(),
      estimatedMinutes: z.number().positive().optional(),
    })
    .optional()
    .describe('Task data for clone mode'),
  targetAgents: z
    .array(targetAgentSchema)
    .min(1)
    .max(20)
    .describe('Target agents (1-20)'),
  mode: z
    .enum(['assign', 'clone', 'notify'])
    .describe(
      'assign=single task to one agent, clone=copy per agent, notify=alert only'
    ),
  supervisorId: z.string().min(1).describe('Supervisor agent ID'),
  sessionId: z.string().optional().describe('Supervisor session ID (auto-detected from connection if omitted)'),
  boardId: z.string().optional().describe('Board ID or "name:Board Name" for clone mode'),
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
  description: 'Push task to multiple agents (assign/clone/notify)',
  zodSchema: schema,

  metadata: {
    category: 'kanban',
    tags: ['task', 'push', 'distribute'],
    examples: [
      { args: { taskId: 'task-1', targetAgents: [{ agentId: 'agent-2', sessionId: 'session-1' }], mode: 'assign', supervisorId: 'agent-1' }, description: 'Assign a task to an agent' },
      { args: { taskData: { title: 'Review code', priority: 'high' }, targetAgents: [{ agentId: 'agent-2', sessionId: 's-1' }, { agentId: 'agent-3', sessionId: 's-2' }], mode: 'clone', supervisorId: 'agent-1' }, description: 'Clone a task to multiple agents' },
    ],
    relatedTools: ['task-assign', 'task-create', 'agent-list'],
  },

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

    return executeWithGuard('task-push-multi', 'kanban-operations', async () => {
      // Resolve sessionId from args or active connection context
      const sessionId = resolveSessionId(input.sessionId);

      // Resolve boardId by name if needed
      const resolvedBoardId = input.boardId
        ? await resolveBoardId(input.boardId, sessionId)
        : undefined;

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
              boardId: resolvedBoardId,
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

      // Check agent rankings and suggest better agents if available
      let rankingSuggestion: string | undefined;
      try {
        const rankStore = getAgentRankStore();
        if (!rankStore.isConnected()) {
          await rankStore.connect().catch((err) => {
            Logger.debug(`[TaskPushMulti] Agent rank store connect failed: ${err instanceof Error ? err.message : String(err)}`);
          });
        }
        if (rankStore.isConnected() && input.targetAgents.length === 1) {
          const targetId = input.targetAgents[0].agentId;
          const targetScore = await rankStore.getScore(targetId);
          const leaderboard = await rankStore.getLeaderboard(3);
          if (targetScore && leaderboard.length > 0 && leaderboard[0].agentId !== targetId) {
            const topAgent = leaderboard[0];
            if (topAgent.score > (targetScore.score + 100)) {
              rankingSuggestion = `Consider agent "${topAgent.agentId}" (${topAgent.rank}, score: ${topAgent.score}) for better results. Current target "${targetId}" has score ${targetScore.score}.`;
            }
          }
        }
      } catch {
        // Ranking is best-effort
      }

      const successCount = results.filter((r) => r.success).length;
      const failCount = results.filter((r) => !r.success).length;

      // Silent mode: return task IDs only
      if (isSilent()) {
        const taskIds = results.filter((r) => r.success && r.taskId).map((r) => r.taskId);
        if (failCount > 0) {
          return JSON.stringify({ pushed: taskIds, errors: results.filter((r) => !r.success).map((r) => r.error) });
        }
        return JSON.stringify(taskIds);
      }

      return JSON.stringify({
        success: failCount === 0,
        mode: input.mode,
        summary: {
          total: results.length,
          success: successCount,
          failed: failCount,
        },
        results,
        ...(rankingSuggestion ? { rankingSuggestion } : {}),
      });
    });
  },
};
