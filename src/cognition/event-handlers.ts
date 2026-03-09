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
 * Cognition Event Handlers
 *
 * Central wiring of all cross-tool reactive handlers.
 * Subscribes to cognition events (via global bus) and triggers cross-store actions:
 *
 *   cognition:decision:recorded       → auto-create confidence record + cross-link
 *   cognition:confidence:low          → trigger intent drift check
 *   cognition:error:recorded          → scan recent decisions, link related ones
 *   cognition:error:matched           → log for future subscribers
 *   cognition:critique:lesson-learned → link lessons to matching error patterns
 *   cognition:intent:drifted          → auto-create self-critique entry + link
 *   cognition:handoff:created         → link to current mental models
 *   cognition:model:stale             → link to affected decisions and active intents
 *   cognition:confidence:outcome-updated → propagate outcome to linked decisions
 *
 * Call initCognitionEventHandlers() once at server startup (via initGlobalEventSystem).
 *
 * @module cognition/event-handlers
 */

import { getGlobalEventBus } from '../events/global-bus.js';
import { getCrossLinker } from './cross-linker.js';
import { getConfidenceStore } from './confidence-store.js';
import { getDecisionStore } from './decision-store.js';
import { getIntentStore } from './intent-store.js';
import { getErrorPatternStore } from './error-pattern-store.js';
import { getSelfCritiqueStore } from './self-critique-store.js';
import { getMentalModelStore } from './mental-model-store.js';
import { Logger } from '../utils/logger.js';

// Track whether cognition handlers have been registered
let cognitionHandlersRegistered = false;

/** Stored unsubscribe functions for graceful shutdown / hot-reload */
const subscriptionCleanups: Array<() => void> = [];

/**
 * Dispose all cognition event handlers (for graceful shutdown or hot-reload).
 * Clears subscriptions and allows re-registration.
 */
export function disposeCognitionEventHandlers(): void {
  for (const cleanup of subscriptionCleanups) {
    try { cleanup(); } catch { /* ignore cleanup errors */ }
  }
  subscriptionCleanups.length = 0;
  cognitionHandlersRegistered = false;
  Logger.info('[CognitionEventHandlers] All handlers disposed');
}

/**
 * Initialize all cognition cross-tool event handlers.
 * Safe to call multiple times — only registers once.
 */
