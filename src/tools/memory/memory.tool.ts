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
 * Unified Memory Tool
 *
 * Consolidates write-memory, read-memory, list-memories, edit-memory,
 * and delete-memory into a single action-based tool.
 *
 * @module tools/memory/memory
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { Logger } from '../../utils/logger.js';
import { executeWithGuard } from '../tool-shared.js';
import {
  type ProjectMemory,
  MEMORY_PREFIX,
  MEMORY_INDEX_PREFIX,
  DEFAULT_MEMORY_TTL,
  MAX_CONTENT_SIZE,
  getRedis,
  getProjectId,
  getExistingCreatedAt,
} from './shared.js';
import { isSilent } from '../../config/silent.js';

const memoryItemSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-zA-Z0-9_-]+$/, 'Name must be alphanumeric with dashes/underscores')
    .describe('Memory name'),
  content: z.string().min(1).describe('Content to store'),
  tags: z.array(z.string()).default([]).describe('Tags for categorization'),
  overwrite: z.boolean().default(false).describe('Overwrite if exists'),
  ttlDays: z.number().min(1).max(365).default(30).describe('TTL in days'),
});

const editItemSchema = z.object({
  name: z.string().min(1).describe('Memory name'),
  content: z.string().optional().describe('Replacement content'),
  appendContent: z.string().optional().describe('Content to append'),
  prependContent: z.string().optional().describe('Content to prepend'),
  tags: z.array(z.string()).optional().describe('Replacement tags'),
  addTags: z.array(z.string()).optional().describe('Tags to add'),
  removeTags: z.array(z.string()).optional().describe('Tags to remove'),
});

const schema = z.preprocess((input) => {
  // Shorthand: { action: "write", name, content, ... } -> { action: "write", memories: [{ name, content, ... }] }
  if (typeof input === 'object' && input !== null && 'action' in input) {
    const obj = input as Record<string, unknown>;
    if (obj.action === 'write' && 'name' in obj && !('memories' in obj)) {
      const { action, name, content, tags, overwrite, ttlDays } = obj;
      return { action, memories: [{ name, content, tags, overwrite, ttlDays }] };
    }
  }
  return input;
}, z.object({
  action: z.enum(['write', 'read', 'list', 'edit', 'delete']).describe(
    'Action: write (store memories), read (retrieve by name), list (browse all), edit (modify existing), delete (remove)'
  ),

  // write params
  memories: z.array(memoryItemSchema).min(1).max(20).optional().describe('Memories to store (action=write, 1-20)'),

  // read params
  names: z.array(z.string().min(1)).min(1).max(20).optional().describe('Memory names to retrieve or delete (action=read/delete, 1-20)'),

  // list params
  tag: z.string().optional().describe('Filter by tag (action=list)'),
  offset: z.number().int().min(0).optional().default(0).describe('Number of items to skip (action=list)'),
  limit: z.number().min(1).max(100).optional().default(50).describe('Max memories to return (action=list)'),
  includeContent: z.boolean().optional().default(false).describe('Include content in list (action=list)'),

  // edit params
  edits: z.array(editItemSchema).min(1).max(10).optional().describe('Memory edits to apply (action=edit, 1-10)'),
}));

type MemoryArgs = z.infer<typeof schema>;

/** Memory summary for listing */
interface MemorySummary {
  name: string;
  contentLength: number;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  ttlDays: number | null;
}

// ─── Action handlers ────────────────────────────────────────────────────────

