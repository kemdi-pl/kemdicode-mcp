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
 * Check Types Tool
 *
 * Runs TypeScript type checking (tsc --noEmit) or PHPStan
 * and parses/formats the errors.
 *
 * @module tools/project/check-types
 */

import { z } from 'zod';
import { existsSync } from 'fs';
import { join } from 'path';
import { UnifiedTool } from '../registry.js';
import {
  spawnProcess,
  getCwd,
  validateCwd,
  SHORT_TIMEOUT,
  ProgressCallback,
} from '../../utils/process-utils.js';

/**
 * Type checker configuration
 */
interface TypeChecker {
  name: string;
  configFile: string;
  command: string;
  args: string[];
  parseErrors: (output: string) => ParsedError[];
}

/**
 * Parsed error structure
 */
interface ParsedError {
  file: string;
  line: number;
  column?: number;
  message: string;
  code?: string;
  severity: 'error' | 'warning';
}

const schema = z.object({
  cwd: z.string().optional().describe('Working directory'),
  checker: z
    .enum(['auto', 'typescript', 'phpstan'])
    .default('auto')
    .describe('Type checker'),
  timeout: z.number().default(120000).describe('Timeout ms'),
  strict: z.boolean().default(false).describe('Enable strict mode'),
});

/**
 * Parse TypeScript errors
 */
function parseTypeScriptErrors(output: string): ParsedError[] {
  const errors: ParsedError[] = [];
  // Match: path/file.ts(line,col): error TS1234: message
  // Or: path/file.ts:line:col - error TS1234: message
  const patterns = [
    /^(.+?)\((\d+),(\d+)\):\s*(error|warning)\s+(TS\d+):\s*(.+)$/gm,
    /^(.+?):(\d+):(\d+)\s*-\s*(error|warning)\s+(TS\d+):\s*(.+)$/gm,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(output)) !== null) {
      errors.push({
        file: match[1],
        line: parseInt(match[2], 10),
        column: parseInt(match[3], 10),
        severity: match[4] as 'error' | 'warning',
        code: match[5],
        message: match[6],
      });
    }
  }

  return errors;
}

/**
 * Parse PHPStan errors (JSON output)
 */
function parsePHPStanErrors(output: string): ParsedError[] {
  const errors: ParsedError[] = [];

  try {
    // Try to extract JSON from output
    const jsonMatch = output.match(/\{[\s\S]*"totals"[\s\S]*\}/);
    if (jsonMatch) {
      const data = JSON.parse(jsonMatch[0]);

      if (data.files) {
        for (const [file, fileData] of Object.entries(data.files)) {
          const messages = (
            fileData as { messages?: Array<{ line: number; message: string; ignorable?: boolean }> }
          ).messages;
          if (messages) {
            for (const msg of messages) {
              errors.push({
                file,
                line: msg.line || 0,
                message: msg.message,
                severity: msg.ignorable ? 'warning' : 'error',
              });
            }
          }
        }
      }
    }
  } catch {
    // Fallback: parse text output
    const pattern = /^(.+?):(\d+):\s*(.+)$/gm;
    let match;
    while ((match = pattern.exec(output)) !== null) {
      errors.push({
        file: match[1],
        line: parseInt(match[2], 10),
        message: match[3],
        severity: 'error',
      });
    }
  }

  return errors;
}

const TYPE_CHECKERS: TypeChecker[] = [
  {
    name: 'typescript',
    configFile: 'tsconfig.json',
    command: 'npx',
    args: ['tsc', '--noEmit', '--pretty', 'false'],
    parseErrors: parseTypeScriptErrors,
  },
  {
    name: 'phpstan',
    configFile: 'phpstan.neon',
    command: 'vendor/bin/phpstan',
    args: ['analyse', '--error-format=json', '--no-progress'],
    parseErrors: parsePHPStanErrors,
  },
];

/**
 * Detect type checker for the project
 */
