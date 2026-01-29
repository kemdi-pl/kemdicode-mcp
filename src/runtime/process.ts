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
 * Process Abstraction
 *
 * Cross-runtime child process spawning for Bun and Node.js.
 *
 * @module runtime/process
 */

import { spawnSync, execSync as nodeExecSync, spawn as nodeSpawn } from 'child_process';
import { isBun } from './index.js';
import type {
  SpawnOptions,
  SpawnResult,
  StreamingSpawnOptions,
  SubprocessHandle,
} from './types.js';

// Bun types (declared for TypeScript)
declare const Bun: {
  spawn: (
    cmd: string[],
    opts?: {
      cwd?: string;
      env?: Record<string, string | undefined>;
      stdout?: 'pipe' | 'inherit' | 'ignore';
      stderr?: 'pipe' | 'inherit' | 'ignore';
    }
  ) => {
    pid: number;
    stdout: ReadableStream<Uint8Array> | null;
    stderr: ReadableStream<Uint8Array> | null;
    exitCode: number | null;
    exited: Promise<number>;
    kill: (signal?: number) => void;
    killed: boolean;
  };
  spawnSync: (
    cmd: string[],
    opts?: {
      cwd?: string;
      env?: Record<string, string | undefined>;
    }
  ) => {
    stdout: Buffer;
    stderr: Buffer;
    exitCode: number;
  };
};

/**
 * Execute a command synchronously
 *
 * @param command - Command to execute
 * @param args - Command arguments
 * @param options - Spawn options
 * @returns Spawn result with stdout, stderr, exitCode
 */
export function execSync(
  command: string,
  args: string[] = [],
  options?: SpawnOptions
): SpawnResult {
  if (isBun) {
    const result = Bun.spawnSync([command, ...args], {
      cwd: options?.cwd,
      env: options?.env as Record<string, string>,
    });

    return {
      stdout: result.stdout?.toString() || '',
      stderr: result.stderr?.toString() || '',
      exitCode: result.exitCode,
    };
  } else {
    // Node.js implementation
    const result = spawnSync(command, args, {
      cwd: options?.cwd,
      env: options?.env,
      maxBuffer: options?.maxBuffer || 10 * 1024 * 1024,
      timeout: options?.timeout,
      shell: options?.shell,
      encoding: 'utf-8',
    });

    return {
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      exitCode: result.status ?? 1,
      timedOut: result.signal === 'SIGTERM',
      killed: result.signal !== null,
    };
  }
}

/**
 * Execute a shell command synchronously (convenience wrapper)
 *
 * @param command - Full shell command
 * @param options - Spawn options
 * @returns Command output as string
 */
export function shellSync(command: string, options?: SpawnOptions): string {
  if (isBun) {
    const result = Bun.spawnSync(['sh', '-c', command], {
      cwd: options?.cwd,
      env: options?.env as Record<string, string>,
    });
    if (result.exitCode !== 0) {
      throw new Error(result.stderr?.toString() || `Command failed: ${command}`);
    }
    return result.stdout?.toString() || '';
  } else {
    return nodeExecSync(command, {
      cwd: options?.cwd,
      env: options?.env,
      maxBuffer: options?.maxBuffer || 10 * 1024 * 1024,
      timeout: options?.timeout,
      encoding: 'utf-8',
    }) as string;
  }
}

/**
 * Spawn a process asynchronously with streaming output
 *
 * @param command - Command to execute
 * @param args - Command arguments
 * @param options - Streaming spawn options
 * @returns Subprocess handle
 */
export function spawn(
  command: string,
  args: string[] = [],
  options?: StreamingSpawnOptions
): SubprocessHandle {
  if (isBun) {
    const proc = Bun.spawn([command, ...args], {
      cwd: options?.cwd,
      env: options?.env as Record<string, string>,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    // Set up streaming if callbacks provided
    if (options?.onStdout && proc.stdout) {
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            options.onStdout?.(decoder.decode(value));
          }
        } catch {
          // Stream closed
        }
      })();
    }

    if (options?.onStderr && proc.stderr) {
      const reader = proc.stderr.getReader();
      const decoder = new TextDecoder();
      (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            options.onStderr?.(decoder.decode(value));
          }
        } catch {
          // Stream closed
        }
      })();
    }

    let exited = false;

    return {
      pid: proc.pid,
      kill: (signal?: string) => {
        try {
          proc.kill(signal === 'SIGKILL' ? 9 : 15);
          return true;
        } catch {
          return false;
        }
      },
      wait: async (): Promise<SpawnResult> => {
        const exitCode = await proc.exited;
        exited = true;
        return {
          stdout: '',
          stderr: '',
          exitCode,
        };
      },
      get exited() {
        return exited || proc.killed;
      },
    };
  } else {
    // Node.js implementation
    const proc = nodeSpawn(command, args, {
      cwd: options?.cwd,
      env: options?.env,
      shell: options?.shell,
    });

    let stdout = '';
    let stderr = '';
    let exited = false;

    proc.stdout?.on('data', (data: Buffer) => {
      const str = data.toString();
      stdout += str;
      options?.onStdout?.(str);
    });

    proc.stderr?.on('data', (data: Buffer) => {
      const str = data.toString();
      stderr += str;
      options?.onStderr?.(str);
    });

    const waitPromise = new Promise<SpawnResult>((resolve, reject) => {
      proc.on('error', reject);
      proc.on('close', (code: number | null) => {
        exited = true;
        resolve({
          stdout,
          stderr,
          exitCode: code,
        });
      });
    });

    // Set up timeout if specified
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    if (options?.timeout) {
      timeoutHandle = setTimeout(() => {
        proc.kill('SIGTERM');
        setTimeout(() => {
          if (!exited) proc.kill('SIGKILL');
        }, 5000);
      }, options.timeout);

      waitPromise.finally(() => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      });
    }

    return {
      pid: proc.pid,
      kill: (signal: NodeJS.Signals = 'SIGTERM') => {
        try {
          proc.kill(signal);
          return true;
        } catch {
          return false;
        }
      },
      wait: () => waitPromise,
      get exited() {
        return exited;
      },
    };
  }
}

/**
 * Execute a command asynchronously and wait for completion
 *
 * @param command - Command to execute
 * @param args - Command arguments
 * @param options - Spawn options
 * @returns Promise resolving to spawn result
 */
export async function exec(
  command: string,
  args: string[] = [],
  options?: StreamingSpawnOptions
): Promise<SpawnResult> {
  const handle = spawn(command, args, options);
  return handle.wait();
}
