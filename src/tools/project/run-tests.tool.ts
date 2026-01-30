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
 * Run Tests Tool
 *
 * Detects test framework (Jest, Vitest, PHPUnit, etc.)
 * and runs tests with optional filter. Parses results for summary.
 *
 * @module tools/project/run-tests
 */

import { z } from 'zod';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { UnifiedTool } from '../registry.js';
import {
  spawnProcess,
  getCwd,
  validateCwd,
  DEFAULT_TIMEOUT,
  ProgressCallback,
} from '../../utils/process-utils.js';

/**
 * Test framework configuration
 */
interface TestFramework {
  name: string;
  configFiles: string[];
  command: string;
  args: string[];
  filterArg: string;
  watchArg?: string;
  coverageArg?: string;
  parseResults: (output: string) => TestResults;
}

/**
 * Test results structure
 */
interface TestResults {
  passed: number;
  failed: number;
  skipped: number;
  total: number;
  duration?: string;
  failures: Array<{ name: string; message: string }>;
}

const schema = z.object({
  cwd: z.string().optional().describe('Working directory'),
  framework: z
    .enum(['auto', 'jest', 'vitest', 'mocha', 'phpunit', 'pytest', 'go'])
    .default('auto')
    .describe('Test framework'),
  filter: z.string().optional().describe('Filter tests by name pattern'),
  coverage: z.boolean().default(false).describe('Generate coverage report'),
  timeout: z.number().default(300000).describe('Timeout ms'),
  watch: z.boolean().default(false).describe('Watch mode'),
});

/**
 * Parse Jest/Vitest output
 */
function parseJestOutput(output: string): TestResults {
  const results: TestResults = { passed: 0, failed: 0, skipped: 0, total: 0, failures: [] };

  // Match: Tests: X passed, Y failed, Z skipped, N total
  const testsMatch = output.match(
    /Tests:\s*(?:(\d+)\s*passed)?[,\s]*(?:(\d+)\s*failed)?[,\s]*(?:(\d+)\s*(?:skipped|todo))?[,\s]*(\d+)\s*total/i
  );
  if (testsMatch) {
    results.passed = parseInt(testsMatch[1] || '0', 10);
    results.failed = parseInt(testsMatch[2] || '0', 10);
    results.skipped = parseInt(testsMatch[3] || '0', 10);
    results.total = parseInt(testsMatch[4] || '0', 10);
  }

  // Match duration
  const timeMatch = output.match(/Time:\s*([\d.]+\s*[sm]s?)/i);
  if (timeMatch) {
    results.duration = timeMatch[1];
  }

  // Extract failures
  const failurePattern =
    /FAIL\s+(.+?)\n[\s\S]*?●\s+(.+?)\n([\s\S]*?)(?=\n\s*●|\n\s*PASS|\n\s*FAIL|$)/g;
  let match;
  while ((match = failurePattern.exec(output)) !== null) {
    results.failures.push({
      name: match[2].trim(),
      message: match[3].trim().slice(0, 200),
    });
  }

  return results;
}

/**
 * Parse PHPUnit output
 */
function parsePHPUnitOutput(output: string): TestResults {
  const results: TestResults = { passed: 0, failed: 0, skipped: 0, total: 0, failures: [] };

  // Match: OK (X tests, Y assertions) or FAILURES!
  const okMatch = output.match(/OK\s*\((\d+)\s*tests?/i);
  if (okMatch) {
    results.passed = parseInt(okMatch[1], 10);
    results.total = results.passed;
  }

  // Match: Tests: X, Assertions: Y, Failures: Z, Errors: W, Skipped: S
  const statsMatch = output.match(
    /Tests:\s*(\d+).*?(?:Failures:\s*(\d+))?.*?(?:Errors:\s*(\d+))?.*?(?:Skipped:\s*(\d+))?/i
  );
  if (statsMatch) {
    results.total = parseInt(statsMatch[1] || '0', 10);
    results.failed = parseInt(statsMatch[2] || '0', 10) + parseInt(statsMatch[3] || '0', 10);
    results.skipped = parseInt(statsMatch[4] || '0', 10);
    results.passed = results.total - results.failed - results.skipped;
  }

  // Match duration
  const timeMatch = output.match(/Time:\s*([\d.]+\s*(?:seconds|ms|minutes?))/i);
  if (timeMatch) {
    results.duration = timeMatch[1];
  }

  // Extract failures
  const failurePattern = /\d+\)\s+(\S+::\S+)\n([\s\S]*?)(?=\n\d+\)|\nFAILURES|$)/g;
  let match;
  while ((match = failurePattern.exec(output)) !== null) {
    results.failures.push({
      name: match[1],
      message: match[2].trim().slice(0, 200),
    });
  }

  return results;
}