async function handleWrite(args: MemoryArgs): Promise<string> {
  const memories = args.memories;
  if (!memories || memories.length === 0) {
    return JSON.stringify({ success: false, error: 'memories[] is required for action=write' });
  }

  const projectId = getProjectId();
  const indexKey = `${MEMORY_INDEX_PREFIX}${projectId}`;

  const results = await Promise.all(
    memories.map(async (item) => {
      try {
        if (item.content.length > MAX_CONTENT_SIZE) {
          return { name: item.name, success: false, error: `Content too large: ${item.content.length} bytes`, code: 'CONTENT_TOO_LARGE' };
        }

        const memoryKey = `${MEMORY_PREFIX}${projectId}:${item.name}`;
        const client = await getRedis();

        const existing = await client.exists(memoryKey);
        if (existing && !item.overwrite) {
          return { name: item.name, success: false, error: `Memory '${item.name}' already exists`, code: 'MEMORY_EXISTS' };
        }

        const now = Date.now();
        const memory: ProjectMemory = {
          name: item.name,
          projectId,
          content: item.content,
          createdAt: existing ? ((await getExistingCreatedAt(client, memoryKey)) ?? now) : now,
          updatedAt: now,
          tags: item.tags,
        };

        const ttl = item.ttlDays * 24 * 60 * 60;
        await client.setex(memoryKey, ttl, JSON.stringify(memory));
        await client.sadd(indexKey, item.name);
        await client.expire(indexKey, DEFAULT_MEMORY_TTL);

        Logger.debug(`memory/write: stored '${item.name}' for project ${projectId}`);

        return { name: item.name, success: true, contentLength: item.content.length, tags: item.tags, ttlDays: item.ttlDays, overwritten: existing > 0 };
      } catch (error) {
        return { name: item.name, success: false, error: error instanceof Error ? error.message : String(error) };
      }
    })
  );

  const successful = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);

  if (isSilent()) {
    if (failed.length > 0) {
      return JSON.stringify({ stored: successful.map((r) => r.name), errors: failed.map((r) => r.error) });
    }
    return JSON.stringify(successful.map((r) => r.name));
  }

  return JSON.stringify({ success: failed.length === 0, projectId, stored: successful.length, failed: failed.length, results });
}

async function handleRead(args: MemoryArgs): Promise<string> {
  const names = args.names;
  if (!names || names.length === 0) {
    return JSON.stringify({ success: false, error: 'names[] is required for action=read' });
  }

  const projectId = getProjectId();
  const client = await getRedis();

  const getPipeline = client.pipeline();
  const ttlPipeline = client.pipeline();
  for (const name of names) {
    const memoryKey = `${MEMORY_PREFIX}${projectId}:${name}`;
    getPipeline.get(memoryKey);
    ttlPipeline.ttl(memoryKey);
  }

  const getResults = await getPipeline.exec();
  const ttlResults = await ttlPipeline.exec();

  const results = names.map((name, i) => {
    const data = getResults?.[i]?.[1] as string | null;
    const ttl = (ttlResults?.[i]?.[1] as number) ?? -1;

    if (!data) {
      return { name, success: false, error: `Memory '${name}' not found`, code: 'MEMORY_NOT_FOUND' };
    }

    const memory = JSON.parse(data) as ProjectMemory;
    Logger.debug(`memory/read: retrieved '${name}' for project ${projectId}`);

    return {
      name: memory.name, success: true, content: memory.content, contentLength: memory.content.length,
      tags: memory.tags, createdAt: memory.createdAt, updatedAt: memory.updatedAt,
      ttlSeconds: ttl > 0 ? ttl : null, ttlDays: ttl > 0 ? Math.round(ttl / 86400) : null,
    };
  });

  const successful = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);

  if (isSilent()) {
    if (names.length === 1 && successful.length === 1) {
      return successful[0].content as string;
    }
    const map: Record<string, string | null> = {};
    for (const r of results) {
      map[r.name] = r.success ? (r as { content: string }).content : null;
    }
    return JSON.stringify(map);
  }

  return JSON.stringify({ success: failed.length === 0, projectId, found: successful.length, notFound: failed.length, results });
}

