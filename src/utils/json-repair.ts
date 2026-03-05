/**
 * KemdiCode MCP Server - JSON Repair Utility
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
 * JSON Repair Module
 *
 * Uses the `jsonrepair` package to safely parse malformed JSON from LLM outputs.
 * Handles common LLM issues:
 * - Trailing commas
 * - Missing quotes on keys
 * - Single quotes instead of double
 * - Unescaped control characters
 * - Truncated JSON (incomplete responses)
 * - Comments in JSON
 * - Markdown code fences wrapping JSON
 *
 * @module utils/json-repair
 */

import { jsonrepair } from 'jsonrepair';
import { Logger } from './logger.js';

/**
 * Result of a JSON parse attempt with repair information.
 */
export interface JsonParseResult<T = unknown> {
  /** Parsed value */
  value: T;
  /** Whether repair was needed */
  repaired: boolean;
  /** Original input if repair was applied */
  originalInput?: string;
}

/**
 * Strip markdown code fences from LLM output before JSON parsing.
 * Handles ```json ... ```, ``` ... ```, and leading/trailing whitespace.
 */
function stripCodeFences(input: string): string {
  let s = input.trim();

  // Remove ```json or ``` prefix
  if (s.startsWith('```')) {
    const firstNewline = s.indexOf('\n');
    if (firstNewline !== -1) {
      s = s.slice(firstNewline + 1);
    }
  }

  // Remove trailing ```
  if (s.endsWith('```')) {
    s = s.slice(0, -3);
  }

  return s.trim();
}

/**
 * Safely parse JSON from LLM output with automatic repair.
 *
 * Strategy:
 * 1. Try native JSON.parse first (fast path, no repair needed)
 * 2. Strip markdown code fences and retry
 * 3. Use jsonrepair for malformed JSON
 *
 * @param input - Raw string from LLM output
 * @returns Parsed value with repair metadata
 * @throws Error if JSON cannot be repaired
 */
export function safeJsonParse<T = unknown>(input: string): JsonParseResult<T> {
  // Fast path: try native parse first
  try {
    return { value: JSON.parse(input) as T, repaired: false };
  } catch {
    // Fall through to repair
  }

  // Try stripping code fences
  const stripped = stripCodeFences(input);
  if (stripped !== input) {
    try {
      return { value: JSON.parse(stripped) as T, repaired: false };
    } catch {
      // Fall through to repair
    }
  }

  // Use jsonrepair
  try {
    const repaired = jsonrepair(stripped);
    const value = JSON.parse(repaired) as T;
    Logger.debug(`json-repair: repaired malformed JSON (${input.length} chars)`);
    return { value, repaired: true, originalInput: input };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`JSON repair failed: ${msg}\nInput (first 200 chars): ${input.slice(0, 200)}`);
  }
}

/**
 * Parse JSON from LLM output, returning null on failure instead of throwing.
 *
 * @param input - Raw string from LLM output
 * @returns Parsed value or null if repair fails
 */
export function tryJsonParse<T = unknown>(input: string): T | null {
  try {
    return safeJsonParse<T>(input).value;
  } catch {
    return null;
  }
}

/**
 * Parse JSON with a Zod schema for validation.
 * Combines JSON repair with schema validation for fully typed, safe LLM output parsing.
 *
 * @param input - Raw string from LLM output
 * @param schema - Zod schema to validate against
 * @returns Validated and typed value
 * @throws Error if JSON repair or validation fails
 */
export function parseJsonWithSchema<T>(
  input: string,
  schema: { parse: (data: unknown) => T },
): JsonParseResult<T> {
  const result = safeJsonParse(input);
  const validated = schema.parse(result.value);
  return { value: validated, repaired: result.repaired, originalInput: result.originalInput };
}
