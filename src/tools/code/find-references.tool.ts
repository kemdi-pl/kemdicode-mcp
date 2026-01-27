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
 * Find References Tool
 *
 * Locates all usages of a symbol in the codebase using ripgrep.
 * Can optionally exclude definition lines and filter by file types.
 *
 * @module tools/code/find-references
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { executeCommand } from '../../utils/commandExecutor.js';

/**
 * Patterns that indicate a line is likely a definition rather than a reference
 * Used to filter out definitions when excludeDefinitions is true
 */
const DEFINITION_INDICATORS: Record<string, RegExp[]> = {
  ts: [
    /^\s*(export\s+)?(class|interface|type|enum)\s+\w+/,
    /^\s*(export\s+)?(const|let|var|function|async\s+function)\s+\w+\s*[=:(]/,
    /^\s*(public|private|protected)\s+(static\s+)?(readonly\s+)?\w+\s*[:(]/,
  ],
  php: [
    /^\s*(class|interface|trait|enum)\s+\w+/,
    /^\s*(public|private|protected|static)\s+(function\s+)?\w+\s*\(/,
    /^\s*function\s+\w+\s*\(/,
    /^\s*const\s+\w+\s*=/,
  ],
  py: [/^\s*(class|def|async\s+def)\s+\w+/, /^\s*\w+\s*=\s*(?!.*\()/],
  go: [
    /^\s*func\s+(\([^)]+\)\s+)?\w+\s*\(/,
    /^\s*type\s+\w+\s+(struct|interface)/,
    /^\s*(var|const)\s+\w+/,
  ],
  rs: [
    /^\s*(pub\s+)?(fn|struct|enum|trait|type|const|static|mod)\s+\w+/,
    /^\s*impl\s+(\w+\s+for\s+)?\w+/,
  ],
};

/** File extension to language mapping */
const EXT_TO_LANG: Record<string, string> = {
  ts: 'ts',
  tsx: 'ts',
  js: 'ts',
  jsx: 'ts',
  mjs: 'ts',
  php: 'php',
  py: 'py',
  go: 'go',
  rs: 'rs',
};

const schema = z.object({
  symbol: z.string().describe('Symbol name to find references for'),
  path: z
    .string()
    .optional()
    .describe('Directory or file to search in (defaults to current directory)'),
  fileType: z
    .string()
    .optional()
    .describe('File type filter (e.g., ts, php, py, go, rs, or glob like "*.service.ts")'),
  excludeDefinitions: z
    .boolean()
    .default(false)
    .describe('Exclude lines that appear to be definitions'),
  maxResults: z.number().default(50).describe('Maximum number of results to return'),
  context: z.number().default(0).describe('Lines of context to show around each match (0-5)'),
});

/**
 * Check if a line is likely a definition
 */
function isDefinition(line: string, language: string): boolean {
  const patterns = DEFINITION_INDICATORS[language];
  if (!patterns) return false;
  return patterns.some((p) => p.test(line));
}

/**
 * Get language from file path
 */
function getLangFromPath(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  return EXT_TO_LANG[ext] || 'ts';
}

/**
 * Build ripgrep arguments for file type filtering
 */
function buildTypeArgs(fileType?: string): string[] {
  if (!fileType) return [];

  // If it's a glob pattern
  if (fileType.includes('*') || fileType.includes('.')) {
    return ['--glob', fileType];
  }

  // Standard type filters
  const typeMap: Record<string, string[]> = {
    ts: ['--type', 'ts', '--type', 'js'],
    js: ['--type', 'js'],
    php: ['--type', 'php'],
    py: ['--type', 'py'],
    go: ['--type', 'go'],
    rs: ['--type', 'rust'],
    rust: ['--type', 'rust'],
  };

  return typeMap[fileType.toLowerCase()] || ['--type', fileType];
}

export const findReferencesTool: UnifiedTool = {
  name: 'find-references',
  description: 'Find all usages of a symbol in the codebase',
  zodSchema: schema,
  skipContextShare: true, // Code navigation doesn't need sharing

  execute: async (args, onProgress) => {
    const {
      symbol,
      path = '.',
      fileType,
      excludeDefinitions = false,
      maxResults = 50,
      context = 0,
    } = args;

    if (!symbol?.toString().trim()) {
      throw new Error('Symbol name is required');
    }

    const symbolName = String(symbol).trim();
    const searchPath = String(path);
    const limit = Number(maxResults);
    const contextLines = Math.min(Math.max(Number(context), 0), 5);

    onProgress?.(`Searching for references to "${symbolName}"...`);

    // Build ripgrep arguments
    const rgArgs: string[] = [
      '-n', // Line numbers
      '-H', // File names
      '--no-heading',
      '--color=never',
      '-w', // Word boundaries
    ];

    // Add context if requested
    if (contextLines > 0) {
      rgArgs.push('-C', String(contextLines));
    }

    // Add file type filter (only if fileType is defined)
    if (fileType) {
      const typeArgs = buildTypeArgs(String(fileType));
      rgArgs.push(...typeArgs);
    }

    // Add the pattern and search path
    rgArgs.push('-e', symbolName, searchPath);

    try {
      const output = await executeCommand('rg', rgArgs);
      let lines = output.split('\n').filter((l) => l.trim());

      if (lines.length === 0) {
        return `No references found for symbol "${symbolName}"`;
      }

      // Filter out definitions if requested
      if (excludeDefinitions) {
        lines = lines.filter((line) => {
          const match = line.match(/^([^:]+):(\d+):(.*)$/);
          if (match) {
            const [, filePath, , content] = match;
            const lang = getLangFromPath(filePath);
            return !isDefinition(content, lang);
          }
          return true; // Keep context lines
        });
      }

      // Limit results
      const resultLines = lines.slice(0, limit);

      // Format output
      const groupedByFile: Record<string, string[]> = {};

      for (const line of resultLines) {
        const match = line.match(/^([^:]+):(\d+)[-:](.*)$/);
        if (match) {
          const [, file, lineNum, content] = match;
          if (!groupedByFile[file]) {
            groupedByFile[file] = [];
          }
          groupedByFile[file].push(`  ${lineNum}: ${content.trim()}`);
        }
      }

      const output_lines: string[] = [];
      let totalRefs = 0;

      for (const [file, refs] of Object.entries(groupedByFile)) {
        output_lines.push(`\n## ${file}`);
        output_lines.push(...refs);
        totalRefs += refs.length;
      }

      const summary = `Found ${totalRefs} reference(s) to "${symbolName}"${excludeDefinitions ? ' (excluding definitions)' : ''}`;
      return `${summary}\n${output_lines.join('\n')}`;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('Exit 1')) {
        return `No references found for symbol "${symbolName}"`;
      }
      throw error;
    }
  },
};
