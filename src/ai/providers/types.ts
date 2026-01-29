/**
 * KemdiCode MCP Server - Multi-Provider Types
 * Interfaces and constants for multi-provider LLM support.
 *
 * @license GPL-3.0
 */

import type { Message, CompletionResponse } from '../client.js';

/** Supported LLM provider identifiers */
export type ProviderId =
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'groq'
  | 'deepseek'
  | 'ollama'
  | 'openrouter';

/** Short aliases for provider prefixes */
export const PROVIDER_ALIASES: Record<string, ProviderId> = {
  o: 'openai',
  a: 'anthropic',
  g: 'gemini',
  q: 'groq',
  d: 'deepseek',
  l: 'ollama',
  r: 'openrouter',
};

/** All recognized provider names (full + short) */
export const ALL_PROVIDER_NAMES = new Set<string>([
  'openai',
  'anthropic',
  'gemini',
  'groq',
  'deepseek',
  'ollama',
  'openrouter',
  ...Object.keys(PROVIDER_ALIASES),
]);

/** Default base URLs per provider */
export const PROVIDER_BASE_URLS: Record<ProviderId, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  gemini: 'https://generativelanguage.googleapis.com',
  groq: 'https://api.groq.com/openai/v1',
  deepseek: 'https://api.deepseek.com/v1',
  ollama: 'http://localhost:11434/v1',
  openrouter: 'https://openrouter.ai/api/v1',
};

/** Environment variable names for API keys per provider */
export const PROVIDER_ENV_KEYS: Record<ProviderId, string[]> = {
  openai: ['OPENAI_API_KEY', 'KEMDICODE_OPENAI_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY', 'KEMDICODE_ANTHROPIC_API_KEY'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'KEMDICODE_GEMINI_API_KEY'],
  groq: ['GROQ_API_KEY', 'KEMDICODE_GROQ_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY', 'KEMDICODE_DEEPSEEK_API_KEY'],
  ollama: [], // No API key needed
  openrouter: ['OPENROUTER_API_KEY', 'KEMDICODE_OPENROUTER_API_KEY'],
};

/** Provider display names */
export const PROVIDER_DISPLAY_NAMES: Record<ProviderId, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  gemini: 'Google Gemini',
  groq: 'Groq',
  deepseek: 'DeepSeek',
  ollama: 'Ollama (local)',
  openrouter: 'OpenRouter',
};

/** Thinking/reasoning configuration parsed from model spec */
export interface ThinkingConfig {
  /** OpenAI o-series reasoning effort: low | medium | high */
  reasoningEffort?: 'low' | 'medium' | 'high';
  /** Anthropic/Gemini thinking token budget */
  thinkingBudget?: number;
}

/** Configuration for a single provider instance */
export interface ProviderConfig {
  id: ProviderId;
  apiKey: string;
  baseURL?: string;
}

/** Unified completion request sent to any provider */
export interface UnifiedCompletionRequest {
  provider: ProviderId;
  model: string;
  messages: Message[];
  maxTokens?: number;
  temperature?: number;
  thinking?: ThinkingConfig;
  stream?: boolean;
  onProgress?: (chunk: string) => void;
}

/** Provider adapter interface - each provider implements this */
export interface LLMProvider {
  readonly id: ProviderId;

  /** Initialize the provider with config */
  init(config: ProviderConfig): void;

  /** Execute a completion */
  complete(request: UnifiedCompletionRequest): Promise<CompletionResponse>;

  /** List available models (if API supports it) */
  listModels?(): Promise<Array<{ id: string; name?: string }>>;

  /** Whether this provider has been initialized */
  isInitialized(): boolean;
}
