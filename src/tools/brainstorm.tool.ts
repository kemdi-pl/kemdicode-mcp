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
import { executeAI } from '../ai/index.js';

const METHODOLOGIES: Record<string, string> = {
  divergent: `**Divergent Thinking:** Generate maximum ideas without self-censoring. Build on wild ideas. Combine unrelated concepts.`,
  convergent: `**Convergent Thinking:** Refine and improve existing concepts. Synthesize related ideas. Prioritize by feasibility.`,
  scamper: `**SCAMPER:** Substitute, Combine, Adapt, Modify, Put to other use, Eliminate, Reverse.`,
  'design-thinking': `**Design Thinking:** Empathize with users, define problems, ideate solutions, consider full journey.`,
  lateral: `**Lateral Thinking:** Make unexpected connections. Challenge assumptions. Apply metaphors from other domains.`,
  auto: `**AI-Optimized:** Combine divergent exploration, SCAMPER triggers, and human-centered perspective.`,
};

const schema = z.object({
  prompt: z.string().min(1).describe('Challenge or question'),
  model: z.string().optional().describe('Model override'),
  methodology: z
    .enum(['divergent', 'convergent', 'scamper', 'design-thinking', 'lateral', 'auto'])
    .default('auto'),
  domain: z.string().optional().describe('Domain context'),
  constraints: z.string().optional().describe('Known limitations'),
  ideaCount: z.number().int().positive().default(12).describe('Target idea count'),
  includeAnalysis: z.boolean().default(true).describe('Include feasibility/impact analysis'),
});

export const brainstormTool: UnifiedTool = {
  name: 'brainstorm',
  description: 'Generate ideas with creative frameworks (SCAMPER, Design Thinking)',
  zodSchema: schema,
  prompt: { description: 'Creative ideation with methodology-driven approach' },
  execute: async (args, onProgress) => {
    const {
      prompt,
      model,
      methodology = 'auto',
      domain,
      constraints,
      ideaCount = 12,
      includeAnalysis = true,
    } = args;

    const systemPrompt = `# BRAINSTORMING SESSION

## Challenge
${prompt}

## Methodology
${METHODOLOGIES[methodology as string] || METHODOLOGIES.auto}

## Context
${domain ? `**Domain:** ${domain}` : ''}
${constraints ? `**Constraints:** ${constraints}` : ''}

## Requirements
- Generate ${ideaCount} distinct, creative ideas
- Each idea should be unique and actionable
- Use clear, descriptive naming
${
  includeAnalysis
    ? `
## Analysis (for each idea)
- **Feasibility:** 1-5 scale
- **Impact:** 1-5 scale
- **Innovation:** 1-5 scale
`
    : ''
}

## Format
### Idea [N]: [Name]
**Description:** [2-3 sentences]
${includeAnalysis ? '**Scores:** Feasibility: X | Impact: X | Innovation: X' : ''}

Begin:`;

    onProgress?.(`Generating ${ideaCount} ideas via ${methodology}...`);
    return executeAI({
      prompt: systemPrompt,
      agent: 'plan',
      model: model as string | undefined,
      onProgress,
    });
  },
};
