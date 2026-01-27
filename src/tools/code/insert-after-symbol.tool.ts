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
 * Insert After Symbol Tool
 *
 * Inserts content after a symbol's definition block in the codebase.
 * Detects the end of the symbol block (closing brace or dedent).
 *
 * @module tools/code/insert-after-symbol
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { executeCommand } from '../../utils/commandExecutor.js';
import { Logger } from '../../utils/logger.js';
import { validatePath, ValidationError, checkRateLimit } from '../../utils/validation.js';
import { readFileLines, writeFileLines } from '../../utils/edit-utils.js';
import {
  parseFile,
  findSymbolBlockEnd as treeSitterFindBlockEnd,
  getLanguageFromFile,
} from '../../tree-sitter/index.js';

/**
 * Language-specific patterns for finding symbol definitions
 */
const DEFINITION_PATTERNS: Record<string, string[]> = {
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

/** Languages that use braces for blocks */
const BRACE_LANGUAGES = ['ts', 'php', 'go', 'rs'];

/** Languages that use indentation for blocks */
const INDENT_LANGUAGES = ['py'];

const schema = z.object({
  symbol: z.string().min(1).describe('Symbol name to find'),
  content: z.string().describe('Content to insert after the symbol block'),
  path: z.string().optional().describe('File or directory to search in'),
  language: z
    .enum(['ts', 'php', 'py', 'go', 'rs', 'auto'])
    .default('auto')
    .describe('Target language'),
  createBackup: z.boolean().default(true).describe('Create backup before editing'),
});

type InsertAfterSymbolArgs = z.infer<typeof schema>;

interface SymbolLocation {
  file: string;
  line: number;
  content: string;
}

/**
 * Find symbol definition using ripgrep
 */
async function findSymbolDefinition(
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

/**
 * Try all languages to find symbol
 */
async function findSymbolAuto(
  symbol: string,
  searchPath: string
): Promise<{ location: SymbolLocation; language: 'ts' | 'php' | 'py' | 'go' | 'rs' } | null> {
  const languages: Array<'ts' | 'php' | 'py' | 'go' | 'rs'> = ['ts', 'php', 'py', 'go', 'rs'];

  for (const lang of languages) {
    const location = await findSymbolDefinition(symbol, lang, searchPath);
    if (location) {
      return { location, language: lang };
    }
  }

  return null;
}

/**
 * Find the end of a brace-delimited block
 */
function findBraceBlockEnd(lines: string[], startLine: number): number {
  let braceCount = 0;
  let foundOpenBrace = false;

  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i];

    for (const char of line) {
      if (char === '{') {
        braceCount++;
        foundOpenBrace = true;
      } else if (char === '}') {
        braceCount--;
        if (foundOpenBrace && braceCount === 0) {
          return i;
        }
      }
    }
  }

  // If no braces found, it might be a single-line definition
  return startLine;
}

/**
 * Find the end of an indentation-based block (Python)
 */
function findIndentBlockEnd(lines: string[], startLine: number): number {
  if (startLine >= lines.length) return startLine;

  // Get the indentation of the definition line
  const defLine = lines[startLine];
  const defIndent = defLine.match(/^(\s*)/)?.[1].length || 0;

  // Find lines that are part of the block (more indented or empty)
  for (let i = startLine + 1; i < lines.length; i++) {
    const line = lines[i];

    // Skip empty lines
    if (line.trim() === '') continue;

    const lineIndent = line.match(/^(\s*)/)?.[1].length || 0;

    // If we find a line with same or less indentation, block ended at previous line
    if (lineIndent <= defIndent) {
      return i - 1;
    }
  }

  // Block extends to end of file
  return lines.length - 1;
}

/**
 * Find the end of a symbol's block (regex-based fallback)
 */
function findSymbolBlockEndRegex(lines: string[], startLine: number, language: string): number {
  // Convert to 0-based index
  const lineIndex = startLine - 1;

  if (BRACE_LANGUAGES.includes(language)) {
    return findBraceBlockEnd(lines, lineIndex);
  } else if (INDENT_LANGUAGES.includes(language)) {
    return findIndentBlockEnd(lines, lineIndex);
  }

  // Default: assume single line
  return lineIndex;
}

