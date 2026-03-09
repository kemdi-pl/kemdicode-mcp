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
 * Unified Agent Communication Tool
 *
 * Consolidates 4 agent communication tools into a single action-based tool:
 * - queue: Queue async messages to agents (was queue-message)
 * - alert: Send urgent alerts or create persistent directives (was agent-alert)
 * - inject: Inject context/directives into agent session (was agent-inject)
 * - history: View agent conversation history (was agent-history)
 */

import { z } from 'zod';
import type { UnifiedTool } from '../registry.js';
import { queueMessageTool } from './queue-message.tool.js';
import { agentAlertTool } from './agent-alert.tool.js';
import { agentInjectTool } from './agent-inject.tool.js';
import { agentHistoryTool } from './agent-history.tool.js';

const schema = z.object({
  action: z
    .enum(['queue', 'alert', 'inject', 'history'])
    .describe('Action: queue (async messages), alert (urgent alerts/directives), inject (context into agent session), history (conversation log)'),

  // ── queue params ─────────────────────────────────────────────────────────
  messages: z
    .array(
      z.object({
        targetAgentId: z.string().min(1).describe('Target agent ID'),
        content: z.string().min(1).max(1048576).describe('Message content (max 1MB)'),
        priority: z
          .enum(['low', 'normal', 'high', 'critical'])
          .default('normal')
          .describe('Message priority'),
        files: z.array(z.string()).optional().describe('File paths to attach'),
        context: z.record(z.string(), z.unknown()).optional().describe('Additional context'),
        forceContextChange: z.boolean().default(false).describe('Force agent to change context'),
      })
    )
    .min(1)
    .max(20)
    .optional()
    .describe('Individual messages for action=queue (1-20)'),
  targetAgentIds: z
    .array(z.string().min(1))
    .min(1)
    .max(20)
    .optional()
    .describe('Broadcast target agent IDs for action=queue (1-20)'),
  fromAgentId: z
    .string()
    .default('supervisor')
    .describe('Sender agent ID (action=queue)'),

  // ── alert params ─────────────────────────────────────────────────────────
  alertAction: z
    .enum(['send', 'list-directives', 'cancel-directive'])
    .optional()
    .default('send')
    .describe('Alert sub-action (action=alert)'),
  agentIds: z
    .string()
    .optional()
    .describe('Comma-separated agent IDs or "*" for broadcast (action=alert, alertAction=send)'),
  message: z
    .string()
    .optional()
    .describe('Alert message content (action=alert, alertAction=send)'),
  source: z
    .string()
    .default('Claude Opus 4.5')
    .describe('Alert source name (action=alert)'),
  interrupt: z
    .boolean()
    .default(false)
    .describe('Interrupt current agent processing (action=alert)'),
  asDirective: z
    .boolean()
    .default(false)
    .describe('Create as persistent directive instead of real-time alert (action=alert)'),
  directiveTitle: z
    .string()
    .optional()
    .describe('Short title for directive (action=alert, asDirective=true)'),
  directiveTtlSeconds: z
    .number()
    .min(60)
    .max(86400)
    .optional()
    .describe('TTL for directive in seconds (action=alert, default: 3600)'),
  directiveId: z
    .string()
    .optional()
    .describe('Directive ID to cancel (action=alert, alertAction=cancel-directive)'),

  // ── inject params ────────────────────────────────────────────────────────
  agentId: z
    .string()
    .optional()
    .describe('Target agent ID (action=inject, history)'),
  injectType: z
    .enum(['context', 'directive', 'query'])
    .optional()
    .default('context')
    .describe('Injection type (action=inject)'),
  data: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Structured data JSON (action=inject)'),

  // ── history params ───────────────────────────────────────────────────────
  since: z
    .number()
    .optional()
    .describe('Only show messages after this timestamp in Unix ms (action=history)'),
  historyType: z
    .enum(['all', 'chat', 'alert', 'directive', 'context', 'query', 'response', 'status', 'system'])
    .optional()
    .default('all')
    .describe('Filter by message type (action=history)'),

  // ── shared params ────────────────────────────────────────────────────────
  content: z
    .string()
    .optional()
    .describe('Content (action=queue broadcast, alert send, inject)'),
  sessionId: z
    .string()
    .optional()
    .describe('Session ID'),
  priority: z
    .enum(['low', 'normal', 'high', 'critical'])
    .default('normal')
    .describe('Priority level'),
  limit: z
    .number()
    .min(1)
    .max(200)
    .default(50)
    .describe('Max items to return (action=history)'),
  files: z
    .array(z.string())
    .optional()
    .describe('File paths to attach (action=queue broadcast)'),
  context: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Additional context (action=queue broadcast)'),
  forceContextChange: z
    .boolean()
    .default(false)
    .describe('Force context change (action=queue broadcast)'),
});

