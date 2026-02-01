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

/**
 * AI Model Pricing Database
 *
 * Maintains pricing information for common AI models across providers.
 * Used for cost-optimized model selection via ai-models --action auto-select.
 *
 * @module ai/pricing
 */

import type { ProviderId } from './providers/types.js';
import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { Logger } from '../utils/logger.js';

/** Model capability classifications */
export type ModelCapability =
  | 'chat'
  | 'code'
  | 'vision'
  | 'function-calling'
  | 'json-mode'
  | 'thinking'
  | 'long-context';

/** Pricing info for a single model */
export interface ModelPricing {
  modelId: string;
  provider: ProviderId;
  inputPricePerMToken: number;
  outputPricePerMToken: number;
  capabilities: ModelCapability[];
  contextWindow: number;
  speed: 'fast' | 'medium' | 'slow';
  lastUpdated: string;
}

/**
 * Built-in pricing database (as of Jan 2025).
 * Override via ~/.kemdicode/pricing.json
 */
export const PRICING_DATABASE: ModelPricing[] = [
  // OpenAI
  {
    modelId: 'gpt-4o',
    provider: 'openai',
    inputPricePerMToken: 2.5,
    outputPricePerMToken: 10.0,
    capabilities: ['chat', 'code', 'vision', 'function-calling', 'json-mode'],
    contextWindow: 128_000,
    speed: 'fast',
    lastUpdated: '2025-01-15',
  },
  {
    modelId: 'gpt-4o-mini',
    provider: 'openai',
    inputPricePerMToken: 0.15,
    outputPricePerMToken: 0.6,
    capabilities: ['chat', 'code', 'function-calling', 'json-mode'],
    contextWindow: 128_000,
    speed: 'fast',
    lastUpdated: '2025-01-15',
  },
  {
    modelId: 'o3',
    provider: 'openai',
    inputPricePerMToken: 10.0,
    outputPricePerMToken: 40.0,
    capabilities: ['chat', 'code', 'thinking', 'function-calling'],
    contextWindow: 200_000,
    speed: 'slow',
    lastUpdated: '2025-01-15',
  },
  {
    modelId: 'o3-mini',
    provider: 'openai',
    inputPricePerMToken: 1.1,
    outputPricePerMToken: 4.4,
    capabilities: ['chat', 'code', 'thinking', 'function-calling'],
    contextWindow: 200_000,
    speed: 'medium',
    lastUpdated: '2025-01-15',
  },

  // Anthropic
  {
    modelId: 'claude-sonnet-4-20250514',
    provider: 'anthropic',
    inputPricePerMToken: 3.0,
    outputPricePerMToken: 15.0,
    capabilities: ['chat', 'code', 'vision', 'function-calling', 'thinking', 'long-context'],
    contextWindow: 200_000,
    speed: 'medium',
    lastUpdated: '2025-05-14',
  },
  {
    modelId: 'claude-opus-4-20250514',
    provider: 'anthropic',
    inputPricePerMToken: 15.0,
    outputPricePerMToken: 75.0,
    capabilities: ['chat', 'code', 'vision', 'function-calling', 'thinking', 'long-context'],
    contextWindow: 200_000,
    speed: 'slow',
    lastUpdated: '2025-05-14',
  },
  {
    modelId: 'claude-3-5-haiku-20241022',
    provider: 'anthropic',
    inputPricePerMToken: 0.8,
    outputPricePerMToken: 4.0,
    capabilities: ['chat', 'code', 'function-calling'],
    contextWindow: 200_000,
    speed: 'fast',
    lastUpdated: '2024-10-22',
  },

  // Google Gemini
  {
    modelId: 'gemini-2.0-flash',
    provider: 'gemini',
    inputPricePerMToken: 0.1,
    outputPricePerMToken: 0.4,
    capabilities: ['chat', 'code', 'vision', 'function-calling', 'thinking', 'long-context'],
    contextWindow: 1_000_000,
    speed: 'fast',
    lastUpdated: '2025-01-15',
  },
  {
    modelId: 'gemini-2.5-flash',
    provider: 'gemini',
    inputPricePerMToken: 0.15,
    outputPricePerMToken: 0.6,
    capabilities: ['chat', 'code', 'vision', 'function-calling', 'thinking', 'long-context'],
    contextWindow: 1_000_000,
    speed: 'fast',
    lastUpdated: '2025-03-01',
  },
  {
    modelId: 'gemini-2.5-pro',
    provider: 'gemini',
    inputPricePerMToken: 1.25,
    outputPricePerMToken: 10.0,
    capabilities: ['chat', 'code', 'vision', 'function-calling', 'thinking', 'long-context'],
    contextWindow: 1_000_000,
    speed: 'medium',
    lastUpdated: '2025-03-01',
  },

  // Groq
  {
    modelId: 'llama-3.3-70b-versatile',
    provider: 'groq',
    inputPricePerMToken: 0.59,
    outputPricePerMToken: 0.79,
    capabilities: ['chat', 'code', 'function-calling'],
    contextWindow: 128_000,
    speed: 'fast',
    lastUpdated: '2025-01-15',
  },
  {
    modelId: 'llama-3.1-8b-instant',
    provider: 'groq',
    inputPricePerMToken: 0.05,
    outputPricePerMToken: 0.08,
    capabilities: ['chat', 'code'],
    contextWindow: 128_000,
    speed: 'fast',
    lastUpdated: '2025-01-15',
  },

  // DeepSeek
  {
    modelId: 'deepseek-chat',
    provider: 'deepseek',
    inputPricePerMToken: 0.14,
    outputPricePerMToken: 0.28,
    capabilities: ['chat', 'code', 'function-calling', 'json-mode'],
    contextWindow: 64_000,
    speed: 'medium',
    lastUpdated: '2025-01-15',
  },
  {
    modelId: 'deepseek-reasoner',
    provider: 'deepseek',
    inputPricePerMToken: 0.55,
    outputPricePerMToken: 2.19,
    capabilities: ['chat', 'code', 'thinking'],
    contextWindow: 64_000,
    speed: 'slow',
    lastUpdated: '2025-01-15',
  },

  // Ollama (local — no cost)
  {
    modelId: 'llama3.2:latest',
    provider: 'ollama',
    inputPricePerMToken: 0,
    outputPricePerMToken: 0,
    capabilities: ['chat', 'code'],
    contextWindow: 8192,
    speed: 'medium',
    lastUpdated: '2025-01-15',
  },
  {
    modelId: 'codellama:latest',
    provider: 'ollama',
    inputPricePerMToken: 0,
    outputPricePerMToken: 0,
    capabilities: ['code'],
    contextWindow: 16384,
    speed: 'medium',
    lastUpdated: '2025-01-15',
  },
  {
    modelId: 'deepseek-coder:latest',
    provider: 'ollama',
    inputPricePerMToken: 0,
    outputPricePerMToken: 0,
    capabilities: ['chat', 'code'],
    contextWindow: 16384,
    speed: 'medium',
    lastUpdated: '2025-01-15',
  },

  // OpenRouter (popular models)
  {
    modelId: 'openrouter/auto',
    provider: 'openrouter',
    inputPricePerMToken: 1.0,
    outputPricePerMToken: 3.0,
    capabilities: ['chat', 'code', 'function-calling'],
    contextWindow: 128_000,
    speed: 'medium',
    lastUpdated: '2025-01-15',
  },
];

