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
 * Task Comment Tool (Batch)
 *
 * Adds 1-20 notes/comments to Kanban tasks in a single call.
 * Notes are appended without overwriting the task description.
 *
 * @module tools/kanban/task-comment
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { Logger } from '../../utils/logger.js';
import { executeWithGuard } from '../tool-shared.js';
import { addTaskNote } from '../../kanban/index.js';
import { isSilent } from '../../config/silent.js';

const commentItemSchema = z.object({
  taskId: z.string().min(1).describe('Task ID'),
  author: z.string().min(1).max(100).describe('Author name or agent ID'),
  content: z.string().min(1).max(5000).describe('Note/comment content'),
});

const batchSchema = z.object({
  comments: z.array(commentItemSchema).min(1).max(20).describe('Comments to add (1-20)'),
});

// Support shorthand: { taskId, author, content } -> { comments: [{ taskId, author, content }] }
const schema = z.preprocess((val) => {
  if (val && typeof val === 'object' && 'taskId' in val && 'content' in val && !('comments' in val)) {
    return { comments: [val] };
  }
  return val;
}, batchSchema);

type TaskCommentArgs = z.infer<typeof batchSchema>;

interface CommentResult {
  taskId: string;
  noteId?: string;
  author: string;
  success: boolean;
  error?: string;
}

export const taskCommentTool: UnifiedTool = {
  name: 'task-comment',
  description: 'Add notes/comments to Kanban tasks (batch: 1-20). Appends without overwriting the description.',
  zodSchema: schema,

  metadata: {
    category: 'kanban',
    tags: ['task', 'comment', 'note'],
    examples: [
      {
        args: { taskId: 'task-abc123', author: 'agent-1', content: 'Started investigating the issue.' },
        description: 'Add a single comment (shorthand)',
      },
      {
        args: {
          comments: [
            { taskId: 'task-abc123', author: 'agent-1', content: 'Found the root cause.' },
            { taskId: 'task-def456', author: 'agent-1', content: 'Blocked on upstream dependency.' },
          ],
        },
        description: 'Add comments to multiple tasks at once',
      },
    ],
    relatedTools: ['task-get', 'task-update', 'task-list'],
  },

  execute: async (args): Promise<string> => {
    const input = args as unknown as TaskCommentArgs;

    return executeWithGuard('task-comment', 'kanban-operations', async () => {
    const results: CommentResult[] = [];

    // Sequential to avoid race conditions when multiple comments target the same task
    for (const comment of input.comments) {
      try {
        const note = await addTaskNote(comment.taskId, {
          author: comment.author,
          content: comment.content,
        });

        Logger.debug(`task-comment: added note ${note.id} to task ${comment.taskId}`);

        results.push({
          taskId: comment.taskId,
          noteId: note.id,
          author: comment.author,
          success: true,
        });
      } catch (error) {
        results.push({
          taskId: comment.taskId,
          author: comment.author,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const successful = results.filter((r) => r.success);
    const failed = results.filter((r) => !r.success);

    // Silent mode: return note IDs only
    if (isSilent()) {
      if (failed.length > 0) {
        return JSON.stringify({ added: successful.map((r) => r.noteId), errors: failed.map((r) => r.error) });
      }
      return JSON.stringify(successful.map((r) => r.noteId));
    }

    return JSON.stringify({
      success: failed.length === 0,
      added: successful.length,
      failed: failed.length,
      results: results.map((r) => ({
        taskId: r.taskId,
        noteId: r.noteId,
        author: r.author,
        success: r.success,
        error: r.error,
      })),
    });
    });
  },
};
