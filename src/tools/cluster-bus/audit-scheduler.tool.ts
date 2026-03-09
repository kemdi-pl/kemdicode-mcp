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

import { z } from 'zod';
import type { UnifiedTool } from '../registry.js';
import {
  createSchedule,
  getSchedule,
  updateSchedule,
  deleteSchedule,
  listSchedules,
  getHistory,
} from '../../cluster-bus/audit-schedule-store.js';
import {
  getAuditScheduler,
} from '../../cluster-bus/audit-scheduler.js';

const schema = z.object({
  action: z
    .enum(['create', 'list', 'get', 'update', 'delete', 'trigger', 'status', 'start', 'stop'])
    .describe(
      'Action: create (new schedule), list (all schedules), get (one schedule + history), ' +
      'update (modify schedule), delete (remove), trigger (run now), status (scheduler state), ' +
      'start (enable schedule timer), stop (disable schedule timer)'
    ),
  id: z
    .string()
    .optional()
    .describe('Schedule ID (required for get, update, delete, trigger, start, stop)'),
  name: z
    .string()
    .optional()
    .describe('Schedule name (for create)'),
  intervalMinutes: z
    .number()
    .min(5)
    .max(43200)
    .optional()
    .describe('Interval between audit runs in minutes (5 min to 30 days)'),
  auditType: z
    .string()
    .optional()
    .describe('Audit type label (e.g., "security", "performance", "full")'),
  prompt: z
    .string()
    .optional()
    .describe('Base prompt for the magistrale dispatch'),
  focusAreas: z
    .array(z.string())
    .optional()
    .describe('Focus areas for work partitioning across clusters'),
  maxTargets: z
    .number()
    .min(1)
    .max(10)
    .optional()
    .describe('Max clusters to dispatch to (default: 3)'),
  timeoutMs: z
    .number()
    .min(30000)
    .max(600000)
    .optional()
    .describe('Timeout per cluster in ms (default: 300000)'),
  orchestrateAgent: z
    .enum(['plan', 'build', 'explore', 'general'])
    .optional()
    .describe('Agent type for orchestration (default: plan)'),
  orchestrateMaxIterations: z
    .number()
    .min(1)
    .max(30)
    .optional()
    .describe('Max tool-call iterations per cluster (default: 10)'),
  orchestrateMaxTokens: z
    .number()
    .min(256)
    .max(128000)
    .optional()
    .describe('Max tokens per LLM call (default: 32000)'),
  enableCognition: z
    .boolean()
    .optional()
    .describe('Enable cognitive tools in audit (default: false)'),
  enableKanban: z
    .boolean()
    .optional()
    .describe('Enable kanban for recording findings (default: true)'),
  enableCollaboration: z
    .boolean()
    .optional()
    .describe('Enable inter-cluster collaboration (default: true)'),
  selfAssess: z
    .boolean()
    .optional()
    .describe('Enable self-assessment after audit (default: true)'),
  feedbackLoop: z
    .boolean()
    .optional()
    .describe('Enable kanban feedback loop (default: true)'),
  boardId: z
    .string()
    .optional()
    .describe('Kanban board ID for recording findings'),
  historyLimit: z
    .number()
    .min(1)
    .max(50)
    .optional()
    .describe('Number of history entries to return (default: 10)'),
});

