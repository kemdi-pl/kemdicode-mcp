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
 * Tool Execution Tracking
 *
 * Records tool executions for sequence tracking, timeline recording,
 * ambient learning, and agent ranking. All operations are fire-and-forget.
 *
 * Extracted from rl/middleware.ts after RL module removal (v3.3.1).
 */

import { getSequenceTracker } from '../loci/sequence-tracker.js';
import { getTimelineRecorder } from '../loci/timeline-recorder.js';
import { getCompactionEngine } from '../loci/compaction-engine.js';
import { getAmbientLearner } from '../cognition/ambient-learner.js';
import { getAgentRankStore } from '../cognition/agent-rank-store.js';
import { Logger } from '../utils/logger.js';

/**
 * Tools that should NOT trigger tracking (prevents recursion)
 */
const TRACKING_SKIP_TOOLS = new Set([
  'sequence-recommend',
  'loci-recall',
  'graph-query',
  'graph-find-path',
  'ping',
  'Help',
  'tool-health',
  'agent',
  'agent-comm',
  'session',
]);

/**
 * Whether tracking is enabled (requires Redis via SequenceTracker)
 */
let trackingEnabled = false;

/**
 * Initialize tracking — connects trackers to Redis.
 * Called lazily on first tool execution.
 */
let initPromise: Promise<void> | null = null;

async function ensureInitialized(): Promise<boolean> {
  if (trackingEnabled) return true;

  if (!initPromise) {
    initPromise = (async () => {
      try {
        const sequenceTracker = getSequenceTracker();
        if (!sequenceTracker.isConnected()) {
          await sequenceTracker.connect();
        }
        if (sequenceTracker.isConnected()) {
          trackingEnabled = true;
        }
      } catch (err) {
        Logger.debug(() => `[Tool Tracking] Init failed: ${err instanceof Error ? err.message : String(err)}`);
        trackingEnabled = false;
      }
      initPromise = null;
    })();
  }

  await initPromise;
  return trackingEnabled;
}

/**
 * Extract agentId from tool args (many tools pass it)
 */
function extractAgentId(args: Record<string, unknown>): string {
  return (
    (args.agentId as string) ||
    (args.createdBy as string) ||
    (args.requestingAgentId as string) ||
    (args.supervisorId as string) ||
    'default-agent'
  );
}

/**
 * Extract sessionId from tool args
 */
function extractSessionId(args: Record<string, unknown>): string {
  return (args.sessionId as string) || 'default-session';
}

/**
 * Record tracking data after tool execution.
 *
 * This is the main integration point — called from executeTool() in registry.ts.
 * All work is async and non-blocking.
 */
export async function recordToolExecution(
  toolName: string,
  args: Record<string, unknown>,
  success: boolean,
  durationMs: number
): Promise<void> {
  // Skip tracking tools to prevent recursion
  if (TRACKING_SKIP_TOOLS.has(toolName)) return;

  try {
    const ready = await ensureInitialized();
    if (!ready) return;

    const agentId = extractAgentId(args);
    const sessionId = extractSessionId(args);

    // 1. Record sequence for pattern learning
    const sequenceTracker = getSequenceTracker();
    if (sequenceTracker.isConnected()) {
      await sequenceTracker.recordToolExecution(agentId, sessionId, toolName, success, durationMs);
    }

    // 2. Record timeline event for compaction & resurrection
    const timelineRecorder = getTimelineRecorder();
    if (!timelineRecorder.isConnected()) {
      await timelineRecorder.connect().catch(() => {});
    }
    if (timelineRecorder.isConnected()) {
      // Wire compaction callback (idempotent - sets once)
      if (!timelineRecorder['compactionCallback']) {
        const compactionEngine = getCompactionEngine();
        if (!compactionEngine.isConnected()) {
          await compactionEngine.connect().catch(() => {});
        }
        if (compactionEngine.isConnected()) {
          timelineRecorder.setCompactionCallback(async (sid: string) => {
            await compactionEngine.runCompaction(sid);
          });
        }
      }
      await timelineRecorder.recordToolExecution(toolName, args, success, durationMs, sessionId, agentId);
    }

    // 3. Ambient learning (fire-and-forget)
    const ambientLearner = getAmbientLearner();
    if (!ambientLearner.isConnected()) {
      await ambientLearner.connect().catch(() => {});
    }
    if (ambientLearner.isConnected()) {
      await ambientLearner.processToolExecution(toolName, args, success, durationMs, sessionId, agentId);
    }

    // 4. Agent ranking update (fire-and-forget)
    const rankStore = getAgentRankStore();
    if (!rankStore.isConnected()) {
      await rankStore.connect().catch(() => {});
    }
    if (rankStore.isConnected()) {
      const complexity = durationMs > 10000 ? 0.8 : durationMs > 5000 ? 0.6 : 0.4;
      await rankStore.updateScore(agentId, success, durationMs, complexity);
    }
  } catch (error) {
    // Never let tracking errors propagate — log and swallow
    Logger.debug(() => `[Tool Tracking] Error: ${error instanceof Error ? error.message : String(error)}`);
  }
}
