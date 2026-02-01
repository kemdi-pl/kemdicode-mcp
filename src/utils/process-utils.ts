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
 * Process Utilities
 *
 * Shared utilities for process execution across project tools.
 * Provides spawn helpers with timeout, progress streaming,
 * and common process patterns.
 *
 * @module utils/process-utils
 */

import { spawn, SpawnOptions } from 'child_process';
import { Logger } from './logger.js';
import { config } from '../config/index.js';

/**
 * Get default timeout for process execution (5 minutes)
 * Uses config which may change at runtime
 */
export function getDefaultTimeout(): number {
  return config.get('timeouts').command;
}

/**
 * Get short timeout for quick operations (2 minutes)
 * Uses config which may change at runtime
 */
export function getShortTimeout(): number {
  return config.get('timeouts').short;
}

/**
 * Get long timeout for test/build operations (10 minutes)
 * Uses config which may change at runtime
 */
export function getLongTimeout(): number {
  return config.get('timeouts').long;
}

/**
 * Default timeout for process execution (5 minutes)
 * @deprecated Use getDefaultTimeout() instead for runtime config support
 */
export const DEFAULT_TIMEOUT = 300_000;

/**
 * Short timeout for quick operations (2 minutes)
 * @deprecated Use getShortTimeout() instead for runtime config support
 */
export const SHORT_TIMEOUT = 120_000;

/**
 * Long timeout for test/build operations (10 minutes)
 * @deprecated Use getLongTimeout() instead for runtime config support
 */
export const LONG_TIMEOUT = 600_000;

/**
 * Progress callback type
 */
export type ProgressCallback = (output: string) => void;

/**
 * Options for spawning a process
 */
export interface SpawnProcessOptions {
  /** Working directory for the command */
  cwd: string;
  /** Timeout in milliseconds (default: 5 minutes) */
  timeout?: number;
  /** Progress callback for streaming output */
  onProgress?: ProgressCallback;
  /** Additional environment variables */
  env?: Record<string, string>;
  /** Whether to use shell (default: true for cross-platform compatibility) */
  shell?: boolean;
  /** Whether to force color output (default: false) */
  forceColor?: boolean;
  /** Whether to set CI environment (default: false) */
  ci?: boolean;
}

/**
 * Result of a spawned process
 */
export interface SpawnResult {
  /** Combined stdout output */
  stdout: string;
  /** Combined stderr output */
  stderr: string;
  /** Exit code (null if killed) */
  exitCode: number | null;
  /** Whether the process timed out */
  timedOut: boolean;
  /** Duration in milliseconds */
  duration: number;
}

/**
 * Spawn a process with timeout and progress streaming
 *
 * @param command - Command to execute
 * @param args - Command arguments
 * @param options - Spawn options
 * @returns Promise resolving to spawn result
 *
 * @example
 * ```typescript
 * const result = await spawnProcess('npm', ['run', 'build'], {
 *   cwd: '/path/to/project',
 *   timeout: 120000,
 *   onProgress: (output) => console.log(output),
 * });
 *
 * if (result.exitCode === 0) {
 *   console.log('Build succeeded');
 * }
 * ```
 */
export async function spawnProcess(
  command: string,
  args: string[],
  options: SpawnProcessOptions
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const timeout = options.timeout ?? getDefaultTimeout();

    Logger.debug(`Running: ${command} ${args.join(' ')} in ${options.cwd}`);
    options.onProgress?.(`$ ${command} ${args.join(' ')}\n\n`);

    // Build environment
    const env: Record<string, string | undefined> = { ...process.env, ...options.env };
    if (options.forceColor) {
      env.FORCE_COLOR = '1';
    }
    if (options.ci) {
      env.CI = 'true';
    }

    const spawnOptions: SpawnOptions = {
      cwd: options.cwd,
      shell: options.shell ?? true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    };

    const proc = spawn(command, args, spawnOptions);

    let stdout = '';
    let stderr = '';
    let done = false;

    // Setup timeout
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      killProcess(proc);
      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: null,
        timedOut: true,
        duration: Date.now() - startTime,
      });
    }, timeout);

    // Capture stdout
    proc.stdout?.on('data', (data) => {
      const chunk = data.toString();
      stdout += chunk;
      options.onProgress?.(chunk);
    });

    // Capture stderr
    proc.stderr?.on('data', (data) => {
      const chunk = data.toString();
      stderr += chunk;
      options.onProgress?.(chunk);
    });

    // Handle spawn error
    proc.on('error', (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(new Error(`Failed to spawn ${command}: ${err.message}`));
    });

    // Handle process exit
    proc.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: code,
        timedOut: false,
        duration: Date.now() - startTime,
      });
    });
  });
}

