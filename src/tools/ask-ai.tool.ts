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
import { UnifiedTool } from './registry.js';
import { executeAI, parseFiles, type AgentType } from '../ai/index.js';
import { ERROR_MESSAGES } from '../constants.js';

const schema = z.object({
  prompt: z.string().min(1).describe('Request prompt. Use @filepath to include files.'),
  model: z.string().optional().describe('Model override (e.g., google/gemini-2.5-flash)'),
  agent: z
    .enum(['plan', 'build', 'explore', 'general'])
    .default('plan')
    .describe('Agent: plan (analysis), build (execution), explore (search)'),
  files: z.string().optional().describe('Space-separated file paths to attach'),
  continueSession: z.boolean().default(false).describe('Continue last session'),
});

export const askAITool: UnifiedTool = {
  name: 'ask-ai',
  description: 'Execute AI with model, agent, files options.',
  zodSchema: schema,
  prompt: { description: 'Direct AI access' },
  metadata: {
    category: 'specialized',
    tags: ['ai', 'query', 'direct'],
    longRunning: true,
    aiRequired: true,
    aiRouting: 'hybrid',
    examples: [
      { args: { prompt: 'Explain the SOLID principles with TypeScript examples' }, description: 'Ask AI a question using default agent' },
      { args: { prompt: 'Refactor this code for readability', agent: 'build', files: '@src/index.ts' }, description: 'Execute AI with file context and build agent' },
    ],
    relatedTools: ['plan', 'build', 'brainstorm'],
  },
  execute: async (args, onProgress) => {
    if (!args.prompt?.toString().trim()) throw new Error(ERROR_MESSAGES.NO_PROMPT);

    return executeAI({
      prompt: String(args.prompt),
      agent: (args.agent || 'plan') as AgentType,
      model: args.model as string | undefined,
      files: args.files ? parseFiles(String(args.files)) : undefined,
      continueSession: Boolean(args.continueSession),
      onProgress,
      enhancePrompt: true,
    });
  },
};
