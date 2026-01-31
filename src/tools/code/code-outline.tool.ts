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
 * Code Outline Tool
 *
 * Generates a hierarchical structure outline of a file.
 * Shows classes with their methods, functions, and other symbols.
 * Supports multiple languages: TypeScript/JavaScript, PHP, Python, Go, Rust.
 *
 * @module tools/code/code-outline
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';

/**
 * Outline node representing a code element
 */
interface OutlineNode {
  name: string;
  type: string;
  line: number;
  endLine?: number;
  children: OutlineNode[];
  modifiers?: string[];
  signature?: string;
}

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
  depth: z.number().default(2).describe('Outline depth (1-5)'),
  showSignatures: z.boolean().default(true).describe('Show signatures'),
  showLineNumbers: z.boolean().default(true).describe('Show line numbers'),
});

/**
 * Parse TypeScript/JavaScript file into outline
 */
function parseTsOutline(content: string): OutlineNode[] {
  const lines = content.split('\n');
  const root: OutlineNode[] = [];
  const _stack: { node: OutlineNode; indent: number }[] = [];

  const patterns = {
    class:
      /^\s*(?:export\s+)?(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+implements\s+([^{]+))?/,
    interface: /^\s*(?:export\s+)?interface\s+(\w+)(?:\s+extends\s+([^{]+))?/,
    enum: /^\s*(?:export\s+)?enum\s+(\w+)/,
    type: /^\s*(?:export\s+)?type\s+(\w+)\s*=/,
    function: /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*(<[^>]+>)?\s*\(([^)]*)\)/,
    arrowFunc:
      /^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:<[^>]+>\s*)?\([^)]*\)\s*(?::\s*[^=]+)?\s*=>/,
    method:
      /^\s*(?:(public|private|protected)\s+)?(?:(static)\s+)?(?:(async)\s+)?(\w+)\s*(<[^>]+>)?\s*\(([^)]*)\)/,
    property:
      /^\s*(?:(public|private|protected)\s+)?(?:(static)\s+)?(?:(readonly)\s+)?(\w+)\s*[?]?\s*:/,
    namespace: /^\s*(?:export\s+)?(?:namespace|module)\s+(\w+)/,
  };

  let currentContainer: OutlineNode | null = null;
  let containerIndent = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    const indent = line.search(/\S/);

    if (indent < 0) continue; // Empty line

    // Check if we've exited the current container
    if (
      currentContainer &&
      indent <= containerIndent &&
      line.trim() &&
      !line.trim().startsWith('//')
    ) {
      currentContainer = null;
      containerIndent = -1;
    }

    // Namespace
    let match = line.match(patterns.namespace);
    if (match) {
      const node: OutlineNode = {
        name: match[1],
        type: 'namespace',
        line: lineNum,
        children: [],
      };
      root.push(node);
      currentContainer = node;
      containerIndent = indent;
      continue;
    }

    // Class
    match = line.match(patterns.class);
    if (match) {
      const modifiers: string[] = [];
      if (line.includes('abstract')) modifiers.push('abstract');
      if (line.includes('export')) modifiers.push('export');

      const node: OutlineNode = {
        name: match[1],
        type: 'class',
        line: lineNum,
        children: [],
        modifiers: modifiers.length > 0 ? modifiers : undefined,
        signature: match[2] ? `extends ${match[2]}` : undefined,
      };

      if (currentContainer) {
        currentContainer.children.push(node);
      } else {
        root.push(node);
      }
      currentContainer = node;
      containerIndent = indent;
      continue;
    }

    // Interface
    match = line.match(patterns.interface);
    if (match) {
      const node: OutlineNode = {
        name: match[1],
        type: 'interface',
        line: lineNum,
        children: [],
        signature: match[2] ? `extends ${match[2].trim()}` : undefined,
      };
      if (currentContainer && currentContainer.type === 'namespace') {
        currentContainer.children.push(node);
      } else {
        root.push(node);
      }
      continue;
    }

    // Enum
    match = line.match(patterns.enum);
    if (match) {
      const node: OutlineNode = {
        name: match[1],
        type: 'enum',
        line: lineNum,
        children: [],
      };
      root.push(node);
      continue;
    }

    // Type
    match = line.match(patterns.type);
    if (match) {
      root.push({
        name: match[1],
        type: 'type',
        line: lineNum,
        children: [],
      });
      continue;
    }

    // Method (inside class)
    if (currentContainer?.type === 'class') {
      match = line.match(patterns.method);
      if (match && !line.includes('function')) {
        const modifiers: string[] = [];
        if (match[1]) modifiers.push(match[1]);
        if (match[2]) modifiers.push('static');
        if (match[3]) modifiers.push('async');

        currentContainer.children.push({
          name: match[4],
          type: 'method',
          line: lineNum,
          children: [],
          modifiers: modifiers.length > 0 ? modifiers : undefined,
          signature: match[6] ? `(${match[6].trim()})` : '()',
        });
        continue;
      }

      // Property
      match = line.match(patterns.property);
      if (match && !line.includes('(')) {
        const modifiers: string[] = [];
        if (match[1]) modifiers.push(match[1]);
        if (match[2]) modifiers.push('static');
        if (match[3]) modifiers.push('readonly');

        currentContainer.children.push({
          name: match[4],
          type: 'property',
          line: lineNum,
          children: [],
          modifiers: modifiers.length > 0 ? modifiers : undefined,
        });
        continue;
      }
    }

    // Top-level function
    if (!currentContainer || currentContainer.type === 'namespace') {
      match = line.match(patterns.function);
      if (match) {
        const targetArray = currentContainer ? currentContainer.children : root;
        targetArray.push({
          name: match[1],
          type: 'function',
          line: lineNum,
          children: [],
          modifiers: line.includes('async') ? ['async'] : undefined,
          signature: `(${match[3]?.trim() || ''})`,
        });
        continue;
      }

      // Arrow function constant
      match = line.match(patterns.arrowFunc);
      if (match) {
        root.push({
          name: match[1],
          type: 'function',
          line: lineNum,
          children: [],
          modifiers: line.includes('async') ? ['async'] : undefined,
        });
      }
    }
  }

  return root;
}

