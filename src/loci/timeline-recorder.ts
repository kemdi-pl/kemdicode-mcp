/**
 * KemdiCode MCP Server
 * Copyright (C) 2025-2026 Kemdi Sp. z o.o.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

/**
 * Timeline Recorder
 *
 * Automatically records tool executions as L0 timeline events and
 * populates the knowledge graph with nodes/edges. Handles session
 * continuity linking for cross-compaction resurrection.
 */

import { RedisBackedService } from '../infrastructure/redis/redis-backed-service.js';
import { Logger } from '../utils/logger.js';
import { createHash, randomBytes } from 'crypto';
import { getGraphStorage } from './graph-storage.js';
import type {
  TimelineEvent,
  SessionContinuity,
  CompactionLevel,
} from './types.js';
import { TIMELINE_KEYS, COMPACTION_TTL } from './types.js';

/** Compaction trigger threshold */
const COMPACTION_TRIGGER_COUNT = 50;

/**
 * Generate a short event ID
 */
function generateEventId(): string {
  return `evt_${Date.now()}_${randomBytes(4).toString('hex')}`;
}

/**
 * Hash a project path for Redis key
 */
export function hashProjectPath(projectPath: string): string {
  return createHash('sha256').update(projectPath).digest('hex').slice(0, 16);
}

/**
 * Extract file paths from tool arguments
 */
function extractFiles(args: Record<string, unknown>): string[] {
  const files: string[] = [];

  if (typeof args.path === 'string') files.push(args.path);
  if (typeof args.file === 'string') files.push(args.file);
  if (typeof args.files === 'string') files.push(args.files);
  if (Array.isArray(args.files)) {
    for (const f of args.files) {
      if (typeof f === 'string') files.push(f);
      if (f && typeof f === 'object' && 'path' in f && typeof (f as Record<string, unknown>).path === 'string') {
        files.push((f as Record<string, unknown>).path as string);
      }
    }
  }
  if (typeof args.relatedFiles === 'object' && Array.isArray(args.relatedFiles)) {
    for (const f of args.relatedFiles) {
      if (typeof f === 'string') files.push(f);
    }
  }

  return files;
}

/**
 * Infer tags from tool name
 */
function inferTags(toolName: string): string[] {
  const tags: string[] = [];
  if (toolName.includes('git')) tags.push('git');
  if (toolName.includes('file')) tags.push('file');
  if (toolName.includes('code') || toolName.includes('refactor')) tags.push('code');
  if (toolName.includes('test')) tags.push('test');
  if (toolName.includes('task') || toolName.includes('board')) tags.push('kanban');
  if (toolName.includes('agent') || toolName.includes('monitor')) tags.push('agent');
  if (toolName.includes('review') || toolName.includes('analyze')) tags.push('analysis');
  if (tags.length === 0) tags.push('general');
  return tags;
}

/**
 * Timeline Recorder - records L0 events and populates graph
 */
export class TimelineRecorder extends RedisBackedService {
  protected get serviceName() { return 'TimelineRecorder'; }

  private l0Counter = 0;
  private compactionCallback: ((sessionId: string) => Promise<void>) | null = null;

  /**
   * Set callback for compaction trigger
   */
  setCompactionCallback(cb: (sessionId: string) => Promise<void>): void {
    this.compactionCallback = cb;
  }

