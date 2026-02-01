/**
 * KemdiCode MCP Server
 * Copyright (C) 2025-2026 Kemdi Sp. z o.o. (Dawid Irzyk <dawid@kemdi.pl>)
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

/**
 * Tool Health Check Tool
 *
 * Returns an availability matrix for all tools, especially AI-dependent ones.
 * Helps agents understand which tools are currently usable.
 *
 * @module tools/system/tool-health
 */

import { z } from 'zod';
import type { UnifiedTool } from '../registry.js';
import { getAvailabilityChecker } from '../availability-checker.js';
import { listProviders } from '../../ai/providers/registry.js';

const schema = z.object({
  includeDetails: z
    .boolean()
    .default(false)
    .describe('Include per-tool availability details'),
});

/** List of tools that require AI */
const AI_TOOL_NAMES = [
  'ask-ai', 'plan', 'build', 'brainstorm',
  'code-review', 'write-tests', 'explain-code', 'fix-bug',
  'refactor', 'auto-fix', 'auto-fix-agent', 'analyze-deps',
  'semantic-search', 'multi-prompt', 'consensus-prompt', 'ai-models',
];

export const toolHealthTool: UnifiedTool<typeof schema> = {
  name: 'tool-health',
  description: 'Check availability of all tools, including AI provider status',
  zodSchema: schema,
  metadata: {
    category: 'system',
    tags: ['health', 'availability', 'diagnostic'],
    examples: [
      { args: {}, description: 'Quick health check of tool availability' },
      { args: { includeDetails: true }, description: 'Detailed per-tool availability matrix' },
    ],
    relatedTools: ['ai-config', 'ai-models'],
  },

  execute: async (args) => {
    const { includeDetails } = args;

    // Provider status
    const providers = listProviders();
    const available = providers.filter((p) => p.available);

    let output = `# Tool Health Check\n\n`;
    output += `## AI Providers\n`;
    output += `Configured: ${available.length}/${providers.length}\n\n`;

    for (const p of providers) {
      const icon = p.available ? '✓' : '✗';
      const status = p.initialized ? 'initialized' : p.available ? 'ready' : 'not configured';
      output += `  ${icon} ${p.id}: ${status}\n`;
    }

    output += `\n## AI-Dependent Tools (${AI_TOOL_NAMES.length})\n`;

    const anyAvailable = available.length > 0;
    if (anyAvailable) {
      output += `Status: All ${AI_TOOL_NAMES.length} AI tools are operational\n`;
    } else {
      output += `Status: ALL AI tools are UNAVAILABLE (no providers configured)\n`;
      output += `\nTo fix: ai-config --action set --provider openai --apiKey <your-key>\n`;
    }

    if (includeDetails) {
      const checker = getAvailabilityChecker();
      if (!checker.isConnected()) {
        await checker.connect().catch(() => {});
      }

      const matrix = checker.getHealthMatrix(AI_TOOL_NAMES, 131);

      output += `\n## Detailed Matrix\n`;
      output += `Total tools: ${matrix.totalTools}\n`;
      output += `Available: ${matrix.availableTools}\n`;
      output += `Unavailable: ${matrix.unavailableTools.length}\n\n`;

      for (const entry of matrix.entries) {
        const icon = entry.available ? '✓' : '✗';
        const fallbacks = entry.fallbackTools
          ? ` (fallbacks: ${entry.fallbackTools.join(', ')})`
          : '';
        output += `  ${icon} ${entry.toolName}${fallbacks}\n`;
      }
    }

    output += `\n## Non-AI Tools\n`;
    output += `Status: All operational (no external dependencies)\n`;

    return output;
  },
};
