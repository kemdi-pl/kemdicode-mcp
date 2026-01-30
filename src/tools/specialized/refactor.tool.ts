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

const GOALS: Record<string, string> = {
  readability: `**READABILITY** - Better naming, shorter methods (max 15-20 lines), early returns, clear conditions`,
  performance: `**PERFORMANCE** - Optimize DB queries (eager loading, chunking), caching, reduce N+1, lazy collections`,
  solid: `**SOLID PRINCIPLES**
- Single Responsibility: one class = one responsibility
- Open/Closed: open for extension, closed for modification
- Liskov Substitution: subclasses must be interchangeable
- Interface Segregation: small, specific interfaces
- Dependency Inversion: depend on abstractions`,
  'laravel-patterns': `**LARAVEL PATTERNS** - Service classes, Repository pattern, Form Requests, Resources, Events/Listeners, Jobs, Policies`,
  dry: `**DRY** - Identify duplication, extract to methods/traits/services, use inheritance wisely, create helpers`,
};

const SCOPES: Record<string, string> = {
  minimal: `**MINIMAL** - Only obvious fixes, keep public interface, safest changes`,
  moderate: `**MODERATE** - Structural changes allowed, can add classes/methods, maintain backward compatibility`,
  aggressive: `**AGGRESSIVE** - Full restructuring allowed, interfaces can change, code quality over compatibility`,
};

const schema = z.object({
  files: z.string().describe('Files to refactor (@path/file syntax)'),
  goal: z
    .enum(['readability', 'performance', 'solid', 'laravel-patterns', 'dry'])
    .default('readability'),
  scope: z.enum(['minimal', 'moderate', 'aggressive']).default('moderate'),
});

export const refactorTool: UnifiedTool = {
  name: 'refactor',
  description: 'Code refactoring with configurable goal and scope',
  zodSchema: schema,
  prompt: { description: 'Refactor PHP/Laravel code' },
  execute: async (args, onProgress) => {
    const { files, goal = 'readability', scope = 'moderate' } = args;
    if (!files?.toString().trim()) throw new Error('Files required. Use @path/file.php syntax.');

    const filesStr = String(files);
    const prompt = `${getEnhancedContextString()}
# Refactoring Request

${GOALS[goal as string]}
${SCOPES[scope as string]}

## Files
${filesStr}

## Output Format

### Analysis
**Current State:** [what's wrong]
**Code smells:** [list]
**Proposed Changes:** [list]

### Refactored Code

#### \`path/file.php\`

**Change 1: [description]**
\`\`\`php
// BEFORE
[old code]

// AFTER
[new code]
\`\`\`
**Rationale:** Why this change is better

---

### New Files (if any)
\`\`\`php
<?php
// app/Services/NewService.php
namespace App\\Services;

class NewService
{
    // ...
}
\`\`\`

### Migration Guide
1. [step 1]
2. [step 2]

### Summary
| Metric | Before | After |
|--------|--------|-------|
| Lines of code | X | Y |
| Complexity | X | Y |
| Classes | X | Y |

Begin refactoring:`;

    onProgress?.(`Refactoring (${goal}, ${scope}): ${filesStr}`);
    const result = await executeAI({ prompt, agent: 'plan', files: parseFiles(filesStr), onProgress });

    // Record suggestions for feedback tracking
    const parsedFiles = parseFiles(filesStr);
    for (const file of parsedFiles) {
      recordSuggestion(
        'refactor',
        file,
        'refactor',
        `Refactoring (${goal}, ${scope})`,
        result.slice(0, 500)
      ).catch(() => {
        /* ignore errors */
      });
    }

    return result;
  },
};
