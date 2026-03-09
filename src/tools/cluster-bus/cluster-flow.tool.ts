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
} from '../../cluster-bus/index.js';
import type { FlowPolicy, SignalType, SignalDirection, SignalPriority } from '../../cluster-bus/index.js';

const schema = z.object({
  action: z
    .enum([
      'list-policies',
      'add-policy',
      'remove-policies',
      'clear-policies',
      'circuit-status',
      'drain-queue',
      'burst-rate',
      'stats',
    ])
    .describe('Action: list-policies (show flow policies), add-policy (create flow policy), remove-policies (delete policies for signal type), clear-policies (remove all), circuit-status (check circuit breaker state), drain-queue (flush queued signals), burst-rate (temporary rate override), stats (flow statistics)'),

  // For add-policy
  signalTypes: z
    .array(z.string())
    .optional()
    .describe('Signal types this policy applies to (empty = all)'),
  allowedDirections: z
    .array(z.enum(['upstream', 'downstream', 'duplex']))
    .optional()
    .describe('Allowed signal directions: upstream (toward hub/coordinator), downstream (toward workers/leaves), duplex (both directions)'),
  rateLimit: z
    .number()
    .min(0)
    .optional()
    .describe('Max signals/second (0 = unlimited)'),
  maxQueueDepth: z
    .number()
    .min(0)
    .optional()
    .describe('Max queued signals before dropping (0 = unlimited)'),
  minPriority: z
    .number()
    .min(0)
    .max(3)
    .optional()
    .describe('Minimum priority to accept (0-3)'),
  bufferOnPressure: z
    .boolean()
    .optional()
    .describe('Buffer signals during backpressure instead of dropping'),

  // For remove-policies, circuit-status, drain-queue, burst-rate
  signalType: z
    .string()
    .optional()
    .describe('Signal type to query or operate on'),
  sourceCluster: z
    .string()
    .optional()
    .describe('Source cluster ID (for circuit-status, burst-rate)'),
  targetCluster: z
    .string()
    .optional()
    .describe('Target cluster ID (for circuit-status, burst-rate)'),

  // For drain-queue
  limit: z
    .number()
    .min(1)
    .max(200)
    .default(50)
    .describe('Max signals to drain'),
});

