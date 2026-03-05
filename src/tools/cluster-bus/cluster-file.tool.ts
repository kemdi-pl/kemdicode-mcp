/**
 * KemdiCode MCP Server - Cluster File Read Tool
 * Copyright (C) 2025-2026 Kemdi Sp. z o.o. (Dawid Irzyk <dawid@kemdi.pl>)
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { promises as fs } from 'fs';
import { validatePathSafe } from '../../utils/validation.js';
import type { UnifiedTool } from '../registry.js';
import type { ClusterSubscription } from '../../cluster-bus/types.js';
import { isClusterBusActive, getClusterBus } from '../../cluster-bus/index.js';
import { Logger } from '../../utils/logger.js';

const schema = z.object({
  paths: z.array(z.string()).min(1).describe('File paths to read'),
  encoding: z.enum(['utf-8', 'base64']).default('utf-8').describe('File encoding'),
  maxLines: z.number().min(1).max(10000).optional().describe('Maximum lines per file'),
  timeoutMs: z.number().min(1000).max(60000).default(10000).describe('Timeout for file read in ms'),
  fallbackToLocal: z
    .boolean()
    .default(true)
    .describe('Fallback to local file reading if cluster nodes do not respond'),
});

type Args = z.infer<typeof schema>;

/**
 * Read file locally as fallback when cluster nodes don't respond
 */
async function readLocalFile(
  path: string,
  encoding: 'utf-8' | 'base64',
  maxLines?: number
): Promise<{ content: string; error?: string }> {
  try {
    const pathResult = await validatePathSafe(
      path,
      {
        allowSymlinks: false,
        requireWithinProject: false,
        allowReadFromBlocked: true,
        operation: 'read',
      },
      'cluster-bus-file-read'
    );

    if (!pathResult.ok) {
      return { content: '', error: pathResult.error };
    }

    let content = await fs.readFile(pathResult.path, {
      encoding: encoding === 'utf-8' ? 'utf8' : 'base64',
    });

    if (maxLines && content.includes('\n')) {
      const lines = content.split('\n');
      content = lines.slice(0, maxLines).join('\n');
    }

    return { content };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: '', error: message };
  }
}

export const clusterFileReadTool: UnifiedTool<typeof schema> = {
  name: 'cluster-bus-file-read',
  description:
    'Read files across cluster nodes via Cluster Bus. Enables AI to read files from remote cluster nodes. Falls back to local file reading if no cluster nodes respond.',
  zodSchema: schema,
  execute: async (args: Args): Promise<string> => {
    const { paths, encoding, maxLines, timeoutMs, fallbackToLocal } = args;

    const clusterAvailable = isClusterBusActive();

    if (!clusterAvailable || !fallbackToLocal) {
      const results: Record<string, { content: string; error?: string; source: string }> = {};

      for (const path of paths) {
        const result = await readLocalFile(path, encoding, maxLines);
        results[path] = { ...result, source: 'local' };
      }

      const fileList = Object.entries(results)
        .map(
          ([path, data]) =>
            `## ${path} (${data.source})\n${data.error ? `Error: ${data.error}` : data.content}`
        )
        .join('\n\n');

      return fileList || 'No files found';
    }

    const bus = getClusterBus();
    if (!bus || !bus.isConnected) {
      Logger.info(`[ClusterFileRead] Cluster bus not connected, reading files locally`);
      const results: Record<string, { content: string; error?: string; source: string }> = {};
      for (const path of paths) {
        const result = await readLocalFile(path, encoding, maxLines);
        results[path] = { ...result, source: 'local' };
      }

      const fileList = Object.entries(results)
        .map(
          ([path, data]) =>
            `## ${path} (${data.source})\n${data.error ? `Error: ${data.error}` : data.content}`
        )
        .join('\n\n');
      return fileList || 'No files found';
    }

    const requestId = uuidv4();
    let clusterResponded = false;

    return new Promise((resolve) => {
      let subscription: ClusterSubscription | undefined;
      // eslint-disable-next-line prefer-const
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      let resolved = false;

      const cleanup = () => {
        if (resolved) return;
        resolved = true;
        if (subscription) subscription.unsubscribe();
        if (timeoutHandle) clearTimeout(timeoutHandle);
      };

      const resolveWithFallback = () => {
        if (resolved) return;

        if (!clusterResponded && fallbackToLocal) {
          Logger.info(`[ClusterFileRead] No cluster response, falling back to local files`);

          Promise.all(
            paths.map(async (path) => {
              const result = await readLocalFile(path, encoding, maxLines);
              return [path, { ...result, source: 'local' }] as [
                string,
                { content: string; error?: string; source: string },
              ];
            })
          ).then((entries) => {
            const results = Object.fromEntries(entries);
            const fileList = Object.entries(results)
              .map(
                ([path, data]) =>
                  `## ${path} (${data.source})\n${data.error ? `Error: ${data.error}` : data.content}`
              )
              .join('\n\n');
            cleanup();
            resolve(fileList || 'No files found');
          });
        } else {
          cleanup();
          resolve(
            `Timeout after ${timeoutMs}ms - no response from cluster nodes (fallback disabled)`
          );
        }
      };

      timeoutHandle = setTimeout(() => {
        resolveWithFallback();
      }, timeoutMs);

      try {
        subscription = bus.onSignal(
          'file:read-result',
          (signal) => {
            if (signal.correlationId !== requestId) return;

            const result = signal.payload as {
              requestId: string;
              files: Record<string, { content: string; error?: string }>;
            };
            if (result.requestId === requestId) {
              clusterResponded = true;
              cleanup();
              const fileList = Object.entries(result.files)
                .map(
                  ([path, data]) =>
                    `## ${path} (cluster)\n${data.error ? `Error: ${data.error}` : data.content}`
                )
                .join('\n\n');
              resolve(fileList || 'No files found');
            }
          },
          undefined,
          { ttlMs: timeoutMs }
        );

        bus
          .broadcast(
            'file:read',
            {
              paths,
              encoding,
              maxLines,
            },
            {
              correlationId: requestId,
              priority: 2,
              direction: 'downstream',
            }
          )
          .catch((err) => {
            Logger.warn(`[ClusterFileRead] Failed to send request: ${err}`);
            resolveWithFallback();
          });
      } catch (err) {
        Logger.warn(`[ClusterFileRead] Error: ${err}`);
        resolveWithFallback();
      }
    });
  },
};
