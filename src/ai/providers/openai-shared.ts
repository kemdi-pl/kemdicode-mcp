/**
 * KemdiCode MCP Server - Shared OpenAI SDK Utilities
 * Common logic shared between OpenAI and OpenAI-compatible providers.
 *
 * @license GPL-3.0
 */

import type OpenAI from 'openai';
import type { ChatCompletionMessageParam, ChatCompletionChunk } from 'openai/resources/chat/completions';
import type { ChatCompletion } from 'openai/resources/chat/completions';
import type { CompletionResponse } from '../client.js';
import type { Message } from '../client.js';

/** Extended delta with reasoning_content for o-series / DeepSeek models */
export interface ReasoningDelta extends ChatCompletionChunk.Choice.Delta {
  reasoning_content?: string;
}

/** Extended message with reasoning_content */
export interface ReasoningMessage {
  content: string | null;
  reasoning_content?: string;
  role: 'assistant';
}

/**
 * Map internal Message[] to OpenAI ChatCompletionMessageParam[].
 */
export function mapMessagesToOpenAI(messages: Message[]): ChatCompletionMessageParam[] {
  return messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));
}

/**
 * Build a CompletionResponse from a non-streaming ChatCompletion.
 */
export function buildCompletionResponse(response: ChatCompletion): CompletionResponse {
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

/**
 * Handle a streaming chat completion, accumulating content and calling onProgress.
 */
export async function handleStreaming(
  stream: AsyncIterable<ChatCompletionChunk>,
  model: string,
  onProgress?: (chunk: string) => void,
): Promise<CompletionResponse> {
  let content = '';
  let finishReason: string | undefined;

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content || '';
    const reasoning = (chunk.choices[0]?.delta as ReasoningDelta)?.reasoning_content || '';
    const text = delta || reasoning;

    if (text) {
      content += text;
      onProgress?.(text);
    }

    if (chunk.choices[0]?.finish_reason) {
      finishReason = chunk.choices[0].finish_reason;
    }
  }

  return { content, model, finishReason };
}

/**
 * List models from an OpenAI client, iterating the async page response.
 */
export async function listModelsFromClient(
  client: OpenAI,
): Promise<Array<{ id: string; name?: string }>> {
  const response = await client.models.list();
  const models: Array<{ id: string; name?: string }> = [];
  for await (const model of response) {
    models.push({ id: model.id });
  }
  return models;
}
