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
 * File Diff Tool
 *
 * Compare two files and output differences in git diff or unified format.
 *
 * @module tools/file/file-diff
 */

import { z } from 'zod';
import { promises as fs } from 'fs';
import { spawn } from 'child_process';
import { UnifiedTool } from '../registry.js';
import { Logger } from '../../utils/logger.js';

/** Default timeout for diff (30 seconds) */
const DIFF_TIMEOUT = 30_000;

/** Maximum file size to diff (10MB) */
const MAX_DIFF_SIZE = 10 * 1024 * 1024;

const schema = z.object({
  file1: z.string().min(1).describe('First file path (original)'),
  file2: z.string().min(1).describe('Second file path (modified)'),
  format: z
    .enum(['unified', 'git', 'side-by-side', 'context'])
    .default('unified')
    .describe('Output format'),
  contextLines: z.number().int().min(0).max(20).default(3).describe('Number of context lines'),
  ignoreWhitespace: z.boolean().default(false).describe('Ignore whitespace changes'),
  ignoreCase: z.boolean().default(false).describe('Case-insensitive comparison'),
  ignoreBlankLines: z.boolean().default(false).describe('Ignore blank line differences'),
  showLineNumbers: z.boolean().default(true).describe('Show line numbers'),
  colorize: z.boolean().default(false).describe('Include ANSI color codes'),
});

type FileDiffArgs = z.infer<typeof schema>;

interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: Array<{
    type: 'context' | 'addition' | 'deletion';
    content: string;
    oldLine?: number;
    newLine?: number;
  }>;
}

interface DiffResult {
  success: boolean;
  file1: string;
  file2: string;
  identical?: boolean;
  hunks?: DiffHunk[];
  rawDiff?: string;
  stats?: {
    additions: number;
    deletions: number;
    changes: number;
  };
  error?: string;
}

/**
 * Check if a file exists and is readable
 */
async function validateFile(
  path: string
): Promise<{ valid: boolean; error?: string; size?: number }> {
  try {
    const stats = await fs.stat(path);
    if (!stats.isFile()) {
      return { valid: false, error: `Not a file: ${path}` };
    }
    if (stats.size > MAX_DIFF_SIZE) {
      return { valid: false, error: `File too large: ${stats.size} bytes (max: ${MAX_DIFF_SIZE})` };
    }
    return { valid: true, size: stats.size };
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === 'ENOENT') {
      return { valid: false, error: `File not found: ${path}` };
    }
    if (nodeError.code === 'EACCES') {
      return { valid: false, error: `Permission denied: ${path}` };
    }
    return { valid: false, error: (error as Error).message };
  }
}

/**
 * Build diff command arguments
 */
function buildDiffArgs(args: FileDiffArgs): string[] {
  const diffArgs: string[] = [];

  switch (args.format) {
    case 'git':
      diffArgs.push('--git');
      break;
    case 'side-by-side':
      diffArgs.push('--side-by-side', '--width=160');
      break;
    case 'context':
      diffArgs.push('-c');
      break;
    case 'unified':
    default:
      diffArgs.push('-u');
      break;
  }

  // Context lines
  if (args.format === 'unified' || args.format === 'git') {
    diffArgs.push(`-U${args.contextLines}`);
  } else if (args.format === 'context') {
    diffArgs.push(`-C${args.contextLines}`);
  }

  if (args.ignoreWhitespace) {
    diffArgs.push('-w');
  }

  if (args.ignoreCase) {
    diffArgs.push('-i');
  }

  if (args.ignoreBlankLines) {
    diffArgs.push('-B');
  }

  if (args.showLineNumbers && args.format !== 'side-by-side') {
    diffArgs.push('-n');
  }

  if (args.colorize) {
    diffArgs.push('--color=always');
  }

  diffArgs.push(args.file1, args.file2);

  return diffArgs;
}

/**
 * Parse unified diff output into structured hunks
 */