/**
 * Parse pytest output
 */
function parsePytestOutput(output: string): TestResults {
  const results: TestResults = { passed: 0, failed: 0, skipped: 0, total: 0, failures: [] };

  // Match: X passed, Y failed, Z skipped in Ns
  const statsMatch = output.match(
    /(?:(\d+)\s*passed)?[,\s]*(?:(\d+)\s*failed)?[,\s]*(?:(\d+)\s*(?:skipped|deselected))?[,\s]*in\s*([\d.]+s)/i
  );
  if (statsMatch) {
    results.passed = parseInt(statsMatch[1] || '0', 10);
    results.failed = parseInt(statsMatch[2] || '0', 10);
    results.skipped = parseInt(statsMatch[3] || '0', 10);
    results.total = results.passed + results.failed + results.skipped;
    results.duration = statsMatch[4];
  }

  // Extract failures
  const failurePattern = /FAILED\s+(\S+)\s*-\s*(.+?)(?=\nFAILED|\n=|$)/g;
  let match;
  while ((match = failurePattern.exec(output)) !== null) {
    results.failures.push({
      name: match[1],
      message: match[2].trim().slice(0, 200),
    });
  }

  return results;
}

/**
 * Parse Go test output
 */
function parseGoOutput(output: string): TestResults {
  const results: TestResults = { passed: 0, failed: 0, skipped: 0, total: 0, failures: [] };

  // Count pass/fail
  results.passed = (output.match(/--- PASS:/g) || []).length;
  results.failed = (output.match(/--- FAIL:/g) || []).length;
  results.skipped = (output.match(/--- SKIP:/g) || []).length;
  results.total = results.passed + results.failed + results.skipped;

  // Match duration
  const timeMatch = output.match(/ok\s+\S+\s+([\d.]+s)/);
  if (timeMatch) {
    results.duration = timeMatch[1];
  }

  // Extract failures
  const failurePattern = /--- FAIL:\s*(\S+)\s*\([\d.]+s\)\n([\s\S]*?)(?=\n---|\nFAIL|$)/g;
  let match;
  while ((match = failurePattern.exec(output)) !== null) {
    results.failures.push({
      name: match[1],
      message: match[2].trim().slice(0, 200),
    });
  }

  return results;
}

const TEST_FRAMEWORKS: TestFramework[] = [
  {
    name: 'vitest',
    configFiles: ['vitest.config.ts', 'vitest.config.js', 'vitest.config.mjs'],
    command: 'npx',
    args: ['vitest', 'run'],
    filterArg: '-t',
    watchArg: '--watch',
    coverageArg: '--coverage',
    parseResults: parseJestOutput,
  },
  {
    name: 'jest',
    configFiles: ['jest.config.js', 'jest.config.ts', 'jest.config.json'],
    command: 'npx',
    args: ['jest'],
    filterArg: '-t',
    watchArg: '--watch',
    coverageArg: '--coverage',
    parseResults: parseJestOutput,
  },
  {
    name: 'mocha',
    configFiles: ['.mocharc.js', '.mocharc.json', '.mocharc.yml'],
    command: 'npx',
    args: ['mocha'],
    filterArg: '--grep',
    watchArg: '--watch',
    coverageArg: '--coverage', // requires nyc
    parseResults: parseJestOutput, // Similar format
  },
  {
    name: 'phpunit',
    configFiles: ['phpunit.xml', 'phpunit.xml.dist'],
    command: 'vendor/bin/phpunit',
    args: [],
    filterArg: '--filter',
    coverageArg: '--coverage-text',
    parseResults: parsePHPUnitOutput,
  },
  {
    name: 'pytest',
    configFiles: ['pytest.ini', 'pyproject.toml', 'setup.cfg'],
    command: 'pytest',
    args: ['-v'],
    filterArg: '-k',
    watchArg: '--looponfail', // requires pytest-watch
    coverageArg: '--cov',
    parseResults: parsePytestOutput,
  },
  {
    name: 'go',
    configFiles: ['go.mod'],
    command: 'go',
    args: ['test', '-v', './...'],
    filterArg: '-run',
    coverageArg: '-cover',
    parseResults: parseGoOutput,
  },
];

/**
 * Detect test framework for the project
 */