async function handleList(args: MemoryArgs): Promise<string> {
  const { tag, offset = 0, limit = 50, includeContent = false } = args;
  const projectId = getProjectId();
  const indexKey = `${MEMORY_INDEX_PREFIX}${projectId}`;
  const client = await getRedis();

  const names = await client.smembers(indexKey);

  if (names.length === 0) {
    return JSON.stringify({ success: true, projectId, total: 0, offset, limit, hasMore: false, count: 0, memories: [], message: 'No memories found for this project' });
  }

  const memoryKeys = names.map((name) => `${MEMORY_PREFIX}${projectId}:${name}`);

  const getPipeline = client.pipeline();
  for (const key of memoryKeys) getPipeline.get(key);
  const getResults = await getPipeline.exec();

  const ttlPipeline = client.pipeline();
  for (const key of memoryKeys) ttlPipeline.ttl(key);
  const ttlResults = await ttlPipeline.exec();

  const allMemories: MemorySummary[] = [];
  const allMemoriesWithContent: (MemorySummary & { content?: string })[] = [];
  const staleNames: string[] = [];

  for (let i = 0; i < names.length; i++) {
    const [getErr, data] = (getResults?.[i] ?? [null, null]) as [Error | null, string | null];
    const [ttlErr, ttl] = (ttlResults?.[i] ?? [null, -1]) as [Error | null, number];

    if (getErr || !data) {
      staleNames.push(names[i]);
      continue;
    }

    try {
      const memory = JSON.parse(data) as ProjectMemory;

      if (tag && !memory.tags.includes(tag)) continue;

      const ttlValue = ttlErr ? null : ttl;
      const summary: MemorySummary = {
        name: memory.name, contentLength: memory.content.length, tags: memory.tags,
        createdAt: memory.createdAt, updatedAt: memory.updatedAt,
        ttlDays: ttlValue && ttlValue > 0 ? Math.round(ttlValue / 86400) : null,
      };

      allMemories.push(summary);
      if (includeContent) {
        allMemoriesWithContent.push({ ...summary, content: memory.content });
      }
    } catch {
      Logger.warn(`memory/list: skipping corrupted entry '${names[i]}'`);
    }
  }

  if (staleNames.length > 0) {
    const cleanupPipeline = client.pipeline();
    for (const name of staleNames) cleanupPipeline.srem(indexKey, name);
    await cleanupPipeline.exec();
  }

  allMemories.sort((a, b) => b.updatedAt - a.updatedAt);
  if (includeContent) allMemoriesWithContent.sort((a, b) => b.updatedAt - a.updatedAt);

  const total = allMemories.length;
  const memories = allMemories.slice(offset, offset + limit);
  const memoriesWithContent = includeContent ? allMemoriesWithContent.slice(offset, offset + limit) : [];
  const hasMore = offset + limit < total;

  Logger.debug(`memory/list: found ${total} memories, returning ${memories.length} (offset=${offset}) for project ${projectId}`);

  if (isSilent()) {
    return JSON.stringify(memories.map((m) => ({ name: m.name, tags: m.tags })));
  }

  return JSON.stringify({
    success: true, projectId, total, offset, limit, hasMore, count: memories.length,
    filter: tag ? { tag } : null, memories: includeContent ? memoriesWithContent : memories,
  });
}

async function handleEdit(args: MemoryArgs): Promise<string> {
  const edits = args.edits;
  if (!edits || edits.length === 0) {
    return JSON.stringify({ success: false, error: 'edits[] is required for action=edit' });
  }

  const projectId = getProjectId();

  const results = await Promise.all(
    edits.map(async (item) => {
      try {
        const { name, content, appendContent, prependContent, tags, addTags, removeTags } = item;

        if (!content && !appendContent && !prependContent && !tags && !addTags && !removeTags) {
          return { name, success: false, error: 'No edit operations specified', code: 'NO_EDITS' };
        }

        const memoryKey = `${MEMORY_PREFIX}${projectId}:${name}`;
        const client = await getRedis();

        const data = await client.get(memoryKey);
        if (!data) {
          return { name, success: false, error: `Memory '${name}' not found`, code: 'MEMORY_NOT_FOUND' };
        }

        const memory = JSON.parse(data) as ProjectMemory;
        const ttl = await client.ttl(memoryKey);
        const changes: string[] = [];

        let newContent = memory.content;
        if (content !== undefined) { newContent = content; changes.push('content replaced'); }
        if (prependContent) { newContent = prependContent + newContent; changes.push(`prepended ${prependContent.length} chars`); }
        if (appendContent) { newContent = newContent + appendContent; changes.push(`appended ${appendContent.length} chars`); }

        if (newContent.length > MAX_CONTENT_SIZE) {
          return { name, success: false, error: 'Content too large', code: 'CONTENT_TOO_LARGE' };
        }

        let newTags = memory.tags;
        if (tags !== undefined) { newTags = tags; changes.push('tags replaced'); }
        if (addTags && addTags.length > 0) {
          const added = addTags.filter((t) => !newTags.includes(t));
          newTags = [...newTags, ...added];
          if (added.length > 0) changes.push(`added tags: ${added.join(', ')}`);
        }
        if (removeTags && removeTags.length > 0) {
          const removed = removeTags.filter((t) => newTags.includes(t));
          newTags = newTags.filter((t) => !removeTags.includes(t));
          if (removed.length > 0) changes.push(`removed tags: ${removed.join(', ')}`);
        }

        const updatedMemory: ProjectMemory = { ...memory, content: newContent, tags: newTags, updatedAt: Date.now() };

        if (ttl > 0) {
          await client.setex(memoryKey, ttl, JSON.stringify(updatedMemory));
        } else {
          await client.set(memoryKey, JSON.stringify(updatedMemory));
        }

        Logger.debug(`memory/edit: updated '${name}': ${changes.join(', ')}`);

        return { name, success: true, changes, contentLength: newContent.length, tags: newTags };
      } catch (error) {
        return { name: item.name, success: false, error: error instanceof Error ? error.message : String(error) };
      }
    })
  );

  const successful = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);

  if (isSilent()) {
    if (failed.length > 0) {
      return JSON.stringify({ edited: successful.map((r) => r.name), errors: failed.map((r) => r.error) });
    }
    return JSON.stringify(successful.map((r) => r.name));
  }

  return JSON.stringify({ success: failed.length === 0, projectId, edited: successful.length, failed: failed.length, results });
}

