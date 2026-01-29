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

import { z } from 'zod';
import { UnifiedTool } from './registry.js';
import { executeCommand } from '../utils/commandExecutor.js';
import { executeAI, parseFiles } from '../ai/index.js';
import { ERROR_MESSAGES } from '../constants.js';

export const pingTool: UnifiedTool = {
  name: 'ping',
  description: 'Echo test message',
  zodSchema: z.object({ prompt: z.string().default('pong') }),
  execute: async (args) => executeCommand('echo', [String(args.prompt || 'pong')]),
};

export const helpTool: UnifiedTool = {
  name: 'help',
  description: 'Show available tools and commands',
  zodSchema: z.object({}),
  execute: async () =>
    'Use: ask-ai, git-status, git-diff, search-code, and more. See README for full list.',
};

const agentSchema = z.object({
  prompt: z.string().min(1).describe('Request prompt. Use @filepath to include files.'),
  model: z.string().optional().describe('Model override (e.g., google/gemini-2.5-flash)'),
  files: z.string().optional().describe('Space-separated file paths to attach'),
});

export const planTool: UnifiedTool = {
  name: 'plan',
  description: 'Execute AI in plan mode for structured analysis',
  zodSchema: agentSchema,
  prompt: { description: 'Run AI with plan agent' },
  execute: async (args, onProgress) => {
    if (!args.prompt?.toString().trim()) throw new Error(ERROR_MESSAGES.NO_PROMPT);
    return executeAI({
      prompt: String(args.prompt),
      agent: 'plan',
      model: args.model as string | undefined,
      files: args.files ? parseFiles(String(args.files)) : undefined,
      onProgress,
    });
  },
};

export const buildTool: UnifiedTool = {
  name: 'build',
  description: 'Execute AI in build mode for immediate implementation',
  zodSchema: agentSchema,
  prompt: { description: 'Run AI with build agent' },
  execute: async (args, onProgress) => {
    if (!args.prompt?.toString().trim()) throw new Error(ERROR_MESSAGES.NO_PROMPT);
    return executeAI({
      prompt: String(args.prompt),
      agent: 'build',
      model: args.model as string | undefined,
      files: args.files ? parseFiles(String(args.files)) : undefined,
      onProgress,
    });
  },
};
