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

/**
 * Semantic Search Tool
 *
 * Uses KemdiCode AI with the 'explore' agent for AI-powered semantic code search.
 * Goes beyond pattern matching to understand code intent and meaning.
 *
 * @module tools/code/semantic-search
 */

import { z } from 'zod';
import { stat, access } from 'fs/promises';
import { UnifiedTool } from '../registry.js';
import { executeAI, parseFiles } from '../../ai/index.js';
import { getEnhancedContextString } from '../../utils/projectContext.enhanced.js';
import { quickPathCheck } from '../../utils/validation.js';

const schema = z.object({
  query: z.string().describe('Natural language search query'),
  files: z
    .string()
    .optional()
    .describe('Scope to files (@path/file.ext syntax)'),
  type: z
    .enum(['function', 'class', 'pattern', 'usage', 'similar', 'any'])
    .default('any')
    .describe('Code element type to search'),
  maxResults: z.number().default(10).describe('Max results'),
  includeContext: z.boolean().default(true).describe('Include surrounding code context'),
});

/**
 * Build a semantic search prompt based on search type
 */
function buildSearchPrompt(
  query: string,
  type: string,
  maxResults: number,
  includeContext: boolean
): string {
  const typeInstructions: Record<string, string> = {
    function: `Find functions/methods that match the description. Focus on:
- Function signatures and implementations
- Method definitions in classes
- Lambda/arrow functions
- Callback definitions`,

    class: `Find classes, interfaces, or types that match the description. Focus on:
- Class definitions and their purpose
- Interface declarations
- Type aliases
- Trait/mixin definitions`,

    pattern: `Find code patterns that match the description. Focus on:
- Design patterns (singleton, factory, observer, etc.)
- Coding patterns (error handling, validation, etc.)
- Architectural patterns (repository, service, etc.)
- Recurring code structures`,

    usage: `Find examples of how something is used. Focus on:
- API calls and method invocations
- Import/require statements
- Variable usage patterns
- Configuration usage`,

    similar: `Find code similar to what's described. Focus on:
- Functionally equivalent implementations
- Code with similar purpose
- Alternative approaches to the same problem`,

    any: `Search broadly for any code matching the description. Consider:
- Functions, classes, and types
- Code patterns and implementations
- Usage examples and integrations
- Comments and documentation`,
  };

  const contextInstruction = includeContext
    ? 'Include 2-3 lines of surrounding context for each result to show how the code fits into the larger codebase.'
    : 'Show only the matching code lines without surrounding context.';

  return `${getEnhancedContextString()}
# Semantic Code Search

## Search Query
"${query}"

## Search Type
${typeInstructions[type] || typeInstructions.any}

## Output Requirements
1. Find up to ${maxResults} relevant code locations
2. ${contextInstruction}
3. For each result, provide:
   - File path and line number(s)
   - The matching code
   - Brief explanation of why it matches the query

## Output Format
### Result 1: [Brief title]
**File:** path/to/file.ext:line-line
**Relevance:** [Why this matches]
\`\`\`
[code snippet]
\`\`\`

### Result 2: ...

## Important
- Search the entire codebase unless specific files are provided
- Prioritize exact matches, then semantic matches
- Include both definitions and usages if relevant
- Note any patterns or conventions you observe

Begin semantic search:`;
}

export const semanticSearchTool: UnifiedTool = {
  name: 'semantic-search',
  description: 'AI-powered semantic code search using natural language',
  zodSchema: schema,
  // Don't skip context share - semantic search results are valuable to share
  metadata: {
    category: 'code',
    tags: ['search', 'semantic', 'ai'],
    longRunning: true,
    aiRequired: { fallbackTools: ['file-search', 'find-definition', 'find-references'] },
    aiRouting: 'local',
    examples: [
      {
        args: { query: 'error handling middleware', type: 'pattern', files: '@src/', maxResults: 5 },
        description: 'Search for error handling middleware patterns in the src directory',
      },
    ],
    relatedTools: ['find-definition', 'find-references', 'file-search'],
  },

  execute: async (args, onProgress) => {
    const { query, files, type = 'any', maxResults = 10, includeContext = true } = args;

    if (!query?.toString().trim()) {
      throw new Error('Search query is required');
    }

    const queryStr = String(query).trim();
    const filesStr = files?.toString().trim() || '';
    const searchType = String(type);
    const limit = Number(maxResults);
    const withContext = Boolean(includeContext);

    onProgress?.(`Performing semantic search: "${queryStr}"...`);

    // If files are specified, parse and validate them
    let attachedFiles: string[] | undefined;
    let scopeInfo = '';

    if (filesStr) {
      const parsedFiles = parseFiles(filesStr);
      const validFiles: string[] = [];

      for (const filePath of parsedFiles) {
        if (!quickPathCheck(filePath)) continue;
        try {
          await access(filePath);
        } catch {
          continue;
        }

        try {
          const stats = await stat(filePath);
          if (stats.isDirectory()) {
            // For directories, add to scope info in prompt instead of attaching
            scopeInfo += `\n- Search in directory: ${filePath}`;
          } else {
            // Regular file, can be attached
            validFiles.push(filePath);
          }
        } catch {
          // Can't stat, skip
          continue;
        }
      }

      attachedFiles = validFiles.length > 0 ? validFiles : undefined;
    }

    const prompt =
      buildSearchPrompt(queryStr, searchType, limit, withContext) +
      (scopeInfo ? `\n\n## Search Scope${scopeInfo}` : '');

    // Use 'explore' agent for fast codebase exploration
    return executeAI({
      prompt,
      agent: 'explore',
      files: attachedFiles,
      onProgress,
    });
  },
};
