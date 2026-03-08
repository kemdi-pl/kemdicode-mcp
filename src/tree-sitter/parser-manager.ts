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
 * Tree-sitter Parser Manager
 *
 * Manages tree-sitter parser instances for multiple languages.
 * Uses web-tree-sitter (WASM) for cross-platform compatibility.
 *
 * @module tree-sitter/parser-manager
 */

import { Parser, Language, type Tree, type SyntaxNode } from 'web-tree-sitter';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { createRequire } from 'module';
import { Logger } from '../utils/logger.js';
import {
  TreeSitterLanguage,
  LANGUAGE_TO_WASM,
  getLanguageFromFile,
  type ParsedSymbol,
  type SymbolType,
  SYMBOL_QUERIES,
} from './types.js';

// Get directory of this module
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Resolve path to WASM grammars from tree-sitter-wasms package.
 * Works both in development and when installed as npm package.
 */
function resolveWasmDir(): string {
  try {
    // Try to resolve the package using require (works when installed as dependency)
    const require = createRequire(import.meta.url);
    const packageJsonPath = require.resolve('tree-sitter-wasms/package.json');
    const wasmPath = resolve(dirname(packageJsonPath), 'out');

    if (existsSync(wasmPath)) {
      Logger.debug(`tree-sitter: resolved WASM dir via require: ${wasmPath}`);
      return wasmPath;
    }
  } catch {
    // Package not found via require, try relative paths
  }

  // Development fallback: try relative to this file
  const devPath = resolve(__dirname, '../../node_modules/tree-sitter-wasms/out');
  if (existsSync(devPath)) {
    Logger.debug(`tree-sitter: resolved WASM dir via relative path: ${devPath}`);
    return devPath;
  }

  // Final fallback: try from process.cwd()
  const cwdPath = resolve(process.cwd(), 'node_modules/tree-sitter-wasms/out');
  if (existsSync(cwdPath)) {
    Logger.debug(`tree-sitter: resolved WASM dir via cwd: ${cwdPath}`);
    return cwdPath;
  }

  // Monorepo fallback: try walking up from __dirname looking for node_modules
  let currentDir = __dirname;
  for (let i = 0; i < 5; i++) {
    const monorepoPath = resolve(currentDir, 'node_modules/tree-sitter-wasms/out');
    if (existsSync(monorepoPath)) {
      Logger.debug(`tree-sitter: resolved WASM dir via monorepo walk: ${monorepoPath}`);
      return monorepoPath;
    }
    currentDir = resolve(currentDir, '..');
  }

  // Return default path even if not found - error will be thrown when loading
  Logger.warn(
    `tree-sitter: could not resolve WASM dir, using default. Install tree-sitter-wasms package.`
  );
  return devPath;
}

/** Path to WASM grammars from tree-sitter-wasms package */
const WASM_DIR = resolveWasmDir();

/** Loaded language instances */
const loadedLanguages = new Map<TreeSitterLanguage, Language>();

/** Parser instance (reused) */
let parser: Parser | null = null;

/** Initialization state */
let initialized = false;

/**
 * Initialize the tree-sitter parser
 * OPTIMIZATION: Already implements lazy loading - only initializes on first use
 */
export async function initParser(): Promise<void> {
  if (initialized) return;

  try {
    await Parser.init();
    parser = new Parser();
    initialized = true;
    Logger.debug('tree-sitter: parser initialized');
  } catch (error) {
    Logger.error(`tree-sitter: failed to initialize parser: ${error}`);
    throw error;
  }
}

/**
 * Load a language grammar
 * OPTIMIZATION: Already implements lazy loading - only loads WASM on first use per language
 */
export async function loadLanguage(language: TreeSitterLanguage): Promise<Language> {
  // Return cached language if available
  const cached = loadedLanguages.get(language);
  if (cached) return cached;

  // Ensure parser is initialized
  await initParser();

  const wasmFile = LANGUAGE_TO_WASM[language]!;
  const wasmPath = resolve(WASM_DIR, wasmFile);

  if (!existsSync(wasmPath)) {
    throw new Error(`Grammar not found for language: ${language} (${wasmPath})`);
  }

  try {
    const lang = await Language.load(wasmPath);
    loadedLanguages.set(language, lang);
    Logger.debug(`tree-sitter: loaded language ${language}`);
    return lang;
  } catch (error) {
    Logger.error(`tree-sitter: failed to load language ${language}: ${error}`);
    throw error;
  }
}

