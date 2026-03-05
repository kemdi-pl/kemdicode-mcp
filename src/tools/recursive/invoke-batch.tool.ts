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
import { executeWithGuard } from '../tool-shared.js';
import { invokeBatch, DEFAULT_POLICY } from '../../recursive/index.js';
import { isSilent } from '../../config/silent.js';

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
  metadata: {
    category: 'recursive',
    tags: ['batch', 'parallel', 'sequential'],
    examples: [
      { args: { operations: [{ toolName: 'find-definition', args: { symbol: 'Logger' } }, { toolName: 'find-references', args: { symbol: 'Logger' } }], agentId: 'backend-dev', sessionId: 'sess-abc123', parallel: true }, description: 'Find definition and references in parallel' },
      { args: { operations: [{ toolName: 'error-pattern', args: { action: 'stats', limit: 10 } }, { toolName: 'context-budget', args: { action: 'estimate', keepTop: 10 } }], agentId: 'qa', sessionId: 'sess-abc123', parallel: false, stopOnError: true }, description: 'Check errors then context budget sequentially' },
    ],
    relatedTools: ['invoke-tool', 'invocation-log', 'batch'],
  },

  execute: async (args): Promise<string> => {
    const input = schema.parse(args);

    return executeWithGuard('invoke-batch', 'recursive-operations', async () => {
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

      if (isSilent()) {
        return JSON.stringify(results.map((r) => r.success ? r.result : { error: r.error }));
      }

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
    });
  },
};
