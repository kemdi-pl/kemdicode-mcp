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

/**
 * Find Definition Tool
 *
 * Locates symbol definitions in the codebase using ripgrep patterns.
 * Supports multiple languages: TypeScript/JavaScript, PHP, Python, Go, Rust.
 *
 * @module tools/code/find-definition
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { executeCommand } from '../../utils/commandExecutor.js';

/**
 * Language-specific patterns for finding symbol definitions
 * Each pattern is a ripgrep regex that matches the definition of a symbol
 */
const DEFINITION_PATTERNS: Record<string, string[]> = {
  // TypeScript/JavaScript patterns
  ts: [
    '(class|interface|type|enum)\\s+SYMBOL\\b',
    '(const|let|var)\\s+SYMBOL\\s*[=:]',
    '(function|async function)\\s+SYMBOL\\s*[(<]',
    'export\\s+(const|let|var|function|class|interface|type|enum)\\s+SYMBOL\\b',
    'SYMBOL\\s*:\\s*(\\([^)]*\\)|[^=])*=>',
    'SYMBOL\\s*=\\s*(async\\s+)?function',
    'SYMBOL\\s*=\\s*(async\\s+)?\\([^)]*\\)\\s*=>',
  ],
  // PHP patterns
  php: [
    'class\\s+SYMBOL\\b',
    'interface\\s+SYMBOL\\b',
    'trait\\s+SYMBOL\\b',
    'enum\\s+SYMBOL\\b',
    'function\\s+SYMBOL\\s*\\(',
    '(public|private|protected|static)\\s+(function\\s+)?SYMBOL\\s*\\(',
    'const\\s+SYMBOL\\s*=',
    '\\$SYMBOL\\s*=',
  ],
  // Python patterns
  py: [
    'class\\s+SYMBOL\\s*[:(]',
    'def\\s+SYMBOL\\s*\\(',
    'async\\s+def\\s+SYMBOL\\s*\\(',
    'SYMBOL\\s*=\\s*',
  ],
  // Go patterns
  go: [
    'func\\s+SYMBOL\\s*\\(',
    'func\\s+\\([^)]+\\)\\s+SYMBOL\\s*\\(',
    'type\\s+SYMBOL\\s+(struct|interface)',
    'var\\s+SYMBOL\\s+',
    'const\\s+SYMBOL\\s+',
  ],
  // Rust patterns
  rs: [
    'fn\\s+SYMBOL\\s*[<(]',
    'struct\\s+SYMBOL\\s*[<{]',
    'enum\\s+SYMBOL\\s*[<{]',
    'trait\\s+SYMBOL\\s*[<{]',
    'impl\\s+SYMBOL\\b',
    'type\\s+SYMBOL\\s*=',
    'const\\s+SYMBOL\\s*:',
    'static\\s+SYMBOL\\s*:',
    'mod\\s+SYMBOL\\b',
  ],
};

/** File type to language mapping */
const _FILE_TYPE_MAP: Record<string, string> = {
  ts: 'ts',
  tsx: 'ts',
  js: 'ts',
  jsx: 'ts',
  mjs: 'ts',
  cjs: 'ts',
  php: 'php',
  py: 'py',
  go: 'go',
  rs: 'rs',
};

const schema = z.object({
  symbol: z.string().describe('Symbol name to find'),
  language: z
    .enum(['ts', 'php', 'py', 'go', 'rs', 'auto'])
    .default('auto')
    .describe('Target language'),
  path: z
    .string()
    .optional()
    .describe('Search directory or file'),
  maxResults: z.number().default(10).describe('Max results'),
});

/**
 * Build ripgrep patterns for a symbol in a given language
 */
function buildPatterns(symbol: string, language: string): string[] {
  const patterns = DEFINITION_PATTERNS[language] || DEFINITION_PATTERNS.ts;
  return patterns.map((p) => p.replace(/SYMBOL/g, symbol));
}

/**
 * Get file type filter for ripgrep
 */
function getTypeFilter(language: string): string[] {
  switch (language) {
    case 'ts':
      return ['--type', 'ts', '--type', 'js'];
    case 'php':
      return ['--type', 'php'];
    case 'py':
      return ['--type', 'py'];
    case 'go':
      return ['--type', 'go'];
    case 'rs':
      return ['--type', 'rust'];
    default:
      return [];
  }
}

/**
 * Execute ripgrep search and parse results
 */
async function searchWithRipgrep(
  patterns: string[],
  language: string,
  searchPath: string,
  maxResults: number
): Promise<string> {
  const typeFilter = getTypeFilter(language);
  const combinedPattern = patterns.join('|');

  const args = [
    '-n', // Line numbers
    '-H', // File names
    '--no-heading',
    '--color=never',
    '-e',
    combinedPattern,
    ...typeFilter,
    searchPath,
  ];

  try {
    const output = await executeCommand('rg', args);
    const lines = output.split('\n').filter((l) => l.trim());

    if (lines.length === 0) {
      return `No definitions found for symbol "${patterns[0]?.replace(/.*SYMBOL.*/g, '')}"`;
    }

    // Format results
    const results = lines.slice(0, maxResults).map((line) => {
      const match = line.match(/^([^:]+):(\d+):(.*)$/);
      if (match) {
        const [, file, lineNum, content] = match;
        return `${file}:${lineNum}\n  ${content.trim()}`;
      }
      return line;
    });

    return `Found ${lines.length} definition(s):\n\n${results.join('\n\n')}`;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes('Exit 1')) {
      return `No definitions found for the specified symbol.`;
    }
    throw error;
  }
}

export const findDefinitionTool: UnifiedTool = {
  name: 'find-definition',
  description: 'Find symbol definition in codebase',
  zodSchema: schema,
  skipContextShare: true, // Code navigation doesn't need sharing
  metadata: {
    category: 'code',
    tags: ['definition', 'navigation', 'ast'],
    examples: [
      {
        args: { symbol: 'UnifiedTool', language: 'ts', path: 'src/' },
        description: 'Find the definition of UnifiedTool interface in TypeScript files',
      },
    ],
    relatedTools: ['find-references', 'find-symbols', 'code-outline'],
  },

  execute: async (args, onProgress) => {
    const { symbol, language = 'auto', path = '.', maxResults = 10 } = args;

    if (!symbol?.toString().trim()) {
      throw new Error('Symbol name is required');
    }

    const symbolName = String(symbol).trim();
    const searchPath = String(path);
    const limit = Number(maxResults);

    onProgress?.(`Searching for definition of "${symbolName}"...`);

    // If auto-detect, search all languages in parallel for better performance
    if (language === 'auto') {
      const languages = Object.keys(DEFINITION_PATTERNS);

      // Run all language searches in parallel
      const searchPromises = languages.map(async (lang) => {
        const patterns = buildPatterns(symbolName, lang);
        try {
          const result = await searchWithRipgrep(patterns, lang, searchPath, limit);
          if (!result.includes('No definitions found')) {
            return { lang, result };
          }
        } catch {
          // Ignore errors for individual language searches
        }
        return null;
      });

      const searchResults = await Promise.all(searchPromises);
      const validResults = searchResults.filter(
        (r): r is { lang: string; result: string } => r !== null
      );

      if (validResults.length === 0) {
        return `No definitions found for symbol "${symbolName}" in any supported language.`;
      }

      // Format results by language
      return validResults.map((r) => `## ${r.lang.toUpperCase()} files\n${r.result}`).join('\n\n');
    }

    // Search specific language
    const patterns = buildPatterns(symbolName, String(language));
    return searchWithRipgrep(patterns, String(language), searchPath, limit);
  },
};
