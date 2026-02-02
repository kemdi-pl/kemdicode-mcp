/**
 * KemdiCode MCP Server - Data Flow Bus
 * Copyright (C) 2025-2026 Kemdi Sp. z o.o. (Dawid Irzyk <dawid@kemdi.pl>)
 *
 * Typed, Redis-backed message bus for inter-module communication.
 * Provides publish/subscribe with schema validation, correlation tracking,
 * and cross-process messaging via Redis Pub/Sub.
 *
 * @license GPL-3.0
 * @module dataflow/bus
 */

import { v4 as uuidv4 } from 'uuid';
import { Logger } from '../utils/logger.js';
import type {
  DataFlowChannel,
  DataFlowEnvelope,
  DataFlowHandler,
  SubscriptionOptions,
  ChannelPayloadMap,
} from './types.js';

/**
 * Internal subscription record.
 */
interface Subscription {
  id: string;
  channel: DataFlowChannel;
  handler: DataFlowHandler;
  options: SubscriptionOptions;
}

/**
 * DataFlowBus - Typed message bus for inter-module communication.
 *
 * Features:
 * - Strongly typed channels with Zod-validated payloads
 * - Correlation IDs for request-response tracing
 * - Priority-based filtering
 * - Source module filtering
 * - In-process pub/sub (Redis bridge optional via global event bus)
 * - Message history for debugging
 */
class DataFlowBus {
  private subscriptions = new Map<DataFlowChannel, Subscription[]>();
  private messageHistory: DataFlowEnvelope[] = [];
  private readonly maxHistory = 200;
  private redisPublisher: ((channel: string, message: string) => Promise<void>) | null = null;

