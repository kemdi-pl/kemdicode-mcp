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
 * Compaction Engine
 *
 * Hierarchical compaction of timeline events:
 * L0 (raw, 24h) -> L1 (hourly summaries, 7d) -> L2 (daily summaries, 30d) -> L3 (key facts, permanent)
 *
 * Also generates resurrection context for agents resuming after compaction.
 */

import { RedisBackedService } from '../infrastructure/redis/redis-backed-service.js';
import { Logger } from '../utils/logger.js';
import { getGraphStorage } from './graph-storage.js';
import { aStarSearch } from './graph-traversal.js';
import { getLociManager } from './loci-manager.js';
import { getSequenceTracker } from './sequence-tracker.js';
import { getTimelineRecorder } from './timeline-recorder.js';
import { getCrossLinker } from '../cognition/cross-linker.js';
import { getIntentStore } from '../cognition/intent-store.js';
import type {
  TimelineEvent,
  CompactionState,
  ResurrectionContext,
  GraphNode,
} from './types.js';
import { TIMELINE_KEYS, COMPACTION_TTL } from './types.js';

/** Thresholds for triggering compaction */
const COMPACTION_THRESHOLDS = {
  L0_TO_L1: 50,   // Compact after 50 L0 events
  L1_TO_L2: 24,   // Compact after 24 L1 summaries (~1 day)
  L2_TO_L3: 7,    // Compact after 7 L2 summaries (~1 week)
};

/** Max events to process in one compaction pass */
const MAX_COMPACTION_BATCH = 200;

/**
 * Group events by time bucket
 */
function groupByTimeBucket(events: TimelineEvent[], bucketMs: number): Map<number, TimelineEvent[]> {
  const groups = new Map<number, TimelineEvent[]>();
  for (const event of events) {
    const bucket = Math.floor(event.timestamp / bucketMs) * bucketMs;
    const group = groups.get(bucket);
    if (group) {
      group.push(event);
    } else {
      groups.set(bucket, [event]);
    }
  }
  return groups;
}

/**
 * Summarize a group of events into a compact string
 */
function summarizeGroup(events: TimelineEvent[]): string {
  const toolCounts = new Map<string, number>();
  let errors = 0;
  const filesSet = new Set<string>();

  for (const event of events) {
    if (event.toolName) {
      toolCounts.set(event.toolName, (toolCounts.get(event.toolName) || 0) + 1);
    }
    if (event.success === false) errors++;
    if (event.files) {
      for (const f of event.files) filesSet.add(f);
    }
  }

  // Top 5 tools by frequency
  const topTools = [...toolCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => `${name}(${count})`)
    .join(', ');

  const files = [...filesSet].slice(0, 5);
  const parts: string[] = [
    `${events.length} calls`,
  ];

  if (topTools) parts.push(`tools: ${topTools}`);
  if (errors > 0) parts.push(`${errors} errors`);
  if (files.length > 0) parts.push(`files: ${files.join(', ')}`);

  return parts.join('; ');
}

/**
 * Extract key facts from daily summaries (pattern-based)
 */
