/**
 * KemdiCode MCP Server - Progress Tracking
 * Copyright (C) 2025-2026 Kemdi Sp. z o.o.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

/**
 * Progress Tracking Module
 *
 * Manages per-request progress state, SSE events, and MCP notifications.
 *
 * @module server/progress
 */

import type { ServerResponse } from 'node:http';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { PROTOCOL } from '../constants.js';
import { Logger } from '../utils/logger.js';
import { SSEEventType, type ProgressState, type ProgressData } from './types.js';

// Re-export for convenience
export { SSEEventType, type ProgressState, type ProgressData } from './types.js';

/** Map of request IDs to their progress states */
const progressStates = new Map<string | number, ProgressState>();

/**
 * Pre-serialized static SSE event type prefixes (avoid repeated string concatenation)
 */
const SSE_EVENT_PREFIXES: Record<SSEEventType, string> = {
  [SSEEventType.CONNECTED]: 'event: connected\ndata: ',
  [SSEEventType.PROGRESS]: 'event: progress\ndata: ',
  [SSEEventType.RESULT]: 'event: result\ndata: ',
  [SSEEventType.ERROR]: 'event: error\ndata: ',
  [SSEEventType.KEEPALIVE]: 'event: keepalive\ndata: ',
  [SSEEventType.LOG]: 'event: log\ndata: ',
};

/**
 * Send SSE event to client with optimized serialization
 * @param res - HTTP response object
 * @param eventType - Type of SSE event
 * @param data - Event data
 */
export function sendSSEEvent(res: ServerResponse, eventType: SSEEventType, data: unknown): void {
  if (res.writableEnded) return;

  // Use pre-computed event prefix and only serialize data once
  const prefix = SSE_EVENT_PREFIXES[eventType];
  const payload = typeof data === 'string' ? data : JSON.stringify(data);

  // Single write operation with template literal (faster than concatenation)
  res.write(`${prefix}${payload}\n\n`);
}

/**
 * Send progress notification to MCP client
 * @param token - Progress token from client
 * @param progress - Progress value (0-100)
 * @param message - Optional progress message
 * @param mcpServer - MCP server instance for notifications
 */
export async function sendProgress(
  token: string | number | undefined,
  progress: number,
  message?: string,
  mcpServer?: Server
): Promise<void> {
  if (!token || !mcpServer) return;
  try {
    await mcpServer.notification({
      method: PROTOCOL.NOTIFICATIONS.PROGRESS,
      params: { progressToken: token, progress, ...(message && { message }) },
    });

    // Also send to SSE stream if available
    const state = progressStates.get(token);
    if (state?.sseResponse) {
      sendSSEEvent(state.sseResponse, SSEEventType.PROGRESS, {
        progress,
        message,
        operation: state.operation,
      });
    }
  } catch {
    /* ignore */
  }
}

/**
 * Start progress tracking for an operation
 * @param operation - Operation name for display
 * @param token - Progress token from client
 * @param mcpServer - MCP server instance
 * @param sseResponse - SSE response for streaming
 * @returns Progress tracking data
 */
export function startProgress(
  operation: string,
  token?: string | number,
  mcpServer?: Server,
  sseResponse?: ServerResponse
): ProgressData {
  const requestId = token || `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const state: ProgressState = {
    isProcessing: true,
    operation,
    latestOutput: '',
    sseResponse,
  };
  progressStates.set(requestId, state);

  if (token) sendProgress(token, 0, `Starting ${operation}`, mcpServer);

  const messages = [
    `Analyzing...`,
    `Processing files...`,
    `Generating response...`,
    `Large analysis in progress...`,
    `Still working...`,
  ];

  let idx = 0;
  let progress = 0;

  const interval = setInterval(() => {
    try {
      const currentState = progressStates.get(requestId);
      if (!currentState?.isProcessing) {
        clearInterval(interval);
        progressStates.delete(requestId);
        return;
      }
      if (token) {
        progress++;
        const preview = currentState.latestOutput.slice(-100).trim();
        const progressPromise = sendProgress(
          token,
          progress,
          `${messages[idx++ % messages.length]}${preview ? `\n${preview}` : ''}`,
          mcpServer
        );
        if (progressPromise && typeof progressPromise.catch === 'function') {
          progressPromise.catch((err: Error) => {
            Logger.error(`[Progress] Error sending progress: ${err}`);
            clearInterval(interval);
            progressStates.delete(requestId);
          });
        }
      }
    } catch (error) {
      Logger.error(`[Progress] Error in progress interval: ${error}`);
      clearInterval(interval);
      progressStates.delete(requestId);
    }
  }, PROTOCOL.KEEPALIVE_INTERVAL);

  return { interval, token, requestId, mcpServer };
}

/**
 * Stop progress tracking and send completion notification
 * @param data - Progress tracking data
 * @param success - Whether operation completed successfully
 */
export function stopProgress(data: ProgressData, success = true): void {
  const state = progressStates.get(data.requestId);
  if (state) {
    state.isProcessing = false;
    if (data.token) {
      sendProgress(
        data.token,
        100,
        success ? `Done: ${state.operation}` : `Failed: ${state.operation}`,
        data.mcpServer
      );

      // Send final SSE event if streaming
      if (state.sseResponse && !state.sseResponse.writableEnded) {
        sendSSEEvent(state.sseResponse, success ? SSEEventType.RESULT : SSEEventType.ERROR, {
          status: success ? 'complete' : 'failed',
          operation: state.operation,
        });
      }
    }
    progressStates.delete(data.requestId);
  }
  clearInterval(data.interval);
}

/**
 * Update latest output for progress display
 * @param requestId - Request identifier
 * @param output - Latest output string
 */
export function updateProgressOutput(requestId: string | number, output: string): void {
  const state = progressStates.get(requestId);
  if (state) {
    state.latestOutput = output;
  }
}

/**
 * Get progress state for a request (for external SSE connection)
 * @param requestId - Request identifier
 * @returns Progress state or undefined
 */
export function getProgressState(requestId: string | number): ProgressState | undefined {
  return progressStates.get(requestId);
}

/**
 * Set SSE response for an existing progress state (used by stream endpoint)
 * @param requestId - Request identifier
 * @param sseResponse - SSE response
 */
export function setProgressSSEResponse(
  requestId: string | number,
  sseResponse: ServerResponse | undefined
): void {
  const state = progressStates.get(requestId);
  if (state) {
    state.sseResponse = sseResponse;
  }
}

/**
 * Delete progress state
 * @param requestId - Request identifier
 */
export function deleteProgressState(requestId: string | number): void {
  progressStates.delete(requestId);
}
