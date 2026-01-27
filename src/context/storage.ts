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
 * Redis-based Context Storage Module
 *
 * Provides persistent storage for MCP context entries, enabling cross-server
 * sharing between KemdiCode MCP and other MCP servers (PHP, etc.). Uses Redis
 * database 2 to avoid conflicts with Laravel cache (db 1) and default (db 0).
 *
 * @module context/storage
 */

import { Redis } from 'ioredis';
import { Logger } from '../utils/logger.js';
import {
  McpContextEntry,
  McpSession,
  ContextQuery,
  RedisConfig,
  ServerIdentifier,
  REDIS_KEYS,
  TTL,
} from './types.js';

/**
 * Context Storage Class
 *
 * Manages Redis-based storage for MCP context entries. Provides indexing by
 * server, tool, tag, and session for efficient querying. Supports TTL-based
 * automatic expiration.
 *
 * @class ContextStorage
 * @example
 * ```typescript
 * const storage = await initContextStorage({ host: '127.0.0.1' });
 * await storage.saveContext(entry);
 * const entries = await storage.queryContext({ sessionId: 'sess_123' });
 * ```
 */
export class ContextStorage {
  /** Redis client instance */
  private redis: Redis | null = null;
  /** Key prefix for all Redis keys */
  private readonly prefix: string;
  /** Connection status flag */
  private connected = false;

  /**
   * Create a new ContextStorage instance
   *
   * @param {RedisConfig} config - Redis connection configuration
   */
  constructor(private readonly config: RedisConfig = {}) {
    this.prefix = REDIS_KEYS.PREFIX;
  }

  /**
   * Initialize Redis connection
   *
   * @description Establishes connection to Redis with retry strategy. Uses
   *              environment variables as fallback for connection settings.
   * @returns {Promise<boolean>} True if connection succeeded, false otherwise
   * @throws {Error} Does not throw - returns false on failure
   * @example
   * ```typescript
   * const storage = new ContextStorage({ host: 'redis.local' });
   * const connected = await storage.connect();
   * ```
   */
  async connect(): Promise<boolean> {
    if (this.connected && this.redis) {
      return true;
    }

    try {
      this.redis = new Redis({
        host: this.config.host || process.env.REDIS_HOST || '127.0.0.1',
        port: this.config.port || parseInt(process.env.REDIS_PORT || '6379'),
        password: this.config.password || process.env.REDIS_PASSWORD || undefined,
        db: this.config.db ?? 2, // MCP context database
        keyPrefix: this.prefix,
        lazyConnect: false,
        maxRetriesPerRequest: 3,
        retryStrategy: (times: number) => {
          if (times > 3) {
            Logger.error('Redis connection failed after 3 retries');
            return null;
          }
          return Math.min(times * 100, 1000);
        },
      });

      // Test connection
      await this.redis!.ping();
      this.connected = true;
      Logger.debug('Context storage connected to Redis');
      return true;
    } catch (error) {
      Logger.error('Failed to connect to Redis:', error);
      this.redis = null;
      this.connected = false;
      return false;
    }
  }

  /**
   * Check if storage is available
   *
   * @description Returns the current connection status
   * @returns {boolean} True if Redis is connected and operational
   */
  isConnected(): boolean {
    return this.connected && this.redis !== null;
  }

  /**
   * Gracefully disconnect from Redis
   *
   * @description Closes the Redis connection cleanly. Should be called during
   *              server shutdown to avoid connection leaks.
   * @returns {Promise<void>}
   */
  async disconnect(): Promise<void> {
    if (this.redis) {
      await this.redis.quit();
      this.redis = null;
      this.connected = false;
    }
  }

