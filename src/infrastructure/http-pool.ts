/**
 * KemdiCode MCP Server - HTTP Connection Pool
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

import http from 'node:http';
import https from 'node:https';

interface ConnectionPool {
  idle: http.Agent[];
  active: Map<http.Agent, number>;
  host: string;
  maxIdle: number;
  maxTotal: number;
  createdAt: number;
  lastUsed: number;
  requestsInProgress: number;
}

export interface HttpPoolConfig {
  maxTotal?: number;
  maxIdle?: number;
  connectTimeout?: number;
  requestTimeout?: number;
  keepAliveMs?: number;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  headers?: Record<string, string>;
  body?: string | object;
  timeout?: number;
  retries?: number;
  retryDelay?: number;
}

interface PoolStats {
  totalConnections: number;
  idleConnections: number;
  activeRequests: number;
  queuedRequests: number;
}

class HttpConnectionPool {
  private pools = new Map<string, ConnectionPool>();
  private config: Required<HttpPoolConfig>;
  private stats = {
    totalRequests: 0,
  };

  constructor(config: HttpPoolConfig = {}) {
    this.config = {
      maxTotal: config.maxTotal ?? 10,
      maxIdle: config.maxIdle ?? 5,
      connectTimeout: config.connectTimeout ?? 5000,
      requestTimeout: config.requestTimeout ?? 30000,
      keepAliveMs: config.keepAliveMs ?? 30000,
    };
  }

  private getOrCreatePool(host: string, _isHttps: boolean): ConnectionPool {
    let pool = this.pools.get(host);

    if (!pool) {
      pool = {
        idle: [],
        active: new Map(),
        host,
        maxIdle: this.config.maxIdle,
        maxTotal: this.config.maxTotal,
        createdAt: Date.now(),
        lastUsed: Date.now(),
        requestsInProgress: 0,
      };
      this.pools.set(host, pool);
    }

    return pool;
  }

  async request(url: string, options: RequestOptions = {}): Promise<unknown> {
    const urlObj = new URL(url);
    const isHttps = urlObj.protocol === 'https:';
    const host = urlObj.host;
    const pool = this.getOrCreatePool(host, isHttps);

    const maxRetries = options.retries ?? 2;
    const retryDelay = options.retryDelay ?? 500;

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const agent = new (isHttps ? https.Agent : http.Agent)({
          keepAlive: true,
          keepAliveMsecs: this.config.keepAliveMs,
          maxSockets: pool.maxTotal,
          maxFreeSockets: pool.maxIdle,
          timeout: this.config.connectTimeout,
        });

        pool.requestsInProgress++;
        this.stats.totalRequests++;

        const response = await this.executeRequest(agent, urlObj, options);
        pool.requestsInProgress = Math.max(0, pool.requestsInProgress - 1);

        if (pool.idle.length < pool.maxIdle) {
          pool.idle.push(agent);
        } else {
          agent.destroy();
        }

        pool.lastUsed = Date.now();
        return response;
      } catch (error) {
        lastError = error as Error;
        if (attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, retryDelay * (attempt + 1)));
        }
      }
    }

    throw lastError;
  }

  private executeRequest(agent: http.Agent, url: URL, options: RequestOptions): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timeout = options.timeout ?? this.config.requestTimeout;
      const timer = setTimeout(() => reject(new Error('Request timeout')), timeout);

      const reqOptions: http.RequestOptions = {
        method: options.method ?? 'GET',
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        headers: {
          Connection: 'keep-alive',
          'Accept-Encoding': 'gzip, deflate',
          ...options.headers,
        },
        agent,
      };

      const req = (url.protocol === 'https:' ? https : http).request(reqOptions, (res) => {
        clearTimeout(timer);

        let data = '';
        res.on('data', (chunk: Buffer) => {
          data += chunk;
        });

        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
          } else {
            resolve({
              status: res.statusCode,
              headers: res.headers,
              body: data,
              url: url.toString(),
            });
          }
        });
      });

      req.on('error', (error: Error) => {
        clearTimeout(timer);
        reject(error);
      });

      if (options.body) {
        const body = typeof options.body === 'object' ? JSON.stringify(options.body) : options.body;
        req.write(body);
      }

      req.end();
    });
  }

  async get<T = unknown>(url: string, headers?: Record<string, string>): Promise<T> {
    return this.request(url, { method: 'GET', headers }) as Promise<T>;
  }

  async post<T = unknown>(
    url: string,
    body?: string | object,
    headers?: Record<string, string>
  ): Promise<T> {
    return this.request(url, {
      method: 'POST',
      body,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
    }) as Promise<T>;
  }

  async closeIdleConnections(): Promise<number> {
    let closed = 0;

    for (const pool of this.pools.values()) {
      const now = Date.now();
      const idleConnections = [...pool.idle];
      for (const conn of idleConnections) {
        if (now - pool.lastUsed > this.config.keepAliveMs) {
          const idx = pool.idle.indexOf(conn);
          if (idx > -1) {
            pool.idle.splice(idx, 1);
            conn.destroy();
            closed++;
          }
        }
      }
    }

    return closed;
  }

  async destroy(): Promise<void> {
    for (const pool of this.pools.values()) {
      for (const conn of pool.idle) {
        conn.destroy();
      }
      for (const [conn] of pool.active) {
        conn.destroy();
      }
    }
    this.pools.clear();
  }

  getStats(): PoolStats {
    let totalConnections = 0;
    let idleConnections = 0;
    let activeRequests = 0;

    for (const pool of this.pools.values()) {
      totalConnections += pool.idle.length + pool.active.size;
      idleConnections += pool.idle.length;
      activeRequests += pool.requestsInProgress;
    }

    return {
      totalConnections,
      idleConnections,
      activeRequests,
      queuedRequests: 0,
    };
  }
}

export const httpPool = new HttpConnectionPool();

export { HttpConnectionPool };
