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
 * AI Routing Layer
 *
 * Routes AI tool executions to local (Ollama) or external (cloud) providers
 * based on tool capabilities, provider availability, and context.
 *
 * @module ai/routing
 */

import type { ProviderId } from './providers/types.js';
import { isProviderAvailable } from './providers/registry.js';

/** Routing strategy for a tool */
export type RoutingStrategy = 'local-capable' | 'external-required' | 'hybrid';

/** Routing configuration for a single tool */
export interface RoutingConfig {
  toolName: string;
  strategy: RoutingStrategy;
  preferredProvider?: ProviderId;
  fallbackProvider?: ProviderId;
  localModel?: string;
}

/** Result of routing decision */
export interface RoutingDecision {
  provider: ProviderId;
  model?: string;
  rationale: string;
  isLocal: boolean;
  isFallback: boolean;
}

/** Tool routing configuration database */
const ROUTING_DB: Record<string, RoutingConfig> = {
  // Local-capable: can run on Ollama
  'explain-code': {
    toolName: 'explain-code',
    strategy: 'local-capable',
    preferredProvider: 'ollama',
    fallbackProvider: 'openai',
    localModel: 'llama3.2:latest',
  },
  'semantic-search': {
    toolName: 'semantic-search',
    strategy: 'local-capable',
    preferredProvider: 'ollama',
    fallbackProvider: 'openai',
    localModel: 'llama3.2:latest',
  },

  // External-required: need cloud API
  'consensus-prompt': {
    toolName: 'consensus-prompt',
    strategy: 'external-required',
    preferredProvider: 'openai',
  },
  'multi-prompt': {
    toolName: 'multi-prompt',
    strategy: 'external-required',
    preferredProvider: 'openai',
  },

  // Hybrid: prefer cloud, fallback to local
  'code-review': {
    toolName: 'code-review',
    strategy: 'hybrid',
    preferredProvider: 'anthropic',
    fallbackProvider: 'ollama',
    localModel: 'deepseek-coder:latest',
  },
  'fix-bug': {
    toolName: 'fix-bug',
    strategy: 'hybrid',
    preferredProvider: 'anthropic',
    fallbackProvider: 'ollama',
    localModel: 'deepseek-coder:latest',
  },
  refactor: {
    toolName: 'refactor',
    strategy: 'hybrid',
    preferredProvider: 'openai',
    fallbackProvider: 'ollama',
    localModel: 'codellama:latest',
  },
  'write-tests': {
    toolName: 'write-tests',
    strategy: 'hybrid',
    preferredProvider: 'openai',
    fallbackProvider: 'ollama',
    localModel: 'codellama:latest',
  },
  'analyze-deps': {
    toolName: 'analyze-deps',
    strategy: 'hybrid',
    preferredProvider: 'openai',
    fallbackProvider: 'ollama',
    localModel: 'llama3.2:latest',
  },
  'ask-ai': {
    toolName: 'ask-ai',
    strategy: 'hybrid',
    preferredProvider: 'openai',
    fallbackProvider: 'ollama',
    localModel: 'llama3.2:latest',
  },
  plan: {
    toolName: 'plan',
    strategy: 'hybrid',
    preferredProvider: 'anthropic',
    fallbackProvider: 'ollama',
    localModel: 'deepseek-coder:latest',
  },
  build: {
    toolName: 'build',
    strategy: 'hybrid',
    preferredProvider: 'openai',
    fallbackProvider: 'ollama',
    localModel: 'deepseek-coder:latest',
  },
  brainstorm: {
    toolName: 'brainstorm',
    strategy: 'hybrid',
    preferredProvider: 'anthropic',
    fallbackProvider: 'ollama',
    localModel: 'llama3.2:latest',
  },
  'auto-fix': {
    toolName: 'auto-fix',
    strategy: 'hybrid',
    preferredProvider: 'openai',
    fallbackProvider: 'ollama',
    localModel: 'deepseek-coder:latest',
  },
  'auto-fix-agent': {
    toolName: 'auto-fix-agent',
    strategy: 'external-required',
    preferredProvider: 'openai',
  },
};

/**
 * Determine the best provider for a tool execution.
 */
export function routeToolExecution(
  toolName: string,
  context?: {
    fileSize?: number;
    complexity?: 'low' | 'medium' | 'high';
  }
): RoutingDecision {
  const cfg = ROUTING_DB[toolName];
  if (!cfg) return defaultRoute(toolName);

  switch (cfg.strategy) {
    case 'external-required':
      return routeExternal(cfg);
    case 'local-capable':
      return routeLocal(cfg);
    case 'hybrid':
      return routeHybrid(cfg, context);
    default:
      return defaultRoute(toolName);
  }
}

