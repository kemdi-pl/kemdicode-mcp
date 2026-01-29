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
 * Batch Tool - Execute multiple operations in parallel
 *
 * This tool allows grouping multiple tool calls into a single request,
 * executing them in parallel for maximum efficiency.
 *
 * Use cases:
 * - Review multiple files simultaneously
 * - Run code analysis + tests + linting in parallel
 * - Execute multiple independent queries at once
 */

import { z } from 'zod';
import { UnifiedTool, executeTool } from './registry.js';
import { Logger } from '../utils/logger.js';

const operationSchema = z.object({
  tool: z.string().describe('Tool name to execute'),
  args: z.record(z.string(), z.unknown()).describe('Tool arguments'),
  id: z.string().optional().describe('Optional operation ID for result tracking'),
});

const schema = z.object({
  operations: z.array(operationSchema).min(1).max(10).describe('Operations to execute (1-10)'),
  parallel: z.boolean().default(true).describe('Execute in parallel (true) or sequential (false)'),
  stopOnError: z
    .boolean()
    .default(false)
    .describe('Stop execution on first error (sequential only)'),
});

interface OperationResult {
  id: string;
  tool: string;
  success: boolean;
  result?: string;
  error?: string;
  durationMs: number;
}

export const batchTool: UnifiedTool<typeof schema> = {
  name: 'batch',
  description:
    'Execute multiple tool operations in parallel for efficiency. Max 10 operations per batch.',
  zodSchema: schema,
  skipContextShare: true, // Individual tools share their own context
  execute: async (args, onProgress) => {
    // args is now properly typed via the generic
    const { operations, parallel = true, stopOnError = false } = args;

    const results: OperationResult[] = [];
    const startTime = Date.now();

    onProgress?.(
      `Batch: ${operations.length} operations (${parallel ? 'parallel' : 'sequential'})`
    );

    const executeOperation = async (
      op: z.infer<typeof operationSchema>,
      index: number
    ): Promise<OperationResult> => {
      const opId = op.id || `op_${index}`;
      const opStart = Date.now();

      try {
        // Execute tool via central execution path (validation + logging + RL + context share)
        const result = await executeTool(op.tool, op.args, (output) => {
          onProgress?.(`[${opId}] ${output.slice(0, 100)}`);
        });

        return {
          id: opId,
          tool: op.tool,
          success: true,
          result,
          durationMs: Date.now() - opStart,
        };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        Logger.error(`Batch operation ${opId} failed:`, error);

        return {
          id: opId,
          tool: op.tool,
          success: false,
          error: errorMsg,
          durationMs: Date.now() - opStart,
        };
      }
    };

    if (parallel) {
      // Execute all operations in parallel
      const promises = operations.map((op, index) => executeOperation(op, index));
      const parallelResults = await Promise.all(promises);
      results.push(...parallelResults);
    } else {
      // Execute sequentially
      for (let i = 0; i < operations.length; i++) {
        const result = await executeOperation(operations[i], i);
        results.push(result);

        if (stopOnError && !result.success) {
          Logger.warn(`Batch stopped at operation ${i} due to error`);
          break;
        }
      }
    }

    const totalDuration = Date.now() - startTime;
    const successful = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;

    // Format output
    const output: string[] = [
      `# Batch Execution Results`,
      ``,
      `**Summary:** ${successful} successful, ${failed} failed, ${totalDuration}ms total`,
      `**Mode:** ${parallel ? 'Parallel' : 'Sequential'}`,
      ``,
      `## Results`,
      ``,
    ];

    for (const result of results) {
      output.push(`### ${result.id} (${result.tool})`);
      output.push(`- **Status:** ${result.success ? '✅ Success' : '❌ Failed'}`);
      output.push(`- **Duration:** ${result.durationMs}ms`);

      if (result.error) {
        output.push(`- **Error:** ${result.error}`);
      }

      if (result.result) {
        // Truncate long results
        const truncated =
          result.result.length > 500
            ? result.result.slice(0, 500) + '... (truncated)'
            : result.result;
        output.push(`\n${truncated}`);
      }

      output.push(``);
    }

    return output.join('\n');
  },
};
