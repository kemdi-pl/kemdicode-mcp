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
import { executeAI, parseFiles } from '../../ai/index.js';
import { getEnhancedContextString } from '../../utils/projectContext.enhanced.js';
import { recordSuggestion } from '../../context/feedback-loop.js';
import { isSilent } from '../../config/silent.js';

const schema = z.object({
  files: z.string().describe('Files with the bug. Use @path/file syntax for multiple files, or plain paths separated by spaces'),
  description: z.string().describe('What happens vs expected behavior'),
  errorLog: z.string().optional().describe('Stack trace or error log'),
  steps: z.string().optional().describe('Steps to reproduce'),
});

export const fixBugTool: UnifiedTool = {
  name: 'fix-bug',
  description: 'Bug analysis and fix - root cause, fix proposal, prevention',
  zodSchema: schema,
  prompt: { description: 'Find and fix bugs in PHP/Laravel code' },
  metadata: {
    category: 'specialized',
    tags: ['bug', 'fix', 'debug'],
    longRunning: true,
    examples: [
      { args: { files: '@src/services/OrderService.ts', description: 'Orders are duplicated when payment fails' }, description: 'Analyze and fix a bug with description' },
      { args: { files: '@app/Jobs/ProcessPayment.php', description: 'Job fails silently', errorLog: 'ErrorException: Undefined index', steps: '1. Create order 2. Process payment 3. Job fails' }, description: 'Fix bug with error log and reproduction steps' },
    ],
    relatedTools: ['auto-fix', 'code-review', 'explain-code'],
  },
  execute: async (args, onProgress) => {
    const { files, description, errorLog, steps } = args;
    if (!files?.toString().trim()) throw new Error('Files required. Use @path/file.php syntax.');
    if (!description?.toString().trim()) throw new Error('Bug description required.');

    const filesStr = String(files);
    const silent = isSilent();

    const prompt = silent
      ? `${getEnhancedContextString()}
Bug fix: ${description}
${steps ? `Steps: ${steps}` : ''}
${errorLog ? `Error: ${errorLog}` : ''}
Files: ${filesStr}
Output: JSON {rootCause: {file, line, cause}, fix: {before, after}, explanation}. No markdown.`
      : `${getEnhancedContextString()}
# Bug Fix Request

## Problem
${description}

${steps ? `## Steps to Reproduce\n${steps}` : ''}
${errorLog ? `## Error Log\n\`\`\`\n${errorLog}\n\`\`\`` : ''}

## Files
${filesStr}

## Analysis Framework

### 1. Root Cause Analysis
- Identify exact line/method causing the bug
- Explain WHY the bug occurs
- Determine if it's a bug or edge case

### 2. Impact Assessment
- Does bug affect other parts of the system?
- Is any data corrupted?
- Priority: critical/high/medium/low

### 3. Fix Proposal
- Minimal change approach
- Complete code to paste
- Explanation of why it works

### 4. Prevention
- How to prevent similar bugs
- Suggested unit test

## Output Format

### Root Cause
**Location:** \`file.php:LINE\`
**Cause:** [explanation]

### Proposed Fix
\`\`\`php
// BEFORE (problematic)
...

// AFTER (fixed)
...
\`\`\`

### Why This Works
[explanation]

### Suggested Test
\`\`\`php
public function test_bug_is_fixed(): void
{
    // test case
}
\`\`\`

### Prevention Tips
- [tip 1]
- [tip 2]

Begin analysis:`;

    onProgress?.(`Analyzing bug in: ${filesStr}`);
    const result = await executeAI({ prompt, agent: 'plan', files: parseFiles(filesStr), onProgress });

    // Record suggestions for feedback tracking
    const parsedFiles = parseFiles(filesStr);
    const descStr = String(description);
    for (const file of parsedFiles) {
      recordSuggestion(
        'fix-bug',
        file,
        'fix',
        `Bug fix: ${descStr.slice(0, 100)}${descStr.length > 100 ? '...' : ''}`,
        result.slice(0, 500)
      ).catch(() => {
        /* ignore errors */
      });
    }

    return result;
  },
};
