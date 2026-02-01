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

import type { Redis } from 'ioredis';
import { getSharedRedis } from './connection.js';
import { Logger } from '../../utils/logger.js';

/**
 * Base class for services that depend on a shared Redis connection.
 * Eliminates duplicated connect/disconnect/isConnected boilerplate.
 */
export abstract class RedisBackedService {
  protected redis: Redis | null = null;
  private _connected = false;

  protected abstract get serviceName(): string;

  async connect(): Promise<void> {
    if (this._connected) return;

    try {
      this.redis = await getSharedRedis();
      this._connected = true;
    } catch (error) {
      Logger.error(`[${this.serviceName}] Failed to connect to Redis:`, error);
      this.redis = null;
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    // Don't quit shared Redis connection, just release reference
    this.redis = null;
    this._connected = false;
  }

  isConnected(): boolean {
    return this._connected && this.redis !== null;
  }

  /**
   * Inject Redis instance (for testing)
   */
  injectRedis(redis: Redis): void {
    this.redis = redis;
    this._connected = true;
  }
}