/**
 * Parse source code
 */
/** Maximum file size for tree-sitter parsing (5MB) */
const MAX_PARSE_SIZE = 5 * 1024 * 1024;

export async function parseCode(code: string, language: TreeSitterLanguage): Promise<Tree> {
  if (code.length > MAX_PARSE_SIZE) {
    throw new Error(`File too large for tree-sitter parsing (${(code.length / 1024 / 1024).toFixed(1)}MB, max ${MAX_PARSE_SIZE / 1024 / 1024}MB)`);
  }

  await initParser();
  if (!parser) throw new Error('Parser not initialized');

  const lang = await loadLanguage(language);
  parser.setLanguage(lang);

  const tree = parser.parse(code);
  if (!tree) throw new Error('Failed to parse code');

  return tree;
}

/**
 * Parse a file
 */
export async function parseFile(
  filePath: string
): Promise<{ tree: Tree; language: TreeSitterLanguage }> {
  const language = getLanguageFromFile(filePath);
  if (!language) {
    throw new Error(`Unsupported file type: ${filePath}`);
  }

  const code = await readFile(filePath, 'utf-8');
  const tree = await parseCode(code, language);

  return { tree, language };
}

/**
 * Find all symbols in a tree
 */
export function findSymbols(
  tree: Tree,
  language: TreeSitterLanguage,
  types?: SymbolType[]
): ParsedSymbol[] {
  const symbols: ParsedSymbol[] = [];
  const queries = SYMBOL_QUERIES[language];

  function processNode(node: SyntaxNode, parent?: string): void {
    // Check if this node matches any symbol type
    let matched = false;
    for (const [symbolType, nodeTypes] of Object.entries(queries)) {
      if (types && !types.includes(symbolType as SymbolType)) continue;
      if (!nodeTypes.includes(node.type)) continue;

      const symbol = extractSymbol(node, symbolType as SymbolType, language, parent);
      if (symbol) {
        symbols.push(symbol);
        matched = true;
        // Process children with this symbol as parent
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i);
          if (child) processNode(child, symbol.name);
        }
        break; // Only match first symbol type per node
      }
    }

    // Process children only if this node didn't match (avoids double processing)
    if (!matched) {
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child) processNode(child, parent);
      }
    }
  }

  processNode(tree.rootNode);
  return symbols;
}

/**
 * Extract symbol information from a node
 */
function extractSymbol(
  node: SyntaxNode,
  type: SymbolType,
  _language: TreeSitterLanguage,
  parent?: string
): ParsedSymbol | null {
  // Find the identifier/name node — try common name patterns
  let nameNode: SyntaxNode | null = node.childForFieldName('name');

  if (!nameNode) {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (
        child &&
        (child.type === 'identifier' ||
          child.type === 'property_identifier' ||
          child.type === 'type_identifier')
      ) {
        nameNode = child;
        break;
      }
    }
  }

  if (!nameNode) return null;

  const name = nameNode.text;
  if (!name) return null;

  // Extract modifiers
  const modifiers: string[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (
      child.type === 'public' ||
      child.type === 'private' ||
      child.type === 'protected' ||
      child.type === 'static' ||
      child.type === 'async' ||
      child.type === 'readonly' ||
      child.type === 'abstract' ||
      child.type === 'export' ||
      child.type === 'visibility_modifier'
    ) {
      modifiers.push(child.text);
    }
  }

  // Build signature for functions/methods
  let signature: string | undefined;
  if (type === 'function' || type === 'method') {
    const params = node.childForFieldName('parameters');
    const returnType = node.childForFieldName('return_type');
    if (params) {
      signature = name + params.text;
      if (returnType) {
        signature += ': ' + returnType.text;
      }
    }
  }

  return {
    name,
    type,
    startLine: node.startPosition.row,
    endLine: node.endPosition.row,
    startColumn: node.startPosition.column,
    endColumn: node.endPosition.column,
    parent,
    modifiers: modifiers.length > 0 ? modifiers : undefined,
    signature,
  };
}

/**
 * Find a symbol by name
 */
export function findSymbolByName(
  tree: Tree,
  language: TreeSitterLanguage,
  name: string,
  type?: SymbolType
): ParsedSymbol | null {
  const symbols = findSymbols(tree, language, type ? [type] : undefined);
  return symbols.find((s) => s.name === name) || null;
}

/**
 * Find all references to a name in the tree
 */
