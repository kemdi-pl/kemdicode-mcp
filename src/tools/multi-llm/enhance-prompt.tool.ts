/**
 * KemdiCode MCP Server - Enhance Prompt Tool
 * Copyright (C) 2025-2026 Kemdi Sp. z o.o. (Dawid Irzyk <dawid@kemdi.pl>)
 *
 * Standalone tool for manual prompt enhancement.
 * Analyzes a user prompt, detects vagueness, loads context, and rewrites it.
 *
 * @license GPL-3.0
 */

import { z } from 'zod';
import type { UnifiedTool } from '../registry.js';
import { enhancePrompt } from '../../ai/prompt-enhancer.js';
import { isSilent } from '../../config/silent.js';

const schema = z.object({
  prompt: z.string().min(1).describe('The prompt to analyze and enhance'),
  model: z.string().optional().describe('Override enhancer model (provider:model syntax)'),
  files: z
    .string()
    .optional()
    .describe('Additional file context hints (@path syntax, comma-separated)'),
  force: z.boolean().default(false).describe('Force enhancement even for detailed prompts'),
  verbose: z.boolean().default(false).describe('Show full analysis details'),
});

async function execute(args: Record<string, unknown>): Promise<string> {
  const { prompt, model, force, verbose } = args as z.infer<typeof schema>;

  const result = await enhancePrompt(prompt, {
    model,
    forceEnhance: force,
    projectRoot: process.cwd(),
  });

  // Silent mode — compact JSON
  if (isSilent()) {
    return JSON.stringify({
      original: result.original,
      enhanced: result.enhanced,
      skipped: result.skipped,
      vagueness: result.analysis.vaguenessScore,
      model: result.model,
      duration: result.duration,
    });
  }

  const lines: string[] = [];

  if (result.skipped) {
    lines.push(`# Prompt Enhancement — Skipped`);
    lines.push('');
    lines.push(
      `The prompt is already clear enough (vagueness: ${result.analysis.vaguenessScore}/10).`
    );
    lines.push('');
    lines.push(`**Intent:** ${result.analysis.intent}`);
    lines.push(`**Model:** ${result.model}`);
    lines.push(`**Duration:** ${result.duration}ms`);
  } else {
    lines.push(`# Prompt Enhancement`);
    lines.push('');
    lines.push(`## Original`);
    lines.push(`> ${result.original}`);
    lines.push('');
    lines.push(`## Enhanced`);
    lines.push(`> ${result.enhanced}`);
    lines.push('');

    if (verbose) {
      lines.push(`## Analysis`);
      lines.push(`- **Vagueness:** ${result.analysis.vaguenessScore}/10`);
      lines.push(`- **Intent:** ${result.analysis.intent}`);
      lines.push(`- **Missing context:** ${result.analysis.missingContext.join(', ') || 'none'}`);
      lines.push(`- **Suggested files:** ${result.analysis.suggestedFiles.join(', ') || 'none'}`);
      lines.push(`- **Files loaded:** ${result.filesLoaded.join(', ') || 'none'}`);
      lines.push('');
    }

    lines.push(`**Model:** ${result.model} | **Duration:** ${result.duration}ms`);
  }

  return lines.join('\n');
}

export const enhancePromptTool: UnifiedTool = {
  name: 'enhance-prompt',
  description:
    'Analyze and rewrite vague prompts into clear, actionable instructions using a cheap LLM. ' +
    'Detects missing context, loads relevant files, and rewrites the prompt before sending to the target model. ' +
    'Use when: user input is vague or ambiguous — improves quality of subsequent AI calls.',
  zodSchema: schema,
  metadata: {
    category: 'multi-llm',
    tags: ['prompt', 'enhancement', 'rewrite', 'quality'],
    aiRequired: true,
    aiRouting: 'external',
    examples: [
      {
        args: { prompt: 'fix the bug' },
        description: 'Enhance a vague bug fix request',
      },
      {
        args: { prompt: 'refactor this', verbose: true },
        description: 'Enhance with detailed analysis output',
      },
    ],
    relatedTools: ['ask-ai', 'plan', 'build'],
  },
  execute,
};
