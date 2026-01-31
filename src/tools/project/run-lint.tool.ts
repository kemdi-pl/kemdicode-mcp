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
 * Run Lint Tool
 *
 * Executes ESLint, PHP_CodeSniffer, or PHPStan
 * and formats the output nicely.
 *
 * @module tools/project/run-lint
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
 * Linter configuration
 */
interface Linter {
  name: string;
  configFiles: string[];
  command: string;
  args: string[];
  fixArgs?: string[];
  formatOutput: (output: string) => string;
}

const schema = z.object({
  cwd: z.string().optional().describe('Working directory'),
  linter: z
    .enum(['auto', 'eslint', 'phpcs', 'phpstan', 'prettier'])
    .default('auto')
    .describe('Linter to use'),
  fix: z.boolean().default(false).describe('Auto-fix issues'),
  files: z.string().optional().describe('Files/directories to lint'),
  timeout: z.number().default(120000).describe('Timeout ms'),
});

/**
 * Format ESLint output
 */
function formatESLintOutput(output: string): string {
  // ESLint already has good formatting, just clean it up
  const lines = output.split('\n');
  const result: string[] = [];
  let errorCount = 0;
  let warningCount = 0;

  for (const line of lines) {
    if (line.includes('error')) errorCount++;
    if (line.includes('warning')) warningCount++;
    result.push(line);
  }

  if (errorCount === 0 && warningCount === 0 && !output.includes('problem')) {
    return 'No linting issues found';
  }

  return result.join('\n');
}

/**
 * Format PHPCS output
 */
function formatPHPCSOutput(output: string): string {
  // Parse PHPCS output
  const lines: string[] = [];
  let currentFile = '';
  let errorCount = 0;
  let warningCount = 0;

  for (const line of output.split('\n')) {
    // File header
    if (line.startsWith('FILE:')) {
      currentFile = line.replace('FILE:', '').trim();
      lines.push(`\n## ${currentFile}`);
      continue;
    }

    // Error/warning line
    const match = line.match(/^\s*(\d+)\s*\|\s*(ERROR|WARNING)\s*\|\s*(.+)$/);
    if (match) {
      const [, lineNum, severity, message] = match;
      if (severity === 'ERROR') errorCount++;
      if (severity === 'WARNING') warningCount++;
      lines.push(`  Line ${lineNum}: [${severity}] ${message}`);
    }
  }

  if (errorCount === 0 && warningCount === 0) {
    return 'No PHPCS issues found';
  }

  lines.push(`\n---\nSummary: ${errorCount} error(s), ${warningCount} warning(s)`);
  return lines.join('\n');
}

/**
 * Format PHPStan output
 */
function formatPHPStanOutput(output: string): string {
  const lines: string[] = [];
  let errorCount = 0;

  // Try to parse JSON output first
  try {
    const jsonMatch = output.match(/\{[\s\S]*"totals"[\s\S]*\}/);
    if (jsonMatch) {
      const data = JSON.parse(jsonMatch[0]);
      if (data.totals) {
        errorCount = data.totals.errors || 0;
      }
      if (data.files) {
        for (const [file, fileData] of Object.entries(data.files)) {
          const messages = (fileData as { messages?: Array<{ line: number; message: string }> })
            .messages;
          if (messages && messages.length > 0) {
            lines.push(`\n## ${file}`);
            for (const msg of messages) {
              lines.push(`  Line ${msg.line}: ${msg.message}`);
            }
          }
        }
      }
    }
  } catch {
    // Fallback: return raw output
    return output;
  }

  if (errorCount === 0 && lines.length === 0) {
    return 'No PHPStan issues found';
  }

  lines.unshift(`# PHPStan Analysis\nFound ${errorCount} issue(s)`);
  return lines.join('\n');
}

/**
 * Format Prettier output
 */
function formatPrettierOutput(output: string): string {
  if (!output.trim() || output.includes('All matched files use Prettier code style')) {
    return 'No formatting issues found';
  }

  const filesWithIssues = output
    .split('\n')
    .filter((line) => line.trim() && !line.startsWith('Checking'))
    .filter((line) => line.match(/\.\w+$/));

  if (filesWithIssues.length === 0) {
    return 'No formatting issues found';
  }

  return `# Prettier Check\nFiles needing formatting:\n${filesWithIssues.map((f) => `- ${f}`).join('\n')}`;
}

