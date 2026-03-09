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
 * Checkpoint Restore Tool
 *
 * Retrieves a named checkpoint for the current project.
 *
 * @module tools/memory/checkpoint-restore
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { Logger } from '../../utils/logger.js';
import { executeWithGuard } from '../tool-shared.js';
import { type Checkpoint, CHECKPOINT_PREFIX, getRedis, getProjectId } from './shared.js';
import { isSilent } from '../../config/silent.js';

const schema = z.object({
  name: z.string().min(1).describe('Checkpoint name'),
});

type CheckpointRestoreArgs = z.infer<typeof schema>;

export const checkpointRestoreTool: UnifiedTool = {
  name: 'checkpoint-restore',
  description:
    'Restore a previously saved checkpoint to roll back file state. ' +
    'Use when: a risky operation failed and you need to return to a known-good state.',
  zodSchema: schema,
  metadata: {
    category: 'memory',
    tags: ['checkpoint', 'restore'],
    examples: [
      { args: { name: 'before-refactor' }, description: 'Restore a named checkpoint' },
    ],
    relatedTools: ['checkpoint-save', 'checkpoint-diff'],
  },

  execute: async (args): Promise<string> => {
    const { name } = args as CheckpointRestoreArgs;

    return executeWithGuard('checkpoint-restore', 'checkpoint-operations', async () => {
    const projectId = getProjectId();
    const checkpointKey = `${CHECKPOINT_PREFIX}${projectId}:${name}`;
      const client = await getRedis();

      const data = await client.get(checkpointKey);
      if (!data) {
        return JSON.stringify({
          success: false,
          error: `Checkpoint '${name}' not found`,
          code: 'CHECKPOINT_NOT_FOUND',
          name,
          projectId,
        });
      }

      const checkpoint = JSON.parse(data) as Checkpoint;
      const ttl = await client.ttl(checkpointKey);

      Logger.debug(`checkpoint-restore: retrieved '${name}' for project ${projectId}`);

      if (isSilent()) {
        return checkpoint.content;
      }

      return JSON.stringify({
        success: true,
        name: checkpoint.name,
        projectId: checkpoint.projectId,
        content: checkpoint.content,
        contentLength: checkpoint.content.length,
        tags: checkpoint.tags,
        createdAt: checkpoint.createdAt,
        updatedAt: checkpoint.updatedAt,
        ttlSeconds: ttl > 0 ? ttl : null,
        ttlDays: ttl > 0 ? Math.round(ttl / 86400) : null,
      });
    }, { maxRequests: 200, windowMs: 60000 });
  },
};
