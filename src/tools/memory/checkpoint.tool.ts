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
 * Unified Checkpoint Tool
 *
 * Consolidates checkpoint-save, checkpoint-restore, and checkpoint-diff
 * into a single action-based tool.
 *
 * @module tools/memory/checkpoint
 */

import { z } from 'zod';
import { readFile, access } from 'fs/promises';
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
  action: z.enum(['save', 'restore', 'diff']).describe(
    'Action: save (snapshot state), restore (retrieve checkpoint), diff (compare with current files)'
  ),

  // Common
  name: z
    .string()
    .min(1)
    .max(100)
    .describe('Checkpoint name'),

  // save params
  content: z.string().min(1).optional().describe('Content to save (action=save)'),
  tags: z.array(z.string()).optional().default([]).describe('Tags for categorization (action=save)'),
  overwrite: z.boolean().optional().default(true).describe('Overwrite if exists (action=save)'),
  ttlDays: z.number().min(1).max(365).optional().default(7).describe('Time-to-live in days (action=save)'),

  // diff params
  files: z.array(z.string()).optional().describe('Specific files to diff (action=diff, default: all files in checkpoint)'),
});

type CheckpointArgs = z.infer<typeof schema>;

// ─── Helpers ────────────────────────────────────────────────────────────────

interface FileDiffEntry {
  path: string;
  status: 'modified' | 'deleted' | 'new' | 'unchanged';
  checkpointLines?: number;
  currentLines?: number;
  lineDelta?: number;
}

function countLines(content: string): number {
  if (content.length === 0) return 0;
  return content.split('\n').length;
}

