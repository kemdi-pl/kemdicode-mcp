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
 * Agent Alert Tool
 *
 * Send alerts/directives to agents from supervisor (Claude Opus 4.5).
 * Format: [ALERT: Source] Message
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { getAgentMonitor } from '../../context/agent-monitor.js';
import { MessagePriority } from '../../context/types.js';
import { sanitizeTerminalOutput, wrapText } from '../../utils/format-helpers.js';
import { isSilent } from '../../config/silent.js';
import { createDirective, getDirective, deleteDirective } from '../../kanban/directive-store.js';
import { getSharedRedis } from '../../infrastructure/redis/connection.js';
import { KANBAN_KEYS } from '../../kanban/types.js';
import type { Directive, DirectivePriority } from '../../kanban/types.js';
import { Logger } from '../../utils/logger.js';

const schema = z.object({
  action: z
    .enum(['send', 'list-directives', 'cancel-directive'])
    .default('send')
    .describe('Action: send (default — send alert or create directive), list-directives (list all directives for a session), cancel-directive (cancel a directive by ID)'),
  agentIds: z.string().optional().describe('Comma-separated agent IDs or "*" for broadcast (required for action=send)'),
  message: z.string().optional().describe('Alert message content (required for action=send)'),
  source: z.string().default('Claude Opus 4.5').describe('Alert source name'),
  priority: z
    .enum(['low', 'normal', 'high', 'critical'])
    .default('high')
    .describe('Message priority'),
  interrupt: z.boolean().default(false).describe('Whether to interrupt current agent processing'),
  sessionId: z.string().optional().describe('Target session ID (required for list-directives and cancel-directive)'),
  asDirective: z
    .boolean()
    .default(false)
    .describe('Create as persistent directive (injected into next tool response) instead of real-time alert'),
  directiveTitle: z
    .string()
    .optional()
    .describe('Short title for directive (if asDirective=true)'),
  directiveTtlSeconds: z
    .number()
    .min(60)
    .max(86400)
    .optional()
    .describe('TTL for directive in seconds (default: 3600)'),
  directiveId: z
    .string()
    .optional()
    .describe('Directive ID to cancel (required for action=cancel-directive)'),
});

