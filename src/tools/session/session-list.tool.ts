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
 * Session List Tool
 *
 * Lists all active sessions with their models and status.
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { getSessionManager } from '../../session/manager.js';
import { isSilent } from '../../config/silent.js';

const schema = z.object({
  projectType: z
    .enum(['node', 'php', 'python', 'rust', 'go', 'ruby', 'java', 'dotnet', 'unknown'])
    .optional()
    .describe('Filter by project type'),
  activeWithin: z
    .number()
    .min(60000)
    .optional()
    .describe('Filter by active within last N milliseconds (min 60s)'),
  limit: z.number().min(1).max(100).default(20).describe('Maximum sessions to return'),
  includeExpired: z.boolean().default(false).describe('Include expired sessions'),
});

export const sessionListTool: UnifiedTool<typeof schema> = {
  name: 'session-list',
  description:
    'List active sessions with models, CWD, and status. Use for managing AI sessions.',
  zodSchema: schema,
  skipContextShare: true,

  metadata: {
    category: 'session',
    tags: ['session', 'list'],
    examples: [
      { args: { limit: 10 }, description: 'List up to 10 active sessions' },
      { args: { projectType: 'node', activeWithin: 3600000 }, description: 'List Node.js sessions active in the last hour' },
    ],
    relatedTools: ['session-create', 'session-info'],
  },

  execute: async (args) => {
    const { projectType, activeWithin, limit, includeExpired } = args;
    const manager = getSessionManager();

    const sessions = await manager.listSessions({
      projectType,
      activeWithin,
      limit,
      includeExpired,
    });

    if (sessions.length === 0) {
      if (isSilent()) return '[]';
      return '## 📋 Active Sessions\n\nNo active sessions found.\n\n💡 **Tip:** Create a session with `session-create` tool.';
    }

    if (isSilent()) {
      return JSON.stringify(sessions.map((s) => ({ id: s.sessionId, model: s.model, cwd: s.cwd })));
    }

    const lines: string[] = [
      '╔══════════════════════════════════════════════════════════════════╗',
      '║                    ACTIVE SESSIONS                               ║',
      '╠══════════════════════════════════════════════════════════════════╣',
    ];

    for (const session of sessions) {
      const age = Math.floor((Date.now() - session.lastAccessedAt) / 1000);
      const ageText =
        age < 60
          ? `${age}s`
          : age < 3600
            ? `${Math.floor(age / 60)}m`
            : `${Math.floor(age / 3600)}h`;

      lines.push(`║ 🆔 ${session.sessionId.padEnd(56)} ║`);
      lines.push(`║   Model: ${(session.model || 'default').padEnd(50)} ║`);
      if (session.fallbackModel) {
        lines.push(`║   Fallback: ${session.fallbackModel.padEnd(47)} ║`);
      }
      lines.push(`║   CWD: ${session.cwd.slice(-50).padStart(50)} ║`);
      lines.push(
        `║   Project: ${(session.projectType || 'unknown').padEnd(49)} ${session.projectName ? `(${session.projectName})` : ''}`
          .slice(0, 67)
          .padEnd(67) + '║'
      );
      lines.push(`║   Last active: ${ageText.padEnd(8)} ago`.padEnd(67) + '║');
      lines.push('╠──────────────────────────────────────────────────────────────────╣');
    }

    lines.pop(); // Remove last separator
    lines.push('╚══════════════════════════════════════════════════════════════════╝');
    lines.push(`\nTotal: ${sessions.length} session(s)`);

    return lines.join('\n');
  },
};
