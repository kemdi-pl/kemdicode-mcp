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

const schema = z.object({
  model: z.string().describe('AI model ID'),
  fallbackModel: z.string().optional().describe('Fallback model'),
  cwd: z.string().optional().describe('Working directory'),
  sessionId: z.string().optional().describe('Custom session ID'),
  skipProjectDetection: z.boolean().default(false).describe('Skip project detection'),
  metadata: z.record(z.string(), z.unknown()).optional().describe('Session metadata'),
});

export const sessionCreateTool: UnifiedTool<typeof schema> = {
  name: 'session-create',
  description: 'Create new session with AI model, returns session ID',
  zodSchema: schema,
  skipContextShare: true,

  execute: async (args) => {
    const { model, fallbackModel, cwd, sessionId, skipProjectDetection, metadata } = args;
    const manager = getSessionManager();

    try {
      const session = await manager.createSession({
        model,
        fallbackModel,
        cwd,
        sessionId,
        skipProjectDetection,
        metadata,
      });

      return [
        '╔══════════════════════════════════════════════════════════════════╗',
        '║ ✅ SESSION CREATED                                              ║',
        '╠══════════════════════════════════════════════════════════════════╣',
        `║ 🆔 ID:       ${session.sessionId.padEnd(54)} ║`,
        `║ 🤖 Model:    ${session.model.padEnd(54)} ║`,
        fallbackModel ? `║ 🔄 Fallback: ${session.fallbackModel!.padEnd(54)} ║` : null,
        `║ 📁 CWD:      ${session.cwd.slice(-54).padStart(54)} ║`,
        `║ 📂 Project:  ${(session.projectType || 'unknown').padEnd(54)} ║`,
        session.projectName ? `║ 📛 Name:     ${session.projectName.padEnd(54)} ║` : null,
        '╠──────────────────────────────────────────────────────────────────╣',
        '║ Use this ID in other tools:'.padEnd(67) + '║',
        `║   session-info --sessionId=${session.sessionId}`.padEnd(67) + '║',
        `║   session-switch --sessionId=${session.sessionId}`.padEnd(67) + '║',
        '╚══════════════════════════════════════════════════════════════════╝',
      ]
        .filter(Boolean)
        .join('\n');
    } catch (error) {
      return `❌ Failed to create session: ${error instanceof Error ? error.message : error}`;
    }
  },
};
