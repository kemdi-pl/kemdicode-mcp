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
import { UnifiedTool } from './registry.js';
import { executeAI, parseFiles, type AgentType } from '../ai/index.js';
import { ERROR_MESSAGES } from '../constants.js';
import { isClusterBusActive, getClusterBus, LLMMagistrale } from '../cluster-bus/index.js';
import type { AggregationStrategy, MagistraleResponse } from '../cluster-bus/index.js';

const schema = z.object({
  prompt: z.string().min(1).describe('Request prompt. Use @filepath to include files.'),
  model: z.string().optional().describe('Model override (e.g., google/gemini-2.5-flash)'),
  agent: z
    .enum(['plan', 'build', 'explore', 'general'])
    .default('plan')
    .describe('Agent: plan (analysis), build (execution), explore (search)'),
  files: z.string().optional().describe('Space-separated file paths to attach'),
  continueSession: z.boolean().default(false).describe('Continue last session'),
  temperature: z.number().min(0).max(2).optional().describe('Temperature override'),
  maxTokens: z.number().int().min(1).optional().describe('Max tokens override'),
  systemPrompt: z.string().optional().describe('System prompt override (replaces agent default)'),
  // Cluster routing
  cluster: z
    .boolean()
    .default(false)
    .describe('Route through cluster bus (multi-agent iteration) instead of direct API'),
  strategy: z
    .enum(['first-wins', 'best-of-n', 'consensus', 'fallback-chain'])
    .default('consensus')
    .describe('Cluster aggregation strategy'),
  agents: z
    .number()
    .min(1)
    .max(5)
    .default(2)
    .describe('Number of agents per cluster (1=single-shot, 2+=producer/reviewer iteration)'),
  maxPasses: z
    .number()
    .min(1)
    .max(10)
    .default(3)
    .describe('Max iteration passes between agents in cluster'),
  qualityThreshold: z
    .number()
    .min(0)
    .max(1)
    .default(0.8)
    .describe('Quality threshold for agent convergence'),
});

function formatMagistraleResponse(response: MagistraleResponse): string {
  const lines: string[] = [];

  if (response.content) {
    lines.push(response.content);
  } else {
    lines.push('*No response received from clusters*');
  }

  // Add metadata footer
  lines.push('');
  lines.push('---');
  lines.push(
    `*Strategy: ${response.strategy} | Clusters: ${response.dispatchedTo} | Success: ${response.successCount} | Latency: ${response.totalLatencyMs}ms*`
  );

  if (response.consensusScore !== undefined) {
    lines.push(`*Consensus: ${(response.consensusScore * 100).toFixed(0)}%*`);
  }

  if (response.avgQuality !== undefined) {
    lines.push(`*Avg Quality: ${(response.avgQuality * 100).toFixed(0)}%*`);
  }

  const errors = response.results.filter((r) => r.error);
  if (errors.length > 0) {
    lines.push('');
    for (const err of errors) {
      lines.push(`**Error (${err.clusterId}):** ${err.error}`);
    }
  }

  return lines.join('\n');
}

export const askAITool: UnifiedTool = {
  name: 'ask-ai',
  description:
    'Execute AI directly (solo) or via cluster bus (multi-agent iteration). Supports model, agent, files, cluster routing.',
  zodSchema: schema,
  prompt: { description: 'Direct AI access' },
  metadata: {
    category: 'specialized',
    tags: ['ai', 'query', 'direct', 'cluster'],
    longRunning: true,
    aiRequired: true,
    aiRouting: 'hybrid',
    examples: [
      {
        args: { prompt: 'Explain the SOLID principles with TypeScript examples' },
        description: 'Solo: Ask AI directly using default agent',
      },
      {
        args: { prompt: 'Refactor this code for readability', agent: 'build', files: '@src/index.ts' },
        description: 'Solo: Execute AI with file context and build agent',
      },
      {
        args: {
          prompt: 'Review this auth flow for security issues',
          cluster: true,
          agents: 2,
          strategy: 'consensus',
        },
        description: 'Cluster: Multi-agent iteration with consensus aggregation',
      },
    ],
    relatedTools: ['plan', 'build', 'brainstorm', 'cluster-bus-magistrale'],
  },

  execute: async (args, onProgress) => {
    if (!args.prompt?.toString().trim()) throw new Error(ERROR_MESSAGES.NO_PROMPT);

    const prompt = String(args.prompt);

    // Cluster mode: route through magistrale with multi-agent iteration
    if (args.cluster && isClusterBusActive()) {
      const bus = getClusterBus();
      if (!bus) {
        return 'Error: Cluster bus not initialized. Use solo mode (cluster: false).';
      }

      const magistrale = new LLMMagistrale(bus);
      try {
        const response = await magistrale.dispatch(prompt, {
          strategy: (args.strategy || 'consensus') as AggregationStrategy,
          maxTargets: 3,
          timeoutMs: 60000,
          minResponses: args.strategy === 'consensus' ? 2 : 1,
          preferredModel: args.model as string | undefined,
          systemPrompt: args.systemPrompt as string | undefined,
          temperature:
            typeof args.temperature === 'number' ? args.temperature : undefined,
          maxTokens:
            typeof args.maxTokens === 'number' ? args.maxTokens : undefined,
          agentIteration: (args.agents as number) > 1 ? {
            agentCount: args.agents as number,
            maxPasses: (args.maxPasses as number) ?? 3,
            qualityThreshold: (args.qualityThreshold as number) ?? 0.8,
          } : undefined,
        });

        return formatMagistraleResponse(response);
      } catch (err) {
        return `Error (cluster): ${err instanceof Error ? err.message : String(err)}`;
      } finally {
        magistrale.destroy();
      }
    }

    // Cluster requested but bus not active
    if (args.cluster) {
      return 'Error: Cluster bus is not active. Start cluster bus first or use solo mode (cluster: false).';
    }

    // Solo mode: direct API call via executeAI
    try {
      return await executeAI({
        prompt,
        agent: (args.agent || 'plan') as AgentType,
        model: args.model as string | undefined,
        files: args.files ? parseFiles(String(args.files)) : undefined,
        continueSession: Boolean(args.continueSession),
        temperature: typeof args.temperature === 'number' ? args.temperature : undefined,
        maxTokens: typeof args.maxTokens === 'number' ? args.maxTokens : undefined,
        systemPrompt: args.systemPrompt as string | undefined,
        onProgress,
        enhancePrompt: true,
      });
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
