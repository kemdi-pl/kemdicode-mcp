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
 * Kanban Event Handlers
 *
 * Reactive handlers for kanban events:
 * - Critical task alerts
 * - Completion metrics logging
 * - Auto board workflow advancement
 *
 * @module events/handlers/kanban-handlers
 */

import { getGlobalEventBus } from '../global-bus.js';
import { Logger } from '../../utils/logger.js';
import { checkAndAdvanceWorkflow } from '../../kanban/workflow-store.js';

export function initKanbanHandlers(): void {
  const bus = getGlobalEventBus();

  // Log warning for critical priority tasks
  bus.on('kanban:task:created', (event) => {
    const { priority, title } = event.payload as { priority?: string; title?: string };
    if (priority === 'critical') {
      Logger.warn(`[KanbanHandler] Critical task created: ${title || 'untitled'}`);
    }
  }, { permanent: true });

  // Log completion metrics + check workflow advancement
  bus.on('kanban:task:completed', async (event) => {
    const { actualMinutes, boardId } = event.payload as {
      actualMinutes?: number;
      boardId?: string;
    };
    const taskId = (event.payload as Record<string, unknown>).taskId as string;

    Logger.info(
      `[KanbanHandler] Task ${taskId || 'unknown'} completed` +
        (actualMinutes ? ` in ${actualMinutes} minutes` : ''),
    );

    // Check if this board has an active workflow and if we should advance
    if (boardId && event.sessionId) {
      try {
        const result = await checkAndAdvanceWorkflow(
          boardId,
          event.sessionId,
          event.agentId || 'system'
        );

        if (result.advanced && result.nextBoardId) {
          Logger.info(
            `[KanbanHandler] AUTO-WORKFLOW: All tasks on board ${boardId} done! ` +
            `Advanced to board ${result.nextBoardId}` +
            (result.navigationTaskId ? ` (navigation task: ${result.navigationTaskId})` : '')
          );

          // Emit workflow advancement event for other handlers/UI
          bus.emit(
            'kanban:workflow:advanced',
            {
              workflowId: result.workflow?.id,
              previousBoardId: boardId,
              nextBoardId: result.nextBoardId,
              navigationTaskId: result.navigationTaskId,
            },
            {
              sessionId: event.sessionId,
              agentId: 'system:workflow',
              sourceModule: 'kanban-handlers',
            }
          );
        }
      } catch (err) {
        Logger.error(`[KanbanHandler] Error checking workflow advancement:`, err);
      }
    }
  }, { permanent: true });
}
