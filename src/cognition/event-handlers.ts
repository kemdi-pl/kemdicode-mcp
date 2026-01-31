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
 * Cognition Event Handlers
 *
 * Central wiring of all cross-tool reactive handlers.
 * Subscribes to cognition events and triggers cross-store actions:
 *
 *   decision:recorded       → auto-create confidence record + cross-link
 *   confidence:low          → trigger intent drift check
 *   error:recorded          → scan recent decisions, link related ones
 *   error:matched           → log for future subscribers
 *   critique:lesson-learned → link lessons to matching error patterns
 *   intent:drifted          → auto-create self-critique entry + link
 *   handoff:created         → link to current mental models
 *   model:stale             → link to affected decisions and active intents
 *   confidence:outcome-updated → propagate outcome to linked decisions
 *
 * Call initCognitionEventHandlers() once at server startup.
 *
 * @module cognition/event-handlers
 */

import { getCognitionEventBus } from './event-bus.js';
import { getCrossLinker } from './cross-linker.js';
import { getConfidenceStore } from './confidence-store.js';
import { getDecisionStore } from './decision-store.js';
import { getIntentStore } from './intent-store.js';
import { getErrorPatternStore } from './error-pattern-store.js';
import { getSelfCritiqueStore } from './self-critique-store.js';
import { getMentalModelStore } from './mental-model-store.js';
import { Logger } from '../utils/logger.js';

/**
 * Initialize all cognition cross-tool event handlers.
 * Safe to call multiple times — only registers once.
 */
export function initCognitionEventHandlers(): void {
  const bus = getCognitionEventBus();
  if (bus.isInitialized) return;

  const linker = getCrossLinker();

  // ── decision:recorded → auto-create confidence record ──────────────
  bus.on('decision:recorded', async (event) => {
    const { confidence, question } = event.payload as {
      confidence: number;
      question: string;
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
        event.sourceId,
        'confidence',
        record.id,
        'auto-created confidence record for decision',
      );
    }
  });

  // ── confidence:low → check for intent drift ────────────────────────
  bus.on('confidence:low', async (event) => {
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
  });

  // ── error:recorded → tag related recent decisions ──────────────────
  bus.on('error:recorded', async (event) => {
    const { context, symptoms } = event.payload as {
      context: string;
      symptoms: string[];
      errorType: string;
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
          event.sourceId,
          'decision',
          decision.id,
          'Error may relate to this recent decision',
        );
      }
    }
  });

  // ── error:matched → informational log ──────────────────────────────
  bus.on('error:matched', async (event) => {
    const { matchedPatternId, fix } = event.payload as {
      matchedPatternId: string;
      fix: string;
    };
    Logger.info(
      `[CognitionHandler] Error matched known pattern ${matchedPatternId}: ${fix.substring(0, 100)}`,
    );
  });

  // ── critique:lesson-learned → link to matching error patterns ──────
  bus.on('critique:lesson-learned', async (event) => {
    const { lessons } = event.payload as { lessons: string[] };

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
            event.sourceId,
            'error-pattern',
            pattern.id,
            'Lesson may address this error pattern',
          );
        }
      }
    }
  });

  // ── intent:drifted → auto-create self-critique ─────────────────────
  bus.on('intent:drifted', async (event) => {
    const { driftScore, currentAction, expectedDirection } = event.payload as {
      driftScore: number;
      currentAction: string;
      expectedDirection: string;
    };

    const critiqueStore = getSelfCritiqueStore();
    const critique = await critiqueStore.record({
      sessionId: event.sessionId,
      agentId: event.agentId || 'unknown',
      scope: 'task',
      targetId: event.sourceId,
      wentWell: [],
      wentPoorly: [
        `Intent drift detected (score=${driftScore})`,
        `Was doing: ${currentAction}`,
        `Should have been: ${expectedDirection}`,
      ],
      wouldChange: ['Check intent alignment before each major action'],
      lessonsLearned: ['Monitor intent alignment continuously'],
      efficiency: Math.max(0, 1 - driftScore),
    });

    if (critique) {
      await linker.link(
        'intent',
        event.sourceId,
        'critique',
        critique.id,
        'Auto-created critique from intent drift',
      );
    }
  });

  // ── handoff:created → link to current mental models ────────────────
  bus.on('handoff:created', async (event) => {
    const modelStore = getMentalModelStore();
    const models = await modelStore.listBySession(event.sessionId);

    for (const model of models) {
      await linker.link(
        'handoff',
        event.sourceId,
        'model',
        model.id,
        model.staleSince
          ? `Mental model snapshot (STALE since ${new Date(model.staleSince).toISOString()})`
          : 'Mental model snapshot (fresh)',
      );
    }
  });

  // ── model:stale → flag affected decisions/intents ──────────────────
  bus.on('model:stale', async (event) => {
    const decisionStore = getDecisionStore();
    const intentStore = getIntentStore();

    const recentDecisions = await decisionStore.listBySession(event.sessionId, 10);
    for (const decision of recentDecisions) {
      if (decision.relatedFiles && decision.relatedFiles.length > 0) {
        await linker.link(
          'model',
          event.sourceId,
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
          event.sourceId,
          'intent',
          intent.id,
          'Stale model may affect active intent',
        );
      }
    }
  });

  // ── confidence:outcome-updated → propagate to linked decisions ─────
  bus.on('confidence:outcome-updated', async (event) => {
    const { outcome, confidenceId } = event.payload as {
      outcome: string;
      confidenceId: string;
    };

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
  });

  bus.markInitialized();
  Logger.info('[CognitionEventHandlers] All cross-tool handlers registered');
}
