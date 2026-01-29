/**
 * KemdiCode MCP Server - Multi-Prompt Tool
 * Send the same prompt to multiple LLM models in parallel and collect all responses.
 *
 * @license GPL-3.0
 */

import { z } from 'zod';
import type { UnifiedTool } from '../registry.js';
import { complete } from '../../ai/client.js';
import { buildAgentMessages, type AgentType } from '../../ai/agents.js';
import { loadAndFormatFiles, parseFiles } from '../../ai/file-context.js';

const schema = z.object({
  prompt: z.string().min(1).describe('Prompt to send to all models'),
  models: z
    .array(z.string().min(1))
    .min(2)
    .max(10)
    .describe(
      'Model specs with provider prefix (e.g., ["openai:gpt-4o", "a:claude-sonnet-4-20250514", "g:gemini-2.5-pro"])'
    ),
  agent: z
    .enum(['plan', 'build', 'explore', 'general'])
    .default('general')
    .describe('Agent type for system prompt'),
  files: z.string().optional().describe('Files to attach (@path syntax, space-separated)'),
  temperature: z.number().min(0).max(2).optional().describe('Temperature override'),
  maxTokens: z.number().int().min(1).optional().describe('Max tokens per model'),
});

async function execute(args: Record<string, unknown>): Promise<string> {
  const { prompt, models, agent, files, temperature, maxTokens } = args as z.infer<typeof schema>;

  // Load file context if specified
  let fileContext: string | undefined;
  if (files) {
    const filePaths = parseFiles(files);
    if (filePaths.length > 0) {
      fileContext = await loadAndFormatFiles(filePaths);
    }
  }

  // Build the full prompt with agent system message
  const userPrompt = fileContext ? `${prompt}\n\n${fileContext}` : prompt;
  const messages = buildAgentMessages(agent as AgentType, userPrompt);

  const startTime = Date.now();

  // Execute all models in parallel
  const results = await Promise.allSettled(
    models.map(async (modelSpec) => {
      const modelStart = Date.now();
      const response = await complete({
        model: modelSpec,
        messages,
        temperature,
        maxTokens,
        stream: false,
      });
      return {
        model: modelSpec,
        content: response.content,
        usage: response.usage,
        duration: Date.now() - modelStart,
      };
    })
  );

  const totalDuration = Date.now() - startTime;

  // Format output
  const lines: string[] = [];
  const successCount = results.filter((r) => r.status === 'fulfilled').length;
  lines.push(
    `# Multi-Model Results (${successCount}/${models.length} succeeded, ${totalDuration}ms)\n`
  );

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const modelSpec = models[i];

    if (result.status === 'fulfilled') {
      const { content, duration, usage } = result.value;
      const usageStr = usage
        ? ` | ${usage.promptTokens}+${usage.completionTokens}=${usage.totalTokens} tokens`
        : '';
      lines.push(`## ${modelSpec} (${duration}ms${usageStr})\n`);
      lines.push(content);
      lines.push('');
    } else {
      lines.push(`## ${modelSpec} (FAILED)\n`);
      lines.push(`**Error:** ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

export const multiPromptTool: UnifiedTool = {
  name: 'multi-prompt',
  description:
    'Send the same prompt to multiple LLM models in parallel. ' +
    'Use provider:model syntax (e.g., openai:gpt-4o, a:claude-sonnet-4-20250514, g:gemini-2.5-pro). ' +
    'Supports thinking tokens: o:o3:high, a:claude-sonnet-4-20250514:4k, g:gemini-2.5-flash:8k',
  zodSchema: schema,
  execute,
};
