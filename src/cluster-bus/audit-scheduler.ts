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
 * Audit Scheduler
 *
 * Core engine for self-organizing recurring audits.
 * Uses setInterval timers backed by Redis schedule persistence.
 *
 * Flow: Timer fires → read kanban (feedback loop) → adjust focus areas
 *       → magistrale.dispatch() → record results → self-assess
 *       → update schedule with follow-up areas → wait for next interval
 *
 * @module cluster-bus/audit-scheduler
 */

import { z } from 'zod';
import { Logger } from '../utils/logger.js';
import { getClusterBus } from './bus.js';
import { LLMMagistrale } from './llm-magistrale.js';
import { isClusterBusActive } from './init.js';
import { generateObject } from '../ai/structured-output.js';
import {
  listSchedules,
  getSchedule,
  updateSchedule,
  addHistoryEntry,
  getHistory,
  getLastRunTime,
} from './audit-schedule-store.js';
import type {
  AuditSchedule,
  AuditHistoryEntry,
} from './audit-schedule-store.js';
import { listTasks } from '../kanban/kanban-store.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum interval: 5 minutes */
const MIN_INTERVAL_MS = 5 * 60 * 1000;

/** Maximum concurrent audit executions */
const MAX_CONCURRENT_AUDITS = 3;

/** Max length of summary stored in history */
const MAX_SUMMARY_LENGTH = 2000;

// ---------------------------------------------------------------------------
// Self-assessment schema
// ---------------------------------------------------------------------------

const SelfAssessmentSchema = z.object({
  followUpAreas: z
    .array(z.string())
    .describe('Focus areas for the next audit run based on findings'),
  severity: z
    .enum(['low', 'medium', 'high', 'critical'])
    .describe('Overall severity of findings'),
  recommendation: z
    .string()
    .describe('Brief recommendation for next steps'),
});

// ---------------------------------------------------------------------------
// AuditScheduler
// ---------------------------------------------------------------------------

export class AuditScheduler {
  private timers = new Map<string, ReturnType<typeof setInterval>>();
  private activeAudits = new Set<string>();
  private initialized = false;

