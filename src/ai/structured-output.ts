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

import { z } from 'zod';
import { complete } from './client.js';
import type { Message, CompletionResponse } from './client.js';
import { safeJsonParse, parseJsonWithSchema } from '../utils/json-repair.js';
import { Logger } from '../utils/logger.js';

/**
 * Options for generating a structured object from an LLM.
 */
export interface GenerateObjectOptions<T extends z.ZodTypeAny> {
  /** Model to use (supports provider:model:thinking syntax) */
  model?: string;
  /** Zod schema defining the expected output structure */
  schema: T;
  /** System prompt */
  system?: string;
  /** User prompt */
  prompt: string;
  /** Additional messages for context */
  messages?: Message[];
  /** Temperature (lower = more deterministic, default 0.2 for structured output) */
  temperature?: number;
  /** Max tokens for the response */
  maxTokens?: number;
  /** Number of retries on parse failure */
  maxRetries?: number;
}

/**
 * Result of structured object generation.
 */
export interface GenerateObjectResult<T> {
  /** The validated, typed object */
  object: T;
  /** Raw LLM response content */
  rawContent: string;
  /** Whether JSON repair was needed */
  repaired: boolean;
  /** Model used */
  model: string;
  /** Token usage if available */
  usage?: CompletionResponse['usage'];
  /** Number of attempts needed */
  attempts: number;
}

/**
 * Generate a structured, typed object from an LLM response.
 *
 * Strategy:
 * 1. Sends prompt with JSON schema instructions to the LLM
 * 2. Parses response using jsonrepair for malformed output
 * 3. Validates against the provided Zod schema
 * 4. Retries on failure (up to maxRetries)
 *
 * @param options - Generation options with schema
 * @returns Validated, typed object
 * @throws Error if all retries fail
 *
 * @example
 * ```typescript
 * const result = await generateObject({
 *   model: 'a:claude-sonnet-4-6',
 *   schema: z.object({
 *     summary: z.string(),
 *     score: z.number().min(0).max(10),
 *     tags: z.array(z.string()),
 *   }),
 *   prompt: 'Analyze this code and return structured feedback',
 * });
 * console.log(result.object.score); // typed as number
 * ```
 */
export async function generateObject<T extends z.ZodTypeAny>(
  options: GenerateObjectOptions<T>,
): Promise<GenerateObjectResult<z.infer<T>>> {
  const {
    model,
    schema,
    system,
    prompt,
    messages: extraMessages,
    temperature = 0.2,
    maxTokens = 4096,
    maxRetries = 2,
  } = options;

  // Generate JSON Schema description for the LLM
  const jsonSchema = z.toJSONSchema(schema, { target: 'draft-07' });
  const schemaStr = JSON.stringify(jsonSchema, null, 2);

  const systemPrompt = [
    system || 'You are a structured data extraction assistant.',
    '',
    'IMPORTANT: You MUST respond with ONLY valid JSON that matches this exact schema:',
    '```json',
    schemaStr,
    '```',
    '',
    'Do NOT include any text before or after the JSON. Do NOT wrap in markdown code fences. Do NOT use XML tags.',
    'Respond with raw JSON only.',
  ].join('\n');

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    const messages: Message[] = [
      { role: 'system', content: systemPrompt },
      ...(extraMessages || []),
      { role: 'user', content: prompt },
    ];

    // Add retry context if this is a retry
    if (attempt > 1 && lastError) {
      messages.push({
        role: 'user',
        content: `Your previous response was invalid JSON or didn't match the schema. Error: ${lastError.message}\n\nPlease try again with valid JSON only.`,
      });
    }

    try {
      const response = await complete({
        model,
        messages,
        temperature,
        maxTokens,
      });

      const content = response.content.trim();

      // Parse and validate with jsonrepair + Zod
      const parsed = parseJsonWithSchema<z.infer<T>>(content, schema);

      if (parsed.repaired) {
        Logger.debug(`structured-output: JSON repair applied (attempt ${attempt})`);
      }

      return {
        object: parsed.value,
        rawContent: content,
        repaired: parsed.repaired,
        model: response.model,
        usage: response.usage,
        attempts: attempt,
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      Logger.warn(
        `structured-output: attempt ${attempt}/${maxRetries + 1} failed: ${lastError.message}`,
      );

      if (attempt > maxRetries) {
        throw new Error(
          `Failed to generate valid structured output after ${maxRetries + 1} attempts. Last error: ${lastError.message}`,
          { cause: error },
        );
      }
    }
  }

  // Unreachable but satisfies TypeScript
  throw new Error('generateObject: unexpected state');
}

/**
 * Generate a structured object using the research model tier.
 * Falls back to main model if research model is not configured.
 *
 * Useful for fact-checking, web search synthesis, and data extraction
 * where Perplexity or similar research-optimized models excel.
 *
 * @param options - Same as generateObject but uses research model by default
 */
export async function generateResearchObject<T extends z.ZodTypeAny>(
  options: GenerateObjectOptions<T>,
): Promise<GenerateObjectResult<z.infer<T>>> {
  const { getClientConfig } = await import('./client.js');
  const config = getClientConfig();
  const researchModel = config?.researchModel;

  return generateObject({
    ...options,
    model: options.model || researchModel || config?.defaultModel,
  });
}

/**
 * Parse an existing LLM response string into a typed object.
 * Does not make an API call - just parses and validates.
 *
 * @param content - Raw LLM response string
 * @param schema - Zod schema to validate against
 * @returns Validated object
 */
export function parseStructuredOutput<T extends z.ZodTypeAny>(
  content: string,
  schema: T,
): z.infer<T> {
  const result = safeJsonParse(content);
  return schema.parse(result.value);
}
