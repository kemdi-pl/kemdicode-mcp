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
 * Consolidated Session Tool
 *
 * Single action-based tool replacing session-list, session-info, session-create,
 * session-switch, session-delete, and session-recover.
 */

import { z } from 'zod';
import type { UnifiedTool } from '../registry.js';
import { getSessionManager } from '../../session/manager.js';
import { getContextStorage } from '../../context/storage.js';
import { setCurrentSession, getCurrentSessionId, clearCurrentSession } from '../../context/integration.js';
import { isSilent } from '../../config/silent.js';

// Import session-recover execute logic (kept as separate file due to complexity)
import { sessionRecoverTool } from './session-recover.tool.js';

const sessionItemSchema = z.object({
  model: z.string().describe('AI model ID'),
  fallbackModel: z.string().optional().describe('Fallback model'),
  cwd: z.string().optional().describe('Working directory'),
  sessionId: z.string().optional().describe('Custom session ID'),
  skipProjectDetection: z.boolean().default(false).describe('Skip project detection'),
  metadata: z.record(z.string(), z.unknown()).optional().describe('Session metadata'),
});

const deleteItemSchema = z.object({
  sessionId: z.string().describe('Session ID to delete'),
  clearContext: z.boolean().default(false).describe('Clear context data too'),
});

const schema = z.object({
  action: z.enum(['list', 'info', 'create', 'switch', 'delete', 'recover']).describe(
    'Action: list=list sessions, info=get session details, create=create sessions, switch=switch/update session, delete=delete sessions, recover=full session recovery'
  ),

  // --- list params ---
  projectType: z.enum(['node', 'php', 'python', 'rust', 'go', 'ruby', 'java', 'dotnet', 'unknown']).optional().describe('(list) Filter by project type'),
  activeWithin: z.number().min(60000).optional().describe('(list) Filter by active within last N milliseconds (min 60s)'),
  limit: z.number().min(1).max(100).optional().describe('(list) Maximum sessions to return (default 20)'),
  includeExpired: z.boolean().optional().describe('(list) Include expired sessions'),

  // --- info / switch / recover params ---
  sessionId: z.string().optional().describe('(info/switch/recover) Session ID'),

  // --- switch params ---
  updateModel: z.string().optional().describe('(switch) New model for session'),
  updateFallback: z.string().optional().describe('(switch) New fallback model'),

  // --- create params ---
  sessions: z.array(sessionItemSchema).min(1).max(10).optional().describe('(create) Sessions to create (1-10)'),

  // --- delete params ---
  deleteSessions: z.array(deleteItemSchema).min(1).max(10).optional().describe('(delete) Sessions to delete (1-10)'),

  // --- recover params ---
  includeAmbientLearning: z.boolean().optional().describe('(recover) Include learned project patterns (default true)'),
  includeAgentRankings: z.boolean().optional().describe('(recover) Include agent performance data (default true)'),
  includeToolHealth: z.boolean().optional().describe('(recover) Include tool availability status (default true)'),
  validateConsistency: z.boolean().optional().describe('(recover) Run CTC consistency validation (default true)'),
});

