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
    .max(100)
    .default(3)
    .describe('Maximum clusters to dispatch to (0 = all matching)'),
  timeoutMs: z
    .number()
    .min(1000)
    .max(600000)
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
  maxPasses: z
    .number()
    .min(1)
    .max(20)
    .optional()
    .describe('Pass budget: max LLM passes per cluster (enables self-regulating multi-pass execution)'),
  qualityThreshold: z
    .number()
    .min(0)
    .max(1)
    .default(0.8)
    .describe('Quality threshold for early stop (0-1, default 0.8)'),
  passStrategy: z
    .enum(['min-passes', 'quality-target', 'fixed'])
    .default('min-passes')
    .describe('Pass budget strategy: min-passes (LLM decides), quality-target (iterate to quality), fixed (exact N passes)'),
  agentCount: z
    .number()
    .min(1)
    .max(5)
    .default(1)
    .describe('Number of agents for multi-agent iteration (1=single-shot, 2+=producer/reviewer iteration)'),
  agentMaxPasses: z
    .number()
    .min(1)
    .max(10)
    .default(3)
    .describe('Max iteration passes between agents (only when agentCount > 1)'),
  agentQualityThreshold: z
    .number()
    .min(0)
    .max(1)
    .default(0.8)
    .describe('Quality threshold for agent convergence (only when agentCount > 1)'),
  orchestrate: z
    .boolean()
    .default(false)
    .describe('Enable full agentic orchestration — each cluster spawns a supervisor that reasons + calls tools autonomously'),
  orchestrateAgent: z
    .enum(['plan', 'build', 'explore', 'general'])
    .default('plan')
    .describe('Agent type for orchestration (only when orchestrate=true)'),
  orchestrateMaxIterations: z
    .number()
    .min(1)
    .max(30)
    .default(10)
    .describe('Max tool-call iterations per cluster (only when orchestrate=true)'),
  orchestrateAllowedTools: z
    .array(z.string())
    .optional()
    .describe('Tool whitelist for orchestration agents (only when orchestrate=true)'),
  orchestrateEnableCognition: z
    .boolean()
    .default(false)
    .describe('Enable cognitive tools in orchestration (only when orchestrate=true)'),
  orchestrateEnableKanban: z
    .boolean()
    .default(false)
    .describe('Enable kanban tools (task, board) in orchestration for recording findings'),
  orchestrateEnableCollaboration: z
    .boolean()
    .default(true)
    .describe('Auto-add shared-thoughts + get-shared-context for inter-cluster communication (only when maxTargets > 1)'),
  orchestrateFocusAreas: z
    .array(z.string())
    .optional()
    .describe('Work partitioning: assign each cluster a focus area (e.g., ["security", "performance", "error-handling"]). Clusters without a focus get general analysis.'),
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
      {
        args: {
          prompt: 'Analyze this architecture for scalability issues',
          strategy: 'first-wins',
          agentCount: 2,
          agentMaxPasses: 3,
          agentQualityThreshold: 0.85,
        },
        description: 'Multi-agent: producer/reviewer iterate until quality convergence',
      },
      {
        args: {
          prompt: 'Find potential race conditions in the cluster-bus module',
          strategy: 'first-wins',
          orchestrate: true,
          orchestrateAgent: 'plan',
          orchestrateMaxIterations: 8,
          orchestrateAllowedTools: ['find-definition', 'find-references', 'semantic-search'],
        },
        description: 'Orchestrated: cluster spawns a supervisor that uses tools to analyze code',
      },
      {
        args: {
          prompt: 'Audit this codebase for quality issues',
          strategy: 'best-of-n',
          maxTargets: 5,
          orchestrate: true,
          orchestrateAgent: 'plan',
          orchestrateMaxIterations: 15,
          orchestrateEnableKanban: true,
          orchestrateEnableCollaboration: true,
          orchestrateFocusAreas: ['security vulnerabilities', 'performance bottlenecks', 'error handling gaps', 'race conditions', 'memory leaks'],
        },
        description: 'Work partitioning: 5 clusters each focus on a different quality aspect',
      },
    ],
    relatedTools: ['cluster-bus-status', 'cluster-bus-send', 'cluster-bus-topology'],
  },

  execute: async (args) => {
    if (!isClusterBusActive()) {
      return 'Cluster bus is not active. Check Redis connectivity and server logs.';
    }

    const bus = getClusterBus();
    if (!bus) return 'Cluster bus not initialized.';

    const magistrale = new LLMMagistrale(bus);

    let response;
    try {
      response = await magistrale.dispatch(args.prompt, {
        strategy: args.strategy as AggregationStrategy,
        maxTargets: args.maxTargets,
        timeoutMs: args.timeoutMs,
        minResponses: args.minResponses,
        preferredProvider: args.preferredProvider,
        preferredModel: args.preferredModel,
        passConfig: args.maxPasses ? {
          maxPasses: args.maxPasses,
          qualityThreshold: args.qualityThreshold,
          strategy: args.passStrategy,
        } : undefined,
        agentIteration: args.agentCount > 1 ? {
          agentCount: args.agentCount,
          maxPasses: args.agentMaxPasses,
          qualityThreshold: args.agentQualityThreshold,
        } : undefined,
        orchestrate: args.orchestrate ? (() => {
          // Build effective allowed tools list with auto-injected collaboration/kanban tools
          const effectiveTools = args.orchestrateAllowedTools ? [...args.orchestrateAllowedTools] : undefined;

          const collaborationTools = ['shared-thoughts', 'get-shared-context'];
          const kanbanTools = ['task', 'task-multi', 'board'];

          if (effectiveTools) {
            // Auto-inject collaboration tools for multi-cluster dispatch
            if (args.orchestrateEnableCollaboration !== false && args.maxTargets > 1) {
              for (const t of collaborationTools) {
                if (!effectiveTools.includes(t)) effectiveTools.push(t);
              }
            }
            // Inject kanban tools if enabled
            if (args.orchestrateEnableKanban) {
              for (const t of kanbanTools) {
                if (!effectiveTools.includes(t)) effectiveTools.push(t);
              }
            }
          }

          return {
            agent: args.orchestrateAgent,
            maxIterations: args.orchestrateMaxIterations,
            allowedTools: effectiveTools,
            enableCognition: args.orchestrateEnableCognition,
            isMultiCluster: args.maxTargets > 1,
            focusAreas: args.orchestrateFocusAreas,
          };
        })() : undefined,
      });
    } finally {
      // Always clean up subscriptions and intervals to prevent leaks
      magistrale.destroy();
    }

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

    if (response.totalPassesAllClusters !== undefined) {
      lines.push(`- **Total Passes (all clusters):** ${response.totalPassesAllClusters}`);
    }
    if (response.avgQuality !== undefined) {
      lines.push(`- **Avg Quality:** ${(response.avgQuality * 100).toFixed(1)}%`);
    }

    lines.push('', '## Response', '', response.content || '*No response received*');

    // Show errors for any failed results
    const errors = response.results.filter((r) => r.error);
    if (errors.length > 0) {
      lines.push('', '## Errors', '');
      for (const err of errors) {
        lines.push(`- **${err.clusterId}**: ${err.error}`);
      }
    }

    if (response.results.length > 1) {
      lines.push('', '## Individual Results', '');
      for (const result of response.results) {
        if (result.error) {
          lines.push(`- **${result.clusterId}**: Error - ${result.error}`);
        } else {
          const passInfo = result.passReport
            ? ` | passes=${result.passReport.totalPasses} (declared=${result.passReport.minPassesDeclared}), quality=${(result.passReport.qualityAchieved * 100).toFixed(0)}%`
            : '';
          lines.push(
            `- **${result.clusterId}** (${result.provider}/${result.model}): ${result.latencyMs}ms, ${result.completionTokens ?? '?'} tokens${passInfo}`,
          );
        }
      }
    }

    // Pass budget detail for single-cluster results
    if (response.results.length === 1 && response.results[0].passReport) {
      const report = response.results[0].passReport;
      lines.push('', '## Pass Budget Report', '');
      lines.push(`- **Strategy:** ${args.passStrategy}`);
      lines.push(`- **Min Passes Declared:** ${report.minPassesDeclared}`);
      lines.push(`- **Total Passes:** ${report.totalPasses}`);
      lines.push(`- **Quality Achieved:** ${(report.qualityAchieved * 100).toFixed(1)}%`);
      lines.push('', '| Pass | Quality | Sufficient | Tokens | Latency |');
      lines.push('|------|---------|------------|--------|---------|');
      for (const p of report.passHistory) {
        lines.push(
          `| ${p.pass === 0 ? 'assess' : p.pass} | ${(p.quality * 100).toFixed(0)}% | ${p.sufficient ? 'yes' : 'no'} | ${p.tokensUsed} | ${p.latencyMs}ms |`,
        );
      }
    }

    return lines.join('\n');
  },
};
