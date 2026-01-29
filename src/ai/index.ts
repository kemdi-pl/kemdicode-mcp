/**
 * KemdiCode MCP Server - AI Module
 * OpenAI SDK integration for OpenAI-compatible APIs
 *
 * @license GPL-3.0
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
  type ProviderId,
  type LLMProvider,
  type ThinkingConfig,
  type UnifiedCompletionRequest,
  type ProviderConfig,
  PROVIDER_ALIASES,
  PROVIDER_BASE_URLS,
  PROVIDER_ENV_KEYS,
  PROVIDER_DISPLAY_NAMES,
} from './providers/index.js';
