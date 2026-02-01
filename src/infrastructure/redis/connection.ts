/**
 * KemdiCode MCP Server - Redis Connection Manager
 * Copyright (C) 2025-2026 Kemdi Sp. z o.o. (Dawid Irzyk <dawid@kemdi.pl>)
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

/**
 * Redis Connection Manager
 *
 * Centralized Redis connection management with retry strategy,
 * connection pooling, and health monitoring.
 *
 * @module infrastructure/redis/connection
 */

import Redis from 'ioredis';
import { Logger } from '../../utils/logger.js';
import type { RedisOptions } from 'ioredis';

export interface RedisConfig {
  host?: string;
  port?: number;
  password?: string;
  db?: number;
  keyPrefix?: string;
}

export interface ConnectionOptions {
  /** Redis database number (default: 2 for MCP) */
  db?: number;
  /** Key prefix for all keys */
  keyPrefix?: string;
  /** Lazy connect (default: false) */
  lazyConnect?: boolean;
  /** Max retries per request (default: 3) */
  maxRetriesPerRequest?: number;
  /** Enable offline queue (default: true) */
  enableOfflineQueue?: boolean;
  /** Connection timeout in ms (default: 5000) */
  connectTimeout?: number;
}

/**
 * Redis Connection Manager
 * Manages Redis connections with automatic retry and health monitoring
 */
export class RedisConnectionManager {
  private redis: Redis | null = null;
  private config: RedisConfig;
  private options: Required<ConnectionOptions>;
  private connected = false;
  private healthCheckInterval: NodeJS.Timeout | null = null;

  constructor(config: RedisConfig = {}, options: ConnectionOptions = {}) {
    this.config = config;
    this.options = {
      db: options.db ?? 2,
      keyPrefix: options.keyPrefix ?? '',
      lazyConnect: options.lazyConnect ?? false,
      maxRetriesPerRequest: options.maxRetriesPerRequest ?? 3,
      enableOfflineQueue: options.enableOfflineQueue ?? true,
      connectTimeout: options.connectTimeout ?? 5000,
    };
  }

  /**
   * Get retry strategy function
   */
  private getRetryStrategy(): (times: number) => number | null {
    return (times: number) => {
      if (times > 3) {
        Logger.error('Redis connection failed after 3 retries');
        return null;
      }
      return Math.min(times * 100, 1000);
    };
  }

  /**
   * Build Redis configuration
   */
  private buildConfig(): RedisOptions {
    return {
      host: this.config.host || process.env.REDIS_HOST || '127.0.0.1',
      port: this.config.port || parseInt(process.env.REDIS_PORT || '6379'),
      password: this.config.password || process.env.REDIS_PASSWORD || undefined,
      db: this.options.db,
      keyPrefix: this.options.keyPrefix,
      lazyConnect: this.options.lazyConnect,
      maxRetriesPerRequest: this.options.maxRetriesPerRequest,
      enableOfflineQueue: this.options.enableOfflineQueue,
      connectTimeout: this.options.connectTimeout,
      retryStrategy: this.getRetryStrategy(),
    };
  }

  /**
   * Connect to Redis
   * @returns True if connection succeeded
   */
  async connect(): Promise<boolean> {
    if (this.connected && this.redis) {
      return true;
    }

    try {
      this.redis = new Redis(this.buildConfig());

      // Test connection
      await this.redis.ping();
      this.connected = true;

      // Setup event handlers
      this.setupEventHandlers();

      // Start health check
      this.startHealthCheck();

      Logger.debug(`Redis connection established (db: ${this.options.db})`);
      return true;
    } catch (error) {
      Logger.error('Failed to connect to Redis:', error);
      this.redis = null;
      this.connected = false;
      return false;
    }
  }

  /**
   * Setup Redis event handlers
   */
  private setupEventHandlers(): void {
    if (!this.redis) return;

    this.redis.on('error', (error) => {
      Logger.error('Redis error:', error);
      this.connected = false;
    });

    this.redis.on('connect', () => {
      Logger.debug('Redis connected');
      this.connected = true;
    });

    this.redis.on('disconnect', () => {
      Logger.debug('Redis disconnected');
      this.connected = false;
    });

    this.redis.on('reconnecting', () => {
      Logger.debug('Redis reconnecting...');
    });
  }

  /**
   * Start health check interval
   */
  private startHealthCheck(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }

    this.healthCheckInterval = setInterval(async () => {
      if (this.redis) {
        try {
          await this.redis.ping();
          this.connected = true;
        } catch {
          this.connected = false;
        }
      }
    }, 30000); // Check every 30 seconds
  }

  /**
   * Check if Redis is connected
   */
  isConnected(): boolean {
    return this.connected && this.redis !== null;
  }

  /**
   * Get Redis client
   * @returns Redis client or null if not connected
   */
  getClient(): Redis | null {
    return this.redis;
  }

  /**
   * Disconnect from Redis
   */
  async disconnect(): Promise<void> {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    if (this.redis) {
      await this.redis.quit();
      this.redis = null;
      this.connected = false;
      Logger.debug('Redis connection closed');
    }
  }

  /**
   * Execute operation with automatic reconnection
   */
  async execute<T>(operation: (redis: Redis) => Promise<T>): Promise<T | null> {
    if (!this.redis || !this.connected) {
      const connected = await this.connect();
      if (!connected) {
        return null;
      }
    }

    try {
      return await operation(this.redis!);
    } catch (error) {
      Logger.error('Redis operation failed:', error);
      this.connected = false;
      return null;
    }
  }
}

/**
 * Create subscriber connection (for Pub/Sub)
 * Separate connection required for Redis Pub/Sub
 */
export function createSubscriberConnection(config: RedisConfig = {}, db = 2): Redis | null {
  try {
    return new Redis({
      host: config.host || process.env.REDIS_HOST || '127.0.0.1',
      port: config.port || parseInt(process.env.REDIS_PORT || '6379'),
      password: config.password || process.env.REDIS_PASSWORD || undefined,
      db,
      keyPrefix: '', // No prefix for pub/sub
      lazyConnect: true,
      maxRetriesPerRequest: 3,
    });
  } catch (error) {
    Logger.error('Failed to create Redis subscriber:', error);
    return null;
  }
}

// Global connection manager instance
let globalConnectionManager: RedisConnectionManager | null = null;

/**
 * Get or create global Redis connection manager
 */
export function getRedisConnectionManager(
  config?: RedisConfig,
  options?: ConnectionOptions
): RedisConnectionManager {
  if (!globalConnectionManager) {
    globalConnectionManager = new RedisConnectionManager(config, options);
  }
  return globalConnectionManager;
}

/**
 * Reset global connection manager (for testing)
 */
export function resetRedisConnectionManager(): void {
  globalConnectionManager = null;
}

/**
 * Get a shared Redis client from the global connection manager.
 * This is the recommended way to get a Redis client in any module.
 * Replaces per-module `let redis: Redis | null = null` + `getRedis()` patterns.
 *
 * @throws Error if Redis is not connected
 */
export async function getSharedRedis(): Promise<Redis> {
  const manager = getRedisConnectionManager();
  if (!manager.isConnected()) {
    await manager.connect();
  }
  const client = manager.getClient();
  if (!client) {
    throw new Error('Redis is not available');
  }
  return client;
}
