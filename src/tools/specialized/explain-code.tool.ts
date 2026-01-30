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
import { UnifiedTool } from '../registry.js';
import { executeAI, parseFiles, type AgentType } from '../../ai/index.js';
import { getEnhancedContextString } from '../../utils/projectContext.enhanced.js';

const DEPTH_PROMPTS: Record<string, string> = {
  quick: `**QUICK OVERVIEW** - 2-3 sentences per method/class, main purpose, key dependencies`,
  detailed: `**DETAILED** - Full explanation of each method, data flow, design patterns, relationships`,
  deep: `**DEEP ANALYSIS** - Everything from detailed + dependency analysis, potential issues, improvement suggestions, ASCII flow diagram`,
};

const AUDIENCE_PROMPTS: Record<string, string> = {
  junior: `**FOR JUNIOR DEVELOPER** - Explain basic concepts, provide examples, link to documentation, avoid jargon`,
  senior: `**FOR SENIOR DEVELOPER** - Assume framework knowledge, focus on architecture decisions, highlight unusual patterns`,
  'non-tech': `**FOR NON-TECHNICAL** - Explain in business terms, what it does for users, problems it solves`,
};

const schema = z.object({
  files: z.string().describe('Files to explain (@path/file syntax)'),
  depth: z.enum(['quick', 'detailed', 'deep']).default('detailed'),
  audience: z.enum(['junior', 'senior', 'non-tech']).default('senior'),
});

export const explainCodeTool: UnifiedTool = {
  name: 'explain-code',
  description: 'Code explanation at configurable depth and audience level',
  zodSchema: schema,
  prompt: { description: 'Explain PHP/Laravel code' },
  execute: async (args, onProgress) => {
    const { files, depth = 'detailed', audience = 'senior' } = args;
    if (!files?.toString().trim()) throw new Error('Files required. Use @path/file.php syntax.');

    const filesStr = String(files);
    const agent: AgentType = depth === 'quick' ? 'explore' : 'plan';

    const prompt = `${getEnhancedContextString()}
# Code Explanation Request

${DEPTH_PROMPTS[depth as string]}
${AUDIENCE_PROMPTS[audience as string]}

## Files
${filesStr}

## Output Format
### [Class/File Name]
**Purpose:** One sentence describing main responsibility

**How it works:**
[Explanation of flow]

${
  depth !== 'quick'
    ? `
**Key methods:**
- \`methodName()\`: What it does and why

**Dependencies:**
- Uses: [list]
- Used by: [list]
`
    : ''
}
${
  depth === 'deep'
    ? `
**Flow diagram:**
\`\`\`
[ASCII diagram]
\`\`\`

**Potential issues:** [list]
**Improvement suggestions:** [list]
`
    : ''
}

Begin explanation:`;

    onProgress?.(`Explaining code (${depth}, ${audience}): ${filesStr}`);
    return executeAI({ prompt, agent, files: parseFiles(filesStr), onProgress });
  },
};
