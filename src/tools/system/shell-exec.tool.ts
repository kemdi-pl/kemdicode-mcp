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
 * Shell Exec Tool
 *
 * Executes shell commands safely with timeout support,
 * streaming output, and comprehensive security validation.
 *
 * @module tools/system/shell-exec
 */

import { z } from 'zod';
import { existsSync } from 'fs';
import { spawn } from 'child_process';
import {
  UnifiedTool,
  FileNotFoundError,
  DangerousOperationError,
  TimeoutError,
  CommandError,
  PermissionError,
} from '../registry.js';
import { Logger } from '../../utils/logger.js';
import { config } from '../../config/index.js';
import {
  validatePath,
  sanitizeEnvVars,
  ValidationError,
  rateLimitGuard,
} from '../../utils/validation.js';
import { maskSensitiveData } from '../../utils/security.js';
import { isSilent } from '../../config/silent.js';

/**
 * List of dangerous commands that should be blocked
 */
const DANGEROUS_PATTERNS = [
  /^rm\s+-rf\s+\/(?!\w)/, // rm -rf /
  /^rm\s+-rf\s+~/, // rm -rf ~
  /^dd\s+if=.+of=\/dev\/(?:sd|hd|nvme)/, // dd to disk
  /^mkfs\./, // Format filesystem
  /^:?\(\)\s*\{\s*:?\|:?\s*&\s*\}\s*;?\s*:/, // Fork bomb
  />\s*\/dev\/sd[a-z]/, // Write to raw disk
  />\s*\/etc\/passwd/, // Overwrite passwd
  />\s*\/etc\/shadow/, // Overwrite shadow
  /chmod\s+-R\s+777\s+\//, // chmod 777 /
  /chown\s+-R\s+.+\s+\/(?!\w)/, // chown /
  // Additional security patterns for command injection and shells
  /curl\s+.*\|\s*(?:ba)?sh/, // Pipe curl to shell
  /wget\s+.*\|\s*(?:ba)?sh/, // Pipe wget to shell
  /curl\s+.*\|\s*python/, // Pipe curl to python
  /wget\s+.*\|\s*python/, // Pipe wget to python
  />\s*\/boot\//, // Write to boot
  />\s*\/usr\//, // Write to system directories
  />\s*\/bin\//, // Write to binaries
  />\s*\/sbin\//, // Write to system binaries
  />\s*\/lib\//, // Write to libraries
  />\s*\/var\/log\//, // Write to logs
  /eval\s*\(?\s*\$/, // Eval with variable
  /\$\([^)]+\)\s*\|\s*sh/, // Command substitution piped to shell
  /`[^`]+`\s*\|\s*sh/, // Backtick command piped to shell
  /base64\s+-d.*\|\s*(?:ba)?sh/, // Base64 decode piped to shell
  /nc\s+.+\s+-e\s+(?:\/bin\/)?(?:ba)?sh/, // Netcat reverse shell
  /python\s+-c\s+['"]import\s+socket/, // Python reverse shell
  /perl\s+-e\s+['"]use\s+Socket/, // Perl reverse shell
  // eslint-disable-next-line no-control-regex
  /\x00/, // Null byte injection
];

/**
 * Suspicious patterns that warrant a warning but not blocking
 */
const SUSPICIOUS_PATTERNS = [
  /curl\s+.*-o\s+.*&&/, // Download and execute pattern
  /wget\s+.*-O\s+.*&&/, // Download and execute pattern
  /chmod\s+\+x\s+.*&&/, // Make executable and run
  /sudo\s+/, // Sudo usage
  /su\s+-/, // Switch user
  /ssh\s+/, // SSH connection
  /scp\s+/, // SCP transfer
];

/**
 * Commands that need confirmation
 */
const REQUIRES_CONFIRMATION = [
  /^rm\s+-rf/,
  /^rm\s+-r/,
  /^git\s+push\s+.*--force/,
  /^git\s+reset\s+--hard/,
  /^npm\s+publish/,
  /^docker\s+rm/,
  /^docker\s+system\s+prune/,
];

const schema = z.object({
  command: z.string().min(1).describe('Shell command to execute'),
  cwd: z.string().optional().describe('Working directory'),
  // NOTE: timeout=0 means "no timeout" (infinite) for backward compatibility.
  timeout: z
    .number()
    .int()
    .min(0)
    .default(60000)
    .describe('Timeout ms (0=no timeout)'),
  shell: z
    .enum(['bash', 'sh', 'zsh', 'fish', 'powershell'])
    .default('bash')
    .describe('Shell to use'),
  env: z.record(z.string(), z.string()).optional().describe('Extra environment variables'),
  allowDangerous: z.boolean().default(false).describe('Allow dangerous commands'),
});

function isShellExecEnabled(): boolean {
  // Disabled-by-default: require explicit opt-in at deployment/runtime.
  const v = process.env.KEMDICODE_SHELL_EXEC_ENABLED;
  return v === '1' || v === 'true';
}

function maskForLogs(text: string, maxLen = 200): string {
  const masked = maskSensitiveData(text);
  return masked.length > maxLen ? masked.slice(0, maxLen) + '…' : masked;
}

/**
 * Check if command is dangerous
 */
function isDangerous(command: string): boolean {
  return DANGEROUS_PATTERNS.some((pattern) => pattern.test(command));
}

/**
 * Check if command requires confirmation
 */
function requiresConfirmation(command: string): boolean {
  return REQUIRES_CONFIRMATION.some((pattern) => pattern.test(command));
}

/**
 * Check if command is suspicious (warrant a warning)
 */
function isSuspicious(command: string): boolean {
  return SUSPICIOUS_PATTERNS.some((pattern) => pattern.test(command));
}

/**
 * Log security-relevant events
 */
function logSecurityEvent(eventType: string, details: Record<string, unknown>): void {
  Logger.warn(`SECURITY [shell-exec]: ${eventType}`, details);
}

/**
 * Execute shell command
 */
async function executeShellCommand(
  command: string,
  cwd: string,
  timeout: number,
  shell: string,
  envVars: Record<string, string> | undefined,
  onProgress?: (output: string) => void
): Promise<string> {
  return new Promise((resolve, reject) => {
    const start = Date.now();

    // Get shell command
    const shellCmd = shell === 'powershell' ? 'powershell' : shell;
    const shellArgs = shell === 'powershell' ? ['-Command', command] : ['-c', command];

    Logger.debug(
      `Executing: ${shellCmd} ${maskForLogs(shellArgs.join(' '), 500)} in ${maskForLogs(cwd, 300)}`
    );
    onProgress?.(`$ ${command}\n\n`);

    const proc = spawn(shellCmd, shellArgs, {
      cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...envVars,
      },
    });

    let stdout = '';
    let stderr = '';
    let done = false;

    const forceKillDelayMs = config.get('timeouts').forceKill;
    const timer =
      timeout > 0
        ? setTimeout(() => {
            if (done) return;
            done = true;
            try {
              proc.kill('SIGTERM');
              setTimeout(() => {
                try {
                  proc.kill('SIGKILL');
                } catch {
                  // Process may have already exited
                }
              }, forceKillDelayMs);
            } catch {
              // Process may have already exited
            }

            const output = stdout.trim();
            if (output) {
              // Return partial output with timeout notice
              resolve(output + `\n\n[TIMEOUT: Command exceeded ${timeout / 1000}s limit]`);
            } else {
              // No output captured, throw TimeoutError
              reject(new TimeoutError(command, timeout, undefined, { cwd, shell }));
            }
          }, timeout)
        : null;

    proc.stdout.on('data', (data) => {
      const chunk = data.toString();
      stdout += chunk;
      onProgress?.(chunk);
    });

    proc.stderr.on('data', (data) => {
      const chunk = data.toString();
      stderr += chunk;
      onProgress?.(chunk);
    });

    proc.on('error', (err) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      reject(
        new CommandError(
          command,
          `Failed to execute command: ${err.message}`,
          undefined,
          undefined,
          { cwd, shell }
        )
      );
    });

    proc.on('close', (code) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);

      const duration = ((Date.now() - start) / 1000).toFixed(2);
      const output = stdout + (stderr ? `\nSTDERR:\n${stderr}` : '');

      if (isSilent()) {
        resolve(output.trim());
      } else if (code === 0) {
        resolve(output.trim() + `\n\n[Exit: 0, Duration: ${duration}s]`);
      } else {
        resolve(output.trim() + `\n\n[Exit: ${code}, Duration: ${duration}s]`);
      }
    });
  });
}

export const shellExecTool: UnifiedTool = {
  name: 'shell-exec',
  description: 'Execute shell command with timeout and streaming output',
  zodSchema: schema,
  metadata: {
    category: 'system',
    tags: ['shell', 'exec', 'command'],
    examples: [
      { args: { command: 'ls -la' }, description: 'List files in current directory' },
      { args: { command: 'docker ps', timeout: 10000 }, description: 'List running Docker containers with 10s timeout' },
      { args: { command: 'npm run build', cwd: '/opt/project', shell: 'bash' }, description: 'Run build in specific directory' },
    ],
    relatedTools: ['run-script', 'process-list'],
  },
  execute: async (args, onProgress) => {
    // Disabled-by-default / admin-gated.
    if (!isShellExecEnabled()) {
      throw new PermissionError('shell-exec', 'execute', {
        reason:
          'shell-exec is disabled by default for security. Set environment variable KEMDICODE_SHELL_EXEC_ENABLED=true to enable it. This is independent of the allowDangerous parameter.',
      });
    }

    const command = String(args.command);
    const inputCwd = (args.cwd as string) || process.cwd();
    // Preserve explicit 0 (no timeout)
    const timeout = typeof args.timeout === 'number' ? (args.timeout as number) : 60000;
    const shell = (args.shell as string) || 'bash';
    const envVars = args.env as Record<string, string> | undefined;
    const allowDangerous = Boolean(args.allowDangerous);

    const blocked = rateLimitGuard('shell-exec', { maxRequests: 30, windowMs: 60000 });
    if (blocked) {
      logSecurityEvent('RATE_LIMIT_EXCEEDED', { command: maskForLogs(command, 100) });
      throw new Error(
        'Rate limit exceeded for shell-exec operations. Please wait before executing more commands.'
      );
    }

    // Validate and sanitize the working directory
    let validatedCwd: string;
    try {
      validatedCwd = await validatePath(inputCwd, {
        allowSymlinks: true, // Allow symlinks for cwd since it's a directory
        requireWithinProject: false, // Allow execution in any accessible directory
        allowReadFromBlocked: true,
        operation: 'execute',
      });
    } catch (validationError) {
      if (validationError instanceof ValidationError) {
        logSecurityEvent('CWD_VALIDATION_FAILED', {
          cwd: inputCwd,
          error: validationError.message,
        });
        throw new FileNotFoundError(inputCwd, 'directory', {
          operation: 'shell-exec',
          error: validationError.message,
        });
      }
      throw validationError;
    }

    // Validate CWD exists
    if (!existsSync(validatedCwd)) {
      throw new FileNotFoundError(validatedCwd, 'directory', { operation: 'shell-exec' });
    }

    // Sanitize environment variables
    const sanitizedEnvVars = sanitizeEnvVars(envVars);
    if (
      envVars &&
      sanitizedEnvVars &&
      Object.keys(envVars).length !== Object.keys(sanitizedEnvVars).length
    ) {
      logSecurityEvent('ENV_VARS_SANITIZED', {
        originalCount: Object.keys(envVars).length,
        sanitizedCount: Object.keys(sanitizedEnvVars).length,
      });
      onProgress?.(`NOTE: Some environment variables were filtered for security.\n\n`);
    }

    // Check for dangerous commands
    if (isDangerous(command)) {
      logSecurityEvent('DANGEROUS_COMMAND_ATTEMPT', {
        command: maskForLogs(command, 200),
        cwd: maskForLogs(validatedCwd, 200),
        allowDangerous,
      });
      if (!allowDangerous) {
        throw new DangerousOperationError(
          command,
          'This command is potentially dangerous and could cause system damage',
          { cwd: validatedCwd, shell }
        );
      }
      onProgress?.(`WARNING: Running potentially dangerous command...\n\n`);
    }

    // Check for suspicious commands
    if (isSuspicious(command)) {
      logSecurityEvent('SUSPICIOUS_COMMAND', {
        command: maskForLogs(command, 200),
        cwd: maskForLogs(validatedCwd, 200),
      });
      onProgress?.(`CAUTION: This command pattern is flagged as potentially risky.\n\n`);
    }

    // Warn about commands that typically require confirmation
    if (requiresConfirmation(command) && !allowDangerous) {
      onProgress?.(`NOTE: This command typically requires confirmation in interactive mode.\n\n`);
    }

    // Log the execution for audit trail
    Logger.debug(`shell-exec: executing command in ${maskForLogs(validatedCwd, 300)}`);

    return executeShellCommand(command, validatedCwd, timeout, shell, sanitizedEnvVars, onProgress);
  },
};