function detectTypeChecker(cwd: string): TypeChecker | null {
  for (const tc of TYPE_CHECKERS) {
    const configPath = join(cwd, tc.configFile);
    if (existsSync(configPath)) {
      return tc;
    }
  }

  // Fallback for TypeScript
  if (existsSync(join(cwd, 'package.json'))) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pkg = require(join(cwd, 'package.json'));
      if (pkg.devDependencies?.typescript || pkg.dependencies?.typescript) {
        return TYPE_CHECKERS.find((tc) => tc.name === 'typescript') || null;
      }
    } catch {
      // Ignore
    }
  }

  // Fallback for PHPStan (check composer.json)
  if (existsSync(join(cwd, 'composer.json'))) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const composer = require(join(cwd, 'composer.json'));
      if (composer['require-dev']?.['phpstan/phpstan']) {
        return TYPE_CHECKERS.find((tc) => tc.name === 'phpstan') || null;
      }
    } catch {
      // Ignore
    }
  }

  return null;
}

/**
 * Get type checker by name
 */
function getTypeChecker(name: string): TypeChecker | null {
  return TYPE_CHECKERS.find((tc) => tc.name === name) || null;
}

/**
 * Execute type checker and parse results using shared process utilities
 */
async function executeTypeChecker(
  tc: TypeChecker,
  cwd: string,
  strict: boolean,
  timeout: number,
  onProgress?: ProgressCallback
): Promise<{ output: string; errors: ParsedError[] }> {
  const args = [...tc.args];

  // Add strict mode for TypeScript
  if (strict && tc.name === 'typescript') {
    args.push('--strict');
  }
  // Add higher level for PHPStan
  if (strict && tc.name === 'phpstan') {
    args.push('--level=max');
  }

  const result = await spawnProcess(tc.command, args, {
    cwd,
    timeout,
    onProgress,
  });

  const combined = result.stdout + result.stderr;
  const errors = tc.parseErrors(combined);

  let output = combined;
  if (result.timedOut) {
    output += `\n\n[TIMEOUT: Type checking exceeded ${timeout / 1000}s limit]`;
  }

  return { output, errors };
}

/**
 * Format errors for display
 */
function formatErrors(errors: ParsedError[], checkerName: string): string {
  if (errors.length === 0) {
    return `No type errors found by ${checkerName}`;
  }

  const lines: string[] = [];
  lines.push(`# Type Check Results (${checkerName})`);
  lines.push(`Found ${errors.length} issue(s)\n`);

  // Group by file
  const byFile = new Map<string, ParsedError[]>();
  for (const err of errors) {
    const existing = byFile.get(err.file) || [];
    existing.push(err);
    byFile.set(err.file, existing);
  }

  for (const [file, fileErrors] of byFile) {
    lines.push(`## ${file}`);
    for (const err of fileErrors) {
      const location = err.column ? `${err.line}:${err.column}` : `${err.line}`;
      const code = err.code ? ` [${err.code}]` : '';
      const severity = err.severity === 'warning' ? '[WARN]' : '[ERR]';
      lines.push(`  ${severity} Line ${location}${code}: ${err.message}`);
    }
    lines.push('');
  }

  // Summary
  const errorCount = errors.filter((e) => e.severity === 'error').length;
  const warnCount = errors.filter((e) => e.severity === 'warning').length;
  lines.push(`---\nSummary: ${errorCount} error(s), ${warnCount} warning(s)`);

  return lines.join('\n');
}

export const checkTypesTool: UnifiedTool = {
  name: 'check-types',
  description: 'Run TypeScript/PHPStan type checking',
  zodSchema: schema,
  execute: async (args, onProgress) => {
    const cwd = getCwd(args.cwd as string | undefined);
    const checkerChoice = (args.checker as string) || 'auto';
    const timeout = (args.timeout as number) || SHORT_TIMEOUT;
    const strict = Boolean(args.strict);

    validateCwd(cwd, existsSync);

    let tc: TypeChecker | null;

    if (checkerChoice === 'auto') {
      tc = detectTypeChecker(cwd);
      if (!tc) {
        return `No type checker detected in ${cwd}\nSearched for: tsconfig.json (TypeScript), phpstan.neon (PHPStan)`;
      }
    } else {
      tc = getTypeChecker(checkerChoice);
      if (!tc) {
        throw new Error(`Unknown type checker: ${checkerChoice}`);
      }
    }

    onProgress?.(`Running ${tc.name} type checker${strict ? ' (strict mode)' : ''}...\n\n`);

    const { errors } = await executeTypeChecker(tc, cwd, strict, timeout, onProgress);

    return formatErrors(errors, tc.name);
  },
};