export function initCognitionEventHandlers(): void {
  if (cognitionHandlersRegistered) return;

  let bus: ReturnType<typeof getGlobalEventBus>;
  let linker: ReturnType<typeof getCrossLinker>;

  try {
    bus = getGlobalEventBus();
    linker = getCrossLinker();
  } catch (err) {
    Logger.warn(`[CognitionEventHandlers] Failed to initialize dependencies: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  /** Helper to track subscription for disposal */
  const track = (sub: { unsubscribe: () => void }) => subscriptionCleanups.push(() => sub.unsubscribe());

  // ── cognition:decision:recorded → auto-create confidence record ──────
  track(bus.on('cognition:decision:recorded', async (event) => {
    const { confidence, question, sourceId } = event.payload as {
      confidence: number;
      question: string;
      sourceId: string;
    };

    const confStore = getConfidenceStore();
    const record = await confStore.record({
      sessionId: event.sessionId,
      agentId: event.agentId || 'unknown',
      toolName: 'decision-journal',
      confidence,
      domain: 'decision',
      reasoning: `Auto-created from decision: ${question.substring(0, 100)}`,
    });

    if (record) {
      await linker.link(
        'decision',
        sourceId,
        'confidence',
        record.id,
        'auto-created confidence record for decision',
      );
    }
  }, { permanent: true }));

  // ── cognition:confidence:low → check for intent drift ────────────────
  track(bus.on('cognition:confidence:low', async (event) => {
    const { toolName, confidence } = event.payload as {
      toolName: string;
      confidence: number;
    };

    const intentStore = getIntentStore();
    const drift = await intentStore.checkDrift(
      event.sessionId,
      `Low confidence (${confidence}) on ${toolName}`,
    );

    if (drift) {
      Logger.warn(
        `[CognitionHandler] Low confidence triggered drift detection (score=${drift.driftScore})`,
      );
    }
  }, { permanent: true }));

  // ── cognition:error:recorded → tag related recent decisions ──────────
  track(bus.on('cognition:error:recorded', async (event) => {
    const { context, symptoms, sourceId } = event.payload as {
      context: string;
      symptoms: string[];
      errorType: string;
      sourceId: string;
    };

    const decisionStore = getDecisionStore();
    const recentDecisions = await decisionStore.listBySession(event.sessionId, 5);

    for (const decision of recentDecisions) {
      const decisionText =
        `${decision.question} ${decision.chosen} ${decision.reasoning}`.toLowerCase();
      const errorText = `${context} ${symptoms.join(' ')}`.toLowerCase();
      const words = errorText.split(/\s+/).filter((w) => w.length > 3);
      const matchCount = words.filter((w) => decisionText.includes(w)).length;

      if (matchCount >= 2) {
        await linker.link(
          'error-pattern',
          sourceId,
          'decision',
          decision.id,
          'Error may relate to this recent decision',
        );
      }
    }
  }, { permanent: true }));

  // ── cognition:error:matched → informational log ──────────────────────
  track(bus.on('cognition:error:matched', async (event) => {
    const { matchedPatternId, fix } = event.payload as {
      matchedPatternId: string;
      fix: string;
    };
    Logger.info(
      `[CognitionHandler] Error matched known pattern ${matchedPatternId}: ${fix.substring(0, 100)}`,
    );
  }, { permanent: true }));

  // ── cognition:critique:lesson-learned → link to matching error patterns
  track(bus.on('cognition:critique:lesson-learned', async (event) => {
    const { lessons, sourceId } = event.payload as { lessons: string[]; sourceId: string };

    const errorStore = getErrorPatternStore();
    const allPatterns = await errorStore.listAll(50);

    for (const lesson of lessons) {
      const lessonWords = new Set(
        lesson
          .toLowerCase()
          .split(/\s+/)
          .filter((w) => w.length > 3),
      );

      for (const pattern of allPatterns) {
        const patternText =
          `${pattern.context} ${pattern.symptoms.join(' ')} ${pattern.rootCause}`.toLowerCase();
        const matchCount = [...lessonWords].filter((w) => patternText.includes(w)).length;

        if (matchCount >= 2) {
          await linker.link(
            'critique',
            sourceId,
            'error-pattern',
            pattern.id,
            'Lesson may address this error pattern',
          );
        }
      }
    }
  }, { permanent: true }));

  // ── cognition:intent:drifted → auto-create self-critique ─────────────
  track(bus.on('cognition:intent:drifted', async (event) => {
    const { driftScore, currentAction, expectedDirection, sourceId } = event.payload as {
      driftScore: number;
      currentAction: string;
      expectedDirection: string;
      sourceId: string;
    };

    const critiqueStore = getSelfCritiqueStore();
    const critique = await critiqueStore.record({
      sessionId: event.sessionId,
      agentId: event.agentId || 'unknown',
      scope: 'task',
      targetId: sourceId,
      wentWell: [],
      wentPoorly: [
        `Intent drift detected (score=${driftScore})`,
        `Was doing: ${currentAction}`,
        `Should have been: ${expectedDirection}`,
      ],
      wouldChange: ['Check intent alignment before each major action'],
      lessonsLearned: ['Monitor intent alignment continuously'],
      efficiency: Math.min(1, Math.max(0, 1 - driftScore)),
    });

    if (critique) {
      await linker.link(
        'intent',
        sourceId,
        'critique',
        critique.id,
        'Auto-created critique from intent drift',
      );
    }
  }, { permanent: true }));

  // ── cognition:handoff:created → link to current mental models ────────
  track(bus.on('cognition:handoff:created', async (event) => {
    const { sourceId } = event.payload as { sourceId: string };
    const modelStore = getMentalModelStore();
    const models = await modelStore.listBySession(event.sessionId);

    for (const model of models) {
      await linker.link(
        'handoff',
        sourceId,
        'model',
        model.id,
        model.staleSince
          ? `Mental model snapshot (STALE since ${new Date(model.staleSince).toISOString()})`
          : 'Mental model snapshot (fresh)',
      );
    }
  }, { permanent: true }));

  // ── cognition:model:stale → flag affected decisions/intents ──────────
  track(bus.on('cognition:model:stale', async (event) => {
    const { sourceId } = event.payload as { sourceId: string };
    const decisionStore = getDecisionStore();
    const intentStore = getIntentStore();

    const recentDecisions = await decisionStore.listBySession(event.sessionId, 10);
    for (const decision of recentDecisions) {
      if (decision.relatedFiles && decision.relatedFiles.length > 0) {
        await linker.link(
          'model',
          sourceId,
          'decision',
          decision.id,
          'Model staleness may affect this decision',
        );
      }
    }

    const intents = await intentStore.listBySession(event.sessionId, 5);
    for (const intent of intents) {
      if (intent.status === 'active') {
        await linker.link(
          'model',
          sourceId,
          'intent',
          intent.id,
          'Stale model may affect active intent',
        );
      }
    }
  }, { permanent: true }));

  // ── cognition:confidence:outcome-updated → propagate to linked decisions
  // Track processed confidence IDs to prevent circular re-processing
  const processedOutcomes = new Set<string>();

  track(bus.on('cognition:confidence:outcome-updated', async (event) => {
    const { outcome, confidenceId } = event.payload as {
      outcome: string;
      confidenceId: string;
    };

    // Prevent re-entrant processing of the same confidence record
    if (processedOutcomes.has(confidenceId)) return;
    processedOutcomes.add(confidenceId);
    // Evict old entries to prevent unbounded growth
    if (processedOutcomes.size > 500) {
      const first = processedOutcomes.values().next().value;
      if (first) processedOutcomes.delete(first);
    }

    const links = await linker.getBacklinks('confidence', confidenceId);
    const decisionStore = getDecisionStore();

    for (const link of links) {
      if (link.type === 'decision') {
        const decision = await decisionStore.get(link.id);
        if (decision && !decision.outcome) {
          await decisionStore.updateOutcome(
            link.id,
            `Auto-updated from confidence outcome: ${outcome}`,
          );
        }
      }
    }
  }, { permanent: true }));

  // ── cognition:confidence:recorded → informational log + cross-link ────
  track(bus.on('cognition:confidence:recorded', async (event) => {
    const { toolName, confidence, sourceId } = event.payload as {
      toolName: string;
      confidence: number;
      sourceId: string;
    };

    Logger.debug(
      `[CognitionHandler] Confidence recorded: ${toolName} @ ${(confidence * 100).toFixed(0)}%`
    );

    // Link to most recent decision in session (if any)
    const decisionStore = getDecisionStore();
    const recentDecisions = await decisionStore.listBySession(event.sessionId, 1);
    if (recentDecisions.length > 0) {
      await linker.link(
        'confidence',
        sourceId,
        'decision',
        recentDecisions[0].id,
        'Confidence recorded during this decision context',
      );
    }
  }, { permanent: true }));

  // ── cognition:error:occurrence → track recurring errors ─────────────
  track(bus.on('cognition:error:occurrence', async (event) => {
    const { sourceId: patternId, occurrences } = event.payload as {
      sourceId: string;
      occurrences: number;
    };

    Logger.info(
      `[CognitionHandler] Error pattern ${patternId} occurred again (total: ${occurrences}x)`
    );

    // If error is recurring, link to recent decisions for investigation
    if (occurrences >= 3) {
      const decisionStore = getDecisionStore();
      const recentDecisions = await decisionStore.listBySession(event.sessionId, 3);
      for (const decision of recentDecisions) {
        await linker.link(
          'error-pattern',
          patternId,
          'decision',
          decision.id,
          `Recurring error (${occurrences}x) may relate to recent decisions`,
        );
      }
    }
  }, { permanent: true }));

  // ── cognition:intent:set → track intent creation for audit ──────────
  track(bus.on('cognition:intent:set', async (event) => {
    const { level, description, sourceId } = event.payload as {
      level: string;
      description: string;
      sourceId: string;
    };

    Logger.debug(
      `[CognitionHandler] Intent set: [${level}] ${description.substring(0, 50)}`
    );

    // Link new intent to active mental models
    const modelStore = getMentalModelStore();
    const models = await modelStore.listBySession(event.sessionId);
    for (const model of models.slice(0, 3)) { // Limit to 3 most recent
      await linker.link(
        'intent',
        sourceId,
        'model',
        model.id,
        'Intent created with this mental model context',
      );
    }
  }, { permanent: true }));

  // ── cognition:model:created → log new mental model ──────────────────
  track(bus.on('cognition:model:created', async (event) => {
    const { name, sourceId } = event.payload as {
      name: string;
      sourceId: string;
    };

    Logger.info(`[CognitionHandler] Mental model created: "${name}"`);

    // Link to active intent if any
    const intentStore = getIntentStore();
    const activeIntent = await intentStore.getActiveIntent(event.sessionId);
    if (activeIntent) {
      await linker.link(
        'model',
        sourceId,
        'intent',
        activeIntent.id,
        'Mental model created while pursuing this intent',
      );
    }
  }, { permanent: true }));

  // ── cognition:model:updated → track model evolution ─────────────────
  track(bus.on('cognition:model:updated', async (event) => {
    const { name, operation, sourceId } = event.payload as {
      name: string;
      operation: string;
      sourceId: string;
    };

    Logger.debug(
      `[CognitionHandler] Mental model "${name}" updated (${operation})`
    );

    // Link update to recent decisions for traceability
    const decisionStore = getDecisionStore();
    const recentDecisions = await decisionStore.listBySession(event.sessionId, 2);
    for (const decision of recentDecisions) {
      await linker.link(
        'model',
        sourceId,
        'decision',
        decision.id,
        `Model ${operation} may be related to this decision`,
      );
    }
  }, { permanent: true }));

  // ── cognition:critique:recorded → link to error patterns ────────────
  track(bus.on('cognition:critique:recorded', async (event) => {
    const { scope, sourceId } = event.payload as {
      scope: string;
      sourceId: string;
    };

    Logger.debug(`[CognitionHandler] Self-critique recorded (scope=${scope})`);

    // Link critique to recent error patterns for learning correlation
    const errorStore = getErrorPatternStore();
    const patterns = await errorStore.listAll(5);
    for (const pattern of patterns) {
      await linker.link(
        'critique',
        sourceId,
        'error-pattern',
        pattern.id,
        'Critique may provide insight on this error pattern',
      );
    }

    // Link to active intent for context
    const intentStore = getIntentStore();
    const activeIntent = await intentStore.getActiveIntent(event.sessionId);
    if (activeIntent) {
      await linker.link(
        'critique',
        sourceId,
        'intent',
        activeIntent.id,
        'Critique recorded while pursuing this intent',
      );
    }
  }, { permanent: true }));

  // ── kanban:task:completed → auto-update cognition state ──────────────
  // When a task is marked as done: complete related intent, update confidence outcomes
  track(bus.on('kanban:task:completed', async (event) => {
    const { taskId, title, assignee } = event.payload as {
      taskId: string;
      title: string;
      assignee?: string;
    };

    const agentId = assignee || event.agentId || 'unknown';

    // 1. Complete related active intent (if task-level intent matches)
    try {
      const intentStore = getIntentStore();
      const activeIntent = await intentStore.getActiveIntent(event.sessionId);
      if (activeIntent && activeIntent.level === 'task') {
        // Check if intent description roughly matches task title
        const intentWords = new Set(activeIntent.description.toLowerCase().split(/\s+/).filter(w => w.length > 3));
        const titleWords = title.toLowerCase().split(/\s+/).filter(w => w.length > 3);
        const overlap = titleWords.filter(w => intentWords.has(w)).length;
        if (overlap >= 2 || titleWords.length <= 2) {
          await intentStore.updateStatus(activeIntent.id, 'completed');
          Logger.info(`[CognitionHandler] Auto-completed task intent ${activeIntent.id} from task ${taskId}`);
        }
      }
    } catch (err) {
      Logger.debug(`[CognitionHandler] Intent auto-complete skipped: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 2. Update confidence outcomes for this session as 'correct'
    try {
      const confStore = getConfidenceStore();
      const records = await confStore.listBySession(event.sessionId, 5);
      for (const record of records) {
        if (!record.outcome && record.agentId === agentId) {
          await confStore.updateOutcome(record.id, 'correct');
          Logger.debug(`[CognitionHandler] Auto-updated confidence ${record.id} outcome to correct`);
          break; // Only update the most recent unresolved one
        }
      }
    } catch (err) {
      Logger.debug(`[CognitionHandler] Confidence auto-update skipped: ${err instanceof Error ? err.message : String(err)}`);
    }

    Logger.info(`[CognitionHandler] Task completed hook: ${taskId} "${title}" by ${agentId}`);
  }, { permanent: true }));

  cognitionHandlersRegistered = true;
  Logger.info('[CognitionEventHandlers] All cross-tool handlers registered (16 handlers)');
}
