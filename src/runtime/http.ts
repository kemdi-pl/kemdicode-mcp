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
 * HTTP Server Abstraction
 *
 * Cross-runtime HTTP server for Bun and Node.js.
 * Provides unified request/response interfaces while maintaining
 * compatibility with MCP SDK which requires Node.js objects.
 *
 * @module runtime/http
 */

import { isBun } from './index.js';
import { Logger } from '../utils/logger.js';
import type { UnifiedRequest, UnifiedResponse, ServerOptions, RequestHandler } from './types.js';

// Bun types
declare const Bun: {
  serve: (opts: {
    port: number;
    hostname: string;
    fetch: (request: Request, server: unknown) => Promise<Response> | Response;
  }) => { stop: () => void };
};

/**
 * Server instance handle
 */
export interface ServerHandle {
  /** Stop the server */
  stop: () => void;
  /** Port the server is listening on */
  port: number;
  /** Host the server is bound to */
  host: string;
}

/**
 * Wraps a Bun Request into UnifiedRequest
 */
function wrapBunRequest(request: Request): UnifiedRequest {
  const url = new URL(request.url);
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });

  return {
    url: url.pathname + url.search,
    method: request.method,
    headers,
    bunReq: request,
  };
}

/**
 * SSE Response builder for Bun
 *
 * Creates a Response with a ReadableStream for Server-Sent Events
 */
export class BunSSEResponse implements UnifiedResponse {
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  private stream: ReadableStream<Uint8Array>;
  private encoder = new TextEncoder();
  private _writableEnded = false;
  private _headers: Record<string, string> = {};
  private _status = 200;
  private responseReady: Promise<Response>;
  private resolveResponse!: (response: Response) => void;

  constructor() {
    this.stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
      },
      cancel: () => {
        this._writableEnded = true;
      },
    });

    this.responseReady = new Promise((resolve) => {
      this.resolveResponse = resolve;
    });
  }

  writeHead(status: number, headers?: Record<string, string>): void {
    this._status = status;
    if (headers) {
      Object.assign(this._headers, headers);
    }
    // Create the response now that we have headers
    this.resolveResponse(
      new Response(this.stream, {
        status: this._status,
        headers: this._headers,
      })
    );
  }

  write(chunk: string | Uint8Array): boolean {
    if (this._writableEnded || !this.controller) return false;
    try {
      const data = typeof chunk === 'string' ? this.encoder.encode(chunk) : chunk;
      this.controller.enqueue(data);
      return true;
    } catch {
      return false;
    }
  }

  end(data?: string | Uint8Array): void {
    if (this._writableEnded) return;
    if (data) this.write(data);
    try {
      this.controller?.close();
    } catch {
      // Already closed
    }
    this._writableEnded = true;
  }

  setHeader(name: string, value: string): void {
    this._headers[name] = value;
  }

  get writableEnded(): boolean {
    return this._writableEnded;
  }

  getResponse(): Promise<Response> {
    return this.responseReady;
  }
}

/**
 * Simple JSON Response builder for Bun
 */
export class BunSimpleResponse implements UnifiedResponse {
  private _headers: Record<string, string> = {};
  private _status = 200;
  private _body: string[] = [];
  private _writableEnded = false;
  private responseReady: Promise<Response>;
  private resolveResponse!: (response: Response) => void;

  constructor() {
    this.responseReady = new Promise((resolve) => {
      this.resolveResponse = resolve;
    });
  }

  writeHead(status: number, headers?: Record<string, string>): void {
    this._status = status;
    if (headers) {
      Object.assign(this._headers, headers);
    }
  }

  write(chunk: string | Uint8Array): boolean {
    if (this._writableEnded) return false;
    this._body.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
    return true;
  }

  end(data?: string | Uint8Array): void {
    if (this._writableEnded) return;
    if (data) {
      this._body.push(typeof data === 'string' ? data : new TextDecoder().decode(data));
    }
    this._writableEnded = true;
    this.resolveResponse(
      new Response(this._body.join(''), {
        status: this._status,
        headers: this._headers,
      })
    );
  }

  setHeader(name: string, value: string): void {
    this._headers[name] = value;
  }

  get writableEnded(): boolean {
    return this._writableEnded;
  }

  getResponse(): Promise<Response> {
    return this.responseReady;
  }
}

/**
 * Wraps Node.js IncomingMessage into UnifiedRequest
 */
