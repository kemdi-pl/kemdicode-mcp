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
import type {
  ChatCompletion,
  ChatCompletionMessageParam,
  ChatCompletionChunk,
} from 'openai/resources/chat/completions';
import type { FunctionTool, ToolCallResult } from './providers/types.js';
import { Logger } from '../utils/logger.js';
import { parseModelSpec, hasProviderPrefix } from './model-spec.js';
import {
  getProvider,
  isProviderAvailable,
  registerBuiltinProviders,
  recordTokenUsage,
} from './providers/registry.js';

/**
 * Extended types for reasoning models (DeepSeek, Kimi, etc.)
 * These models return reasoning_content in addition to standard content.
 */
interface ReasoningDelta extends ChatCompletionChunk.Choice.Delta {
  reasoning_content?: string;
}

interface ReasoningMessage {
  content: string | null;
  reasoning_content?: string;
  role: 'assistant';
}

// Singleton client instance
let client: OpenAI | null = null;
let currentConfig: AIClientConfig | null = null;

export interface AIClientConfig {
  baseURL: string;
  apiKey: string;
  defaultModel: string;
  fallbackModel?: string;
  /** Research model for fact-checking (e.g., perplexity:sonar-pro). 3-tier: main → research → fallback */
  researchModel?: string;
  timeout?: number;
  maxRetries?: number;
}

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ToolCallResult[]; // assistant response with tool calls
  toolCallId?: string; // tool response referencing call ID
}

export interface CompletionRequest {
  model?: string;
  messages: Message[];
  stream?: boolean;
  maxTokens?: number;
  temperature?: number;
  onProgress?: (chunk: string) => void;
  tools?: FunctionTool[];
  toolChoice?: 'none' | 'auto' | 'required' | { type: 'function'; function: { name: string } };
  _fallbackAttempt?: boolean;
}

export interface CompletionResponse {
  content: string;
  model: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  finishReason?: string;
  toolCalls?: ToolCallResult[];
}

export class AIError extends Error {
  constructor(
    message: string,
    public statusCode?: number
  ) {
    super(message);
    this.name = 'AIError';
  }
}

/**
 * Validate AI client configuration
 */
function validateConfig(config: AIClientConfig): void {
  if (!config.baseURL) {
    throw new AIError('baseURL is required for AI client initialization');
  }
  if (!config.apiKey) {
    throw new AIError('apiKey is required for AI client initialization');
  }
  try {
    new URL(config.baseURL);
  } catch {
    throw new AIError(`Invalid baseURL: ${config.baseURL}`);
  }
}

/**
 * Initialize the OpenAI client with configuration
 */
export function initAIClient(config: AIClientConfig): void {
  validateConfig(config);
  currentConfig = config;
  client = new OpenAI({
    baseURL: config.baseURL,
    apiKey: config.apiKey,
    timeout: config.timeout ?? 120000,
    maxRetries: config.maxRetries ?? 3,
  });
  Logger.info(
    `AI client initialized: ${config.baseURL}, model: ${config.defaultModel || '(not set)'}`
  );
}

/**
 * Get the current OpenAI client instance
 */
export function getAIClient(): OpenAI {
  if (!client) {
    throw new AIError('AI client not initialized. Call initAIClient() first.');
  }
  return client;
}

/**
 * Get current client configuration
 */
export function getClientConfig(): AIClientConfig | null {
  return currentConfig;
}

/**
 * Update client configuration (hot reload)
 */
export function updateClientConfig(updates: Partial<AIClientConfig>): void {
  if (!currentConfig) {
    throw new AIError('AI client not initialized. Call initAIClient() first.');
  }

  // Dispose old client to prevent socket leaks
  if (client) {
    try {
      (client as { httpAgent?: { destroy?: () => void } }).httpAgent?.destroy?.();
    } catch {
      /* ignore disposal errors */
    }
  }
  const newConfig = { ...currentConfig, ...updates };
  initAIClient(newConfig);
  Logger.info('AI client configuration updated');
}

