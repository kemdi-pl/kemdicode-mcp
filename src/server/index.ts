/**
 * KemdiCode MCP Server - Server Module
 * Copyright (C) 2025-2026 Kemdi Sp. z o.o.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

/**
 * Server Module
 *
 * HTTP server, SSE streaming, session management, and progress tracking.
 *
 * @module server
 */

// Types
export {
  VERSION,
  SSEEventType,
  type ServerConfig,
  type SessionConfig,
  type ProgressState,
  type ProgressData,
} from './types.js';
export type { ToolArguments } from '../tools/registry.js';

// Progress tracking
export {
  sendSSEEvent,
  sendProgress,
  startProgress,
  stopProgress,
  updateProgressOutput,
  getProgressState,
  setProgressSSEResponse,
  deleteProgressState,
} from './progress.js';

// Session management
export {
  resolveCwd,
  getSessionConfig,
  setSessionConfig,
  deleteSessionConfig,
  getAllSessionConfigs,
  getAllSessionServers,
  broadcastNotification,
  createSessionServer,
  getOrCreateTransport,
  generateSessionId,
  recordSessionActivity,
  getSessionActivity,
  getAllSessionActivity,
  deleteSessionActivity,
} from './session-server.js';

// HTTP server
export { startHttpServer, stopHttpServer, getHttpServer } from './http-server.js';
