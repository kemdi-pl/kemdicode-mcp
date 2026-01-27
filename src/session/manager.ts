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
 * Session Manager
 *
 * Manages session lifecycle, configuration, and persistence.
 * Uses in-memory Map for fast access with Redis for persistence.
 */

import { Redis } from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import { Logger } from '../utils/logger.js';
import { RedisConfig } from '../context/types.js';
import {
  SessionConfig,
  SessionUpdate,
  CreateSessionOptions,
  SessionListOptions,
  SESSION_REDIS_KEYS,
  SESSION_TTL,
} from './types.js';
import { resolveCwd, detectProjectInfo } from './cwd-resolver.js';

/**
 * Session Manager Class
 *
 * Manages session lifecycle, configuration, and persistence.
 * Uses an in-memory Map for fast access with Redis for persistence and
 * cross-server session sharing. Handles automatic cleanup of expired sessions.
 *
 * @class SessionManager
 * @example
 * ```typescript
 * const manager = await initSessionManager({ host: '127.0.0.1', port: 6379 });
 * const session = await manager.createSession({ model: 'gpt-4' });
 * console.log(session.sessionId); // sess_abc123...
 * ```
 */
export class SessionManager {
  /** In-memory session cache for fast access */
  private sessions: Map<string, SessionConfig> = new Map();
  /** Redis connection for persistence */
  private redis: Redis | null = null;
  /** Whether Redis is connected and operational */
  private redisConnected = false;
  /** Cleanup timer for expired session removal */
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Create a new SessionManager instance
   *
   * @param {RedisConfig} config - Redis connection configuration
   */
  constructor(private readonly config: RedisConfig = {}) {}

  /**
   * Initialize Redis connection and start cleanup timer
   *
   * @description Establishes connection to Redis, starts the session cleanup timer,
   *              and loads existing sessions from Redis. Uses retry strategy for
   *              connection resilience.
   * @returns {Promise<boolean>} True if connection succeeded, false otherwise
   * @throws {Error} Does not throw - returns false on failure
   * @example
   * ```typescript
   * const manager = new SessionManager({ host: '127.0.0.1' });
   * const connected = await manager.initialize();
   * if (connected) {
   *   console.log('Redis connected');
   * }
   * ```
   */
  async initialize(): Promise<boolean> {
    try {
      this.redis = new Redis({
        host: this.config.host || process.env.REDIS_HOST || '127.0.0.1',
        port: this.config.port || parseInt(process.env.REDIS_PORT || '6379'),
        password: this.config.password || process.env.REDIS_PASSWORD || undefined,
        db: this.config.db ?? 2, // Same database as context storage
        keyPrefix: SESSION_REDIS_KEYS.PREFIX,
        lazyConnect: false,
        maxRetriesPerRequest: 3,
        retryStrategy: (times: number) => {
          if (times > 3) {
            Logger.error('Session manager: Redis connection failed after 3 retries');
            return null;
          }
          return Math.min(times * 100, 1000);
        },
      });

      await this.redis.ping();
      this.redisConnected = true;
      Logger.debug('Session manager connected to Redis');

      // Start cleanup timer
      this.startCleanupTimer();

      // Load existing sessions from Redis
      await this.loadSessionsFromRedis();

      return true;
    } catch (error) {
      Logger.error('Session manager: Failed to connect to Redis:', error);
      this.redis = null;
      this.redisConnected = false;
      return false;
    }
  }

  /**
   * Check if Redis is connected
   *
   * @description Returns the current connection status of the Redis client
   * @returns {boolean} True if Redis is connected and operational
   */
  isConnected(): boolean {
    return this.redisConnected && this.redis !== null;
  }

  /**
   * Gracefully shutdown the session manager
   *
   * @description Stops the cleanup timer, disconnects from Redis, and clears
   *              all in-memory sessions. Should be called during server shutdown.
   * @returns {Promise<void>}
   * @example
   * ```typescript
   * process.on('SIGTERM', async () => {
   *   await manager.shutdown();
   *   process.exit(0);
   * });
   * ```
   */
  async shutdown(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    if (this.redis) {
      await this.redis.quit();
      this.redis = null;
      this.redisConnected = false;
    }

    this.sessions.clear();
    Logger.debug('Session manager shutdown complete');
  }

  /**
   * Generate a unique session ID
   *
   * @description Creates a unique session identifier with 'sess_' prefix and 16-char UUID
   * @returns {string} Session ID in format 'sess_xxxxxxxxxxxxxxxx'
   * @private
   */
  private generateSessionId(): string {
    return `sess_${uuidv4().replace(/-/g, '').substring(0, 16)}`;
  }

