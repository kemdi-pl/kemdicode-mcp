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
 * Checkpoint Diff Tool
 *
 * Compares current file state with a saved checkpoint.
 * Shows which files have been modified, deleted, or added
 * since the checkpoint was created.
 *
 * @module tools/memory/checkpoint-diff
 */

import { z } from 'zod';
import { readFile, access } from 'fs/promises';
import { UnifiedTool } from '../registry.js';
import { Logger } from '../../utils/logger.js';
import { checkRateLimit } from '../../utils/validation.js';
import { type Checkpoint, CHECKPOINT_PREFIX, getRedis, getProjectId } from './shared.js';
import { isSilent } from '../../config/silent.js';

const schema = z.object({
  checkpointId: z.string().min(1).describe('Checkpoint ID to compare against'),
  files: z
    .array(z.string())
    .optional()
    .describe('Specific files to diff (default: all files in checkpoint)'),
});

type CheckpointDiffArgs = z.infer<typeof schema>;

interface FileDiffEntry {
  path: string;
  status: 'modified' | 'deleted' | 'new' | 'unchanged';
  checkpointLines?: number;
  currentLines?: number;
  lineDelta?: number;
}

/**
 * Count the number of lines in a string.
 */
function countLines(content: string): number {
  if (content.length === 0) return 0;
  return content.split('\n').length;
}

/**
 * Try to read a file from disk, returning null if it does not exist.
 */
async function readFileOrNull(filePath: string): Promise<string | null> {
  try {
    await access(filePath);
    return await readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Parse checkpoint content to extract file entries.
 *
 * Checkpoint content is stored as a single string. It may contain
 * structured file data (JSON with a "files" map) or plain text.
 */
function parseCheckpointFiles(content: string): Map<string, string> {
  const files = new Map<string, string>();

  // Try parsing as JSON with a files map
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
    // Not JSON, treat as single-content checkpoint
  }

  // If not a structured file map, store the entire content under a generic key
  // This allows diffing even for non-file-based checkpoints
  if (content.length > 0) {
    files.set('__checkpoint_content__', content);
  }

  return files;
}

export const checkpointDiffTool: UnifiedTool = {
  name: 'checkpoint-diff',
  description: 'Compare current file state with a saved checkpoint to see what changed',
  zodSchema: schema,
  metadata: {
    category: 'memory',
    tags: ['checkpoint', 'diff', 'compare'],
    examples: [
      { args: { checkpointId: 'before-refactor' }, description: 'Compare all files against a saved checkpoint' },
      { args: { checkpointId: 'v1-release', files: ['src/index.ts', 'src/server.ts'] }, description: 'Diff specific files against checkpoint' },
    ],
    relatedTools: ['checkpoint-save', 'checkpoint-restore'],
  },

  execute: async (args): Promise<string> => {
    const { checkpointId, files: requestedFiles } = args as CheckpointDiffArgs;

    if (!checkRateLimit('checkpoint-operations', { maxRequests: 200, windowMs: 60000 })) {
      return JSON.stringify({
        success: false,
        error: 'Rate limit exceeded for checkpoint operations',
        code: 'RATE_LIMIT_EXCEEDED',
      });
    }

    const projectId = getProjectId();
    const checkpointKey = `${CHECKPOINT_PREFIX}${projectId}:${checkpointId}`;

    try {
      const client = await getRedis();

      // Load checkpoint data
      const data = await client.get(checkpointKey);
      if (!data) {
        return JSON.stringify({
          success: false,
          error: `Checkpoint '${checkpointId}' not found`,
          code: 'CHECKPOINT_NOT_FOUND',
          checkpointId,
          projectId,
        });
      }

      const checkpoint = JSON.parse(data) as Checkpoint;
      const checkpointFiles = parseCheckpointFiles(checkpoint.content);

      // If checkpoint content is not file-based, report that
      if (checkpointFiles.has('__checkpoint_content__') && checkpointFiles.size === 1) {
        return JSON.stringify({
          success: true,
          checkpointId,
          projectId,
          note: 'Checkpoint contains plain text content, not file snapshots. File-based diff not available.',
          contentLength: checkpoint.content.length,
          tags: checkpoint.tags,
          createdAt: checkpoint.createdAt,
          updatedAt: checkpoint.updatedAt,
        });
      }

      const diffEntries: FileDiffEntry[] = [];

      // Determine which files to compare
      const filesToCheck = new Set<string>();

      // Add all files from checkpoint
      for (const path of checkpointFiles.keys()) {
        if (path !== '__checkpoint_content__') {
          filesToCheck.add(path);
        }
      }

      // Add requested files that may be new
      if (requestedFiles) {
        for (const f of requestedFiles) {
          filesToCheck.add(f);
        }
      }

      // Compare each file
      for (const filePath of filesToCheck) {
        const checkpointContent = checkpointFiles.get(filePath) ?? null;
        const currentContent = await readFileOrNull(filePath);

        const checkpointLineCount = checkpointContent !== null ? countLines(checkpointContent) : undefined;
        const currentLineCount = currentContent !== null ? countLines(currentContent) : undefined;

        if (checkpointContent !== null && currentContent !== null) {
          // Both exist - check if modified
          if (checkpointContent === currentContent) {
            diffEntries.push({
              path: filePath,
              status: 'unchanged',
              checkpointLines: checkpointLineCount,
              currentLines: currentLineCount,
              lineDelta: 0,
            });
          } else {
            diffEntries.push({
              path: filePath,
              status: 'modified',
              checkpointLines: checkpointLineCount,
              currentLines: currentLineCount,
              lineDelta: (currentLineCount ?? 0) - (checkpointLineCount ?? 0),
            });
          }
        } else if (checkpointContent !== null && currentContent === null) {
          // In checkpoint but not on disk
          diffEntries.push({
            path: filePath,
            status: 'deleted',
            checkpointLines: checkpointLineCount,
          });
        } else if (checkpointContent === null && currentContent !== null) {
          // Not in checkpoint but exists on disk (new file)
          diffEntries.push({
            path: filePath,
            status: 'new',
            currentLines: currentLineCount,
          });
        }
      }

      // Build summary counts
      const modified = diffEntries.filter((e) => e.status === 'modified').length;
      const deleted = diffEntries.filter((e) => e.status === 'deleted').length;
      const newFiles = diffEntries.filter((e) => e.status === 'new').length;
      const unchanged = diffEntries.filter((e) => e.status === 'unchanged').length;

      Logger.debug(
        `checkpoint-diff: compared ${diffEntries.length} files for checkpoint '${checkpointId}'`
      );

      if (isSilent()) {
        return JSON.stringify({ modified, deleted, new: newFiles, files: diffEntries.filter((e) => e.status !== 'unchanged') });
      }

      return JSON.stringify({
        success: true,
        checkpointId,
        projectId,
        summary: {
          totalFiles: diffEntries.length,
          modified,
          deleted,
          new: newFiles,
          unchanged,
        },
        files: diffEntries,
        checkpointCreatedAt: checkpoint.createdAt,
        checkpointUpdatedAt: checkpoint.updatedAt,
        checkpointTags: checkpoint.tags,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      Logger.error(`checkpoint-diff error: ${errorMessage}`);

      return JSON.stringify({
        success: false,
        error: errorMessage,
        code: 'DIFF_ERROR',
      });
    }
  },
};