export const sessionTool: UnifiedTool<typeof schema> = {
  name: 'session',
  description:
    'Manage sessions: list, info, create, switch, delete, recover. ' +
    'Use action="recover" IMMEDIATELY after context compaction or at session start to restore full working context.',
  zodSchema: schema,
  skipContextShare: true,

  metadata: {
    category: 'session',
    tags: ['session', 'list', 'info', 'create', 'switch', 'delete', 'recover'],
    examples: [
      { args: { action: 'list', limit: 10 }, description: 'List up to 10 active sessions' },
      { args: { action: 'info', sessionId: 'session-1' }, description: 'Get detailed info about a session' },
      { args: { action: 'create', sessions: [{ model: 'gpt-4.1', cwd: '/opt/my-project' }] }, description: 'Create a session with GPT-4.1' },
      { args: { action: 'switch', sessionId: 'backend-dev' }, description: 'Switch to an existing session' },
      { args: { action: 'delete', deleteSessions: [{ sessionId: 'old-session', clearContext: true }] }, description: 'Delete a session and clear its context' },
      { args: { action: 'recover' }, description: 'Full session recovery with all components' },
    ],
    relatedTools: ['smart-handoff', 'memory', 'loci-recall'],
  },

  execute: async (args, onProgress) => {
    switch (args.action) {
      case 'list':
        return executeList(args);
      case 'info':
        return executeInfo(args);
      case 'create':
        return executeCreate(args);
      case 'switch':
        return executeSwitch(args);
      case 'delete':
        return executeDelete(args);
      case 'recover':
        return executeRecover(args, onProgress);
      default:
        return `Unknown action: ${args.action}. Use: list, info, create, switch, delete, recover.`;
    }
  },
};

// ─── List ────────────────────────────────────────────────────────────────────

async function executeList(args: z.infer<typeof schema>): Promise<string> {
  const { projectType, activeWithin, includeExpired } = args;
  const limit = args.limit ?? 20;
  const manager = getSessionManager();

  const sessions = await manager.listSessions({
    projectType,
    activeWithin,
    limit,
    includeExpired: includeExpired ?? false,
  });

  if (sessions.length === 0) {
    if (isSilent()) return '[]';
    return '## Active Sessions\n\nNo active sessions found.\n\nTip: Create a session with `session` action="create".';
  }

  if (isSilent()) {
    return JSON.stringify(sessions.map((s) => ({ id: s.sessionId, model: s.model, cwd: s.cwd })));
  }

  const lines: string[] = [
    '== ACTIVE SESSIONS ==',
    '',
  ];

  for (const session of sessions) {
    const age = Math.floor((Date.now() - session.lastAccessedAt) / 1000);
    const ageText =
      age < 60 ? `${age}s` : age < 3600 ? `${Math.floor(age / 60)}m` : `${Math.floor(age / 3600)}h`;

    lines.push(`ID: ${session.sessionId}`);
    lines.push(`  Model: ${session.model || 'default'}`);
    if (session.fallbackModel) {
      lines.push(`  Fallback: ${session.fallbackModel}`);
    }
    lines.push(`  CWD: ${session.cwd}`);
    lines.push(`  Project: ${session.projectType || 'unknown'}${session.projectName ? ` (${session.projectName})` : ''}`);
    lines.push(`  Last active: ${ageText} ago`);
    lines.push('');
  }

  lines.push(`Total: ${sessions.length} session(s)`);
  return lines.join('\n');
}

// ─── Info ────────────────────────────────────────────────────────────────────

async function executeInfo(args: z.infer<typeof schema>): Promise<string> {
  const { sessionId } = args;
  if (!sessionId) return 'Error: sessionId is required for action="info"';

  const manager = getSessionManager();
  const session = await manager.getSession(sessionId);

  if (!session) {
    return `Session not found: ${sessionId}`;
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
    '== SESSION INFORMATION ==',
    '',
    `ID:        ${session.sessionId}`,
    `Model:     ${session.model || 'Not set'}`,
  ];

  if (session.fallbackModel) {
    lines.push(`Fallback:  ${session.fallbackModel}`);
  }

  lines.push(
    `CWD:       ${session.cwd}`,
    `Project:   ${session.projectType || 'unknown'}`,
  );

  if (session.projectName) {
    lines.push(`Name:      ${session.projectName}`);
  }

  lines.push(
    `Created:   ${formatTime(age)} ago`,
    `Last seen: ${formatTime(lastAccess)} ago`,
    '',
    '-- Metadata --',
  );

  if (session.metadata && Object.keys(session.metadata).length > 0) {
    for (const [key, value] of Object.entries(session.metadata)) {
      const valueStr = typeof value === 'string' ? value : JSON.stringify(value);
      lines.push(`  ${key}: ${valueStr}`);
    }
  } else {
    lines.push('  No metadata');
  }

  if (session.enabledTools && session.enabledTools.length > 0) {
    lines.push('', '-- Enabled Tools --');
    for (const tool of session.enabledTools.slice(0, 10)) {
      lines.push(`  - ${tool}`);
    }
    if (session.enabledTools.length > 10) {
      lines.push(`  ... and ${session.enabledTools.length - 10} more`);
    }
  }

  return lines.join('\n');
}

