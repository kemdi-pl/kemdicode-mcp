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
 * LLM Magistrale — Parallel LLM execution across clusters.
 *
 * Dispatches LLM requests to multiple cluster nodes in parallel,
 * collects results, and aggregates them via configurable strategies:
 * - first-wins: return the fastest response
 * - best-of-n: collect N responses, pick best (via voting or scoring)
 * - consensus: majority vote from multiple responses
 * - fallback-chain: try clusters in order, return first success
 *
 * @module cluster-bus/llm-magistrale
 */

import { v4 as uuidv4 } from 'uuid';
import { Logger } from '../utils/logger.js';
import type {
  ClusterSignal,
  SignalPayloadMap,
  PassConfigSchema,
  PassReportSchema,
} from './types.js';
import type { z } from 'zod';
import type { ClusterBus } from './bus.js';
import type { ClusterNode } from './types.js';
import { listClusters, findByCapability } from './cluster-registry.js';
import { getCustomEndpoint } from '../ai/providers/registry.js';
import { tfidfCosineSimilarity } from '../cognition/ctc-math.js';
import { analyzeOrbits } from '../cognition/orbit-compressor.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Aggregation strategies for multi-cluster LLM responses */
export type AggregationStrategy = 'first-wins' | 'best-of-n' | 'consensus' | 'fallback-chain';

/** Configuration for a magistrale dispatch */
export interface MagistraleConfig {
  /** Aggregation strategy */
  strategy: AggregationStrategy;
  /** Maximum clusters to dispatch to (0 = all matching) */
  maxTargets: number;
  /** Timeout per cluster response in ms */
  timeoutMs: number;
  /** Minimum responses required (for consensus/best-of-n) */
  minResponses: number;
  /** Custom scoring function for best-of-n (higher = better) */
  scorer?: (result: MagistraleResult) => number;
  /** Preferred provider filter (only dispatch to clusters with this provider) */
  preferredProvider?: string;
  /** Preferred model (hint for target clusters) */
  preferredModel?: string;
  /** Pass budget configuration — enables multi-pass self-regulating execution on each cluster */
  passConfig?: z.infer<typeof PassConfigSchema>;
  /** Multi-agent iteration config — agents iterate until quality convergence */
  agentIteration?: { agentCount: number; maxPasses: number; qualityThreshold: number };
  /** Full agentic orchestration — each cluster spawns a supervisor with tool access */
  orchestrate?: {
    agent: 'plan' | 'build' | 'explore' | 'general';
    maxIterations: number;
    allowedTools?: string[];
    blockedTools?: string[];
    enableCognition: boolean;
    isMultiCluster?: boolean;
  };
  /** System prompt override for LLM calls */
  systemPrompt?: string;
  /** Temperature override */
  temperature?: number;
  /** Max tokens override */
  maxTokens?: number;
}

/** A single result from one cluster */
export interface MagistraleResult {
  /** Source cluster ID */
  clusterId: string;
  /** Source cluster name */
  clusterName: string;
  /** LLM response content */
  content: string;
  /** Model that produced the result */
  model: string;
  /** Provider that served the request */
  provider: string;
  /** Response latency in ms */
  latencyMs: number;
  /** Token counts */
  promptTokens?: number;
  completionTokens?: number;
  /** Finish reason */
  finishReason?: string;
  /** Error if this cluster failed */
  error?: string;
  /** Pass budget report (present when passConfig was used) */
  passReport?: z.infer<typeof PassReportSchema>;
}

/** Aggregated response from the magistrale */
export interface MagistraleResponse {
  /** Unique dispatch ID */
  id: string;
  /** Original prompt */
  prompt: string;
  /** Strategy used */
  strategy: AggregationStrategy;
  /** Final aggregated content */
  content: string;
  /** Which cluster produced the chosen result */
  chosenCluster: string;
  /** All individual results */
  results: MagistraleResult[];
  /** Total dispatch latency in ms */
  totalLatencyMs: number;
  /** Number of clusters dispatched to */
  dispatchedTo: number;
  /** Number of successful responses */
  successCount: number;
  /** Consensus score (for consensus strategy, 0-1) */
  consensusScore?: number;
  /** Total passes executed across all clusters (when passConfig used) */
  totalPassesAllClusters?: number;
  /** Average quality achieved across clusters (when passConfig used) */
  avgQuality?: number;
}

