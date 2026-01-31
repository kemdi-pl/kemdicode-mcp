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

import { LOG_PREFIX } from '../constants.js';
import { isSilent } from '../config/silent.js';
import { randomUUID } from 'node:crypto';

/**
 * Log levels enum with numeric values for comparison
 */
export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

/**
 * Log format types
 */
export type LogFormat = 'text' | 'json';

/**
 * Structured log entry for JSON format
 */
export interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
  requestId?: string;
  duration?: number;
  memory?: NodeJS.MemoryUsage;
  [key: string]: unknown;
}

/**
 * Timing measurement for performance tracking
 */
export interface TimingContext {
  label: string;
  startTime: number;
  startMemory?: NodeJS.MemoryUsage;
  requestId?: string;
}

/**
 * Request context for correlating logs
 */
export interface RequestContext {
  requestId: string;
  sessionId?: string;
  toolName?: string;
  startTime: number;
}

/**
 * Logger configuration
 */
interface LoggerConfig {
  level: LogLevel;
  format: LogFormat;
  enableMemoryLogging: boolean;
}

/**
 * Parse log level from string
 */
function parseLogLevel(level: string | undefined): LogLevel {
  if (!level) return LogLevel.INFO;
  switch (level.toLowerCase()) {
    case 'debug':
      return LogLevel.DEBUG;
    case 'info':
      return LogLevel.INFO;
    case 'warn':
      return LogLevel.WARN;
    case 'error':
      return LogLevel.ERROR;
    default:
      return LogLevel.INFO;
  }
}

/**
 * Parse log format from string
 */
function parseLogFormat(format: string | undefined): LogFormat {
  if (!format) return 'text';
  return format.toLowerCase() === 'json' ? 'json' : 'text';
}

/**
 * Get configuration from environment variables
 */
function getConfig(): LoggerConfig {
  return {
    level: parseLogLevel(process.env.KEMDICODE_LOG_LEVEL),
    format: parseLogFormat(process.env.KEMDICODE_LOG_FORMAT),
    enableMemoryLogging: process.env.KEMDICODE_LOG_MEMORY === 'true',
  };
}

/**
 * Enhanced Logger class with levels, structured output, and request tracing
 */
export class Logger {
  private static config: LoggerConfig = getConfig();
  private static times = new Map<number | string, TimingContext>();
  private static activeRequestId: string | undefined;
  private static requestContexts = new Map<string, RequestContext>();

  /**
   * Refresh configuration from environment variables
   */
  static refreshConfig(): void {
    this.config = getConfig();
  }

  /**
   * Set log level programmatically
   */
  static setLevel(level: LogLevel): void {
    this.config.level = level;
  }

  /**
   * Set log format programmatically
   */
  static setFormat(format: LogFormat): void {
    this.config.format = format;
  }

  /**
   * Get current log level
   */
  static getLevel(): LogLevel {
    return this.config.level;
  }

  /**
   * Check if a log level is enabled
   */
  static isLevelEnabled(level: LogLevel): boolean {
    return level >= this.config.level;
  }

  /**
   * Generate a new request ID
   */
  static generateRequestId(): string {
    return `req_${randomUUID().replace(/-/g, '').substring(0, 12)}`;
  }

  /**
   * Set the active request ID for correlation
   */
  static setRequestId(requestId: string): void {
    this.activeRequestId = requestId;
  }

  /**
   * Get the active request ID
   */
  static getRequestId(): string | undefined {
    return this.activeRequestId;
  }

  /**
   * Clear the active request ID
   */
  static clearRequestId(): void {
    this.activeRequestId = undefined;
  }

  /**
   * Start a request context for correlation
   */
  static startRequest(sessionId?: string, toolName?: string): RequestContext {
    const requestId = this.generateRequestId();
    const context: RequestContext = {
      requestId,
      sessionId,
      toolName,
      startTime: Date.now(),
    };
    this.requestContexts.set(requestId, context);
    this.activeRequestId = requestId;
    return context;
  }

