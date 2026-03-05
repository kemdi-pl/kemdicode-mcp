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
 * RL Middleware
 *
 * Integrates the RL system (state tracking, reward shaping, dopamine signals,
 * sequence tracking) into the tool execution pipeline.
 *
 * All operations are fire-and-forget — they never block tool responses.
 */

import { getStateTracker } from './state-tracker.js';
import { getRewardTracker, getIntrinsicReward } from './rewards.js';
import { getDopamineEmitter } from './dopamine.js';
import { getSequenceTracker } from '../loci/sequence-tracker.js';
import { getTimelineRecorder } from '../loci/timeline-recorder.js';
import { getCompactionEngine } from '../loci/compaction-engine.js';
import { getAmbientLearner } from '../cognition/ambient-learner.js';
import { getAgentRankStore } from '../cognition/agent-rank-store.js';
import type { IntrinsicRewards } from './types.js';
import { Logger } from '../utils/logger.js';

/**
 * Tools that should NOT trigger RL tracking (prevents recursion)
 */
const RL_SKIP_TOOLS = new Set([
  'rl-reward-stats',
  'rl-dopamine-log',
  'sequence-recommend',
  'loci-recall',
  'graph-query',
  'graph-find-path',
  'ping',
  'Help',
  'tool-health',
  'agent-rank',
  'session-recover',
]);

/**
 * Whether RL tracking is enabled (requires Redis via StateTracker)
 */
let rlEnabled = false;

/**
 * Initialize RL middleware — connects trackers to Redis.
 * Called lazily on first tool execution.
 */
let initPromise: Promise<void> | null = null;

async function ensureInitialized(): Promise<boolean> {
  if (rlEnabled) return true;

  if (!initPromise) {
    initPromise = (async () => {
      try {
        const stateTracker = getStateTracker();
        if (!stateTracker.isConnected()) {
          await stateTracker.connect();
        }
        if (stateTracker.isConnected()) {
          rlEnabled = true;

          // Connect other trackers in background
          const rewardTracker = getRewardTracker();
          const dopamineEmitter = getDopamineEmitter();
          const sequenceTracker = getSequenceTracker();

          await Promise.allSettled([
            rewardTracker.isConnected() ? Promise.resolve() : rewardTracker.connect(),
            dopamineEmitter.isConnected() ? Promise.resolve() : dopamineEmitter.connect(),
            sequenceTracker.isConnected() ? Promise.resolve() : sequenceTracker.connect(),
          ]);
        }
      } catch (err) {
        Logger.debug(() => `[RL Middleware] Init failed: ${err instanceof Error ? err.message : String(err)}`);
        rlEnabled = false;
      }
      initPromise = null;
    })();
  }

  await initPromise;
  return rlEnabled;
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
 * Record RL data after tool execution.
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
  // Skip RL tools to prevent recursion
  if (RL_SKIP_TOOLS.has(toolName)) return;

  try {
    const ready = await ensureInitialized();
    if (!ready) return;

    const agentId = extractAgentId(args);
    const sessionId = extractSessionId(args);
    const isFast = durationMs < 1000;

    // 1. Capture pre-state (initialize in Redis if new agent)
    const stateTracker = getStateTracker();
    const existingState = await stateTracker.getState(agentId);
    let preState;
    if (existingState) {
      preState = { ...existingState, stateAge: Date.now() - existingState.timestamp, timestamp: Date.now() };
    } else {
      preState = await stateTracker.initializeState(agentId, sessionId);
    }

    // 2. Update state with tool result
    const postState = await stateTracker.updateState(agentId, {
      toolSuccess: success,
      toolName,
      taskProgressDelta: success ? 0.01 : 0, // Small progress per successful tool
      hasError: !success,
    });

    if (!postState) return;

    // 3. Determine intrinsic reward
    let rewardEvent: keyof IntrinsicRewards;
    if (success && isFast) {
      rewardEvent = 'TOOL_FAST_SUCCESS';
    } else if (success) {
      rewardEvent = 'TOOL_SUCCESS';
    } else if (postState.consecutiveErrors >= 2) {
      rewardEvent = 'REPEATED_ERROR';
    } else {
      rewardEvent = 'TOOL_FAILURE';
    }

    const intrinsicReward = getIntrinsicReward(rewardEvent);

    // 4. Record shaped reward
    const rewardTracker = getRewardTracker();
    if (rewardTracker.isConnected()) {
      await rewardTracker.recordReward(toolName, preState, postState, intrinsicReward);
    }

    // 5. Emit dopamine signal
    const dopamineEmitter = getDopamineEmitter();
    if (dopamineEmitter.isConnected()) {
      if (success) {
        await dopamineEmitter.toolSuccess(agentId, toolName, durationMs);
      } else {
        await dopamineEmitter.toolFailure(agentId, toolName);
      }

      // Extra signal for repeated errors
      if (!success && postState.consecutiveErrors >= 2) {
        await dopamineEmitter.repeatedError(agentId, toolName);
      }
    }

    // 6. Record sequence for pattern learning
    const sequenceTracker = getSequenceTracker();
    if (sequenceTracker.isConnected()) {
      await sequenceTracker.recordToolExecution(agentId, sessionId, toolName, success, durationMs);
    }

    // 7. Record timeline event for compaction & resurrection
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

    // 8. Ambient learning (fire-and-forget — never blocks response)
    const ambientLearner = getAmbientLearner();
    if (!ambientLearner.isConnected()) {
      await ambientLearner.connect().catch(() => {});
    }
    if (ambientLearner.isConnected()) {
      await ambientLearner.processToolExecution(toolName, args, success, durationMs, sessionId, agentId);
    }

    // 9. Agent ranking update (fire-and-forget)
    const rankStore = getAgentRankStore();
    if (!rankStore.isConnected()) {
      await rankStore.connect().catch(() => {});
    }
    if (rankStore.isConnected()) {
      const complexity = durationMs > 10000 ? 0.8 : durationMs > 5000 ? 0.6 : 0.4;
      await rankStore.updateScore(agentId, success, durationMs, complexity);
    }
  } catch (error) {
    // Never let RL errors propagate — log and swallow
    Logger.debug(() => `[RL Middleware] Error: ${error instanceof Error ? error.message : String(error)}`);
  }
}