// ---------------------------------------------------------------------------
// Default config
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: MagistraleConfig = {
  strategy: 'first-wins',
  maxTargets: 3,
  timeoutMs: 30000,
  minResponses: 1,
};

/** Resource quota: max concurrent dispatches per magistrale instance */
const MAX_CONCURRENT_DISPATCHES = 10;

/** Resource quota: max total pending results across all dispatches */
const MAX_TOTAL_PENDING_RESULTS = 50;

// ---------------------------------------------------------------------------
// LLMMagistrale
// ---------------------------------------------------------------------------

/**
 * LLMMagistrale — orchestrates parallel LLM dispatch and aggregation.
 *
 * Usage:
 *   const magistrale = new LLMMagistrale(clusterBus);
 *   const response = await magistrale.dispatch(prompt, { strategy: 'consensus', ... });
 */
export class LLMMagistrale {
  private bus: ClusterBus;
  private pendingDispatches = new Map<string, PendingDispatch>();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private subscriptions: Array<{ unsubscribe: () => void }> = [];
  /** Cache of cluster ID → human-readable name, populated during dispatch (bounded) */
  private clusterNameCache = new Map<string, string>();
  private readonly maxNameCacheSize = 500;

  constructor(bus: ClusterBus) {
    this.bus = bus;

    // Subscribe to LLM results coming back from clusters
    // Permanent subscriptions (ttlMs: 0) — must not be cleaned up by idle subscription reaper
    this.subscriptions.push(
      this.bus.onSignal<SignalPayloadMap['llm:result']>(
        'llm:result',
        (signal) => {
          this.handleResult(signal);
        },
        undefined,
        { ttlMs: 0 }
      )
    );

    this.subscriptions.push(
      this.bus.onSignal<SignalPayloadMap['llm:error']>(
        'llm:error',
        (signal) => {
          this.handleError(signal);
        },
        undefined,
        { ttlMs: 0 }
      )
    );

    // Periodic cleanup of stale PendingDispatch entries (every 60s)
    this.cleanupInterval = setInterval(() => {
      this.sweepStaleDispatches();
    }, 60_000);
  }

  /** Stop the periodic cleanup and unsubscribe signal handlers (for graceful shutdown). */
  stopCleanup(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    // Unsubscribe signal handlers to prevent subscription leak
    for (const sub of this.subscriptions) {
      sub.unsubscribe();
    }
    this.subscriptions = [];
  }

  /** Fully destroy this magistrale instance: unsubscribe all handlers, stop cleanup. */
  destroy(): void {
    this.stopCleanup();
    for (const sub of this.subscriptions) {
      sub.unsubscribe();
    }
    this.subscriptions = [];
    this.pendingDispatches.clear();
  }