  /**
   * End a request context
   */
  static endRequest(requestId: string): { duration: number } | undefined {
    const context = this.requestContexts.get(requestId);
    if (context) {
      const duration = Date.now() - context.startTime;
      this.requestContexts.delete(requestId);
      if (this.activeRequestId === requestId) {
        this.activeRequestId = undefined;
      }
      return { duration };
    }
    return undefined;
  }

  /**
   * Get request context
   */
  static getRequestContext(requestId: string): RequestContext | undefined {
    return this.requestContexts.get(requestId);
  }

  /**
   * Format message for text output
   */
  private static formatText(level: string, msg: string, extra?: Record<string, unknown>): string {
    const timestamp = new Date().toISOString();
    const reqId = this.activeRequestId ? ` [${this.activeRequestId}]` : '';
    const levelPad = level.padEnd(5);
    let formatted = `${timestamp} ${LOG_PREFIX} ${levelPad}${reqId} ${msg}`;

    if (extra && Object.keys(extra).length > 0) {
      // Add extra fields inline for text format
      const extraStr = Object.entries(extra)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
        .join(' ');
      if (extraStr) {
        formatted += ` ${extraStr}`;
      }
    }

    return formatted;
  }

  /**
   * Format message for JSON output
   */
  private static formatJson(level: string, msg: string, extra?: Record<string, unknown>): string {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message: msg,
      ...(this.activeRequestId && { requestId: this.activeRequestId }),
      ...extra,
    };

    if (this.config.enableMemoryLogging) {
      entry.memory = process.memoryUsage();
    }