/**
 * Complete a chat request.
 *
 * Unified routing: ALL models go through the provider registry first.
 * Falls back to the legacy OpenAI SDK client only when:
 * 1. No provider prefix is present, AND
 * 2. No matching provider is registered in the registry
 *
 * This eliminates the dual code path that previously existed.
 */
export async function complete(request: CompletionRequest): Promise<CompletionResponse> {
  const model = request.model || currentConfig?.defaultModel;

  if (!model) {
    throw new AIError('No model specified. Set primaryModel in config or pass model in request.');
  }

  // Ensure builtin providers are registered
  registerBuiltinProviders();

  // Parse model spec (handles both prefixed and unprefixed models)
  const spec = hasProviderPrefix(model)
    ? parseModelSpec(model)
    : parseModelSpec(model, 'openai'); // default to openai for unprefixed

  // Validate model is non-empty after parsing
  if (!spec.model) {
    throw new AIError(`Invalid model specification: "${model}" — model name is empty after parsing.`);
  }

  // Try provider registry first (unified path)
  if (isProviderAvailable(spec.provider)) {
    try {
      const provider = getProvider(spec.provider);
      const result = await provider.complete({
        provider: spec.provider,
        model: spec.model,
        messages: request.messages,
        thinking: spec.thinking,
        maxTokens: request.maxTokens,
        temperature: request.temperature,
        stream: request.stream,
        onProgress: request.onProgress,
        tools: request.tools,
        toolChoice: request.toolChoice,
      });
      if (result.usage) recordTokenUsage(result.usage);
      return result;
    } catch (error) {
      // Try fallback model if configured (prevent circular fallback via _fallbackAttempt)
      if (
        currentConfig?.fallbackModel &&
        request.model !== currentConfig.fallbackModel &&
        !(request as CompletionRequest)._fallbackAttempt
      ) {
        Logger.warn(
          `Provider ${spec.provider} failed, trying fallback: ${currentConfig.fallbackModel}`
        );
        return complete({
          ...request,
          model: currentConfig.fallbackModel,
          _fallbackAttempt: true,
        } as CompletionRequest);
      }
      throw error;
    }
  }

  // Provider not available — if model had an explicit prefix, that's an error
  if (hasProviderPrefix(model)) {
    throw new AIError(
      `Provider "${spec.provider}" is not configured. Set API key via environment variable or config tool.`
    );
  }

  // Legacy fallback: use the old OpenAI SDK client for unprefixed models
  // when no provider is registered (backward compatibility)
  const openai = getAIClient();

  const messages: ChatCompletionMessageParam[] = request.messages.map((m) => {
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

  try {
    // Streaming mode
    if (request.stream && request.onProgress) {
      const stream = await openai.chat.completions.create({
        model,
        messages,
        max_tokens: request.maxTokens ?? 8192,
        temperature: request.temperature ?? 0.7,
        stream: true,
        tools: request.tools,
        tool_choice: request.toolChoice,
      });

      let content = '';
      let finishReason: string | undefined;

      for await (const chunk of stream) {
        const firstChoice = chunk.choices?.[0];
        if (!firstChoice) continue; // Skip chunks with empty choices (thinking models may emit these)
        const delta = firstChoice.delta?.content || '';
        // Handle reasoning models that return reasoning_content (DeepSeek, Kimi, etc.)
        const reasoning = (firstChoice.delta as ReasoningDelta)?.reasoning_content || '';
        const text = delta || reasoning;

        if (text) {
          content += text;
          request.onProgress(text);
        }

        if (firstChoice.finish_reason) {
          finishReason = firstChoice.finish_reason;
        }
      }

      return {
        content,
        model,
        finishReason,
      };
    }

    // Non-streaming mode
    const createParams: OpenAI.ChatCompletionCreateParamsNonStreaming = {
      model,
      messages,
      max_tokens: request.maxTokens ?? 8192,
      temperature: request.temperature ?? 0.7,
    };

    if (request.tools?.length) {
      (createParams as unknown as Record<string, unknown>).tools = request.tools;
      if (request.toolChoice)
        (createParams as unknown as Record<string, unknown>).tool_choice = request.toolChoice;
    }

    const response: ChatCompletion = await openai.chat.completions.create(createParams);

    const choice = response.choices?.[0];
    if (!choice) {
      // Thinking models may return content outside choices array — check raw response
      const raw = response as unknown as Record<string, unknown>;
      const rawContent = typeof raw.content === 'string' ? raw.content : '';
      if (rawContent) {
        return { content: rawContent, model, finishReason: 'stop' };
      }
      throw new Error(`Empty choices array from model ${model} — the model may use a non-standard response format`);
    }
    // Handle reasoning models (DeepSeek, Kimi, etc.)
    const message = choice.message as ReasoningMessage | undefined;
    const content = message?.content || message?.reasoning_content || '';

    // Extract tool calls from response
    const rawToolCalls = choice?.message?.tool_calls as
      | Array<{ id: string; type: string; function: { name: string; arguments: string } }>
      | undefined;
    const toolCalls: ToolCallResult[] | undefined = rawToolCalls
      ?.filter((tc) => tc.type === 'function' && tc.function)
      .map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.function.name, arguments: tc.function.arguments },
      }));

    const usage = response.usage
      ? {
          promptTokens: response.usage.prompt_tokens,
          completionTokens: response.usage.completion_tokens,
          totalTokens: response.usage.total_tokens,
        }
      : undefined;

    if (usage) recordTokenUsage(usage);

    return {
      content,
      model: response.model,
      usage,
      finishReason: choice?.finish_reason || undefined,
      toolCalls: toolCalls?.length ? toolCalls : undefined,
    };
  } catch (error) {
    // Try fallback model if primary fails (max 1 attempt to prevent infinite recursion)
    if (currentConfig?.fallbackModel && request.model !== currentConfig.fallbackModel) {
      if ((request as CompletionRequest)._fallbackAttempt) {
        // Already tried fallback once — don't recurse further
        if (error instanceof OpenAI.APIError) {
          throw new AIError(`API error: ${error.status} ${error.message}`, error.status);
        }
        throw error;
      }
      Logger.warn(`Primary model failed, trying fallback: ${currentConfig.fallbackModel}`);
      return complete({
        ...request,
        model: currentConfig.fallbackModel,
        _fallbackAttempt: true,
      } as CompletionRequest);
    }

    if (error instanceof OpenAI.APIError) {
      throw new AIError(`API error: ${error.status} ${error.message}`, error.status);
    }
    throw error;
  }
}

/**
 * Test connection to the API
 */
export async function testConnection(): Promise<{ success: boolean; message: string }> {
  try {
    const openai = getAIClient();
    const model = currentConfig?.defaultModel;

    if (!model) {
      return {
        success: false,
        message: 'No model configured. Use: ai-config --action set --primaryModel <model>',
      };
    }

    const response = await openai.chat.completions.create({
      model,
      messages: [{ role: 'user', content: 'Say OK' }],
      max_tokens: 5,
    });

    const message = response.choices?.[0]?.message as ReasoningMessage | undefined;
    const content = message?.content || message?.reasoning_content || '';

    return {
      success: true,
      message: `Connection OK. Model: ${response.model}, Response: ${content.substring(0, 50)}`,
    };
  } catch (error) {
    if (error instanceof OpenAI.APIError) {
      return {
        success: false,
        message: `API error: ${error.status} ${error.message}`,
      };
    }
    return {
      success: false,
      message: `Connection failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
}

// Legacy exports for backward compatibility
export { AIError as AIClientError };
export type { AIClientConfig as AIClientOptions };
