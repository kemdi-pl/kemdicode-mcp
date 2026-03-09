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

import { GoogleGenAI } from '@google/genai';
import type { CompletionResponse } from '../client.js';
import type { LLMProvider, ProviderConfig, UnifiedCompletionRequest } from './types.js';
import { Logger } from '../../utils/logger.js';

export class GeminiProvider implements LLMProvider {
  readonly id = 'gemini' as const;
  private client: GoogleGenAI | null = null;

  init(config: ProviderConfig): void {
    this.client = new GoogleGenAI({
      apiKey: config.apiKey,
      httpOptions: { timeout: 120_000 },
    });
    Logger.info(`Gemini provider initialized`);
  }

  isInitialized(): boolean {
    return this.client !== null;
  }

  async complete(request: UnifiedCompletionRequest): Promise<CompletionResponse> {
    if (!this.client) throw new Error('Gemini provider not initialized');

    // Build contents from messages
    let systemInstruction: string | undefined;
    const contents: Array<{ role: string; parts: Array<{ text: string }> }> = [];

    for (const msg of request.messages) {
      if (msg.role === 'system') {
        systemInstruction = msg.content;
      } else {
        contents.push({
          role: msg.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: msg.content }],
        });
      }
    }

    // Build config
    const config: Record<string, unknown> = {
      maxOutputTokens: request.maxTokens ?? 8192,
    };

    if (request.temperature !== undefined) {
      config.temperature = request.temperature;
    }

    // Add thinking budget
    if (request.thinking?.thinkingBudget && request.thinking.thinkingBudget > 0) {
      config.thinkingConfig = {
        thinkingBudget: request.thinking.thinkingBudget,
      };
    }

    if (systemInstruction) {
      config.systemInstruction = systemInstruction;
    }

    try {
      const response = await this.client.models.generateContent({
        model: request.model,
        contents,
        config,
      });

      let content = '';
      let thinkingContent = '';

      if (response.candidates && response.candidates.length > 0) {
        const candidate = response.candidates[0];
        if (candidate.content?.parts) {
          for (const part of candidate.content.parts) {
            if (part.thought) {
              thinkingContent += part.text || '';
            } else {
              content += part.text || '';
            }
          }
        }
      }

      // Fallback to response.text if no content extracted
      if (!content && response.text) {
        content = response.text;
      }

      const fullContent = thinkingContent
        ? `<thinking>\n${thinkingContent}\n</thinking>\n\n${content}`
        : content;

      return {
        content: fullContent,
        model: request.model,
        usage: response.usageMetadata
          ? {
              promptTokens: response.usageMetadata.promptTokenCount ?? 0,
              completionTokens: response.usageMetadata.candidatesTokenCount ?? 0,
              totalTokens: response.usageMetadata.totalTokenCount ?? 0,
            }
          : undefined,
        finishReason: response.candidates?.[0]?.finishReason || undefined,
      };
    } catch (error) {
      throw new Error(
        `Gemini API error: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
  }

  async listModels(): Promise<Array<{ id: string; name?: string }>> {
    if (!this.client) throw new Error('Gemini provider not initialized');

    const response = await this.client.models.list();
    const models: Array<{ id: string; name?: string }> = [];

    for (const model of response.page) {
      if (model.name) {
        models.push({
          id: model.name.replace('models/', ''),
          name: model.displayName || undefined,
        });
      }
    }
    return models;
  }
}
