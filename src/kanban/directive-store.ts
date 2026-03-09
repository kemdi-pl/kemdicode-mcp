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
 * Directive Store
 *
 * Redis-backed storage for obligatory AI actions (directives).
 * Directives are injected as prefixes in tool responses to ensure
 * the AI cannot miss critical actions.
 *
 * @module kanban/directive-store
 */

import { getSharedRedis } from '../infrastructure/redis/connection.js';
import { Logger } from '../utils/logger.js';
import { safeJsonParse } from '../utils/validation.js';
import {
  type Directive,
  type CreateDirectiveInput,
  type DirectivePriority,
  KANBAN_KEYS,
  DIRECTIVE_PREFIXES,
} from './types.js';

/** Default TTL: 1 hour */
const DEFAULT_TTL_SECONDS = 60 * 60;

/** Max directives per session to prevent unbounded growth */
const MAX_DIRECTIVES_PER_SESSION = 50;

/**
 * Generate unique directive ID
 */
function generateDirectiveId(): string {
  const random = Math.random().toString(36).substring(2, 10);
  return `dir_${Date.now()}_${random}`;
}

/**
 * Create a new directive
 */
export async function createDirective(input: CreateDirectiveInput): Promise<Directive> {
  const redis = await getSharedRedis();
  const now = Date.now();
  const ttl = input.ttlSeconds ?? DEFAULT_TTL_SECONDS;

  const directive: Directive = {
    id: generateDirectiveId(),
    sessionId: input.sessionId,
    priority: input.priority ?? 'normal',
    title: input.title,
    instruction: input.instruction,
    source: input.source,
    context: input.context,
    createdAt: now,
    expiresAt: now + ttl * 1000,
    delivered: false,
  };

  const key = KANBAN_KEYS.directive(directive.id);
  const listKey = KANBAN_KEYS.directives(input.sessionId);

  // Store directive data
  await redis.set(key, JSON.stringify(directive), 'EX', ttl);

  // Add to session's directive list (newest first)
  await redis.lpush(listKey, directive.id);

  // Trim to max size
  await redis.ltrim(listKey, 0, MAX_DIRECTIVES_PER_SESSION - 1);

  // Set TTL on list key
  await redis.expire(listKey, ttl + 60); // slightly longer than directive TTL

  Logger.info(`[DirectiveStore] Created directive: ${directive.id} (${directive.priority}) - ${directive.title}`);

  return directive;
}

/**
 * Get a directive by ID
 */
export async function getDirective(directiveId: string): Promise<Directive | null> {
  const redis = await getSharedRedis();
  const data = await redis.get(KANBAN_KEYS.directive(directiveId));
  return safeJsonParse<Directive | null>(data, null);
}

/**
 * List pending (undelivered) directives for a session
 * Returns directives sorted by priority (critical > high > normal), then by creation time
 */
export async function listPendingDirectives(sessionId: string): Promise<Directive[]> {
  const redis = await getSharedRedis();
  const listKey = KANBAN_KEYS.directives(sessionId);

  // Get all directive IDs
  const directiveIds = await redis.lrange(listKey, 0, -1);
  if (directiveIds.length === 0) return [];

  const now = Date.now();
  const directives: Directive[] = [];

  // Batch-fetch all directives via pipeline (eliminates N+1 sequential GETs)
  const pipeline = redis.pipeline();
  for (const id of directiveIds) {
    pipeline.get(KANBAN_KEYS.directive(id));
  }
  const results = await pipeline.exec();

  if (results) {
    for (const [err, data] of results) {
      if (err || !data || typeof data !== 'string') continue;
      const directive = safeJsonParse<Directive | null>(data, null);
      if (directive && !directive.delivered && directive.expiresAt > now) {
        directives.push(directive);
      }
    }
  }

  // Sort by priority (critical first) then by creation time (oldest first)
  const priorityOrder: Record<DirectivePriority, number> = {
    critical: 0,
    high: 1,
    normal: 2,
  };

  directives.sort((a, b) => {
    const priorityDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
    if (priorityDiff !== 0) return priorityDiff;
    return a.createdAt - b.createdAt;
  });

  return directives;
}

/**
 * Mark a directive as delivered
 */
export async function markDirectiveDelivered(
  directiveId: string,
  deliveredBy: string
): Promise<boolean> {
  const redis = await getSharedRedis();
  const directive = await getDirective(directiveId);

  if (!directive) return false;

  directive.delivered = true;
  directive.deliveredAt = Date.now();
  directive.deliveredBy = deliveredBy;

  const key = KANBAN_KEYS.directive(directiveId);
  const ttl = await redis.ttl(key);

  if (ttl > 0) {
    await redis.set(key, JSON.stringify(directive), 'EX', ttl);
  }

  Logger.debug(`[DirectiveStore] Directive ${directiveId} delivered by ${deliveredBy}`);
  return true;
}