/**
 * Register custom routing config for a tool (runtime extension).
 */
export function registerRoutingConfig(cfg: RoutingConfig): void {
  ROUTING_DB[cfg.toolName] = cfg;
}

/**
 * Get routing strategy for a tool.
 */
export function getRoutingStrategy(toolName: string): RoutingStrategy | undefined {
  return ROUTING_DB[toolName]?.strategy;
}

// --- Internal routing functions ---

function routeExternal(cfg: RoutingConfig): RoutingDecision {
  const preferred = cfg.preferredProvider || 'openai';

  if (isProviderAvailable(preferred)) {
    return {
      provider: preferred,
      rationale: `External provider ${preferred} for "${cfg.toolName}"`,
      isLocal: false,
      isFallback: false,
    };
  }

  // Try other external providers
  const alternatives: ProviderId[] = ['openai', 'anthropic', 'gemini', 'groq', 'deepseek', 'openrouter'];
  for (const alt of alternatives) {
    if (alt !== preferred && isProviderAvailable(alt)) {
      return {
        provider: alt,
        rationale: `Fallback to ${alt} (${preferred} unavailable) for "${cfg.toolName}"`,
        isLocal: false,
        isFallback: true,
      };
    }
  }

  throw new Error(`Tool "${cfg.toolName}" requires external provider but none are configured`);
}

function routeLocal(cfg: RoutingConfig): RoutingDecision {
  if (isProviderAvailable('ollama')) {
    return {
      provider: 'ollama',
      model: cfg.localModel,
      rationale: `Local Ollama for "${cfg.toolName}"`,
      isLocal: true,
      isFallback: false,
    };
  }

  if (cfg.fallbackProvider && isProviderAvailable(cfg.fallbackProvider)) {
    return {
      provider: cfg.fallbackProvider,
      rationale: `Fallback to ${cfg.fallbackProvider} (Ollama unavailable) for "${cfg.toolName}"`,
      isLocal: false,
      isFallback: true,
    };
  }

  throw new Error(`Tool "${cfg.toolName}" requires Ollama or ${cfg.fallbackProvider || 'external provider'}`);
}

function routeHybrid(
  cfg: RoutingConfig,
  context?: { fileSize?: number; complexity?: 'low' | 'medium' | 'high' }
): RoutingDecision {
  // Decision: use external for large/complex tasks
  const useExternal =
    (context?.fileSize && context.fileSize > 50000) ||
    context?.complexity === 'high';

  if (useExternal && cfg.preferredProvider && isProviderAvailable(cfg.preferredProvider)) {
    return {
      provider: cfg.preferredProvider,
      rationale: `External ${cfg.preferredProvider} for complex task "${cfg.toolName}"`,
      isLocal: false,
      isFallback: false,
    };
  }

  // Try preferred external first (if no explicit context push to local)
  if (cfg.preferredProvider && isProviderAvailable(cfg.preferredProvider)) {
    return {
      provider: cfg.preferredProvider,
      rationale: `External ${cfg.preferredProvider} for "${cfg.toolName}"`,
      isLocal: false,
      isFallback: false,
    };
  }

  // Fallback to local
  if (isProviderAvailable('ollama')) {
    return {
      provider: 'ollama',
      model: cfg.localModel,
      rationale: `Local Ollama fallback for "${cfg.toolName}"`,
      isLocal: true,
      isFallback: true,
    };
  }

  // Last resort: any available provider
  if (cfg.fallbackProvider && isProviderAvailable(cfg.fallbackProvider)) {
    return {
      provider: cfg.fallbackProvider,
      rationale: `Last-resort ${cfg.fallbackProvider} for "${cfg.toolName}"`,
      isLocal: cfg.fallbackProvider === 'ollama',
      isFallback: true,
    };
  }

  throw new Error(`No AI providers available for hybrid tool "${cfg.toolName}"`);
}

function defaultRoute(toolName: string): RoutingDecision {
  const providers: ProviderId[] = ['openai', 'anthropic', 'gemini', 'groq', 'deepseek', 'ollama', 'openrouter'];

  for (const provider of providers) {
    if (isProviderAvailable(provider)) {
      return {
        provider,
        rationale: `Default routing to ${provider} for "${toolName}"`,
        isLocal: provider === 'ollama',
        isFallback: false,
      };
    }
  }

  throw new Error('No AI providers available');
}
