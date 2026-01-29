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
 * Tree-sitter Types
 *
 * TypeScript interfaces for tree-sitter integration.
 *
 * @module tree-sitter/types
 */

/** Supported languages */
export type TreeSitterLanguage =
  | 'typescript'
  | 'javascript'
  | 'php'
  | 'python'
  | 'go'
  | 'rust'
  | 'java'
  | 'c'
  | 'cpp'
  | 'csharp'
  | 'ruby'
  | 'swift'
  | 'kotlin'
  | 'scala'
  | 'lua'
  | 'bash'
  | 'json'
  | 'html'
  | 'css';

/** File extension to language mapping */
export const EXTENSION_TO_LANGUAGE: Record<string, TreeSitterLanguage> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.php': 'php',
  '.py': 'python',
  '.pyw': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.hpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.cs': 'csharp',
  '.rb': 'ruby',
  '.swift': 'swift',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.scala': 'scala',
  '.sc': 'scala',
  '.lua': 'lua',
  '.sh': 'bash',
  '.bash': 'bash',
  '.zsh': 'bash',
  '.json': 'json',
  '.html': 'html',
  '.htm': 'html',
  '.css': 'css',
};

/** Language to WASM file mapping */
export const LANGUAGE_TO_WASM: Record<TreeSitterLanguage, string> = {
  typescript: 'tree-sitter-typescript.wasm',
  javascript: 'tree-sitter-javascript.wasm',
  php: 'tree-sitter-php.wasm',
  python: 'tree-sitter-python.wasm',
  go: 'tree-sitter-go.wasm',
  rust: 'tree-sitter-rust.wasm',
  java: 'tree-sitter-java.wasm',
  c: 'tree-sitter-c.wasm',
  cpp: 'tree-sitter-cpp.wasm',
  csharp: 'tree-sitter-c_sharp.wasm',
  ruby: 'tree-sitter-ruby.wasm',
  swift: 'tree-sitter-swift.wasm',
  kotlin: 'tree-sitter-kotlin.wasm',
  scala: 'tree-sitter-scala.wasm',
  lua: 'tree-sitter-lua.wasm',
  bash: 'tree-sitter-bash.wasm',
  json: 'tree-sitter-json.wasm',
  html: 'tree-sitter-html.wasm',
  css: 'tree-sitter-css.wasm',
};

/** Symbol types for different languages */
export type SymbolType =
  | 'class'
  | 'interface'
  | 'function'
  | 'method'
  | 'property'
  | 'variable'
  | 'constant'
  | 'enum'
  | 'type'
  | 'namespace'
  | 'module'
  | 'import'
  | 'export';

/** Parsed symbol information */
export interface ParsedSymbol {
  name: string;
  type: SymbolType;
  startLine: number;
  endLine: number;
  startColumn: number;
  endColumn: number;
  children?: ParsedSymbol[];
  parent?: string;
  modifiers?: string[];
  signature?: string;
}

/** Position in source code */
export interface SourcePosition {
  line: number; // 0-indexed
  column: number; // 0-indexed
}

/** Range in source code */
export interface SourceRange {
  start: SourcePosition;
  end: SourcePosition;
}

/** Location in a file */
export interface SourceLocation {
  file: string;
  range: SourceRange;
}

/** Definition lookup result */
export interface DefinitionResult {
  found: boolean;
  symbol: string;
  type: SymbolType;
  location: SourceLocation;
  signature?: string;
}

/** Reference lookup result */
export interface ReferenceResult {
  symbol: string;
  locations: SourceLocation[];
  count: number;
}

/** Rename operation result */
export interface RenameResult {
  success: boolean;
  oldName: string;
  newName: string;
  edits: Array<{
    file: string;
    range: SourceRange;
    newText: string;
  }>;
  fileCount: number;
  editCount: number;
  dryRun: boolean;
}

/** Code outline entry */
export interface OutlineEntry {
  name: string;
  type: SymbolType;
  line: number;
  signature?: string;
  children?: OutlineEntry[];
}

