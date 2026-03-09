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
import { executeAI, parseFiles, type AgentType } from '../../ai/index.js';
import type { MindType } from '../../ai/minds.js';
import { getMindConfig, isMindType } from '../../ai/minds.js';

// ── Predefined Compositions (inspired by Ouroboros Double Diamond) ──────────

const COMPOSITIONS: Record<string, MindType[]> = {
  dialectical: ['socratic', 'ontologist', 'seed-architect'],
  adversarial: ['architect', 'contrarian', 'evaluator'],
  evidence: ['researcher', 'hacker', 'simplifier'],
  'full-review': ['socratic', 'ontologist', 'architect', 'contrarian', 'evaluator', 'simplifier'],
};

const MIND_ENUM = [
  'socratic', 'ontologist', 'seed-architect', 'evaluator', 'contrarian',
  'hacker', 'simplifier', 'researcher', 'architect',
] as const;

const schema = z.object({
  prompt: z.string().min(1).describe('The problem or question to analyze. Use @filepath to include files.'),
  composition: z
    .enum(['dialectical', 'adversarial', 'evidence', 'full-review', 'custom'])
    .default('dialectical')
    .describe(
      'Predefined Mind chain: dialectical (Socratic→Ontologist→Seed Architect), ' +
      'adversarial (Architect→Contrarian→Evaluator), ' +
      'evidence (Researcher→Hacker→Simplifier), ' +
      'full-review (6 Minds), custom (provide minds array)'
    ),
  minds: z
    .array(z.enum(MIND_ENUM))
    .min(2)
    .max(9)
    .optional()
    .describe('Custom Mind sequence (required when composition=custom). Min 2, max 9 Minds.'),
  model: z.string().optional().describe('Model override (e.g., a:claude-sonnet-4-6)'),
  files: z.string().optional().describe('Space-separated file paths to attach as context'),
  includePrevious: z
    .boolean()
    .default(true)
    .describe('Include full previous Mind outputs in each step context (default true)'),
  synthesize: z
    .boolean()
    .default(true)
    .describe('Add a final synthesis step that summarizes all Mind perspectives'),
});

type SchemaInput = z.infer<typeof schema>;

/**
 * Build the enriched prompt for a Mind step, injecting accumulated context
 */
function buildStepPrompt(
  originalPrompt: string,
  mindType: MindType,
  stepIndex: number,
  previousOutputs: Array<{ mind: string; output: string }>,
  includePrevious: boolean,
): string {
  const mindConfig = getMindConfig(mindType);
  const parts: string[] = [];

  if (previousOutputs.length > 0 && includePrevious) {
    parts.push('## Previous Mind Analyses\n');
    for (const prev of previousOutputs) {
      parts.push(`### ${prev.mind}\n${prev.output}\n`);
    }
    parts.push('---\n');
  }

  parts.push(`## Your Task (Step ${stepIndex + 1}: ${mindConfig.name})\n`);
  parts.push(`Core question: **${mindConfig.coreQuestion}**\n`);

  if (previousOutputs.length > 0) {
    parts.push(
      `Build on the analysis above. Apply your unique perspective as the ${mindConfig.name} ` +
      `(${mindConfig.role}) to deepen or challenge what has been established.\n`
    );
  }

  parts.push(`\n${originalPrompt}`);

  return parts.join('\n');
}

/**
 * Build synthesis prompt from all Mind outputs
 */
function buildSynthesisPrompt(
  originalPrompt: string,
  outputs: Array<{ mind: string; output: string }>,
): string {
  const parts: string[] = [];

  parts.push('## Multi-Mind Analysis — Synthesis\n');
  parts.push(`You have received analyses from ${outputs.length} specialized cognitive Minds, ` +
    'each approaching the same problem from a fundamentally different angle.\n');
  parts.push('Synthesize their perspectives into a unified, actionable conclusion.\n\n');

  for (const o of outputs) {
    parts.push(`### ${o.mind}\n${o.output}\n`);
  }

  parts.push('---\n');
  parts.push('## Synthesis Instructions\n');
  parts.push('1. Identify points of **agreement** across Minds\n');
  parts.push('2. Highlight **tensions** or contradictions between perspectives\n');
  parts.push('3. Determine which insights are **actionable** vs. theoretical\n');
  parts.push('4. Produce a clear **recommendation** with supporting rationale\n');
  parts.push('5. Note any **open questions** that remain unresolved\n\n');
  parts.push(`Original prompt: ${originalPrompt}`);

  return parts.join('\n');
}