  /**
   * Create a new session
   *
   * @description Creates a new session with the provided options. Automatically
   *              resolves CWD and detects project type unless skipProjectDetection is set.
   * @param {CreateSessionOptions} options - Session creation options
   * @returns {Promise<SessionConfig>} The created session configuration
   * @example
   * ```typescript
   * const session = await manager.createSession({
   *   model: 'gpt-4',
   *   cwd: '/path/to/project',
   *   metadata: { source: 'claude-code' }
   * });
   * ```
   */
  async createSession(options: CreateSessionOptions): Promise<SessionConfig> {
    const sessionId = options.sessionId || this.generateSessionId();
    const now = Date.now();

    Logger.debug(() => `Creating session: ${sessionId}`, {
      hasExplicitCwd: !!options.cwd,
      skipProjectDetection: !!options.skipProjectDetection,
    });

    // Resolve CWD if not provided
    let cwd = options.cwd || process.cwd();
    let projectType: SessionConfig['projectType'] = 'unknown';
    let projectName: string | undefined;

    if (!options.skipProjectDetection) {
      const resolution = await resolveCwd({ explicitCwd: options.cwd });
      cwd = resolution.cwd;
      projectType = resolution.projectType;
      projectName = resolution.projectName;
    }

    const session: SessionConfig = {
      sessionId,
      cwd,
      model: options.model,
      fallbackModel: options.fallbackModel,
      projectType,
      projectName,
      createdAt: now,
      lastAccessedAt: now,
      metadata: options.metadata || {},
    };

    // Store in memory
    this.sessions.set(sessionId, session);

    // Persist to Redis
    await this.persistSession(session);

    Logger.sessionEvent('created', sessionId, { cwd, projectType, projectName });
    return session;
  }

  /**
   * Get a session by ID
   *
   * @description Retrieves a session from memory cache first, then falls back to Redis.
   *              Updates the lastAccessedAt timestamp on access.
   * @param {string} sessionId - The session ID to retrieve
   * @returns {Promise<SessionConfig | null>} The session if found, null otherwise
   * @example
   * ```typescript
   * const session = await manager.getSession('sess_abc123');
   * if (session) {
   *   console.log(`Session CWD: ${session.cwd}`);
   * }
   * ```
   */
  async getSession(sessionId: string): Promise<SessionConfig | null> {
    // Check memory first
    let session: SessionConfig | null = this.sessions.get(sessionId) ?? null;
    let source: 'memory' | 'redis' | 'not_found' = 'memory';

    // If not in memory, try Redis
    if (!session && this.redis) {
      session = await this.loadSessionFromRedis(sessionId);
      if (session) {
        this.sessions.set(sessionId, session);
        source = 'redis';
      } else {
        source = 'not_found';
      }
    } else if (!session) {
      source = 'not_found';
    }

    if (session) {
      // Update last accessed time
      session.lastAccessedAt = Date.now();
      await this.persistSession(session);
      Logger.sessionEvent('accessed', sessionId, { source });
    } else {
      Logger.debug(() => `Session not found: ${sessionId}`, { sessionId });
    }

    return session;
  }

  /**
   * Get or create a session
   *
   * @description Attempts to retrieve an existing session by ID. If not found or no ID
   *              provided, creates a new session with the given options.
   * @param {CreateSessionOptions} options - Session options with optional sessionId
   * @returns {Promise<SessionConfig>} Existing or newly created session
   * @example
   * ```typescript
   * // Will reuse existing session or create new one
   * const session = await manager.getOrCreateSession({
   *   sessionId: 'sess_abc123',
   *   model: 'gpt-4'
   * });
   * ```
   */
  async getOrCreateSession(options: CreateSessionOptions): Promise<SessionConfig> {
    if (options.sessionId) {
      const existing = await this.getSession(options.sessionId);
      if (existing) {
        return existing;
      }
    }
    return this.createSession(options);
  }

  /**
   * Update session configuration
   *
   * @description Updates an existing session with new values. If CWD changes,
   *              automatically re-detects project type and name.
   * @param {string} sessionId - The session ID to update
   * @param {SessionUpdate} updates - Partial session updates to apply
   * @returns {Promise<SessionConfig | null>} Updated session or null if not found
   * @example
   * ```typescript
   * const updated = await manager.updateSession('sess_abc123', {
   *   cwd: '/new/project/path',
   *   metadata: { environment: 'production' }
   * });
   * ```
   */
  async updateSession(sessionId: string, updates: SessionUpdate): Promise<SessionConfig | null> {
    const session = await this.getSession(sessionId);
    if (!session) {
      Logger.warn(`Session not found for update: ${sessionId}`);
      return null;
    }

    // Apply updates
    Object.assign(session, updates, { lastAccessedAt: Date.now() });

    // If CWD changed, re-detect project type
    if (updates.cwd && updates.cwd !== session.cwd) {
      const projectInfo = await detectProjectInfo(updates.cwd);
      session.projectType = projectInfo.type;
      session.projectName = projectInfo.name;
    }

    // Persist changes
    this.sessions.set(sessionId, session);
    await this.persistSession(session);

    Logger.sessionEvent('updated', sessionId, {
      updatedFields: Object.keys(updates),
      cwdChanged: !!updates.cwd,
    });
    return session;
  }