/**
 * Parse PHP file into outline
 */
function parsePhpOutline(content: string): OutlineNode[] {
  const lines = content.split('\n');
  const root: OutlineNode[] = [];
  let currentClass: OutlineNode | null = null;

  const patterns = {
    namespace: /^\s*namespace\s+([^;]+)/,
    class:
      /^\s*(?:abstract\s+|final\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+implements\s+([^{]+))?/,
    interface: /^\s*interface\s+(\w+)(?:\s+extends\s+([^{]+))?/,
    trait: /^\s*trait\s+(\w+)/,
    enum: /^\s*enum\s+(\w+)/,
    function: /^\s*function\s+(\w+)\s*\(([^)]*)\)/,
    method: /^\s*(?:(public|private|protected)\s+)?(?:(static)\s+)?function\s+(\w+)\s*\(([^)]*)\)/,
    property: /^\s*(?:(public|private|protected)\s+)?(?:(static)\s+)?\$(\w+)/,
    const: /^\s*(?:const|public\s+const|private\s+const|protected\s+const)\s+(\w+)\s*=/,
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Namespace
    let match = line.match(patterns.namespace);
    if (match) {
      root.push({
        name: match[1].trim(),
        type: 'namespace',
        line: lineNum,
        children: [],
      });
      continue;
    }

    // Class
    match = line.match(patterns.class);
    if (match) {
      const modifiers: string[] = [];
      if (line.includes('abstract')) modifiers.push('abstract');
      if (line.includes('final')) modifiers.push('final');

      currentClass = {
        name: match[1],
        type: 'class',
        line: lineNum,
        children: [],
        modifiers: modifiers.length > 0 ? modifiers : undefined,
        signature: match[2] ? `extends ${match[2]}` : undefined,
      };
      root.push(currentClass);
      continue;
    }

    // Interface
    match = line.match(patterns.interface);
    if (match) {
      root.push({
        name: match[1],
        type: 'interface',
        line: lineNum,
        children: [],
        signature: match[2] ? `extends ${match[2].trim()}` : undefined,
      });
      continue;
    }

    // Trait
    match = line.match(patterns.trait);
    if (match) {
      currentClass = {
        name: match[1],
        type: 'trait',
        line: lineNum,
        children: [],
      };
      root.push(currentClass);
      continue;
    }

    // Enum
    match = line.match(patterns.enum);
    if (match) {
      root.push({
        name: match[1],
        type: 'enum',
        line: lineNum,
        children: [],
      });
      continue;
    }

    // Method (inside class/trait)
    if (currentClass) {
      match = line.match(patterns.method);
      if (match) {
        const modifiers: string[] = [];
        if (match[1]) modifiers.push(match[1]);
        if (match[2]) modifiers.push('static');

        currentClass.children.push({
          name: match[3],
          type: 'method',
          line: lineNum,
          children: [],
          modifiers: modifiers.length > 0 ? modifiers : undefined,
          signature: `(${match[4]?.trim() || ''})`,
        });
        continue;
      }

      // Property
      match = line.match(patterns.property);
      if (match) {
        const modifiers: string[] = [];
        if (match[1]) modifiers.push(match[1]);
        if (match[2]) modifiers.push('static');

        currentClass.children.push({
          name: match[3],
          type: 'property',
          line: lineNum,
          children: [],
          modifiers: modifiers.length > 0 ? modifiers : undefined,
        });
        continue;
      }

      // Constant
      match = line.match(patterns.const);
      if (match) {
        currentClass.children.push({
          name: match[1],
          type: 'constant',
          line: lineNum,
          children: [],
        });
        continue;
      }
    }

    // Top-level function
    if (!currentClass) {
      match = line.match(patterns.function);
      if (match) {
        root.push({
          name: match[1],
          type: 'function',
          line: lineNum,
          children: [],
          signature: `(${match[2]?.trim() || ''})`,
        });
      }
    }

    // Reset class context at closing brace (simplistic)
    if (currentClass && line.match(/^}\s*$/)) {
      currentClass = null;
    }
  }

  return root;
}

