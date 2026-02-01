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
import { UnifiedTool } from '../registry.js';
import { executeAI, parseFiles, type AgentType } from '../../ai/index.js';
import { getEnhancedContextString } from '../../utils/projectContext.enhanced.js';
import { isSilent } from '../../config/silent.js';

const schema = z.object({
  files: z.string().describe('Main file to analyze (@path/file syntax)'),
  depth: z
    .enum(['shallow', 'deep'])
    .default('shallow')
    .describe('shallow = direct deps, deep = full tree'),
  direction: z.enum(['uses', 'used-by', 'both']).default('both'),
});

export const analyzeDepsTool: UnifiedTool = {
  name: 'analyze-deps',
  description: 'Dependency analysis - uses, used-by, impact assessment',
  zodSchema: schema,
  prompt: { description: 'Analyze file dependencies' },
  metadata: {
    category: 'specialized',
    tags: ['dependencies', 'analysis', 'imports'],
    longRunning: true,
    aiRequired: { fallbackTools: ['project-info', 'file-tree'] },
    aiRouting: 'hybrid',
    examples: [
      { args: { files: '@src/services/UserService.ts' }, description: 'Analyze dependencies of a service file' },
      { args: { files: '@app/Http/Controllers/AuthController.php', depth: 'deep', direction: 'both' }, description: 'Deep dependency analysis in both directions' },
    ],
    relatedTools: ['code-review', 'project-info'],
  },
  execute: async (args, onProgress) => {
    const { files, depth = 'shallow', direction = 'both' } = args;
    if (!files?.toString().trim()) throw new Error('Files required. Use @path/file.php syntax.');

    const filesStr = String(files);
    const agent: AgentType = depth === 'shallow' ? 'explore' : 'plan';

    const directionMap: Record<string, string> = {
      uses: 'OUTGOING - What classes, services, models this file imports/calls',
      'used-by': 'INCOMING - Where this file is imported, called, instantiated',
      both: 'BOTH DIRECTIONS - What it uses and what uses it',
    };

    const silent = isSilent();

    const prompt = silent
      ? `${getEnhancedContextString()}
Dependency analysis (${depth}, ${direction}): ${filesStr}
Output: JSON {file, type, purpose, uses: [{class, type, path}], usedBy: [{class, type, path}]}. No markdown, no diagrams.`
      : `${getEnhancedContextString()}
# Dependency Analysis Request

## Files
${filesStr}

## Scope
**Depth:** ${depth === 'deep' ? 'Full dependency tree (max 3 levels)' : 'Direct dependencies only'}
**Direction:** ${directionMap[direction as string]}

## Instructions
1. **Read** the main file and identify:
   - use statements (imports)
   - new ClassName() calls
   - Dependency injection in constructor
   - Static calls ClassName::method()
   - Dispatched Jobs/Events

2. **Search** for related files:
   - "use App\\...\\ClassName"
   - "new ClassName"
   - Route files
   - Config bindings

3. **Classify** each dependency:
   - Type (Model, Service, Job, Controller, Helper, External)
   - Criticality (would change to main file break it?)

## Output Format
### Main File: \`path/file.php\`
**Type:** Controller|Service|Job|Model|Command
**Purpose:** [one sentence]

### Uses (outgoing)
| Class | Type | Path | Criticality |
|-------|------|------|-------------|

### Used By (incoming)
| Class | Type | Path | How Used |
|-------|------|------|----------|

### Dependency Graph
\`\`\`
[ASCII diagram]
\`\`\`

### Impact Analysis
**If this file changes:**
- ⚠️ May affect: [list]
- ✅ Safe changes: [list]
- 🔴 Risky changes: [list]

Begin analysis:`;

    onProgress?.(`Dependency analysis (${depth}, ${direction}): ${filesStr}`);
    return executeAI({ prompt, agent, files: parseFiles(filesStr), onProgress });
  },
};
