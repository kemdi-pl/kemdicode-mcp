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
 * Response Formatter
 *
 * Formats tool responses based on output level.
 * Silent mode strips metadata, compact strips decorations,
 * normal preserves current behavior.
 *
 * @module utils/response
 */

import { getOutputLevel, type OutputLevel } from '../config/silent.js';

/** Maximum response size in silent mode (bytes) */
const SILENT_MAX_RESPONSE = 8192;

/** Fields always stripped in silent/compact mode */
const STRIP_FIELDS = new Set([
  'success',
  'sessionId',
  'createdBy',
  'priorityIcon',
  'statusIcon',
  'tool',
]);

/** Fields stripped only in strict silent mode */
const SILENT_STRIP_FIELDS = new Set([
  'createdAt',
  'updatedAt',
  'modifiedAt',
  'encoding',
  'totalLines',
  'size',
  'contentLength',
  'tags',
  'labels',
]);

export interface FormatOptions {
  /** Override output level for this call */
  level?: OutputLevel;
  /** Fields to always keep even in silent mode */
  keep?: string[];
  /** If true, return raw string value instead of JSON for simple results */
  raw?: boolean;
}

/**
 * Format a tool response based on output level.
 *
 * - normal: JSON.stringify(data) unchanged
 * - compact: strips success wrappers, decorations, metadata
 * - silent: strips everything non-essential, truncates if too large
 */
export function formatResponse(data: unknown, opts?: FormatOptions): string {
  const level = opts?.level ?? getOutputLevel();

  // Normal mode: pass through unchanged
  if (level === 'normal') {
    return typeof data === 'string' ? data : JSON.stringify(data);
  }

  // Raw string passthrough
  if (opts?.raw && typeof data === 'string') {
    return truncateIfNeeded(data, level);
  }

  // For non-object data, stringify directly
  if (typeof data !== 'object' || data === null) {
    return String(data);
  }

  const keepSet = opts?.keep ? new Set(opts.keep) : undefined;
  const cleaned = stripFields(data as Record<string, unknown>, level, keepSet);

  // If the cleaned result is a single-value object, unwrap it
  const keys = Object.keys(cleaned);
  if (keys.length === 1) {
    const val = cleaned[keys[0]];
    if (typeof val === 'string') return truncateIfNeeded(val, level);
    if (Array.isArray(val)) return truncateIfNeeded(JSON.stringify(val), level);
  }

  return truncateIfNeeded(JSON.stringify(cleaned), level);
}

/**
 * Create a silent-mode response with just IDs.
 * Common pattern for create/update operations.
 */
export function silentIds(ids: string[]): string {
  return JSON.stringify(ids);
}

/**
 * Create a silent-mode OK response.
 * For operations that just need confirmation.
 */
export function silentOk(): string {
  return '{"ok":true}';
}

/**
 * Create a silent-mode count response.
 */
export function silentCount(key: string, count: number): string {
  return JSON.stringify({ [key]: count });
}

function stripFields(
  obj: Record<string, unknown>,
  level: OutputLevel,
  keep?: Set<string>
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const isSilent = level === 'silent';

  for (const [key, value] of Object.entries(obj)) {
    // Skip if in strip list (unless explicitly kept)
    if (keep?.has(key)) {
      result[key] = value;
      continue;
    }
    if (STRIP_FIELDS.has(key)) continue;
    if (isSilent && SILENT_STRIP_FIELDS.has(key)) continue;

    // Skip null/undefined/empty
    if (value === null || value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) continue;

    // Recursively strip nested objects
    if (typeof value === 'object' && !Array.isArray(value)) {
      result[key] = stripFields(value as Record<string, unknown>, level, keep);
    } else {
      result[key] = value;
    }
  }

  return result;
}

function truncateIfNeeded(str: string, level: OutputLevel): string {
  if (level === 'silent' && str.length > SILENT_MAX_RESPONSE) {
    return str.substring(0, SILENT_MAX_RESPONSE) + '...[truncated]';
  }
  return str;
}
