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

import {
  type ProviderId,
  type ThinkingConfig,
  PROVIDER_ALIASES,
  ALL_PROVIDER_NAMES,
} from './providers/types.js';

/** Parsed model specification */
export interface ModelSpec {
  provider: ProviderId;
  model: string;
  thinking?: ThinkingConfig;
  raw: string;
}

/** Check if a provider string is a custom endpoint reference */
function isCustomPrefix(segment: string): boolean {
  return segment.toLowerCase() === 'custom';
}

const REASONING_EFFORTS = new Set(['low', 'medium', 'high']);

/**
 * Parse a thinking/reasoning suffix.
 * - "low" | "medium" | "high" → reasoningEffort (OpenAI o-series)
 * - "4k" | "4096" → thinkingBudget (Anthropic/Gemini)
 */
function parseThinkingSuffix(suffix: string): ThinkingConfig | undefined {
  if (!suffix) return undefined;

  const lower = suffix.toLowerCase();

  // OpenAI reasoning effort
  if (REASONING_EFFORTS.has(lower)) {
    return { reasoningEffort: lower as 'low' | 'medium' | 'high' };
  }

  // Thinking budget: "4k" → 4096, "16384" → 16384
  const kMatch = lower.match(/^(\d+)k$/);
  if (kMatch) {
    return { thinkingBudget: parseInt(kMatch[1], 10) * 1024 };
  }

  const numMatch = lower.match(/^(\d+)$/);
  if (numMatch) {
    return { thinkingBudget: parseInt(numMatch[1], 10) };
  }

  return undefined;
}

/**
 * Resolve a provider name (full or alias) to a ProviderId.
 * Returns undefined if the segment is not a recognized provider.
 */
function resolveProvider(segment: string): ProviderId | undefined {
  const lower = segment.toLowerCase();
  if (PROVIDER_ALIASES[lower]) return PROVIDER_ALIASES[lower];
  if (ALL_PROVIDER_NAMES.has(lower)) return lower as ProviderId;
  return undefined;
}

/**
 * Check if a model string contains a provider prefix.
 */
export function hasProviderPrefix(input: string): boolean {
  if (!input || !input.includes(':')) return false;
  const firstSegment = input.split(':')[0];
  return resolveProvider(firstSegment) !== undefined || isCustomPrefix(firstSegment);
}

/**
 * Parse a model specification string into a structured ModelSpec.
 *
 * @param input - Model string (e.g., "openai:gpt-4.1", "a:claude-sonnet-4-6:4k", "gpt-4.1")
 * @param defaultProvider - Provider to use when no prefix is present (defaults to 'openai')
 */
/** Maximum length for a model spec string to prevent DoS */
const MAX_MODEL_SPEC_LENGTH = 512;

export function parseModelSpec(
  input: string,
  defaultProvider: ProviderId = 'openai'
): ModelSpec {
  if (!input || !input.trim()) {
    return { provider: defaultProvider, model: '', raw: input };
  }

  const trimmed = input.trim();

  if (trimmed.length > MAX_MODEL_SPEC_LENGTH) {
    throw new Error(`Model spec too long (${trimmed.length} > ${MAX_MODEL_SPEC_LENGTH})`);
  }
  const parts = trimmed.split(':');

  // Single segment → no provider prefix, use default
  if (parts.length === 1) {
    return { provider: defaultProvider, model: parts[0], raw: trimmed };
  }

  // Custom endpoint: custom:<endpoint-name>:<model>[:<thinking>]
  // Provider ID becomes "custom:<endpoint-name>", model is the rest
  if (isCustomPrefix(parts[0]) && parts.length >= 3) {
    const endpointName = parts[1];
    const customProviderId: ProviderId = `custom:${endpointName}`;

    if (parts.length === 3) {
      return { provider: customProviderId, model: parts[2], raw: trimmed };
    }

    // custom:name:model:thinking
    if (parts.length === 4) {
      const thinking = parseThinkingSuffix(parts[3]);
      return { provider: customProviderId, model: parts[2], thinking, raw: trimmed };
    }

    // custom:name:model-with-colons...
    const lastPart = parts[parts.length - 1];
    const thinking = parseThinkingSuffix(lastPart);
    if (thinking) {
      const model = parts.slice(2, -1).join(':');
      return { provider: customProviderId, model, thinking, raw: trimmed };
    }
    const model = parts.slice(2).join(':');
    return { provider: customProviderId, model, raw: trimmed };
  }

  // Check if first segment is a known provider
  const provider = resolveProvider(parts[0]);

  if (!provider) {
    // Not a recognized provider prefix → treat entire string as model name
    // This handles model names that contain colons (rare but possible)
    return { provider: defaultProvider, model: trimmed, raw: trimmed };
  }

  // provider:model
  if (parts.length === 2) {
    return { provider, model: parts[1], raw: trimmed };
  }

  // provider:model:thinking
  if (parts.length === 3) {
    const thinking = parseThinkingSuffix(parts[2]);
    return { provider, model: parts[1], thinking, raw: trimmed };
  }

  // provider:model-with-colons:... (more than 3 parts)
  // Join everything after the first part as the model, check if last part is thinking
  const lastPart = parts[parts.length - 1];
  const thinking = parseThinkingSuffix(lastPart);

  if (thinking) {
    // Last part was thinking config → model is everything in between
    const model = parts.slice(1, -1).join(':');
    return { provider, model, thinking, raw: trimmed };
  }

  // No thinking suffix → model is everything after provider
  const model = parts.slice(1).join(':');
  return { provider, model, raw: trimmed };
}