  /**
   * Initialize the scheduler: load all enabled schedules from Redis
   * and start their timers.
   */
  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    try {
      const schedules = await listSchedules();
      let started = 0;
      for (const schedule of schedules) {
        if (schedule.enabled) {
          this.startTimer(schedule);
          started++;
        }
      }
      if (started > 0) {
        Logger.info(`[AuditScheduler] Initialized: ${started} schedule(s) active`);
      }
    } catch (err) {
      Logger.error('[AuditScheduler] Init failed:', err);
    }
  }

  /**
   * Start a timer for a schedule. If a timer already exists, it is replaced.
   */
  startTimer(schedule: AuditSchedule): void {
    this.stopTimer(schedule.id);

    const intervalMs = Math.max(schedule.intervalMs, MIN_INTERVAL_MS);

    const timer = setInterval(() => {
      this.executeAudit(schedule.id).catch((err) => {
        Logger.error(`[AuditScheduler] Audit ${schedule.id} failed:`, err);
      });
    }, intervalMs);

    this.timers.set(schedule.id, timer);
    Logger.debug(
      `[AuditScheduler] Timer started for "${schedule.name}" (every ${Math.round(intervalMs / 60000)}min)`
    );
  }

  /**
   * Stop a specific schedule timer.
   */
  stopTimer(scheduleId: string): void {
    const timer = this.timers.get(scheduleId);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(scheduleId);
    }
  }

  /**
   * Execute a single audit run for the given schedule.
   */
  async executeAudit(scheduleId: string): Promise<AuditHistoryEntry | null> {
    // Guard: too many concurrent audits
    if (this.activeAudits.size >= MAX_CONCURRENT_AUDITS) {
      Logger.warn(
        `[AuditScheduler] Skipping audit ${scheduleId}: ${this.activeAudits.size} audits already running`
      );
      return null;
    }

    // Guard: cluster bus must be active
    if (!isClusterBusActive()) {
      Logger.warn('[AuditScheduler] Cluster bus not active, skipping audit');
      return null;
    }

    const schedule = await getSchedule(scheduleId);
    if (!schedule || !schedule.enabled) return null;

    this.activeAudits.add(scheduleId);
    const startTime = Date.now();

    try {
      // Step 1: Feedback loop — read kanban to adjust focus
      let effectiveFocusAreas = [...schedule.focusAreas];
      let feedbackUsed = false;

      if (schedule.feedbackLoopEnabled && schedule.boardId) {
        const feedbackContext = await this.buildFeedbackContext(schedule);
        if (feedbackContext) {
          effectiveFocusAreas = feedbackContext.adjustedAreas;
          feedbackUsed = true;
          Logger.debug(
            `[AuditScheduler] Feedback loop adjusted focus: ${effectiveFocusAreas.join(', ')}`
          );
        }
      }

      // Step 2: Dispatch via magistrale
      const bus = getClusterBus();
      if (!bus) {
        Logger.warn('[AuditScheduler] No cluster bus available');
        return null;
      }

      const magistrale = new LLMMagistrale(bus);
      let response;
      try {
        const cfg = schedule.magistraleConfig;
        response = await magistrale.dispatch(schedule.prompt, {
          strategy: 'best-of-n',
          maxTargets: cfg.maxTargets,
          timeoutMs: cfg.timeoutMs,
          minResponses: 1,
          orchestrate: {
            agent: cfg.orchestrateAgent,
            maxIterations: cfg.orchestrateMaxIterations,
            maxTokens: cfg.orchestrateMaxTokens,
            enableCognition: cfg.orchestrateEnableCognition,
            isMultiCluster: cfg.maxTargets > 1,
            focusAreas: effectiveFocusAreas,
            allowedTools: this.buildToolList(cfg),
          },
        });
      } finally {
        magistrale.destroy();
      }

      const summary = response.content.slice(0, MAX_SUMMARY_LENGTH);

      // Step 3: Self-assessment — extract follow-up focus areas
      let followUpAreas: string[] | undefined;
      if (schedule.selfAssessEnabled && response.successCount > 0) {
        followUpAreas = await this.selfAssess(schedule, summary);
      }

      // Step 4: Record history
      const entry: AuditHistoryEntry = {
        timestamp: new Date().toISOString(),
        durationMs: Date.now() - startTime,
        successCount: response.successCount,
        dispatchedTo: response.dispatchedTo,
        focusAreas: effectiveFocusAreas,
        summary,
        followUpAreas,
        feedbackUsed,
      };

      await addHistoryEntry(scheduleId, entry);

      // Step 5: Update schedule with follow-up areas for next run
      if (followUpAreas && followUpAreas.length > 0) {
        await updateSchedule(scheduleId, {
          focusAreas: followUpAreas,
        });
        Logger.info(
          `[AuditScheduler] Self-assessment updated focus areas: ${followUpAreas.join(', ')}`
        );
      }

      Logger.info(
        `[AuditScheduler] Audit "${schedule.name}" completed: ${response.successCount}/${response.dispatchedTo} clusters, ${entry.durationMs}ms`
      );

      return entry;
    } catch (err) {
      Logger.error(`[AuditScheduler] Audit "${scheduleId}" error:`, err);
      return null;
    } finally {
      this.activeAudits.delete(scheduleId);
    }
  }

  /**
   * Build feedback context from kanban board.
   * Reads open/in-progress tasks and extracts themes to prioritize.
   */
  private async buildFeedbackContext(
    schedule: AuditSchedule
  ): Promise<{ adjustedAreas: string[] } | null> {
    try {
      // Read tasks from the linked board's session
      const sessionId = `audit-${schedule.id.slice(0, 8)}`;
      const tasks = await listTasks(sessionId, { status: ['backlog', 'in_progress'] }, 20);

      if (tasks.length === 0) return null;

      // Also check recent history for patterns
      const history = await getHistory(schedule.id, 3);

      // Extract themes from open tasks
      const taskTitles = tasks.map((t) => t.title).join('; ');
      const historyAreas = history
        .flatMap((h) => h.followUpAreas || [])
        .filter((a, i, arr) => arr.indexOf(a) === i);

      // Combine: open task themes + previous follow-up areas + original areas
      const combined = new Set<string>();

      // Previous follow-up areas take priority
      for (const area of historyAreas) {
        combined.add(area);
      }

      // Original areas as fallback
      for (const area of schedule.focusAreas) {
        combined.add(area);
      }

      // If we have open tasks, add a synthesized focus area
      if (tasks.length > 0) {
        combined.add(`Follow up on ${tasks.length} open findings: ${taskTitles.slice(0, 200)}`);
      }

      // Cap at 5 focus areas to avoid dilution
      const adjustedAreas = Array.from(combined).slice(0, 5);

      return { adjustedAreas };
    } catch (err) {
      Logger.warn(`[AuditScheduler] Feedback loop error: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /**
   * Self-assess audit results to generate follow-up focus areas.
   * Uses generateObject() with a structured schema.
   */
  private async selfAssess(
    schedule: AuditSchedule,
    summary: string
  ): Promise<string[] | undefined> {
    try {
      const result = await generateObject({
        schema: SelfAssessmentSchema,
        prompt: `You just completed a "${schedule.auditType}" audit with focus areas: ${schedule.focusAreas.join(', ')}.

Here are the findings:
${summary}

Based on these findings, determine:
1. What focus areas should the NEXT audit prioritize? (max 5)
2. What is the overall severity?
3. What is your brief recommendation?

Return ONLY the JSON object.`,
        system: 'You are an audit self-assessment engine. Analyze findings and recommend follow-up focus areas for the next audit cycle. Be specific and actionable.',
        temperature: 0.3,
        maxTokens: 1000,
      });

      return result.object.followUpAreas;
    } catch (err) {
      Logger.warn(
        `[AuditScheduler] Self-assessment failed: ${err instanceof Error ? err.message : String(err)}`
      );
      return undefined;
    }
  }

  /**
   * Build tool whitelist from magistrale config flags.
   */
  private buildToolList(cfg: AuditSchedule['magistraleConfig']): string[] {
    const tools = [
      'find-definition',
      'find-references',
      'semantic-search',
    ];

    if (cfg.orchestrateEnableKanban) {
      tools.push('task', 'task-multi', 'board');
    }

    if (cfg.orchestrateEnableCollaboration) {
      tools.push('shared-thoughts', 'get-shared-context');
    }

    if (cfg.orchestrateEnableCognition) {
      tools.push(
        'error-pattern',
        'decision-journal',
        'confidence-tracker',
        'mental-model'
      );
    }

    return tools;
  }

  /**
   * Get status of all running timers and active audits.
   */
  getStatus(): {
    runningTimers: string[];
    activeAudits: string[];
    initialized: boolean;
  } {
    return {
      runningTimers: Array.from(this.timers.keys()),
      activeAudits: Array.from(this.activeAudits),
      initialized: this.initialized,
    };
  }

  /**
   * Trigger an audit immediately (outside normal schedule).
   */
  async triggerNow(scheduleId: string): Promise<AuditHistoryEntry | null> {
    return this.executeAudit(scheduleId);
  }

  /**
   * Destroy the scheduler: stop all timers.
   */
  destroy(): void {
    for (const [id, timer] of this.timers) {
      clearInterval(timer);
      Logger.debug(`[AuditScheduler] Stopped timer for ${id}`);
    }
    this.timers.clear();
    this.initialized = false;
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: AuditScheduler | null = null;

export function getAuditScheduler(): AuditScheduler {
  if (!instance) {
    instance = new AuditScheduler();
  }
  return instance;
}

export function resetAuditScheduler(): void {
  if (instance) {
    instance.destroy();
    instance = null;
  }
}
