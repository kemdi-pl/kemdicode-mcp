/**
 * KemdiCode MCP Server - OpenAI Provider
 * Native OpenAI SDK provider with reasoning effort support for o-series models.
 *
 * @license GPL-3.0
 */

import OpenAI from 'openai';
import type { ChatCompletionMessageParam, ChatCompletionChunk } from 'openai/resources/chat/completions';
import type { ChatCompletion } from 'openai/resources/chat/completions';
import type { CompletionResponse } from '../client.js';
import type { LLMProvider, ProviderConfig, UnifiedCompletionRequest } from './types.js';
import { Logger } from '../../utils/logger.js';

interface ReasoningDelta extends ChatCompletionChunk.Choice.Delta {
  reasoning_content?: string;
}

interface ReasoningMessage {
  content: string | null;
  reasoning_content?: string;
  role: 'assistant';
}

export class OpenAIProvider implements LLMProvider {
  readonly id = 'openai' as const;
  private client: OpenAI | null = null;

  init(config: ProviderConfig): void {
    this.client = new OpenAI({
      baseURL: config.baseURL || 'https://api.openai.com/v1',
      apiKey: config.apiKey,
      timeout: 120_000,
      maxRetries: 3,
    });
    Logger.info(`OpenAI provider initialized`);
  }

  isInitialized(): boolean {
    return this.client !== null;
  }

  async complete(request: UnifiedCompletionRequest): Promise<CompletionResponse> {
    if (!this.client) throw new Error('OpenAI provider not initialized');

    const messages: ChatCompletionMessageParam[] = request.messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    const isReasoning = !!request.thinking?.reasoningEffort;

    // Build params: o-series models require different param names and don't support temperature
    const baseParams: Record<string, unknown> = {
      model: request.model,
      messages,
    };

    if (isReasoning) {
      // o-series models: use max_completion_tokens, no temperature, add reasoning_effort
      baseParams.max_completion_tokens = request.maxTokens ?? 8192;
      baseParams.reasoning_effort = request.thinking!.reasoningEffort;
    } else {
      baseParams.max_tokens = request.maxTokens ?? 8192;
      baseParams.temperature = request.temperature ?? 0.7;
    }

    try {
      if (request.stream && request.onProgress) {
        return await this.completeStreaming(baseParams, request);
      }
      return await this.completeNonStreaming(baseParams, request);
    } catch (error) {
      if (error instanceof OpenAI.APIError) {
        throw new Error(`OpenAI API error: ${error.status} ${error.message}`);
      }
      throw error;
    }
  }

  private async completeStreaming(
    baseParams: Record<string, unknown>,
    request: UnifiedCompletionRequest
  ): Promise<CompletionResponse> {
    const stream = await this.client!.chat.completions.create({
      ...baseParams,
      stream: true,
    } as unknown as OpenAI.ChatCompletionCreateParamsStreaming);

    let content = '';
    let finishReason: string | undefined;

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content || '';
      const reasoning = (chunk.choices[0]?.delta as ReasoningDelta)?.reasoning_content || '';
      const text = delta || reasoning;

      if (text) {
        content += text;
        request.onProgress?.(text);
      }

      if (chunk.choices[0]?.finish_reason) {
        finishReason = chunk.choices[0].finish_reason;
      }
    }

    return { content, model: request.model, finishReason };
  }

  private async completeNonStreaming(
    baseParams: Record<string, unknown>,
    _request: UnifiedCompletionRequest
  ): Promise<CompletionResponse> {
    const response = (await this.client!.chat.completions.create(
      baseParams as unknown as OpenAI.ChatCompletionCreateParamsNonStreaming
    )) as ChatCompletion;

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
  }

  async listModels(): Promise<Array<{ id: string; name?: string }>> {
    if (!this.client) throw new Error('OpenAI provider not initialized');
    const response = await this.client.models.list();
    const models: Array<{ id: string; name?: string }> = [];
    for await (const model of response) {
      models.push({ id: model.id });
    }
    return models;
  }
}