async function wrapNodeRequest(req: import('node:http').IncomingMessage): Promise<UnifiedRequest> {
  // Read body for POST requests
  let body: string | undefined;
  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    body = Buffer.concat(chunks).toString('utf-8');
  }

  return {
    url: req.url || '/',
    method: req.method || 'GET',
    headers: req.headers as Record<string, string | string[] | undefined>,
    body,
    nodeReq: req,
  };
}

/**
 * Wraps Node.js ServerResponse into UnifiedResponse
 */
function wrapNodeResponse(res: import('node:http').ServerResponse): UnifiedResponse {
  return {
    writeHead: (status, headers) => {
      res.writeHead(status, headers);
    },
    write: (chunk) => {
      return res.write(chunk);
    },
    end: (data) => {
      res.end(data);
    },
    setHeader: (name, value) => {
      res.setHeader(name, value);
    },
    get writableEnded() {
      return res.writableEnded;
    },
    nodeRes: res,
  };
}

/**
 * Start HTTP server
 *
 * @param handler - Request handler function
 * @param options - Server options
 * @returns Server handle
 */
export async function startServer(
  handler: RequestHandler,
  options: ServerOptions
): Promise<ServerHandle> {
  const { port, host } = options;

  if (isBun) {
    const server = Bun.serve({
      port,
      hostname: host,
      fetch: async (request: Request) => {
        const unifiedReq = wrapBunRequest(request);

        // Read body for POST requests
        if (request.method === 'POST' || request.method === 'PUT' || request.method === 'PATCH') {
          unifiedReq.body = await request.text();
        }

        // Determine if this is an SSE request
        const url = new URL(request.url);
        const isSSE =
          url.pathname === '/sse' || url.pathname === '/mcp' || url.pathname.startsWith('/stream/');

        const res = isSSE ? new BunSSEResponse() : new BunSimpleResponse();

        // Run handler asynchronously
        const handlerPromise = handler(unifiedReq, res);

        if (isSSE) {
          // For SSE, start handler but return response immediately
          handlerPromise.catch((err) => {
            Logger.error('SSE handler error:', err);
            res.end();
          });
          return (res as BunSSEResponse).getResponse();
        } else {
          // For regular requests, wait for handler to complete
          await handlerPromise;
          return (res as BunSimpleResponse).getResponse();
        }
      },
    });

    return {
      stop: () => server.stop(),
      port,
      host,
    };
  } else {
    // Node.js implementation
    const { createServer } = await import('node:http');

    const server = createServer(async (req, res) => {
      try {
        const unifiedReq = await wrapNodeRequest(req);
        const unifiedRes = wrapNodeResponse(res);
        await handler(unifiedReq, unifiedRes);
      } catch (error) {
        Logger.error('Request handler error:', error);
        if (!res.writableEnded) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Internal Server Error' }));
        }
      }
    });

    return new Promise((resolve) => {
      server.listen(port, host, () => {
        resolve({
          stop: () => server.close(),
          port,
          host,
        });
      });
    });
  }
}

/**
 * Send an SSE event
 *
 * @param res - Response object
 * @param event - Event type
 * @param data - Event data
 */
export function sendSSEEvent(res: UnifiedResponse, event: string, data: unknown): void {
  if (res.writableEnded) return;
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  res.write(`event: ${event}\ndata: ${payload}\n\n`);
}

/**
 * Send SSE keepalive comment
 *
 * @param res - Response object
 */
export function sendSSEKeepalive(res: UnifiedResponse): void {
  if (res.writableEnded) return;
  res.write(': keepalive\n\n');
}

/**
 * Get allowed CORS origin from environment or default to localhost
 * In production, set MCP_CORS_ORIGIN to restrict access
 */
function getCorsOrigin(): string {
  return process.env.MCP_CORS_ORIGIN || 'http://127.0.0.1:*';
}

/**
 * Standard CORS headers
 * Origin is configurable via MCP_CORS_ORIGIN env var
 * Default: 'http://127.0.0.1:*' (localhost only)
 * Set to '*' only for development
 */
export const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': getCorsOrigin(),
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, mcp-session-id, x-project-path, x-request-id',
  'Access-Control-Expose-Headers': 'mcp-session-id, x-request-id',
};

/**
 * SSE response headers
 */
export const SSE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
  ...CORS_HEADERS,
};

/**
 * JSON response headers
 */
export const JSON_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
  ...CORS_HEADERS,
};

/**
 * Apply CORS headers to response
 */
export function applyCORSHeaders(res: UnifiedResponse): void {
  Object.entries(CORS_HEADERS).forEach(([key, value]) => {
    res.setHeader(key, value);
  });
}
