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
 * Command Executor Module
 *
 * Executes shell commands with timeout support, progress streaming,
 * AbortController for cancellation, and automatic configuration injection.
 *
 * @module utils/commandExecutor
 */

import { spawn, ChildProcess } from 'child_process';
import { Logger } from './logger.js';
import { TimeoutError, CommandError, AbortError } from './errors.js';
import { config } from '../config/index.js';

/**
 * Options for command execution
 */
export interface ExecuteCommandOptions {
  /** Callback for stdout streaming */
  onProgress?: (output: string) => void;
  /** Timeout in milliseconds (default: 300000) */
  timeout?: number;
  /** AbortSignal for cancellation support */
  signal?: AbortSignal;
  /** Working directory for the command */
  cwd?: string;
  /** Additional environment variables */
  env?: Record<string, string>;
}

/**
 * Execute a shell command with timeout and progress streaming
 * @param {string} command - Command to execute
 * @param {string[]} args - Command arguments
 * @param {Function} [onProgress] - Callback for stdout streaming
 * @param {number} [timeout=300000] - Timeout in milliseconds
 * @returns {Promise<string>} Command stdout
 * @throws {Error} On timeout, spawn failure, or non-zero exit code
 */
export async function executeCommand(
  command: string,
  args: string[],
  onProgress?: (output: string) => void,
  timeout?: number
): Promise<string> {
  const effectiveTimeout = timeout ?? config.get('timeouts').command;
  return executeCommandWithOptions(command, args, { onProgress, timeout: effectiveTimeout });
}

/**
 * Execute a shell command with full options including AbortController support
 * @param {string} command - Command to execute
 * @param {string[]} args - Command arguments
 * @param {ExecuteCommandOptions} options - Execution options
 * @returns {Promise<string>} Command stdout
 * @throws {AbortError} On abort signal
 * @throws {TimeoutError} On timeout
 * @throws {CommandError} On spawn failure or non-zero exit code
 */
export async function executeCommandWithOptions(
  command: string,
  args: string[],
  options: ExecuteCommandOptions = {}
): Promise<string> {
  const timeouts = config.get('timeouts');
  const { onProgress, timeout = timeouts.command, signal, cwd, env: extraEnv } = options;

  return new Promise((resolve, reject) => {
    // Check if already aborted
    if (signal?.aborted) {
      reject(new AbortError(`${command} ${args.join(' ')}`, { command, args }));
      return;
    }

    const start = Date.now();
    Logger.commandExecution(command, args, start);

    const spawnOptions: {
      env: NodeJS.ProcessEnv;
      shell: boolean;
      stdio: ['ignore', 'pipe', 'pipe'];
      cwd?: string;
    } = {
      env: { ...process.env, ...extraEnv },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    };

    if (cwd) {
      spawnOptions.cwd = cwd;
    }

    const proc: ChildProcess = spawn(command, args, spawnOptions);

    let stdout = '',
      stderr = '',
      done = false,
      lastLen = 0;

    const fullCommand = `${command} ${args.join(' ')}`;

    // Cleanup function to properly terminate
    const cleanup = (reason: 'abort' | 'timeout' | 'complete') => {
      if (done) return false;
      done = true;
      clearTimeout(timer);
      if (abortHandler) {
        signal?.removeEventListener('abort', abortHandler);
      }

      if (reason !== 'complete') {
        try {
          proc.kill('SIGTERM');
          // Force kill after configured delay if still running
          setTimeout(() => {
            try {
              proc.kill('SIGKILL');
            } catch {
              // Process may have already exited
            }
          }, timeouts.forceKill);
        } catch {
          // Process may have already exited
        }
      }
      return true;
    };

    // Handle abort signal
    let abortHandler: (() => void) | undefined;
    if (signal) {
      abortHandler = () => {
        if (cleanup('abort')) {
          if (stdout.trim()) {
            resolve(stdout.trim() + '\n\n[ABORTED]');
          } else {
            reject(new AbortError(fullCommand, { command, args }));
          }
        }
      };
      signal.addEventListener('abort', abortHandler);
    }

    // Handle timeout
    const timer = setTimeout(() => {
      if (cleanup('timeout')) {
        if (stdout.trim()) {
          // Return partial output with timeout notice
          resolve(stdout.trim() + `\n\n[TIMEOUT: ${timeout / 1000}s limit]`);
        } else {
          // No output captured, throw TimeoutError with context
          reject(new TimeoutError(fullCommand, timeout, undefined, { command, args }));
        }
      }
    }, timeout);

    proc.stdout?.on('data', (data) => {
      stdout += data.toString();
      if (onProgress && stdout.length > lastLen) {
        onProgress(stdout.substring(lastLen));
        lastLen = stdout.length;
      }
    });

    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
      if (stderr.includes('RESOURCE_EXHAUSTED')) {
        Logger.error('Quota exceeded - try fallback model');
      }
    });

    proc.on('error', (err) => {
      if (cleanup('complete')) {
        reject(
          new CommandError(fullCommand, `Spawn failed: ${err.message}`, undefined, undefined, {
            command,
            args,
          })
        );
      }
    });

    proc.on('close', (code) => {
      if (cleanup('complete')) {
        Logger.commandComplete(start, code, stdout.length);
        if (code === 0) {
          resolve(stdout.trim());
        } else {
          reject(
            new CommandError(
              fullCommand,
              stderr.trim() || `Command exited with code ${code}`,
              code ?? undefined,
              stderr.trim() || undefined,
              { command, args }
            )
          );
        }
      }
    });
  });
}
