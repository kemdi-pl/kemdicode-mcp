/**
 * KemdiCode MCP Server - OpenAI-Compatible Provider
 * Factory for providers using OpenAI-compatible APIs (Groq, DeepSeek, Ollama, OpenRouter).
 *
 * @license GPL-3.0
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

/**
 * Create an OpenAI-compatible provider for a given provider ID.
 * Uses the OpenAI SDK with a custom baseURL.
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
        maxRetries: 3,
        defaultHeaders: {
          'User-Agent': 'KemdiCode-MCP/1.24.0',
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
        // Fall back to extracting content from raw response.
        if (!response.choices?.length) {
          const raw = response as unknown as Record<string, unknown>;
          const content = typeof raw.content === 'string' ? raw.content : JSON.stringify(raw);
          return {
            content,
            model: response.model || request.model,
            finishReason: 'stop',
          };
        }

        return buildCompletionResponse(response);
      } catch (error) {
        if (error instanceof OpenAI.APIError) {
          throw new Error(`${providerId} API error: ${error.status} ${error.message}`);
        }
        throw error;
      }
    },

    async listModels(): Promise<Array<{ id: string; name?: string }>> {
      if (!client) throw new Error(`${providerId} provider not initialized`);
      return listModelsFromClient(client);
    },
  };
}
