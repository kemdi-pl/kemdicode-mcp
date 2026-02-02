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
 * Find Symbols Tool
 *
 * Lists all symbols (classes, functions, methods, constants) in a file.
 * Uses regex patterns to extract symbol definitions with line numbers.
 *
 * @module tools/code/find-symbols
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { readFile } from 'fs/promises';
import { access } from 'fs/promises';
import { validatePathSafe } from '../../utils/validation.js';

/**
 * Symbol type enumeration
 */
type SymbolType =
  | 'class'
  | 'interface'
  | 'function'
  | 'method'
  | 'property'
  | 'constant'
  | 'type'
  | 'enum'
  | 'trait'
  | 'module';

/**
 * Extracted symbol information
 */
interface SymbolInfo {
  name: string;
  type: SymbolType;
  line: number;
  parent?: string;
  visibility?: 'public' | 'private' | 'protected';
  isStatic?: boolean;
  isAsync?: boolean;
}

/**
 * Language-specific symbol extraction patterns
 */
interface LanguagePatterns {
  class: RegExp;
  interface?: RegExp;
  function: RegExp;
  method: RegExp;
  property?: RegExp;
  constant?: RegExp;
  type?: RegExp;
  enum?: RegExp;
  trait?: RegExp;
  module?: RegExp;
}

