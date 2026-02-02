/**
 * KemdiCode MCP Server - LLM Magistrale
 * Copyright (C) 2025-2026 Kemdi Sp. z o.o. (Dawid Irzyk <dawid@kemdi.pl>)
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
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
import type { ClusterSignal, SignalPayloadMap, PassConfigSchema, PassReportSchema } from './types.js';
import type { z } from 'zod';
import type { ClusterBus } from './bus.js';
import type { ClusterNode } from './types.js';
import { listClusters, findByCapability } from './cluster-registry.js';

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

  constructor(bus: ClusterBus) {
    this.bus = bus;

    // Subscribe to LLM results coming back from clusters
    this.bus.onSignal<SignalPayloadMap['llm:result']>('llm:result', (signal) => {
      this.handleResult(signal);
    });

    this.bus.onSignal<SignalPayloadMap['llm:error']>('llm:error', (signal) => {
      this.handleError(signal);
    });
  }

  // -------------------------------------------------------------------------
  // Dispatch
  // -------------------------------------------------------------------------

  /**
   * Dispatch an LLM prompt to multiple clusters in parallel.
   */
  async dispatch(
    prompt: string,
    config: Partial<MagistraleConfig> = {},
  ): Promise<MagistraleResponse> {
    const cfg = { ...DEFAULT_CONFIG, ...config };
    const dispatchId = uuidv4();
    const startTime = Date.now();

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

    // Limit targets
    if (cfg.maxTargets > 0 && targets.length > cfg.maxTargets) {
      targets = targets.slice(0, cfg.maxTargets);
    }

    // Create pending dispatch
    const pending: PendingDispatch = {
      id: dispatchId,
      prompt,
      config: cfg,
      startTime,
      targets: targets.map((t) => t.id),
      results: [],
      resolve: null as unknown as (response: MagistraleResponse) => void,
    };

    const promise = new Promise<MagistraleResponse>((resolve) => {
      pending.resolve = resolve;
    });

    this.pendingDispatches.set(dispatchId, pending);

    // Dispatch to all targets
    const payload: SignalPayloadMap['llm:request'] = {
      prompt,
      model: cfg.preferredModel,
      passConfig: cfg.passConfig,
    };

    for (const target of targets) {
      try {
        await this.bus.send(target.id, 'llm:request', payload, {
          correlationId: dispatchId,
          priority: 2,
          direction: 'downstream',
        });
      } catch (err) {
        Logger.warn(
          `[Magistrale] Failed to dispatch to ${target.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    Logger.info(
      `[Magistrale] Dispatched "${prompt.slice(0, 50)}..." to ${targets.length} clusters (strategy: ${cfg.strategy})`,
    );

    // Set timeout
    const timeoutHandle = setTimeout(() => {
      this.resolveDispatch(dispatchId);
    }, cfg.timeoutMs);

    const response = await promise;

    clearTimeout(timeoutHandle);
    this.pendingDispatches.delete(dispatchId);

    return response;
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
      clusterName: signal.sourceCluster,
      content: payload.content,
      model: payload.model,
      provider: payload.provider,
      latencyMs: payload.latencyMs ?? (Date.now() - pending.startTime),
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
      clusterName: signal.sourceCluster,
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
    if (!pending) return;

    const successes = pending.results.filter((r) => !r.error);
    const cfg = pending.config;
    const totalLatencyMs = Date.now() - pending.startTime;

    let content = '';
    let chosenCluster = '';
    let consensusScore: number | undefined;

    switch (cfg.strategy) {
      case 'first-wins': {
        const first = successes[0];
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

    // Aggregate pass metrics across clusters
    const passResults = successes.filter((r) => r.passReport);
    const totalPassesAllClusters = passResults.reduce(
      (sum, r) => sum + (r.passReport?.totalPasses ?? 0), 0,
    ) || undefined;
    const avgQuality = passResults.length > 0
      ? passResults.reduce((sum, r) => sum + (r.passReport?.qualityAchieved ?? 0), 0) / passResults.length
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
    let candidates: ClusterNode[];

    if (cfg.preferredProvider) {
      // Find clusters with specific provider
      const all = await listClusters();
      candidates = all.filter(
        (n) =>
          n.status === 'online' &&
          n.connectedProviders.includes(cfg.preferredProvider!),
      );
    } else {
      // Find clusters with generic LLM capability (including self for single-node)
      candidates = (await findByCapability('llm')).filter(
        (n) => n.status === 'online',
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
  resolve: (response: MagistraleResponse) => void;
}

// ---------------------------------------------------------------------------
// Scoring & Consensus
// ---------------------------------------------------------------------------

/** Default scorer: prefer faster responses with more tokens. */
function defaultScorer(result: MagistraleResult): number {
  const latencyPenalty = result.latencyMs / 1000; // seconds
  const tokenBonus = (result.completionTokens ?? 100) / 100;
  return tokenBonus - latencyPenalty;
}

/**
 * Simple consensus: find the most common response pattern.
 * Uses first-sentence similarity as a heuristic for agreement.
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

  // Normalize responses for comparison (first 200 chars, lowercased, trimmed)
  const normalized = results.map((r) => r.content.slice(0, 200).toLowerCase().trim());

  // Score each response by how many others are similar
  const scores = normalized.map((norm, i) => {
    let matchCount = 0;
    for (let j = 0; j < normalized.length; j++) {
      if (i === j) continue;
      if (jaccardSimilarity(norm, normalized[j]) > 0.5) {
        matchCount++;
      }
    }
    return matchCount;
  });

  // Pick the response with the highest agreement score
  let bestIdx = 0;
  let bestScore = scores[0];
  for (let i = 1; i < scores.length; i++) {
    if (scores[i] > bestScore) {
      bestScore = scores[i];
      bestIdx = i;
    }
  }

  const consensusScore = (bestScore + 1) / results.length; // +1 includes self

  return {
    content: results[bestIdx].content,
    chosenCluster: results[bestIdx].clusterId,
    score: consensusScore,
  };
}

/** Jaccard similarity between two strings (word-level). */
function jaccardSimilarity(a: string, b: string): number {
  const setA = new Set(a.split(/\s+/));
  const setB = new Set(b.split(/\s+/));

  let intersection = 0;
  for (const word of setA) {
    if (setB.has(word)) intersection++;
  }

  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
