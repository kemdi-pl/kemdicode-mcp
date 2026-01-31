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
 * Invoke Tool Tool
 *
 * Allows agents to invoke other MCP tools recursively.
 *
 * @module tools/recursive/invoke-tool
 */

import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { UnifiedTool } from '../registry.js';
import { Logger } from '../../utils/logger.js';
import { checkRateLimit } from '../../utils/validation.js';
import { invokeTool, checkSafety, DEFAULT_POLICY } from '../../recursive/index.js';
import { isSilent } from '../../config/silent.js';

const schema = z.object({
  toolName: z.string().min(1).describe('Tool name to invoke'),
  args: z.record(z.string(), z.unknown()).describe('Tool arguments'),
  agentId: z.string().min(1).describe('Agent ID'),
  sessionId: z.string().min(1).describe('Session ID'),
  reason: z.string().optional().describe('Invocation reason'),
  dryRun: z
    .boolean()
    .default(false)
    .describe('Check permission without executing'),
});

export const invokeToolTool: UnifiedTool = {
  name: 'invoke-tool',
  description: 'Invoke MCP tool from agent context (recursive invocation)',
  zodSchema: schema,
  metadata: {
    category: 'recursive',
    tags: ['invoke', 'recursive', 'meta'],
    examples: [
      { args: { toolName: 'file-read', args: { path: '@src/index.ts' }, agentId: 'backend-dev', sessionId: 'sess-abc123' }, description: 'Invoke file-read from agent context' },
      { args: { toolName: 'code-review', args: { files: '@src/auth.ts' }, agentId: 'qa', sessionId: 'sess-abc123', dryRun: true }, description: 'Check if agent can invoke code-review without executing' },
    ],
    relatedTools: ['invoke-batch', 'invocation-log'],
  },

  execute: async (args): Promise<string> => {
    const input = schema.parse(args);

    if (!checkRateLimit('recursive-operations', { maxRequests: 50, windowMs: 60000 })) {
      return JSON.stringify({
        success: false,
        error: 'Rate limit exceeded for recursive operations',
        code: 'RATE_LIMIT_EXCEEDED',
      });
    }

    const request = {
      invocationId: uuidv4(),
      agentId: input.agentId,
      sessionId: input.sessionId,
      toolName: input.toolName,
      args: input.args,
      reason: input.reason,
      timestamp: Date.now(),
    };

    try {
      // Dry run - just check if it would be allowed
      if (input.dryRun) {
        const safety = await checkSafety(request, DEFAULT_POLICY);

        return JSON.stringify({
          success: true,
          dryRun: true,
          allowed: safety.allowed,
          reason: safety.reason,
          requiresApproval: safety.requiresSupervisorApproval,
          currentDepth: safety.currentDepth,
          rateLimit: safety.rateLimit,
        });
      }

      // Actually invoke the tool
      const result = await invokeTool(request, DEFAULT_POLICY);

      Logger.debug(`invoke-tool: ${input.toolName} invoked by ${input.agentId}`);

      if (isSilent()) {
        return result.success ? String(result.result ?? '{}') : JSON.stringify({ error: result.error });
      }

      return JSON.stringify({
        success: result.success,
        invocationId: result.invocationId,
        result: result.result,
        error: result.error,
        duration: result.duration,
        depth: result.depth,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      Logger.error(`invoke-tool error: ${errorMessage}`);

      return JSON.stringify({
        success: false,
        error: errorMessage,
        code: 'INVOCATION_ERROR',
      });
    }
  },
};