export const auditSchedulerTool: UnifiedTool<typeof schema> = {
  name: 'audit-scheduler',
  description:
    'Self-organizing recurring audit system: create schedules, auto-dispatch magistrale audits, ' +
    'self-assess findings, and feed results back via kanban for continuous improvement',
  zodSchema: schema,
  metadata: {
    category: 'system',
    tags: ['audit', 'scheduler', 'magistrale', 'self-organizing', 'kanban'],
    examples: [
      {
        args: {
          action: 'create',
          name: 'Daily Security Audit',
          intervalMinutes: 1440,
          auditType: 'security',
          prompt: 'Audit the kemdicode-mcp codebase for security vulnerabilities',
          focusAreas: ['input validation', 'authentication', 'injection attacks'],
          maxTargets: 3,
          selfAssess: true,
          feedbackLoop: true,
        },
        description: 'Create a daily security audit with self-assessment and feedback loop',
      },
      {
        args: {
          action: 'trigger',
          id: '<schedule-id>',
        },
        description: 'Trigger an audit immediately outside normal schedule',
      },
      {
        args: {
          action: 'status',
        },
        description: 'View scheduler status: running timers and active audits',
      },
    ],
    relatedTools: ['cluster-bus-magistrale', 'task', 'board'],
  },

  execute: async (args) => {
    const scheduler = getAuditScheduler();

    switch (args.action) {
      case 'create': {
        if (!args.name || !args.prompt) {
          return 'Error: name and prompt are required for create';
        }

        const schedule = await createSchedule({
          name: args.name,
          intervalMs: (args.intervalMinutes ?? 1440) * 60 * 1000,
          enabled: true,
          auditType: args.auditType ?? 'general',
          prompt: args.prompt,
          focusAreas: args.focusAreas ?? [],
          magistraleConfig: {
            maxTargets: args.maxTargets ?? 3,
            timeoutMs: args.timeoutMs ?? 300000,
            orchestrateAgent: args.orchestrateAgent ?? 'plan',
            orchestrateMaxIterations: args.orchestrateMaxIterations ?? 10,
            orchestrateMaxTokens: args.orchestrateMaxTokens ?? 32000,
            orchestrateEnableCognition: args.enableCognition ?? false,
            orchestrateEnableKanban: args.enableKanban ?? true,
            orchestrateEnableCollaboration: args.enableCollaboration ?? true,
          },
          boardId: args.boardId,
          selfAssessEnabled: args.selfAssess ?? true,
          feedbackLoopEnabled: args.feedbackLoop ?? true,
        });

        scheduler.startTimer(schedule);

        return [
          '# Audit Schedule Created',
          '',
          `- **ID:** ${schedule.id}`,
          `- **Name:** ${schedule.name}`,
          `- **Type:** ${schedule.auditType}`,
          `- **Interval:** ${args.intervalMinutes ?? 1440} minutes`,
          `- **Focus Areas:** ${schedule.focusAreas.join(', ') || 'none'}`,
          `- **Self-Assessment:** ${schedule.selfAssessEnabled ? 'enabled' : 'disabled'}`,
          `- **Feedback Loop:** ${schedule.feedbackLoopEnabled ? 'enabled' : 'disabled'}`,
          `- **Clusters:** ${schedule.magistraleConfig.maxTargets}`,
          '',
          'Timer started. First audit will run after the configured interval.',
          'Use `trigger` action to run immediately.',
        ].join('\n');
      }

      case 'list': {
        const schedules = await listSchedules();
        if (schedules.length === 0) {
          return 'No audit schedules configured. Use action=create to set one up.';
        }

        const lines = ['# Audit Schedules', ''];
        for (const s of schedules) {
          const intervalMin = Math.round(s.intervalMs / 60000);
          lines.push(
            `- **${s.name}** (${s.id.slice(0, 8)}) — ${s.auditType}, every ${intervalMin}min, ${s.enabled ? 'enabled' : 'disabled'}`,
            `  Focus: ${s.focusAreas.join(', ') || 'none'} | Self-assess: ${s.selfAssessEnabled} | Feedback: ${s.feedbackLoopEnabled}`
          );
        }
        return lines.join('\n');
      }

      case 'get': {
        if (!args.id) return 'Error: id is required for get';

        const schedule = await getSchedule(args.id);
        if (!schedule) return `Schedule ${args.id} not found`;

        const history = await getHistory(args.id, args.historyLimit ?? 10);
        const intervalMin = Math.round(schedule.intervalMs / 60000);

        const lines = [
          '# Audit Schedule',
          '',
          `- **ID:** ${schedule.id}`,
          `- **Name:** ${schedule.name}`,
          `- **Type:** ${schedule.auditType}`,
          `- **Enabled:** ${schedule.enabled}`,
          `- **Interval:** ${intervalMin} minutes`,
          `- **Focus Areas:** ${schedule.focusAreas.join(', ') || 'none'}`,
          `- **Self-Assessment:** ${schedule.selfAssessEnabled}`,
          `- **Feedback Loop:** ${schedule.feedbackLoopEnabled}`,
          `- **Board ID:** ${schedule.boardId || 'none'}`,
          `- **Max Targets:** ${schedule.magistraleConfig.maxTargets}`,
          `- **Agent:** ${schedule.magistraleConfig.orchestrateAgent}`,
          `- **Created:** ${schedule.createdAt}`,
          `- **Updated:** ${schedule.updatedAt}`,
        ];

        if (history.length > 0) {
          lines.push('', '## History', '');
          lines.push('| Time | Duration | Clusters | Focus | Feedback |');
          lines.push('|------|----------|----------|-------|----------|');
          for (const h of history) {
            lines.push(
              `| ${h.timestamp.slice(0, 19)} | ${(h.durationMs / 1000).toFixed(1)}s | ${h.successCount}/${h.dispatchedTo} | ${h.focusAreas.slice(0, 2).join(', ')} | ${h.feedbackUsed ? 'yes' : 'no'} |`
            );
          }

          // Show latest follow-up areas
          const latest = history[0];
          if (latest.followUpAreas && latest.followUpAreas.length > 0) {
            lines.push('', '## Next Focus Areas (from self-assessment)', '');
            for (const area of latest.followUpAreas) {
              lines.push(`- ${area}`);
            }
          }
        } else {
          lines.push('', '*No audit history yet*');
        }

        return lines.join('\n');
      }

      case 'update': {
        if (!args.id) return 'Error: id is required for update';

        const updates: Record<string, unknown> = {};

        if (args.name !== undefined) updates.name = args.name;
        if (args.auditType !== undefined) updates.auditType = args.auditType;
        if (args.prompt !== undefined) updates.prompt = args.prompt;
        if (args.focusAreas !== undefined) updates.focusAreas = args.focusAreas;
        if (args.intervalMinutes !== undefined) {
          updates.intervalMs = args.intervalMinutes * 60 * 1000;
        }
        if (args.selfAssess !== undefined) updates.selfAssessEnabled = args.selfAssess;
        if (args.feedbackLoop !== undefined) updates.feedbackLoopEnabled = args.feedbackLoop;
        if (args.boardId !== undefined) updates.boardId = args.boardId;

        // Magistrale config updates
        const existing = await getSchedule(args.id);
        if (!existing) return `Schedule ${args.id} not found`;

        const mcfg = { ...existing.magistraleConfig };
        if (args.maxTargets !== undefined) mcfg.maxTargets = args.maxTargets;
        if (args.timeoutMs !== undefined) mcfg.timeoutMs = args.timeoutMs;
        if (args.orchestrateAgent !== undefined) mcfg.orchestrateAgent = args.orchestrateAgent;
        if (args.orchestrateMaxIterations !== undefined) mcfg.orchestrateMaxIterations = args.orchestrateMaxIterations;
        if (args.orchestrateMaxTokens !== undefined) mcfg.orchestrateMaxTokens = args.orchestrateMaxTokens;
        if (args.enableCognition !== undefined) mcfg.orchestrateEnableCognition = args.enableCognition;
        if (args.enableKanban !== undefined) mcfg.orchestrateEnableKanban = args.enableKanban;
        if (args.enableCollaboration !== undefined) mcfg.orchestrateEnableCollaboration = args.enableCollaboration;
        updates.magistraleConfig = mcfg;

        const updated = await updateSchedule(args.id, updates);
        if (!updated) return `Failed to update schedule ${args.id}`;

        // Restart timer if interval changed or schedule is enabled
        if (updated.enabled) {
          scheduler.startTimer(updated);
        }

        return `Schedule "${updated.name}" updated successfully`;
      }

      case 'delete': {
        if (!args.id) return 'Error: id is required for delete';

        scheduler.stopTimer(args.id);
        const deleted = await deleteSchedule(args.id);
        return deleted
          ? `Schedule ${args.id} deleted and timer stopped`
          : `Schedule ${args.id} not found`;
      }

      case 'trigger': {
        if (!args.id) return 'Error: id is required for trigger';

        const schedule = await getSchedule(args.id);
        if (!schedule) return `Schedule ${args.id} not found`;

        const entry = await scheduler.triggerNow(args.id);
        if (!entry) return 'Audit could not be executed (check logs for details)';

        const lines = [
          '# Audit Triggered',
          '',
          `- **Schedule:** ${schedule.name}`,
          `- **Duration:** ${(entry.durationMs / 1000).toFixed(1)}s`,
          `- **Clusters:** ${entry.successCount}/${entry.dispatchedTo}`,
          `- **Feedback Used:** ${entry.feedbackUsed}`,
        ];

        if (entry.followUpAreas) {
          lines.push('', '## Follow-Up Areas', '');
          for (const area of entry.followUpAreas) {
            lines.push(`- ${area}`);
          }
        }

        lines.push('', '## Summary', '', entry.summary);

        return lines.join('\n');
      }

      case 'status': {
        const status = scheduler.getStatus();
        const schedules = await listSchedules();

        const lines = [
          '# Audit Scheduler Status',
          '',
          `- **Initialized:** ${status.initialized}`,
          `- **Running Timers:** ${status.runningTimers.length}`,
          `- **Active Audits:** ${status.activeAudits.length}`,
          '',
        ];

        if (schedules.length > 0) {
          lines.push('## Schedules', '');
          for (const s of schedules) {
            const running = status.runningTimers.includes(s.id);
            const active = status.activeAudits.includes(s.id);
            const intervalMin = Math.round(s.intervalMs / 60000);
            lines.push(
              `- **${s.name}** — ${running ? 'timer running' : 'timer stopped'}${active ? ' (EXECUTING)' : ''}, every ${intervalMin}min`
            );
          }
        }

        return lines.join('\n');
      }

      case 'start': {
        if (!args.id) return 'Error: id is required for start';

        const schedule = await getSchedule(args.id);
        if (!schedule) return `Schedule ${args.id} not found`;

        await updateSchedule(args.id, { enabled: true });
        scheduler.startTimer({ ...schedule, enabled: true });

        return `Schedule "${schedule.name}" enabled and timer started`;
      }

      case 'stop': {
        if (!args.id) return 'Error: id is required for stop';

        const schedule = await getSchedule(args.id);
        if (!schedule) return `Schedule ${args.id} not found`;

        await updateSchedule(args.id, { enabled: false });
        scheduler.stopTimer(args.id);

        return `Schedule "${schedule.name}" disabled and timer stopped`;
      }

      default:
        return `Unknown action: ${args.action}`;
    }
  },
};