async function readFileOrNull(filePath: string): Promise<string | null> {
  try {
    await access(filePath);
    return await readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

function parseCheckpointFiles(content: string): Map<string, string> {
  const files = new Map<string, string>();

  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (parsed.files && typeof parsed.files === 'object' && parsed.files !== null) {
      const fileMap = parsed.files as Record<string, string>;
      for (const [path, fileContent] of Object.entries(fileMap)) {
        if (typeof fileContent === 'string') {
          files.set(path, fileContent);
        }
      }
      return files;
    }
  } catch {
    // Not JSON
  }

  if (content.length > 0) {
    files.set('__checkpoint_content__', content);
  }

  return files;
}

// ─── Action handlers ────────────────────────────────────────────────────────

async function handleSave(args: CheckpointArgs): Promise<string> {
  const { name, content, tags = [], overwrite = true, ttlDays = 7 } = args;

  if (!content) {
    return JSON.stringify({ success: false, error: 'content is required for action=save' });
  }

  if (content.length > MAX_CONTENT_SIZE) {
    return JSON.stringify({ success: false, error: `Content too large: ${content.length} bytes (max: ${MAX_CONTENT_SIZE} bytes)`, code: 'CONTENT_TOO_LARGE' });
  }

  const projectId = getProjectId();
  const checkpointKey = `${CHECKPOINT_PREFIX}${projectId}:${name}`;
  const indexKey = `${CHECKPOINT_INDEX_PREFIX}${projectId}`;
  const client = await getRedis();

  const existing = await client.exists(checkpointKey);
  if (existing && !overwrite) {
    return JSON.stringify({ success: false, error: `Checkpoint '${name}' already exists. Use overwrite: true to replace.`, code: 'CHECKPOINT_EXISTS', name, projectId });
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

  Logger.debug(`checkpoint/save: stored '${name}' for project ${projectId}`);

  if (isSilent()) {
    return JSON.stringify({ name, contentLength: content.length });
  }

  return JSON.stringify({
    success: true, name, projectId, contentLength: content.length, tags, ttlDays,
    overwritten: existing > 0, createdAt: checkpoint.createdAt, updatedAt: checkpoint.updatedAt,
  });
}

async function handleRestore(args: CheckpointArgs): Promise<string> {
  const { name } = args;
  const projectId = getProjectId();
  const checkpointKey = `${CHECKPOINT_PREFIX}${projectId}:${name}`;
  const client = await getRedis();

  const data = await client.get(checkpointKey);
  if (!data) {
    return JSON.stringify({ success: false, error: `Checkpoint '${name}' not found`, code: 'CHECKPOINT_NOT_FOUND', name, projectId });
  }

  const checkpoint = JSON.parse(data) as Checkpoint;
  const ttl = await client.ttl(checkpointKey);

  Logger.debug(`checkpoint/restore: retrieved '${name}' for project ${projectId}`);

  if (isSilent()) {
    return checkpoint.content;
  }

  return JSON.stringify({
    success: true, name: checkpoint.name, projectId: checkpoint.projectId, content: checkpoint.content,
    contentLength: checkpoint.content.length, tags: checkpoint.tags, createdAt: checkpoint.createdAt,
    updatedAt: checkpoint.updatedAt, ttlSeconds: ttl > 0 ? ttl : null, ttlDays: ttl > 0 ? Math.round(ttl / 86400) : null,
  });
}

async function handleDiff(args: CheckpointArgs): Promise<string> {
  const { name: checkpointId, files: requestedFiles } = args;
  const projectId = getProjectId();
  const checkpointKey = `${CHECKPOINT_PREFIX}${projectId}:${checkpointId}`;
  const client = await getRedis();

  const data = await client.get(checkpointKey);
  if (!data) {
    return JSON.stringify({ success: false, error: `Checkpoint '${checkpointId}' not found`, code: 'CHECKPOINT_NOT_FOUND', checkpointId, projectId });
  }

  const checkpoint = JSON.parse(data) as Checkpoint;
  const checkpointFiles = parseCheckpointFiles(checkpoint.content);

  if (checkpointFiles.has('__checkpoint_content__') && checkpointFiles.size === 1) {
    return JSON.stringify({
      success: true, checkpointId, projectId,
      note: 'Checkpoint contains plain text content, not file snapshots. File-based diff not available.',
      contentLength: checkpoint.content.length, tags: checkpoint.tags,
      createdAt: checkpoint.createdAt, updatedAt: checkpoint.updatedAt,
    });
  }

  const diffEntries: FileDiffEntry[] = [];
  const filesToCheck = new Set<string>();

  for (const path of checkpointFiles.keys()) {
    if (path !== '__checkpoint_content__') filesToCheck.add(path);
  }
  if (requestedFiles) {
    for (const f of requestedFiles) filesToCheck.add(f);
  }

  for (const filePath of filesToCheck) {
    const checkpointContent = checkpointFiles.get(filePath) ?? null;
    const currentContent = await readFileOrNull(filePath);

    const checkpointLineCount = checkpointContent !== null ? countLines(checkpointContent) : undefined;
    const currentLineCount = currentContent !== null ? countLines(currentContent) : undefined;

    if (checkpointContent !== null && currentContent !== null) {
      if (checkpointContent === currentContent) {
        diffEntries.push({ path: filePath, status: 'unchanged', checkpointLines: checkpointLineCount, currentLines: currentLineCount, lineDelta: 0 });
      } else {
        diffEntries.push({ path: filePath, status: 'modified', checkpointLines: checkpointLineCount, currentLines: currentLineCount, lineDelta: (currentLineCount ?? 0) - (checkpointLineCount ?? 0) });
      }
    } else if (checkpointContent !== null && currentContent === null) {
      diffEntries.push({ path: filePath, status: 'deleted', checkpointLines: checkpointLineCount });
    } else if (checkpointContent === null && currentContent !== null) {
      diffEntries.push({ path: filePath, status: 'new', currentLines: currentLineCount });
    }
  }

  const modified = diffEntries.filter((e) => e.status === 'modified').length;
  const deleted = diffEntries.filter((e) => e.status === 'deleted').length;
  const newFiles = diffEntries.filter((e) => e.status === 'new').length;
  const unchanged = diffEntries.filter((e) => e.status === 'unchanged').length;

  Logger.debug(`checkpoint/diff: compared ${diffEntries.length} files for checkpoint '${checkpointId}'`);

  if (isSilent()) {
    return JSON.stringify({ modified, deleted, new: newFiles, files: diffEntries.filter((e) => e.status !== 'unchanged') });
  }

  return JSON.stringify({
    success: true, checkpointId, projectId,
    summary: { totalFiles: diffEntries.length, modified, deleted, new: newFiles, unchanged },
    files: diffEntries, checkpointCreatedAt: checkpoint.createdAt,
    checkpointUpdatedAt: checkpoint.updatedAt, checkpointTags: checkpoint.tags,
  });
}

// ─── Unified Tool ───────────────────────────────────────────────────────────

export const checkpointTool: UnifiedTool = {
  name: 'checkpoint',
  description:
    'Unified checkpoint management: save, restore, or diff state snapshots. ' +
    'USE PROACTIVELY: save before risky operations (refactors, migrations, deployments) to enable rollback.',
  zodSchema: schema,
  metadata: {
    category: 'memory',
    tags: ['checkpoint', 'save', 'restore', 'diff', 'snapshot'],
    examples: [
      { args: { action: 'save', name: 'before-refactor', content: '{"files":{"src/index.ts":"..."}}', tags: ['refactor'] }, description: 'Save a checkpoint before refactoring' },
      { args: { action: 'restore', name: 'before-refactor' }, description: 'Restore a named checkpoint' },
      { args: { action: 'diff', name: 'before-refactor' }, description: 'Compare all files against a saved checkpoint' },
    ],
    relatedTools: ['memory'],
  },

  execute: async (args): Promise<string> => {
    const parsed = args as unknown as CheckpointArgs;
    const action = parsed.action;

    return executeWithGuard('checkpoint', 'checkpoint-operations', async () => {
      switch (action) {
        case 'save':
          return handleSave(parsed);
        case 'restore':
          return handleRestore(parsed);
        case 'diff':
          return handleDiff(parsed);
        default:
          return JSON.stringify({ success: false, error: `Unknown action: ${action}` });
      }
    }, { maxRequests: 200, windowMs: 60000 });
  },
};
