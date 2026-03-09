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
 * Tool Availability Checker
 *
 * Checks if tools requiring AI providers are available before execution.
 * Supports soft mode (guidance) and force mode (blocking).
 *
 * @module tools/availability-checker
 */

import {
  isProviderAvailable,
  listProviders,
} from '../ai/providers/registry.js';
import type { ProviderId } from '../ai/providers/types.js';
import { PROVIDER_DISPLAY_NAMES } from '../ai/providers/types.js';
import { RedisBackedService } from '../infrastructure/redis/redis-backed-service.js';

/** AI requirement specification for a tool */
export interface AIRequirement {
  /** Specific provider required (if omitted, any provider suffices) */
  provider?: ProviderId;
  /** Minimum model name hint */
  minModel?: string;
  /** Tools that can be used instead when AI is unavailable */
  fallbackTools?: string[];
}

/** AI requirement config: boolean (any AI) or detailed spec */
export type AIRequirementConfig = boolean | AIRequirement;

/** Result of an availability check */
export interface AvailabilityCheckResult {
  available: boolean;
  provider?: ProviderId;
  message?: string;
  alternatives?: string[];
  mode: 'soft' | 'force';
}

/** Health matrix entry for a single tool */
export interface ToolHealthEntry {
  toolName: string;
  aiRequired: boolean;
  available: boolean;
  provider?: ProviderId;
  fallbackTools?: string[];
}

/** Complete health matrix */
export interface HealthMatrix {
  totalTools: number;
  availableTools: number;
  unavailableTools: string[];
  aiProvidersConfigured: string[];
  entries: ToolHealthEntry[];
}

/** Availability cache TTL in seconds */
const CACHE_TTL = 60;

/** Non-AI alternatives for AI-dependent tools (v4.6.0) */
const FALLBACK_MAP: Record<string, string[]> = {
  'semantic-search': ['find-definition', 'find-references'],
  'ask-ai': ['shared-thoughts'],
  plan: ['thinking-chain'],
  build: ['ask-ai'],
  brainstorm: ['shared-thoughts'],
  'multi-prompt': ['ask-ai'],
  'consensus-prompt': ['ask-ai'],
};

/**
 * Singleton availability checker with Redis caching.
 */
class AvailabilityCheckerService extends RedisBackedService {
  protected get serviceName(): string {
    return 'AvailabilityChecker';
  }

  /**
   * Check if a tool's AI requirements are met.
   */
  async check(
    toolName: string,
    requirement: AIRequirementConfig,
    mode: 'soft' | 'force' = 'soft'
  ): Promise<AvailabilityCheckResult> {
    if (requirement === true) {
      return this.checkAnyProvider(toolName, mode);
    }

    const req = requirement as AIRequirement;
    if (!req.provider) {
      return this.checkAnyProvider(toolName, mode);
    }

    // Check cache first
    const cached = await this.getCachedAvailability(toolName, req.provider);
    if (cached !== null) {
      if (cached) return { available: true, provider: req.provider, mode };
      return this.buildUnavailableResult(toolName, req.provider, req.fallbackTools, mode);
    }

    const available = isProviderAvailable(req.provider);
    await this.cacheAvailability(toolName, req.provider, available);

    if (available) {
      return { available: true, provider: req.provider, mode };
    }

    return this.buildUnavailableResult(toolName, req.provider, req.fallbackTools, mode);
  }

  /**
   * Generate a complete health matrix of all tools.
   */
  getHealthMatrix(aiToolNames: string[], allToolCount: number): HealthMatrix {
    const configuredProviders = listProviders()
      .filter((p) => p.available)
      .map((p) => p.id);

    const anyAvailable = configuredProviders.length > 0;

    const entries: ToolHealthEntry[] = aiToolNames.map((toolName) => ({
      toolName,
      aiRequired: true,
      available: anyAvailable,
      fallbackTools: FALLBACK_MAP[toolName],
    }));

    const unavailableTools = entries.filter((e) => !e.available).map((e) => e.toolName);

    return {
      totalTools: allToolCount,
      availableTools: allToolCount - unavailableTools.length,
      unavailableTools,
      aiProvidersConfigured: configuredProviders,
      entries,
    };
  }

  // --- Private helpers ---

  private checkAnyProvider(
    toolName: string,
    mode: 'soft' | 'force'
  ): AvailabilityCheckResult {
    const providers: ProviderId[] = [
      'openai', 'anthropic', 'gemini', 'groq', 'deepseek', 'ollama', 'openrouter',
    ];

    for (const provider of providers) {
      if (isProviderAvailable(provider)) {
        return { available: true, provider, mode };
      }
    }

    const alternatives = FALLBACK_MAP[toolName] || [];
    const message =
      mode === 'force'
        ? `BLOCKED: Tool "${toolName}" requires AI but no providers are configured. DO NOT retry this tool.`
        : `Tool "${toolName}" requires AI but no providers are configured.\n\n` +
          (alternatives.length > 0
            ? `Available alternatives:\n${alternatives.map((t) => `  - ${t}`).join('\n')}\n\n`
            : '') +
          `Configure a provider via: ai-config --action set --provider <name> --apiKey <key>`;

    return { available: false, message, alternatives, mode };
  }

  private buildUnavailableResult(
    toolName: string,
    provider: ProviderId,
    explicitFallbacks: string[] | undefined,
    mode: 'soft' | 'force'
  ): AvailabilityCheckResult {
    const alternatives = explicitFallbacks || FALLBACK_MAP[toolName] || [];
    const displayName = PROVIDER_DISPLAY_NAMES[provider] || provider;

    const message =
      mode === 'force'
        ? `BLOCKED: Tool "${toolName}" requires ${displayName} which is not configured. DO NOT retry this tool.`
        : `Tool "${toolName}" requires ${displayName} which is currently unavailable.\n\n` +
          (alternatives.length > 0
            ? `Available alternatives:\n${alternatives.map((t) => `  - ${t}`).join('\n')}\n\n`
            : '') +
          `You can:\n` +
          `1. Configure ${displayName} via: ai-config --action set --provider ${provider} --apiKey <key>\n` +
          `2. Use an alternative tool from the list above\n` +
          `3. Choose a different approach that doesn't require AI`;

    return { available: false, provider, message, alternatives, mode };
  }

  private async getCachedAvailability(
    toolName: string,
    provider: ProviderId
  ): Promise<boolean | null> {
    if (!this.redis) return null;
    try {
      const key = `mcp:availability:${toolName}:${provider}`;
      const cached = await this.redis.get(key);
      return cached === null ? null : cached === '1';
    } catch {
      return null;
    }
  }

  private async cacheAvailability(
    toolName: string,
    provider: ProviderId,
    available: boolean
  ): Promise<void> {
    if (!this.redis) return;
    try {
      const key = `mcp:availability:${toolName}:${provider}`;
      await this.redis.setex(key, CACHE_TTL, available ? '1' : '0');
    } catch {
      // Non-critical
    }
  }
}

// --- Singleton ---

let instance: AvailabilityCheckerService | null = null;

export function getAvailabilityChecker(): AvailabilityCheckerService {
  if (!instance) {
    instance = new AvailabilityCheckerService();
  }
  return instance;
}