export const mindChainTool: UnifiedTool = {
  name: 'mind-chain',
  description:
    'Sequential Mind-to-Mind chain: each Mind builds on the previous. ' +
    'Predefined patterns: dialectical, adversarial, evidence, full-review. ' +
    'Inspired by Ouroboros (Harry Munro).',
  zodSchema: schema,
  prompt: { description: 'Mind chain composition' },
  metadata: {
    category: 'multi-llm',
    tags: ['nine-minds', 'chain', 'composition', 'orchestration'],
    longRunning: true,
    aiRequired: true,
    aiRouting: 'hybrid',
    examples: [
      {
        args: {
          prompt: 'Should we migrate from REST to GraphQL?',
          composition: 'dialectical',
        },
        description: 'Dialectical: Socratic questions → Ontologist essence → Seed Architect spec',
      },
      {
        args: {
          prompt: 'Review auth module security @src/auth/',
          composition: 'adversarial',
        },
        description: 'Adversarial: Architect proposes → Contrarian challenges → Evaluator verifies',
      },
      {
        args: {
          prompt: 'Optimize database queries',
          composition: 'custom',
          minds: ['researcher', 'architect', 'simplifier'],
        },
        description: 'Custom chain: Research → Structural analysis → Simplification',
      },
    ],
    relatedTools: ['ask-ai', 'consensus-prompt', 'multi-prompt'],
  },

  execute: async (args, onProgress) => {
    const input = args as SchemaInput;

    // Resolve Mind sequence
    let mindSequence: MindType[];
    if (input.composition === 'custom') {
      if (!input.minds || input.minds.length < 2) {
        return 'Error: composition=custom requires minds array with at least 2 Minds.';
      }
      mindSequence = input.minds;
    } else {
      mindSequence = COMPOSITIONS[input.composition];
    }

    // Validate all minds
    for (const m of mindSequence) {
      if (!isMindType(m)) {
        return `Error: Unknown mind type "${m}".`;
      }
    }

    const prompt = String(input.prompt);
    const files = input.files ? parseFiles(String(input.files)) : undefined;
    const previousOutputs: Array<{ mind: string; output: string }> = [];
    const stepTimings: Array<{ mind: string; duration: number }> = [];
    const totalStart = Date.now();

    onProgress?.(`## Mind Chain: ${mindSequence.map(m => getMindConfig(m).name).join(' → ')}\n\n`);

    // Execute each Mind in sequence
    for (let i = 0; i < mindSequence.length; i++) {
      const mindType = mindSequence[i];
      const mindConfig = getMindConfig(mindType);
      const stepStart = Date.now();

      onProgress?.(`### Step ${i + 1}/${mindSequence.length}: ${mindConfig.name}\n`);
      onProgress?.(`*Core question: ${mindConfig.coreQuestion}*\n\n`);

      const stepPrompt = buildStepPrompt(
        prompt,
        mindType,
        i,
        previousOutputs,
        input.includePrevious,
      );

      try {
        const result = await executeAI({
          prompt: stepPrompt,
          agent: mindType as AgentType,
          model: input.model,
          files: i === 0 ? files : undefined, // Files only in first step (context carries forward)
          onProgress,
        });

        previousOutputs.push({ mind: mindConfig.name, output: result });
        stepTimings.push({ mind: mindConfig.name, duration: Date.now() - stepStart });

        onProgress?.('\n\n---\n\n');
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        previousOutputs.push({
          mind: mindConfig.name,
          output: `[ERROR: ${errorMsg}]`,
        });
        stepTimings.push({ mind: mindConfig.name, duration: Date.now() - stepStart });
        onProgress?.(`\n**Error in ${mindConfig.name}:** ${errorMsg}\n\n---\n\n`);
      }
    }

    // Synthesis step
    let synthesisOutput = '';
    if (input.synthesize && previousOutputs.length >= 2) {
      const synthStart = Date.now();
      onProgress?.('### Synthesis\n\n');

      try {
        const synthPrompt = buildSynthesisPrompt(prompt, previousOutputs);
        synthesisOutput = await executeAI({
          prompt: synthPrompt,
          agent: 'plan',
          model: input.model,
          onProgress,
        });
        stepTimings.push({ mind: 'Synthesis', duration: Date.now() - synthStart });
      } catch (err) {
        synthesisOutput = `[Synthesis error: ${err instanceof Error ? err.message : String(err)}]`;
        stepTimings.push({ mind: 'Synthesis', duration: Date.now() - synthStart });
      }
    }

    // Build final output
    const totalDuration = Date.now() - totalStart;
    const lines: string[] = [];

    lines.push(`# Mind Chain: ${input.composition}\n`);
    lines.push(`**Sequence:** ${mindSequence.map(m => getMindConfig(m).name).join(' → ')}\n`);

    for (const o of previousOutputs) {
      lines.push(`## ${o.mind}\n`);
      lines.push(o.output);
      lines.push('');
    }

    if (synthesisOutput) {
      lines.push('## Synthesis\n');
      lines.push(synthesisOutput);
      lines.push('');
    }

    // Timing footer
    lines.push('---\n');
    lines.push(`*Total: ${(totalDuration / 1000).toFixed(1)}s | Steps: ${stepTimings.map(
      s => `${s.mind} ${(s.duration / 1000).toFixed(1)}s`
    ).join(', ')}*`);

    return lines.join('\n');
  },
};
