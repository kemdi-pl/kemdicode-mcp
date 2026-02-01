/**
 * KemdiCode MCP Server
 * Copyright (C) 2025-2026 Kemdi Sp. z o.o. (Dawid Irzyk <dawid@kemdi.pl>)
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

/**
 * Redis Bridge for Global Event Bus
 *
 * Publishes selected events to Redis Pub/Sub for cross-session propagation.
 * Maintains a capped history list per session for replay.
 *
 * @module events/redis-bridge
 */

import { getSharedRedis } from '../infrastructure/redis/connection.js';
import { Logger } from '../utils/logger.js';
import type { GlobalEvent, RedisEventOptions } from './types.js';

const DEFAULT_HISTORY_CAP = 100;
const DEFAULT_HISTORY_TTL = 3600; // 1 hour

/**
 * Derive Redis channel from event type.
 * e.g. 'kanban:task:created' → 'mcp:events:kanban:task'
 */
function deriveChannel(eventType: string): string {
  const parts = eventType.split(':');
  if (parts.length >= 2) {
    return `mcp:events:${parts[0]}:${parts[1]}`;
  }
  return `mcp:events:${parts[0]}`;
}

/**
 * Publish a GlobalEvent to Redis Pub/Sub and append to history.
 */
export async function publishToRedis(
  event: GlobalEvent,
  options?: RedisEventOptions,
): Promise<void> {
  try {
    const client = await getSharedRedis();
    const channel = options?.channel || deriveChannel(event.type);
    const ttl = options?.ttl ?? DEFAULT_HISTORY_TTL;
    const historyKey = `mcp:events:history:${event.sessionId}`;
    const serialized = JSON.stringify(event);

    const pipeline = client.pipeline();
    pipeline.publish(channel, serialized);
    pipeline.lpush(historyKey, serialized);
    pipeline.ltrim(historyKey, 0, DEFAULT_HISTORY_CAP - 1);
    if (ttl > 0) {
      pipeline.expire(historyKey, ttl);
    }
    await pipeline.exec();
  } catch (err) {
    Logger.warn(`[RedisBridge] Failed to publish ${event.type}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Subscribe to Redis events matching a pattern.
 * Pattern example: 'kanban:*' → subscribes to 'mcp:events:kanban:*'
 */
export async function subscribeToRedisEvents(
  pattern: string,
  handler: (event: GlobalEvent) => void,
): Promise<() => void> {
  const { Redis } = await import('ioredis');
  const fullPattern = `mcp:events:${pattern}`;

  const subscriber = new Redis({
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT || '6379'),
    password: process.env.REDIS_PASSWORD || undefined,
    db: 2,
  });

  subscriber.on('error', (err: Error) => {
    Logger.error(`[RedisBridge] Subscriber error for ${fullPattern}: ${err.message}`);
  });

  await subscriber.psubscribe(fullPattern);

  subscriber.on('pmessage', (_pattern: string, _channel: string, message: string) => {
    try {
      const event = JSON.parse(message) as GlobalEvent;
      handler(event);
    } catch (err) {
      Logger.warn(`[RedisBridge] Failed to parse event: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  return () => {
    subscriber.punsubscribe(fullPattern).catch(() => {});
    subscriber.disconnect();
  };
}

/**
 * Get recent event history for a session.
 */
export async function getEventHistory(
  sessionId: string,
  limit: number = 50,
): Promise<GlobalEvent[]> {
  try {
    const client = await getSharedRedis();
    const historyKey = `mcp:events:history:${sessionId}`;
    const items = await client.lrange(historyKey, 0, limit - 1);

    return items
      .map((item) => {
        try {
          return JSON.parse(item) as GlobalEvent;
        } catch {
          return null;
        }
      })
      .filter((e): e is GlobalEvent => e !== null);
  } catch (err) {
    Logger.warn(`[RedisBridge] Failed to get event history: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}
