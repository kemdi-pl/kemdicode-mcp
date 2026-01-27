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
 * Error Utilities Module
 *
 * Provides standardized error handling across all MCP tools with:
 * - Custom error classes for different error types
 * - Error formatting for consistent MCP responses
 * - Error wrapping to preserve stack traces
 *
 * @module utils/errors
 */

/**
 * Base error class for all MCP tool errors
 * Provides consistent error structure with context preservation
 */
export class McpError extends Error {
  /** Error code for categorization */
  readonly code: string;
  /** Additional context about the error */
  readonly context: Record<string, unknown>;
  /** Original error if this is a wrapped error */
  readonly cause?: Error;

  constructor(message: string, code: string, context: Record<string, unknown> = {}, cause?: Error) {
    super(message);
    this.name = 'McpError';
    this.code = code;
    this.context = context;
    this.cause = cause;

    // Preserve stack trace from cause if available
    if (cause?.stack) {
      this.stack = `${this.stack}\nCaused by: ${cause.stack}`;
    }

    // Ensure prototype chain is correct
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /**
   * Convert error to JSON-serializable format for MCP responses
   */
  toJSON(): Record<string, unknown> {
    return {
      success: false,
      error: this.message,
      code: this.code,
      ...this.context,
    };
  }
}

/**
 * Error thrown when tool execution fails
 * Used for general tool failures that don't fit other categories
 */
export class ToolExecutionError extends McpError {
  /** Name of the tool that failed */
  readonly toolName: string;

  constructor(
    toolName: string,
    message: string,
    context: Record<string, unknown> = {},
    cause?: Error
  ) {
    super(message, 'TOOL_EXECUTION_ERROR', { toolName, ...context }, cause);
    this.name = 'ToolExecutionError';
    this.toolName = toolName;
  }
}

/**
 * Error thrown when input validation fails
 * Used for invalid arguments, malformed input, or schema violations
 *
 * Note: Named InputValidationError to avoid conflict with validation.ts ValidationError
 */
export class InputValidationError extends McpError {
  /** Field(s) that failed validation */
  readonly fields: string[];

  constructor(message: string, fields: string[] = [], context: Record<string, unknown> = {}) {
    super(message, 'VALIDATION_ERROR', { fields, ...context });
    this.name = 'InputValidationError';
    this.fields = fields;
  }

  /**
   * Create from Zod validation issues
   * Supports Zod 4 PropertyKey[] paths (string | number | symbol)
   */
  static fromZodIssues(
    issues: Array<{ path: PropertyKey[]; message: string }>
  ): InputValidationError {
    const fields = issues.map((i) => i.path.map(String).join('.'));
    const messages = issues.map((i) => `${i.path.map(String).join('.')}: ${i.message}`);
    return new InputValidationError(`Invalid arguments: ${messages.join(', ')}`, fields, {
      issues: issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })),
    });
  }
}

/**
 * Error thrown when an operation times out
 * Used for command execution, network requests, or long-running operations
 */
export class TimeoutError extends McpError {
  /** Timeout duration in milliseconds */
  readonly timeoutMs: number;
  /** Operation that timed out */
  readonly operation: string;
  /** Partial output captured before timeout */
  readonly partialOutput?: string;

  constructor(
    operation: string,
    timeoutMs: number,
    partialOutput?: string,
    context: Record<string, unknown> = {}
  ) {
    super(`Operation timed out after ${timeoutMs / 1000}s: ${operation}`, 'TIMEOUT_ERROR', {
      operation,
      timeoutMs,
      hasPartialOutput: !!partialOutput,
      ...context,
    });
    this.name = 'TimeoutError';
    this.timeoutMs = timeoutMs;
    this.operation = operation;
    this.partialOutput = partialOutput;
  }

  override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      partialOutput: this.partialOutput,
    };
  }
}

/**
 * Error thrown when a file or directory is not found
 * Used for file operations, path resolution, or resource access
 */
export class FileNotFoundError extends McpError {
  /** Path that was not found */
  readonly path: string;
  /** Type of resource (file, directory, etc.) */
  readonly resourceType: 'file' | 'directory' | 'path';

  constructor(
    path: string,
    resourceType: 'file' | 'directory' | 'path' = 'file',
    context: Record<string, unknown> = {}
  ) {
    super(
      `${resourceType.charAt(0).toUpperCase() + resourceType.slice(1)} not found: ${path}`,
      'FILE_NOT_FOUND',
      { path, resourceType, ...context }
    );
    this.name = 'FileNotFoundError';
    this.path = path;
    this.resourceType = resourceType;
  }
}

/**
 * Error thrown when permission is denied for an operation
 * Used for file access, command execution, or resource access
 */
export class PermissionError extends McpError {
  /** Path or resource that access was denied for */
  readonly path: string;
  /** Operation that was attempted */
  readonly operation: string;

