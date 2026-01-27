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
 * Language Detection Module
 *
 * Uses ML-based detection from @vscode/vscode-languagedetection
 * for accurate programming language identification from code content.
 *
 * @module utils/languageDetection
 */

import pkg from '@vscode/vscode-languagedetection';
const { ModelOperations } = pkg;
import { Logger } from './logger.js';

/** Singleton ML model instance */
let modelOperations: InstanceType<typeof ModelOperations> | null = null;

// Language ID to display name mapping
const LANGUAGE_NAMES: Record<string, string> = {
  ts: 'TypeScript',
  js: 'JavaScript',
  py: 'Python',
  rb: 'Ruby',
  go: 'Go',
  rs: 'Rust',
  java: 'Java',
  cs: 'C#',
  cpp: 'C++',
  c: 'C',
  php: 'PHP',
  swift: 'Swift',
  kt: 'Kotlin',
  scala: 'Scala',
  r: 'R',
  lua: 'Lua',
  perl: 'Perl',
  hs: 'Haskell',
  clj: 'Clojure',
  erl: 'Erlang',
  ex: 'Elixir',
  fs: 'F#',
  dart: 'Dart',
  groovy: 'Groovy',
  julia: 'Julia',
  sql: 'SQL',
  html: 'HTML',
  css: 'CSS',
  scss: 'SCSS',
  less: 'LESS',
  json: 'JSON',
  yaml: 'YAML',
  xml: 'XML',
  md: 'Markdown',
  sh: 'Shell',
  bash: 'Bash',
  ps1: 'PowerShell',
  bat: 'Batch',
  dockerfile: 'Dockerfile',
  makefile: 'Makefile',
  tex: 'LaTeX',
  vue: 'Vue',
  svelte: 'Svelte',
  tsx: 'TypeScript React',
  jsx: 'JavaScript React',
  coffee: 'CoffeeScript',
  elm: 'Elm',
  nim: 'Nim',
  zig: 'Zig',
  v: 'V',
  cr: 'Crystal',
  ml: 'OCaml',
  prolog: 'Prolog',
  lisp: 'Lisp',
  scheme: 'Scheme',
  racket: 'Racket',
  asm: 'Assembly',
  wasm: 'WebAssembly',
  sol: 'Solidity',
  move: 'Move',
  cairo: 'Cairo',
};

// Language ID to syntax highlighting mapping (for code blocks)
const LANGUAGE_SYNTAX: Record<string, string> = {
  ts: 'typescript',
  js: 'javascript',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  cs: 'csharp',
  cpp: 'cpp',
  c: 'c',
  php: 'php',
  swift: 'swift',
  kt: 'kotlin',
  scala: 'scala',
  r: 'r',
  lua: 'lua',
  perl: 'perl',
  hs: 'haskell',
  clj: 'clojure',
  erl: 'erlang',
  ex: 'elixir',
  fs: 'fsharp',
  dart: 'dart',
  groovy: 'groovy',
  julia: 'julia',
  sql: 'sql',
  html: 'html',
  css: 'css',
  scss: 'scss',
  less: 'less',
  json: 'json',
  yaml: 'yaml',
  xml: 'xml',
  md: 'markdown',
  sh: 'bash',
  bash: 'bash',
  ps1: 'powershell',
  bat: 'batch',
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  tex: 'latex',
  vue: 'vue',
  svelte: 'svelte',
  tsx: 'tsx',
  jsx: 'jsx',
  coffee: 'coffeescript',
  elm: 'elm',
  nim: 'nim',
  zig: 'zig',
  v: 'v',
  cr: 'crystal',
  ml: 'ocaml',
  prolog: 'prolog',
  lisp: 'lisp',
  scheme: 'scheme',
  racket: 'racket',
  asm: 'asm',
  wasm: 'wasm',
  sol: 'solidity',
};

export interface LanguageDetectionResult {
  languageId: string;
  languageName: string;
  syntaxHighlight: string;
  confidence: number;
}

/**
 * Get the model operations instance (lazy initialization)
 */
function getModelOperations(): InstanceType<typeof ModelOperations> {
  if (!modelOperations) {
    modelOperations = new ModelOperations();
  }
  return modelOperations;
}

/**
 * Detect programming language from source code content using ML
 * @param content Source code content
 * @returns Detection result with language info and confidence
 */