/**
 * Kill a process gracefully with SIGTERM, then SIGKILL after 5 seconds
 *
 * @param proc - Process to kill
 */
function killProcess(proc: ReturnType<typeof spawn>): void {
  try {
    proc.kill('SIGTERM');
    setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        // Process may have already exited
      }
    }, 5000);
  } catch {
    // Process may have already exited
  }
}

/**
 * Format duration in milliseconds to human-readable string
 *
 * @param ms - Duration in milliseconds
 * @returns Formatted duration string
 *
 * @example
 * ```typescript
 * formatDuration(1500); // '1.50s'
 * formatDuration(65000); // '1m 5.00s'
 * ```
 */
export function formatDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(2)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds.toFixed(2)}s`;
}

/**
 * Create a formatted completion message
 *
 * @param result - Spawn result
 * @returns Formatted completion string
 */
export function formatCompletion(result: SpawnResult): string {
  const duration = formatDuration(result.duration);

  if (result.timedOut) {
    return `\n\n[TIMEOUT: Exceeded ${formatDuration(result.duration)} limit]`;
  }

  if (result.exitCode === 0) {
    return `\n\n[Completed in ${duration}]`;
  }

  return `\n\n[Exit code: ${result.exitCode}, Duration: ${duration}]`;
}

/**
 * Run a command and return formatted output with completion message
 *
 * @param command - Command to execute
 * @param args - Command arguments
 * @param options - Spawn options
 * @returns Formatted output string
 *
 * @example
 * ```typescript
 * const output = await runCommand('npm', ['test'], {
 *   cwd: '/project',
 *   onProgress,
 * });
 * ```
 */
export async function runCommand(
  command: string,
  args: string[],
  options: SpawnProcessOptions
): Promise<string> {
  const result = await spawnProcess(command, args, options);

  let output = result.stdout;
  if (result.stderr) {
    output += (output ? '\n\nSTDERR:\n' : '') + result.stderr;
  }

  return output + formatCompletion(result);
}

/**
 * Options for running with auto-detection
 */
export interface DetectableRunner<T> {
  /** Name of the runner */
  name: string;
  /** Config files to detect this runner */
  configFiles: string[];
  /** The configuration object */
  config: T;
}

/**
 * Detect a runner from config files
 *
 * @param cwd - Working directory
 * @param runners - List of runners to check
 * @param checkExists - Function to check if file exists
 * @returns Detected runner or null
 *
 * @example
 * ```typescript
 * const runner = await detectRunner(cwd, TEST_FRAMEWORKS, existsSync);
 * if (!runner) {
 *   return 'No test framework detected';
 * }
 * ```
 */
export function detectRunner<T>(
  cwd: string,
  runners: DetectableRunner<T>[],
  checkExists: (path: string) => boolean
): T | null {
  for (const runner of runners) {
    for (const configFile of runner.configFiles) {
      const configPath = `${cwd}/${configFile}`;
      if (checkExists(configPath)) {
        return runner.config;
      }
    }
  }
  return null;
}

/**
 * Get runner by name from a list
 *
 * @param name - Runner name
 * @param runners - List of runners
 * @returns Runner config or null
 */
export function getRunnerByName<T>(name: string, runners: DetectableRunner<T>[]): T | null {
  const runner = runners.find((r) => r.name === name);
  return runner?.config ?? null;
}

/**
 * Validate working directory exists
 *
 * @param cwd - Directory path
 * @param checkExists - Function to check if directory exists
 * @throws Error if directory does not exist
 */
export function validateCwd(cwd: string, checkExists: (path: string) => boolean): void {
  if (!checkExists(cwd)) {
    throw new Error(`Directory not found: ${cwd}`);
  }
}

/**
 * Get the working directory, defaulting to process.cwd()
 *
 * @param cwd - Optional working directory from args
 * @returns Working directory path
 */
export function getCwd(cwd?: string): string {
  return cwd || process.cwd();
}