  /**
   * Delete a session
   *
   * @description Removes a session from both memory and Redis, including all
   *              associated indexes (active index, project type index).
   * @param {string} sessionId - The session ID to delete
   * @returns {Promise<boolean>} True if deletion succeeded, false on error
   * @example
   * ```typescript
   * const deleted = await manager.deleteSession('sess_abc123');
   * if (deleted) {
   *   console.log('Session removed');
   * }
   * ```
   */
  async deleteSession(sessionId: string): Promise<boolean> {
    // Remove from memory
    this.sessions.delete(sessionId);

    // Remove from Redis
    if (this.redis) {
      try {
        const key = `${SESSION_REDIS_KEYS.CONFIG}${sessionId}`;
        await this.redis.del(key);

        // Remove from indexes
        await this.redis.zrem(SESSION_REDIS_KEYS.INDEX, sessionId);

        Logger.sessionEvent('deleted', sessionId, { source: 'explicit' });
        return true;
      } catch (error) {
        Logger.error(`Failed to delete session from Redis: ${sessionId}`, error);
        return false;
      }
    }

    return true;
  }

  /**
   * List all sessions
   *
   * @description Returns sessions filtered by the provided options. Supports filtering
   *              by project type, activity window, and pagination. Results are sorted
   *              by last accessed time (most recent first).
   * @param {SessionListOptions} options - Filtering and pagination options
   * @returns {Promise<SessionConfig[]>} Array of matching sessions
   * @example
   * ```typescript
   * // Get active PHP sessions
   * const sessions = await manager.listSessions({
   *   projectType: 'php',
   *   activeWithin: 3600000, // 1 hour
   *   limit: 10
   * });
   * ```
   */
  async listSessions(options: SessionListOptions = {}): Promise<SessionConfig[]> {
    const { projectType, activeWithin, limit = 100, includeExpired = false } = options;
    const now = Date.now();
    const results: SessionConfig[] = [];

    // Get from memory first
    for (const session of this.sessions.values()) {
      // Filter by project type
      if (projectType && session.projectType !== projectType) {
        continue;
      }

      // Filter by activity
      if (activeWithin && now - session.lastAccessedAt > activeWithin) {
        continue;
      }

      // Filter expired
      if (!includeExpired) {
        const age = now - session.lastAccessedAt;
        if (age > SESSION_TTL.ACTIVE * 1000) {
          continue;
        }
      }

      results.push(session);

      if (results.length >= limit) {
        break;
      }
    }

    // Sort by last accessed (most recent first)
    results.sort((a, b) => b.lastAccessedAt - a.lastAccessedAt);

    return results;
  }

  /**
   * Get session count
   *
   * @description Returns the number of sessions currently in memory cache
   * @returns {number} Count of sessions in memory
   */
  getSessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Persist session to Redis
   *
   * @description Saves a session to Redis with TTL and updates all related indexes
   *              (active index sorted by last access, project type index).
   * @param {SessionConfig} session - The session to persist
   * @returns {Promise<boolean>} True if persistence succeeded, false otherwise
   * @private
   */
  private async persistSession(session: SessionConfig): Promise<boolean> {
    if (!this.redis) return false;

    try {
      const key = `${SESSION_REDIS_KEYS.CONFIG}${session.sessionId}`;
      const pipeline = this.redis.pipeline();

      // Save session data
      pipeline.setex(key, SESSION_TTL.ACTIVE, JSON.stringify(session));

      // Update active index (sorted set by last access time)
      pipeline.zadd(SESSION_REDIS_KEYS.INDEX, session.lastAccessedAt, session.sessionId);

      // Update project type index
      if (session.projectType) {
        pipeline.sadd(
          `${SESSION_REDIS_KEYS.INDEX_PROJECT}${session.projectType}`,
          session.sessionId
        );
      }

      await pipeline.exec();
      return true;
    } catch (error) {
      Logger.error('Failed to persist session:', error);
      return false;
    }
  }

  /**
   * Load session from Redis
   *
   * @description Retrieves a single session from Redis by ID and parses JSON
   * @param {string} sessionId - The session ID to load
   * @returns {Promise<SessionConfig | null>} Parsed session or null if not found
   * @private
   */
  private async loadSessionFromRedis(sessionId: string): Promise<SessionConfig | null> {
    if (!this.redis) return null;

    try {
      const key = `${SESSION_REDIS_KEYS.CONFIG}${sessionId}`;
      const data = await this.redis.get(key);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      Logger.error(`Failed to load session from Redis: ${sessionId}`, error);
      return null;
    }
  }