/**
 * Parse Python file into outline
 */
function parsePyOutline(content: string): OutlineNode[] {
  const lines = content.split('\n');
  const root: OutlineNode[] = [];
  let currentClass: OutlineNode | null = null;
  let classIndent = -1;

  const patterns = {
    class: /^(\s*)class\s+(\w+)(?:\(([^)]*)\))?:/,
    function: /^(\s*)(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)/,
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Class
    let match = line.match(patterns.class);
    if (match) {
      const indent = match[1].length;

      // Check if we've exited a class
      if (currentClass && indent <= classIndent) {
        currentClass = null;
        classIndent = -1;
      }

      currentClass = {
        name: match[2],
        type: 'class',
        line: lineNum,
        children: [],
        signature: match[3] ? `(${match[3].trim()})` : undefined,
      };
      classIndent = indent;
      root.push(currentClass);
      continue;
    }

    // Function/Method
    match = line.match(patterns.function);
    if (match) {
      const indent = match[1].length;
      const isAsync = line.includes('async def');

      // Check if we've exited a class
      if (currentClass && indent <= classIndent) {
        currentClass = null;
        classIndent = -1;
      }

      const node: OutlineNode = {
        name: match[2],
        type: currentClass && indent > classIndent ? 'method' : 'function',
        line: lineNum,
        children: [],
        modifiers: isAsync ? ['async'] : undefined,
        signature: `(${match[3]?.trim() || ''})`,
      };

      if (currentClass && indent > classIndent) {
        currentClass.children.push(node);
      } else {
        root.push(node);
      }
    }
  }

  return root;
}

/**
 * Parse Go file into outline
 */
function parseGoOutline(content: string): OutlineNode[] {
  const lines = content.split('\n');
  const root: OutlineNode[] = [];

  const patterns = {
    package: /^package\s+(\w+)/,
    struct: /^type\s+(\w+)\s+struct\s*\{/,
    interface: /^type\s+(\w+)\s+interface\s*\{/,
    typeAlias: /^type\s+(\w+)\s+/,
    function: /^func\s+(\w+)\s*(\([^)]*\))?/,
    method: /^func\s+\(([^)]+)\)\s+(\w+)\s*(\([^)]*\))?/,
    const: /^const\s+(\w+)\s+/,
    var: /^var\s+(\w+)\s+/,
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Package
    let match = line.match(patterns.package);
    if (match) {
      root.push({
        name: match[1],
        type: 'package',
        line: lineNum,
        children: [],
      });
      continue;
    }

    // Struct
    match = line.match(patterns.struct);
    if (match) {
      root.push({
        name: match[1],
        type: 'struct',
        line: lineNum,
        children: [],
      });
      continue;
    }

    // Interface
    match = line.match(patterns.interface);
    if (match) {
      root.push({
        name: match[1],
        type: 'interface',
        line: lineNum,
        children: [],
      });
      continue;
    }

    // Method (has receiver)
    match = line.match(patterns.method);
    if (match) {
      root.push({
        name: match[2],
        type: 'method',
        line: lineNum,
        children: [],
        signature: match[3] || '()',
        modifiers: [match[1].trim()], // Receiver as modifier
      });
      continue;
    }

    // Function
    match = line.match(patterns.function);
    if (match) {
      root.push({
        name: match[1],
        type: 'function',
        line: lineNum,
        children: [],
        signature: match[2] || '()',
      });
      continue;
    }

    // Const
    match = line.match(patterns.const);
    if (match) {
      root.push({
        name: match[1],
        type: 'constant',
        line: lineNum,
        children: [],
      });
      continue;
    }

    // Var
    match = line.match(patterns.var);
    if (match) {
      root.push({
        name: match[1],
        type: 'variable',
        line: lineNum,
        children: [],
      });
    }
  }

  return root;
}

