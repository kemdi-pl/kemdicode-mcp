/**
 * KemdiCode MCP Server - Anthropic Provider
 * Native Anthropic SDK with extended thinking support.
 *
 * @license GPL-3.0
 */

import Anthropic from '@anthropic-ai/sdk';
import type { MessageParam, ContentBlock, Message } from '@anthropic-ai/sdk/resources/messages';
import type { CompletionResponse } from '../client.js';
import type { LLMProvider, ProviderConfig, UnifiedCompletionRequest, ToolCallResult } from './types.js';
import { Logger } from '../../utils/logger.js';

export class AnthropicProvider implements LLMProvider {
  readonly id = 'anthropic' as const;
  private client: Anthropic | null = null;

  init(config: ProviderConfig): void {
    this.client = new Anthropic({
      apiKey: config.apiKey,
      timeout: 120_000,
    });
    Logger.info(`Anthropic provider initialized`);
  }

  isInitialized(): boolean {
    return this.client !== null;
  }

  async complete(request: UnifiedCompletionRequest): Promise<CompletionResponse> {
    if (!this.client) throw new Error('Anthropic provider not initialized');

    // Separate system message from conversation messages
    let systemPrompt: string | undefined;
    const messages: MessageParam[] = [];

    for (const msg of request.messages) {
      if (msg.role === 'system') {
        systemPrompt = msg.content;
      } else if (msg.role === 'tool' && msg.toolCallId) {
        // Map tool results to Anthropic's tool_result format
        messages.push({
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: msg.toolCallId,
            content: msg.content,
          }],
        } as MessageParam);
      } else if (msg.role === 'assistant' && msg.toolCalls?.length) {
        // Map assistant tool calls to Anthropic's tool_use format
        const contentBlocks: Array<{ type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown }> = [];
        if (msg.content) {
          contentBlocks.push({ type: 'text', text: msg.content });
        }
        for (const tc of msg.toolCalls) {
          let parsedInput: unknown;
          try {
            parsedInput = JSON.parse(tc.function.arguments);
          } catch {
            parsedInput = {};
            Logger.warn(`Anthropic: malformed tool call arguments for ${tc.function.name}, using empty input`);
          }
          contentBlocks.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input: parsedInput,
          });
        }
        messages.push({ role: 'assistant', content: contentBlocks } as unknown as MessageParam);
      } else {
        messages.push({ role: msg.role as 'user' | 'assistant', content: msg.content });
      }
    }

    const hasBudget = request.thinking?.thinkingBudget && request.thinking.thinkingBudget > 0;
    const maxTokens = request.maxTokens ?? 8192;

    // Build request params
    const params: Anthropic.MessageCreateParams = {
      model: request.model,
      messages,
      max_tokens: hasBudget ? maxTokens + request.thinking!.thinkingBudget! : maxTokens,
    };

    if (systemPrompt) {
      params.system = systemPrompt;
    }

    // Map OpenAI-compatible tools to Anthropic format
    if (request.tools?.length) {
      const paramsAny = params as unknown as Record<string, unknown>;
      paramsAny.tools = request.tools.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters,
      }));
      if (request.toolChoice) {
        if (request.toolChoice === 'auto') {
          paramsAny.tool_choice = { type: 'auto' };
        } else if (request.toolChoice === 'required') {
          paramsAny.tool_choice = { type: 'any' };
        } else if (request.toolChoice === 'none') {
          // Anthropic doesn't have a direct 'none' — omit tools instead
        } else if (typeof request.toolChoice === 'object') {
          paramsAny.tool_choice = {
            type: 'tool',
            name: request.toolChoice.function.name,
          };
        }
      }
    }

    // Add thinking support (temperature is mutually exclusive with thinking)
    if (hasBudget) {
      params.thinking = {
        type: 'enabled',
        budget_tokens: request.thinking!.thinkingBudget!,
      };
    } else {
      params.temperature = request.temperature ?? 0.7;
    }

    try {
      if (request.stream && request.onProgress) {
        return await this.completeStreaming(params, request);
      }
      return await this.completeNonStreaming(params);
    } catch (error) {
      if (error instanceof Anthropic.APIError) {
        throw new Error(`Anthropic API error: ${error.status} ${error.message}`);
      }
      throw error;
    }
  }

  private async completeStreaming(
    params: Anthropic.MessageCreateParams,
    request: UnifiedCompletionRequest
  ): Promise<CompletionResponse> {
    const stream = this.client!.messages.stream(params);

    let content = '';

    stream.on('text', (text: string) => {
      content += text;
      request.onProgress?.(text);
    });

    let finalMessage: Message;
    try {
      finalMessage = await stream.finalMessage();
    } catch (streamError) {
      // Return partial content on mid-stream failure
      if (content.length > 0) {
        return { content, model: request.model, finishReason: 'error' };
      }
      throw streamError;
    }

    // If no text content was streamed, extract from final message
    if (!content) {
      content = this.extractContent(finalMessage.content);
    }

    // Extract tool_use blocks from streamed response
    const toolCalls: ToolCallResult[] = [];
    for (const block of finalMessage.content) {
      if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input),
          },
        });
      }
    }

    return {
      content,
      model: finalMessage.model,
      usage: {
        promptTokens: finalMessage.usage.input_tokens,
        completionTokens: finalMessage.usage.output_tokens,
        totalTokens: finalMessage.usage.input_tokens + finalMessage.usage.output_tokens,
      },
      finishReason: finalMessage.stop_reason || undefined,
      toolCalls: toolCalls.length ? toolCalls : undefined,
    };
  }

  private async completeNonStreaming(params: Anthropic.MessageCreateParams): Promise<CompletionResponse> {
    const response = await this.client!.messages.create({
      ...params,
      stream: false,
    });

    const content = this.extractContent(response.content);

    // Extract tool_use blocks and map to ToolCallResult
    const toolCalls: ToolCallResult[] = [];
    for (const block of response.content) {
      if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input),
          },
        });
      }
    }

    return {
      content,
      model: response.model,
      usage: {
        promptTokens: response.usage.input_tokens,
        completionTokens: response.usage.output_tokens,
        totalTokens: response.usage.input_tokens + response.usage.output_tokens,
      },
      finishReason: response.stop_reason || undefined,
      toolCalls: toolCalls.length ? toolCalls : undefined,
    };
  }

  private extractContent(blocks: ContentBlock[]): string {
    let content = '';
    let thinkingContent = '';

    for (const block of blocks) {
      if (block.type === 'text') {
        content += block.text;
      } else if (block.type === 'thinking' && 'thinking' in block) {
        thinkingContent += (block as unknown as { thinking: string }).thinking;
      }
    }

    return thinkingContent
      ? `<thinking>\n${thinkingContent}\n</thinking>\n\n${content}`
      : content;
  }

  async listModels(): Promise<Array<{ id: string; name?: string }>> {
    if (!this.client) throw new Error('Anthropic provider not initialized');
    const response = await this.client.models.list();
    const models: Array<{ id: string; name?: string }> = [];
    for await (const model of response) {
      models.push({ id: model.id, name: model.display_name });
    }
    return models;
  }
}