/** Block detection result */
export interface BlockResult {
  found: boolean;
  startLine: number;
  endLine: number;
  type: 'function' | 'class' | 'method' | 'block' | 'if' | 'loop' | 'other';
}

/** Parser manager state */
export interface ParserState {
  initialized: boolean;
  loadedLanguages: Set<TreeSitterLanguage>;
}

/**
 * Get language from file path
 */
export function getLanguageFromFile(filePath: string): TreeSitterLanguage | null {
  const ext = filePath.slice(filePath.lastIndexOf('.'));
  return EXTENSION_TO_LANGUAGE[ext] || null;
}

/**
 * Node type queries for different languages
 */
export const SYMBOL_QUERIES: Record<TreeSitterLanguage, Record<SymbolType, string[]>> = {
  typescript: {
    class: ['class_declaration', 'abstract_class_declaration'],
    interface: ['interface_declaration', 'type_alias_declaration'],
    function: ['function_declaration', 'arrow_function', 'function_expression'],
    method: ['method_definition', 'method_signature'],
    property: ['property_signature', 'public_field_definition'],
    variable: ['variable_declarator', 'lexical_declaration'],
    constant: ['variable_declarator'],
    enum: ['enum_declaration'],
    type: ['type_alias_declaration'],
    namespace: ['module'],
    module: ['module'],
    import: ['import_statement'],
    export: ['export_statement'],
  },
  javascript: {
    class: ['class_declaration'],
    interface: [],
    function: ['function_declaration', 'arrow_function', 'function_expression'],
    method: ['method_definition'],
    property: ['property_identifier'],
    variable: ['variable_declarator'],
    constant: ['variable_declarator'],
    enum: [],
    type: [],
    namespace: [],
    module: [],
    import: ['import_statement'],
    export: ['export_statement'],
  },
  php: {
    class: ['class_declaration'],
    interface: ['interface_declaration'],
    function: ['function_definition'],
    method: ['method_declaration'],
    property: ['property_declaration'],
    variable: ['simple_variable'],
    constant: ['const_declaration'],
    enum: ['enum_declaration'],
    type: [],
    namespace: ['namespace_definition'],
    module: [],
    import: ['use_declaration'],
    export: [],
  },
  python: {
    class: ['class_definition'],
    interface: [],
    function: ['function_definition'],
    method: ['function_definition'],
    property: ['assignment'],
    variable: ['assignment'],
    constant: ['assignment'],
    enum: [],
    type: [],
    namespace: [],
    module: ['module'],
    import: ['import_statement', 'import_from_statement'],
    export: [],
  },
  go: {
    class: ['type_declaration'],
    interface: ['type_declaration'],
    function: ['function_declaration'],
    method: ['method_declaration'],
    property: ['field_declaration'],
    variable: ['var_declaration', 'short_var_declaration'],
    constant: ['const_declaration'],
    enum: [],
    type: ['type_declaration'],
    namespace: ['package_clause'],
    module: [],
    import: ['import_declaration'],
    export: [],
  },
  rust: {
    class: ['struct_item'],
    interface: ['trait_item'],
    function: ['function_item'],
    method: ['function_item'],
    property: ['field_declaration'],
    variable: ['let_declaration'],
    constant: ['const_item', 'static_item'],
    enum: ['enum_item'],
    type: ['type_item'],
    namespace: ['mod_item'],
    module: ['mod_item'],
    import: ['use_declaration'],
    export: [],
  },
  java: {
    class: ['class_declaration'],
    interface: ['interface_declaration'],
    function: ['method_declaration'],
    method: ['method_declaration'],
    property: ['field_declaration'],
    variable: ['local_variable_declaration'],
    constant: ['field_declaration'],
    enum: ['enum_declaration'],
    type: [],
    namespace: ['package_declaration'],
    module: [],
    import: ['import_declaration'],
    export: [],
  },
  c: {
    class: ['struct_specifier'],
    interface: [],
    function: ['function_definition'],
    method: [],
    property: ['field_declaration'],
    variable: ['declaration'],
    constant: ['preproc_def'],
    enum: ['enum_specifier'],
    type: ['type_definition'],
    namespace: [],
    module: [],
    import: ['preproc_include'],
    export: [],
  },
  cpp: {
    class: ['class_specifier', 'struct_specifier'],
    interface: [],
    function: ['function_definition'],
    method: ['function_definition'],
    property: ['field_declaration'],
    variable: ['declaration'],
    constant: ['preproc_def'],
    enum: ['enum_specifier'],
    type: ['type_definition'],
    namespace: ['namespace_definition'],
    module: [],
    import: ['preproc_include'],
    export: [],
  },
  csharp: {
    class: ['class_declaration'],
    interface: ['interface_declaration'],
    function: ['method_declaration'],
    method: ['method_declaration'],
    property: ['property_declaration'],
    variable: ['variable_declaration'],
    constant: ['field_declaration'],
    enum: ['enum_declaration'],
    type: [],
    namespace: ['namespace_declaration'],
    module: [],
    import: ['using_directive'],
    export: [],
  },
  ruby: {
    class: ['class'],
    interface: [],
    function: ['method'],
    method: ['method', 'singleton_method'],
    property: [],
    variable: ['assignment'],
    constant: ['constant'],
    enum: [],
    type: [],
    namespace: ['module'],
    module: ['module'],
    import: [], // require/require_relative handled by regex fallback
    export: [],
  },
  swift: {
    class: ['class_declaration'],
    interface: ['protocol_declaration'],
    function: ['function_declaration'],
    method: ['function_declaration'],
    property: ['property_declaration'],
    variable: ['property_declaration'],
    constant: ['property_declaration'],
    enum: ['enum_declaration'],
    type: ['typealias_declaration'],
    namespace: [],
    module: [],
    import: ['import_declaration'],
    export: [],
  },
  kotlin: {
    class: ['class_declaration'],
    interface: ['class_declaration'], // interface in Kotlin is a class
    function: ['function_declaration'],
    method: ['function_declaration'],
    property: ['property_declaration'],
    variable: ['property_declaration'],
    constant: ['property_declaration'],
    enum: ['class_declaration'],
    type: ['type_alias'],
    namespace: ['package_header'],
    module: [],
    import: ['import_header'],
    export: [],
  },
  scala: {
    class: ['class_definition'],
    interface: ['trait_definition'],
    function: ['function_definition'],
    method: ['function_definition'],
    property: ['val_definition', 'var_definition'],
    variable: ['var_definition'],
    constant: ['val_definition'],
    enum: ['enum_definition'],
    type: ['type_definition'],
    namespace: ['package_clause'],
    module: ['object_definition'],
    import: ['import_declaration'],
    export: [],
  },
  lua: {
    class: [],
    interface: [],
    function: ['function_declaration', 'local_function'],
    method: ['function_declaration'],
    property: ['field'],
    variable: ['assignment_statement', 'local_variable_declaration'],
    constant: [],
    enum: [],
    type: [],
    namespace: [],
    module: [],
    import: [], // require()
    export: ['return_statement'],
  },
  bash: {
    class: [],
    interface: [],
    function: ['function_definition'],
    method: [],
    property: [],
    variable: ['variable_assignment'],
    constant: [],
    enum: [],
    type: [],
    namespace: [],
    module: [],
    import: [], // source
    export: ['variable_assignment'],
  },
  json: {
    class: [],
    interface: [],
    function: [],
    method: [],
    property: ['pair'],
    variable: [],
    constant: [],
    enum: [],
    type: [],
    namespace: [],
    module: [],
    import: [],
    export: [],
  },
  html: {
    class: [],
    interface: [],
    function: [],
    method: [],
    property: ['attribute'],
    variable: [],
    constant: [],
    enum: [],
    type: [],
    namespace: [],
    module: [],
    import: [],
    export: [],
  },
  css: {
    class: ['class_selector'],
    interface: [],
    function: [],
    method: [],
    property: ['declaration'],
    variable: [],
    constant: [],
    enum: [],
    type: [],
    namespace: [],
    module: [],
    import: ['import_statement'],
    export: [],
  },
};