/**
 * Parse Rust file into outline
 */
function parseRsOutline(content: string): OutlineNode[] {
  const lines = content.split('\n');
  const root: OutlineNode[] = [];
  let currentImpl: OutlineNode | null = null;

  const patterns = {
    mod: /^(?:pub\s+)?mod\s+(\w+)/,
    struct: /^(?:pub\s+)?struct\s+(\w+)/,
    enum: /^(?:pub\s+)?enum\s+(\w+)/,
    trait: /^(?:pub\s+)?trait\s+(\w+)/,
    impl: /^impl(?:<[^>]+>)?\s+(?:(\w+)\s+for\s+)?(\w+)/,
    fn: /^(\s*)(?:pub\s+)?(?:async\s+)?fn\s+(\w+)(?:<[^>]+>)?\s*\(([^)]*)\)/,
    const: /^(?:pub\s+)?const\s+(\w+)\s*:/,
    static: /^(?:pub\s+)?static\s+(\w+)\s*:/,
    type: /^(?:pub\s+)?type\s+(\w+)\s*=/,
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Module
    let match = line.match(patterns.mod);
    if (match) {
      root.push({
        name: match[1],
        type: 'module',
        line: lineNum,
        children: [],
        modifiers: line.includes('pub') ? ['pub'] : undefined,
      });
      continue;
    }

    // Struct
    match = line.match(patterns.struct);
    if (match) {
      root.push({
        name: match[1],
        type: 'struct',
        line: lineNum,
        children: [],
        modifiers: line.includes('pub') ? ['pub'] : undefined,
      });
      continue;
    }

    // Enum
    match = line.match(patterns.enum);
    if (match) {
      root.push({
        name: match[1],
        type: 'enum',
        line: lineNum,
        children: [],
        modifiers: line.includes('pub') ? ['pub'] : undefined,
      });
      continue;
    }

    // Trait
    match = line.match(patterns.trait);
    if (match) {
      root.push({
        name: match[1],
        type: 'trait',
        line: lineNum,
        children: [],
        modifiers: line.includes('pub') ? ['pub'] : undefined,
      });
      continue;
    }

    // Impl block
    match = line.match(patterns.impl);
    if (match) {
      currentImpl = {
        name: match[1] ? `${match[1]} for ${match[2]}` : match[2],
        type: 'impl',
        line: lineNum,
        children: [],
      };
      root.push(currentImpl);
      continue;
    }

    // Function
    match = line.match(patterns.fn);
    if (match) {
      const indent = match[1].length;
      const modifiers: string[] = [];
      if (line.includes('pub')) modifiers.push('pub');
      if (line.includes('async')) modifiers.push('async');

      const node: OutlineNode = {
        name: match[2],
        type: currentImpl && indent > 0 ? 'method' : 'function',
        line: lineNum,
        children: [],
        modifiers: modifiers.length > 0 ? modifiers : undefined,
        signature: `(${match[3]?.trim() || ''})`,
      };

      if (currentImpl && indent > 0) {
        currentImpl.children.push(node);
      } else {
        root.push(node);
        currentImpl = null;
      }
      continue;
    }

    // Const
    match = line.match(patterns.const);
    if (match) {
      root.push({
        name: match[1],
        type: 'constant',
        line: lineNum,
        children: [],
        modifiers: line.includes('pub') ? ['pub'] : undefined,
      });
      continue;
    }

    // Static
    match = line.match(patterns.static);
    if (match) {
      root.push({
        name: match[1],
        type: 'static',
        line: lineNum,
        children: [],
        modifiers: line.includes('pub') ? ['pub'] : undefined,
      });
      continue;
    }

    // Type alias
    match = line.match(patterns.type);
    if (match) {
      root.push({
        name: match[1],
        type: 'type',
        line: lineNum,
        children: [],
        modifiers: line.includes('pub') ? ['pub'] : undefined,
      });
    }

    // Reset impl context at closing brace
    if (currentImpl && line.match(/^}\s*$/)) {
      currentImpl = null;
    }
  }

  return root;
}