function extractKeyFacts(events: TimelineEvent[]): string[] {
  const facts: string[] = [];
  const toolUsage = new Map<string, number>();
  const errorTools = new Set<string>();
  const allFiles = new Set<string>();
  let totalCalls = 0;
  let totalErrors = 0;

  for (const event of events) {
    if (event.toolName) {
      toolUsage.set(event.toolName, (toolUsage.get(event.toolName) || 0) + 1);
    }
    if (event.success === false) {
      totalErrors++;
      if (event.toolName) errorTools.add(event.toolName);
    }
    if (event.files) {
      for (const f of event.files) allFiles.add(f);
    }
    totalCalls++;
  }

  // Most used tools
  const topTools = [...toolUsage.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
  if (topTools.length > 0) {
    facts.push(`Primary tools: ${topTools.map(([n, c]) => `${n}(${c})`).join(', ')}`);
  }

  // Error patterns
  if (errorTools.size > 0) {
    facts.push(`Error-prone tools: ${[...errorTools].join(', ')}`);
  }

  // Active files
  const topFiles = [...allFiles].slice(0, 10);
  if (topFiles.length > 0) {
    facts.push(`Active files: ${topFiles.join(', ')}`);
  }

  // Stats
  facts.push(`Total: ${totalCalls} calls, ${totalErrors} errors (${totalCalls > 0 ? Math.round((totalErrors / totalCalls) * 100) : 0}% error rate)`);

  return facts;
}

/**
 * Compaction Engine
 */
export class CompactionEngine extends RedisBackedService {
  protected get serviceName() { return 'CompactionEngine'; }

  /**
   * Run compaction for a session (called after COMPACTION_TRIGGER_COUNT L0 events)
   */
  async runCompaction(sessionId: string): Promise<void> {
    if (!this.isConnected() || !this.redis) return;

    try {
      const state = await this.getCompactionState(sessionId);

      // L0 -> L1 (hourly summaries)
      const l0Count = await this.redis.zcard(TIMELINE_KEYS.l0(sessionId));
      if (l0Count >= COMPACTION_THRESHOLDS.L0_TO_L1) {
        await this.compactL0ToL1(sessionId, state);
      }

      // L1 -> L2 (daily summaries)
      const l1Count = await this.redis.zcard(TIMELINE_KEYS.l1(sessionId));
      if (l1Count >= COMPACTION_THRESHOLDS.L1_TO_L2) {
        await this.compactL1ToL2(sessionId, state);
      }

      // L2 -> L3 (key facts)
      const l2Count = await this.redis.zcard(TIMELINE_KEYS.l2(sessionId));
      if (l2Count >= COMPACTION_THRESHOLDS.L2_TO_L3) {
        await this.compactL2ToL3(sessionId, state);
      }

      await this.saveCompactionState(sessionId, state);
    } catch (error) {
      Logger.debug(() => `[CompactionEngine] Compaction failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Compact L0 raw events into L1 hourly summaries
   */
  private async compactL0ToL1(sessionId: string, state: CompactionState): Promise<void> {
    if (!this.redis) return;

    const sinceTs = state.lastL0ToL1Ts || 0;
    const now = Date.now();

    // Get L0 events since last compaction (up to batch limit)
    const eventIds = await this.redis.zrangebyscore(
      TIMELINE_KEYS.l0(sessionId),
      sinceTs,
      now - 3600000, // Only compact events older than 1 hour
      'LIMIT', 0, MAX_COMPACTION_BATCH
    );

    if (eventIds.length === 0) return;

    // Load events
    const events: TimelineEvent[] = [];
    for (const eid of eventIds) {
      const raw = await this.redis.get(TIMELINE_KEYS.event(eid));
      if (raw) {
        events.push(JSON.parse(raw));
      }
    }

    if (events.length === 0) return;

    // Group by hour
    const hourMs = 3600000;
    const groups = groupByTimeBucket(events, hourMs);

    const pipeline = this.redis.pipeline();

    for (const [bucket, groupEvents] of groups) {
      const summary = summarizeGroup(groupEvents);
      const date = new Date(bucket);
      const hourStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:00`;

      const l1Event: TimelineEvent = {
        id: `l1_${bucket}_${sessionId.slice(0, 8)}`,
        sessionId,
        timestamp: bucket,
        level: 'L1',
        type: 'summary',
        summary: `${hourStr}: ${summary}`,
        tags: [...new Set(groupEvents.flatMap(e => e.tags))],
        graphNodeIds: [...new Set(groupEvents.flatMap(e => e.graphNodeIds))],
        data: {
          eventCount: groupEvents.length,
          errorCount: groupEvents.filter(e => e.success === false).length,
          toolNames: [...new Set(groupEvents.map(e => e.toolName).filter(Boolean))],
          files: [...new Set(groupEvents.flatMap(e => e.files || []))].slice(0, 20),
        },
      };

      const eventKey = TIMELINE_KEYS.event(l1Event.id);
      pipeline.set(eventKey, JSON.stringify(l1Event));
      pipeline.expire(eventKey, COMPACTION_TTL.L1);
      pipeline.zadd(TIMELINE_KEYS.l1(sessionId), bucket, l1Event.id);
    }

    // Set TTL on L1 sorted set
    pipeline.expire(TIMELINE_KEYS.l1(sessionId), COMPACTION_TTL.L1);
    await pipeline.exec();

    // Update state
    state.lastL0ToL1Ts = now;
    state.l1Count = (state.l1Count || 0) + groups.size;

    Logger.debug(() => `[CompactionEngine] L0→L1: ${events.length} events → ${groups.size} hourly summaries`);
  }

  /**
   * Compact L1 hourly summaries into L2 daily summaries
   */
  private async compactL1ToL2(sessionId: string, state: CompactionState): Promise<void> {
    if (!this.redis) return;

    const sinceTs = state.lastL1ToL2Ts || 0;
    const now = Date.now();

    const eventIds = await this.redis.zrangebyscore(
      TIMELINE_KEYS.l1(sessionId),
      sinceTs,
      now - 86400000, // Only compact L1 events older than 1 day
      'LIMIT', 0, MAX_COMPACTION_BATCH
    );

    if (eventIds.length === 0) return;

    const events: TimelineEvent[] = [];
    for (const eid of eventIds) {
      const raw = await this.redis.get(TIMELINE_KEYS.event(eid));
      if (raw) events.push(JSON.parse(raw));
    }

    if (events.length === 0) return;

    // Group by day
    const dayMs = 86400000;
    const groups = groupByTimeBucket(events, dayMs);

    const pipeline = this.redis.pipeline();

    for (const [bucket, groupEvents] of groups) {
      const date = new Date(bucket);
      const dayStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

      // Aggregate from L1 data fields
      let totalCalls = 0;
      let totalErrors = 0;
      const allTools = new Set<string>();
      const allFiles = new Set<string>();

      for (const e of groupEvents) {
        const data = (e.data || {}) as Record<string, unknown>;
        totalCalls += (data.eventCount as number) || 0;
        totalErrors += (data.errorCount as number) || 0;
        if (Array.isArray(data.toolNames)) {
          for (const t of data.toolNames) allTools.add(t as string);
        }
        if (Array.isArray(data.files)) {
          for (const f of data.files) allFiles.add(f as string);
        }
      }

      const l2Event: TimelineEvent = {
        id: `l2_${bucket}_${sessionId.slice(0, 8)}`,
        sessionId,
        timestamp: bucket,
        level: 'L2',
        type: 'summary',
        summary: `${dayStr}: ${totalCalls} calls, ${totalErrors} errors, ${allTools.size} tools, ${allFiles.size} files`,
        tags: [...new Set(groupEvents.flatMap(e => e.tags))],
        graphNodeIds: [...new Set(groupEvents.flatMap(e => e.graphNodeIds))],
        data: {
          totalCalls,
          totalErrors,
          toolNames: [...allTools],
          files: [...allFiles].slice(0, 50),
          hourlyBreakdown: groupEvents.map(e => e.summary),
        },
      };

      const eventKey = TIMELINE_KEYS.event(l2Event.id);
      pipeline.set(eventKey, JSON.stringify(l2Event));
      pipeline.expire(eventKey, COMPACTION_TTL.L2);
      pipeline.zadd(TIMELINE_KEYS.l2(sessionId), bucket, l2Event.id);
    }

    pipeline.expire(TIMELINE_KEYS.l2(sessionId), COMPACTION_TTL.L2);
    await pipeline.exec();

    state.lastL1ToL2Ts = now;
    state.l2Count = (state.l2Count || 0) + groups.size;

    Logger.debug(() => `[CompactionEngine] L1→L2: ${events.length} hourly → ${groups.size} daily summaries`);
  }

  /**
   * Compact L2 daily summaries into L3 key facts (permanent)
   */
  private async compactL2ToL3(sessionId: string, state: CompactionState): Promise<void> {
    if (!this.redis) return;

    const sinceTs = state.lastL2ToL3Ts || 0;

    const eventIds = await this.redis.zrangebyscore(
      TIMELINE_KEYS.l2(sessionId),
      sinceTs,
      '+inf',
      'LIMIT', 0, MAX_COMPACTION_BATCH
    );

    if (eventIds.length === 0) return;

    // Load all L2 events to extract underlying L0 patterns
    const l2Events: TimelineEvent[] = [];
    for (const eid of eventIds) {
      const raw = await this.redis.get(TIMELINE_KEYS.event(eid));
      if (raw) l2Events.push(JSON.parse(raw));
    }

    if (l2Events.length === 0) return;

    // Aggregate all data across L2 events
    const allToolNames = new Set<string>();
    const allFiles = new Set<string>();
    let grandTotalCalls = 0;
    let grandTotalErrors = 0;

    for (const e of l2Events) {
      const data = (e.data || {}) as Record<string, unknown>;
      grandTotalCalls += (data.totalCalls as number) || 0;
      grandTotalErrors += (data.totalErrors as number) || 0;
      if (Array.isArray(data.toolNames)) {
        for (const t of data.toolNames) allToolNames.add(t as string);
      }
      if (Array.isArray(data.files)) {
        for (const f of data.files) allFiles.add(f as string);
      }
    }

    const keyFacts = extractKeyFacts(l2Events);

    const dateRange = l2Events.length > 0
      ? `${new Date(l2Events[0].timestamp).toISOString().slice(0, 10)} to ${new Date(l2Events[l2Events.length - 1].timestamp).toISOString().slice(0, 10)}`
      : 'unknown';

    const l3Event: TimelineEvent = {
      id: `l3_${Date.now()}_${sessionId.slice(0, 8)}`,
      sessionId,
      timestamp: Date.now(),
      level: 'L3',
      type: 'key_facts',
      summary: `Key facts (${dateRange}): ${keyFacts.slice(0, 3).join('; ')}`,
      tags: ['key-facts'],
      graphNodeIds: [...new Set(l2Events.flatMap(e => e.graphNodeIds))],
      data: {
        keyFacts,
        dateRange,
        totalCalls: grandTotalCalls,
        totalErrors: grandTotalErrors,
        toolNames: [...allToolNames],
        files: [...allFiles].slice(0, 100),
        l2Summaries: l2Events.map(e => e.summary),
      },
    };

    const pipeline = this.redis.pipeline();
    const eventKey = TIMELINE_KEYS.event(l3Event.id);
    pipeline.set(eventKey, JSON.stringify(l3Event));
    // L3 has no TTL (permanent) — but set a very long one as safety net
    if (COMPACTION_TTL.L3 > 0) {
      pipeline.expire(eventKey, COMPACTION_TTL.L3);
    }
    pipeline.zadd(TIMELINE_KEYS.l3(sessionId), Date.now(), l3Event.id);
    await pipeline.exec();

    state.lastL2ToL3Ts = Date.now();
    state.l3Count = (state.l3Count || 0) + 1;

    Logger.debug(() => `[CompactionEngine] L2→L3: ${l2Events.length} daily → 1 key facts entry`);
  }

  /**
   * Generate resurrection context for an agent resuming after compaction.
   *
   * Gathers:
   * 1. Session continuity chain
   * 2. L3 key facts (permanent knowledge)
   * 3. Recent L2/L1 summaries
   * 4. Relevant graph nodes (via goal-based search)
   * 5. Pending kanban tasks
   * 6. Unresolved errors
   */
  async generateResurrectionContext(
    projectPath: string,
    currentGoal?: string,
    sessionId?: string
  ): Promise<ResurrectionContext> {
    const context: ResurrectionContext = {
      continuityChain: [],
      keyFacts: [],
      recentSummaries: [],
      activeFiles: [],
      suggestedActions: [],
    };

    if (!this.isConnected() || !this.redis) return context;

    try {
      const recorder = getTimelineRecorder();
      if (!recorder.isConnected()) {
        await recorder.connect();
      }

      // 1. Get continuity chain
      context.continuityChain = await recorder.getContinuityChain(projectPath);

      // Determine the relevant session IDs
      const sessionIds: string[] = [];
      if (sessionId) {
        sessionIds.push(sessionId);
      }
      for (const c of context.continuityChain) {
        sessionIds.push(c.sessionId);
      }

      // 2. Gather L3 key facts from all sessions in the chain
      for (const sid of sessionIds) {
        const l3Events = await recorder.getEvents(sid, 'L3', 10);
        for (const event of l3Events) {
          const data = (event.data || {}) as Record<string, unknown>;
          if (Array.isArray(data.keyFacts)) {
            context.keyFacts.push(...(data.keyFacts as string[]));
          }
        }
      }
      // Dedupe key facts
      context.keyFacts = [...new Set(context.keyFacts)];

      // 3. Gather recent L2 and L1 summaries
      for (const sid of sessionIds.slice(0, 3)) {
        const l2Events = await recorder.getEvents(sid, 'L2', 5);
        const l1Events = await recorder.getEvents(sid, 'L1', 10);
        context.recentSummaries.push(
          ...l2Events.map(e => e.summary),
          ...l1Events.map(e => e.summary)
        );
      }

      // 4. Extract active files from recent events
      const filesSet = new Set<string>();
      for (const sid of sessionIds.slice(0, 2)) {
        const recentL0 = await recorder.getEvents(sid, 'L0', 30);
        for (const event of recentL0) {
          if (event.files) {
            for (const f of event.files) filesSet.add(f);
          }
        }
      }
      context.activeFiles = [...filesSet].slice(0, 20);

      // 5. Goal-based A* graph search (if goal provided)
      if (currentGoal) {
        const graph = getGraphStorage();
        if (!graph.isConnected()) {
          await graph.connect();
        }

        if (graph.isConnected()) {
          const goalWords = currentGoal.toLowerCase().split(/\s+/).filter(w => w.length > 3);

          // Try A* search from graph nodes linked to timeline events
          const graphNodeIds = new Set<string>();
          for (const sid of sessionIds.slice(0, 2)) {
            const recentEvents = await recorder.getEvents(sid, 'L0', 20);
            for (const event of recentEvents) {
              for (const nid of event.graphNodeIds) graphNodeIds.add(nid);
            }
          }

          // A* from each seed node with goal heuristic
          const goalFn = (node: GraphNode): number => {
            const labelLower = node.label.toLowerCase();
            let matchScore = 0;
            for (const w of goalWords) {
              if (labelLower.includes(w)) matchScore++;
            }
            // Score 0 = perfect match, 1 = no match
            return goalWords.length > 0 ? 1 - (matchScore / goalWords.length) : 0.5;
          };

          const aStarResults: GraphNode[] = [];
          const seenNodeIds = new Set<string>();

          for (const seedId of [...graphNodeIds].slice(0, 5)) {
            try {
              const nodes = await aStarSearch(seedId, goalFn, {
                maxResults: 10,
                relevanceThreshold: 0.7,
                maxDepth: 4,
                maxNodes: 100,
              });
              for (const node of nodes) {
                if (!seenNodeIds.has(node.id)) {
                  seenNodeIds.add(node.id);
                  aStarResults.push(node);
                }
              }
            } catch {
              // Individual A* search may fail if node expired
            }
          }

          // Classify A* results
          context.graphInsights = [];
          for (const node of aStarResults.slice(0, 15)) {
            if (node.type === 'error') {
              if (!context.unresolvedErrors) context.unresolvedErrors = [];
              context.unresolvedErrors.push(node.label);
            } else if (node.type === 'file') {
              if (!context.activeFiles.includes(node.label)) {
                context.activeFiles.push(node.label);
              }
            } else {
              context.graphInsights.push(`[${node.type}] ${node.label}`);
            }
          }

          // Fallback: if A* found nothing, do simple label search
          if (aStarResults.length === 0) {
            for (const sid of sessionIds.slice(0, 2)) {
              const nodes = await graph.queryNodes({
                sessionId: sid,
                limit: 20,
                sortBy: 'weight',
                sortOrder: 'desc',
              });
              for (const node of nodes) {
                const labelLower = node.label.toLowerCase();
                const relevant = goalWords.some(w => labelLower.includes(w));
                if (relevant) {
                  if (node.type === 'error') {
                    if (!context.unresolvedErrors) context.unresolvedErrors = [];
                    context.unresolvedErrors.push(node.label);
                  } else if (node.type === 'file') {
                    if (!context.activeFiles.includes(node.label)) {
                      context.activeFiles.push(node.label);
                    }
                  } else {
                    if (!context.graphInsights) context.graphInsights = [];
                    context.graphInsights.push(`[${node.type}] ${node.label}`);
                  }
                }
              }
            }
          }
        }
      }

      // 5.5. CTC: Causal core tagging
      // Tag graph insights that are in the causal core with [CORE] prefix
      // to prioritize them during context reconstruction.
      try {
        const crossLinker = getCrossLinker();
        const intentStore = getIntentStore();
        if (crossLinker.isConnected() && intentStore.isConnected()) {
          const effectiveSessionId = sessionId || sessionIds[0] || '';
          if (effectiveSessionId) {
            const activeIntent = await intentStore.getActiveIntent(effectiveSessionId);
            if (activeIntent) {
              const coreResult = await crossLinker.findCausalCore(effectiveSessionId, activeIntent.id);
              if (coreResult.coreItems.size > 0 && context.graphInsights) {
                context.graphInsights = context.graphInsights.map((insight) => {
                  // Check if any core item key appears in the insight text
                  for (const coreKey of coreResult.coreItems) {
                    const [, coreId] = coreKey.split(':');
                    if (coreId && insight.includes(coreId)) {
                      return `[CORE] ${insight}`;
                    }
                  }
                  return insight;
                });
                // Add causal core size as a suggested action
                context.suggestedActions.push(
                  `Causal core: ${coreResult.coreItems.size} essential items (of ${coreResult.totalItems} total)`,
                );
              }
            }
          }
        }
      } catch {
        // CTC causal core is an optimization, not critical
      }

      // 6. Loci palace associations
      try {
        const lociManager = getLociManager();
        if (!lociManager.isConnected()) {
          await lociManager.connect();
        }

        if (lociManager.isConnected()) {
          // Walk palace for all sessions in chain
          for (const sid of sessionIds.slice(0, 2)) {
            const recalls = await lociManager.walkPalace(sid);
            if (recalls.length > 0) {
              context.lociAssociations = context.lociAssociations || [];
              for (const recall of recalls.slice(0, 5)) {
                const icon = recall.loci.icon || '';
                context.lociAssociations.push(
                  `${icon} ${recall.loci.name}: ${recall.nodes.length} memories`
                );
                // Include triggered associations (mnemonic cues)
                for (const assoc of recall.associationsTriggered.slice(0, 2)) {
                  context.lociAssociations.push(`  - ${assoc}`);
                }
              }
            }
          }
        }
      } catch {
        // Loci manager may not be available
      }

      // 7. Tool sequence patterns
      try {
        const seqTracker = getSequenceTracker();
        if (!seqTracker.isConnected()) {
          await seqTracker.connect();
        }

        if (seqTracker.isConnected()) {
          for (const sid of sessionIds.slice(0, 2)) {
            const sequences = await seqTracker.getSequences(sid);
            if (sequences.length > 0) {
              context.toolPatterns = context.toolPatterns || [];
              for (const seq of sequences.slice(0, 5)) {
                const rate = Math.round(seq.successRate * 100);
                context.toolPatterns.push(
                  `${seq.tools.join(' -> ')} (${seq.occurrences}x, ${rate}% success)`
                );
              }
            }
          }
        }
      } catch {
        // Sequence tracker may not be available
      }

      // 8. Generate suggested actions
      if (context.unresolvedErrors && context.unresolvedErrors.length > 0) {
        context.suggestedActions.push(`Fix ${context.unresolvedErrors.length} unresolved error(s)`);
      }
      if (context.activeFiles.length > 0) {
        context.suggestedActions.push(`Continue work on: ${context.activeFiles.slice(0, 3).join(', ')}`);
      }
      if (context.toolPatterns && context.toolPatterns.length > 0) {
        context.suggestedActions.push(`Follow learned pattern: ${context.toolPatterns[0]}`);
      }
      if (context.keyFacts.length === 0) {
        context.suggestedActions.push('No prior key facts found - this may be a fresh project');
      }

    } catch (error) {
      Logger.debug(() => `[CompactionEngine] Resurrection context failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    return context;
  }

  /**
   * Get compaction state for a session
   */
  private async getCompactionState(sessionId: string): Promise<CompactionState> {
    if (!this.redis) {
      return { lastL0ToL1Ts: 0, lastL1ToL2Ts: 0, lastL2ToL3Ts: 0, l0Count: 0, l1Count: 0, l2Count: 0, l3Count: 0 };
    }

    const key = TIMELINE_KEYS.compactionState(sessionId);
    const raw = await this.redis.get(key);
    if (raw) {
      return JSON.parse(raw);
    }
    return { lastL0ToL1Ts: 0, lastL1ToL2Ts: 0, lastL2ToL3Ts: 0, l0Count: 0, l1Count: 0, l2Count: 0, l3Count: 0 };
  }

  /**
   * Save compaction state
   */
  private async saveCompactionState(sessionId: string, state: CompactionState): Promise<void> {
    if (!this.redis) return;
    const key = TIMELINE_KEYS.compactionState(sessionId);
    await this.redis.set(key, JSON.stringify(state));
  }
}

// Singleton
let compactionEngine: CompactionEngine | null = null;

export function getCompactionEngine(): CompactionEngine {
  if (!compactionEngine) {
    compactionEngine = new CompactionEngine();
  }
  return compactionEngine;
}

export function resetCompactionEngine(): void {
  if (compactionEngine) {
    compactionEngine.disconnect().catch((err) => Logger.error(err));
  }
  compactionEngine = null;
}