  /**
   * Save a context entry to Redis with indexes
   *
   * @description Persists a context entry and updates multiple indexes:
   *              - Server index: entries by server ID
   *              - Tool index: entries by tool name
   *              - Tag indexes: entries by each tag
   *              - Session index: sorted set by timestamp
   * @param {McpContextEntry} entry - The context entry to save
   * @returns {Promise<boolean>} True if save succeeded, false otherwise
   * @example
   * ```typescript
   * await storage.saveContext({
   *   id: 'entry_123',
   *   sessionId: 'sess_abc',
   *   serverId: 'kemdicode-mcp',
   *   toolName: 'code-review',
   *   args: { files: '@src/index.ts' },
   *   output: 'Review completed...',
   *   timestamp: Date.now(),
   *   tags: ['review', 'security']
   * });
   * ```
   */
  async saveContext(entry: McpContextEntry): Promise<boolean> {
    if (!this.redis) {
      Logger.warn('Context storage not connected, skipping save');
      return false;
    }

    const startTime = Date.now();
    const key = `${REDIS_KEYS.CONTEXT}${entry.sessionId}:${entry.id}`;

    try {
      const ttl = entry.ttl || TTL.DEFAULT;

      const pipeline = this.redis.pipeline();

      // Save entry
      pipeline.setex(key, ttl, JSON.stringify(entry));

      // Update indexes
      pipeline.sadd(`${REDIS_KEYS.INDEX_SERVER}${entry.serverId}`, entry.id);
      pipeline.sadd(`${REDIS_KEYS.INDEX_TOOL}${entry.toolName}`, entry.id);

      for (const tag of entry.tags) {
        pipeline.sadd(`${REDIS_KEYS.INDEX_TAG}${tag}`, entry.id);
      }

      // Session index (sorted set by timestamp)
      pipeline.zadd(`${REDIS_KEYS.INDEX_SESSION}${entry.sessionId}`, entry.timestamp, entry.id);

      // Set TTL on session index
      pipeline.expire(`${REDIS_KEYS.INDEX_SESSION}${entry.sessionId}`, TTL.SESSION);

      await pipeline.exec();
      const duration = Date.now() - startTime;
      Logger.redisOperation('saveContext', key, true, duration, {
        tool: entry.toolName,
        ttl,
        indexCount: entry.tags.length + 3,
      });
      return true;
    } catch (error) {
      const duration = Date.now() - startTime;
      Logger.redisOperation('saveContext', key, false, duration);
      Logger.error('Failed to save context:', error);
      return false;
    }
  }

  /**
   * Get a specific context entry
   *
   * @description Retrieves a single context entry by session and entry ID
   * @param {string} sessionId - The session ID
   * @param {string} entryId - The entry ID
   * @returns {Promise<McpContextEntry | null>} The entry if found, null otherwise
   */
  async getContext(sessionId: string, entryId: string): Promise<McpContextEntry | null> {
    if (!this.redis) return null;

    const startTime = Date.now();
    const key = `${REDIS_KEYS.CONTEXT}${sessionId}:${entryId}`;

    try {
      const data = await this.redis.get(key);
      const duration = Date.now() - startTime;
      Logger.redisOperation('getContext', key, true, duration, { found: !!data });
      return data ? JSON.parse(data) : null;
    } catch (error) {
      const duration = Date.now() - startTime;
      Logger.redisOperation('getContext', key, false, duration);
      Logger.error('Failed to get context:', error);
      return null;
    }
  }

  /**
   * Query context entries with filters
   *
   * @description Retrieves context entries matching the query criteria. Supports
   *              filtering by server, tool, tags, and time range. Results are
   *              ordered by timestamp.
   * @param {ContextQuery} query - Query parameters including sessionId, serverId, toolName, tags, limit, since
   * @returns {Promise<McpContextEntry[]>} Array of matching entries
   * @example
   * ```typescript
   * const entries = await storage.queryContext({
   *   sessionId: 'sess_abc',
   *   toolName: 'code-review',
   *   limit: 10,
   *   since: Date.now() - 3600000 // Last hour
   * });
   * ```
   */
  async queryContext(query: ContextQuery): Promise<McpContextEntry[]> {
    if (!this.redis || !query.sessionId) return [];

    const startTime = Date.now();

    try {
      const limit = query.limit || 20;
      const since = query.since || 0;

      // Get entry IDs from session index
      const entryIds = await this.redis.zrangebyscore(
        `${REDIS_KEYS.INDEX_SESSION}${query.sessionId}`,
        since,
        '+inf',
        'LIMIT',
        0,
        limit * 2 // Fetch extra to allow filtering
      );

      const entries: McpContextEntry[] = [];

      for (const id of entryIds) {
        if (entries.length >= limit) break;

        const entry = await this.getContext(query.sessionId, id);
        if (!entry) continue;

        // Apply filters
        if (query.serverId && entry.serverId !== query.serverId) continue;
        if (query.toolName && entry.toolName !== query.toolName) continue;
        if (query.tags?.length && !query.tags.some((t) => entry.tags.includes(t))) continue;

        entries.push(entry);
      }

      const duration = Date.now() - startTime;
      Logger.redisOperation('queryContext', `session:${query.sessionId}`, true, duration, {
        candidateCount: entryIds.length,
        matchedCount: entries.length,
        limit,
      });

      return entries;
    } catch (error) {
      const duration = Date.now() - startTime;
      Logger.redisOperation('queryContext', `session:${query.sessionId}`, false, duration);
      Logger.error('Failed to query context:', error);
      return [];
    }
  }