const LINTERS: Linter[] = [
  {
    name: 'eslint',
    configFiles: [
      '.eslintrc',
      '.eslintrc.js',
      '.eslintrc.json',
      '.eslintrc.yml',
      'eslint.config.js',
      'eslint.config.mjs',
    ],
    command: 'npx',
    args: ['eslint', '.', '--ext', '.js,.jsx,.ts,.tsx', '--format', 'stylish'],
    fixArgs: ['eslint', '.', '--ext', '.js,.jsx,.ts,.tsx', '--fix'],
    formatOutput: formatESLintOutput,
  },
  {
    name: 'phpcs',
    configFiles: ['phpcs.xml', 'phpcs.xml.dist', '.phpcs.xml'],
    command: 'vendor/bin/phpcs',
    args: ['--standard=PSR12'],
    fixArgs: undefined, // Use phpcbf instead
    formatOutput: formatPHPCSOutput,
  },
  {
    name: 'phpstan',
    configFiles: ['phpstan.neon', 'phpstan.neon.dist'],
    command: 'vendor/bin/phpstan',
    args: ['analyse', '--error-format=json', '--no-progress'],
    formatOutput: formatPHPStanOutput,
  },
  {
    name: 'prettier',
    configFiles: ['.prettierrc', '.prettierrc.js', '.prettierrc.json', 'prettier.config.js'],
    command: 'npx',
    args: ['prettier', '--check', '.'],
    fixArgs: ['prettier', '--write', '.'],
    formatOutput: formatPrettierOutput,
  },
];

/**
 * Detect linter for the project
 */
function detectLinter(cwd: string): Linter | null {
  for (const linter of LINTERS) {
    for (const configFile of linter.configFiles) {
      if (existsSync(join(cwd, configFile))) {
        return linter;
      }
    }
  }

  // Fallback: check package.json for eslint
  if (existsSync(join(cwd, 'package.json'))) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pkg = require(join(cwd, 'package.json'));
      if (pkg.devDependencies?.eslint || pkg.dependencies?.eslint) {
        return LINTERS.find((l) => l.name === 'eslint') || null;
      }
      if (pkg.devDependencies?.prettier || pkg.dependencies?.prettier) {
        return LINTERS.find((l) => l.name === 'prettier') || null;
      }
    } catch {
      // Ignore
    }
  }

  return null;
}

/**
 * Get linter by name
 */
function getLinter(name: string): Linter | null {
  return LINTERS.find((l) => l.name === name) || null;
}

/**
 * Execute linter using shared process utilities
 */
async function executeLinter(
  linter: Linter,
  cwd: string,
  fix: boolean,
  files: string | undefined,
  timeout: number,
  onProgress?: ProgressCallback
): Promise<string> {
  let args = fix && linter.fixArgs ? [...linter.fixArgs] : [...linter.args];

  // Add specific files if provided
  if (files) {
    args = args.filter((a) => a !== '.');
    args.push(...files.split(' ').filter(Boolean));
  }

  onProgress?.(`Running ${linter.name}${fix ? ' --fix' : ''}...\n`);

  const result = await spawnProcess(linter.command, args, {
    cwd,
    timeout,
    onProgress,
    forceColor: false, // Disable colors for parsing
  });

  // Linters often exit with code 1 when issues are found
  const combined = result.stdout + result.stderr;
  const formatted = linter.formatOutput(combined);

  if (result.timedOut) {
    return formatted + `\n\n[TIMEOUT: Linting exceeded ${timeout / 1000}s limit]`;
  }

  if (fix) {
    return formatted + '\n\n[Auto-fix applied]';
  }

  return formatted;
}

export const runLintTool: UnifiedTool = {
  name: 'run-lint',
  description: 'Run ESLint/PHPCS/PHPStan/Prettier with formatted output',
  zodSchema: schema,
  metadata: {
    category: 'project',
    tags: ['lint', 'eslint', 'quality'],
    longRunning: true,
    examples: [
      { args: {}, description: 'Auto-detect linter and run in current project' },
      { args: { linter: 'eslint', fix: true }, description: 'Run ESLint with auto-fix' },
      { args: { linter: 'phpstan', files: 'src/Services/' }, description: 'Run PHPStan on specific directory' },
    ],
    relatedTools: ['check-types', 'run-tests', 'code-review'],
  },
  execute: async (args, onProgress) => {
    const cwd = getCwd(args.cwd as string | undefined);
    const linterChoice = (args.linter as string) || 'auto';
    const fix = Boolean(args.fix);
    const files = args.files as string | undefined;
    const timeout = (args.timeout as number) || SHORT_TIMEOUT;

    validateCwd(cwd, existsSync);

    let linter: Linter | null;

    if (linterChoice === 'auto') {
      linter = detectLinter(cwd);
      if (!linter) {
        return `No linter detected in ${cwd}\nSearched for: ESLint, PHPCS, PHPStan, Prettier config files`;
      }
    } else {
      linter = getLinter(linterChoice);
      if (!linter) {
        throw new Error(`Unknown linter: ${linterChoice}`);
      }
    }

    onProgress?.(`Running ${linter.name}${fix ? ' with auto-fix' : ''}...\n\n`);

    return executeLinter(linter, cwd, fix, files, timeout, onProgress);
  },
};
