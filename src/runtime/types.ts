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
 * Runtime Types
 *
 * Unified type definitions for cross-runtime compatibility (Bun/Node.js).
 *
 * @module runtime/types
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Runtime identifier
 */
export type RuntimeType = 'bun' | 'node';

/**
 * Unified HTTP request interface
 */
export interface UnifiedRequest {
  /** Request URL path */
  url: string;
  /** HTTP method */
  method: string;
  /** Request headers */
  headers: Record<string, string | string[] | undefined>;
  /** Request body as string (for POST) */
  body?: string;
  /** Raw Node.js request (for MCP SDK compatibility) */
  nodeReq?: IncomingMessage;
  /** Raw Bun request */
  bunReq?: Request;
}

/**
 * Unified HTTP response interface
 */
export interface UnifiedResponse {
  /** Write response head with status and headers */
  writeHead(status: number, headers?: Record<string, string>): void;
  /** Write chunk to response body */
  write(chunk: string | Uint8Array): boolean;
  /** End response */
  end(data?: string | Uint8Array): void;
  /** Set single header */
  setHeader(name: string, value: string): void;
  /** Check if response has been ended */
  readonly writableEnded: boolean;
  /** Raw Node.js response (for MCP SDK compatibility) */
  nodeRes?: ServerResponse;
}

/**
 * HTTP server options
 */
export interface ServerOptions {
  port: number;
  host: string;
}

/**
 * HTTP request handler signature
 */
export type RequestHandler = (req: UnifiedRequest, res: UnifiedResponse) => Promise<void>;

/**
 * Spawn options for child processes
 */
export interface SpawnOptions {
  /** Working directory */
  cwd?: string;
  /** Environment variables */
  env?: Record<string, string | undefined>;
  /** Timeout in milliseconds */
  timeout?: number;
  /** Use shell for execution */
  shell?: boolean;
  /** Maximum buffer size for stdout/stderr */
  maxBuffer?: number;
}

/**
 * Spawn result
 */
export interface SpawnResult {
  /** Standard output */
  stdout: string;
  /** Standard error */
  stderr: string;
  /** Exit code (null if process was killed) */
  exitCode: number | null;
  /** Whether process timed out */
  timedOut?: boolean;
  /** Whether process was killed */
  killed?: boolean;
}

/**
 * Streaming spawn options
 */
export interface StreamingSpawnOptions extends SpawnOptions {
  /** Callback for stdout data */
  onStdout?: (data: string) => void;
  /** Callback for stderr data */
  onStderr?: (data: string) => void;
}

/**
 * Subprocess handle for streaming spawns
 */
export interface SubprocessHandle {
  /** Process ID */
  pid: number | undefined;
  /** Kill the process */
  kill(signal?: string): boolean;
  /** Wait for process to exit */
  wait(): Promise<SpawnResult>;
  /** Whether process has exited */
  readonly exited: boolean;
}

/**
 * Socket check options
 */
export interface SocketCheckOptions {
  host: string;
  port: number;
  timeout?: number;
}

/**
 * Timer handle type (compatible with both runtimes)
 */
export type TimerHandle = ReturnType<typeof setTimeout>;

/**
 * Interval handle type (compatible with both runtimes)
 */
export type IntervalHandle = ReturnType<typeof setInterval>;
