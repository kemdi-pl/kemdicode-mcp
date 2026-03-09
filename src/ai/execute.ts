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

import { complete, getClientConfig } from './client.js';
import type { Message, CompletionResponse } from './client.js';
import type { FunctionTool } from './providers/types.js';
import { hasProviderPrefix } from './model-spec.js';
import { routeToolExecution } from './routing.js';
import {
  buildAgentMessages,
  getAgentTemperature,
  getAgentMaxTokens,
  type AgentType,
} from './agents.js';
import { loadFileContexts, formatFileContextForPrompt } from './file-context.js';
import { enhancePrompt as runPromptEnhancer, type EnhancerOptions, type EnhancerResult } from './prompt-enhancer.js';
import { Logger } from '../utils/logger.js';
import { rankByPerturbationImpact } from '../cognition/ctc-math.js';

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

  /** Override system prompt (replaces agent's default system prompt) */
  systemPrompt?: string;

  /** Enable prompt enhancement ("first step") before sending to LLM.
   *  Pass true for defaults, or EnhancerOptions for fine control. */
  enhancePrompt?: boolean | EnhancerOptions;
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

// Simple in-memory session storage for conversation history with LRU eviction
const SESSION_HISTORY_MAX = 100;
const sessionHistory = new Map<string, Array<{ role: 'user' | 'assistant'; content: string }>>();

/**
 * Shared preparation logic for AI execution
 */
