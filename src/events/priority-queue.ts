/**
 * KemdiCode MCP Server - Priority Event Queue
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
 * Priority Queue for Event Bus
 *
 * Features:
 * - 4 priority levels (0-3)
 * - O(1) enqueue for same-priority events
 * - O(log n) priority changes
 * - Burst protection
 * - Batch processing for high-throughput scenarios
 *
 * @module events/priority-queue
 */

export type EventPriority = 0 | 1 | 2 | 3;

interface QueuedEvent<T = unknown> {
  type: string;
  payload: T;
  priority: EventPriority;
  timestamp: number;
  id: string;
  retries: number;
  maxRetries: number;
}

export interface PriorityQueueConfig {
  /** Max queue size per priority level */
  maxSizePerPriority?: number;
  /** Enable batch processing */
  batchSize?: number;
  /** Batch processing interval in ms */
  batchInterval?: number;
  /** Enable burst protection */
  burstProtection?: boolean;
  /** Max events per burst window */
  maxBurstEvents?: number;
  /** Burst window in ms */
  burstWindowMs?: number;
}

export class PriorityEventQueue<T = unknown> {
  private queues: Map<EventPriority, QueuedEvent<T>[]> = new Map();
  private priorityOrder: EventPriority[] = [3, 2, 1, 0];
  private config: Required<PriorityQueueConfig>;
  private size = 0;
  private burstCounter = new Map<number, number>();
  private burstWindowStart = 0;
  private processing = false;
  private batchTimer: NodeJS.Timeout | null = null;

  constructor(config: PriorityQueueConfig = {}) {
    this.config = {
      maxSizePerPriority: config.maxSizePerPriority ?? 1000,
      batchSize: config.batchSize ?? 10,
      batchInterval: config.batchInterval ?? 10,
      burstProtection: config.burstProtection ?? true,
      maxBurstEvents: config.maxBurstEvents ?? 100,
      burstWindowMs: config.burstWindowMs ?? 1000,
    };

    for (const p of this.priorityOrder) {
      this.queues.set(p, []);
    }
  }

  enqueue(type: string, payload: T, priority: EventPriority = 1, maxRetries = 3): boolean {
    const now = Date.now();

    if (this.config.burstProtection) {
      if (this.checkBurstExceeded(now)) {
        return false;
      }
    }

    const queue = this.queues.get(priority);
    if (!queue) return false;

    if (queue.length >= this.config.maxSizePerPriority) {
      return false;
    }

    queue.push({
      type,
      payload,
      priority,
      timestamp: now,
      id: `${type}:${now}:${Math.random().toString(36).slice(2)}`,
      retries: 0,
      maxRetries,
    });

    this.size++;
    return true;
  }

  dequeue(): QueuedEvent<T> | null {
    for (const priority of this.priorityOrder) {
      const queue = this.queues.get(priority);
      if (queue && queue.length > 0) {
        this.size--;
        return queue.shift()!;
      }
    }
    return null;
  }

  dequeueBatch(maxBatchSize?: number): QueuedEvent<T>[] {
    const batch: QueuedEvent<T>[] = [];
    const limit = maxBatchSize ?? this.config.batchSize;

    while (batch.length < limit) {
      const event = this.dequeue();
      if (!event) break;
      batch.push(event);
    }

    return batch;
  }

  peek(priority?: EventPriority): QueuedEvent<T> | null {
    if (priority !== undefined) {
      const queue = this.queues.get(priority);
      return queue && queue.length > 0 ? queue[0] : null;
    }

    for (const p of this.priorityOrder) {
      const queue = this.queues.get(p);
      if (queue && queue.length > 0) {
        return queue[0];
      }
    }
    return null;
  }

  peekByType(type: string): QueuedEvent<T> | null {
    for (const queue of this.queues.values()) {
      for (const event of queue) {
        if (event.type === type) {
          return event;
        }
      }
    }
    return null;
  }

  removeByType(type: string): number {
    let removed = 0;
    for (const queue of this.queues.values()) {
      const newQueue = queue.filter((e) => e.type !== type);
      removed += queue.length - newQueue.length;
      this.size -= queue.length - newQueue.length;
      queue.length = 0;
      queue.push(...newQueue);
    }
    return removed;
  }

  updatePriority(type: string, newPriority: EventPriority): boolean {
    for (const queue of this.queues.values()) {
      const idx = queue.findIndex((e) => e.type === type);
      if (idx !== -1) {
        const event = queue.splice(idx, 1)[0];
        event.priority = newPriority;
        event.timestamp = Date.now();

        const newQueue = this.queues.get(newPriority);
        if (newQueue && newQueue.length < this.config.maxSizePerPriority) {
          newQueue.push(event);
          return true;
        } else {
          queue.push(event);
          return false;
        }
      }
    }
    return false;
  }

  getSize(priority?: EventPriority): number {
    if (priority !== undefined) {
      return this.queues.get(priority)?.length ?? 0;
    }
    return this.size;
  }

  isEmpty(): boolean {
    return this.size === 0;
  }

  clear(): void {
    for (const queue of this.queues.values()) {
      queue.length = 0;
    }
    this.size = 0;
    this.burstCounter.clear();
  }

  getStats(): {
    totalSize: number;
    byPriority: Record<number, number>;
    isProcessing: boolean;
  } {
    const byPriority: Record<number, number> = {};
    for (const [p, queue] of this.queues) {
      byPriority[p] = queue.length;
    }
    return {
      totalSize: this.size,
      byPriority,
      isProcessing: this.processing,
    };
  }

  private checkBurstExceeded(now: number): boolean {
    if (now - this.burstWindowStart >= this.config.burstWindowMs) {
      this.burstWindowStart = now;
      this.burstCounter.clear();
    }

    const currentCount = this.burstCounter.get(now) ?? 0;
    if (currentCount >= this.config.maxBurstEvents) {
      return true;
    }

    this.burstCounter.set(now, currentCount + 1);
    return false;
  }

  startBatchProcessing(handler: (events: QueuedEvent<T>[]) => Promise<void>): void {
    if (this.processing) return;
    this.processing = true;

    const process = async () => {
      const batch = this.dequeueBatch();
      if (batch.length > 0) {
        await handler(batch);
      }
    };

    this.batchTimer = setInterval(process, this.config.batchInterval);
  }

  stopBatchProcessing(): void {
    if (this.batchTimer) {
      clearInterval(this.batchTimer);
      this.batchTimer = null;
    }
    this.processing = false;
  }
}

export function createPriorityQueue<T>(config?: PriorityQueueConfig): PriorityEventQueue<T> {
  return new PriorityEventQueue<T>(config);
}
