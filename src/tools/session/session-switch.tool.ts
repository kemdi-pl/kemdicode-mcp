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
 * Session Switch Tool
 *
 * Switches to a different session or updates current session model.
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { getSessionManager } from '../../session/manager.js';
import { setCurrentSession, getCurrentSessionId } from '../../context/integration.js';
import { isSilent } from '../../config/silent.js';

const schema = z.object({
  sessionId: z.string().describe('Target session ID'),
  updateModel: z.string().optional().describe('New model for session'),
  updateFallback: z.string().optional().describe('New fallback model'),
});

export const sessionSwitchTool: UnifiedTool<typeof schema> = {
  name: 'session-switch',
  description: 'Switch session or update session model',
  zodSchema: schema,
  skipContextShare: true,

  metadata: {
    category: 'session',
    tags: ['session', 'switch', 'activate'],
    examples: [
      { args: { sessionId: 'backend-dev' }, description: 'Switch to an existing session' },
      { args: { sessionId: 'session-1', updateModel: 'gpt-4o' }, description: 'Switch session and update its model' },
    ],
    relatedTools: ['session-list', 'session-info'],
  },

  execute: async (args) => {
    const { sessionId, updateModel, updateFallback } = args;
    const manager = getSessionManager();

    // Check if session exists
    let session = await manager.getSession(sessionId);

    if (!session) {
      return `❌ Session not found: ${sessionId}\n\nUse \`session-list\` to see available sessions or \`session-create\` to create a new one.`;
    }

    const previousId = getCurrentSessionId();

    // Update session if model changes requested
    if (updateModel || updateFallback) {
      const updates: { model?: string; fallbackModel?: string } = {};
      if (updateModel) updates.model = updateModel;
      if (updateFallback) updates.fallbackModel = updateFallback;

      const updated = await manager.updateSession(sessionId, updates);
      if (updated) {
        session = updated;
      }
    }

    // Set as current session
    setCurrentSession(sessionId);

    if (isSilent()) {
      return JSON.stringify({ sessionId, model: session.model });
    }

    const lines: string[] = [
      '╔══════════════════════════════════════════════════════════════════╗',
      '║ 🔄 SESSION SWITCHED                                             ║',
      '╠══════════════════════════════════════════════════════════════════╣',
    ];

    if (previousId && previousId !== sessionId) {
      lines.push(`║ Previous:    ${previousId.padEnd(54)} ║`);
    }

    lines.push(
      `║ Current:     ${sessionId.padEnd(54)} ║`,
      `║ 🤖 Model:    ${(session.model || 'Not set').padEnd(54)} ║`
    );

    if (session.fallbackModel) {
      lines.push(`║ 🔄 Fallback: ${session.fallbackModel.padEnd(54)} ║`);
    }

    lines.push(
      `║ 📁 CWD:      ${session.cwd.slice(-54).padStart(54)} ║`,
      '╠──────────────────────────────────────────────────────────────────╣',
      '║ All subsequent tool calls will use this session context.'.padEnd(67) + '║',
      '╚══════════════════════════════════════════════════════════════════╝'
    );

    return lines.join('\n');
  },
};