/**
 * Format outline as text
 */
function formatOutline(
  nodes: OutlineNode[],
  depth: number,
  showSignatures: boolean,
  showLineNumbers: boolean,
  currentDepth: number = 0,
  indent: string = ''
): string {
  if (currentDepth >= depth) return '';

  const lines: string[] = [];

  for (const node of nodes) {
    const typeIcon = getTypeIcon(node.type);
    const mods = node.modifiers?.length ? `[${node.modifiers.join(' ')}] ` : '';
    const sig = showSignatures && node.signature ? node.signature : '';
    const lineNum = showLineNumbers ? ` :${node.line}` : '';

    lines.push(`${indent}${typeIcon} ${mods}${node.name}${sig}${lineNum}`);

    if (node.children.length > 0 && currentDepth + 1 < depth) {
      const childOutput = formatOutline(
        node.children,
        depth,
        showSignatures,
        showLineNumbers,
        currentDepth + 1,
        indent + '  '
      );
      if (childOutput) {
        lines.push(childOutput);
      }
    }
  }

  return lines.join('\n');
}

/**
 * Get icon for node type
 */
function getTypeIcon(type: string): string {
  const icons: Record<string, string> = {
    namespace: 'N',
    package: 'P',
    module: 'M',
    class: 'C',
    interface: 'I',
    trait: 'T',
    struct: 'S',
    enum: 'E',
    impl: 'I',
    function: 'f',
    method: 'm',
    property: 'p',
    constant: 'k',
    static: 's',
    variable: 'v',
    type: 't',
  };
  return icons[type] || '?';
}

/**
 * Detect language from file extension
 */
function detectLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  return EXT_TO_LANG[ext] || 'ts';
}

export const codeOutlineTool: UnifiedTool = {
  name: 'code-outline',
  description: 'Generate file structure outline (classes, methods, functions)',
  zodSchema: schema,
  skipContextShare: true, // Code navigation doesn't need sharing
  metadata: {
    category: 'code',
    tags: ['outline', 'structure', 'ast'],
    examples: [
      {
        args: { file: 'src/tools/registry.ts', depth: 2, showSignatures: true },
        description: 'Generate outline of registry.ts showing classes and methods with signatures',
      },
    ],
    relatedTools: ['find-symbols', 'find-definition', 'explain-code'],
  },

  execute: async (args, onProgress) => {
    const { file, depth = 2, showSignatures = true, showLineNumbers = true } = args;

    if (!file?.toString().trim()) {
      throw new Error('File path is required');
    }

    const filePath = String(file).trim();
    const maxDepth = Math.min(Math.max(Number(depth), 1), 5);

    if (!existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    onProgress?.(`Generating outline for ${filePath}...`);

    const content = await readFile(filePath, 'utf-8');
    const lang = detectLanguage(filePath);

    let outline: OutlineNode[];

    switch (lang) {
      case 'ts':
        outline = parseTsOutline(content);
        break;
      case 'php':
        outline = parsePhpOutline(content);
        break;
      case 'py':
        outline = parsePyOutline(content);
        break;
      case 'go':
        outline = parseGoOutline(content);
        break;
      case 'rs':
        outline = parseRsOutline(content);
        break;
      default:
        outline = parseTsOutline(content); // Fallback to TS patterns
    }

    if (outline.length === 0) {
      return `No symbols found in ${filePath}`;
    }

    const header = `# Code Outline: ${filePath}\n# Language: ${lang.toUpperCase()}\n\n`;
    const legend = `Legend: C=class I=interface T=trait S=struct E=enum M=module\n        f=function m=method p=property k=constant\n\n`;

    return (
      header +
      legend +
      formatOutline(outline, maxDepth, Boolean(showSignatures), Boolean(showLineNumbers))
    );
  },
};