export async function detectLanguageFromContent(
  content: string
): Promise<LanguageDetectionResult | null> {
  if (!content || content.trim().length < 20) {
    return null;
  }

  try {
    const model = getModelOperations();
    const results = await model.runModel(content);

    if (results && results.length > 0) {
      const top = results[0];
      return {
        languageId: top.languageId,
        languageName: LANGUAGE_NAMES[top.languageId] || top.languageId.toUpperCase(),
        syntaxHighlight: LANGUAGE_SYNTAX[top.languageId] || top.languageId,
        confidence: top.confidence,
      };
    }
  } catch (error) {
    Logger.error('Language detection failed:', error);
  }

  return null;
}

/**
 * Detect language from file extension
 * @param filename Filename or path
 * @returns Language info or null
 */
export function detectLanguageFromExtension(filename: string): LanguageDetectionResult | null {
  const ext = filename.split('.').pop()?.toLowerCase();

  if (!ext) return null;

  const extensionMap: Record<string, string> = {
    ts: 'ts',
    tsx: 'tsx',
    js: 'js',
    jsx: 'jsx',
    mjs: 'js',
    cjs: 'js',
    py: 'py',
    pyw: 'py',
    rb: 'rb',
    go: 'go',
    rs: 'rs',
    java: 'java',
    cs: 'cs',
    cpp: 'cpp',
    cc: 'cpp',
    cxx: 'cpp',
    c: 'c',
    h: 'c',
    hpp: 'cpp',
    php: 'php',
    swift: 'swift',
    kt: 'kt',
    kts: 'kt',
    scala: 'scala',
    r: 'r',
    lua: 'lua',
    pl: 'perl',
    pm: 'perl',
    hs: 'hs',
    lhs: 'hs',
    clj: 'clj',
    cljs: 'clj',
    cljc: 'clj',
    erl: 'erl',
    hrl: 'erl',
    ex: 'ex',
    exs: 'ex',
    fs: 'fs',
    fsx: 'fs',
    dart: 'dart',
    groovy: 'groovy',
    jl: 'julia',
    sql: 'sql',
    html: 'html',
    htm: 'html',
    css: 'css',
    scss: 'scss',
    sass: 'scss',
    less: 'less',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    xml: 'xml',
    md: 'md',
    markdown: 'md',
    sh: 'sh',
    bash: 'bash',
    zsh: 'sh',
    fish: 'sh',
    ps1: 'ps1',
    bat: 'bat',
    cmd: 'bat',
    dockerfile: 'dockerfile',
    tex: 'tex',
    vue: 'vue',
    svelte: 'svelte',
    coffee: 'coffee',
    elm: 'elm',
    nim: 'nim',
    zig: 'zig',
    v: 'v',
    cr: 'cr',
    ml: 'ml',
    mli: 'ml',
    pro: 'prolog',
    lisp: 'lisp',
    lsp: 'lisp',
    scm: 'scheme',
    rkt: 'racket',
    asm: 'asm',
    s: 'asm',
    wasm: 'wasm',
    wat: 'wasm',
    sol: 'sol',
  };

  const langId = extensionMap[ext];
  if (!langId) return null;

  return {
    languageId: langId,
    languageName: LANGUAGE_NAMES[langId] || langId.toUpperCase(),
    syntaxHighlight: LANGUAGE_SYNTAX[langId] || langId,
    confidence: 1.0, // Extension-based detection is certain
  };
}

/**
 * Detect language - tries extension first, falls back to ML content analysis
 * @param filename Filename or path
 * @param content Optional source code content for ML detection
 * @returns Language info
 */
export async function detectLanguage(
  filename: string,
  content?: string
): Promise<LanguageDetectionResult> {
  // Try extension-based detection first (faster and more accurate for known extensions)
  const extResult = detectLanguageFromExtension(filename);
  if (extResult) {
    return extResult;
  }

  // Fall back to ML-based content detection
  if (content) {
    const mlResult = await detectLanguageFromContent(content);
    if (mlResult) {
      return mlResult;
    }
  }

  // Default fallback
  return {
    languageId: 'text',
    languageName: 'Plain Text',
    syntaxHighlight: 'text',
    confidence: 0,
  };
}

/**
 * Get all supported languages
 * @returns Array of supported language names
 */
export function getSupportedLanguages(): string[] {
  return Object.values(LANGUAGE_NAMES);
}

/**
 * Get syntax highlight language for code blocks
 * @param languageId Language ID (e.g., 'ts', 'py')
 * @returns Syntax highlight string for markdown code blocks
 */
export function getSyntaxHighlight(languageId: string): string {
  return LANGUAGE_SYNTAX[languageId] || languageId || 'text';
}