/**
 * Find the end of a symbol's block using tree-sitter (with fallback to regex)
 */
async function findSymbolBlockEnd(
  filePath: string,
  symbolName: string,
  startLine: number,
  lines: string[],
  language: string
): Promise<number> {
  // Try tree-sitter first for supported languages
  const tsLanguage = getLanguageFromFile(filePath);

  if (tsLanguage) {
    try {
      const { tree } = await parseFile(filePath);
      const blockEnd = treeSitterFindBlockEnd(tree, tsLanguage, symbolName);

      if (blockEnd !== null) {
        Logger.debug(`insert-after-symbol: tree-sitter found block end at line ${blockEnd + 1}`);
        return blockEnd; // tree-sitter returns 0-indexed
      }
    } catch (error) {
      Logger.debug(`insert-after-symbol: tree-sitter failed, using regex fallback: ${error}`);
    }
  }

  // Fallback to regex-based detection
  return findSymbolBlockEndRegex(lines, startLine, language);
}

export const insertAfterSymbolTool: UnifiedTool = {
  name: 'insert-after-symbol',
  description: 'Insert content after a symbol definition block (after closing brace/dedent)',
  zodSchema: schema,

  execute: async (args): Promise<string> => {
    const {
      symbol,
      content,
      path: inputPath,
      language,
      createBackup,
    } = args as InsertAfterSymbolArgs;

    // Rate limit check
    if (!checkRateLimit('edit-operations', { maxRequests: 50, windowMs: 60000 })) {
      return JSON.stringify({
        success: false,
        error: 'Rate limit exceeded for edit operations',
        code: 'RATE_LIMIT_EXCEEDED',
      });
    }

    const searchPath = inputPath || process.cwd();

    try {
      // Find the symbol
      let location: SymbolLocation | null = null;
      let detectedLanguage: 'ts' | 'php' | 'py' | 'go' | 'rs' | 'auto' = language;

      if (language === 'auto') {
        const result = await findSymbolAuto(symbol, searchPath);
        if (result) {
          location = result.location;
          detectedLanguage = result.language;
        }
      } else {
        location = await findSymbolDefinition(symbol, language, searchPath);
      }

      if (!location) {
        return JSON.stringify({
          success: false,
          error: `Symbol '${symbol}' not found`,
          code: 'SYMBOL_NOT_FOUND',
          searchPath,
          language: detectedLanguage,
        });
      }

      // Validate the file path for writing
      let validatedPath: string;
      try {
        validatedPath = await validatePath(location.file, {
          allowSymlinks: false,
          requireWithinProject: false,
          operation: 'write',
        });
      } catch (validationError) {
        if (validationError instanceof ValidationError) {
          return JSON.stringify({
            success: false,
            error: validationError.message,
            code: validationError.code,
            file: location.file,
          });
        }
        throw validationError;
      }

      // Read file
      const lines = await readFileLines(validatedPath);

      // Find end of symbol block using tree-sitter (with regex fallback)
      const effectiveLanguage = detectedLanguage === 'auto' ? 'ts' : detectedLanguage;
      const blockEndLine = await findSymbolBlockEnd(
        validatedPath,
        symbol,
        location.line,
        lines,
        effectiveLanguage
      );
      const insertLine = blockEndLine + 1; // Insert after the block

      // Split content into lines and insert
      const contentLines = content.split('\n');
      lines.splice(insertLine, 0, ...contentLines);

      // Write back
      const backupPath = await writeFileLines(validatedPath, lines, createBackup);

      Logger.debug(
        `insert-after-symbol: inserted ${contentLines.length} lines after '${symbol}' block at ${validatedPath}:${insertLine + 1}`
      );

      return JSON.stringify({
        success: true,
        file: validatedPath,
        symbol,
        symbolStartLine: location.line,
        symbolEndLine: blockEndLine + 1,
        insertedAt: insertLine + 1,
        linesInserted: contentLines.length,
        newTotalLines: lines.length,
        backup: backupPath,
        language: detectedLanguage,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      Logger.error(`insert-after-symbol error: ${errorMessage}`);

      return JSON.stringify({
        success: false,
        error: errorMessage,
      });
    }
  },
};
