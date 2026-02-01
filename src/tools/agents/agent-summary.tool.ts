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
 * Agent Summary Tool
 *
 * Update activity summaries for 1-N agents at once.
 * Supports both single and bulk status updates.
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { getAgentMonitor } from '../../context/agent-monitor.js';
import { isSilent } from '../../config/silent.js';

const summarySchema = z.object({
  agentId: z.string().min(1).describe('Agent ID'),
  activity: z.string().min(1).describe('Current activity description'),
  progress: z.number().min(0).max(100).optional().describe('Progress percentage'),
  taskId: z.string().optional().describe('Current task ID'),
  lastAction: z.string().optional().describe('Last completed action'),
});

const schema = z.object({
  summaries: z
    .array(summarySchema)
    .min(1)
    .max(20)
    .describe('Array of agent summaries to update (max 20)'),
  sessionId: z.string().min(1).describe('Session ID'),
});

interface SummaryResult {
  agentId: string;
  activity: string;
  progress?: number;
  success: boolean;
  error?: string;
}

export const agentSummaryTool: UnifiedTool = {
  name: 'agent-summary',
  description: 'Report agent activity (1-20). Update progress and status.',
  zodSchema: schema,
  skipContextShare: true,
  metadata: {
    category: 'agents',
    tags: ['summary', 'status'],
    examples: [
      { args: { summaries: [{ agentId: 'backend-dev', activity: 'Implementing JWT auth', progress: 65, taskId: 'task-1' }], sessionId: 'sess-abc123' }, description: 'Update single agent summary with progress' },
      { args: { summaries: [{ agentId: 'agent-1', activity: 'Writing tests' }, { agentId: 'agent-2', activity: 'Code review' }], sessionId: 'sess-abc123' }, description: 'Batch update multiple agent summaries' },
    ],
    relatedTools: ['agent-list', 'monitor'],
  },

  execute: async (args) => {
    const { summaries, sessionId } = args as z.infer<typeof schema>;

    const monitor = getAgentMonitor();
    if (!monitor.isConnected()) {
      await monitor.connect();
    }

    const results: SummaryResult[] = [];

    // Update all summaries in parallel
    const updatePromises = summaries.map(async (summary) => {
      try {
        const success = await monitor.updateAgentSummary(summary.agentId, {
          sessionId,
          activity: summary.activity,
          progress: summary.progress,
          currentTaskId: summary.taskId,
          lastAction: summary.lastAction,
        });

        return {
          agentId: summary.agentId,
          activity: summary.activity,
          progress: summary.progress,
          success,
          error: success ? undefined : 'Update failed',
        };
      } catch (error) {
        return {
          agentId: summary.agentId,
          activity: summary.activity,
          progress: summary.progress,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });

    const updateResults = await Promise.all(updatePromises);
    results.push(...updateResults);

    const successful = results.filter((r) => r.success);
    const failed = results.filter((r) => !r.success);

    if (isSilent()) {
      return JSON.stringify({ updated: successful.length });
    }

    return JSON.stringify({
      success: failed.length === 0,
      sessionId,
      updated: successful.length,
      failed: failed.length,
      results: results.map((r) => ({
        agentId: r.agentId,
        activity: r.activity + (r.progress !== undefined ? ` (${r.progress}%)` : ''),
        success: r.success,
        error: r.error,
      })),
    });
  },
};
