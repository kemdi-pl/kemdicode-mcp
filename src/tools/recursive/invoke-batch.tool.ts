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
 * Invoke Batch Tool
 *
 * Invoke multiple tools in a batch (parallel or sequential).
 *
 * @module tools/recursive/invoke-batch
 */

import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { UnifiedTool } from '../registry.js';
import { Logger } from '../../utils/logger.js';
import { checkRateLimit } from '../../utils/validation.js';
import { invokeBatch, DEFAULT_POLICY } from '../../recursive/index.js';

const operationSchema = z.object({
  toolName: z.string().min(1).describe('Tool name to execute'),
  args: z.record(z.string(), z.unknown()).describe('Tool arguments'),
  id: z.string().optional().describe('Operation ID for result tracking'),
});

const schema = z.object({
  operations: z.array(operationSchema).min(1).max(10).describe('Operations to execute'),
  agentId: z.string().min(1).describe('Agent ID'),
  sessionId: z.string().min(1).describe('Session ID'),
  parallel: z.boolean().default(true).describe('Parallel or sequential execution'),
  stopOnError: z.boolean().default(false).describe('Stop on first error (sequential only)'),
});

export const invokeBatchTool: UnifiedTool = {
  name: 'invoke-batch',
  description: 'Batch invoke multiple tools (parallel or sequential)',
  zodSchema: schema,

  execute: async (args): Promise<string> => {
    const input = schema.parse(args);

    if (!checkRateLimit('recursive-operations', { maxRequests: 50, windowMs: 60000 })) {
      return JSON.stringify({
        success: false,
        error: 'Rate limit exceeded for recursive operations',
        code: 'RATE_LIMIT_EXCEEDED',
      });
    }

    try {
      const requests = input.operations.map((op) => ({
        invocationId: uuidv4(),
        agentId: input.agentId,
        sessionId: input.sessionId,
        toolName: op.toolName,
        args: op.args,
        timestamp: Date.now(),
      }));

      const startTime = Date.now();
      const results = await invokeBatch(requests, DEFAULT_POLICY, input.parallel);
      const totalDuration = Date.now() - startTime;

      const successCount = results.filter((r) => r.success).length;
      const failureCount = results.length - successCount;

      Logger.debug(
        `invoke-batch: ${successCount}/${results.length} succeeded in ${totalDuration}ms`
      );

      return JSON.stringify({
        success: failureCount === 0,
        totalOperations: results.length,
        successCount,
        failureCount,
        totalDuration,
        parallel: input.parallel,
        results: results.map((r, i) => ({
          operationId: input.operations[i].id || `op-${i}`,
          toolName: input.operations[i].toolName,
          success: r.success,
          result: r.result,
          error: r.error,
          duration: r.duration,
          depth: r.depth,
        })),
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      Logger.error(`invoke-batch error: ${errorMessage}`);

      return JSON.stringify({
        success: false,
        error: errorMessage,
        code: 'BATCH_ERROR',
      });
    }
  },
};
