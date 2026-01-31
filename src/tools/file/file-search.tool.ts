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
 * File Search Tool
 *
 * Fast file content search using ripgrep with support for regex patterns,
 * file type filters, context lines, and security validation.
 *
 * @module tools/file/file-search
 */

import { z } from 'zod';
import { spawn } from 'child_process';
import { UnifiedTool } from '../registry.js';
import { Logger } from '../../utils/logger.js';
import {
  validatePath,
  validateRegexPattern,
  ValidationError,
  ValidationErrorCode,
  checkRateLimit,
  quickPathCheck,
} from '../../utils/validation.js';

/** Maximum number of matches to return */
const MAX_MATCHES = 500;

/** Default timeout for search (30 seconds) */
const SEARCH_TIMEOUT = 30_000;

const schema = z.object({
  pattern: z.string().min(1).describe('Search pattern (regex supported)'),
  path: z.string().default('.').describe('Search path'),
  type: z.string().optional().describe('File type filter'),
  glob: z
    .string()
    .optional()
    .describe('Glob pattern to filter files'),
  ignoreCase: z.boolean().default(false).describe('Case-insensitive'),
  wholeWord: z.boolean().default(false).describe('Whole words only'),
  contextBefore: z
    .number()
    .int()
    .min(0)
    .max(10)
    .default(0)
    .describe('Context lines before'),
  contextAfter: z
    .number()
    .int()
    .min(0)
    .max(10)
    .default(0)
    .describe('Context lines after'),
  context: z
    .number()
    .int()
    .min(0)
    .max(10)
    .optional()
    .describe('Context lines before and after'),
  maxMatches: z
    .number()
    .int()
    .positive()
    .default(MAX_MATCHES)
    .describe('Max matches'),
  hidden: z.boolean().default(false).describe('Search hidden files'),
  followSymlinks: z.boolean().default(false).describe('Follow symlinks'),
  fixedStrings: z.boolean().default(false).describe('Literal string, not regex'),
  invertMatch: z.boolean().default(false).describe('Show non-matching lines'),
  filesWithMatches: z.boolean().default(false).describe('Show only file names'),
  count: z.boolean().default(false).describe('Show match count per file'),
});

type FileSearchArgs = z.infer<typeof schema>;

interface SearchMatch {
  file: string;
  line: number;
  column?: number;
  content: string;
  contextBefore?: string[];
  contextAfter?: string[];
}

interface SearchResult {
  success: boolean;
  matches?: SearchMatch[];
  files?: string[];
  counts?: Record<string, number>;
  totalMatches?: number;
  truncated?: boolean;
  searchTime?: number;
  error?: string;
  command?: string;
}

/**
 * Build ripgrep command arguments
 */
function buildRipgrepArgs(args: FileSearchArgs): string[] {
  const rgArgs: string[] = [
    '--json', // JSON output for parsing
    '--no-heading', // Don't group by file
    '--line-number', // Show line numbers
    '--column', // Show column numbers
  ];

  if (args.ignoreCase) {
    rgArgs.push('--ignore-case');
  }

  if (args.wholeWord) {
    rgArgs.push('--word-regexp');
  }

  if (args.fixedStrings) {
    rgArgs.push('--fixed-strings');
  }

  if (args.invertMatch) {
    rgArgs.push('--invert-match');
  }

  if (args.filesWithMatches) {
    rgArgs.push('--files-with-matches');
  }

  if (args.count) {
    rgArgs.push('--count');
  }

  if (args.hidden) {
    rgArgs.push('--hidden');
  }

  if (args.followSymlinks) {
    rgArgs.push('--follow');
  }

  // Context lines
  if (args.context !== undefined) {
    rgArgs.push('-C', String(args.context));
  } else {
    if (args.contextBefore > 0) {
      rgArgs.push('-B', String(args.contextBefore));
    }
    if (args.contextAfter > 0) {
      rgArgs.push('-A', String(args.contextAfter));
    }
  }

  // File type filter
  if (args.type) {
    rgArgs.push('--type', args.type);
  }

  // Glob pattern
  if (args.glob) {
    rgArgs.push('--glob', args.glob);
  }

  // Max count
  rgArgs.push('--max-count', String(args.maxMatches));

  // Pattern and path
  rgArgs.push(args.pattern);
  rgArgs.push(args.path);

  return rgArgs;
}

/**
 * Parse ripgrep JSON output
 */
function parseRipgrepOutput(stdout: string): SearchMatch[] {
  const matches: SearchMatch[] = [];

  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;

    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;

      if (parsed.type === 'match') {
        const data = parsed.data as {
          path: { text: string };
          line_number: number;
          submatches: Array<{ start: number }>;
          lines: { text: string };
        };

        matches.push({
          file: data.path.text,
          line: data.line_number,
          column: data.submatches?.[0]?.start,
          content: data.lines.text.replace(/\n$/, ''),
        });
      }
    } catch {
      // Skip non-JSON lines (context lines in some cases)
    }
  }

  return matches;
}

/**
 * Parse simple ripgrep output (for files-with-matches or count mode)
 */
function parseSimpleOutput(
  stdout: string,
  isCount: boolean
): { files?: string[]; counts?: Record<string, number> } {
  if (isCount) {
    const counts: Record<string, number> = {};
    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue;
      const [file, count] = line.split(':');
      if (file && count) {
        counts[file] = parseInt(count, 10);
      }
    }
    return { counts };
  }

  return {
    files: stdout.split('\n').filter((f) => f.trim()),
  };
}

