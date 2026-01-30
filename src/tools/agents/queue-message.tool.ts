/**
 * KemdiCode MCP Server
 * Copyright (C) 2025-2026 Kemdi Sp. z o.o.
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
 * Queue Message Tool
 *
 * Queue messages to 1-N agents at once.
 * Two modes: individual messages per agent OR broadcast same message to all.
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { getAgentMonitor } from '../../context/agent-monitor.js';
import type { MessagePriority } from '../../context/types.js';

const messageSchema = z.object({
  targetAgentId: z.string().min(1).describe('Target agent ID'),
  content: z.string().min(1).max(1048576).describe('Message content (max 1MB)'),
  priority: z
    .enum(['low', 'normal', 'high', 'critical'])
    .default('normal')
    .describe('Message priority'),
  files: z.array(z.string()).optional().describe('File paths to attach'),
  context: z.record(z.string(), z.unknown()).optional().describe('Additional context'),
  forceContextChange: z.boolean().default(false).describe('Force agent to change context'),
});

const schema = z.object({
  messages: z.array(messageSchema).min(1).max(20).describe('Array of messages to queue (max 20)'),
  sessionId: z.string().min(1).describe('Session ID'),
  fromAgentId: z.string().default('supervisor').describe('Sender agent ID'),
});

// Alternative: broadcast same message to multiple agents
const broadcastSchema = z.object({
  targetAgentIds: z.array(z.string().min(1)).min(1).max(20).describe('Target agent IDs'),
  content: z.string().min(1).max(1048576).describe('Message content (same for all, max 1MB)'),
  priority: z.enum(['low', 'normal', 'high', 'critical']).default('normal'),
  sessionId: z.string().min(1).describe('Session ID'),
  fromAgentId: z.string().default('supervisor'),
  files: z.array(z.string()).optional(),
  context: z.record(z.string(), z.unknown()).optional(),
  forceContextChange: z.boolean().default(false),
});

// Combined schema supporting both modes
const combinedSchema = z.union([schema, broadcastSchema]);

interface QueueResult {
  targetAgentId: string;
  messageId?: string;
  priority: string;
  success: boolean;
  error?: string;
  queueDepth?: number;
}

export const queueMessageTool: UnifiedTool = {
  name: 'queue-message',
  description:
    'Queue messages to agents. Use "messages" array or "targetAgentIds" + "content" for broadcast.',
  zodSchema: combinedSchema,
  skipContextShare: true,

  execute: async (args) => {
    const monitor = getAgentMonitor();
    if (!monitor.isConnected()) {
      await monitor.connect();
    }

    const results: QueueResult[] = [];

    // Detect which mode we're in
    const isBroadcastMode = 'targetAgentIds' in args && Array.isArray(args.targetAgentIds);

    if (isBroadcastMode) {
      // Broadcast mode: same message to multiple agents
      const {
        targetAgentIds,
        content,
        priority,
        sessionId,
        fromAgentId,
        files,
        context,
        forceContextChange,
      } = args as z.infer<typeof broadcastSchema>;

      const queuePromises = targetAgentIds.map(async (targetAgentId) => {
        try {
          const message = await monitor.queueMessage(targetAgentId, sessionId, content, {
            priority: priority as MessagePriority,
            files,
            context,
            forceContextChange,
            fromAgentId,
          });

          if (message) {
            const queueDepth = await monitor.getQueueDepth(targetAgentId);
            return {
              targetAgentId,
              messageId: message.id,
              priority,
              success: true,
              queueDepth,
            };
          } else {
            return {
              targetAgentId,
              priority,
              success: false,
              error: 'Failed to queue message',
            };
          }
        } catch (error) {
          return {
            targetAgentId,
            priority,
            success: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      });

      results.push(...(await Promise.all(queuePromises)));
    } else {
      // Individual messages mode
      const { messages, sessionId, fromAgentId } = args as unknown as z.infer<typeof schema>;

      const queuePromises = messages.map(async (msg) => {
        try {
          const message = await monitor.queueMessage(msg.targetAgentId, sessionId, msg.content, {
            priority: msg.priority as MessagePriority,
            files: msg.files,
            context: msg.context,
            forceContextChange: msg.forceContextChange,
            fromAgentId,
          });

          if (message) {
            const queueDepth = await monitor.getQueueDepth(msg.targetAgentId);
            return {
              targetAgentId: msg.targetAgentId,
              messageId: message.id,
              priority: msg.priority,
              success: true,
              queueDepth,
            };
          } else {
            return {
              targetAgentId: msg.targetAgentId,
              priority: msg.priority,
              success: false,
              error: 'Failed to queue message',
            };
          }
        } catch (error) {
          return {
            targetAgentId: msg.targetAgentId,
            priority: msg.priority,
            success: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      });

      results.push(...(await Promise.all(queuePromises)));
    }

    const successful = results.filter((r) => r.success);
    const failed = results.filter((r) => !r.success);

    const priorityIcon = (p: string) =>
      ({
        low: '⚪',
        normal: '🟢',
        high: '🟠',
        critical: '🔴',
      })[p] || '⚪';

    return JSON.stringify({
      success: failed.length === 0,
      mode: isBroadcastMode ? 'broadcast' : 'individual',
      queued: successful.length,
      failed: failed.length,
      results: results.map((r) => ({
        targetAgentId: r.targetAgentId,
        messageId: r.messageId,
        priority: `${priorityIcon(r.priority)} ${r.priority}`,
        queueDepth: r.queueDepth,
        success: r.success,
        error: r.error,
      })),
    });
  },
};
