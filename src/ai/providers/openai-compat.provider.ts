/**
 * KemdiCode MCP Server - OpenAI-Compatible Provider
 * Factory for providers using OpenAI-compatible APIs (Groq, DeepSeek, Ollama, OpenRouter).
 *
 * @license GPL-3.0
 */

import OpenAI from 'openai';
import type {
  ChatCompletionMessageParam,
  ChatCompletionChunk,
  ChatCompletion,
} from 'openai/resources/chat/completions';
import type { CompletionResponse } from '../client.js';
import type { LLMProvider, ProviderId, ProviderConfig, UnifiedCompletionRequest } from './types.js';
import { PROVIDER_BASE_URLS } from './types.js';
import { Logger } from '../../utils/logger.js';

interface ReasoningDelta extends ChatCompletionChunk.Choice.Delta {
  reasoning_content?: string;
}

interface ReasoningMessage {
  content: string | null;
  reasoning_content?: string;
  role: 'assistant';
}

/**
 * Create an OpenAI-compatible provider for a given provider ID.
 * Uses the OpenAI SDK with a custom baseURL.
 */
export function createOpenAICompatProvider(providerId: ProviderId): LLMProvider {
  let client: OpenAI | null = null;

  return {
    id: providerId,

    init(config: ProviderConfig): void {
      const baseURL = config.baseURL || PROVIDER_BASE_URLS[providerId];
      client = new OpenAI({
        baseURL,
        apiKey: config.apiKey || 'not-needed',
        timeout: 120_000,
        maxRetries: 3,
      });
      Logger.info(`${providerId} provider initialized (OpenAI-compatible: ${baseURL})`);
    },

    isInitialized(): boolean {
      return client !== null;
    },

    async complete(request: UnifiedCompletionRequest): Promise<CompletionResponse> {
      if (!client) throw new Error(`${providerId} provider not initialized`);

      const messages: ChatCompletionMessageParam[] = request.messages.map((m) => ({
        role: m.role,
        content: m.content,
      }));

      const baseParams = {
        model: request.model,
        messages,
        max_tokens: request.maxTokens ?? 8192,
        temperature: request.temperature ?? 0.7,
      };

      try {
        if (request.stream && request.onProgress) {
          const stream = await client.chat.completions.create({
            ...baseParams,
            stream: true,
          });

          let content = '';
          let finishReason: string | undefined;

          for await (const chunk of stream) {
            const delta = chunk.choices[0]?.delta?.content || '';
            const reasoning =
              (chunk.choices[0]?.delta as ReasoningDelta)?.reasoning_content || '';
            const text = delta || reasoning;

            if (text) {
              content += text;
              request.onProgress(text);
            }

            if (chunk.choices[0]?.finish_reason) {
              finishReason = chunk.choices[0].finish_reason;
            }
          }

          return { content, model: request.model, finishReason };
        }

        // Non-streaming
        const response = (await client.chat.completions.create(baseParams)) as ChatCompletion;

        const choice = response.choices[0];
        const message = choice?.message as ReasoningMessage | undefined;
        const content = message?.content || message?.reasoning_content || '';

        return {
          content,
          model: response.model,
          usage: response.usage
            ? {
                promptTokens: response.usage.prompt_tokens,
                completionTokens: response.usage.completion_tokens,
                totalTokens: response.usage.total_tokens,
              }
            : undefined,
          finishReason: choice?.finish_reason || undefined,
        };
      } catch (error) {
        if (error instanceof OpenAI.APIError) {
          throw new Error(`${providerId} API error: ${error.status} ${error.message}`);
        }
        throw error;
      }
    },

    async listModels(): Promise<Array<{ id: string; name?: string }>> {
      if (!client) throw new Error(`${providerId} provider not initialized`);
      const response = await client.models.list();
      const models: Array<{ id: string; name?: string }> = [];
      for await (const model of response) {
        models.push({ id: model.id });
      }
      return models;
    },
  };
}