  /**
   * Load all active sessions from Redis
   *
   * @description Bulk loads all sessions from Redis active index into memory cache.
   *              Called during initialization to restore session state.
   * @returns {Promise<void>}
   * @private
   */
  private async loadSessionsFromRedis(): Promise<void> {
    if (!this.redis) return;

    try {
      // Get all session IDs from the active index
      const sessionIds = await this.redis.zrange(SESSION_REDIS_KEYS.INDEX, 0, -1);

      for (const sessionId of sessionIds) {
        const session = await this.loadSessionFromRedis(sessionId);
        if (session) {
          this.sessions.set(sessionId, session);
        }
      }

      Logger.debug(`Loaded ${this.sessions.size} sessions from Redis`);
    } catch (error) {
      Logger.error('Failed to load sessions from Redis:', error);
    }
  }

  /**
   * Start cleanup timer for expired sessions
   *
   * @description Starts an interval timer that periodically removes expired sessions.
   *              Timer interval is defined by SESSION_TTL.CLEANUP_INTERVAL.
   * @returns {void}
   * @private
   */
  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(async () => {
      await this.cleanupExpiredSessions();
    }, SESSION_TTL.CLEANUP_INTERVAL * 1000);
  }

  /**
   * Clean up expired sessions
   *
   * @description Iterates through all sessions and removes those that have exceeded
   *              the SESSION_TTL.ACTIVE threshold based on lastAccessedAt.
   * @returns {Promise<void>}
   * @private
   */
  private async cleanupExpiredSessions(): Promise<void> {
    const now = Date.now();
    const expiredIds: string[] = [];

    for (const [sessionId, session] of this.sessions) {
      const age = now - session.lastAccessedAt;
      if (age > SESSION_TTL.ACTIVE * 1000) {
        expiredIds.push(sessionId);
      }
    }

    for (const sessionId of expiredIds) {
      Logger.sessionEvent('expired', sessionId);
      await this.deleteSession(sessionId);
    }

    if (expiredIds.length > 0) {
      Logger.debug(() => `Session cleanup completed`, {
        expiredCount: expiredIds.length,
        remainingCount: this.sessions.size,
      });
    }
  }

  /**
   * Get session statistics
   *
   * @description Returns aggregate statistics about all sessions including total count,
   *              active/idle breakdown, and counts by project type.
   * @returns {Promise<Record<string, number>>} Statistics object with various counts
   * @example
   * ```typescript
   * const stats = await manager.getStats();
   * // Returns: { totalSessions: 5, activeSessions: 3, idleSessions: 2, projectType_php: 2, projectType_node: 3 }
   * ```
   */
  async getStats(): Promise<Record<string, number>> {
    const stats: Record<string, number> = {
      totalSessions: this.sessions.size,
      activeSessions: 0,
      idleSessions: 0,
    };

    const now = Date.now();
    const idleThreshold = SESSION_TTL.IDLE * 1000;

    for (const session of this.sessions.values()) {
      const age = now - session.lastAccessedAt;
      if (age < idleThreshold) {
        stats.activeSessions++;
      } else {
        stats.idleSessions++;
      }
    }

    // Count by project type
    for (const session of this.sessions.values()) {
      const key = `projectType_${session.projectType || 'unknown'}`;
      stats[key] = (stats[key] || 0) + 1;
    }

    return stats;
  }
}

/** Singleton session manager instance */
let sessionManagerInstance: SessionManager | null = null;

/**
 * Get or create the session manager singleton
 *
 * @description Returns the singleton SessionManager instance, creating it with
 *              the provided config if it doesn't exist. Subsequent calls return
 *              the same instance (config is ignored after first call).
 * @param {RedisConfig} [config] - Redis connection configuration (used only on first call)
 * @returns {SessionManager} The singleton session manager instance
 * @example
 * ```typescript
 * const manager = getSessionManager({ host: 'redis.local' });
 * ```
 */
export function getSessionManager(config?: RedisConfig): SessionManager {
  if (!sessionManagerInstance) {
    sessionManagerInstance = new SessionManager(config);
  }
  return sessionManagerInstance;
}

/**
 * Initialize session manager and connect to Redis
 *
 * @description Convenience function that gets the singleton manager and initializes it.
 *              Combines getSessionManager() and initialize() in one call.
 * @param {RedisConfig} [config] - Redis connection configuration
 * @returns {Promise<SessionManager>} Initialized session manager
 * @example
 * ```typescript
 * const manager = await initSessionManager({ host: '127.0.0.1', port: 6379 });
 * const session = await manager.createSession({ model: 'gpt-4' });
 * ```
 */
export async function initSessionManager(config?: RedisConfig): Promise<SessionManager> {
  const manager = getSessionManager(config);
  await manager.initialize();
  return manager;
}
