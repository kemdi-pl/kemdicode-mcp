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

import type OpenAI from 'openai';
import type { ChatCompletionMessageParam, ChatCompletionChunk } from 'openai/resources/chat/completions';
import type { ChatCompletion } from 'openai/resources/chat/completions';
import type { CompletionResponse } from '../client.js';
import type { Message } from '../client.js';
import type { ToolCallResult } from './types.js';

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
 * Handles tool role messages and assistant messages with tool_calls.
 */
export function mapMessagesToOpenAI(messages: Message[]): ChatCompletionMessageParam[] {
  return messages.map((m) => {
    if (m.role === 'tool' && m.toolCallId) {
      return { role: 'tool' as const, content: m.content, tool_call_id: m.toolCallId };
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      return {
        role: 'assistant' as const,
        content: m.content || null,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.function.name, arguments: tc.function.arguments },
        })),
      };
    }
    return { role: m.role as 'system' | 'user' | 'assistant', content: m.content };
  });
}

/**
 * Build a CompletionResponse from a non-streaming ChatCompletion.
 * Extracts tool_calls if present in the response.
 */
export function buildCompletionResponse(response: ChatCompletion): CompletionResponse {
  const choice = response.choices?.[0];
  const message = choice?.message as ReasoningMessage | undefined;
  // Some models (DeepSeek-V3.2, Kimi-K2, Qwen3-thinking) return content in reasoning_content
  // or in a non-standard response shape. Handle gracefully.
  const rawResponse = response as unknown as Record<string, unknown>;
  const content = message?.content
    || message?.reasoning_content
    || (typeof rawResponse.content === 'string' ? rawResponse.content : '')
    || '';

  // Extract tool calls from response
  const rawToolCalls = choice?.message?.tool_calls as Array<{ id: string; type: string; function: { name: string; arguments: string } }> | undefined;
  const toolCalls: ToolCallResult[] | undefined = rawToolCalls
    ?.filter((tc) => tc.type === 'function' && tc.function)
    .map((tc) => ({
      id: tc.id,
      type: 'function' as const,
      function: { name: tc.function.name, arguments: tc.function.arguments },
    }));

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
    toolCalls: toolCalls?.length ? toolCalls : undefined,
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

  try {
    for await (const chunk of stream) {
      const firstChoice = chunk.choices?.[0];
      if (!firstChoice) continue; // Skip chunks with empty choices (thinking models may emit these)
      const delta = firstChoice.delta?.content || '';
      const reasoning = (firstChoice.delta as ReasoningDelta)?.reasoning_content || '';
      const text = delta || reasoning;

      if (text) {
        content += text;
        onProgress?.(text);
      }

      if (firstChoice.finish_reason) {
        finishReason = firstChoice.finish_reason;
      }
    }
  } catch (streamError) {
    // Return partial content on mid-stream failure rather than losing everything
    if (content.length > 0) {
      return { content, model, finishReason: 'error' };
    }
    throw streamError;
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
