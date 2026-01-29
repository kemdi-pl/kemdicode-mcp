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
 * Security Validation Utilities
 *
 * Provides robust input validation for file paths, shell commands,
 * regex patterns, and file sizes. Prevents common security issues
 * like path traversal, command injection, and ReDoS attacks.
 *
 * @module utils/validation
 */

import { promises as fs } from 'fs';
import { resolve, normalize, isAbsolute, relative, dirname, basename } from 'path';
import { Logger } from './logger.js';

/**
 * Validation error with detailed context
 */
export class ValidationError extends Error {
  constructor(
    message: string,
    public readonly code: ValidationErrorCode,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}

/**
 * Validation error codes for programmatic error handling
 */
export enum ValidationErrorCode {
  PATH_TRAVERSAL = 'PATH_TRAVERSAL',
  SENSITIVE_PATH = 'SENSITIVE_PATH',
  SYMLINK_DETECTED = 'SYMLINK_DETECTED',
  FILE_TOO_LARGE = 'FILE_TOO_LARGE',
  INVALID_REGEX = 'INVALID_REGEX',
  REGEX_TOO_COMPLEX = 'REGEX_TOO_COMPLEX',
  COMMAND_INJECTION = 'COMMAND_INJECTION',
  DANGEROUS_COMMAND = 'DANGEROUS_COMMAND',
  INVALID_PATH = 'INVALID_PATH',
  OUTSIDE_PROJECT = 'OUTSIDE_PROJECT',
}

/**
 * Configuration for path validation
 */
export interface PathValidationOptions {
  /** Allow symlinks (default: false) */
  allowSymlinks?: boolean;
  /** Allow absolute paths (default: true) */
  allowAbsolute?: boolean;
  /** Require path to be within project root (default: true) */
  requireWithinProject?: boolean;
  /** Project root directory (default: process.cwd()) */
  projectRoot?: string;
  /** Additional blocked directories beyond the defaults */
  additionalBlockedPaths?: string[];
  /** Allow reading from blocked paths (less strict mode) */
  allowReadFromBlocked?: boolean;
  /** Operation type for logging */
  operation?: 'read' | 'write' | 'execute' | 'search';
}

/**
 * Configuration for regex validation
 */
export interface RegexValidationOptions {
  /** Maximum pattern length (default: 1000) */
  maxLength?: number;
  /** Maximum number of quantifiers (default: 10) */
  maxQuantifiers?: number;
  /** Maximum nesting depth (default: 5) */
  maxNestingDepth?: number;
  /** Timeout for regex test in ms (default: 1000) */
  testTimeout?: number;
}

/**
 * Default sensitive directories that should be blocked for write operations
 */
const SENSITIVE_DIRECTORIES: readonly string[] = [
  '/etc',
  '/root',
  // '/var' removed - /var/www is commonly used for web projects
  '/usr',
  '/bin',
  '/sbin',
  '/boot',
  '/dev',
  '/proc',
  '/sys',
  '/lib',
  '/lib64',
  '/run',
  '/var/log', // Block logs
  '/var/run', // Block runtime
  '/var/cache', // Block cache
  // '/tmp' removed - useful for temp files
  // '/home' removed - may need to write to user dirs
] as const;

/**
 * Directories that are always blocked (even for read)
 */
const ALWAYS_BLOCKED_DIRECTORIES: readonly string[] = ['/proc', '/sys', '/dev'] as const;

/**
 * Sensitive file patterns that should never be modified
 */
const SENSITIVE_FILE_PATTERNS: readonly RegExp[] = [
  /\.env$/i,
  /\.env\.\w+$/i,
  /credentials\.json$/i,
  /secrets\.json$/i,
  /\.pem$/i,
  /\.key$/i,
  /id_rsa/i,
  /id_ed25519/i,
  /authorized_keys$/i,
  /known_hosts$/i,
  /\.ssh\//i,
  /password/i,
  /shadow$/,
  /passwd$/,
  /sudoers/,
  /\.gnupg\//i,
  /\.aws\/credentials/i,
  /\.kube\/config/i,
  /\.docker\/config\.json/i,
];

/**
 * Patterns that indicate potential command injection
 */
const COMMAND_INJECTION_PATTERNS: readonly RegExp[] = [
  /;\s*[a-z]/i, // Semicolon followed by command
  /\|\s*[a-z]/i, // Pipe to command
  /`[^`]+`/, // Backtick command substitution
  /\$\([^)]+\)/, // $() command substitution
  /\$\{[^}]+\}/, // ${} variable expansion with potential command
  /&&\s*[a-z]/i, // && chaining
  /\|\|\s*[a-z]/i, // || chaining
  />\s*\//, // Redirect to absolute path
  /2>\s*\//, // Stderr redirect to absolute path
  /\n/, // Newline injection
  /\r/, // Carriage return injection
];

/**
 * Patterns for potentially catastrophic regex (ReDoS vulnerable)
 */
const REDOS_PATTERNS: readonly RegExp[] = [
  /\([^)]*[+*][^)]*\)[+*]/, // Nested quantifiers: (a+)+
  /\([^)]*\|[^)]*\)[+*]/, // Alternation with quantifier: (a|b)+
  /\.{2,}\*/, // Multiple dots with star
  /\*{2,}/, // Multiple stars
  /\+{2,}/, // Multiple plus
];

/**
 * Security log for audit trail
 */
function logSecurityEvent(eventType: string, details: Record<string, unknown>): void {
  Logger.warn(`SECURITY: ${eventType}`, details);
}

/**
 * Validate and sanitize a file path
 *
 * @param inputPath - The path to validate
 * @param options - Validation options
 * @returns Resolved, safe path
 * @throws ValidationError if path is invalid or unsafe
 */
export async function validatePath(
  inputPath: string,
  options: PathValidationOptions = {}
): Promise<string> {
  const {
    allowSymlinks = false,
    allowAbsolute = true,
    requireWithinProject = true,
    projectRoot = process.cwd(),
    additionalBlockedPaths = [],
    allowReadFromBlocked = false,
    operation = 'read',
  } = options;

  // Basic validation
  if (!inputPath || typeof inputPath !== 'string') {
    throw new ValidationError('Path must be a non-empty string', ValidationErrorCode.INVALID_PATH, {
      inputPath,
    });
  }

  // Trim and check for empty after trim
  const trimmedPath = inputPath.trim();
  if (!trimmedPath) {
    throw new ValidationError(
      'Path cannot be empty or whitespace only',
      ValidationErrorCode.INVALID_PATH,
      {
        inputPath,
      }
    );
  }

  // Check for null bytes (common attack vector)
  if (trimmedPath.includes('\0')) {
    logSecurityEvent('NULL_BYTE_INJECTION', { inputPath, operation });
    throw new ValidationError('Path contains null bytes', ValidationErrorCode.PATH_TRAVERSAL, {
      inputPath,
    });
  }

  // Check for path traversal attempts
  const normalizedPath = normalize(trimmedPath);
  const pathSegments = normalizedPath.split(/[/\\]/);
  if (pathSegments.includes('..')) {
    logSecurityEvent('PATH_TRAVERSAL_ATTEMPT', { inputPath, normalizedPath, operation });
    throw new ValidationError(
      'Path traversal detected: ".." not allowed',
      ValidationErrorCode.PATH_TRAVERSAL,
      { inputPath, normalizedPath }
    );
  }

  // Resolve to absolute path
  let resolvedPath: string;
  if (isAbsolute(normalizedPath)) {
    if (!allowAbsolute) {
      throw new ValidationError(
        'Absolute paths are not allowed',
        ValidationErrorCode.INVALID_PATH,
        {
          inputPath,
        }
      );
    }
    resolvedPath = normalize(normalizedPath);
  } else {
    resolvedPath = resolve(projectRoot, normalizedPath);
  }

  // Check if within project root (if required)
  if (requireWithinProject) {
    const relativePath = relative(projectRoot, resolvedPath);
    if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
      logSecurityEvent('OUTSIDE_PROJECT_ACCESS', {
        inputPath,
        resolvedPath,
        projectRoot,
        operation,
      });
      throw new ValidationError(
        `Path is outside project root: ${resolvedPath}`,
        ValidationErrorCode.OUTSIDE_PROJECT,
        { inputPath, resolvedPath, projectRoot }
      );
    }
  }

  // Check against always-blocked directories (for all operations)
  for (const blocked of ALWAYS_BLOCKED_DIRECTORIES) {
    if (resolvedPath.startsWith(blocked + '/') || resolvedPath === blocked) {
      logSecurityEvent('BLOCKED_DIRECTORY_ACCESS', {
        inputPath,
        resolvedPath,
        blockedDir: blocked,
        operation,
      });
      throw new ValidationError(
        `Access to ${blocked} is not allowed`,
        ValidationErrorCode.SENSITIVE_PATH,
        { inputPath, resolvedPath, blockedDirectory: blocked }
      );
    }
  }

  // Check against sensitive directories (for write/execute operations)
  if (operation !== 'read' || !allowReadFromBlocked) {
    const allBlockedPaths = [...SENSITIVE_DIRECTORIES, ...additionalBlockedPaths];
    for (const blocked of allBlockedPaths) {
      if (resolvedPath.startsWith(blocked + '/') || resolvedPath === blocked) {
        logSecurityEvent('SENSITIVE_PATH_ACCESS', {
          inputPath,
          resolvedPath,
          blockedDir: blocked,
          operation,
        });
        throw new ValidationError(
          `${operation === 'write' ? 'Writing to' : 'Access to'} ${blocked} is not allowed`,
          ValidationErrorCode.SENSITIVE_PATH,
          { inputPath, resolvedPath, blockedDirectory: blocked }
        );
      }
    }
  }

  // Check for sensitive file patterns (for write operations)
  if (operation === 'write') {
    const fileName = basename(resolvedPath);
    for (const pattern of SENSITIVE_FILE_PATTERNS) {
      if (pattern.test(fileName) || pattern.test(resolvedPath)) {
        logSecurityEvent('SENSITIVE_FILE_WRITE', {
          inputPath,
          resolvedPath,
          pattern: pattern.source,
        });
        throw new ValidationError(
          `Cannot write to sensitive file: ${fileName}`,
          ValidationErrorCode.SENSITIVE_PATH,
          { inputPath, resolvedPath, pattern: pattern.source }
        );
      }
    }
  }

  // Check for symlinks if not allowed
  if (!allowSymlinks) {
    try {
      const stats = await fs.lstat(resolvedPath);
      if (stats.isSymbolicLink()) {
        logSecurityEvent('SYMLINK_DETECTED', { inputPath, resolvedPath, operation });
        throw new ValidationError(
          `Symbolic links are not allowed: ${resolvedPath}`,
          ValidationErrorCode.SYMLINK_DETECTED,
          { inputPath, resolvedPath }
        );
      }
    } catch (error) {
      // File doesn't exist yet (okay for write operations)
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Re-throw ValidationErrors
        if (error instanceof ValidationError) {
          throw error;
        }
        // For other errors, just continue (file may not exist yet)
      }
    }

    // Also check parent directory for symlinks
    const parentDir = dirname(resolvedPath);
    try {
      const parentStats = await fs.lstat(parentDir);
      if (parentStats.isSymbolicLink()) {
        logSecurityEvent('SYMLINK_IN_PATH', { inputPath, resolvedPath, parentDir, operation });
        throw new ValidationError(
          `Parent directory is a symbolic link: ${parentDir}`,
          ValidationErrorCode.SYMLINK_DETECTED,
          { inputPath, resolvedPath, parentDir }
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        if (error instanceof ValidationError) {
          throw error;
        }
      }
    }
  }

  return resolvedPath;
}

/**
 * Validate file size against a maximum limit
 *
 * @param filePath - Path to the file
 * @param maxSize - Maximum allowed size in bytes
 * @returns File stats if valid
 * @throws ValidationError if file is too large
 */
export async function validateFileSize(
  filePath: string,
  maxSize: number
): Promise<{ size: number; isFile: boolean }> {
  try {
    const stats = await fs.stat(filePath);

    if (!stats.isFile()) {
      return { size: 0, isFile: false };
    }

    if (stats.size > maxSize) {
      throw new ValidationError(
        `File size ${stats.size} bytes exceeds maximum ${maxSize} bytes`,
        ValidationErrorCode.FILE_TOO_LARGE,
        { filePath, actualSize: stats.size, maxSize }
      );
    }

    return { size: stats.size, isFile: true };
  } catch (error) {
    if (error instanceof ValidationError) {
      throw error;
    }
    throw error; // Re-throw fs errors
  }
}

/**
 * Validate a regex pattern for safety and correctness
 *
 * @param pattern - The regex pattern to validate
 * @param options - Validation options
 * @returns The validated pattern (unchanged if safe)
 * @throws ValidationError if pattern is invalid or potentially dangerous
 */
export function validateRegexPattern(
  pattern: string,
  options: RegexValidationOptions = {}
): string {
  const {
    maxLength = 1000,
    maxQuantifiers = 10,
    maxNestingDepth = 5,
    testTimeout = 1000,
  } = options;

  // Check pattern length
  if (pattern.length > maxLength) {
    throw new ValidationError(
      `Regex pattern too long: ${pattern.length} chars (max: ${maxLength})`,
      ValidationErrorCode.REGEX_TOO_COMPLEX,
      { patternLength: pattern.length, maxLength }
    );
  }

  // Check for ReDoS patterns
  for (const redosPattern of REDOS_PATTERNS) {
    if (redosPattern.test(pattern)) {
      logSecurityEvent('REDOS_PATTERN_DETECTED', {
        pattern: pattern.substring(0, 100),
        matchedPattern: redosPattern.source,
      });
      throw new ValidationError(
        'Regex pattern may cause catastrophic backtracking (ReDoS)',
        ValidationErrorCode.REGEX_TOO_COMPLEX,
        { pattern: pattern.substring(0, 100), matchedPattern: redosPattern.source }
      );
    }
  }

  // Count quantifiers
  const quantifierCount = (pattern.match(/[+*?]|\{[\d,]+\}/g) || []).length;
  if (quantifierCount > maxQuantifiers) {
    throw new ValidationError(
      `Too many quantifiers in regex: ${quantifierCount} (max: ${maxQuantifiers})`,
      ValidationErrorCode.REGEX_TOO_COMPLEX,
      { quantifierCount, maxQuantifiers }
    );
  }

  // Check nesting depth
  let depth = 0;
  let maxDepth = 0;
  for (const char of pattern) {
    if (char === '(' || char === '[') {
      depth++;
      maxDepth = Math.max(maxDepth, depth);
    } else if (char === ')' || char === ']') {
      depth--;
    }
  }

  if (maxDepth > maxNestingDepth) {
    throw new ValidationError(
      `Regex nesting too deep: ${maxDepth} levels (max: ${maxNestingDepth})`,
      ValidationErrorCode.REGEX_TOO_COMPLEX,
      { nestingDepth: maxDepth, maxNestingDepth }
    );
  }

  // Try to compile the regex
  try {
    new RegExp(pattern);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    throw new ValidationError(
      `Invalid regex pattern: ${message}`,
      ValidationErrorCode.INVALID_REGEX,
      { pattern: pattern.substring(0, 100), error: message }
    );
  }

  // Test with a timeout using a simple test string
  const testString = 'a'.repeat(100);
  const startTime = Date.now();
  try {
    const regex = new RegExp(pattern);
    regex.test(testString);
    const elapsed = Date.now() - startTime;
    if (elapsed > testTimeout) {
      logSecurityEvent('SLOW_REGEX_DETECTED', {
        pattern: pattern.substring(0, 100),
        elapsed,
        testTimeout,
      });
      throw new ValidationError(
        `Regex execution too slow: ${elapsed}ms (max: ${testTimeout}ms)`,
        ValidationErrorCode.REGEX_TOO_COMPLEX,
        { pattern: pattern.substring(0, 100), elapsed, testTimeout }
      );
    }
  } catch (error) {
    if (error instanceof ValidationError) {
      throw error;
    }
    // Regex test failed, but compilation succeeded - likely okay
  }

  return pattern;
}

/**
 * Validate a shell command for injection attacks
 *
 * @param command - The command to validate
 * @param allowedCommands - Optional list of allowed command prefixes
 * @returns The validated command
 * @throws ValidationError if command contains injection patterns
 */
export function validateCommand(command: string, allowedCommands?: readonly string[]): string {
  // Check for empty command
  if (!command || typeof command !== 'string') {
    throw new ValidationError(
      'Command must be a non-empty string',
      ValidationErrorCode.COMMAND_INJECTION,
      {
        command,
      }
    );
  }

  const trimmedCommand = command.trim();
  if (!trimmedCommand) {
    throw new ValidationError('Command cannot be empty', ValidationErrorCode.COMMAND_INJECTION, {
      command,
    });
  }

  // Check for null bytes
  if (trimmedCommand.includes('\0')) {
    logSecurityEvent('COMMAND_NULL_BYTE', { command: trimmedCommand.substring(0, 100) });
    throw new ValidationError(
      'Command contains null bytes',
      ValidationErrorCode.COMMAND_INJECTION,
      {
        command: trimmedCommand.substring(0, 100),
      }
    );
  }

  // Check for injection patterns
  for (const pattern of COMMAND_INJECTION_PATTERNS) {
    if (pattern.test(trimmedCommand)) {
      logSecurityEvent('COMMAND_INJECTION_DETECTED', {
        command: trimmedCommand.substring(0, 100),
        pattern: pattern.source,
      });
      throw new ValidationError(
        'Potential command injection detected',
        ValidationErrorCode.COMMAND_INJECTION,
        { command: trimmedCommand.substring(0, 100), pattern: pattern.source }
      );
    }
  }

  // Check against allowed commands if provided
  if (allowedCommands && allowedCommands.length > 0) {
    const commandName = trimmedCommand.split(/\s+/)[0];
    if (
      !allowedCommands.some(
        (allowed) => commandName === allowed || commandName.startsWith(allowed + ' ')
      )
    ) {
      throw new ValidationError(
        `Command not in allowed list: ${commandName}`,
        ValidationErrorCode.DANGEROUS_COMMAND,
        { command: commandName, allowedCommands }
      );
    }
  }

  return trimmedCommand;
}

/**
 * Sanitize environment variables for shell execution
 *
 * @param env - Environment variables to sanitize
 * @returns Sanitized environment variables
 */
export function sanitizeEnvVars(
  env: Record<string, string> | undefined
): Record<string, string> | undefined {
  if (!env) return undefined;

  const sanitized: Record<string, string> = {};
  const blockedVars = ['PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES'];

  for (const [key, value] of Object.entries(env)) {
    // Skip blocked variables
    if (blockedVars.includes(key.toUpperCase())) {
      logSecurityEvent('BLOCKED_ENV_VAR', { key });
      continue;
    }

    // Sanitize key (alphanumeric and underscore only)
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
      logSecurityEvent('INVALID_ENV_VAR_NAME', { key });
      continue;
    }

    // Check for injection in value
    if (value.includes('\0') || value.includes('\n') || value.includes('\r')) {
      logSecurityEvent('ENV_VAR_INJECTION', { key, value: value.substring(0, 50) });
      continue;
    }

    sanitized[key] = value;
  }

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

/**
 * Rate limiter configuration and state
 */
interface RateLimitConfig {
  maxRequests: number;
  windowMs: number;
}

interface RateLimitState {
  requests: number[];
}

const rateLimitStates: Map<string, RateLimitState> = new Map();

/**
 * Check if an operation is within rate limits
 *
 * @param key - Unique key for the rate limit (e.g., "file-write")
 * @param config - Rate limit configuration
 * @returns true if within limits, false if exceeded
 */
export function checkRateLimit(
  key: string,
  config: RateLimitConfig = { maxRequests: 100, windowMs: 60000 }
): boolean {
  const now = Date.now();
  const state = rateLimitStates.get(key) || { requests: [] };

  // Remove old requests outside the window
  state.requests = state.requests.filter((time) => now - time < config.windowMs);

  // Check if within limit
  if (state.requests.length >= config.maxRequests) {
    logSecurityEvent('RATE_LIMIT_EXCEEDED', {
      key,
      requests: state.requests.length,
      limit: config.maxRequests,
    });
    return false;
  }

  // Record this request
  state.requests.push(now);
  rateLimitStates.set(key, state);

  return true;
}

/**
 * Reset rate limit state (for testing)
 */
export function resetRateLimits(): void {
  rateLimitStates.clear();
}

/**
 * Comprehensive validation result type
 */
export interface ValidationResult {
  valid: boolean;
  error?: ValidationError;
  sanitizedValue?: string;
}

/**
 * Validate multiple paths at once
 *
 * @param paths - Array of paths to validate
 * @param options - Validation options
 * @returns Array of validation results
 */
export async function validatePaths(
  paths: string[],
  options: PathValidationOptions = {}
): Promise<Map<string, ValidationResult>> {
  const results = new Map<string, ValidationResult>();

  for (const path of paths) {
    try {
      const sanitized = await validatePath(path, options);
      results.set(path, { valid: true, sanitizedValue: sanitized });
    } catch (error) {
      if (error instanceof ValidationError) {
        results.set(path, { valid: false, error });
      } else {
        results.set(path, {
          valid: false,
          error: new ValidationError(
            error instanceof Error ? error.message : 'Unknown error',
            ValidationErrorCode.INVALID_PATH,
            { path }
          ),
        });
      }
    }
  }

  return results;
}

/**
 * Quick path check (synchronous, less thorough)
 * Use for preliminary filtering before async validation
 *
 * @param inputPath - Path to check
 * @returns true if path passes basic checks
 */
export function quickPathCheck(inputPath: string): boolean {
  if (!inputPath || typeof inputPath !== 'string') return false;
  if (inputPath.includes('\0')) return false;
  if (inputPath.includes('..')) return false;

  const normalized = normalize(inputPath);
  for (const blocked of ALWAYS_BLOCKED_DIRECTORIES) {
    if (normalized.startsWith(blocked + '/') || normalized === blocked) {
      return false;
    }
  }

  return true;
}