async function prepareAndExecute(options: ExecuteAIOptions) {
  const config = getClientConfig();
  // Allow provider-prefixed models (e.g. "anthropic:claude-...") to work without
  // initAIClient(). The multi-provider path in complete() does not require the
  // OpenAI SDK client.
  if (!config && !(options.model && hasProviderPrefix(options.model))) {
    throw new Error('AI client not initialized. Call initAIClient() first.');
  }

  const startTime = Date.now();
  let { prompt, files } = options;
  const { agent, model, continueSession, sessionId, projectRoot, onProgress, temperature, maxTokens, systemPrompt } = options;
  const { enhancePrompt: enhanceOpt } = options;

  // Prompt enhancement ("first step") — rewrite vague prompts before LLM call
  let enhancerResult: EnhancerResult | undefined;
  if (enhanceOpt && !systemPrompt && agent !== 'explore') {
    const enhancerOpts: EnhancerOptions = typeof enhanceOpt === 'object' ? enhanceOpt : {};
    if (!enhancerOpts.projectRoot) enhancerOpts.projectRoot = projectRoot || process.cwd();
    try {
      enhancerResult = await runPromptEnhancer(prompt, enhancerOpts);
      if (!enhancerResult.skipped) {
        prompt = enhancerResult.enhanced;
        // Use enhancer-suggested files if caller didn't provide any
        if (enhancerResult.filesLoaded.length > 0 && !files?.length) {
          files = enhancerResult.filesLoaded;
        }
        Logger.debug(
          `[Enhancer] Prompt enhanced (vagueness: ${enhancerResult.analysis.vaguenessScore}/10, ${enhancerResult.duration}ms)`,
        );
      }
    } catch (err) {
      Logger.warn(`[Enhancer] Failed, using original prompt: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Load file contents if specified
  let fileContext = '';
  if (files?.length) {
    const fileContexts = await loadFileContexts(files, projectRoot || process.cwd());
    fileContext = formatFileContextForPrompt(fileContexts);
  }

  // Get conversation history if continuing session
  const historyKey = sessionId || 'default';
  const history = continueSession ? sessionHistory.get(historyKey) : undefined;

  // Build messages: use custom systemPrompt if provided, otherwise agent defaults
  let messages: import('./client.js').Message[];
  if (systemPrompt) {
    messages = [{ role: 'system' as const, content: systemPrompt }];
    if (history?.length) {
      messages.push(...history);
    }
    const fullPrompt = fileContext ? `${prompt}\n\n---\n\n${fileContext}` : prompt;
    messages.push({ role: 'user' as const, content: fullPrompt });
  } else {
    messages = buildAgentMessages(agent, prompt, fileContext, history);
  }

  // AI routing: determine optimal provider/model if no explicit model override
  let resolvedModel = model;
  if (!resolvedModel) {
    try {
      const toolName = agent === 'plan' ? 'plan' : agent === 'build' ? 'build' : undefined;
      if (toolName) {
        const decision = routeToolExecution(toolName, {
          fileSize: fileContext.length,
          complexity: agent === 'plan' ? 'high' : 'medium',
        });
        if (decision.model) {
          resolvedModel = decision.provider ? `${decision.provider}:${decision.model}` : decision.model;
          Logger.debug(`[AI Router] ${toolName} → ${resolvedModel} (${decision.rationale})`);
        }
      }
    } catch {
      // Routing is best-effort, fall through to default model
    }
  }

  const response = await complete({
    model: resolvedModel,
    messages,
    stream: !!onProgress,
    temperature: temperature ?? getAgentTemperature(agent),
    maxTokens: maxTokens ?? getAgentMaxTokens(agent),
    onProgress,
  });

  return { response, startTime, historyKey, prompt, agent, sessionId, continueSession };
}

/**
 * Execute AI completion - drop-in replacement for executeAI
 */
export async function executeAI(options: ExecuteAIOptions): Promise<string> {
  const { response, startTime, historyKey, prompt, agent, sessionId, continueSession } =
    await prepareAndExecute(options);

  // Store conversation for session continuity
  if (sessionId || continueSession) {
    const currentHistory = sessionHistory.get(historyKey) || [];
    currentHistory.push({ role: 'user', content: prompt });
    currentHistory.push({ role: 'assistant', content: response.content });

    // Lorenz-aware history pruning: keep high-impact exchanges, drop low-impact ones
    if (currentHistory.length > 20) {
      const excess = currentHistory.length - 20;
      // For small excess or very short histories, simple splice is fine
      if (excess <= 4 || currentHistory.length < 12) {
        currentHistory.splice(0, excess);
      } else {
        // Rank messages by perturbation impact — drop lowest-impact ones
        try {
          const texts = currentHistory.map((m) => m.content.slice(0, 300));
          const rankings = rankByPerturbationImpact(texts);
          // Remove the lowest-impact messages (end of desc-sorted rankings)
          const removeIndices = new Set(
            rankings.slice(-excess).map((r) => r.index)
          );
          // Always keep the most recent 4 messages (active turn context)
          const protectedTail = currentHistory.length - 4;
          for (let i = protectedTail; i < currentHistory.length; i++) {
            removeIndices.delete(i);
          }
          // Rebuild without removed indices
          const kept = currentHistory.filter((_, i) => !removeIndices.has(i));
          currentHistory.length = 0;
          currentHistory.push(...kept);
          // If still over limit after impact-based pruning, trim oldest
          if (currentHistory.length > 20) {
            currentHistory.splice(0, currentHistory.length - 20);
          }
        } catch {
          // Fallback to simple splice
          currentHistory.splice(0, excess);
        }
      }
    }

    // Re-insert to move to end of Map iteration order (LRU)
    sessionHistory.delete(historyKey);

    // LRU eviction: remove oldest entry when map is at capacity (before insertion)
    if (sessionHistory.size >= SESSION_HISTORY_MAX) {
      const oldestKey = sessionHistory.keys().next().value;
      if (oldestKey !== undefined) {
        sessionHistory.delete(oldestKey);
      }
    }

    sessionHistory.set(historyKey, currentHistory);
  }

  const duration = Date.now() - startTime;
  Logger.debug(
    `[AI] ${agent} agent completed in ${duration}ms` +
      (response.usage ? ` (${response.usage.totalTokens} tokens)` : '')
  );

  return response.content;
}

/**
 * Execute AI completion with full result metadata
 */
export async function executeAIWithResult(options: ExecuteAIOptions): Promise<ExecuteAIResult> {
  const { response, startTime } = await prepareAndExecute(options);

  return {
    content: response.content,
    model: response.model,
    usage: response.usage,
    duration: Date.now() - startTime,
  };
}

/**
 * Execute AI completion with native function calling support.
 * Returns the full CompletionResponse including toolCalls.
 */
export async function completeWithTools(options: {
  messages: Message[];
  agent: AgentType;
  model?: string;
  systemPrompt?: string;
  tools?: FunctionTool[];
  toolChoice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
  temperature?: number;
  maxTokens?: number;
}): Promise<CompletionResponse> {
  const config = getClientConfig();
  if (!config && !(options.model && hasProviderPrefix(options.model))) {
    throw new Error('AI client not initialized. Call initAIClient() first.');
  }

  // AI routing: determine optimal provider/model if no explicit model override
  let resolvedModel = options.model;
  if (!resolvedModel) {
    try {
      const toolName = options.agent === 'plan' ? 'plan' : options.agent === 'build' ? 'build' : undefined;
      if (toolName) {
        const decision = routeToolExecution(toolName, { complexity: 'medium' });
        if (decision.model) {
          resolvedModel = decision.provider ? `${decision.provider}:${decision.model}` : decision.model;
        }
      }
    } catch {
      // Routing is best-effort
    }
  }

  return complete({
    model: resolvedModel,
    messages: options.messages,
    temperature: options.temperature ?? getAgentTemperature(options.agent),
    maxTokens: options.maxTokens ?? getAgentMaxTokens(options.agent),
    tools: options.tools,
    toolChoice: options.toolChoice,
  });
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
