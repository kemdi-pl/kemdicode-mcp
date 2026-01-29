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
 * Invocation Log Tool
 *
 * View the invocation history for an agent.
 *
 * @module tools/recursive/invocation-log
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { Logger } from '../../utils/logger.js';
import { checkRateLimit } from '../../utils/validation.js';
import { getInvocationLog, getCurrentContext } from '../../recursive/index.js';

const schema = z.object({
  agentId: z.string().min(1).describe('Agent ID'),
  limit: z.number().min(1).max(100).default(20).describe('Number of entries to return'),
  includeContext: z.boolean().default(false).describe('Include current invocation context'),
});

type InvocationLogArgs = z.infer<typeof schema>;

export const invocationLogTool: UnifiedTool = {
  name: 'invocation-log',
  description: 'View tool invocation history for an agent',
  zodSchema: schema,

  execute: async (args): Promise<string> => {
    const input = args as InvocationLogArgs;

    if (!checkRateLimit('recursive-operations', { maxRequests: 100, windowMs: 60000 })) {
      return JSON.stringify({
        success: false,
        error: 'Rate limit exceeded for recursive operations',
        code: 'RATE_LIMIT_EXCEEDED',
      });
    }

    try {
      const log = await getInvocationLog(input.agentId, input.limit);

      // Calculate stats
      const successCount = log.filter((e) => e.success).length;
      const failureCount = log.length - successCount;
      const avgDuration =
        log.length > 0 ? Math.round(log.reduce((sum, e) => sum + e.duration, 0) / log.length) : 0;
      const maxDepth = log.length > 0 ? Math.max(...log.map((e) => e.depth)) : 0;

      // Tool frequency
      const toolCounts = new Map<string, number>();
      for (const entry of log) {
        toolCounts.set(entry.toolName, (toolCounts.get(entry.toolName) || 0) + 1);
      }
      const topTools = Array.from(toolCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([tool, count]) => ({ tool, count }));

      const result: Record<string, unknown> = {
        success: true,
        agentId: input.agentId,
        entryCount: log.length,
        stats: {
          successCount,
          failureCount,
          successRate: log.length > 0 ? Math.round((successCount / log.length) * 100) : 0,
          avgDuration,
          maxDepth,
          topTools,
        },
        entries: log.map((e) => ({
          invocationId: e.invocationId,
          toolName: e.toolName,
          success: e.success,
          error: e.error,
          duration: e.duration,
          depth: e.depth,
          timestamp: e.timestamp,
        })),
      };

      if (input.includeContext) {
        const context = getCurrentContext(input.agentId);
        result.currentContext = context
          ? {
              rootInvocationId: context.rootInvocationId,
              currentDepth: context.currentDepth,
              chainLength: context.chain.length,
              elapsedMs: Date.now() - context.startTime,
            }
          : null;
      }

      Logger.debug(`invocation-log: retrieved ${log.length} entries for agent ${input.agentId}`);

      return JSON.stringify(result);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      Logger.error(`invocation-log error: ${errorMessage}`);

      return JSON.stringify({
        success: false,
        error: errorMessage,
        code: 'LOG_ERROR',
      });
    }
  },
};
