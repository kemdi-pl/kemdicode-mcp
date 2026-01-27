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
 * Session Delete Tool
 *
 * Deletes a session and optionally its associated context.
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { getSessionManager } from '../../session/manager.js';
import { getContextStorage } from '../../context/storage.js';
import { getCurrentSessionId, clearCurrentSession } from '../../context/integration.js';

const schema = z.object({
  sessionId: z.string().describe('Session ID to delete'),
  clearContext: z.boolean().default(false).describe('Also clear all context data for this session'),
  force: z.boolean().default(false).describe('Skip confirmation (required if session has agents)'),
});

export const sessionDeleteTool: UnifiedTool<typeof schema> = {
  name: 'session-delete',
  description:
    'Delete a session. Use with caution - this removes session configuration and optionally all context data.',
  zodSchema: schema,
  skipContextShare: true,

  execute: async (args) => {
    const { sessionId, clearContext } = args;
    const manager = getSessionManager();

    // Check if session exists
    const session = await manager.getSession(sessionId);

    if (!session) {
      return `❌ Session not found: ${sessionId}`;
    }

    // Check if this is current session
    const currentId = getCurrentSessionId();
    const isCurrent = currentId === sessionId;

    let contextCleared = false;

    // Clear context if requested
    if (clearContext) {
      const storage = getContextStorage();
      if (storage.isConnected()) {
        // Delete all context entries for this session
        await storage.clearSession(sessionId);
        contextCleared = true;
      }
    }

    // Delete the session
    const deleted = await manager.deleteSession(sessionId);

    if (!deleted) {
      return `❌ Failed to delete session: ${sessionId}`;
    }

    // If this was current session, clear it
    if (isCurrent) {
      clearCurrentSession();
    }

    const lines: string[] = [
      '╔══════════════════════════════════════════════════════════════════╗',
      '║ 🗑️  SESSION DELETED                                             ║',
      '╠══════════════════════════════════════════════════════════════════╣',
      `║ 🆔 ID:        ${sessionId.padEnd(54)} ║`,
      `║ 🤖 Model:     ${(session.model || 'N/A').padEnd(54)} ║`,
    ];

    if (isCurrent) {
      lines.push('║ ⚠️  This was the current session - context reset.'.padEnd(67) + '║');
    }

    if (clearContext) {
      lines.push(
        `║ 🧹 Context:   ${contextCleared ? 'Cleared' : 'Failed to clear'}`.padEnd(67) + '║'
      );
    }

    lines.push(
      '╠──────────────────────────────────────────────────────────────────╣',
      '║ Remaining sessions:'.padEnd(67) + '║'
    );

    const remaining = await manager.listSessions({ limit: 5 });
    if (remaining.length > 0) {
      for (const s of remaining) {
        lines.push(`║   • ${s.sessionId} (${s.model || 'no model'})`.slice(0, 67).padEnd(67) + '║');
      }
    } else {
      lines.push('║   (none)'.padEnd(67) + '║');
    }

    lines.push('╚══════════════════════════════════════════════════════════════════╝');

    return lines.join('\n');
  },
};