export const agentCommTool: UnifiedTool = {
  name: 'agent-comm',
  description:
    'Unified agent communication. Actions: queue (async messages to 1-N agents, individual or broadcast), alert (urgent alerts, persistent directives, list/cancel directives), inject (context/directive/query into specific agent session), history (conversation log with filters).',
  zodSchema: schema,
  skipContextShare: true,
  metadata: {
    category: 'agents',
    tags: ['communication', 'queue', 'alert', 'inject', 'history'],
    examples: [
      {
        args: {
          action: 'queue',
          messages: [{ targetAgentId: 'backend-dev', content: 'Please review PR #42', priority: 'high' }],
          sessionId: 'sess-abc123',
        },
        description: 'Queue a message to an agent',
      },
      {
        args: {
          action: 'alert',
          agentIds: '*',
          message: 'Critical bug found — stop all work',
          priority: 'critical',
          interrupt: true,
        },
        description: 'Broadcast critical alert to all agents',
      },
      {
        args: {
          action: 'inject',
          agentId: 'backend-dev',
          sessionId: 'sess-abc123',
          injectType: 'context',
          content: 'DB schema changed: new email_verified column',
        },
        description: 'Inject context into running agent',
      },
      {
        args: {
          action: 'history',
          sessionId: 'sess-abc123',
          limit: 20,
        },
        description: 'View recent conversation history',
      },
    ],
    relatedTools: ['agent', 'monitor', 'task-list'],
  },

  execute: async (args) => {
    const parsed = args as unknown as z.infer<typeof schema>;

    switch (parsed.action) {
      case 'queue': {
        if (!parsed.sessionId) {
          return JSON.stringify({
            success: false,
            error: 'sessionId is required for action=queue',
            code: 'VALIDATION_ERROR',
          });
        }

        // Build args for queue-message tool
        const queueArgs: Record<string, unknown> = {
          sessionId: parsed.sessionId,
          fromAgentId: parsed.fromAgentId,
        };

        if (parsed.messages && parsed.messages.length > 0) {
          // Individual message mode
          queueArgs.messages = parsed.messages;
        } else if (parsed.targetAgentIds && parsed.targetAgentIds.length > 0) {
          // Broadcast mode
          if (!parsed.content) {
            return JSON.stringify({
              success: false,
              error: 'content is required for broadcast mode (action=queue with targetAgentIds)',
              code: 'VALIDATION_ERROR',
            });
          }
          queueArgs.targetAgentIds = parsed.targetAgentIds;
          queueArgs.content = parsed.content;
          queueArgs.priority = parsed.priority;
          queueArgs.files = parsed.files;
          queueArgs.context = parsed.context;
          queueArgs.forceContextChange = parsed.forceContextChange;
        } else {
          return JSON.stringify({
            success: false,
            error: 'Provide either "messages" (individual) or "targetAgentIds" + "content" (broadcast) for action=queue',
            code: 'VALIDATION_ERROR',
          });
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return queueMessageTool.execute(queueArgs as any);
      }

      case 'alert': {
        return agentAlertTool.execute({
          action: parsed.alertAction ?? 'send',
          agentIds: parsed.agentIds,
          message: parsed.message,
          source: parsed.source,
          priority: parsed.priority,
          interrupt: parsed.interrupt,
          sessionId: parsed.sessionId,
          asDirective: parsed.asDirective,
          directiveTitle: parsed.directiveTitle,
          directiveTtlSeconds: parsed.directiveTtlSeconds,
          directiveId: parsed.directiveId,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any);
      }

      case 'inject': {
        if (!parsed.agentId) {
          return JSON.stringify({
            success: false,
            error: 'agentId is required for action=inject',
            code: 'VALIDATION_ERROR',
          });
        }
        if (!parsed.sessionId) {
          return JSON.stringify({
            success: false,
            error: 'sessionId is required for action=inject',
            code: 'VALIDATION_ERROR',
          });
        }
        if (!parsed.content) {
          return JSON.stringify({
            success: false,
            error: 'content is required for action=inject',
            code: 'VALIDATION_ERROR',
          });
        }
        return agentInjectTool.execute({
          agentId: parsed.agentId,
          sessionId: parsed.sessionId,
          type: parsed.injectType ?? 'context',
          content: parsed.content,
          data: parsed.data,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any);
      }

      case 'history': {
        if (!parsed.sessionId) {
          return JSON.stringify({
            success: false,
            error: 'sessionId is required for action=history',
            code: 'VALIDATION_ERROR',
          });
        }
        return agentHistoryTool.execute({
          sessionId: parsed.sessionId,
          agentId: parsed.agentId,
          limit: parsed.limit,
          since: parsed.since,
          type: parsed.historyType ?? 'all',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any);
      }

      default:
        return JSON.stringify({
          success: false,
          error: `Unknown action: ${parsed.action}`,
          code: 'UNKNOWN_ACTION',
        });
    }
  },
};