/**
 * Delete a directive
 */
export async function deleteDirective(directiveId: string, sessionId: string): Promise<boolean> {
  const redis = await getSharedRedis();
  const key = KANBAN_KEYS.directive(directiveId);
  const listKey = KANBAN_KEYS.directives(sessionId);

  const deleted = await redis.del(key);
  await redis.lrem(listKey, 0, directiveId);

  return deleted > 0;
}

/**
 * Clean up expired directives from a session's list
 */
export async function cleanupExpiredDirectives(sessionId: string): Promise<number> {
  const redis = await getSharedRedis();
  const listKey = KANBAN_KEYS.directives(sessionId);

  const directiveIds = await redis.lrange(listKey, 0, -1);
  let cleaned = 0;

  // Batch-check existence via pipeline (eliminates N+1 sequential EXISTS calls)
  const pipeline = redis.pipeline();
  for (const id of directiveIds) {
    pipeline.exists(KANBAN_KEYS.directive(id));
  }
  const results = await pipeline.exec();

  const expiredIds: string[] = [];
  if (results) {
    for (let i = 0; i < results.length; i++) {
      const [err, exists] = results[i];
      if (!err && !exists) {
        expiredIds.push(directiveIds[i]);
      }
    }
  }

  // Batch-remove expired IDs
  for (const id of expiredIds) {
    await redis.lrem(listKey, 0, id);
    cleaned++;
  }

  if (cleaned > 0) {
    Logger.debug(`[DirectiveStore] Cleaned up ${cleaned} expired directives for session ${sessionId}`);
  }

  return cleaned;
}

/**
 * Format directives as a prefix for tool response
 * Returns empty string if no pending directives
 */
export async function formatDirectivesPrefix(
  sessionId: string,
  toolName: string
): Promise<string> {
  const directives = await listPendingDirectives(sessionId);

  if (directives.length === 0) return '';

  const lines: string[] = [
    '',
    '═'.repeat(60),
  ];

  for (const directive of directives) {
    const prefix = DIRECTIVE_PREFIXES[directive.priority];
    lines.push(prefix);
    lines.push(`📋 ${directive.title}`);
    lines.push('');
    lines.push(directive.instruction);

    if (directive.context && Object.keys(directive.context).length > 0) {
      lines.push('');
      lines.push('Context:');
      for (const [key, value] of Object.entries(directive.context)) {
        lines.push(`  • ${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
      }
    }

    lines.push('');
    lines.push(`Source: ${directive.source}`);
    lines.push('─'.repeat(60));

    // Mark as delivered
    await markDirectiveDelivered(directive.id, toolName);
  }

  lines.push('═'.repeat(60));
  lines.push('');

  return lines.join('\n');
}

/**
 * Check if there are any pending directives for a session
 */
export async function hasPendingDirectives(sessionId: string): Promise<boolean> {
  const directives = await listPendingDirectives(sessionId);
  return directives.length > 0;
}

/**
 * Create a workflow advancement directive
 * This is a helper for the workflow system
 */
export async function createWorkflowDirective(
  sessionId: string,
  workflowName: string,
  previousBoardId: string,
  previousBoardName: string,
  nextBoardId: string,
  nextBoardName: string,
  navigationTaskId?: string
): Promise<Directive> {
  const context: Record<string, unknown> = {
    previousBoardId,
    previousBoardName,
    nextBoardId,
    nextBoardName,
    workflowName,
  };

  if (navigationTaskId) {
    context.navigationTaskId = navigationTaskId;
  }

  return createDirective({
    sessionId,
    priority: 'high',
    title: `Przejdź na tablicę "${nextBoardName}"`,
    instruction: [
      `Workflow "${workflowName}" automatycznie przeszedł na następną tablicę.`,
      '',
      `✅ Ukończona tablica: "${previousBoardName}" (${previousBoardId})`,
      `➡️ Następna tablica: "${nextBoardName}" (${nextBoardId})`,
      '',
      'MUSISZ wykonać następujące kroki:',
      `1. Użyj task-list z boardId="${nextBoardId}" aby zobaczyć nowe zadania`,
      '2. Rozpocznij pracę nad zadaniami z nowej tablicy',
      '3. Pamiętaj: poprzednia tablica jest zamknięta - wszystkie zadania wykonane',
    ].join('\n'),
    source: `workflow:${workflowName}`,
    context,
    ttlSeconds: 2 * 60 * 60, // 2 hours for workflow directives
  });
}
