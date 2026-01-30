/**
 * KemdiCode MCP Server - Consensus Prompt Tool
 * CEO-and-Board decision pattern: multiple models respond, one synthesizes.
 *
 * @license GPL-3.0
 */

import { z } from 'zod';
import type { UnifiedTool } from '../registry.js';
import { complete } from '../../ai/client.js';
import { buildAgentMessages, type AgentType } from '../../ai/agents.js';
import { loadAndFormatFiles, parseFiles } from '../../ai/file-context.js';

const DEFAULT_SYNTHESIS_PROMPT = `<purpose>
You are the CEO making a final decision based on input from your board of advisors.
Each board member (a different AI model) has provided their perspective on the same question.
Synthesize their responses into a comprehensive, actionable decision.
</purpose>

<instructions>
<instruction>Analyze all board member responses carefully</instruction>
<instruction>Identify areas of agreement and disagreement</instruction>
<instruction>Consider multiple dimensions: risk, reward, feasibility, timeline, quality</instruction>
<instruction>Add any novel considerations the board may have missed</instruction>
<instruction>Produce a clear, structured final decision with rationale</instruction>
</instructions>

<output-format>
## Board Summary
- Key agreements across members
- Key disagreements or trade-offs

## Analysis
Multi-dimensional analysis of the options

## Decision
Clear final recommendation with rationale

## Action Items
Concrete next steps
</output-format>

<original-question>
{original_prompt}
</original-question>

<board-responses>
{board_responses}
</board-responses>`;

const schema = z.object({
  prompt: z.string().min(1).describe('Prompt for all board models'),
  boardModels: z
    .array(z.string().min(1))
    .min(2)
    .max(8)
    .describe('Board member model specs (provider:model syntax)'),
  ceoModel: z
    .string()
    .min(1)
    .describe('CEO model for synthesis'),
  agent: z
    .enum(['plan', 'build', 'explore', 'general'])
    .default('plan')
    .describe('Agent type for board'),
  files: z.string().optional().describe('Files to attach (@path syntax)'),
  synthesisPrompt: z
    .string()
    .optional()
    .describe('Custom CEO synthesis prompt'),
  temperature: z.number().min(0).max(2).optional().describe('Board member temperature'),
  maxTokens: z.number().int().min(1).optional().describe('Max tokens per model'),
});

async function execute(args: Record<string, unknown>): Promise<string> {
  const {
    prompt,
    boardModels,
    ceoModel,
    agent,
    files,
    synthesisPrompt,
    temperature,
    maxTokens,
  } = args as z.infer<typeof schema>;

  // Load file context
  let fileContext: string | undefined;
  if (files) {
    const filePaths = parseFiles(files);
    if (filePaths.length > 0) {
      fileContext = await loadAndFormatFiles(filePaths);
    }
  }

  const userPrompt = fileContext ? `${prompt}\n\n${fileContext}` : prompt;
  const messages = buildAgentMessages(agent as AgentType, userPrompt);

  const output: string[] = [];
  const startTime = Date.now();

  // Phase 1: Send to all board members in parallel
  output.push('# Consensus Decision\n');
  output.push(`**Board members:** ${boardModels.length} models`);
  output.push(`**CEO:** ${ceoModel}\n`);
  output.push('---\n');

  const boardResults = await Promise.allSettled(
    boardModels.map(async (modelSpec) => {
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
        duration: Date.now() - modelStart,
      };
    })
  );

  // Collect board responses
  const boardResponsesXml: string[] = [];
  output.push('## Board Member Responses\n');

  for (let i = 0; i < boardResults.length; i++) {
    const result = boardResults[i];
    const modelSpec = boardModels[i];

    if (result.status === 'fulfilled') {
      const { content, duration } = result.value;
      output.push(`### ${modelSpec} (${duration}ms)\n`);
      output.push(content);
      output.push('');

      boardResponsesXml.push(
        `<board-response>\n<model-name>${modelSpec}</model-name>\n<response>\n${content}\n</response>\n</board-response>`
      );
    } else {
      output.push(`### ${modelSpec} (FAILED)\n`);
      output.push(
        `**Error:** ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`
      );
      output.push('');
    }
  }

  // Phase 2: CEO synthesis
  if (boardResponsesXml.length === 0) {
    output.push('\n## CEO Decision\n');
    output.push('**No board responses received.** Cannot synthesize a decision.');
    return output.join('\n');
  }

  const template = synthesisPrompt || DEFAULT_SYNTHESIS_PROMPT;
  const ceoPrompt = template
    .replaceAll('{original_prompt}', prompt)
    .replaceAll('{board_responses}', boardResponsesXml.join('\n\n'));

  output.push('---\n');
  output.push('## CEO Decision\n');

  try {
    const ceoMessages = buildAgentMessages('plan' as AgentType, ceoPrompt);
    const ceoStart = Date.now();
    const ceoResponse = await complete({
      model: ceoModel,
      messages: ceoMessages,
      temperature: 0.7,
      maxTokens: maxTokens ? maxTokens * 2 : 16384, // CEO gets more tokens
      stream: false,
    });

    const ceoDuration = Date.now() - ceoStart;
    output.push(`*Synthesized by ${ceoModel} in ${ceoDuration}ms*\n`);
    output.push(ceoResponse.content);
  } catch (error) {
    output.push(
      `**CEO synthesis failed:** ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const totalDuration = Date.now() - startTime;
  output.push(`\n---\n*Total time: ${totalDuration}ms*`);

  return output.join('\n');
}

export const consensusPromptTool: UnifiedTool = {
  name: 'consensus-prompt',
  description:
    'CEO-and-Board decision pattern. Board models respond in parallel, CEO synthesizes final decision. ' +
    'provider:model syntax. Supports thinking tokens.',
  zodSchema: schema,
  execute,
};
