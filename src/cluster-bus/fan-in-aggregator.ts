/**
 * KemdiCode MCP Server - CI Fan-In Aggregator
 * Copyright (C) 2025-2026 Kemdi Sp. z o.o. (Dawid Irzyk <dawid@kemdi.pl>)
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

/**
 * CI Fan-In Aggregator — Collects and aggregates results from CI multicast
 *
 * Handles aggregation of CI build/test/deploy results from multiple
 * clusters with support for different aggregation strategies.
 *
 * @module cluster-bus/fan-in-aggregator
 */

import { v4 as uuidv4 } from 'uuid';
import { Logger } from '../utils/logger.js';
import type { ClusterSignal, CIMulticastPayloadType, CIResultPayloadType } from './types.js';

export type AggregationMode = 'all' | 'first' | 'majority' | 'custom';
export type AggregationState = 'pending' | 'collecting' | 'completed' | 'failed';

export interface AggregationResult {
  pipelineId: string;
  stage: string;
  state: AggregationState;
  totalExpected: number;
  receivedCount: number;
  successCount: number;
  failureCount: number;
  results: CIResultPayloadType[];
  aggregatedAt: number;
  durationMs: number;
}

export interface CustomAggregationRule {
  name: string;
  handler: (results: CIResultPayloadType[]) => AggregationResult;
}

interface PendingAggregation {
  payload: CIMulticastPayloadType;
  results: CIResultPayloadType[];
  startedAt: number;
  timeoutMs: number;
}

const aggregations = new Map<string, PendingAggregation>();
const customRules = new Map<string, CustomAggregationRule>();
const aggregationResults = new Map<string, AggregationResult>();

export const AGGREGATION_TIMEOUT_MS = 5 * 60 * 1000;
export const AGGREGATION_CLEANUP_MS = 30 * 60 * 1000;

let cleanupInterval: ReturnType<typeof setInterval> | null = null;

export function registerCustomRule(rule: CustomAggregationRule): void {
  customRules.set(rule.name, rule);
  Logger.info(`[FanInAggregator] Registered custom aggregation rule: ${rule.name}`);
}

export function unregisterCustomRule(name: string): boolean {
  return customRules.delete(name);
}

export function startAggregation(payload: CIMulticastPayloadType): AggregationResult {
  // Lazy-start cleanup scheduler on first aggregation
  if (!cleanupInterval) {
    startCleanupScheduler();
  }

  const aggregationId = payload.pipelineId;

  const existing = aggregations.get(aggregationId);
  if (existing) {
    Logger.warn(`[FanInAggregator] Aggregation already exists for ${aggregationId}, replacing`);
  }

  const aggregation: PendingAggregation = {
    payload,
    results: [],
    startedAt: Date.now(),
    timeoutMs: payload.timeoutMs || AGGREGATION_TIMEOUT_MS,
  };

  aggregations.set(aggregationId, aggregation);

  const result: AggregationResult = {
    pipelineId: payload.pipelineId,
    stage: payload.stage,
    state: 'collecting',
    totalExpected: payload.targets.length,
    receivedCount: 0,
    successCount: 0,
    failureCount: 0,
    results: [],
    aggregatedAt: 0,
    durationMs: 0,
  };

  aggregationResults.set(aggregationId, result);

  Logger.info(
    `[FanInAggregator] Started aggregation for pipeline ${payload.pipelineId} (stage: ${payload.stage}, expected: ${payload.targets.length})`
  );

  return result;
}

export function addResult(payload: CIResultPayloadType): AggregationResult | null {
  const aggregationId = payload.pipelineId;
  const aggregation = aggregations.get(aggregationId);

  if (!aggregation) {
    Logger.warn(`[FanInAggregator] No aggregation found for ${aggregationId}`);
    return null;
  }

  aggregation.results.push(payload);

  const result = aggregationResults.get(aggregationId)!;
  result.receivedCount++;
  result.results.push(payload);

  if (payload.success) {
    result.successCount++;
  } else {
    result.failureCount++;
  }

  const elapsed = Date.now() - aggregation.startedAt;
  const timedOut = elapsed > aggregation.timeoutMs;
  const allReceived = result.receivedCount >= result.totalExpected;

  // Mode: first — complete as soon as any target succeeds
  if (aggregation.payload.aggregationMode === 'first' && payload.success) {
    completeAggregation(aggregationId, 'completed');
    return aggregationResults.get(aggregationId)!;
  }

  // Mode: majority — complete when strict majority of targets succeeded
  if (
    aggregation.payload.aggregationMode === 'majority' &&
    result.successCount > result.totalExpected / 2
  ) {
    completeAggregation(aggregationId, 'completed');
    return aggregationResults.get(aggregationId)!;
  }

  // All modes: complete when all results received or timeout
  if (allReceived || timedOut) {
    completeAggregation(aggregationId, timedOut ? 'failed' : 'completed');
    return aggregationResults.get(aggregationId)!;
  }

  return result;
}

function completeAggregation(aggregationId: string, state: AggregationState): void {
  const aggregation = aggregations.get(aggregationId);
  if (!aggregation) return;

  const result = aggregationResults.get(aggregationId)!;
  result.state = state;
  result.aggregatedAt = Date.now();
  result.durationMs = result.aggregatedAt - aggregation.startedAt;

  if (state === 'completed') {
    if (
      aggregation.payload.aggregationMode === 'custom' &&
      aggregation.payload.customAggregationRule
    ) {
      const customRule = customRules.get(aggregation.payload.customAggregationRule);
      if (customRule) {
        const customResult = customRule.handler(result.results);
        aggregationResults.set(aggregationId, { ...result, ...customResult });
      }
    }
  }

  aggregations.delete(aggregationId);

  Logger.info(
    `[FanInAggregator] Completed aggregation ${aggregationId}: state=${state}, success=${result.successCount}/${result.totalExpected}, duration=${result.durationMs}ms`
  );
}

export function getAggregation(pipelineId: string): AggregationResult | null {
  return aggregationResults.get(pipelineId) || null;
}

export function getPendingAggregations(): AggregationResult[] {
  const results: AggregationResult[] = [];
  for (const [id, agg] of aggregations) {
    const result = aggregationResults.get(id);
    if (result) results.push(result);
  }
  return results;
}

export function getAllAggregations(): AggregationResult[] {
  return [...aggregationResults.values()];
}

export function cleanupStaleAggregations(): number {
  const now = Date.now();
  let cleaned = 0;

  for (const [id, agg] of aggregations) {
    const elapsed = now - agg.startedAt;
    if (elapsed > agg.timeoutMs) {
      completeAggregation(id, 'failed');
      cleaned++;
    }
  }

  for (const [id, result] of aggregationResults) {
    const elapsed = now - result.aggregatedAt;
    if (elapsed > AGGREGATION_CLEANUP_MS) {
      aggregationResults.delete(id);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    Logger.info(`[FanInAggregator] Cleaned up ${cleaned} stale aggregations`);
  }

  return cleaned;
}

export function startCleanupScheduler(intervalMs = AGGREGATION_CLEANUP_MS): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
  }

  cleanupInterval = setInterval(() => {
    cleanupStaleAggregations();
  }, intervalMs);

  Logger.info(`[FanInAggregator] Started cleanup scheduler (interval: ${intervalMs}ms)`);
}

export function stopCleanupScheduler(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
    Logger.info('[FanInAggregator] Stopped cleanup scheduler');
  }
}

export function reset(): void {
  aggregations.clear();
  aggregationResults.clear();
  stopCleanupScheduler();
  Logger.info('[FanInAggregator] Reset complete');
}
