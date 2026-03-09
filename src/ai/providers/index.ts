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

export type {
  BuiltinProviderId,
  ProviderId,
  ModelTier,
  ThinkingConfig,
  ProviderConfig,
  CustomEndpointConfig,
  UnifiedCompletionRequest,
  LLMProvider,
} from './types.js';

export {
  PROVIDER_ALIASES,
  ALL_PROVIDER_NAMES,
  PROVIDER_BASE_URLS,
  PROVIDER_ENV_KEYS,
  PROVIDER_DISPLAY_NAMES,
} from './types.js';

export {
  registerBuiltinProviders,
  setProviderConfig,
  getProvider,
  isProviderAvailable,
  listProviders,
  registerCustomEndpoint,
  registerCustomEndpoints,
  deregisterCustomEndpoint,
  getCustomEndpoint,
  listCustomEndpoints,
  isCustomProvider,
  customProviderName,
} from './registry.js';

export { OpenAIProvider } from './openai.provider.js';
export { AnthropicProvider } from './anthropic.provider.js';
export { GeminiProvider } from './gemini.provider.js';
export { createOpenAICompatProvider } from './openai-compat.provider.js';
