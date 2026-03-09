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
 * Redis Bridge for Global Event Bus
 *
 * Publishes selected events to Redis Pub/Sub for cross-session propagation.
 * Maintains a capped history list per session for replay.
 *
 * @module events/redis-bridge
 */

import { getSharedRedis } from '../infrastructure/redis/connection.js';
import { Logger } from '../utils/logger.js';
import { safeJsonParseNoProto } from '../utils/security.js';
import type { GlobalEvent, RedisEventOptions } from './types.js';

const DEFAULT_HISTORY_CAP = 100;
const DEFAULT_HISTORY_TTL = 3600; // 1 hour

// Shared subscriber singleton — avoids creating new Redis connections per subscription
let sharedSubscriber: import('ioredis').Redis | null = null;
const activeSubscriptions = new Map<string, (event: GlobalEvent) => void>();

/**
 * Get or create the shared Redis subscriber instance.
 * Auto-resubscribes all active patterns on reconnect.
 */
async function getSharedSubscriber(): Promise<import('ioredis').Redis> {
  if (sharedSubscriber) return sharedSubscriber;

  const { Redis } = await import('ioredis');

  sharedSubscriber = new Redis({
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT || '6379'),
    password: process.env.REDIS_PASSWORD || undefined,
    db: 2,
  });

  sharedSubscriber.on('error', (err: Error) => {
    Logger.error(`[RedisBridge] Subscriber error: ${err.message}`);
  });

  // Re-subscribe all active patterns after reconnect
  sharedSubscriber.on('ready', async () => {
    Logger.info('[RedisBridge] Subscriber reconnected, resubscribing to patterns');
    for (const pattern of activeSubscriptions.keys()) {
      try {
        await sharedSubscriber!.psubscribe(pattern);
      } catch (err) {
        Logger.error(
          `[RedisBridge] Failed to resubscribe to ${pattern}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  });

  sharedSubscriber.on('pmessage', (_pattern: string, _channel: string, message: string) => {
    try {
      const event = safeJsonParseNoProto<GlobalEvent>(message);
      if (!event) return;
      // Dispatch to matching handler - use glob-style pattern matching
      for (const [subPattern, handler] of activeSubscriptions) {
        const patternPrefix = subPattern.replace(/\*/g, '');
        if (
          _pattern === subPattern ||
          _channel.startsWith(patternPrefix + ':') ||
          _channel === patternPrefix
        ) {
          queueMicrotask(() => handler(event));
        }
      }
    } catch (err) {
      Logger.warn(
        `[RedisBridge] Failed to parse event: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  });

  return sharedSubscriber;
}

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
 * Rethrows errors so publishWithRetry can retry.
 */
export async function publishToRedis(
  event: GlobalEvent,
  options?: RedisEventOptions
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
    Logger.warn(
      `[RedisBridge] Failed to publish ${event.type}: ${err instanceof Error ? err.message : String(err)}`
    );
    throw err; // Rethrow so publishWithRetry can retry
  }
}

/**
 * Subscribe to Redis events matching a pattern.
 * Uses shared subscriber singleton — no new connections per call.
 * Pattern example: 'kanban:*' → subscribes to 'mcp:events:kanban:*'
 */
export async function subscribeToRedisEvents(
  pattern: string,
  handler: (event: GlobalEvent) => void
): Promise<() => Promise<void>> {
  const fullPattern = `mcp:events:${pattern}`;
  const subscriber = await getSharedSubscriber();

  activeSubscriptions.set(fullPattern, handler);
  await subscriber.psubscribe(fullPattern);

  return async () => {
    try {
      await subscriber.punsubscribe(fullPattern);
      activeSubscriptions.delete(fullPattern);

      // Only disconnect if no more active subscriptions
      if (activeSubscriptions.size === 0 && sharedSubscriber) {
        await sharedSubscriber.quit();
        sharedSubscriber = null;
      }
    } catch (err) {
      Logger.warn(
        `[RedisBridge] Failed to unsubscribe from ${fullPattern}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  };
}

/**
 * Get recent event history for a session.
 */
export async function getEventHistory(
  sessionId: string,
  limit: number = 50
): Promise<GlobalEvent[]> {
  try {
    const client = await getSharedRedis();
    const historyKey = `mcp:events:history:${sessionId}`;
    const items = await client.lrange(historyKey, 0, limit - 1);

    return items
      .map((item) => {
        try {
          return safeJsonParseNoProto<GlobalEvent>(item);
        } catch {
          return null;
        }
      })
      .filter((e): e is GlobalEvent => e !== null);
  } catch (err) {
    Logger.warn(
      `[RedisBridge] Failed to get event history: ${err instanceof Error ? err.message : String(err)}`
    );
    return [];
  }
}