async function handleDelete(args: MemoryArgs): Promise<string> {
  const names = args.names;
  if (!names || names.length === 0) {
    return JSON.stringify({ success: false, error: 'names[] is required for action=delete' });
  }

  const projectId = getProjectId();
  const indexKey = `${MEMORY_INDEX_PREFIX}${projectId}`;
  const client = await getRedis();

  const existsPipeline = client.pipeline();
  for (const name of names) {
    existsPipeline.exists(`${MEMORY_PREFIX}${projectId}:${name}`);
  }
  const existsResults = await existsPipeline.exec();

  const delPipeline = client.pipeline();
  const results = names.map((name, i) => {
    const exists = (existsResults?.[i]?.[1] as number) > 0;
    if (!exists) {
      return { name, success: false, error: `Memory '${name}' not found`, code: 'MEMORY_NOT_FOUND' };
    }
    delPipeline.del(`${MEMORY_PREFIX}${projectId}:${name}`);
    delPipeline.srem(indexKey, name);
    return { name, success: true };
  });

  if (results.some((r) => r.success)) {
    await delPipeline.exec();
  }

  for (const r of results) {
    if (r.success) Logger.debug(`memory/delete: deleted '${r.name}' from project ${projectId}`);
  }

  const successful = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);

  if (isSilent()) {
    if (failed.length > 0) {
      return JSON.stringify({ deleted: successful.length, errors: failed.map((r) => r.error) });
    }
    return JSON.stringify({ deleted: successful.length });
  }

  return JSON.stringify({ success: failed.length === 0, projectId, deleted: successful.length, notFound: failed.length, results });
}

// ─── Unified Tool ───────────────────────────────────────────────────────────

export const memoryTool: UnifiedTool = {
  name: 'memory',
  description:
    'Unified project memory: write, read, list, edit, or delete named memories. ' +
    'USE PROACTIVELY: save key findings, read "active-session" at start, check existing memories before duplicating work. ' +
    'Memories persist across sessions — use them to build cumulative project knowledge.',
  zodSchema: schema,
  metadata: {
    category: 'memory',
    tags: ['memory', 'write', 'read', 'list', 'edit', 'delete'],
    examples: [
      { args: { action: 'write', name: 'active-session', content: 'session-id: abc123', tags: ['session'] }, description: 'Store a named memory (shorthand)' },
      { args: { action: 'write', memories: [{ name: 'api-schema', content: '{"endpoints":[]}', tags: ['api'], ttlDays: 7 }] }, description: 'Store memory with custom TTL' },
      { args: { action: 'read', names: ['active-session'] }, description: 'Read a single memory entry' },
      { args: { action: 'list', tag: 'session' }, description: 'List memories filtered by tag' },
      { args: { action: 'edit', edits: [{ name: 'project-notes', appendContent: '\n- New finding', addTags: ['updated'] }] }, description: 'Append content and add tags' },
      { args: { action: 'delete', names: ['old-context'] }, description: 'Delete a memory entry' },
    ],
    relatedTools: ['checkpoint'],
  },

  execute: async (args): Promise<string> => {
    const parsed = args as unknown as MemoryArgs;
    const action = parsed.action;

    return executeWithGuard('memory', 'memory-operations', async () => {
      switch (action) {
        case 'write':
          return handleWrite(parsed);
        case 'read':
          return handleRead(parsed);
        case 'list':
          return handleList(parsed);
        case 'edit':
          return handleEdit(parsed);
        case 'delete':
          return handleDelete(parsed);
        default:
          return JSON.stringify({ success: false, error: `Unknown action: ${action}` });
      }
    });
  },
};
