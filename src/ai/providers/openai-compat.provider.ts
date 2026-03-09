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

import OpenAI from 'openai';
import type { ChatCompletion } from 'openai/resources/chat/completions';
import type { CompletionResponse } from '../client.js';
import type { LLMProvider, ProviderId, ProviderConfig, UnifiedCompletionRequest } from './types.js';
import { PROVIDER_BASE_URLS } from './types.js';
import {
  mapMessagesToOpenAI,
  buildCompletionResponse,
  handleStreaming,
  listModelsFromClient,
} from './openai-shared.js';
import { Logger } from '../../utils/logger.js';

/** HTTP status codes that trigger retry with backoff */
const RETRYABLE_STATUS_CODES = new Set([429, 449, 502, 503, 529]);

/** Max retries for rate-limit errors */
const MAX_RETRIES = 4;

/** Base delay in ms for exponential backoff (1s, 2s, 4s, 8s) */
const BASE_DELAY_MS = 1000;

/** Sleep helper */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Compute backoff delay with jitter.
 * Exponential: baseDelay * 2^attempt + random jitter (0-500ms)
 */
function backoffDelay(attempt: number, retryAfterMs?: number): number {
  if (retryAfterMs && retryAfterMs > 0) return retryAfterMs;
  const exponential = BASE_DELAY_MS * Math.pow(2, attempt);
  const jitter = Math.random() * 500;
  return exponential + jitter;
}

/**
 * Extract Retry-After header value in ms from an API error.
 */
function parseRetryAfter(error: InstanceType<typeof OpenAI.APIError>): number | undefined {
  const headers = error.headers as Record<string, string> | undefined;
  if (!headers) return undefined;
  const retryAfter = headers['retry-after'] ?? headers['Retry-After'];
  if (!retryAfter) return undefined;
  const seconds = parseFloat(String(retryAfter));
  if (!isNaN(seconds) && seconds > 0) return seconds * 1000;
  return undefined;
}

/**
 * Create an OpenAI-compatible provider for a given provider ID.
 * Uses the OpenAI SDK with a custom baseURL.
 * Includes retry with exponential backoff for rate-limit errors (429, 449).
 */
export function createOpenAICompatProvider(providerId: ProviderId): LLMProvider {
  let client: OpenAI | null = null;

  return {
    id: providerId,

    init(config: ProviderConfig): void {
      const isBuiltin = !String(providerId).startsWith('custom:');
      const baseURL = config.baseURL || (isBuiltin ? PROVIDER_BASE_URLS[providerId as keyof typeof PROVIDER_BASE_URLS] : undefined);
      client = new OpenAI({
        baseURL,
        apiKey: config.apiKey || 'not-needed',
        timeout: 120_000,
        // Disable SDK built-in retries — we handle retries ourselves with broader status code support
        maxRetries: 0,
        defaultHeaders: {
          'User-Agent': 'KemdiCode-MCP/2.2.0',
        },
      });
      Logger.info(`${providerId} provider initialized (OpenAI-compatible: ${baseURL})`);
    },

    isInitialized(): boolean {
      return client !== null;
    },

    async complete(request: UnifiedCompletionRequest): Promise<CompletionResponse> {
      if (!client) throw new Error(`${providerId} provider not initialized`);

      const messages = mapMessagesToOpenAI(request.messages);

      const baseParams: Record<string, unknown> = {
        model: request.model,
        messages,
        max_tokens: request.maxTokens ?? 8192,
        temperature: request.temperature ?? 0.7,
      };

      if (request.tools?.length) {
        baseParams.tools = request.tools;
        if (request.toolChoice) baseParams.tool_choice = request.toolChoice;
      }

      let lastError: Error | null = null;

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          if (request.stream && request.onProgress) {
            const stream = await client.chat.completions.create({
              ...baseParams,
              stream: true,
            } as unknown as OpenAI.ChatCompletionCreateParamsStreaming);

            return await handleStreaming(stream, request.model, request.onProgress);
          }

          // Non-streaming
          const response = (await client.chat.completions.create(
            baseParams as unknown as OpenAI.ChatCompletionCreateParamsNonStreaming
          )) as ChatCompletion;

          // Some APIs return non-standard responses (no choices array).
          // Thinking models (Qwen3-thinking, DeepSeek-R1) may return content outside choices.
          if (!response.choices?.length) {
            const raw = response as unknown as Record<string, unknown>;
            // Check if raw response is a rate-limit JSON (e.g., iFlow 449)
            let status = typeof raw.status === 'number' ? raw.status : typeof raw.status === 'string' ? parseInt(raw.status, 10) : 0;
            if (isNaN(status) || status < 100 || status > 599) status = 0;
            if (RETRYABLE_STATUS_CODES.has(status) && attempt < MAX_RETRIES) {
              const delay = backoffDelay(attempt);
              Logger.warn(`[${providerId}] Rate limit (${status}), retry ${attempt + 1}/${MAX_RETRIES} in ${Math.round(delay)}ms`);
              await sleep(delay);
              continue;
            }

            // Try buildCompletionResponse anyway — it handles reasoning_content and raw content fallbacks
            const fallbackResult = buildCompletionResponse(response);
            if (fallbackResult.content) {
              return fallbackResult;
            }

            // Non-standard response without any extractable content — treat as error
            throw new Error(
              `${providerId}: non-standard response (no choices array, keys: ${Object.keys(raw).join(',')})`,
            );
          }

          return buildCompletionResponse(response);
        } catch (error) {
          if (error instanceof OpenAI.APIError && RETRYABLE_STATUS_CODES.has(error.status)) {
            lastError = new Error(`${providerId} API error: ${error.status} ${error.message}`);

            if (attempt < MAX_RETRIES) {
              const retryAfterMs = parseRetryAfter(error);
              const delay = backoffDelay(attempt, retryAfterMs);
              Logger.warn(
                `[${providerId}] Rate limit (${error.status}), retry ${attempt + 1}/${MAX_RETRIES} in ${Math.round(delay)}ms` +
                  (retryAfterMs ? ` (Retry-After: ${retryAfterMs}ms)` : ''),
              );
              await sleep(delay);
              continue;
            }
          }

          if (error instanceof OpenAI.APIError) {
            throw new Error(`${providerId} API error: ${error.status} ${error.message}`, { cause: error });
          }
          throw error;
        }
      }

      // All retries exhausted
      throw lastError || new Error(`${providerId}: max retries (${MAX_RETRIES}) exhausted`);
    },

    async listModels(): Promise<Array<{ id: string; name?: string }>> {
      if (!client) throw new Error(`${providerId} provider not initialized`);
      return listModelsFromClient(client);
    },
  };
}
