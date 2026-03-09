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
 * Checkpoint Save Tool
 *
 * Saves a named checkpoint for the current project.
 * Checkpoints are temporary state snapshots stored in Redis.
 *
 * @module tools/memory/checkpoint-save
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { Logger } from '../../utils/logger.js';
import { executeWithGuard } from '../tool-shared.js';
import {
  type Checkpoint,
  CHECKPOINT_PREFIX,
  CHECKPOINT_INDEX_PREFIX,
  DEFAULT_CHECKPOINT_TTL,
  MAX_CONTENT_SIZE,
  getRedis,
  getProjectId,
  getExistingCreatedAt,
} from './shared.js';
import { isSilent } from '../../config/silent.js';

const schema = z.object({
  name: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-zA-Z0-9_-]+$/, 'Name must be alphanumeric with dashes/underscores')
    .describe('Checkpoint name, alphanumeric with dashes/underscores'),
  content: z.string().min(1).describe('Content to save'),
  tags: z.array(z.string()).default([]).describe('Tags for categorization'),
  overwrite: z.boolean().default(true).describe('Overwrite if exists'),
  ttlDays: z.number().min(1).max(365).default(7).describe('Time-to-live in days'),
});

type CheckpointSaveArgs = z.infer<typeof schema>;

export const checkpointSaveTool: UnifiedTool = {
  name: 'checkpoint-save',
  description:
    'Save named checkpoint for current project — snapshot of file state. ' +
    'USE PROACTIVELY: save before risky operations (refactors, migrations, deployments) to enable rollback.',
  zodSchema: schema,
  metadata: {
    category: 'memory',
    tags: ['checkpoint', 'save', 'snapshot'],
    examples: [
      { args: { name: 'before-refactor', content: '{"files":{"src/index.ts":"..."}}', tags: ['refactor'] }, description: 'Save a checkpoint before refactoring' },
      { args: { name: 'deploy-v2', content: 'deployment state snapshot', tags: ['deploy'], ttlDays: 30 }, description: 'Save deployment checkpoint with 30-day TTL' },
    ],
    relatedTools: ['checkpoint-restore', 'checkpoint-diff'],
  },

  execute: async (args): Promise<string> => {
    const { name, content, tags, overwrite, ttlDays } = args as CheckpointSaveArgs;

    return executeWithGuard('checkpoint-save', 'checkpoint-operations', async () => {
    if (content.length > MAX_CONTENT_SIZE) {
      return JSON.stringify({
        success: false,
        error: `Content too large: ${content.length} bytes (max: ${MAX_CONTENT_SIZE} bytes)`,
        code: 'CONTENT_TOO_LARGE',
      });
    }

    const projectId = getProjectId();
    const checkpointKey = `${CHECKPOINT_PREFIX}${projectId}:${name}`;
    const indexKey = `${CHECKPOINT_INDEX_PREFIX}${projectId}`;
      const client = await getRedis();

      const existing = await client.exists(checkpointKey);
      if (existing && !overwrite) {
        return JSON.stringify({
          success: false,
          error: `Checkpoint '${name}' already exists. Use overwrite: true to replace.`,
          code: 'CHECKPOINT_EXISTS',
          name,
          projectId,
        });
      }

      const now = Date.now();
      const checkpoint: Checkpoint = {
        name,
        projectId,
        content,
        createdAt: existing ? ((await getExistingCreatedAt(client, checkpointKey)) ?? now) : now,
        updatedAt: now,
        tags,
      };

      const ttl = ttlDays * 24 * 60 * 60;

      await client.setex(checkpointKey, ttl, JSON.stringify(checkpoint));
      await client.sadd(indexKey, name);
      await client.expire(indexKey, DEFAULT_CHECKPOINT_TTL);

      Logger.debug(`checkpoint-save: stored '${name}' for project ${projectId}`);

      if (isSilent()) {
        return JSON.stringify({ name, contentLength: content.length });
      }

      return JSON.stringify({
        success: true,
        name,
        projectId,
        contentLength: content.length,
        tags,
        ttlDays,
        overwritten: existing > 0,
        createdAt: checkpoint.createdAt,
        updatedAt: checkpoint.updatedAt,
      });
    });
  },
};

