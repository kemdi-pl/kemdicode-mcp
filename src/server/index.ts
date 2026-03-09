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