function detectTestFramework(cwd: string): TestFramework | null {
  for (const framework of TEST_FRAMEWORKS) {
    for (const configFile of framework.configFiles) {
      if (existsSync(join(cwd, configFile))) {
        // Special handling for pyproject.toml - check if it has pytest config
        if (configFile === 'pyproject.toml') {
          try {
            const content = readFileSync(join(cwd, configFile), 'utf-8');
            if (!content.includes('[tool.pytest]') && !content.includes('pytest')) {
              continue;
            }
          } catch {
            continue;
          }
        }
        return framework;
      }
    }
  }

  // Fallback: check package.json for jest/vitest
  if (existsSync(join(cwd, 'package.json'))) {
    try {
      const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf-8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps.vitest) return TEST_FRAMEWORKS.find((f) => f.name === 'vitest') || null;
      if (deps.jest) return TEST_FRAMEWORKS.find((f) => f.name === 'jest') || null;
      if (deps.mocha) return TEST_FRAMEWORKS.find((f) => f.name === 'mocha') || null;
    } catch {
      // Ignore
    }
  }

  return null;
}

/**
 * Get test framework by name
 */
function getTestFramework(name: string): TestFramework | null {
  return TEST_FRAMEWORKS.find((f) => f.name === name) || null;
}

/**
 * Execute tests using shared process utilities
 */
async function executeTests(
  framework: TestFramework,
  cwd: string,
  filter: string | undefined,
  coverage: boolean,
  watch: boolean,
  timeout: number,
  onProgress?: ProgressCallback
): Promise<{ output: string; results: TestResults }> {
  const args = [...framework.args];

  if (filter) {
    args.push(framework.filterArg, filter);
  }
  if (coverage && framework.coverageArg) {
    args.push(framework.coverageArg);
  }
  if (watch && framework.watchArg) {
    args.push(framework.watchArg);
  }

  const spawnResult = await spawnProcess(framework.command, args, {
    cwd,
    timeout,
    onProgress,
    forceColor: true,
    ci: true,
  });

  const combined = spawnResult.stdout + spawnResult.stderr;
  const results = framework.parseResults(combined);

  let output = combined;
  if (spawnResult.timedOut) {
    output += `\n\n[TIMEOUT: Tests exceeded ${timeout / 1000}s limit]`;
  }

  return { output, results };
}

/**
 * Format test results
 */
function formatResults(output: string, results: TestResults, frameworkName: string): string {
  const lines: string[] = [];

  lines.push(`# Test Results (${frameworkName})`);
  lines.push('');

  // Summary
  const status = results.failed > 0 ? 'FAILED' : 'PASSED';
  lines.push(`## Summary: ${status}`);
  lines.push(`- Passed: ${results.passed}`);
  lines.push(`- Failed: ${results.failed}`);
  if (results.skipped > 0) {
    lines.push(`- Skipped: ${results.skipped}`);
  }
  lines.push(`- Total: ${results.total}`);
  if (results.duration) {
    lines.push(`- Duration: ${results.duration}`);
  }

  // Failures
  if (results.failures.length > 0) {
    lines.push('');
    lines.push('## Failures');
    for (const failure of results.failures.slice(0, 10)) {
      lines.push(`\n### ${failure.name}`);
      lines.push('```');
      lines.push(failure.message);
      lines.push('```');
    }
    if (results.failures.length > 10) {
      lines.push(`\n... and ${results.failures.length - 10} more failures`);
    }
  }

  return lines.join('\n');
}

export const runTestsTool: UnifiedTool = {
  name: 'run-tests',
  description: 'Run tests (Jest, Vitest, PHPUnit, pytest, Go)',
  zodSchema: schema,
  execute: async (args, onProgress) => {
    const cwd = getCwd(args.cwd as string | undefined);
    const frameworkChoice = (args.framework as string) || 'auto';
    const filter = args.filter as string | undefined;
    const coverage = Boolean(args.coverage);
    const watch = Boolean(args.watch);
    const timeout = (args.timeout as number) || DEFAULT_TIMEOUT;

    validateCwd(cwd, existsSync);

    let framework: TestFramework | null;

    if (frameworkChoice === 'auto') {
      framework = detectTestFramework(cwd);
      if (!framework) {
        return `No test framework detected in ${cwd}\nSearched for: Jest, Vitest, Mocha, PHPUnit, pytest, Go test`;
      }
    } else {
      framework = getTestFramework(frameworkChoice);
      if (!framework) {
        throw new Error(`Unknown test framework: ${frameworkChoice}`);
      }
    }

    onProgress?.(`Running ${framework.name}${filter ? ` (filter: ${filter})` : ''}...\n\n`);

    const { output, results } = await executeTests(
      framework,
      cwd,
      filter,
      coverage,
      watch,
      timeout,
      onProgress
    );

    return formatResults(output, results, framework.name);
  },
};
