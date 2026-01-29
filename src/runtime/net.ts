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
 * Network Abstraction
 *
 * Cross-runtime network utilities for Bun and Node.js.
 *
 * @module runtime/net
 */

import { createConnection } from 'net';
import { isBun } from './index.js';
import type { SocketCheckOptions } from './types.js';

// Bun types
declare const Bun: {
  connect: (opts: {
    hostname: string;
    port: number;
    socket: {
      open: (socket: { end: () => void }) => void;
      error: (socket: unknown, error: Error) => void;
      close: () => void;
      data: () => void;
    };
  }) => Promise<{ end: () => void }>;
};

/**
 * Check if a port is open (something is listening)
 *
 * @param options - Socket check options
 * @returns Promise resolving to true if port is open
 */
export async function isPortOpen(options: SocketCheckOptions): Promise<boolean> {
  const { host, port, timeout = 5000 } = options;

  if (isBun) {
    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => resolve(false), timeout);

      Bun.connect({
        hostname: host,
        port,
        socket: {
          open: (socket) => {
            clearTimeout(timeoutId);
            socket.end();
            resolve(true);
          },
          error: () => {
            clearTimeout(timeoutId);
            resolve(false);
          },
          close: () => {},
          data: () => {},
        },
      }).catch(() => {
        clearTimeout(timeoutId);
        resolve(false);
      });
    });
  } else {
    // Node.js implementation
    return new Promise((resolve) => {
      const socket = createConnection({ port, host });

      const timeoutId = setTimeout(() => {
        socket.destroy();
        resolve(false);
      }, timeout);

      socket.once('connect', () => {
        clearTimeout(timeoutId);
        socket.destroy();
        resolve(true);
      });

      socket.once('error', () => {
        clearTimeout(timeoutId);
        socket.destroy();
        resolve(false);
      });
    });
  }
}

/**
 * Wait for a port to become available (open)
 *
 * @param options - Socket check options
 * @param maxWait - Maximum time to wait in milliseconds
 * @param interval - Check interval in milliseconds
 * @returns Promise resolving to true if port becomes available
 */
export async function waitForPort(
  options: SocketCheckOptions,
  maxWait = 30000,
  interval = 500
): Promise<boolean> {
  const startTime = Date.now();

  while (Date.now() - startTime < maxWait) {
    if (await isPortOpen(options)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }

  return false;
}

/**
 * Check if a port is free (nothing listening)
 *
 * @param options - Socket check options
 * @returns Promise resolving to true if port is free
 */
export async function isPortFree(options: SocketCheckOptions): Promise<boolean> {
  return !(await isPortOpen(options));
}
