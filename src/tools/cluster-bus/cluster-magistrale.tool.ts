/**
 * KemdiCode MCP Server - Cluster Magistrale Tool
 * Copyright (C) 2025-2026 Kemdi Sp. z o.o. (Dawid Irzyk <dawid@kemdi.pl>)
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import { z } from 'zod';
import type { UnifiedTool } from '../registry.js';
import {
  isClusterBusActive,
  getClusterBus,
  LLMMagistrale,
} from '../../cluster-bus/index.js';
import type { AggregationStrategy } from '../../cluster-bus/index.js';

const schema = z.object({
  prompt: z
    .string()
    .min(1)
    .describe('LLM prompt to dispatch across clusters'),
  strategy: z
    .enum(['first-wins', 'best-of-n', 'consensus', 'fallback-chain'])
    .default('first-wins')
    .describe('Aggregation strategy for multi-cluster responses'),
  maxTargets: z
    .number()
    .min(0)
    .max(20)
    .default(3)
    .describe('Maximum clusters to dispatch to (0 = all matching)'),
  timeoutMs: z
    .number()
    .min(1000)
    .max(120000)
    .default(30000)
    .describe('Timeout per cluster response in ms'),
  minResponses: z
    .number()
    .min(1)
    .max(10)
    .default(1)
    .describe('Minimum responses required (for consensus/best-of-n)'),
  preferredProvider: z
    .string()
    .optional()
    .describe('Preferred AI provider (e.g., anthropic, openai)'),
  preferredModel: z
    .string()
    .optional()
    .describe('Preferred model hint for target clusters'),
});

export const clusterMagistraleTool: UnifiedTool<typeof schema> = {
  name: 'cluster-bus-magistrale',
  description: 'Dispatch LLM prompt across multiple clusters in parallel with aggregation (first-wins, best-of-n, consensus, fallback-chain)',
  zodSchema: schema,
  metadata: {
    category: 'system',
    tags: ['cluster', 'llm', 'magistrale', 'parallel', 'consensus'],
    examples: [
      {
        args: {
          prompt: 'Explain the difference between Redis Pub/Sub and Redis Streams',
          strategy: 'first-wins',
          maxTargets: 3,
        },
        description: 'Fast parallel dispatch - return first response',
      },
      {
        args: {
          prompt: 'Review this code for security issues',
          strategy: 'consensus',
          maxTargets: 5,
          minResponses: 3,
        },
        description: 'Consensus: collect responses from 5 clusters, vote on best',
      },
    ],
    relatedTools: ['cluster-bus-status', 'cluster-bus-send', 'cluster-bus-topology'],
  },

  execute: async (args) => {
    if (!isClusterBusActive()) {
      return 'Cluster bus is not active. Enable with MCP_CLUSTER_ENABLED=1.';
    }

    const bus = getClusterBus();
    if (!bus) return 'Cluster bus not initialized.';

    const magistrale = new LLMMagistrale(bus);

    const response = await magistrale.dispatch(args.prompt, {
      strategy: args.strategy as AggregationStrategy,
      maxTargets: args.maxTargets,
      timeoutMs: args.timeoutMs,
      minResponses: args.minResponses,
      preferredProvider: args.preferredProvider,
      preferredModel: args.preferredModel,
    });

    const lines = [
      '# Magistrale Response',
      '',
      `- **Strategy:** ${response.strategy}`,
      `- **Dispatched To:** ${response.dispatchedTo} clusters`,
      `- **Successful:** ${response.successCount}`,
      `- **Latency:** ${response.totalLatencyMs}ms`,
      `- **Chosen Cluster:** ${response.chosenCluster || 'N/A'}`,
    ];

    if (response.consensusScore !== undefined) {
      lines.push(`- **Consensus Score:** ${(response.consensusScore * 100).toFixed(1)}%`);
    }

    lines.push('', '## Response', '', response.content || '*No response received*');

    if (response.results.length > 1) {
      lines.push('', '## Individual Results', '');
      for (const result of response.results) {
        if (result.error) {
          lines.push(`- **${result.clusterId}**: Error - ${result.error}`);
        } else {
          lines.push(
            `- **${result.clusterId}** (${result.provider}/${result.model}): ${result.latencyMs}ms, ${result.completionTokens ?? '?'} tokens`,
          );
        }
      }
    }

    return lines.join('\n');
  },
};
