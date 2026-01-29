/**
 * KemdiCode MCP Server - Model Spec Parser
 * Parses model strings like "provider:model:thinking" into structured specs.
 *
 * Examples:
 *   "gpt-4o"                         → { provider: default, model: 'gpt-4o' }
 *   "openai:gpt-4o"                  → { provider: 'openai', model: 'gpt-4o' }
 *   "o:o3:high"                      → { provider: 'openai', model: 'o3', thinking: { reasoningEffort: 'high' } }
 *   "a:claude-sonnet-4-20250514:4k"  → { provider: 'anthropic', model: '...', thinking: { thinkingBudget: 4096 } }
 *   "g:gemini-2.5-flash:8k"          → { provider: 'gemini', model: '...', thinking: { thinkingBudget: 8192 } }
 *
 * @license GPL-3.0
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
  return resolveProvider(firstSegment) !== undefined;
}

/**
 * Parse a model specification string into a structured ModelSpec.
 *
 * @param input - Model string (e.g., "openai:gpt-4o", "a:claude-sonnet-4-20250514:4k", "gpt-4o")
 * @param defaultProvider - Provider to use when no prefix is present (defaults to 'openai')
 */
export function parseModelSpec(
  input: string,
  defaultProvider: ProviderId = 'openai'
): ModelSpec {
  if (!input || !input.trim()) {
    return { provider: defaultProvider, model: '', raw: input };
  }

  const trimmed = input.trim();
  const parts = trimmed.split(':');

  // Single segment → no provider prefix, use default
  if (parts.length === 1) {
    return { provider: defaultProvider, model: parts[0], raw: trimmed };
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