/**
 * Calculate cost-effectiveness score for a model.
 * Lower is better (cheaper). Weighted: 60% input, 40% output.
 */
export function calculateCostScore(pricing: ModelPricing): number {
  return pricing.inputPricePerMToken * 0.6 + pricing.outputPricePerMToken * 0.4;
}

/**
 * Rank models by cost-effectiveness, optionally filtering by capabilities.
 */
export function rankModelsByCost(
  models: ModelPricing[],
  requiredCapabilities: ModelCapability[] = [],
  maxCostPerMToken?: number
): ModelPricing[] {
  let filtered = models;

  // Filter by capabilities
  if (requiredCapabilities.length > 0) {
    filtered = filtered.filter((m) =>
      requiredCapabilities.every((cap) => m.capabilities.includes(cap))
    );
  }

  // Filter by max cost
  if (maxCostPerMToken !== undefined) {
    filtered = filtered.filter((m) => calculateCostScore(m) <= maxCostPerMToken);
  }

  // Sort by cost score ascending (cheapest first)
  return [...filtered].sort((a, b) => calculateCostScore(a) - calculateCostScore(b));
}

/**
 * Load custom pricing overrides from ~/.kemdicode/pricing.json
 * Merges with built-in database (custom entries override by modelId+provider).
 */
export function loadPricingDatabase(): ModelPricing[] {
  const customPath = join(homedir(), '.kemdicode', 'pricing.json');

  try {
    const raw = readFileSync(customPath, 'utf-8');
    const custom: ModelPricing[] = JSON.parse(raw);

    if (!Array.isArray(custom)) return PRICING_DATABASE;

    // Merge: custom overrides built-in by modelId+provider key
    const merged = new Map<string, ModelPricing>();
    for (const entry of PRICING_DATABASE) {
      merged.set(`${entry.provider}:${entry.modelId}`, entry);
    }
    for (const entry of custom) {
      merged.set(`${entry.provider}:${entry.modelId}`, entry);
    }

    return Array.from(merged.values());
  } catch {
    // No custom file or parse error — use built-in
    return PRICING_DATABASE;
  }
}

/**
 * Format a pricing entry for display.
 */
export function formatPricingEntry(entry: ModelPricing, rank: number): string {
  const cost = calculateCostScore(entry);
  return (
    `${rank}. ${entry.modelId} (${entry.provider})\n` +
    `   Cost score: $${cost.toFixed(4)}/M tokens\n` +
    `   Input: $${entry.inputPricePerMToken}/M | Output: $${entry.outputPricePerMToken}/M\n` +
    `   Capabilities: ${entry.capabilities.join(', ')}\n` +
    `   Context: ${(entry.contextWindow / 1000).toFixed(0)}K | Speed: ${entry.speed}`
  );
}