  /**
   * Get latest entries from a specific server
   *
   * @description Convenience method to get recent entries from a specific MCP server
   * @param {string} sessionId - The session ID
   * @param {ServerIdentifier} serverId - Server identifier (e.g., 'kemdicode-mcp', 'my-server')
   * @param {number} [limit=5] - Maximum entries to return
   * @returns {Promise<McpContextEntry[]>} Array of entries from the server
   */
  async getLatestFromServer(
    sessionId: string,
    serverId: ServerIdentifier,
    limit = 5
  ): Promise<McpContextEntry[]> {
    return this.queryContext({ sessionId, serverId, limit });
  }

  /**
   * Get all entries from current session
   *
   * @description Retrieves the most recent entries from a session in reverse
   *              chronological order (newest first).
   * @param {string} sessionId - The session ID
   * @param {number} [limit=50] - Maximum entries to return
   * @returns {Promise<McpContextEntry[]>} Array of entries, newest first
   */
  async getSessionHistory(sessionId: string, limit = 50): Promise<McpContextEntry[]> {
    if (!this.redis) return [];

    try {
      // Get most recent entries (reverse order)
      const entryIds = await this.redis.zrevrange(
        `${REDIS_KEYS.INDEX_SESSION}${sessionId}`,
        0,
        limit - 1
      );

      const entries: McpContextEntry[] = [];
      for (const id of entryIds) {
        const entry = await this.getContext(sessionId, id);
        if (entry) entries.push(entry);
      }

      return entries;
    } catch (error) {
      Logger.error('Failed to get session history:', error);
      return [];
    }
  }

  /**
   * Get session metadata
   *
   * @description Retrieves session metadata (not to be confused with SessionConfig
   *              from session/manager). This is for context sharing sessions.
   * @param {string} sessionId - The session ID
   * @returns {Promise<McpSession | null>} Session metadata or null if not found
   */
  async getSession(sessionId: string): Promise<McpSession | null> {
    if (!this.redis) return null;

    try {
      const key = `${REDIS_KEYS.SESSION}${sessionId}`;
      const data = await this.redis.get(key);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      Logger.error('Failed to get session:', error);
      return null;
    }
  }

  /**
   * Update session metadata
   *
   * @description Updates session metadata and refreshes the lastAccessedAt timestamp.
   *              Also resets the session TTL.
   * @param {McpSession} session - Session object to update
   * @returns {Promise<boolean>} True if update succeeded, false otherwise
   */
  async updateSession(session: McpSession): Promise<boolean> {
    if (!this.redis) return false;

    try {
      const key = `${REDIS_KEYS.SESSION}${session.id}`;
      session.lastAccessedAt = Date.now();
      await this.redis.setex(key, TTL.SESSION, JSON.stringify(session));
      return true;
    } catch (error) {
      Logger.error('Failed to update session:', error);
      return false;
    }
  }

