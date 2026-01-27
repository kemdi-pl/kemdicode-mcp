/**
 * KemdiCode MCP Server - HTTP Server
 * Copyright (C) 2025-2026 Kemdi Sp. z o.o.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

/**
 * HTTP Server Module
 *
 * Main HTTP server with SSE streaming, MCP endpoints, and request routing.
 *
 * @module server/http-server
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Logger, LogLevel } from '../utils/logger.js';
import { config } from '../config/index.js';
import { getToolDefinitions } from '../tools/index.js';
import {
  sendSSEEvent,
  getProgressState,
  setProgressSSEResponse,
  deleteProgressState,
  SSEEventType,
} from './progress.js';
import {
  getOrCreateTransport,
  deleteSessionConfig,
  getAllSessionConfigs,
  generateSessionId,
} from './session-server.js';
import { VERSION } from './types.js';

/**
 * Start HTTP server for multi-agent scenarios
 * Supports concurrent connections with SSE streaming
 * @param host - Server host
 * @param port - Server port
 */
import type { Server } from 'node:http';

/**
 * HTTP Server instance for graceful shutdown
 */
let serverInstance: Server | null = null;

/**
 * Get the HTTP server instance
 */
export function getHttpServer(): Server | null {
  return serverInstance;
}

/**
 * Stop the HTTP server gracefully
 */
export async function stopHttpServer(): Promise<void> {
  return new Promise((resolve) => {
    if (serverInstance) {
      serverInstance.close(() => {
        Logger.info('HTTP server closed');
        serverInstance = null;
        resolve();
      });
    } else {
      resolve();
    }
  });
}

