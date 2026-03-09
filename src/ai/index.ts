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

// Client (OpenAI SDK wrapper)
export {
  initAIClient,
  getAIClient,
  getClientConfig,
  updateClientConfig,
  complete,
  testConnection,
  AIError,
  type AIClientConfig,
  type CompletionRequest,
  type CompletionResponse,
  type Message,
} from './client.js';

// Agents
export {
  AGENTS,
  getAgentConfig,
  buildAgentMessages,
  getAgentTemperature,
  getAgentMaxTokens,
  type AgentType,
  type AgentConfig,
} from './agents.js';

// File context
export {
  loadFileContext,
  loadFileContexts,
  formatFileContextForPrompt,
  loadAndFormatFiles,
  parseFilePath,
  parseFiles,
  detectLanguage,
  type FileContext,
} from './file-context.js';

// Execute (main function)
export {
  executeAI,
  executeAIWithResult,
  clearSessionHistory,
  getSessionHistorySize,
  type ExecuteAIOptions,
  type ExecuteAIResult,
} from './execute.js';

// Workspace Editor (OpenAI Agents SDK integration)
export {
  WorkspaceEditor,
  createWorkspaceEditor,
  type WorkspaceEditorOptions,
} from './workspace-editor.js';

// Model spec parser
export { parseModelSpec, hasProviderPrefix, type ModelSpec } from './model-spec.js';

// Multi-provider support
export {
  registerBuiltinProviders,
  getProvider,
  isProviderAvailable,
  listProviders,
  setProviderConfig,
  registerCustomEndpoint,
  registerCustomEndpoints,
  deregisterCustomEndpoint,
  getCustomEndpoint,
  listCustomEndpoints,
  isCustomProvider,
  customProviderName,
  type ProviderId,
  type BuiltinProviderId,
  type CustomEndpointConfig,
  type LLMProvider,
  type ThinkingConfig,
  type UnifiedCompletionRequest,
  type ProviderConfig,
  PROVIDER_ALIASES,
  PROVIDER_BASE_URLS,
  PROVIDER_ENV_KEYS,
  PROVIDER_DISPLAY_NAMES,
} from './providers/index.js';