// ─── Create ──────────────────────────────────────────────────────────────────

async function executeCreate(args: z.infer<typeof schema>): Promise<string> {
  const { sessions } = args;
  if (!sessions || sessions.length === 0) return 'Error: sessions array is required for action="create"';

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

  if (isSilent()) {
    return JSON.stringify(successful.map((r) => r.sessionId));
  }

  return JSON.stringify({
    success: failed.length === 0,
    created: successful.length,
    failed: failed.length,
    sessions: results,
    sessionIds: successful.map((r) => r.sessionId),
  });
}

// ─── Switch ──────────────────────────────────────────────────────────────────

async function executeSwitch(args: z.infer<typeof schema>): Promise<string> {
  const { sessionId, updateModel, updateFallback } = args;
  if (!sessionId) return 'Error: sessionId is required for action="switch"';

  const manager = getSessionManager();

  let session = await manager.getSession(sessionId);
  if (!session) {
    return `Session not found: ${sessionId}\n\nUse \`session\` action="list" to see available sessions or action="create" to create a new one.`;
  }

  const previousId = getCurrentSessionId();

  if (updateModel || updateFallback) {
    const updates: { model?: string; fallbackModel?: string } = {};
    if (updateModel) updates.model = updateModel;
    if (updateFallback) updates.fallbackModel = updateFallback;

    const updated = await manager.updateSession(sessionId, updates);
    if (updated) {
      session = updated;
    }
  }

  setCurrentSession(sessionId);

  if (isSilent()) {
    return JSON.stringify({ sessionId, model: session.model });
  }

  const lines: string[] = [
    '== SESSION SWITCHED ==',
    '',
  ];

  if (previousId && previousId !== sessionId) {
    lines.push(`Previous:  ${previousId}`);
  }

  lines.push(
    `Current:   ${sessionId}`,
    `Model:     ${session.model || 'Not set'}`,
  );

  if (session.fallbackModel) {
    lines.push(`Fallback:  ${session.fallbackModel}`);
  }

  lines.push(
    `CWD:       ${session.cwd}`,
    '',
    'All subsequent tool calls will use this session context.',
    'Recommendation: Run `session` action="recover" to load cognition context for this session.',
  );

  return lines.join('\n');
}

// ─── Delete ──────────────────────────────────────────────────────────────────

async function executeDelete(args: z.infer<typeof schema>): Promise<string> {
  const { deleteSessions } = args;
  if (!deleteSessions || deleteSessions.length === 0) return 'Error: deleteSessions array is required for action="delete"';

  const manager = getSessionManager();

  const results = await Promise.all(
    deleteSessions.map(async (item) => {
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

  if (isSilent()) {
    return JSON.stringify({ deleted: successful.length });
  }

  return JSON.stringify({
    success: failed.length === 0,
    deleted: successful.length,
    failed: failed.length,
    results,
  });
}

// ─── Recover ─────────────────────────────────────────────────────────────────

async function executeRecover(
  args: z.infer<typeof schema>,
  onProgress?: (msg: string) => void,
): Promise<string> {
  // Delegate to the original session-recover tool's execute function
  return sessionRecoverTool.execute(
    {
      sessionId: args.sessionId,
      includeAmbientLearning: args.includeAmbientLearning ?? true,
      includeAgentRankings: args.includeAgentRankings ?? true,
      includeToolHealth: args.includeToolHealth ?? true,
      validateConsistency: args.validateConsistency ?? true,
    },
    onProgress,
  );
}