  /**
   * Clear all context for a session
   *
   * @description Deletes all context entries and indexes for a session.
   *              Uses a Redis pipeline for atomic deletion.
   * @param {string} sessionId - The session ID to clear
   * @returns {Promise<boolean>} True if clear succeeded, false otherwise
   */
  async clearSession(sessionId: string): Promise<boolean> {
    if (!this.redis) return false;

    const startTime = Date.now();

    try {
      // Get all entry IDs
      const entryIds = await this.redis.zrange(`${REDIS_KEYS.INDEX_SESSION}${sessionId}`, 0, -1);

      if (entryIds.length === 0) {
        Logger.redisOperation(
          'clearSession',
          `session:${sessionId}`,
          true,
          Date.now() - startTime,
          {
            entriesCleared: 0,
          }
        );
        return true;
      }

      const pipeline = this.redis.pipeline();

      // Delete all entries
      for (const id of entryIds) {
        pipeline.del(`${REDIS_KEYS.CONTEXT}${sessionId}:${id}`);
      }

      // Delete session index
      pipeline.del(`${REDIS_KEYS.INDEX_SESSION}${sessionId}`);

      // Delete session
      pipeline.del(`${REDIS_KEYS.SESSION}${sessionId}`);

      await pipeline.exec();
      const duration = Date.now() - startTime;
      Logger.redisOperation('clearSession', `session:${sessionId}`, true, duration, {
        entriesCleared: entryIds.length,
      });
      return true;
    } catch (error) {
      const duration = Date.now() - startTime;
      Logger.redisOperation('clearSession', `session:${sessionId}`, false, duration);
      Logger.error('Failed to clear session:', error);
      return false;
    }
  }

  /**
   * Simple key-value get
   *
   * @description Low-level key-value retrieval for internal modules (e.g., feedback-loop).
   *              Note: key prefix is automatically applied.
   * @param {string} key - Redis key (without prefix)
   * @returns {Promise<string | null>} Value or null if not found
   */
  async get(key: string): Promise<string | null> {
    if (!this.redis) return null;
    try {
      return await this.redis.get(key);
    } catch {
      return null;
    }
  }

  /**
   * Simple key-value set with optional TTL
   *
   * @description Low-level key-value storage for internal modules.
   *              Note: key prefix is automatically applied.
   * @param {string} key - Redis key (without prefix)
   * @param {string} value - Value to store
   * @param {number} [ttlSeconds] - Optional TTL in seconds
   * @returns {Promise<boolean>} True if set succeeded, false otherwise
   */
  async set(key: string, value: string, ttlSeconds?: number): Promise<boolean> {
    if (!this.redis) return false;
    try {
      if (ttlSeconds) {
        await this.redis.setex(key, ttlSeconds, value);
      } else {
        await this.redis.set(key, value);
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get statistics about current storage
   *
   * @description Returns basic statistics about the Redis database including
   *              total key count and connection status.
   * @returns {Promise<Record<string, number>>} Stats object with totalKeys and connected
   */
  async getStats(): Promise<Record<string, number>> {
    if (!this.redis) return {};

    try {
      const info = await this.redis.info('keyspace');
      const dbMatch = info.match(/db2:keys=(\d+)/);
      const keys = dbMatch ? parseInt(dbMatch[1]) : 0;

      return {
        totalKeys: keys,
        connected: this.connected ? 1 : 0,
      };
    } catch {
      return { connected: 0 };
    }
  }
}

/** Singleton storage instance */
let storageInstance: ContextStorage | null = null;

/**
 * Get or create the storage singleton
 *
 * @description Returns the singleton ContextStorage instance, creating it with
 *              the provided config if it doesn't exist. Note: config is only
 *              used on first call.
 * @param {RedisConfig} [config] - Redis connection configuration (used only on first call)
 * @returns {ContextStorage} The singleton storage instance
 * @example
 * ```typescript
 * const storage = getContextStorage({ host: 'redis.local' });
 * ```
 */
export function getContextStorage(config?: RedisConfig): ContextStorage {
  if (!storageInstance) {
    storageInstance = new ContextStorage(config);
  }
  return storageInstance;
}

/**
 * Initialize storage and connect
 *
 * @description Convenience function that gets the singleton storage and connects it.
 *              Combines getContextStorage() and connect() in one call.
 * @param {RedisConfig} [config] - Redis connection configuration
 * @returns {Promise<ContextStorage>} Connected storage instance
 * @example
 * ```typescript
 * const storage = await initContextStorage({ host: '127.0.0.1', port: 6379 });
 * await storage.saveContext(entry);
 * ```
 */
export async function initContextStorage(config?: RedisConfig): Promise<ContextStorage> {
  const storage = getContextStorage(config);
  await storage.connect();
  return storage;
}
