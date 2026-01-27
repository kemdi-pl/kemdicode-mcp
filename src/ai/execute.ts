/**
 * KemdiCode MCP Server - AI Execute
 * Drop-in replacement for executeAI
 *
 * @license GPL-3.0
 */

import { complete, getClientConfig } from './client.js';
import {
  buildAgentMessages,
  getAgentTemperature,
  getAgentMaxTokens,
  type AgentType,
} from './agents.js';
import { loadFileContexts, formatFileContextForPrompt } from './file-context.js';

export interface ExecuteAIOptions {
  /** The prompt/question for the AI */
  prompt: string;

  /** Agent type: plan, build, explore, or general */
  agent: AgentType;

  /** Optional model override (format: "provider/model" or just "model") */
  model?: string;

  /** File paths to include as context (supports @path/file syntax) */
  files?: string[];

  /** Continue previous session (currently stores in-memory per session) */
  continueSession?: boolean;

  /** Session ID for conversation continuity */
  sessionId?: string;

  /** Project root for resolving relative file paths */
  projectRoot?: string;

  /** Progress callback for streaming responses */
  onProgress?: (output: string) => void;

  /** Override temperature */
  temperature?: number;

  /** Override max tokens */
  maxTokens?: number;
}

export interface ExecuteAIResult {
  /** AI response content */
  content: string;

  /** Model used for completion */
  model: string;

  /** Token usage (if available) */
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };

  /** Time taken in milliseconds */
  duration: number;
}

// Simple in-memory session storage for conversation history
const sessionHistory = new Map<string, Array<{ role: 'user' | 'assistant'; content: string }>>();

/**
 * Execute AI completion - drop-in replacement for executeAI
 *
 * @example
 * ```typescript
 * const result = await executeAI({
 *   prompt: "Review this code for security issues",
 *   agent: 'plan',
 *   files: ['src/auth.ts'],
 *   onProgress: (chunk) => console.log(chunk),
 * });
 * ```
 */
export async function executeAI(options: ExecuteAIOptions): Promise<string> {
  const config = getClientConfig();
  if (!config) {
    throw new Error('AI client not initialized. Call initAIClient() first.');
  }

  const startTime = Date.now();

  const {
    prompt,
    agent,
    model,
    files,
    continueSession,
    sessionId,
    projectRoot,
    onProgress,
    temperature,
    maxTokens,
  } = options;

  // Load file contents if specified
  let fileContext = '';
  if (files?.length) {
    const fileContexts = await loadFileContexts(files, projectRoot || process.cwd());
    fileContext = formatFileContextForPrompt(fileContexts);
  }

  // Get conversation history if continuing session
  let history: Array<{ role: 'user' | 'assistant'; content: string }> | undefined;
  const historyKey = sessionId || 'default';
  if (continueSession) {
    history = sessionHistory.get(historyKey);
  }

  // Build messages
  const messages = buildAgentMessages(agent, prompt, fileContext, history);

  // Execute completion using OpenAI SDK
  const response = await complete({
    model,
    messages,
    stream: !!onProgress,
    temperature: temperature ?? getAgentTemperature(agent),
    maxTokens: maxTokens ?? getAgentMaxTokens(agent),
    onProgress,
  });

  // Store conversation for session continuity
  if (sessionId || continueSession) {
    const currentHistory = sessionHistory.get(historyKey) || [];
    currentHistory.push({ role: 'user', content: prompt });
    currentHistory.push({ role: 'assistant', content: response.content });

    // Keep last 10 exchanges to prevent unbounded growth
    if (currentHistory.length > 20) {
      currentHistory.splice(0, currentHistory.length - 20);
    }

    sessionHistory.set(historyKey, currentHistory);
  }

  const duration = Date.now() - startTime;

  // Log completion stats
  console.log(
    `[AI] ${agent} agent completed in ${duration}ms` +
      (response.usage ? ` (${response.usage.totalTokens} tokens)` : '')
  );

  return response.content;
}

/**
 * Execute AI completion with full result metadata
 */
export async function executeAIWithResult(options: ExecuteAIOptions): Promise<ExecuteAIResult> {
  const config = getClientConfig();
  if (!config) {
    throw new Error('AI client not initialized. Call initAIClient() first.');
  }

  const startTime = Date.now();

  const {
    prompt,
    agent,
    model,
    files,
    continueSession,
    sessionId,
    projectRoot,
    onProgress,
    temperature,
    maxTokens,
  } = options;

  // Load file contents if specified
  let fileContext = '';
  if (files?.length) {
    const fileContexts = await loadFileContexts(files, projectRoot || process.cwd());
    fileContext = formatFileContextForPrompt(fileContexts);
  }

  // Get conversation history if continuing session
  let history: Array<{ role: 'user' | 'assistant'; content: string }> | undefined;
  const historyKey = sessionId || 'default';
  if (continueSession) {
    history = sessionHistory.get(historyKey);
  }

  // Build messages
  const messages = buildAgentMessages(agent, prompt, fileContext, history);

  // Execute completion using OpenAI SDK
  const response = await complete({
    model,
    messages,
    stream: !!onProgress,
    temperature: temperature ?? getAgentTemperature(agent),
    maxTokens: maxTokens ?? getAgentMaxTokens(agent),
    onProgress,
  });

  const duration = Date.now() - startTime;

  return {
    content: response.content,
    model: response.model,
    usage: response.usage,
    duration,
  };
}

/**
 * Clear session history
 */
export function clearSessionHistory(sessionId?: string): void {
  if (sessionId) {
    sessionHistory.delete(sessionId);
  } else {
    sessionHistory.clear();
  }
}

/**
 * Get session history size
 */
export function getSessionHistorySize(sessionId?: string): number {
  if (sessionId) {
    return sessionHistory.get(sessionId)?.length || 0;
  }
  return sessionHistory.size;
}

// Re-export parseFiles for compatibility with existing tools
export { parseFiles } from './file-context.js';
