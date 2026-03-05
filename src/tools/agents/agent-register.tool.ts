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
 * Agent Register Tool
 *
 * Register 1-N agents at once in the multi-agent system.
 * Supports both single and bulk registration.
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { getAgentMonitor } from '../../context/agent-monitor.js';
import type { AgentRole } from '../../context/types.js';
import { isSilent } from '../../config/silent.js';

const agentSchema = z.object({
  name: z.string().min(1).describe('Human-readable agent name'),
  role: z
    .enum(['supervisor', 'worker', 'specialist', 'coordinator'])
    .default('worker')
    .describe('Agent role'),
  model: z.string().optional().describe('Model being used'),
  metadata: z.record(
    z.string().regex(/^(?!__proto__|constructor|prototype$)/, 'Reserved key name'),
    z.unknown()
  ).optional().describe('Additional metadata'),
});

const schema = z.object({
  agents: z.array(agentSchema).min(1).max(20).describe('Array of agents to register (max 20)'),
  sessionId: z.string().min(1).describe('Session ID for all agents'),
  serverId: z.string().default('kemdicode-mcp').describe('Server running these agents'),
});

interface RegisteredAgent {
  id: string;
  name: string;
  role: string;
  success: boolean;
  error?: string;
}

export const agentRegisterTool: UnifiedTool = {
  name: 'agent-register',
  description: 'Register 1-20 agents in bulk. Returns agent IDs only — no task claiming or intent setting. Use when: registering agents that will claim tasks separately. For full onboarding (register + claim task + set intent), use agent-init instead.',
  zodSchema: schema,
  skipContextShare: true,
  metadata: {
    category: 'agents',
    tags: ['register', 'lifecycle'],
    examples: [
      { args: { agents: [{ name: 'Backend Dev', role: 'worker', model: 'claude-sonnet-4-20250514' }], sessionId: 'sess-abc123', serverId: 'kemdicode-mcp' }, description: 'Register a single worker agent' },
      { args: { agents: [{ name: 'Coordinator', role: 'coordinator' }, { name: 'QA Agent', role: 'specialist' }], sessionId: 'sess-abc123' }, description: 'Register multiple agents at once' },
    ],
    relatedTools: ['agent-list', 'agent-init'],
  },

  execute: async (args) => {
    const { agents, sessionId, serverId } = args as unknown as z.infer<typeof schema>;

    const monitor = getAgentMonitor();
    if (!monitor.isConnected()) {
      await monitor.connect();
    }

    const results: RegisteredAgent[] = [];

    // Register all agents in parallel
    const registrationPromises = agents.map(async (agentDef) => {
      try {
        const agent = await monitor.registerAgent(
          agentDef.name,
          agentDef.role as AgentRole,
          sessionId,
          serverId,
          agentDef.model,
          agentDef.metadata || {}
        );

        if (agent) {
          return {
            id: agent.id,
            name: agentDef.name,
            role: agentDef.role,
            success: true,
          };
        } else {
          return {
            id: '',
            name: agentDef.name,
            role: agentDef.role,
            success: false,
            error: 'Registration failed',
          };
        }
      } catch (error) {
        return {
          id: '',
          name: agentDef.name,
          role: agentDef.role,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });

    const registrationResults = await Promise.all(registrationPromises);
    results.push(...registrationResults);

    const successful = results.filter((r) => r.success);
    const failed = results.filter((r) => !r.success);

    const roleIcon = (role: string) =>
      ({
        supervisor: '👑',
        coordinator: '🎯',
        worker: '⚙️',
        specialist: '🔬',
      })[role] || '👤';

    if (isSilent()) {
      const ids = successful.map((r) => r.id);
      if (failed.length > 0) {
        return JSON.stringify({ registered: ids, errors: failed.map((r) => r.error) });
      }
      return JSON.stringify(ids);
    }

    return JSON.stringify({
      success: failed.length === 0,
      sessionId,
      serverId,
      registered: successful.length,
      failed: failed.length,
      agents: results.map((r) => ({
        id: r.id,
        name: r.name,
        role: `${roleIcon(r.role)} ${r.role}`,
        success: r.success,
        error: r.error,
      })),
      // Quick reference for agent IDs
      agentIds: successful.map((r) => r.id),
      // Comma-separated for easy use with agent-alert
      agentIdsString: successful.map((r) => r.id).join(','),
    });
  },
};
