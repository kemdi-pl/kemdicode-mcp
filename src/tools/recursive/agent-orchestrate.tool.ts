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
 * Agent Orchestrate Tool
 *
 * Launches an autonomous agentic loop: AI reasons about a task,
 * calls tools, processes results, and iterates until completion.
 * Supports sub-agent spawning and dependency injection.
 *
 * @module tools/recursive/agent-orchestrate
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { executeWithGuard } from '../tool-shared.js';
import { executeAgenticLoop } from '../../recursive/agentic-loop.js';
import { isSilent } from '../../config/silent.js';

const schema = z.object({
  task: z.string().min(1).describe('Task description for the AI agent to solve'),
  agent: z
    .enum(['plan', 'build', 'explore', 'general'])
    .default('plan')
    .describe('Agent type (plan=analysis, build=implementation, explore=search, general=balanced)'),
  model: z.string().optional().describe('Model override (provider:model syntax)'),
  sessionId: z.string().min(1).describe('Session ID for conversation tracking'),
  maxIterations: z.number().min(1).max(50).default(20).describe('Maximum loop iterations (1-50)'),
  maxSubAgentDepth: z
    .number()
    .min(0)
    .max(3)
    .default(2)
    .describe('Maximum sub-agent nesting depth (0=no sub-agents)'),
  allowedTools: z.array(z.string()).optional().describe('Whitelist of allowed tools (empty=all)'),
  blockedTools: z.array(z.string()).optional().describe('Blacklist of blocked tools'),
  enableCognition: z
    .boolean()
    .default(false)
    .describe(
      'Enable cognitive tools (decision-journal, confidence-tracker, thinking-chain, shared-thoughts, error-pattern, self-critique)'
    ),
  useFunctionCalling: z
    .boolean()
    .default(true)
    .describe('Use native function calling (true) or text-based parsing (false)'),
  maxTokens: z
    .number()
    .min(1024)
    .max(32768)
    .optional()
    .describe(
      'Override max tokens for AI responses (default: from agent config — plan=16384, build=8192, explore=4096, general=8192)'
    ),
  temperature: z
    .number()
    .min(0)
    .max(2)
    .optional()
    .describe(
      'Override temperature for AI responses (default: from agent config — plan=0.7, build=0.3, explore=0.5, general=0.5)'
    ),
});

export const agentOrchestrateTool: UnifiedTool = {
  name: 'agent-orchestrate',
  description:
    'Launch autonomous AI agent loop: AI reasons → calls tools → processes results → iterates. Supports sub-agents.',
  zodSchema: schema,
  metadata: {
    category: 'recursive',
    tags: ['agent', 'orchestrate', 'autonomous', 'loop'],
    aiRequired: true,
    examples: [
      {
        args: {
          task: 'Find all TODO comments in the codebase and create a summary',
          agent: 'explore',
          sessionId: 'sess-abc123',
          maxIterations: 5,
        },
        description: 'Autonomous exploration task',
      },
      {
        args: {
          task: 'Execute 100 test tasks and update progress in kanban',
          agent: 'build',
          sessionId: 'sess-abc123',
          maxIterations: 30,
          enableCognition: true,
        },
        description: 'Large-scale task execution with cognition tracking',
      },
      {
        args: {
          task: 'Review src/auth.ts for security issues and suggest fixes',
          agent: 'plan',
          sessionId: 'sess-abc123',
          maxIterations: 8,
          allowedTools: ['find-definition', 'find-references', 'semantic-search', 'error-pattern'],
        },
        description: 'Scoped security review with limited tool access',
      },
      {
        args: {
          task: 'Analyze the project structure and create a mental model',
          agent: 'plan',
          sessionId: 'sess-abc123',
          maxSubAgentDepth: 1,
          blockedTools: ['task-delete', 'workspace-delete'],
        },
        description: 'Read-only analysis with sub-agents but no destructive access',
      },
      {
        args: {
          task: 'Review src/auth/ for security issues. Record decisions and share findings with other agents.',
          agent: 'plan',
          sessionId: 'sess-abc123',
          maxIterations: 8,
          maxSubAgentDepth: 2,
          enableCognition: true,
          allowedTools: ['find-definition', 'find-references', 'semantic-search', 'error-pattern'],
        },
        description: 'Security audit with cognitive tools and sub-agent replication',
      },
    ],
    relatedTools: ['invoke-tool', 'invoke-batch', 'pipeline', 'ask-ai'],
  },

  execute: async (args, onProgress): Promise<string> => {
    const input = schema.parse(args);

    return executeWithGuard(
      'agent-orchestrate',
      'recursive-operations',
      async () => {
        const result = await executeAgenticLoop({
          task: input.task,
          agent: input.agent,
          model: input.model,
          sessionId: input.sessionId,
          maxIterations: input.maxIterations,
          maxSubAgentDepth: input.maxSubAgentDepth,
          allowedTools: input.allowedTools,
          blockedTools: input.blockedTools,
          enableCognition: input.enableCognition,
          useFunctionCalling: input.useFunctionCalling,
          maxTokens: input.maxTokens,
          temperature: input.temperature,
          onProgress: onProgress ? (msg) => onProgress(msg) : undefined,
        });

        if (isSilent()) {
          return (
            result.answer ||
            JSON.stringify({
              completed: result.completed,
              iterations: result.iterations,
              stopReason: result.stopReason,
            })
          );
        }

        return JSON.stringify({
          success: result.completed,
          answer: result.answer,
          iterations: result.iterations,
          stopReason: result.stopReason,
          duration: result.duration,
          toolCallsTotal: result.log.reduce((sum, i) => sum + i.toolCalls.length, 0),
          subAgents: result.subAgentResults?.length ?? 0,
          log: result.log.map((i) => ({
            iteration: i.iteration,
            toolCalls: i.toolCalls.map((tc) => ({
              tool: tc.tool,
              success: tc.success,
              duration: tc.duration,
              resultPreview: tc.result.slice(0, 200),
            })),
          })),
        });
      },
      { maxRequests: 10, windowMs: 60000 }
    );
  },
};