  /**
   * Record a tool execution as an L0 timeline event + graph nodes.
   */
  async recordToolExecution(
    toolName: string,
    args: Record<string, unknown>,
    success: boolean,
    durationMs: number,
    sessionId: string,
    agentId: string
  ): Promise<void> {
    if (!this.isConnected() || !this.redis) return;

    try {
      const now = Date.now();
      const files = extractFiles(args);
      const tags = inferTags(toolName);

      // Create L0 event
      const event: TimelineEvent = {
        id: generateEventId(),
        sessionId,
        timestamp: now,
        level: 'L0',
        type: 'tool_exec',
        summary: `${toolName}${success ? '' : ' [FAILED]'}${files.length > 0 ? ` → ${files[0]}` : ''}`,
        toolName,
        success,
        durationMs,
        files: files.length > 0 ? files : undefined,
        tags,
        graphNodeIds: [],
        data: { agentId },
      };

      // Store event and add to timeline sorted set
      const pipeline = this.redis.pipeline();
      const eventKey = TIMELINE_KEYS.event(event.id);
      pipeline.set(eventKey, JSON.stringify(event));
      pipeline.expire(eventKey, COMPACTION_TTL.L0);
      pipeline.zadd(TIMELINE_KEYS.l0(sessionId), now, event.id);
      pipeline.expire(TIMELINE_KEYS.l0(sessionId), COMPACTION_TTL.L0);
      await pipeline.exec();

      // Auto-populate graph (non-blocking)
      this.populateGraph(event, sessionId).catch((err) => {
        Logger.debug(() => `[TimelineRecorder] Graph population failed: ${err instanceof Error ? err.message : String(err)}`);
      });

      // Check compaction trigger
      this.l0Counter++;
      if (this.l0Counter >= COMPACTION_TRIGGER_COUNT && this.compactionCallback) {
        this.l0Counter = 0;
        this.compactionCallback(sessionId).catch((err) => {
          Logger.debug(() => `[TimelineRecorder] Compaction trigger failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
    } catch (error) {
      Logger.debug(() => `[TimelineRecorder] Record failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Auto-populate knowledge graph from timeline event
   */
  private async populateGraph(event: TimelineEvent, sessionId: string): Promise<void> {
    const graph = getGraphStorage();
    if (!graph.isConnected()) {
      await graph.connect();
    }
    if (!graph.isConnected()) return;

    const ttl = COMPACTION_TTL.L0;

    // Create tool node
    const toolNode = await graph.addNode({
      type: 'tool',
      label: `${event.toolName}${event.success ? '' : ' [FAIL]'}`,
      weight: event.success ? 0.5 : 0.7, // failures are more noteworthy
      sessionId,
      data: {
        toolName: event.toolName,
        success: event.success,
        durationMs: event.durationMs,
        eventId: event.id,
      },
      tags: event.tags,
    }, ttl);

    if (!toolNode) return;

    event.graphNodeIds.push(toolNode.id);

    // Create file nodes and edges
    if (event.files) {
      for (const filePath of event.files.slice(0, 5)) {
        const fileNode = await graph.addNode({
          type: 'file',
          label: filePath,
          weight: 0.6,
          sessionId,
          data: { path: filePath },
          tags: ['file'],
        }, ttl);

        if (fileNode) {
          event.graphNodeIds.push(fileNode.id);
          await graph.addEdge(toolNode.id, fileNode.id, 'uses', 0.5, undefined, ttl);
        }
      }
    }

    // If tool failed, create error node
    if (!event.success) {
      const errorNode = await graph.addNode({
        type: 'error',
        label: `Error in ${event.toolName}`,
        weight: 0.8,
        sessionId,
        data: { toolName: event.toolName, eventId: event.id },
        tags: ['error'],
      }, ttl);

      if (errorNode) {
        event.graphNodeIds.push(errorNode.id);
        await graph.addEdge(toolNode.id, errorNode.id, 'produces', 0.7, undefined, ttl);
      }
    }

    // Update event with graph node IDs
    if (this.redis) {
      const eventKey = TIMELINE_KEYS.event(event.id);
      await this.redis.set(eventKey, JSON.stringify(event));
    }
  }

  /**
   * Link current session to predecessor in the continuity chain
   */
  async linkSession(
    currentSessionId: string,
    projectPath: string,
    predecessorSessionId?: string
  ): Promise<SessionContinuity> {
    const projectHash = hashProjectPath(projectPath);
    const now = Date.now();

    const continuity: SessionContinuity = {
      sessionId: currentSessionId,
      projectPath,
      predecessorSessionId,
      startedAt: now,
    };

    if (this.isConnected() && this.redis) {
      const pipeline = this.redis.pipeline();

      // Store continuity metadata
      pipeline.set(
        TIMELINE_KEYS.continuityMeta(currentSessionId),
        JSON.stringify(continuity)
      );

      // Add to project continuity chain (list)
      pipeline.rpush(TIMELINE_KEYS.continuity(projectHash), currentSessionId);

      // Auto-detect predecessor if not specified
      if (!predecessorSessionId) {
        const chain = await this.redis.lrange(TIMELINE_KEYS.continuity(projectHash), -2, -2);
        if (chain.length > 0) {
          continuity.predecessorSessionId = chain[0];

          // Update predecessor with successor link
          const predMeta = await this.redis.get(TIMELINE_KEYS.continuityMeta(chain[0]));
          if (predMeta) {
            const pred: SessionContinuity = JSON.parse(predMeta);
            pred.successorSessionId = currentSessionId;
            pipeline.set(TIMELINE_KEYS.continuityMeta(chain[0]), JSON.stringify(pred));
          }
        }
      }

      // Record session_start event
      const startEvent: TimelineEvent = {
        id: generateEventId(),
        sessionId: currentSessionId,
        timestamp: now,
        level: 'L0',
        type: 'session_start',
        summary: `Session started${continuity.predecessorSessionId ? ` (continues ${continuity.predecessorSessionId.slice(0, 12)}...)` : ''}`,
        tags: ['session'],
        graphNodeIds: [],
      };

      const eventKey = TIMELINE_KEYS.event(startEvent.id);
      pipeline.set(eventKey, JSON.stringify(startEvent));
      pipeline.expire(eventKey, COMPACTION_TTL.L0);
      pipeline.zadd(TIMELINE_KEYS.l0(currentSessionId), now, startEvent.id);

      await pipeline.exec();
    }

    return continuity;
  }

  /**
   * Mark session end
   */
  async markSessionEnd(
    sessionId: string,
    reason: SessionContinuity['endReason'] = 'manual'
  ): Promise<void> {
    if (!this.isConnected() || !this.redis) return;

    const metaKey = TIMELINE_KEYS.continuityMeta(sessionId);
    const metaRaw = await this.redis.get(metaKey);

    if (metaRaw) {
      const meta: SessionContinuity = JSON.parse(metaRaw);
      meta.endedAt = Date.now();
      meta.endReason = reason;
      await this.redis.set(metaKey, JSON.stringify(meta));
    }

    // Record session_end event
    const endEvent: TimelineEvent = {
      id: generateEventId(),
      sessionId,
      timestamp: Date.now(),
      level: 'L0',
      type: 'session_end',
      summary: `Session ended: ${reason}`,
      tags: ['session'],
      graphNodeIds: [],
    };

    const eventKey = TIMELINE_KEYS.event(endEvent.id);
    const pipeline = this.redis.pipeline();
    pipeline.set(eventKey, JSON.stringify(endEvent));
    pipeline.expire(eventKey, COMPACTION_TTL.L0);
    pipeline.zadd(TIMELINE_KEYS.l0(sessionId), Date.now(), endEvent.id);
    await pipeline.exec();
  }

  /**
   * Get session continuity chain for a project
   */
  async getContinuityChain(projectPath: string): Promise<SessionContinuity[]> {
    if (!this.isConnected() || !this.redis) return [];

    const projectHash = hashProjectPath(projectPath);
    const sessionIds = await this.redis.lrange(TIMELINE_KEYS.continuity(projectHash), 0, -1);

    const chain: SessionContinuity[] = [];
    for (const sid of sessionIds) {
      const metaRaw = await this.redis.get(TIMELINE_KEYS.continuityMeta(sid));
      if (metaRaw) {
        chain.push(JSON.parse(metaRaw));
      }
    }

    return chain;
  }

  /**
   * Get L0 events for a session
   */
  async getEvents(
    sessionId: string,
    level: CompactionLevel = 'L0',
    limit: number = 50
  ): Promise<TimelineEvent[]> {
    if (!this.isConnected() || !this.redis) return [];

    const key = TIMELINE_KEYS.forLevel(level, sessionId);
    const eventIds = await this.redis.zrevrange(key, 0, limit - 1);

    const events: TimelineEvent[] = [];
    for (const eid of eventIds) {
      const raw = await this.redis.get(TIMELINE_KEYS.event(eid));
      if (raw) {
        events.push(JSON.parse(raw));
      }
    }

    return events;
  }

  /**
   * Count events at a given level
   */
  async countEvents(sessionId: string, level: CompactionLevel = 'L0'): Promise<number> {
    if (!this.isConnected() || !this.redis) return 0;
    return this.redis.zcard(TIMELINE_KEYS.forLevel(level, sessionId));
  }
}

// Singleton
let timelineRecorder: TimelineRecorder | null = null;

export function getTimelineRecorder(): TimelineRecorder {
  if (!timelineRecorder) {
    timelineRecorder = new TimelineRecorder();
  }
  return timelineRecorder;
}

export function resetTimelineRecorder(): void {
  if (timelineRecorder) {
    timelineRecorder.disconnect().catch((err) => Logger.error(err));
  }
  timelineRecorder = null;
}