export function findReferences(
  tree: Tree,
  name: string
): Array<{ line: number; column: number; context: string }> {
  const references: Array<{ line: number; column: number; context: string }> = [];

  function processNode(node: SyntaxNode): void {
    // Check if this is an identifier matching our name
    if (
      (node.type === 'identifier' ||
        node.type === 'property_identifier' ||
        node.type === 'type_identifier') &&
      node.text === name
    ) {
      // Get the parent line for context
      let current: SyntaxNode | null = node;
      while (current && current.startPosition.row === node.startPosition.row) {
        if (current.parent) current = current.parent;
        else break;
      }
      const contextNode =
        current?.startPosition.row === node.startPosition.row ? current : node.parent;

      references.push({
        line: node.startPosition.row,
        column: node.startPosition.column,
        context: contextNode?.text.split('\n')[0].trim() || node.text,
      });
    }

    // Process children
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) processNode(child);
    }
  }

  processNode(tree.rootNode);
  return references;
}

/**
 * Find the block containing a position
 */
export function findBlockAtPosition(
  tree: Tree,
  line: number,
  column: number
): { startLine: number; endLine: number; type: string } | null {
  let bestMatch: SyntaxNode | null = null;

  function processNode(node: SyntaxNode): void {
    // Check if position is within this node
    const start = node.startPosition;
    const end = node.endPosition;

    if (
      (line > start.row || (line === start.row && column >= start.column)) &&
      (line < end.row || (line === end.row && column <= end.column))
    ) {
      // Check if this is a "block-like" node
      if (
        node.type.includes('function') ||
        node.type.includes('method') ||
        node.type.includes('class') ||
        node.type.includes('block') ||
        node.type.includes('if') ||
        node.type.includes('for') ||
        node.type.includes('while') ||
        node.type.includes('try') ||
        node.type.includes('switch')
      ) {
        // Prefer smaller blocks
        if (
          !bestMatch ||
          node.endPosition.row - node.startPosition.row <
            bestMatch.endPosition.row - bestMatch.startPosition.row
        ) {
          bestMatch = node;
        }
      }

      // Process children
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child) processNode(child);
      }
    }
  }

  processNode(tree.rootNode);

  if (!bestMatch) return null;

  // TypeScript can't track mutations in nested functions, so we need a local const
  const matchedNode: SyntaxNode = bestMatch;

  return {
    startLine: matchedNode.startPosition.row,
    endLine: matchedNode.endPosition.row,
    type: matchedNode.type,
  };
}

/**
 * Find the end of a symbol's block
 */
export function findSymbolBlockEnd(
  tree: Tree,
  language: TreeSitterLanguage,
  symbolName: string
): number | null {
  const symbol = findSymbolByName(tree, language, symbolName);
  if (!symbol) return null;

  // Find the actual node
  let targetNode: SyntaxNode | null = null;

  function findNode(node: SyntaxNode): void {
    if (targetNode) return;

    if (node.startPosition.row === symbol!.startLine && node.endPosition.row === symbol!.endLine) {
      const nameChild = node.childForFieldName('name');
      if (nameChild && nameChild.text === symbolName) {
        targetNode = node;
        return;
      }
      // Also check direct children
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child && child.text === symbolName) {
          targetNode = node;
          return;
        }
      }
    }

    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) findNode(child);
    }
  }

  findNode(tree.rootNode);

  if (!targetNode) return null;

  // TypeScript can't track mutations in nested functions, so we need a local const
  const foundNode: SyntaxNode = targetNode;

  // Find the body/block child
  const body = foundNode.childForFieldName('body');

  if (!body) {
    for (let i = 0; i < foundNode.childCount; i++) {
      const child = foundNode.child(i);
      if (child && (child.type.includes('block') || child.type.includes('body'))) {
        return child.endPosition.row;
      }
    }
  }

  if (body) {
    return body.endPosition.row;
  }

  return foundNode.endPosition.row;
}

/**
 * Get parser status
 */
export function getParserStatus(): {
  initialized: boolean;
  loadedLanguages: TreeSitterLanguage[];
} {
  return {
    initialized,
    loadedLanguages: Array.from(loadedLanguages.keys()),
  };
}

/**
 * Cleanup parser resources
 */
export function cleanup(): void {
  loadedLanguages.clear();
  parser = null;
  initialized = false;
  Logger.debug('tree-sitter: cleaned up');
}
