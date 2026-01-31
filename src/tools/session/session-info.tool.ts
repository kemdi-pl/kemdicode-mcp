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
 * Session Info Tool
 *
 * Gets detailed information about a specific session.
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { getSessionManager } from '../../session/manager.js';
import { isSilent } from '../../config/silent.js';

const schema = z.object({
  sessionId: z.string().describe('Session ID'),
});

export const sessionInfoTool: UnifiedTool<typeof schema> = {
  name: 'session-info',
  description: 'Get detailed session info: model, CWD, project, metadata.',
  zodSchema: schema,
  skipContextShare: true,

  metadata: {
    category: 'session',
    tags: ['session', 'info', 'details'],
    examples: [
      { args: { sessionId: 'session-1' }, description: 'Get detailed info about a session' },
    ],
    relatedTools: ['session-list', 'session-switch'],
  },

  execute: async (args) => {
    const { sessionId } = args;
    const manager = getSessionManager();

    const session = await manager.getSession(sessionId);

    if (!session) {
      return `❌ Session not found: ${sessionId}`;
    }

    if (isSilent()) {
      return JSON.stringify({ id: session.sessionId, model: session.model, cwd: session.cwd, projectType: session.projectType });
    }

    const age = Math.floor((Date.now() - session.createdAt) / 1000);
    const lastAccess = Math.floor((Date.now() - session.lastAccessedAt) / 1000);

    const formatTime = (seconds: number) => {
      if (seconds < 60) return `${seconds}s`;
      if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
      if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
      return `${Math.floor(seconds / 86400)}d`;
    };

    const lines: string[] = [
      '╔══════════════════════════════════════════════════════════════════╗',
      '║                    SESSION INFORMATION                           ║',
      '╠══════════════════════════════════════════════════════════════════╣',
      `║ 🆔 ID:        ${session.sessionId.padEnd(54)} ║`,
      `║ 🤖 Model:     ${(session.model || 'Not set').padEnd(54)} ║`,
    ];

    if (session.fallbackModel) {
      lines.push(`║ 🔄 Fallback:  ${session.fallbackModel.padEnd(54)} ║`);
    }

    lines.push(
      `║ 📁 CWD:       ${session.cwd.slice(-54).padStart(54)} ║`,
      `║ 📂 Project:   ${(session.projectType || 'unknown').padEnd(54)} ║`
    );

    if (session.projectName) {
      lines.push(`║ 📛 Name:      ${session.projectName.padEnd(54)} ║`);
    }

    lines.push(
      `║ ⏱️  Created:   ${formatTime(age).padEnd(54)} ago ║`,
      `║ 🕐 Last seen:  ${formatTime(lastAccess).padEnd(54)} ago ║`,
      '╠══════════════════════════════════════════════════════════════════╣',
      '║                      METADATA                                    ║',
      '╠══════════════════════════════════════════════════════════════════╣'
    );

    if (session.metadata && Object.keys(session.metadata).length > 0) {
      for (const [key, value] of Object.entries(session.metadata)) {
        const valueStr = typeof value === 'string' ? value : JSON.stringify(value);
        const line = `║ ${key}: ${valueStr}`;
        lines.push(line.slice(0, 67).padEnd(67) + '║');
      }
    } else {
      lines.push('║ No metadata'.padEnd(67) + '║');
    }

    if (session.enabledTools && session.enabledTools.length > 0) {
      lines.push(
        '╠══════════════════════════════════════════════════════════════════╣',
        '║                      ENABLED TOOLS                               ║',
        '╠══════════════════════════════════════════════════════════════════╣'
      );
      for (const tool of session.enabledTools.slice(0, 10)) {
        lines.push(`║ • ${tool.padEnd(63)} ║`);
      }
      if (session.enabledTools.length > 10) {
        lines.push(`║ ... and ${session.enabledTools.length - 10} more`.padEnd(67) + '║');
      }
    }

    lines.push('╚══════════════════════════════════════════════════════════════════╝');

    return lines.join('\n');
  },
};