/**
 * Log security-relevant events
 */
function logSecurityEvent(eventType: string, details: Record<string, unknown>): void {
  Logger.warn(`SECURITY [file-search]: ${eventType}`, details);
}

export const fileSearchTool: UnifiedTool = {
  name: 'file-search',
  description: 'Ripgrep file search with regex, type filters, and context',
  zodSchema: schema,
  skipContextShare: true, // Search results may be large
  metadata: {
    category: 'file',
    tags: ['search', 'grep', 'ripgrep'],
    examples: [
      { args: { pattern: 'TODO', path: 'src/' }, description: 'Search for TODO comments in src directory' },
      { args: { pattern: 'export function', type: 'ts', filesWithMatches: true }, description: 'List TypeScript files with exported functions' },
    ],
    relatedTools: ['file-read', 'semantic-search', 'find-references'],
  },

  execute: async (args): Promise<string> => {
    const searchArgs = args as FileSearchArgs;
    const startTime = Date.now();
    const result: SearchResult = { success: false };

    // Rate limit check
    if (!checkRateLimit('file-search', { maxRequests: 100, windowMs: 60000 })) {
      logSecurityEvent('RATE_LIMIT_EXCEEDED', { pattern: searchArgs.pattern.substring(0, 50) });
      return JSON.stringify({
        success: false,
        error: 'Rate limit exceeded for file-search operations',
        code: 'RATE_LIMIT_EXCEEDED',
      });
    }

    // Validate the search pattern (for regex safety)
    if (!searchArgs.fixedStrings) {
      try {
        validateRegexPattern(searchArgs.pattern, {
          maxLength: 500,
          maxQuantifiers: 8,
          maxNestingDepth: 4,
          testTimeout: 500,
        });
      } catch (validationError) {
        if (validationError instanceof ValidationError) {
          logSecurityEvent('INVALID_REGEX_PATTERN', {
            pattern: searchArgs.pattern.substring(0, 100),
            error: validationError.message,
          });
          return JSON.stringify({
            success: false,
            error: validationError.message,
            code: validationError.code,
            suggestion: 'Use fixedStrings: true for literal string search',
          });
        }
        throw validationError;
      }
    }

    // Quick path check for obvious issues
    if (!quickPathCheck(searchArgs.path)) {
      logSecurityEvent('INVALID_SEARCH_PATH', { path: searchArgs.path });
      return JSON.stringify({
        success: false,
        error: 'Invalid or blocked search path',
        code: ValidationErrorCode.INVALID_PATH,
        path: searchArgs.path,
      });
    }

    // Validate the search path
    // Note: requireWithinProject is false for search to allow searching external codebases
    let validatedPath: string;
    try {
      validatedPath = await validatePath(searchArgs.path, {
        allowSymlinks: true, // ripgrep handles symlinks with --follow
        requireWithinProject: false, // Allow searching any accessible directory
        allowReadFromBlocked: true, // Allow reading from more places for search
        operation: 'search',
        projectRoot: (args as Record<string, unknown>)._sessionCwd as string | undefined,
      });
    } catch (validationError) {
      if (validationError instanceof ValidationError) {
        logSecurityEvent('PATH_VALIDATION_FAILED', {
          path: searchArgs.path,
          error: validationError.message,
        });
        return JSON.stringify({
          success: false,
          error: validationError.message,
          code: validationError.code,
          path: searchArgs.path,
        });
      }
      throw validationError;
    }

    // Update searchArgs with validated path
    const validatedSearchArgs = { ...searchArgs, path: validatedPath };

    // Build ripgrep command
    const rgArgs = buildRipgrepArgs(validatedSearchArgs);
    result.command = `rg ${rgArgs.join(' ')}`;

    return new Promise((resolve) => {
      const proc = spawn('rg', rgArgs, {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: SEARCH_TIMEOUT,
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('error', (error) => {
        Logger.error(`file-search spawn error: ${error.message}`);

        // Check if ripgrep is not installed
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          result.error =
            'ripgrep (rg) is not installed. Please install it: https://github.com/BurntSushi/ripgrep#installation';
        } else {
          result.error = error.message;
        }

        resolve(JSON.stringify(result));
      });

      proc.on('close', (code) => {
        result.searchTime = Date.now() - startTime;

        // Exit code 0 = matches found, 1 = no matches, 2 = error
        if (code === 2) {
          result.error = stderr.trim() || 'Search failed';
          resolve(JSON.stringify(result));
          return;
        }

        result.success = true;

        if (searchArgs.filesWithMatches || searchArgs.count) {
          // Parse simple output
          const parsed = parseSimpleOutput(stdout, searchArgs.count);
          if (searchArgs.count) {
            result.counts = parsed.counts;
            result.totalMatches = Object.values(parsed.counts || {}).reduce((a, b) => a + b, 0);
          } else {
            result.files = parsed.files;
            result.totalMatches = parsed.files?.length || 0;
          }
        } else {
          // Parse JSON output
          const matches = parseRipgrepOutput(stdout);
          result.matches = matches;
          result.totalMatches = matches.length;
          result.truncated = matches.length >= searchArgs.maxMatches;
        }

        if (result.totalMatches === 0) {
          result.success = true;
          result.matches = [];
        }

        resolve(JSON.stringify(result));
      });
    });
  },
};