  constructor(path: string, operation: string = 'access', context: Record<string, unknown> = {}) {
    super(`Permission denied: cannot ${operation} ${path}`, 'PERMISSION_DENIED', {
      path,
      operation,
      ...context,
    });
    this.name = 'PermissionError';
    this.path = path;
    this.operation = operation;
  }
}

/**
 * Error thrown when a command or process fails
 * Used for shell execution, subprocess spawning, or external tool calls
 */
export class CommandError extends McpError {
  /** Command that was executed */
  readonly command: string;
  /** Exit code if available */
  readonly exitCode?: number;
  /** Standard error output */
  readonly stderr?: string;

  constructor(
    command: string,
    message: string,
    exitCode?: number,
    stderr?: string,
    context: Record<string, unknown> = {}
  ) {
    super(message, 'COMMAND_ERROR', { command, exitCode, ...context });
    this.name = 'CommandError';
    this.command = command;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }

  override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      stderr: this.stderr,
    };
  }
}

/**
 * Error thrown when an operation is aborted
 * Used for user-initiated cancellation or AbortController signals
 */
export class AbortError extends McpError {
  /** The operation that was aborted */
  readonly operation: string;

  constructor(operation: string, context: Record<string, unknown> = {}) {
    super(`Operation aborted: ${operation}`, 'ABORT_ERROR', { operation, ...context });
    this.name = 'AbortError';
    this.operation = operation;
  }
}

/**
 * Error thrown when a dangerous operation is blocked
 * Used for security-sensitive operations that require explicit confirmation
 */
export class DangerousOperationError extends McpError {
  /** The operation that was blocked */
  readonly operation: string;
  /** Reason for blocking */
  readonly reason: string;

  constructor(
    operation: string,
    reason: string = 'This operation is potentially dangerous',
    context: Record<string, unknown> = {}
  ) {
    super(
      `BLOCKED: ${reason}\nOperation: ${operation}\n\nTo proceed, set allowDangerous: true`,
      'DANGEROUS_OPERATION',
      { operation, reason, ...context }
    );
    this.name = 'DangerousOperationError';
    this.operation = operation;
    this.reason = reason;
  }
}

// ============================================================================
// Error Utility Functions
// ============================================================================

/**
 * Format an error for consistent MCP response
 * Handles both custom McpError types and standard errors
 */
export function formatErrorResponse(error: unknown): Record<string, unknown> {
  if (error instanceof McpError) {
    return error.toJSON();
  }

  if (error instanceof Error) {
    return {
      success: false,
      error: error.message,
      code: 'UNKNOWN_ERROR',
      name: error.name,
    };
  }

  return {
    success: false,
    error: String(error),
    code: 'UNKNOWN_ERROR',
  };
}

/**
 * Wrap an error with additional context while preserving the stack trace
 * @param error - Original error to wrap
 * @param context - Additional context to add
 * @returns Wrapped error with preserved stack trace
 */
export function wrapError<T extends Error>(
  error: T,
  context: Record<string, unknown> = {}
): T | McpError {
  if (error instanceof McpError) {
    // Merge context into existing McpError
    Object.assign(error.context, context);
    return error;
  }

  // Wrap standard Error in ToolExecutionError
  return new ToolExecutionError(
    (context.toolName as string) || 'unknown',
    error.message,
    context,
    error
  );
}

/**
 * Convert a Node.js errno error to appropriate custom error type
 * @param error - Node.js error with code property
 * @param path - File/resource path for context
 * @param operation - Operation being performed
 */
export function fromNodeError(
  error: NodeJS.ErrnoException,
  path: string,
  operation: string = 'access'
): McpError {
  switch (error.code) {
    case 'ENOENT':
      return new FileNotFoundError(path);
    case 'EACCES':
    case 'EPERM':
      return new PermissionError(path, operation);
    case 'ENOTDIR':
      return new FileNotFoundError(path, 'directory', { originalCode: error.code });
    case 'EISDIR':
      return new InputValidationError(`Expected file but found directory: ${path}`, ['path'], {
        path,
      });
    case 'ENOSPC':
      return new ToolExecutionError('file-operation', 'No space left on device', { path });
    case 'EROFS':
      return new ToolExecutionError('file-operation', 'Read-only file system', { path });
    case 'ETIMEDOUT':
      return new TimeoutError(operation, 0, undefined, { path });
    default:
      return new ToolExecutionError(
        'file-operation',
        error.message || `Operation failed: ${error.code}`,
        { path, code: error.code },
        error
      );
  }
}

/**
 * Check if an error is a specific type of McpError
 */
export function isErrorType<T extends McpError>(
  error: unknown,
  errorClass: new (...args: unknown[]) => T
): error is T {
  return error instanceof errorClass;
}

/**
 * Create a JSON string response for an error (for tools that return JSON)
 */
export function errorToJsonString(error: unknown): string {
  return JSON.stringify(formatErrorResponse(error));
}