export const agentAlertTool: UnifiedTool = {
  name: 'agent-alert',
  description:
    'Send urgent one-time alerts or create persistent directives for agents. Alerts are real-time notifications via agent monitor. Directives (asDirective=true) persist in Redis and are injected into every subsequent tool response until cancelled. Use when: critical events or standing orders. For async message queuing between agents, use queue-message. For injecting context into a specific agent session, use agent-inject.',
  zodSchema: schema,
  skipContextShare: true,
  metadata: {
    category: 'agents',
    tags: ['alert', 'notification', 'directive'],
    examples: [
      { args: { agentIds: 'backend-dev', message: 'Deploy complete', priority: 'high' }, description: 'Send real-time alert to agent' },
      { args: { agentIds: '*', message: 'Stop all work, critical bug found', priority: 'critical', interrupt: true }, description: 'Broadcast critical alert to all agents' },
      { args: { agentIds: 'unused', sessionId: 'session-123', message: 'Sprawdź plik config.ts', asDirective: true, directiveTitle: 'Sprawdź konfigurację', priority: 'high' }, description: 'Create directive injected into next tool response' },
      { args: { action: 'list-directives', sessionId: 'session-123' }, description: 'List all active directives for a session' },
      { args: { action: 'cancel-directive', directiveId: 'dir_123456_abcdefgh', sessionId: 'session-123' }, description: 'Cancel a directive by ID' },
    ],
    relatedTools: ['agent-list', 'queue-message', 'task-list'],
  },

  execute: async (args) => {
    const { action, agentIds, message, source, priority, interrupt, sessionId, asDirective, directiveTitle, directiveTtlSeconds, directiveId } = args as z.infer<
      typeof schema
    >;

    // ─── LIST DIRECTIVES ─────────────────────────────────────────────────
    if (action === 'list-directives') {
      if (!sessionId) {
        return JSON.stringify({
          success: false,
          error: 'sessionId is required for action=list-directives',
          code: 'VALIDATION_ERROR',
        });
      }

      try {
        const redis = await getSharedRedis();
        const listKey = KANBAN_KEYS.directives(sessionId);
        const directiveIds = await redis.lrange(listKey, 0, -1);

        if (directiveIds.length === 0) {
          if (isSilent()) {
            return JSON.stringify({ directives: [], count: 0 });
          }
          return 'No directives found for this session.';
        }

        const now = Date.now();
        const directives: Directive[] = [];

        for (const id of directiveIds) {
          const dir = await getDirective(id);
          if (dir) {
            directives.push(dir);
          }
        }

        if (directives.length === 0) {
          if (isSilent()) {
            return JSON.stringify({ directives: [], count: 0 });
          }
          return 'No directives found for this session (all expired).';
        }

        if (isSilent()) {
          return JSON.stringify({
            directives: directives.map((d) => ({
              id: d.id,
              title: d.title,
              priority: d.priority,
              source: d.source,
              delivered: d.delivered,
              expired: d.expiresAt <= now,
              createdAt: d.createdAt,
              expiresAt: d.expiresAt,
            })),
            count: directives.length,
          });
        }

        const lines: string[] = [
          '╔══════════════════════════════════════════════════════════════════╗',
          '║                  DIRECTIVES LIST                                ║',
          '╠══════════════════════════════════════════════════════════════════╣',
          `║ Session: ${sanitizeTerminalOutput(sessionId).padEnd(55)} ║`,
          `║ Total:   ${directives.length.toString().padEnd(55)} ║`,
          '╠══════════════════════════════════════════════════════════════════╣',
        ];

        for (const dir of directives) {
          const expired = dir.expiresAt <= now;
          const statusLabel = expired ? 'EXPIRED' : dir.delivered ? 'DELIVERED' : 'PENDING';
          const statusIcon = expired ? '⏰' : dir.delivered ? '✅' : '⏳';
          const priorityIcon = { critical: '🔴', high: '🟠', normal: '🟢' }[dir.priority];
          const createdStr = new Date(dir.createdAt).toLocaleString();

          lines.push(`║ ${statusIcon} ${sanitizeTerminalOutput(dir.id).padEnd(62)} ║`);
          lines.push(`║   Title:    ${sanitizeTerminalOutput(dir.title).padEnd(52)} ║`);
          lines.push(`║   Priority: ${priorityIcon} ${dir.priority.padEnd(49)} ║`);
          lines.push(`║   Status:   ${statusLabel.padEnd(52)} ║`);
          lines.push(`║   Source:   ${sanitizeTerminalOutput(dir.source).padEnd(52)} ║`);
          lines.push(`║   Created:  ${createdStr.padEnd(52)} ║`);

          if (dir.delivered && dir.deliveredBy) {
            lines.push(`║   Delivered by: ${sanitizeTerminalOutput(dir.deliveredBy).padEnd(48)} ║`);
          }

          lines.push('╠──────────────────────────────────────────────────────────────────╣');
        }

        // Replace last separator with closing border
        lines[lines.length - 1] = '╚══════════════════════════════════════════════════════════════════╝';

        return lines.join('\n');
      } catch (error) {
        Logger.error('Failed to list directives:', error);
        return JSON.stringify({
          success: false,
          error: `Failed to list directives: ${error instanceof Error ? error.message : String(error)}`,
          code: 'LIST_DIRECTIVES_ERROR',
        });
      }
    }

    // ─── CANCEL DIRECTIVE ────────────────────────────────────────────────
    if (action === 'cancel-directive') {
      if (!directiveId) {
        return JSON.stringify({
          success: false,
          error: 'directiveId is required for action=cancel-directive',
          code: 'VALIDATION_ERROR',
        });
      }
      if (!sessionId) {
        return JSON.stringify({
          success: false,
          error: 'sessionId is required for action=cancel-directive',
          code: 'VALIDATION_ERROR',
        });
      }

      try {
        // Check if directive exists before deleting
        const existing = await getDirective(directiveId);
        if (!existing) {
          return JSON.stringify({
            success: false,
            error: `Directive not found: ${directiveId}`,
            code: 'NOT_FOUND',
          });
        }

        const deleted = await deleteDirective(directiveId, sessionId);

        if (!deleted) {
          return JSON.stringify({
            success: false,
            error: `Failed to delete directive: ${directiveId}`,
            code: 'DELETE_FAILED',
          });
        }

        Logger.info(`[agent-alert] Directive cancelled: ${directiveId} (session: ${sessionId})`);

        if (isSilent()) {
          return JSON.stringify({ success: true, directiveId, cancelled: true });
        }

        return [
          '╔══════════════════════════════════════════════════════════════════╗',
          '║                  DIRECTIVE CANCELLED                             ║',
          '╠══════════════════════════════════════════════════════════════════╣',
          `║ ID:       ${sanitizeTerminalOutput(directiveId).padEnd(54)} ║`,
          `║ Session:  ${sanitizeTerminalOutput(sessionId).padEnd(54)} ║`,
          `║ Title:    ${sanitizeTerminalOutput(existing.title).padEnd(54)} ║`,
          `║ Priority: ${existing.priority.padEnd(54)} ║`,
          `║ Status:   ${(existing.delivered ? 'was delivered' : 'was pending').padEnd(54)} ║`,
          '╚══════════════════════════════════════════════════════════════════╝',
        ].join('\n');
      } catch (error) {
        Logger.error('Failed to cancel directive:', error);
        return JSON.stringify({
          success: false,
          error: `Failed to cancel directive: ${error instanceof Error ? error.message : String(error)}`,
          code: 'CANCEL_DIRECTIVE_ERROR',
        });
      }
    }

    // ─── SEND (default action) ───────────────────────────────────────────

    if (!agentIds) {
      return JSON.stringify({
        success: false,
        error: 'agentIds is required for action=send',
        code: 'VALIDATION_ERROR',
      });
    }

    if (!message) {
      return JSON.stringify({
        success: false,
        error: 'message is required for action=send',
        code: 'VALIDATION_ERROR',
      });
    }

    // If creating as directive, use directive system instead of real-time alert
    if (asDirective) {
      if (!sessionId) {
        return JSON.stringify({
          success: false,
          error: 'sessionId is required when creating a directive (asDirective=true)',
          code: 'VALIDATION_ERROR',
        });
      }

      // Map alert priority to directive priority
      const directivePriority: DirectivePriority =
        priority === 'critical' ? 'critical' :
        priority === 'high' ? 'high' : 'normal';

      const directive = await createDirective({
        sessionId,
        priority: directivePriority,
        title: directiveTitle || `Alert from ${source}`,
        instruction: message,
        source: `agent-alert:${source}`,
        ttlSeconds: directiveTtlSeconds || 3600,
      });

      if (isSilent()) {
        return JSON.stringify({ directiveId: directive.id, type: 'directive' });
      }

      const priorityIcon = {
        critical: '🔴',
        high: '🟠',
        normal: '🟢',
      }[directivePriority];

      return [
        '╔══════════════════════════════════════════════════════════════════╗',
        '║                  DIRECTIVE CREATED                               ║',
        '╠══════════════════════════════════════════════════════════════════╣',
        `║ ID:       ${sanitizeTerminalOutput(directive.id).padEnd(54)} ║`,
        `║ Session:  ${sanitizeTerminalOutput(sessionId).padEnd(54)} ║`,
        `║ Priority: ${priorityIcon} ${directivePriority.padEnd(51)} ║`,
        `║ Source:   ${sanitizeTerminalOutput(source).padEnd(54)} ║`,
        `║ TTL:      ${(directiveTtlSeconds || 3600).toString().padEnd(54)} ║`,
        '╠──────────────────────────────────────────────────────────────────╣',
        `║ Title:    ${sanitizeTerminalOutput(directiveTitle || `Alert from ${source}`).padEnd(54)} ║`,
        '╠──────────────────────────────────────────────────────────────────╣',
        `║ Message (will be shown in next tool response):`.padEnd(67) + '║',
        ...wrapText(sanitizeTerminalOutput(message), 63).map((line) => `║   ${line.padEnd(62)} ║`),
        '╚══════════════════════════════════════════════════════════════════╝',
      ].join('\n');
    }

    // Original real-time alert logic
    const monitor = getAgentMonitor();

    if (!monitor.isConnected()) {
      await monitor.connect();
    }

    // Parse agent IDs
    const targets =
      agentIds === '*'
        ? '*'
        : agentIds
            .split(',')
            .map((id) => id.trim())
            .filter(Boolean);

    if (Array.isArray(targets) && targets.length === 0) {
      return 'Error: No valid agent IDs provided.';
    }

    const alert = await monitor.sendAlert(
      targets as string[] | '*',
      message,
      source,
      priority as MessagePriority,
      interrupt,
      sessionId
    );

    if (!alert) {
      return 'Failed to send alert. Check Redis connection.';
    }

    if (isSilent()) {
      return JSON.stringify({ id: alert.id });
    }

    const targetCount = targets === '*' ? 'all agents' : `${(targets as string[]).length} agent(s)`;
    const priorityIcon = {
      low: '⚪',
      normal: '🟢',
      high: '🟠',
      critical: '🔴',
    }[priority];

    const safeId = sanitizeTerminalOutput(alert.id);
    const safeSource = sanitizeTerminalOutput(source);
    const safeMessage = sanitizeTerminalOutput(message);

    return [
      '╔══════════════════════════════════════════════════════════════════╗',
      '║                    ALERT SENT                                    ║',
      '╠══════════════════════════════════════════════════════════════════╣',
      `║ ID:       ${safeId.padEnd(54)} ║`,
      `║ To:       ${targetCount.padEnd(54)} ║`,
      `║ Priority: ${priorityIcon} ${priority.padEnd(51)} ║`,
      `║ Source:   ${safeSource.padEnd(54)} ║`,
      `║ Interrupt: ${interrupt ? 'Yes' : 'No'}`.padEnd(67) + '║',
      '╠──────────────────────────────────────────────────────────────────╣',
      `║ Message:`.padEnd(67) + '║',
      ...wrapText(safeMessage, 63).map((line) => `║   ${line.padEnd(62)} ║`),
      '╚══════════════════════════════════════════════════════════════════╝',
    ].join('\n');
  },
};