export async function startHttpServer(host: string, port: number): Promise<Server> {
  // Track active transports by session ID
  const transports = new Map<string, StreamableHTTPServerTransport>();
  // Track SSE keep-alive intervals
  const keepAliveIntervals = new Map<string, NodeJS.Timeout>();
  // Track active tool execution streams
  const executionStreams = new Map<string, ServerResponse>();

  const httpServer = createServer(async (req, res) => {
    const requestStartTime = Date.now();
    const requestId = Logger.generateRequestId();
    Logger.setRequestId(requestId);

    // CORS headers for cross-origin requests
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, mcp-session-id, x-project-path, x-request-id'
    );
    res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id, x-request-id');
    res.setHeader('X-Request-Id', requestId);

    const url = req.url || '/';
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    // Log incoming request (skip health checks at debug level)
    if (url !== '/health' || Logger.isLevelEnabled(LogLevel.DEBUG)) {
      Logger.httpRequest(req.method || 'GET', url, sessionId, { requestId });
    }

    // Helper to log response and clear request ID
    const finishRequest = (statusCode: number) => {
      const duration = Date.now() - requestStartTime;
      if (url !== '/health' || statusCode >= 400) {
        Logger.httpResponse(req.method || 'GET', url, statusCode, duration, { requestId });
      }
      Logger.clearRequestId();
    };

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      finishRequest(200);
      return;
    }

    // Health check endpoint
    if (url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'ok',
          version: VERSION,
          activeSessions: transports.size,
          activeStreams: executionStreams.size,
          model: config.get('server').primaryModel,
        })
      );
      finishRequest(200);
      return;
    }

    // List available tools endpoint
    if (url === '/tools' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ tools: getToolDefinitions() }));
      finishRequest(200);
      return;
    }

    // Stream endpoint for long-running operations
    // GET /stream/:requestId - Subscribe to tool execution progress
    const streamMatch = url.match(/^\/stream\/([^/]+)$/);
    if (streamMatch && req.method === 'GET') {
      const streamRequestId = streamMatch[1];

      // SSE headers
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Request-Id': streamRequestId,
      });

      // Send connection event
      sendSSEEvent(res, SSEEventType.CONNECTED, { requestId: streamRequestId });

      // Store for progress updates
      executionStreams.set(streamRequestId, res);

      // Check if there's already a progress state for this request
      const existingState = getProgressState(streamRequestId);
      if (existingState) {
        setProgressSSEResponse(streamRequestId, res);
      }

      // Cleanup on close
      req.on('close', () => {
        executionStreams.delete(streamRequestId);
        setProgressSSEResponse(streamRequestId, undefined);
      });

      // Keep alive
      const keepAlive = setInterval(() => {
        if (!res.writableEnded) {
          sendSSEEvent(res, SSEEventType.KEEPALIVE, { timestamp: Date.now() });
        } else {
          clearInterval(keepAlive);
        }
      }, 30000);

      // SSE endpoints don't finish immediately
      Logger.debug(() => `SSE stream connected: ${streamRequestId}`);
      return;
    }

    // SSE endpoint for Claude Code (also accept /mcp for compatibility)
    if (url === '/sse' || (url === '/mcp' && req.method === 'GET')) {
      const sseSessionId = sessionId || generateSessionId();

      // Get or create transport
      const { transport, isNew } = await getOrCreateTransport(sseSessionId, transports, req);

      if (isNew) {
        Logger.sessionEvent('created', sseSessionId, {
          source: 'sse',
          cwd: getAllSessionConfigs().get(sseSessionId)?.cwd,
        });
        transport.onclose = () => {
          transports.delete(sseSessionId);
          deleteSessionConfig(sseSessionId);
          const interval = keepAliveIntervals.get(sseSessionId);
          if (interval) {
            clearInterval(interval);
            keepAliveIntervals.delete(sseSessionId);
          }
          Logger.sessionEvent('deleted', sseSessionId);
        };
      }

      // SSE headers
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'mcp-session-id': sseSessionId,
        'Access-Control-Allow-Origin': '*',
      });

      // Send initial connection event
      res.write(`event: endpoint\ndata: /message?sessionId=${sseSessionId}\n\n`);

      // Keep connection alive
      const keepAlive = setInterval(() => {
        if (!res.writableEnded) {
          res.write(`: keepalive\n\n`);
        } else {
          clearInterval(keepAlive);
        }
      }, 30000);
      keepAliveIntervals.set(sseSessionId, keepAlive);

      // Cleanup on close
      req.on('close', () => {
        const interval = keepAliveIntervals.get(sseSessionId);
        if (interval) {
          clearInterval(interval);
          keepAliveIntervals.delete(sseSessionId);
        }
      });

      return;
    }

    // Message endpoint for SSE
    if (url.startsWith('/message')) {
      const urlParams = new URL(url, `http://${req.headers.host}`).searchParams;
      const msgSessionId = urlParams.get('sessionId') || sessionId;

      if (!msgSessionId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing sessionId' }));
        finishRequest(400);
        return;
      }

      const { transport, isNew } = await getOrCreateTransport(msgSessionId, transports, req);

      if (isNew) {
        Logger.sessionEvent('created', msgSessionId, { source: 'message' });
      }

      transport.onclose = () => {
        transports.delete(msgSessionId);
        deleteSessionConfig(msgSessionId);
        const interval = keepAliveIntervals.get(msgSessionId);
        if (interval) {
          clearInterval(interval);
          keepAliveIntervals.delete(msgSessionId);
        }
        Logger.sessionEvent('deleted', msgSessionId);
      };

      await transport.handleRequest(req, res);
      finishRequest(200);
      return;
    }

    // MCP endpoint (POST for messages, GET handled above for SSE)
    if (url.startsWith('/mcp')) {
      const mcpSessionId = sessionId;

      if (req.method === 'POST') {
        let transport: StreamableHTTPServerTransport;

        if (mcpSessionId && transports.has(mcpSessionId)) {
          transport = transports.get(mcpSessionId)!;
        } else {
          // Create new transport
          const newSessionId = mcpSessionId || generateSessionId();
          const result = await getOrCreateTransport(newSessionId, transports, req);
          transport = result.transport;

          if (result.isNew) {
            Logger.sessionEvent('created', newSessionId, { source: 'mcp-post' });
            transport.onclose = () => {
              const closedSessionId = transport.sessionId;
              if (closedSessionId) {
                transports.delete(closedSessionId);
                deleteSessionConfig(closedSessionId);
                Logger.sessionEvent('deleted', closedSessionId);
              }
            };
          }
        }

        await transport.handleRequest(req, res);
        finishRequest(200);
        return;
      }

      // DELETE to close session
      if (req.method === 'DELETE' && mcpSessionId) {
        const transport = transports.get(mcpSessionId);
        if (transport) {
          await transport.close();
          transports.delete(mcpSessionId);
          deleteSessionConfig(mcpSessionId);
          Logger.sessionEvent('deleted', mcpSessionId, { source: 'explicit-delete' });
          res.writeHead(200);
          res.end(JSON.stringify({ status: 'closed', sessionId: mcpSessionId }));
          finishRequest(200);
        } else {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'Session not found' }));
          finishRequest(404);
        }
        return;
      }
    }

    // 404 for other routes
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
    finishRequest(404);
  });

  httpServer.listen(port, host, () => {
    Logger.info(`HTTP MCP server v${VERSION} running at http://${host}:${port}/mcp`);
    Logger.info(`Health check: http://${host}:${port}/health`);
    Logger.info(`Tool list: http://${host}:${port}/tools`);
    Logger.info(`Stream endpoint: http://${host}:${port}/stream/:requestId`);
    Logger.info(`Multiple agents can now connect simultaneously!`);
  });

  serverInstance = httpServer;
  return httpServer;
}
