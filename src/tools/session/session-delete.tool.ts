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

const deleteItemSchema = z.object({
  sessionId: z.string().describe('Session ID to delete'),
  clearContext: z.boolean().default(false).describe('Clear context data too'),
});

const schema = z.object({
  sessions: z.array(deleteItemSchema).min(1).max(10).describe('Sessions to delete (1-10)'),
  force: z.boolean().default(false).describe('Skip confirmation'),
});

export const sessionDeleteTool: UnifiedTool<typeof schema> = {
  name: 'session-delete',
  description: 'Delete 1-10 sessions and optionally their context data.',
  zodSchema: schema,
  skipContextShare: true,

  metadata: {
    category: 'session',
    tags: ['session', 'delete', 'cleanup'],
    examples: [
      { args: { sessions: [{ sessionId: 'old-session-1', clearContext: true }] }, description: 'Delete a session and clear its context data' },
      { args: { sessions: [{ sessionId: 'session-a' }, { sessionId: 'session-b' }], force: true }, description: 'Force delete multiple sessions' },
    ],
    relatedTools: ['session-list', 'session-create'],
  },

  execute: async (args) => {
    const { sessions } = args;
    const manager = getSessionManager();

    const results = await Promise.all(
      sessions.map(async (item) => {
        try {
          const session = await manager.getSession(item.sessionId);
          if (!session) {
            return { sessionId: item.sessionId, success: false, error: 'Session not found' };
          }

          const currentId = getCurrentSessionId();
          const isCurrent = currentId === item.sessionId;

          let contextCleared = false;
          if (item.clearContext) {
            const storage = getContextStorage();
            if (storage.isConnected()) {
              await storage.clearSession(item.sessionId);
              contextCleared = true;
            }
          }

          const deleted = await manager.deleteSession(item.sessionId);
          if (!deleted) {
            return { sessionId: item.sessionId, success: false, error: 'Failed to delete' };
          }

          if (isCurrent) {
            clearCurrentSession();
          }

          return {
            sessionId: item.sessionId,
            model: session.model || 'N/A',
            success: true,
            wasCurrent: isCurrent,
            contextCleared: item.clearContext ? contextCleared : undefined,
          };
        } catch (error) {
          return {
            sessionId: item.sessionId,
            success: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      })
    );

    const successful = results.filter((r) => r.success);
    const failed = results.filter((r) => !r.success);

    return JSON.stringify({
      success: failed.length === 0,
      deleted: successful.length,
      failed: failed.length,
      results,
    });
  },
};
