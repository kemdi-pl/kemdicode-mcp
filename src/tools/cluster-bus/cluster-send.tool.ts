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
  getClusterBus,
  isClusterBusActive,
} from '../../cluster-bus/index.js';
import type { SignalType, SignalDirection, SignalPriority } from '../../cluster-bus/index.js';

const schema = z.object({
  mode: z
    .enum(['unicast', 'broadcast', 'routed'])
    .describe('Send mode: unicast (to specific cluster), broadcast (all), or routed (via meta-tag rules)'),
  targetCluster: z
    .string()
    .optional()
    .describe('Target cluster ID (required for unicast)'),
  signalType: z
    .string()
    .describe('Signal type (e.g., data:broadcast, llm:request, control:config)'),
  payload: z
    .record(z.string(), z.unknown())
    .describe('Signal payload object'),
  direction: z
    .enum(['upstream', 'downstream', 'duplex'])
    .default('duplex')
    .describe('Signal flow direction'),
  priority: z
    .number()
    .min(0)
    .max(3)
    .default(1)
    .describe('Priority: 0=low, 1=normal, 2=high, 3=critical'),
  correlationId: z
    .string()
    .optional()
    .describe('Correlation ID for tracing signal chains'),
});

export const clusterSendTool: UnifiedTool<typeof schema> = {
  name: 'cluster-bus-send',
  description: 'Send signal via cluster bus (unicast, broadcast, or meta-tag routed)',
  zodSchema: schema,
  metadata: {
    category: 'system',
    tags: ['cluster', 'send', 'signal', 'bus'],
    examples: [
      {
        args: {
          mode: 'broadcast',
          signalType: 'data:broadcast',
          payload: { message: 'Hello from this cluster' },
        },
        description: 'Broadcast a data signal to all clusters',
      },
      {
        args: {
          mode: 'routed',
          signalType: 'llm:request',
          payload: { prompt: 'Analyze this code' },
        },
        description: 'Route LLM request via meta-tag rules',
      },
    ],
    relatedTools: ['cluster-bus-status', 'cluster-bus-topology', 'cluster-bus-magistrale'],
  },

  execute: async (args) => {
    if (!isClusterBusActive()) {
      return 'Cluster bus is not active. Check Redis connectivity and server logs.';
    }

    const bus = getClusterBus();
    if (!bus) {
      return 'Cluster bus not initialized.';
    }

    const signalType = args.signalType as SignalType;
    const direction = args.direction as SignalDirection;
    const priority = args.priority as SignalPriority;

    switch (args.mode) {
      case 'unicast': {
        if (!args.targetCluster) {
          return 'Error: targetCluster is required for unicast mode.';
        }
        const signalId = await bus.send(args.targetCluster, signalType, args.payload, {
          direction,
          priority,
          correlationId: args.correlationId,
        });
        return `Signal sent (unicast)\n- ID: ${signalId}\n- Target: ${args.targetCluster}\n- Type: ${signalType}`;
      }

      case 'broadcast': {
        const signalId = await bus.broadcast(signalType, args.payload, {
          direction,
          priority,
          correlationId: args.correlationId,
        });
        return `Signal sent (broadcast)\n- ID: ${signalId}\n- Type: ${signalType}`;
      }

      case 'routed': {
        const result = await bus.routedSend(signalType, args.payload, {
          direction,
          priority,
          correlationId: args.correlationId,
        });
        return `Signal routed\n- ID: ${result.signalId}\n- Targets: ${result.targets.length > 0 ? result.targets.join(', ') : 'none (no matching clusters)'}`;
      }
    }
  },
};
