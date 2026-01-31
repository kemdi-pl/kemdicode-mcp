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
 * Session Create Tool
 *
 * Creates a new session with a specific model.
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { getSessionManager } from '../../session/manager.js';

const sessionItemSchema = z.object({
  model: z.string().describe('AI model ID'),
  fallbackModel: z.string().optional().describe('Fallback model'),
  cwd: z.string().optional().describe('Working directory'),
  sessionId: z.string().optional().describe('Custom session ID'),
  skipProjectDetection: z.boolean().default(false).describe('Skip project detection'),
  metadata: z.record(z.string(), z.unknown()).optional().describe('Session metadata'),
});

const schema = z.object({
  sessions: z.array(sessionItemSchema).min(1).max(10).describe('Sessions to create (1-10)'),
});

export const sessionCreateTool: UnifiedTool<typeof schema> = {
  name: 'session-create',
  description: 'Create 1-10 sessions with AI models. Returns session IDs.',
  zodSchema: schema,
  skipContextShare: true,

  metadata: {
    category: 'session',
    tags: ['session', 'create'],
    examples: [
      { args: { sessions: [{ model: 'gpt-4o', cwd: '/opt/my-project' }] }, description: 'Create a single session with GPT-4o' },
      { args: { sessions: [{ model: 'claude-sonnet-4-20250514', sessionId: 'backend-dev' }, { model: 'gpt-4o', sessionId: 'frontend-dev' }] }, description: 'Create two sessions with different models' },
    ],
    relatedTools: ['session-list', 'session-info', 'session-switch'],
  },

  execute: async (args) => {
    const { sessions } = args;
    const manager = getSessionManager();

    const results = await Promise.all(
      sessions.map(async (item) => {
        try {
          const session = await manager.createSession({
            model: item.model,
            fallbackModel: item.fallbackModel,
            cwd: item.cwd,
            sessionId: item.sessionId,
            skipProjectDetection: item.skipProjectDetection,
            metadata: item.metadata,
          });

          return {
            sessionId: session.sessionId,
            model: session.model,
            fallbackModel: session.fallbackModel,
            cwd: session.cwd,
            projectType: session.projectType || 'unknown',
            projectName: session.projectName,
            success: true,
          };
        } catch (error) {
          return {
            model: item.model,
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
      created: successful.length,
      failed: failed.length,
      sessions: results,
      sessionIds: successful.map((r) => r.sessionId),
    });
  },
};