export const clusterFlowTool: UnifiedTool<typeof schema> = {
  name: 'cluster-bus-flow',
  description: 'Manage cluster bus flow control: policies, circuit breakers, backpressure queues, and burst detection',
  zodSchema: schema,
  metadata: {
    category: 'cluster-bus',
    tags: ['cluster', 'flow-control', 'rate-limit', 'circuit-breaker', 'backpressure'],
    examples: [
      { args: { action: 'list-policies' }, description: 'List all active flow policies' },
      { args: { action: 'stats' }, description: 'Get flow control statistics' },
      {
        args: {
          action: 'add-policy',
          signalTypes: ['data:broadcast'],
          allowedDirections: ['duplex'],
          rateLimit: 100,
          maxQueueDepth: 500,
          minPriority: 0,
          bufferOnPressure: true,
        },
        description: 'Add a rate-limiting policy for broadcast signals',
      },
      {
        args: { action: 'circuit-status', signalType: 'llm:request', sourceCluster: 'gpt52-a', targetCluster: '*' },
        description: 'Check circuit breaker status for a channel',
      },
      { args: { action: 'drain-queue', signalType: 'llm:request', limit: 20 }, description: 'Drain queued signals' },
      {
        args: { action: 'burst-rate', signalType: 'llm:request', sourceCluster: 'gpt52-a' },
        description: 'Get current burst rate for a channel',
      },
    ],
    relatedTools: ['cluster-bus-status', 'cluster-bus-send', 'cluster-bus-routing'],
  },

  execute: async (args) => {
    if (!isClusterBusActive()) {
      return 'Cluster bus is not active. Check Redis connectivity and server logs.';
    }

    const bus = getClusterBus();
    if (!bus) return 'Cluster bus not initialized.';

    const flow = bus.flowController;

    switch (args.action) {
      case 'list-policies': {
        const policies = flow.getPolicies();
        if (policies.length === 0) return 'No flow policies configured.';

        const lines = ['# Flow Policies', '', `Total: ${policies.length}`, ''];
        for (let i = 0; i < policies.length; i++) {
          const p = policies[i];
          lines.push(
            `### Policy ${i + 1}`,
            `- **Signal Types:** ${p.signalTypes.length > 0 ? p.signalTypes.join(', ') : 'all'}`,
            `- **Directions:** ${p.allowedDirections.length > 0 ? p.allowedDirections.join(', ') : 'all'}`,
            `- **Rate Limit:** ${p.rateLimit > 0 ? `${p.rateLimit}/s` : 'unlimited'}`,
            `- **Max Queue:** ${p.maxQueueDepth > 0 ? p.maxQueueDepth : 'unlimited'}`,
            `- **Min Priority:** ${p.minPriority}`,
            `- **Buffer on Pressure:** ${p.bufferOnPressure ? 'yes' : 'no'}`,
            '',
          );
        }
        return lines.join('\n');
      }

      case 'add-policy': {
        const policy: FlowPolicy = {
          signalTypes: (args.signalTypes || []) as SignalType[],
          allowedDirections: (args.allowedDirections || []) as SignalDirection[],
          rateLimit: args.rateLimit ?? 0,
          maxQueueDepth: args.maxQueueDepth ?? 0,
          minPriority: (args.minPriority ?? 0) as SignalPriority,
          bufferOnPressure: args.bufferOnPressure ?? false,
        };

        flow.addPolicy(policy);

        return [
          'Flow policy added.',
          `- Signal Types: ${policy.signalTypes.length > 0 ? policy.signalTypes.join(', ') : 'all'}`,
          `- Rate Limit: ${policy.rateLimit > 0 ? `${policy.rateLimit}/s` : 'unlimited'}`,
          `- Buffer on Pressure: ${policy.bufferOnPressure ? 'yes' : 'no'}`,
          `- Total policies: ${flow.getPolicies().length}`,
        ].join('\n');
      }

      case 'remove-policies': {
        if (!args.signalTypes || args.signalTypes.length === 0) {
          return 'Error: signalTypes is required for remove-policies action.';
        }
        const removed = flow.removePolicies(args.signalTypes as SignalType[]);
        return `Removed ${removed} policies matching signal types: ${args.signalTypes.join(', ')}. Remaining: ${flow.getPolicies().length}`;
      }

      case 'clear-policies': {
        const beforeCount = flow.getPolicies().length;
        flow.clearPolicies();
        return `Cleared all ${beforeCount} flow policies.`;
      }

      case 'circuit-status': {
        if (!args.signalType) return 'Error: signalType is required for circuit-status.';

        const isOpen = flow.isCircuitOpen(
          args.signalType as SignalType,
          args.sourceCluster || '*',
          args.targetCluster || '*',
        );

        const channelKey = `${args.signalType}:${args.sourceCluster || '*'}:${args.targetCluster || '*'}`;

        return [
          `# Circuit Breaker: ${channelKey}`,
          '',
          `- **State:** ${isOpen ? 'OPEN (blocking traffic)' : 'CLOSED (allowing traffic)'}`,
          `- **Signal Type:** ${args.signalType}`,
          `- **Source:** ${args.sourceCluster || '*'}`,
          `- **Target:** ${args.targetCluster || '*'}`,
        ].join('\n');
      }

      case 'drain-queue': {
        if (!args.signalType) return 'Error: signalType is required for drain-queue.';

        const drained = flow.drain(args.signalType as SignalType, args.limit);
        if (drained.length === 0) {
          return `No queued signals for type '${args.signalType}'.`;
        }

        const lines = [
          `# Drained ${drained.length} Signals`,
          '',
          `Type: ${args.signalType}`,
          '',
        ];

        for (const signal of drained) {
          lines.push(
            `- \`${signal.id.slice(0, 8)}\` ${signal.type} | ${signal.sourceCluster} → ${signal.targetCluster || '*'} | P${signal.priority}`,
          );
        }

        return lines.join('\n');
      }

      case 'burst-rate': {
        if (!args.signalType) return 'Error: signalType is required for burst-rate.';

        const rate = flow.getBurstRate(
          args.signalType as SignalType,
          args.sourceCluster || '*',
          args.targetCluster || '*',
        );

        return [
          `# Burst Rate`,
          '',
          `- **Channel:** ${args.signalType}:${args.sourceCluster || '*'}:${args.targetCluster || '*'}`,
          `- **Current Rate:** ${rate.toFixed(1)} signals/sec`,
          `- **Window:** 500ms sliding`,
        ].join('\n');
      }

      case 'stats': {
        const stats = flow.getStats();

        return [
          '# Flow Control Statistics',
          '',
          `- **Total Processed:** ${stats.totalProcessed}`,
          `- **Total Dropped:** ${stats.totalDropped}`,
          `- **Total Queued:** ${stats.totalQueued}`,
          '',
          '## Direction Counts',
          `- Upstream: ${stats.directionCounts.upstream || 0}`,
          `- Downstream: ${stats.directionCounts.downstream || 0}`,
          `- Duplex: ${stats.directionCounts.duplex || 0}`,
          '',
          `## Pressured Channels`,
          stats.pressuredChannels.length > 0
            ? stats.pressuredChannels.map((c) => `- ${c}`).join('\n')
            : 'None',
          '',
          `**Active Policies:** ${flow.getPolicies().length}`,
        ].join('\n');
      }

      default:
        return 'Unknown action.';
    }
  },
};