  /**
   * Publish a typed message to a channel.
   */
  async publish<C extends DataFlowChannel>(
    channel: C,
    payload: C extends keyof ChannelPayloadMap ? ChannelPayloadMap[C] : unknown,
    meta: {
      source: string;
      target?: string;
      sessionId?: string;
      agentId?: string;
      correlationId?: string;
      priority?: 0 | 1 | 2 | 3;
      ttl?: number;
    },
  ): Promise<string> {
    const envelope: DataFlowEnvelope = {
      id: uuidv4(),
      channel,
      payload,
      source: meta.source,
      target: meta.target,
      sessionId: meta.sessionId,
      agentId: meta.agentId,
      timestamp: Date.now(),
      correlationId: meta.correlationId,
      schemaVersion: 1,
      priority: meta.priority ?? 1,
      ttl: meta.ttl ?? 0,
    };

    // Store in history
    this.messageHistory.push(envelope);
    if (this.messageHistory.length > this.maxHistory) {
      this.messageHistory.shift();
    }

    // Deliver to local subscribers (skip expired messages)
    if (envelope.ttl && envelope.ttl > 0 && Date.now() - envelope.timestamp > envelope.ttl) {
      Logger.debug(`dataflow: message expired (ttl=${envelope.ttl}ms), skipping delivery`);
      return envelope.id;
    }

    const subs = this.subscriptions.get(channel) || [];
    const matchingSubs = subs.filter((sub) => this.matchesSubscription(sub, envelope));

    const deliveryPromises = matchingSubs.map((sub) => {
      try {
        const result = sub.handler(envelope);
        return result instanceof Promise ? result.catch((err) => {
          Logger.error(`dataflow: handler error on ${channel}: ${err instanceof Error ? err.message : String(err)}`);
        }) : Promise.resolve();
      } catch (err) {
        Logger.error(`dataflow: sync handler error on ${channel}: ${err instanceof Error ? err.message : String(err)}`);
        return Promise.resolve();
      }
    });

    await Promise.all(deliveryPromises);

    // Publish to Redis if bridge is set
    if (this.redisPublisher) {
      try {
        await this.redisPublisher(`mcp:dataflow:${channel}`, JSON.stringify(envelope));
      } catch (err) {
        Logger.warn(`dataflow: Redis publish failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return envelope.id;
  }

  /**
   * Subscribe to a channel with type-safe handler.
   * Returns an unsubscribe function.
   */
  subscribe<C extends DataFlowChannel>(
    channel: C,
    handler: DataFlowHandler<C extends keyof ChannelPayloadMap ? ChannelPayloadMap[C] : unknown>,
    options: SubscriptionOptions = {},
  ): () => void {
    const sub: Subscription = {
      id: uuidv4(),
      channel,
      handler: handler as DataFlowHandler,
      options,
    };

    if (!this.subscriptions.has(channel)) {
      this.subscriptions.set(channel, []);
    }
    this.subscriptions.get(channel)!.push(sub);

    Logger.debug(`dataflow: subscribed to ${channel} (id: ${sub.id})`);

    return () => {
      const subs = this.subscriptions.get(channel);
      if (subs) {
        const idx = subs.findIndex((s) => s.id === sub.id);
        if (idx !== -1) subs.splice(idx, 1);
      }
    };
  }

  /**
   * Get recent message history for a channel.
   */
  getHistory(channel?: DataFlowChannel, limit = 50): DataFlowEnvelope[] {
    const messages = channel
      ? this.messageHistory.filter((m) => m.channel === channel)
      : this.messageHistory;

    return messages.slice(-limit);
  }

  /**
   * Get messages by correlation ID (for tracing chains).
   */
  getCorrelated(correlationId: string): DataFlowEnvelope[] {
    return this.messageHistory.filter((m) => m.correlationId === correlationId);
  }

  /**
   * Get statistics about the bus.
   */
  getStats(): {
    totalMessages: number;
    channelCounts: Record<string, number>;
    subscriberCounts: Record<string, number>;
  } {
    const channelCounts: Record<string, number> = {};
    const subscriberCounts: Record<string, number> = {};

    for (const msg of this.messageHistory) {
      channelCounts[msg.channel] = (channelCounts[msg.channel] || 0) + 1;
    }

    for (const [channel, subs] of this.subscriptions) {
      subscriberCounts[channel] = subs.length;
    }

    return {
      totalMessages: this.messageHistory.length,
      channelCounts,
      subscriberCounts,
    };
  }

  /**
   * Connect Redis publisher for cross-process messaging.
   */
  setRedisPublisher(publisher: (channel: string, message: string) => Promise<void>): void {
    this.redisPublisher = publisher;
    Logger.info('dataflow: Redis publisher connected');
  }

  /**
   * Handle incoming Redis message (from subscriber).
   */
  handleRedisMessage(channel: string, message: string): void {
    try {
      const envelope = JSON.parse(message) as DataFlowEnvelope;

      // Avoid re-publishing locally-originated messages
      if (this.messageHistory.some((m) => m.id === envelope.id)) return;

      // Verify envelope channel matches actual Redis channel to prevent spoofing
      const resolvedChannel = channel.replace('mcp:dataflow:', '') as DataFlowChannel;
      if (envelope.channel && envelope.channel !== resolvedChannel) {
        Logger.warn(`dataflow: channel mismatch (expected=${resolvedChannel}, got=${envelope.channel}), dropping message`);
        return;
      }

      // Skip expired messages
      if (envelope.ttl && envelope.ttl > 0 && Date.now() - envelope.timestamp > envelope.ttl) {
        Logger.debug(`dataflow: expired Redis message (ttl=${envelope.ttl}ms), skipping`);
        return;
      }

      // Store and deliver
      this.messageHistory.push(envelope);
      if (this.messageHistory.length > this.maxHistory) {
        this.messageHistory.shift();
      }

      const subs = this.subscriptions.get(resolvedChannel) || [];

      for (const sub of subs) {
        if (this.matchesSubscription(sub, envelope)) {
          try {
            sub.handler(envelope);
          } catch (err) {
            Logger.error(`dataflow: Redis handler error: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    } catch (err) {
      Logger.error(`dataflow: failed to parse Redis message: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Clear all subscriptions and history.
   */
  reset(): void {
    this.subscriptions.clear();
    this.messageHistory = [];
    this.redisPublisher = null;
  }

  private matchesSubscription(sub: Subscription, envelope: DataFlowEnvelope): boolean {
    const { sourceFilter, minPriority } = sub.options;

    // Target filtering: skip if message is addressed to a specific target that doesn't match
    if ((sub.options as any).target && (sub.options as any).target !== envelope.target) {
      return false;
    }

    if (sourceFilter?.length && !sourceFilter.includes(envelope.source)) {
      return false;
    }

    if (minPriority !== undefined && envelope.priority < minPriority) {
      return false;
    }

    // TTL enforcement: skip expired messages
    if (envelope.ttl && envelope.ttl > 0 && Date.now() - envelope.timestamp > envelope.ttl) {
      return false;
    }

    return true;
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────────

let busInstance: DataFlowBus | null = null;

/**
 * Get the global DataFlowBus singleton.
 */
export function getDataFlowBus(): DataFlowBus {
  if (!busInstance) {
    busInstance = new DataFlowBus();
  }
  return busInstance;
}

/**
 * Reset the global bus (for testing).
 */
export function resetDataFlowBus(): void {
  busInstance?.reset();
  busInstance = null;
}
