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
 * Shared symbol search utilities for insert-before-symbol and insert-after-symbol tools.
 *
 * @module tools/code/symbol-search
 */

import { executeCommand } from '../../utils/commandExecutor.js';

/** Language-specific regex patterns for finding symbol definitions via ripgrep */
export const DEFINITION_PATTERNS: Record<string, string[]> = {
  ts: [
    '(class|interface|type|enum)\\s+SYMBOL\\b',
    '(const|let|var)\\s+SYMBOL\\s*[=:]',
    '(function|async function)\\s+SYMBOL\\s*[(<]',
    'export\\s+(const|let|var|function|class|interface|type|enum)\\s+SYMBOL\\b',
  ],
  php: [
    'class\\s+SYMBOL\\b',
    'interface\\s+SYMBOL\\b',
    'trait\\s+SYMBOL\\b',
    'function\\s+SYMBOL\\s*\\(',
    '(public|private|protected|static)\\s+function\\s+SYMBOL\\s*\\(',
  ],
  py: ['class\\s+SYMBOL\\s*[:(]', 'def\\s+SYMBOL\\s*\\(', 'async\\s+def\\s+SYMBOL\\s*\\('],
  go: [
    'func\\s+SYMBOL\\s*\\(',
    'func\\s+\\([^)]+\\)\\s+SYMBOL\\s*\\(',
    'type\\s+SYMBOL\\s+(struct|interface)',
  ],
  rs: [
    'fn\\s+SYMBOL\\s*[<(]',
    'struct\\s+SYMBOL\\s*[<{]',
    'enum\\s+SYMBOL\\s*[<{]',
    'trait\\s+SYMBOL\\s*[<{]',
    'impl\\s+SYMBOL\\b',
  ],
};

/** Supported symbol search languages */
export type SymbolSearchLanguage = 'ts' | 'php' | 'py' | 'go' | 'rs';

/** All supported languages for auto-detection */
export const ALL_LANGUAGES: SymbolSearchLanguage[] = ['ts', 'php', 'py', 'go', 'rs'];

/** Result of a symbol location search */
export interface SymbolLocation {
  file: string;
  line: number;
  content: string;
}

/** Get ripgrep file type filter flags for a language */
export function getTypeFilter(language: string): string[] {
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

/** Find a symbol definition using ripgrep patterns */
export async function findSymbolDefinition(
  symbol: string,
  language: string,
  searchPath: string
): Promise<SymbolLocation | null> {
  const patterns = DEFINITION_PATTERNS[language] || DEFINITION_PATTERNS.ts;
  const typeFilter = getTypeFilter(language);

  for (const pattern of patterns) {
    const regex = pattern.replace(/SYMBOL/g, symbol);

    const args = [
      '-n',
      '-H',
      '--no-heading',
      '--color=never',
      '-e',
      regex,
      ...typeFilter,
      searchPath,
    ];

    try {
      const output = await executeCommand('rg', args);
      const lines = output.split('\n').filter((l) => l.trim());

      if (lines.length > 0) {
        const match = lines[0].match(/^([^:]+):(\d+):(.*)$/);
        if (match) {
          return {
            file: match[1],
            line: parseInt(match[2], 10),
            content: match[3].trim(),
          };
        }
      }
    } catch {
      // Pattern didn't match, try next
    }
  }

  return null;
}

/** Try all languages to find a symbol (auto-detection) */
export async function findSymbolAuto(
  symbol: string,
  searchPath: string
): Promise<{ location: SymbolLocation; language: SymbolSearchLanguage } | null> {
  for (const lang of ALL_LANGUAGES) {
    const location = await findSymbolDefinition(symbol, lang, searchPath);
    if (location) {
      return { location, language: lang };
    }
  }

  return null;
}