    return JSON.stringify(entry);
  }

  /**
   * Core log function
   * In silent mode: only ERROR level reaches stderr.
   * INFO/WARN/DEBUG are suppressed to avoid terminal noise.
   */
  private static logInternal(
    level: LogLevel,
    levelName: string,
    msg: string,
    extra?: Record<string, unknown>
  ): void {
    if (!this.isLevelEnabled(level)) return;

    // Silent mode: suppress everything except errors
    if (isSilent() && level < LogLevel.ERROR) return;

    const formatted =
      this.config.format === 'json'
        ? this.formatJson(levelName, msg, extra)
        : this.formatText(levelName, msg, extra);

    // Use stderr for all log output to avoid mixing with MCP protocol
    if (level === LogLevel.ERROR) {
      console.error(formatted);
    } else {
      console.warn(formatted);
    }
  }

  /**
   * Debug level log - only shown when KEMDICODE_LOG_LEVEL=debug
   * Uses lazy evaluation for expensive computations
   */
  static debug(msg: string | (() => string), extra?: Record<string, unknown>): void {
    if (!this.isLevelEnabled(LogLevel.DEBUG)) return;
    const message = typeof msg === 'function' ? msg() : msg;
    this.logInternal(LogLevel.DEBUG, 'DEBUG', message, extra);
  }

  /**
   * Info level log
   */
  static info(msg: string, extra?: Record<string, unknown>): void {
    this.logInternal(LogLevel.INFO, 'INFO', msg, extra);
  }

  /**
   * Warning level log
   */
  static warn(msg: string, extra?: Record<string, unknown>): void {
    this.logInternal(LogLevel.WARN, 'WARN', msg, extra);
  }

  /**
   * Error level log
   */
  static error(msg: string, error?: unknown, extra?: Record<string, unknown>): void {
    const errorInfo: Record<string, unknown> = { ...extra };

    if (error instanceof Error) {
      errorInfo.errorName = error.name;
      errorInfo.errorMessage = error.message;
      if (this.isLevelEnabled(LogLevel.DEBUG)) {
        errorInfo.stack = error.stack;
      }
    } else if (error !== undefined) {
      errorInfo.error = String(error);
    }

    this.logInternal(LogLevel.ERROR, 'ERROR', msg, errorInfo);
  }

  /**
   * Alias for info (backward compatibility)
   */
  static log(msg: string, extra?: Record<string, unknown>): void {
    this.info(msg, extra);
  }

  /**
   * Log tool invocation with structured data.
   * Skipped entirely in silent mode.
   */
  static toolInvocation(name: string, args: unknown): void {
    if (isSilent()) return;
    this.debug(() => `Tool invoked: ${name}`, {
      tool: name,
      args: typeof args === 'object' ? (args as Record<string, unknown>) : { value: args },
    });
  }

  /**
   * Log command execution start
   */
  static commandExecution(cmd: string, args: string[], startKey: number | string): void {
    const context: TimingContext = {
      label: `${cmd} ${args.slice(0, 3).join(' ')}`,
      startTime: Date.now(),
      requestId: this.activeRequestId,
    };

    if (this.config.enableMemoryLogging) {
      context.startMemory = process.memoryUsage();
    }

    this.times.set(startKey, context);

    this.debug(() => `Exec start: ${context.label}...`, {
      command: cmd,
      argsPreview: args.slice(0, 5),
    });
  }

  /**
   * Log command completion with timing
   */
  static commandComplete(startKey: number | string, code: number | null, len?: number): void {
    const context = this.times.get(startKey);
    if (!context) {
      this.warn('Command complete called without matching start', { startKey });
      return;
    }

    const duration = Date.now() - context.startTime;
    this.times.delete(startKey);

    const extra: Record<string, unknown> = {
      duration,
      durationSec: (duration / 1000).toFixed(2),
      exitCode: code,
    };

    if (len !== undefined) {
      extra.outputLength = len;
    }

    if (context.startMemory && this.config.enableMemoryLogging) {
      const endMemory = process.memoryUsage();
      extra.memoryDelta = {
        heapUsed: endMemory.heapUsed - context.startMemory.heapUsed,
        heapTotal: endMemory.heapTotal - context.startMemory.heapTotal,
        rss: endMemory.rss - context.startMemory.rss,
      };
    }

    this.debug(() => `Exec done: ${context.label}`, extra);
  }

  /**
   * Start a timing measurement
   */
  static startTiming(label: string): TimingContext {
    const context: TimingContext = {
      label,
      startTime: Date.now(),
      requestId: this.activeRequestId,
    };

    if (this.config.enableMemoryLogging) {
      context.startMemory = process.memoryUsage();
    }

    this.times.set(label, context);
    return context;
  }

  /**
   * End a timing measurement and log the result
   */
  static endTiming(label: string, extra?: Record<string, unknown>): number {
    const context = this.times.get(label);
    if (!context) {
      this.warn('End timing called without matching start', { label });
      return 0;
    }

    const duration = Date.now() - context.startTime;
    this.times.delete(label);

    const logExtra: Record<string, unknown> = {
      ...extra,
      duration,
      durationSec: (duration / 1000).toFixed(2),
    };

    if (context.startMemory && this.config.enableMemoryLogging) {
      const endMemory = process.memoryUsage();
      logExtra.memoryDelta = {
        heapUsed: endMemory.heapUsed - context.startMemory.heapUsed,
        heapTotal: endMemory.heapTotal - context.startMemory.heapTotal,
        rss: endMemory.rss - context.startMemory.rss,
      };
    }

    this.debug(() => `Timing: ${label}`, logExtra);
    return duration;
  }

  /**
   * Log memory usage
   */
  static logMemory(label?: string): void {
    if (!this.isLevelEnabled(LogLevel.DEBUG)) return;

    const memory = process.memoryUsage();
    const formatMB = (bytes: number) => (bytes / 1024 / 1024).toFixed(2);

    this.debug(() => `Memory${label ? ` [${label}]` : ''}`, {
      heapUsed: `${formatMB(memory.heapUsed)} MB`,
      heapTotal: `${formatMB(memory.heapTotal)} MB`,
      rss: `${formatMB(memory.rss)} MB`,
      external: `${formatMB(memory.external)} MB`,
    });
  }

  /**
   * HTTP request logging
   */
  static httpRequest(
    method: string,
    url: string,
    sessionId?: string,
    extra?: Record<string, unknown>
  ): void {
    this.info(`${method} ${url}`, {
      method,
      url,
      ...(sessionId && { sessionId }),
      ...extra,
    });
  }

  /**
   * HTTP response logging
   */
  static httpResponse(
    method: string,
    url: string,
    statusCode: number,
    duration?: number,
    extra?: Record<string, unknown>
  ): void {
    const level =
      statusCode >= 500 ? LogLevel.ERROR : statusCode >= 400 ? LogLevel.WARN : LogLevel.INFO;
    const levelName =
      level === LogLevel.ERROR ? 'ERROR' : level === LogLevel.WARN ? 'WARN' : 'INFO';

    this.logInternal(level, levelName, `${method} ${url} ${statusCode}`, {
      method,
      url,
      statusCode,
      ...(duration !== undefined && { duration }),
      ...extra,
    });
  }

  /**
   * Session lifecycle logging
   */
  static sessionEvent(
    event: 'created' | 'updated' | 'deleted' | 'expired' | 'accessed',
    sessionId: string,
    extra?: Record<string, unknown>
  ): void {
    this.debug(() => `Session ${event}: ${sessionId}`, {
      event,
      sessionId,
      ...extra,
    });
  }

  /**
   * Redis operation logging
   */
  static redisOperation(
    operation: string,
    key?: string,
    success?: boolean,
    duration?: number,
    extra?: Record<string, unknown>
  ): void {
    const level = success === false ? LogLevel.WARN : LogLevel.DEBUG;
    if (!this.isLevelEnabled(level)) return;

    const levelName = success === false ? 'WARN' : 'DEBUG';
    this.logInternal(level, levelName, `Redis ${operation}${key ? `: ${key}` : ''}`, {
      operation,
      ...(key && { key }),
      ...(success !== undefined && { success }),
      ...(duration !== undefined && { duration }),
      ...extra,
    });
  }

  /**
   * Tool execution logging with timing.
   * In silent mode: only errors are logged. Start/end phases are suppressed.
   */
  static toolExecution(
    phase: 'start' | 'end' | 'error',
    toolName: string,
    duration?: number,
    extra?: Record<string, unknown>
  ): void {
    // Silent mode: skip start/end, only log errors
    if (isSilent() && phase !== 'error') return;

    const msg = `Tool ${phase}: ${toolName}`;

    switch (phase) {
      case 'start':
        this.debug(() => msg, { tool: toolName, phase, ...extra });
        break;
      case 'end':
        this.info(msg, { tool: toolName, phase, duration, ...extra });
        break;
      case 'error':
        this.error(msg, undefined, { tool: toolName, phase, duration, ...extra });
        break;
    }
  }
}

/**
 * Performance timing decorator for methods
 * Usage: Apply to class methods to automatically log execution time
 */
export function Timed(label?: string) {
  return function (target: unknown, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;
    const timingLabel =
      label || `${(target as object).constructor?.name || 'Unknown'}.${propertyKey}`;

    descriptor.value = async function (...args: unknown[]) {
      Logger.startTiming(timingLabel);
      try {
        const result = await originalMethod.apply(this, args);
        Logger.endTiming(timingLabel, { success: true });
        return result;
      } catch (error) {
        Logger.endTiming(timingLabel, { success: false, error: String(error) });
        throw error;
      }
    };

    return descriptor;
  };
}

/**
 * Request context wrapper for automatic correlation
 * Wraps an async function to automatically set up request context
 */
export function withRequestContext<T>(
  fn: (context: RequestContext) => Promise<T>,
  sessionId?: string,
  toolName?: string
): Promise<T> {
  const context = Logger.startRequest(sessionId, toolName);

  return fn(context)
    .then((result) => {
      Logger.endRequest(context.requestId);
      return result;
    })
    .catch((error) => {
      Logger.endRequest(context.requestId);
      throw error;
    });
}
