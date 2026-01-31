/**
 * KemdiCode MCP Server - Server Types
 * Copyright (C) 2025-2026 Kemdi Sp. z o.o.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

/**
 * Server Types Module
 *
 * Type definitions for HTTP server, SSE, sessions, and progress tracking.
 *
 * @module server/types
 */

import type { ServerResponse } from 'node:http';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

// Re-export VERSION from central version file
export { VERSION } from '../version.js';

/**
 * SSE Event types for streaming responses
 */
export enum SSEEventType {
  PROGRESS = 'progress',
  RESULT = 'result',
  ERROR = 'error',
  CONNECTED = 'connected',
  KEEPALIVE = 'keepalive',
  LOG = 'log',
}

/**
 * Server configuration interface
 * @interface ServerConfig
 */
export interface ServerConfig {
  /** Primary model for KemdiCode AI */
  primaryModel: string;
  /** Fallback model when quota exceeded */
  fallbackModel?: string;
  /** API base URL for KemdiCode AI */
  apiBaseUrl?: string;
  /** API key for KemdiCode AI */
  apiKey?: string;
}

/**
 * Session configuration interface
 * @interface SessionConfig
 */
export interface SessionConfig {
  /** Unique session identifier */
  sessionId: string;
  /** Current working directory for this session */
  cwd: string;
  /** Model override for this session */
  model?: string;
  /** Project type (auto-detected) */
  projectType?: string;
}

/**
 * Per-request progress state for tracking concurrent operations
 * @interface ProgressState
 */
export interface ProgressState {
  /** Whether operation is currently processing */
  isProcessing: boolean;
  /** Name of the operation */
  operation: string;
  /** Latest output for progress display */
  latestOutput: string;
  /** SSE response for streaming (if applicable) */
  sseResponse?: ServerResponse;
}

/**
 * Progress tracking data returned by startProgress
 * @interface ProgressData
 */
export interface ProgressData {
  interval: NodeJS.Timeout;
  token?: string | number;
  requestId: string | number;
  mcpServer?: Server;
}

// ToolArguments type is re-exported from tools/registry.js
// Use: import type { ToolArguments } from '../tools/registry.js';