const PATTERNS: Record<string, LanguagePatterns> = {
  ts: {
    class: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/,
    interface: /^\s*(?:export\s+)?interface\s+(\w+)/,
    function: /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/,
    method:
      /^\s*(?:(public|private|protected)\s+)?(?:(static)\s+)?(?:(async)\s+)?(\w+)\s*\([^)]*\)\s*[:{]/,
    property:
      /^\s*(?:(public|private|protected)\s+)?(?:(static)\s+)?(?:readonly\s+)?(\w+)\s*[?]?\s*[:=]/,
    constant: /^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*[:=]/,
    type: /^\s*(?:export\s+)?type\s+(\w+)/,
    enum: /^\s*(?:export\s+)?enum\s+(\w+)/,
  },
  php: {
    class: /^\s*(?:abstract\s+|final\s+)?class\s+(\w+)/,
    interface: /^\s*interface\s+(\w+)/,
    trait: /^\s*trait\s+(\w+)/,
    function: /^\s*function\s+(\w+)\s*\(/,
    method: /^\s*(?:(public|private|protected)\s+)?(?:(static)\s+)?function\s+(\w+)\s*\(/,
    property: /^\s*(?:(public|private|protected)\s+)?(?:(static)\s+)?\$(\w+)/,
    constant: /^\s*(?:const|define\s*\(\s*['"]\s*)(\w+)/,
    enum: /^\s*enum\s+(\w+)/,
  },
  py: {
    class: /^\s*class\s+(\w+)/,
    function: /^\s*(?:async\s+)?def\s+(\w+)\s*\(/,
    method: /^\s{4,}(?:async\s+)?def\s+(\w+)\s*\(/,
    property: /^\s{4,}(\w+)\s*[:=]/,
    constant: /^([A-Z][A-Z0-9_]*)\s*=/,
    module: /^__(\w+)__\s*=/,
  },
  go: {
    class: /^type\s+(\w+)\s+struct\s*\{/,
    interface: /^type\s+(\w+)\s+interface\s*\{/,
    function: /^func\s+(\w+)\s*\(/,
    method: /^func\s+\([^)]+\)\s+(\w+)\s*\(/,
    constant: /^\s*(?:const|var)\s+(\w+)\s+/,
    type: /^type\s+(\w+)\s*=/,
  },
  rs: {
    class: /^(?:pub\s+)?struct\s+(\w+)/,
    interface: /^(?:pub\s+)?trait\s+(\w+)/,
    function: /^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/,
    method: /^\s+(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/,
    constant: /^(?:pub\s+)?(?:const|static)\s+(\w+)\s*:/,
    type: /^(?:pub\s+)?type\s+(\w+)/,
    enum: /^(?:pub\s+)?enum\s+(\w+)/,
    module: /^(?:pub\s+)?mod\s+(\w+)/,
  },
};

/** File extension to language mapping */
const EXT_TO_LANG: Record<string, string> = {
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
  file: z.string().describe('File path'),
  types: z
    .string()
    .optional()
    .describe('Filter by types (comma-separated)'),
  includePrivate: z.boolean().default(true).describe('Include private/protected'),
});

/**
 * Detect language from file extension
 */
function detectLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  return EXT_TO_LANG[ext] || 'ts';
}

/**
 * Extract symbols from file content
 */
function extractSymbols(content: string, lang: string, filterTypes?: Set<string>): SymbolInfo[] {
  const patterns = PATTERNS[lang];
  if (!patterns) return [];

  const lines = content.split('\n');
  const symbols: SymbolInfo[] = [];
  let currentClass: string | undefined;
  let classIndent = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    const currentIndent = line.search(/\S/);

    // Track class context (for method/property parent)
    if (patterns.class) {
      const classMatch = line.match(patterns.class);
      if (classMatch) {
        currentClass = classMatch[1];
        classIndent = currentIndent;
        if (!filterTypes || filterTypes.has('class')) {
          symbols.push({ name: currentClass, type: 'class', line: lineNum });
        }
        continue;
      }
    }

    // Reset class context if we've dedented
    if (currentIndent <= classIndent && currentIndent >= 0 && line.trim()) {
      currentClass = undefined;
      classIndent = -1;
    }

    // Interface
    if (patterns.interface) {
      const match = line.match(patterns.interface);
      if (match && (!filterTypes || filterTypes.has('interface'))) {
        symbols.push({ name: match[1], type: 'interface', line: lineNum });
        continue;
      }
    }

    // Trait (PHP)
    if (patterns.trait) {
      const match = line.match(patterns.trait);
      if (match && (!filterTypes || filterTypes.has('trait'))) {
        symbols.push({ name: match[1], type: 'trait', line: lineNum });
        continue;
      }
    }

    // Type alias
    if (patterns.type) {
      const match = line.match(patterns.type);
      if (match && (!filterTypes || filterTypes.has('type'))) {
        symbols.push({ name: match[1], type: 'type', line: lineNum });
        continue;
      }
    }

    // Enum
    if (patterns.enum) {
      const match = line.match(patterns.enum);
      if (match && (!filterTypes || filterTypes.has('enum'))) {
        symbols.push({ name: match[1], type: 'enum', line: lineNum });
        continue;
      }
    }

    // Module
    if (patterns.module) {
      const match = line.match(patterns.module);
      if (match && (!filterTypes || filterTypes.has('module'))) {
        symbols.push({ name: match[1], type: 'module', line: lineNum });
        continue;
      }
    }

    // Method (check before function to avoid false positives)
    if (patterns.method && currentClass) {
      const match = line.match(patterns.method);
      if (match) {
        // Extract name based on language pattern
        let name: string;
        let visibility: 'public' | 'private' | 'protected' | undefined;
        let isStatic = false;
        let isAsync = false;

        if (lang === 'ts') {
          visibility = match[1] as typeof visibility;
          isStatic = match[2] === 'static';
          isAsync = match[3] === 'async';
          name = match[4];
        } else if (lang === 'php') {
          visibility = match[1] as typeof visibility;
          isStatic = match[2] === 'static';
          name = match[3];
        } else {
          name = match[1];
        }

        if (!filterTypes || filterTypes.has('method')) {
          symbols.push({
            name,
            type: 'method',
            line: lineNum,
            parent: currentClass,
            visibility,
            isStatic,
            isAsync,
          });
        }
        continue;
      }
    }

    // Function (only at top level or for languages without class context)
    if (patterns.function && !currentClass) {
      const match = line.match(patterns.function);
      if (match && (!filterTypes || filterTypes.has('function'))) {
        const isAsync = line.includes('async');
        symbols.push({ name: match[1], type: 'function', line: lineNum, isAsync });
        continue;
      }
    }

    // Property (only inside class)
    if (patterns.property && currentClass) {
      const match = line.match(patterns.property);
      if (match) {
        let name: string;
        let visibility: 'public' | 'private' | 'protected' | undefined;
        let isStatic = false;

        if (lang === 'ts') {
          visibility = match[1] as typeof visibility;
          isStatic = match[2] === 'static';
          name = match[3];
        } else if (lang === 'php') {
          visibility = match[1] as typeof visibility;
          isStatic = match[2] === 'static';
          name = match[3];
        } else {
          name = match[1];
        }

        // Skip constructor assignments and method params
        if (name && !name.startsWith('_') && name !== 'this') {
          if (!filterTypes || filterTypes.has('property')) {
            symbols.push({
              name,
              type: 'property',
              line: lineNum,
              parent: currentClass,
              visibility,
              isStatic,
            });
          }
        }
        continue;
      }
    }

    // Constant (top-level only)
    if (patterns.constant && !currentClass) {
      const match = line.match(patterns.constant);
      if (match && (!filterTypes || filterTypes.has('constant'))) {
        symbols.push({ name: match[1], type: 'constant', line: lineNum });
      }
    }
  }

  return symbols;
}

/**
 * Format symbols for output
 */
function formatSymbols(symbols: SymbolInfo[], includePrivate: boolean): string {
  const filtered = includePrivate
    ? symbols
    : symbols.filter((s) => s.visibility !== 'private' && s.visibility !== 'protected');

  if (filtered.length === 0) {
    return 'No symbols found in the file.';
  }

  // Group by parent (class)
  const toplevel: SymbolInfo[] = [];
  const byClass: Record<string, SymbolInfo[]> = {};

  for (const sym of filtered) {
    if (sym.parent) {
      if (!byClass[sym.parent]) byClass[sym.parent] = [];
      byClass[sym.parent].push(sym);
    } else {
      toplevel.push(sym);
    }
  }

  const lines: string[] = [`Found ${filtered.length} symbol(s):\n`];

  // Format top-level symbols
  for (const sym of toplevel) {
    const prefix = getTypePrefix(sym.type);
    const modifiers = formatModifiers(sym);
    lines.push(`${prefix} ${sym.name}${modifiers}  (line ${sym.line})`);
  }

  // Format class members
  for (const [className, members] of Object.entries(byClass)) {
    lines.push(`\n## ${className}`);
    for (const sym of members) {
      const prefix = getTypePrefix(sym.type);
      const modifiers = formatModifiers(sym);
      const vis = sym.visibility ? `[${sym.visibility.charAt(0)}] ` : '';
      lines.push(`  ${prefix} ${vis}${sym.name}${modifiers}  (line ${sym.line})`);
    }
  }

  return lines.join('\n');
}

/**
 * Get prefix symbol for type
 */
function getTypePrefix(type: SymbolType): string {
  const prefixes: Record<SymbolType, string> = {
    class: 'C',
    interface: 'I',
    function: 'F',
    method: 'M',
    property: 'P',
    constant: 'K',
    type: 'T',
    enum: 'E',
    trait: 'R',
    module: 'D',
  };
  return prefixes[type] || '?';
}

/**
 * Format modifiers string
 */
function formatModifiers(sym: SymbolInfo): string {
  const mods: string[] = [];
  if (sym.isStatic) mods.push('static');
  if (sym.isAsync) mods.push('async');
  return mods.length > 0 ? ` [${mods.join(', ')}]` : '';
}

export const findSymbolsTool: UnifiedTool = {
  name: 'find-symbols',
  description: 'List all symbols in file',
  zodSchema: schema,
  skipContextShare: true, // Code navigation doesn't need sharing
  metadata: {
    category: 'code',
    tags: ['symbols', 'listing', 'ast'],
    examples: [
      {
        args: { file: 'src/tools/registry.ts', types: 'class,interface', includePrivate: false },
        description: 'List all public classes and interfaces in registry.ts',
      },
    ],
    relatedTools: ['find-definition', 'find-references', 'code-outline'],
  },

  execute: async (args, onProgress) => {
    const { file, types, includePrivate = true } = args;

    if (!file?.toString().trim()) {
      throw new Error('File path is required');
    }

    const pathResult = await validatePathSafe(String(file).trim(), { operation: 'read' }, 'find-symbols');
    if (!pathResult.ok) {
      return JSON.stringify({ success: false, error: pathResult.error, code: pathResult.code });
    }
    const filePath = pathResult.path;

    await access(filePath).catch(() => { throw new Error(`File not found: ${filePath}`); });

    onProgress?.(`Analyzing symbols in ${filePath}...`);

    const content = await readFile(filePath, 'utf-8');
    const lang = detectLanguage(filePath);

    // Parse type filter
    const filterTypes = types?.toString().trim()
      ? new Set(
          String(types)
            .split(',')
            .map((t) => t.trim().toLowerCase())
        )
      : undefined;

    const symbols = extractSymbols(content, lang, filterTypes);

    return formatSymbols(symbols, Boolean(includePrivate));
  },
};
