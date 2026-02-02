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
import { clientCreateMessage, hasCapability, getClientVersion } from '../../client/bridge.js';

const messageSchema = z.object({
  role: z.enum(['user', 'assistant']).describe('Message role'),
  content: z.string().describe('Message text content'),
});

const modelPreferencesSchema = z
  .object({
    hints: z
      .array(z.object({ name: z.string().optional().describe('Model name hint (substring match)') }))
      .optional()
      .describe('Model name hints in order of preference'),
    costPriority: z.number().min(0).max(1).optional().describe('Cost minimization priority (0-1)'),
    speedPriority: z.number().min(0).max(1).optional().describe('Speed/latency priority (0-1)'),
    intelligencePriority: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe('Intelligence/capability priority (0-1)'),
  })
  .optional()
  .describe('Model selection preferences');

const schema = z.object({
  messages: z
    .array(messageSchema)
    .min(1)
    .describe('Conversation messages to send to the client LLM'),
  systemPrompt: z.string().optional().describe('Optional system prompt for the LLM'),
  maxTokens: z.number().default(1024).describe('Maximum tokens in response'),
  temperature: z.number().min(0).max(1).optional().describe('Sampling temperature'),
  modelPreferences: modelPreferencesSchema,
  includeContext: z
    .enum(['none', 'thisServer', 'allServers'])
    .default('none')
    .describe('How much MCP context to include in the request'),
});

export const clientSamplingTool: UnifiedTool = {
  name: 'client-sampling',
  description:
    'Request LLM sampling (completion) from the connected MCP client. ' +
    'Sends messages to the client\'s LLM and returns the response. ' +
    'Uses the client\'s own model and API keys — no server-side API key needed.',
  zodSchema: schema,
  skipContextShare: true,
  metadata: {
    category: 'client',
    tags: ['client', 'sampling', 'llm', 'mcp'],
    relatedTools: ['client-elicit', 'client-roots', 'ask-ai'],
  },
  execute: async (rawArgs) => {
    const args = rawArgs as unknown as z.infer<typeof schema>;

    if (!hasCapability('sampling')) {
      return JSON.stringify({
        error: 'Client does not support sampling',
        client: getClientVersion(),
        hint: 'Sampling (sampling/createMessage) requires client-side support. Claude Code does not yet support this feature (see github.com/anthropics/claude-code/issues/1785).',
      });
    }

    const params: Parameters<typeof clientCreateMessage>[0] = {
      messages: args.messages.map((m) => ({
        role: m.role,
        content: { type: 'text' as const, text: m.content },
      })),
      maxTokens: args.maxTokens,
    };
    if (args.systemPrompt) params.systemPrompt = args.systemPrompt;
    if (args.temperature !== undefined) params.temperature = args.temperature;
    if (args.modelPreferences) params.modelPreferences = args.modelPreferences;
    if (args.includeContext && args.includeContext !== 'none') {
      params.includeContext = args.includeContext;
    }

    const result = await Promise.race([
      clientCreateMessage(params),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('sampling/createMessage request timed out')), 30000),
      ),
    ]);

    return JSON.stringify(
      {
        role: result.role,
        content: result.content,
        model: result.model,
        stopReason: result.stopReason,
      },
      null,
      2,
    );
  },
};
