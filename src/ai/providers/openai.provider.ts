/**
 * KemdiCode MCP Server - OpenAI Provider
 * Native OpenAI SDK provider with reasoning effort support for o-series models.
 *
 * @license GPL-3.0
 */

import OpenAI from 'openai';
import type { ChatCompletion } from 'openai/resources/chat/completions';
import type { CompletionResponse } from '../client.js';
import type { LLMProvider, ProviderConfig, UnifiedCompletionRequest } from './types.js';
import {
  mapMessagesToOpenAI,
  buildCompletionResponse,
  handleStreaming,
  listModelsFromClient,
} from './openai-shared.js';
import { Logger } from '../../utils/logger.js';

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

    const messages = mapMessagesToOpenAI(request.messages);

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
      return await this.completeNonStreaming(baseParams);
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

    return handleStreaming(stream, request.model, request.onProgress);
  }

  private async completeNonStreaming(
    baseParams: Record<string, unknown>,
  ): Promise<CompletionResponse> {
    const response = (await this.client!.chat.completions.create(
      baseParams as unknown as OpenAI.ChatCompletionCreateParamsNonStreaming
    )) as ChatCompletion;

    return buildCompletionResponse(response);
  }

  async listModels(): Promise<Array<{ id: string; name?: string }>> {
    if (!this.client) throw new Error('OpenAI provider not initialized');
    return listModelsFromClient(this.client);
  }
}
