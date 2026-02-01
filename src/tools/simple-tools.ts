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
import { UnifiedTool, getToolRegistry } from './registry.js';
import { executeCommand } from '../utils/commandExecutor.js';
import { executeAI, parseFiles } from '../ai/index.js';
import { ERROR_MESSAGES } from '../constants.js';

export const pingTool: UnifiedTool = {
  name: 'ping',
  description: 'Echo test message',
  zodSchema: z.object({ prompt: z.string().default('pong') }),
  // Optimize: direct return instead of subprocess spawn for simple echo
  execute: async (args) => String(args.prompt || 'pong'),
};

export const helpTool: UnifiedTool = {
  name: 'help',
  description: 'Show available tools and commands',
  zodSchema: z.object({}),
  execute: async () => {
    const tools = getToolRegistry();
    const categories = new Map<string, { name: string; description: string }[]>();

    for (const tool of tools) {
      const category = tool.metadata?.category || 'other';
      if (!categories.has(category)) {
        categories.set(category, []);
      }
      categories.get(category)!.push({ name: tool.name, description: tool.description });
    }

    const lines: string[] = [`# Available Tools (${tools.length} total)`, ''];

    // Sort categories alphabetically
    const sortedCategories = Array.from(categories.entries()).sort(([a], [b]) =>
      a.localeCompare(b)
    );

    for (const [category, categoryTools] of sortedCategories) {
      lines.push(`## ${category}`);
      for (const t of categoryTools) {
        lines.push(`- ${t.name}: ${t.description}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  },
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
  metadata: {
    category: 'specialized',
    tags: ['ai', 'plan', 'analysis'],
    longRunning: true,
    aiRequired: true,
    aiRouting: 'hybrid',
  },
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
  metadata: {
    category: 'specialized',
    tags: ['ai', 'build', 'execution'],
    longRunning: true,
    aiRequired: true,
    aiRouting: 'hybrid',
  },
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