  private sweepStaleDispatches(): void {
    const now = Date.now();
    for (const [id, pending] of this.pendingDispatches) {
      // Stale = 2x the configured timeout and still not resolved
      const maxAge = pending.config.timeoutMs * 2;
      if (now - pending.startTime > maxAge && !pending.resolved) {
        Logger.warn(
          `[Magistrale] Sweeping stale dispatch ${id} (age=${now - pending.startTime}ms)`
        );
        pending.resolved = true;
        if (pending.timeoutHandle) {
          clearTimeout(pending.timeoutHandle);
          pending.timeoutHandle = null;
        }
        pending.resolve({
          id,
          prompt: pending.prompt,
          strategy: pending.config.strategy,
          content: `[Magistrale] Dispatch swept as stale after ${now - pending.startTime}ms`,
          chosenCluster: '',
          results: pending.results,
          totalLatencyMs: now - pending.startTime,
          dispatchedTo: pending.targets.length,
          successCount: pending.results.filter((r) => !r.error).length,
        });
        this.pendingDispatches.delete(id);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Dispatch
  // -------------------------------------------------------------------------

  /**
   * Dispatch an LLM prompt to multiple clusters in parallel.
   */
  async dispatch(
    prompt: string,
    config: Partial<MagistraleConfig> = {}
  ): Promise<MagistraleResponse> {
    const cfg = { ...DEFAULT_CONFIG, ...config };
    const dispatchId = uuidv4();
    const startTime = Date.now();

    // Resource quota: limit concurrent dispatches to prevent resource exhaustion
    if (this.pendingDispatches.size >= MAX_CONCURRENT_DISPATCHES) {
      Logger.warn(
        `[Magistrale] Resource quota: ${this.pendingDispatches.size} concurrent dispatches (max ${MAX_CONCURRENT_DISPATCHES})`
      );
      return {
        id: dispatchId,
        prompt,
        strategy: cfg.strategy,
        content: `[Magistrale] Resource quota exceeded: ${this.pendingDispatches.size} dispatches active. Try again later.`,
        chosenCluster: '',
        results: [],
        totalLatencyMs: Date.now() - startTime,
        dispatchedTo: 0,
        successCount: 0,
      };
    }

    // Resource quota: limit total pending results across all dispatches
    let totalPending = 0;
    for (const [, p] of this.pendingDispatches) {
      totalPending += p.targets.length - p.results.length;
    }
    if (totalPending >= MAX_TOTAL_PENDING_RESULTS) {
      Logger.warn(
        `[Magistrale] Resource quota: ${totalPending} pending results (max ${MAX_TOTAL_PENDING_RESULTS})`
      );
      return {
        id: dispatchId,
        prompt,
        strategy: cfg.strategy,
        content: `[Magistrale] Resource quota exceeded: ${totalPending} pending results (max ${MAX_TOTAL_PENDING_RESULTS}). Try again later.`,
        chosenCluster: '',
        results: [],
        totalLatencyMs: Date.now() - startTime,
        dispatchedTo: 0,
        successCount: 0,
      };
    }

    // Find target clusters with LLM capability
    let targets = await this.findTargets(cfg);

    if (targets.length === 0) {
      return {
        id: dispatchId,
        prompt,
        strategy: cfg.strategy,
        content: '',
        chosenCluster: '',
        results: [],
        totalLatencyMs: Date.now() - startTime,
        dispatchedTo: 0,
        successCount: 0,
      };
    }

    // Prefer user-registered clusters (with meta-tags) over auto-registered local nodes.
    // User-registered clusters have meta-tags set via topology register;
    // auto-registered local nodes typically have no meta-tags.
    targets.sort((a, b) => b.metaTags.length - a.metaTags.length);

    // Limit targets
    if (cfg.maxTargets > 0 && targets.length > cfg.maxTargets) {
      targets = targets.slice(0, cfg.maxTargets);
    }

    // Validate timeoutMs
    const timeoutMs =
      typeof cfg.timeoutMs === 'number' && cfg.timeoutMs > 0
        ? cfg.timeoutMs
        : DEFAULT_CONFIG.timeoutMs;

    // Create pending dispatch
    const pending: PendingDispatch = {
      id: dispatchId,
      prompt,
      config: { ...cfg, timeoutMs },
      startTime,
      targets: targets.map((t) => t.id),
      results: [],
      resolved: false,
      timeoutHandle: null,
      resolve: null as unknown as (response: MagistraleResponse) => void,
    };

    const promise = new Promise<MagistraleResponse>((resolve) => {
      pending.resolve = resolve;
    });

    this.pendingDispatches.set(dispatchId, pending);

    try {
      // Cache cluster ID→name mappings for result handling (bounded)
      for (const target of targets) {
        this.clusterNameCache.set(target.id, target.name);
      }
      if (this.clusterNameCache.size > this.maxNameCacheSize) {
        const excess = this.clusterNameCache.size - this.maxNameCacheSize;
        const it = this.clusterNameCache.keys();
        for (let i = 0; i < excess; i++) {
          const key = it.next().value;
          if (key) this.clusterNameCache.delete(key);
        }
      }

      // Dispatch to all targets
      // Build full model spec: combine preferredProvider + preferredModel when both present
      let modelSpec = cfg.preferredModel || undefined;
      if (modelSpec && cfg.preferredProvider && !modelSpec.includes(':')) {
        // Model doesn't have a provider prefix — prepend the preferred provider
        modelSpec = `${cfg.preferredProvider}:${modelSpec}`;
      }

      // Guard: empty model spec causes target clusters to fail with cryptic errors
      if (modelSpec !== undefined && !modelSpec.trim()) {
        modelSpec = undefined;
      }

      // Set timeout BEFORE dispatching to avoid race where response arrives before timeout is assigned
      pending.timeoutHandle = setTimeout(() => {
        this.resolveDispatch(dispatchId);
      }, timeoutMs);

      // Lorenz orbit compression: remove redundant blocks from long prompts
      // before dispatching to remote clusters to save tokens
      const compressedPrompt = compressPromptForDispatch(prompt);

      const payload: SignalPayloadMap['llm:request'] = {
        prompt: compressedPrompt,
        model: modelSpec,
        passConfig: cfg.passConfig,
        agentIteration: cfg.agentIteration,
        orchestrate: cfg.orchestrate ? {
          ...cfg.orchestrate,
          isMultiCluster: cfg.orchestrate.isMultiCluster ?? targets.length > 1,
        } : undefined,
        systemPrompt: cfg.systemPrompt,
        temperature: cfg.temperature,
        maxTokens: cfg.maxTokens,
      };

      const sendTimeoutMs = Math.min(timeoutMs, 10000); // max 10s per send
      for (const target of targets) {
        // Per-target model spec: use the cluster's connectedProviders if no explicit model
        let targetPayload = payload;
        if (!modelSpec && target.connectedProviders.length > 0) {
          const providerId = target.connectedProviders[0];
          let resolvedModelSpec = providerId;

          // For custom providers, resolve full model spec: custom:<name>:<defaultModel>
          if (providerId.startsWith('custom:')) {
            const endpoint = getCustomEndpoint(providerId.replace('custom:', ''));
            if (endpoint?.defaultModel) {
              resolvedModelSpec = `${providerId}:${endpoint.defaultModel}`;
            }
          }

          targetPayload = { ...payload, model: resolvedModelSpec };
          Logger.info(`[Magistrale] Using model "${resolvedModelSpec}" from cluster "${target.id}" (${target.name})`);
        }

        let sendTimer: ReturnType<typeof setTimeout> | null = null;
        const sendPromise = this.bus.send(target.id, 'llm:request', targetPayload, {
          correlationId: dispatchId,
          priority: 2,
          direction: 'downstream',
        });

        const timeoutPromise = new Promise<never>((_, reject) => {
          sendTimer = setTimeout(
            () => reject(new Error(`bus.send timeout after ${sendTimeoutMs}ms`)),
            sendTimeoutMs
          );
        });

        try {
          await Promise.race([sendPromise, timeoutPromise]);
        } catch (err) {
          Logger.warn(
            `[Magistrale] Failed to dispatch to ${target.id}: ${err instanceof Error ? err.message : String(err)}`
          );
        } finally {
          if (sendTimer) clearTimeout(sendTimer);
        }
      }

      Logger.info(
        `[Magistrale] Dispatched "${prompt.slice(0, 50)}..." to ${targets.length} clusters (strategy: ${cfg.strategy})`
      );

      const response = await promise;
      return response;
    } finally {
      // Cleanup: clear timeout and remove pending dispatch
      if (pending.timeoutHandle) {
        clearTimeout(pending.timeoutHandle);
        pending.timeoutHandle = null;
      }
      this.pendingDispatches.delete(dispatchId);
    }
  }

  /**
   * Get the number of pending dispatches.
   */
  getPendingCount(): number {
    return this.pendingDispatches.size;
  }

  // -------------------------------------------------------------------------
  // Result Handling
  // -------------------------------------------------------------------------

  private handleResult(signal: ClusterSignal<SignalPayloadMap['llm:result']>): void {
    const correlationId = signal.correlationId;
    if (!correlationId) return;

    const pending = this.pendingDispatches.get(correlationId);
    if (!pending) return;

    const payload = signal.payload;

    pending.results.push({
      clusterId: signal.sourceCluster,
      clusterName: this.clusterNameCache.get(signal.sourceCluster) || signal.sourceCluster,
      content: payload.content,
      model: payload.model,
      provider: payload.provider,
      latencyMs: payload.latencyMs ?? Date.now() - pending.startTime,
      promptTokens: payload.promptTokens,
      completionTokens: payload.completionTokens,
      finishReason: payload.finishReason,
      passReport: payload.passReport,
    });

    this.checkCompletion(correlationId);
  }

  private handleError(signal: ClusterSignal<SignalPayloadMap['llm:error']>): void {
    const correlationId = signal.correlationId;
    if (!correlationId) return;

    const pending = this.pendingDispatches.get(correlationId);
    if (!pending) return;

    pending.results.push({
      clusterId: signal.sourceCluster,
      clusterName: this.clusterNameCache.get(signal.sourceCluster) || signal.sourceCluster,
      content: '',
      model: '',
      provider: '',
      latencyMs: Date.now() - pending.startTime,
      error: signal.payload.error,
    });

    this.checkCompletion(correlationId);
  }

  private checkCompletion(dispatchId: string): void {
    const pending = this.pendingDispatches.get(dispatchId);
    if (!pending) return;

    const successCount = pending.results.filter((r) => !r.error).length;
    const allResponded = pending.results.length >= pending.targets.length;
    const cfg = pending.config;

    const shouldResolve =
      allResponded ||
      (cfg.strategy === 'first-wins' && successCount >= 1) ||
      (cfg.strategy === 'fallback-chain' && successCount >= 1) ||
      (successCount >= cfg.minResponses && cfg.strategy !== 'first-wins');

    if (shouldResolve) {
      this.resolveDispatch(dispatchId);
    }
  }

  private resolveDispatch(dispatchId: string): void {
    const pending = this.pendingDispatches.get(dispatchId);
    if (!pending || pending.resolved) return;
    pending.resolved = true;

    // Clear timeout if resolving before it fires (e.g. from checkCompletion)
    if (pending.timeoutHandle) {
      clearTimeout(pending.timeoutHandle);
      pending.timeoutHandle = null;
    }

    const successes = pending.results.filter((r) => !r.error);
    const cfg = pending.config;
    const totalLatencyMs = Date.now() - pending.startTime;

    let content = '';
    let chosenCluster = '';
    let consensusScore: number | undefined;

    switch (cfg.strategy) {
      case 'first-wins': {
        // Sort by latency — pick the fastest response, not arbitrary first
        const sorted = [...successes].sort((a, b) => a.latencyMs - b.latencyMs);
        const first = sorted[0];
        if (first) {
          content = first.content;
          chosenCluster = first.clusterId;
        }
        break;
      }

      case 'fallback-chain': {
        // Pick first success in target order
        for (const targetId of pending.targets) {
          const result = successes.find((r) => r.clusterId === targetId);
          if (result) {
            content = result.content;
            chosenCluster = result.clusterId;
            break;
          }
        }
        break;
      }

      case 'best-of-n': {
        if (successes.length > 0) {
          const scorer = cfg.scorer || defaultScorer;
          let bestScore = -Infinity;
          for (const result of successes) {
            const score = scorer(result);
            if (score > bestScore) {
              bestScore = score;
              content = result.content;
              chosenCluster = result.clusterId;
            }
          }
        }
        break;
      }

      case 'consensus': {
        const result = computeConsensus(successes);
        content = result.content;
        chosenCluster = result.chosenCluster;
        consensusScore = result.score;
        break;
      }
    }

    if (successes.length === 0) {
      const errors = pending.results.filter((r) => r.error).map((r) => r.error);
      const timedOut = pending.results.length < pending.targets.length;
      content = timedOut
        ? `[Magistrale] Timeout: ${pending.results.length}/${pending.targets.length} clusters responded, 0 successes. Errors: ${errors.join('; ') || 'none'}`
        : `[Magistrale] All ${pending.targets.length} clusters failed. Errors: ${errors.join('; ')}`;
      Logger.warn(`[Magistrale] Dispatch ${dispatchId} resolved with 0 successes: ${content}`);
    }

    // Aggregate pass metrics across clusters
    const passResults = successes.filter((r) => r.passReport);
    const totalPassesAllClusters =
      passResults.reduce((sum, r) => sum + (r.passReport?.totalPasses ?? 0), 0) || undefined;
    const avgQuality =
      passResults.length > 0
        ? passResults.reduce((sum, r) => sum + (r.passReport?.qualityAchieved ?? 0), 0) /
          passResults.length
        : undefined;

    const response: MagistraleResponse = {
      id: dispatchId,
      prompt: pending.prompt,
      strategy: cfg.strategy,
      content,
      chosenCluster,
      results: pending.results,
      totalLatencyMs,
      dispatchedTo: pending.targets.length,
      successCount: successes.length,
      consensusScore,
      totalPassesAllClusters,
      avgQuality,
    };

    pending.resolve(response);
  }

  // -------------------------------------------------------------------------
  // Target Selection
  // -------------------------------------------------------------------------

  private async findTargets(cfg: MagistraleConfig): Promise<ClusterNode[]> {
    const all = await listClusters();
    let candidates: ClusterNode[];

    if (cfg.preferredProvider) {
      // Find clusters with specific provider in connectedProviders
      candidates = all.filter(
        (n) => n.status === 'online' && n.connectedProviders.includes(cfg.preferredProvider!)
      );

      // Fallback: if no clusters match the preferred provider, use local cluster
      // (the local node can route to any registered provider)
      if (candidates.length === 0) {
        candidates = all.filter((n) => n.status === 'online' && n.capabilities.includes('llm'));
      }
    } else {
      // Find clusters with LLM capability OR any connectedProviders
      // Virtual clusters registered with providers (e.g. ["custom:minimax"]) are valid LLM targets
      candidates = all.filter(
        (n) => n.status === 'online' && (n.capabilities.includes('llm') || n.connectedProviders.length > 0)
      );
    }

    return candidates;
  }
}

// ---------------------------------------------------------------------------
// Internal Types
// ---------------------------------------------------------------------------

interface PendingDispatch {
  id: string;
  prompt: string;
  config: MagistraleConfig;
  startTime: number;
  targets: string[];
  results: MagistraleResult[];
  resolved: boolean;
  timeoutHandle: ReturnType<typeof setTimeout> | null;
  resolve: (response: MagistraleResponse) => void;
}

// ---------------------------------------------------------------------------
// Scoring & Consensus
// ---------------------------------------------------------------------------

/**
 * Enhanced scorer: weighted scoring combining quality, content depth, and latency.
 * Prioritizes quality from pass reports when available.
 */
function defaultScorer(result: MagistraleResult): number {
  // Quality score from pass report (0-1) — most important signal
  const qualityScore = result.passReport?.qualityAchieved ?? 0.5;

  // Content depth: prefer substantive responses (log scale to avoid linear bias)
  const contentLength = result.content.length;
  const depthScore = contentLength > 0 ? Math.min(1, Math.log10(contentLength) / 4) : 0;

  // Latency penalty: normalized (lower is better), but less weight than quality
  const latencyPenalty = Math.min(1, result.latencyMs / 120000);

  // Token efficiency: more completion tokens relative to prompt tokens = better
  const tokenRatio = result.completionTokens
    ? Math.min(1, result.completionTokens / Math.max(result.promptTokens ?? 1, 1))
    : 0.5;

  // Weighted combination: quality dominates
  return qualityScore * 0.45 + depthScore * 0.25 + tokenRatio * 0.15 - latencyPenalty * 0.15;
}

/**
 * Weighted consensus: combines agreement scoring with quality-based weighting.
 * Each response's vote weight is proportional to its quality score from pass reports.
 * Falls back to equal weights when pass reports are not available.
 */
function computeConsensus(results: MagistraleResult[]): {
  content: string;
  chosenCluster: string;
  score: number;
} {
  if (results.length === 0) {
    return { content: '', chosenCluster: '', score: 0 };
  }

  if (results.length === 1) {
    return { content: results[0].content, chosenCluster: results[0].clusterId, score: 1 };
  }

  // Normalize responses for comparison (first 1500 chars, lowercased, trimmed)
  const normalized = results.map((r) => r.content.slice(0, 1500).toLowerCase().trim());

  // Compute quality weight for each result (from pass report or default)
  const weights = results.map((r) => {
    const quality = r.passReport?.qualityAchieved ?? 0.5;
    // Weight = quality^2 to amplify high-quality responses
    return quality * quality;
  });

  // Weighted agreement: each response's score = sum of (weight * similarity) for agreeing peers
  // Uses TF-IDF cosine similarity (Lorenz NLP) for more accurate semantic comparison
  const weightedScores = normalized.map((norm, i) => {
    let weightedMatchSum = 0;
    for (let j = 0; j < normalized.length; j++) {
      if (i === j) continue;
      const similarity = tfidfCosineSimilarity(norm, normalized[j]);
      if (similarity > 0.3) {
        weightedMatchSum += weights[j] * similarity;
      }
    }
    // Self-weight added
    return weightedMatchSum + weights[i];
  });

  // Pick the response with the highest weighted agreement score
  // Tiebreaker: prefer lower latency when scores are equal
  let bestIdx = 0;
  let bestScore = weightedScores[0];
  for (let i = 1; i < weightedScores.length; i++) {
    if (
      weightedScores[i] > bestScore ||
      (weightedScores[i] === bestScore && results[i].latencyMs < results[bestIdx].latencyMs)
    ) {
      bestScore = weightedScores[i];
      bestIdx = i;
    }
  }

  // Consensus score: ratio of best weighted score to total possible weight
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const consensusScore = totalWeight > 0 ? Math.min(1, bestScore / totalWeight) : 0;

  return {
    content: results[bestIdx].content,
    chosenCluster: results[bestIdx].clusterId,
    score: consensusScore,
  };
}

/** Minimum prompt length (chars) to trigger Lorenz orbit compression before dispatch */
const PROMPT_COMPRESS_THRESHOLD = 3000;

/**
 * Compress a long prompt using Lorenz orbit compression.
 *
 * Splits prompt into paragraph-sized blocks, detects repeating patterns
 * via TF-IDF cosine similarity matrix, and removes redundant cycles.
 * This reduces token cost when dispatching to remote clusters.
 *
 * @returns Compressed prompt (or original if no compression possible)
 */
function compressPromptForDispatch(prompt: string): string {
  if (prompt.length < PROMPT_COMPRESS_THRESHOLD) return prompt;

  try {
    // Split into blocks by double newlines or tool-result boundaries
    const blocks = prompt.split(/\n{2,}/).filter((b) => b.trim().length > 20);
    if (blocks.length < 4) return prompt;

    const indexed = blocks.map((b, i) => ({ index: i, content: b, confidence: 50 }));
    const orbits = analyzeOrbits(indexed);

    if (orbits.pruneIndices.length === 0) return prompt;

    const pruneSet = new Set(orbits.pruneIndices);
    const kept = blocks.filter((_, i) => !pruneSet.has(i));

    Logger.debug(
      `[Magistrale] Lorenz prompt compression: ${blocks.length} → ${kept.length} blocks ` +
      `(${orbits.orbits.length} cycles, ratio: ${orbits.compressionRatio.toFixed(2)})`
    );

    return kept.join('\n\n');
  } catch {
    return prompt;
  }
}