function parseUnifiedDiff(diffOutput: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  const lines = diffOutput.split('\n');
  let currentHunk: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const line of lines) {
    // Skip header lines
    if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('diff')) {
      continue;
    }

    // Parse hunk header: @@ -start,count +start,count @@
    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunkMatch) {
      if (currentHunk) {
        hunks.push(currentHunk);
      }
      oldLine = parseInt(hunkMatch[1], 10);
      newLine = parseInt(hunkMatch[3], 10);
      currentHunk = {
        oldStart: oldLine,
        oldCount: parseInt(hunkMatch[2] || '1', 10),
        newStart: newLine,
        newCount: parseInt(hunkMatch[4] || '1', 10),
        lines: [],
      };
      continue;
    }

    if (!currentHunk) continue;

    if (line.startsWith('-')) {
      currentHunk.lines.push({
        type: 'deletion',
        content: line.slice(1),
        oldLine: oldLine++,
      });
    } else if (line.startsWith('+')) {
      currentHunk.lines.push({
        type: 'addition',
        content: line.slice(1),
        newLine: newLine++,
      });
    } else if (line.startsWith(' ') || line === '') {
      currentHunk.lines.push({
        type: 'context',
        content: line.slice(1) || '',
        oldLine: oldLine++,
        newLine: newLine++,
      });
    }
  }

  if (currentHunk) {
    hunks.push(currentHunk);
  }

  return hunks;
}

/**
 * Calculate diff statistics
 */
function calculateStats(hunks: DiffHunk[]): {
  additions: number;
  deletions: number;
  changes: number;
} {
  let additions = 0;
  let deletions = 0;

  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.type === 'addition') additions++;
      if (line.type === 'deletion') deletions++;
    }
  }

  return {
    additions,
    deletions,
    changes: additions + deletions,
  };
}

/**
 * Execute diff using git diff or system diff
 */
async function executeDiff(args: FileDiffArgs): Promise<{ stdout: string; identical: boolean }> {
  return new Promise((resolve, reject) => {
    // Try git diff first (better output), fall back to diff
    const diffArgs = buildDiffArgs(args);

    // Use git diff --no-index for non-git files
    const useGit = args.format === 'git';
    const command = useGit ? 'git' : 'diff';
    const commandArgs = useGit ? ['diff', '--no-index', ...diffArgs.slice(1)] : diffArgs;

    const proc = spawn(command, commandArgs, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: DIFF_TIMEOUT,
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
      // If git fails, try regular diff
      if (useGit && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        const fallbackArgs = buildDiffArgs({ ...args, format: 'unified' });
        const fallbackProc = spawn('diff', fallbackArgs, {
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: DIFF_TIMEOUT,
        });

        let fallbackStdout = '';

        fallbackProc.stdout.on('data', (data) => {
          fallbackStdout += data.toString();
        });

        fallbackProc.on('close', (code) => {
          // diff exit codes: 0 = identical, 1 = different, 2 = error
          if (code === 0) {
            resolve({ stdout: '', identical: true });
          } else if (code === 1) {
            resolve({ stdout: fallbackStdout, identical: false });
          } else {
            reject(new Error(`diff failed with exit code ${code}`));
          }
        });

        fallbackProc.on('error', (fallbackError) => {
          reject(new Error(`diff not available: ${fallbackError.message}`));
        });

        return;
      }

      reject(error);
    });

    proc.on('close', (code) => {
      // git diff exit codes: 0 = identical, 1 = different, other = error
      if (code === 0) {
        resolve({ stdout: '', identical: true });
      } else if (code === 1) {
        resolve({ stdout, identical: false });
      } else {
        // Check stderr for actual errors
        if (stderr.includes('fatal:') || stderr.includes('error:')) {
          reject(new Error(stderr.trim()));
        } else {
          resolve({ stdout, identical: false });
        }
      }
    });
  });
}

export const fileDiffTool: UnifiedTool = {
  name: 'file-diff',
  description: 'Compare two files with git diff or unified format output',
  zodSchema: schema,

  execute: async (args): Promise<string> => {
    const diffArgs = args as FileDiffArgs;
    const result: DiffResult = {
      success: false,
      file1: diffArgs.file1,
      file2: diffArgs.file2,
    };

    try {
      // Validate both files
      const [validation1, validation2] = await Promise.all([
        validateFile(diffArgs.file1),
        validateFile(diffArgs.file2),
      ]);

      if (!validation1.valid) {
        result.error = validation1.error;
        return JSON.stringify(result);
      }

      if (!validation2.valid) {
        result.error = validation2.error;
        return JSON.stringify(result);
      }

      // Execute diff
      const { stdout, identical } = await executeDiff(diffArgs);

      result.success = true;
      result.identical = identical;

      if (identical) {
        result.stats = { additions: 0, deletions: 0, changes: 0 };
        return JSON.stringify(result);
      }

      result.rawDiff = stdout;

      // Parse hunks for structured output
      if (diffArgs.format === 'unified' || diffArgs.format === 'git') {
        result.hunks = parseUnifiedDiff(stdout);
        result.stats = calculateStats(result.hunks);
      }

      return JSON.stringify(result);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      Logger.error(`file-diff error: ${errorMessage}`);
      result.error = errorMessage;
      return JSON.stringify(result);
    }
  },
};
