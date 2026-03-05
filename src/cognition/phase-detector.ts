/**
 * KemdiCode MCP Server
 * Copyright (C) 2025-2026 Kemdi Sp. z o.o. (Dawid Irzyk <dawid@kemdi.pl>)
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

/**
 * Phase Detector — Poincaré Section Analysis for Thinking Chains
 *
 * Inspired by Lorenz's observations on deterministic chaos:
 * A Poincaré section is a lower-dimensional slice through a dynamical
 * system's phase space. Each crossing captures the system state at a
 * critical moment — the transition between qualitative regimes.
 *
 * Applied to AI reasoning:
 * - "Phase" = a coherent segment of thought on a single topic/approach
 * - "Phase boundary" = the moment reasoning switches topic or strategy
 * - Phase boundaries carry MAXIMUM information about the thinking trajectory
 *
 * During compaction, preserving phase boundaries (Poincaré crossings)
 * gives a minimal skeleton that reconstructs the full reasoning path.
 *
 * All functions are pure (no side effects, no Redis, no I/O).
 *
 * @module cognition/phase-detector
 */

import { jensenShannonDivergence, textToDistribution } from './ctc-math.js';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

export const PHASE = {
  /** Default JSD threshold for detecting phase boundary */
  BOUNDARY_THRESHOLD: 0.35,
  /** Minimum segment length (thoughts) to qualify as a phase */
  MIN_SEGMENT_LENGTH: 2,
  /** Smoothing window for JSD computation */
  SMOOTHING_WINDOW: 1,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ThoughtInput {
  index: number;
  content: string;
  confidence: number;
}

export interface PhaseBoundary {
  /** Index of the thought where phase transition occurs */
  index: number;
  /** JSD between thought[index-1] and thought[index] */
  divergence: number;
  /** Topic distribution before boundary */
  beforeTopTerms: string[];
  /** Topic distribution after boundary */
  afterTopTerms: string[];
}

export interface PhaseSegment {
  /** Start thought index (inclusive) */
  startIndex: number;
  /** End thought index (inclusive) */
  endIndex: number;
  /** Number of thoughts in this phase */
  length: number;
  /** Average confidence within this phase */
  avgConfidence: number;
  /** Top terms characterizing this phase */
  topTerms: string[];
}

export interface PhaseAnalysis {
  /** Detected phase boundaries (Poincaré crossings) */
  boundaries: PhaseBoundary[];
  /** Coherent phase segments between boundaries */
  segments: PhaseSegment[];
  /** Indices to preserve during compaction (boundary thoughts) */
  preserveIndices: number[];
  /** Overall phase count */
  phaseCount: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Core Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute pairwise JSD between consecutive thoughts.
 *
 * For each pair (thought[i], thought[i+1]):
 *   jsd[i] = JSD(dist(thought[i].content), dist(thought[i+1].content))
 *
 * High JSD = topic change = potential phase boundary.
 *
 * @param thoughts - Ordered array of thoughts
 * @returns Array of JSD values (length = thoughts.length - 1)
 */
export function computeConsecutiveJSD(thoughts: ThoughtInput[]): number[] {
  if (thoughts.length < 2) return [];

  const distributions = thoughts.map((t) => textToDistribution(t.content));
  const jsds: number[] = [];

  for (let i = 0; i < distributions.length - 1; i++) {
    jsds.push(jensenShannonDivergence(distributions[i], distributions[i + 1]));
  }

  return jsds;
}

/**
 * Get top N terms from a distribution, sorted by probability.
 */
function topTerms(dist: Map<string, number>, n: number = 3): string[] {
  return [...dist.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([term]) => term);
}

/**
 * Detect phase boundaries in a thinking chain.
 *
 * A phase boundary occurs at thought[i] when:
 *   JSD(thought[i-1], thought[i]) > threshold
 *
 * This is the Poincaré section: each crossing captures a qualitative
 * shift in the reasoning trajectory.
 *
 * @param thoughts  - Ordered array of thoughts
 * @param threshold - JSD threshold for boundary detection (default 0.35)
 * @returns Array of PhaseBoundary objects
 */
export function detectPhaseBoundaries(
  thoughts: ThoughtInput[],
  threshold: number = PHASE.BOUNDARY_THRESHOLD,
): PhaseBoundary[] {
  if (thoughts.length < 2) return [];

  const jsds = computeConsecutiveJSD(thoughts);
  const distributions = thoughts.map((t) => textToDistribution(t.content));
  const boundaries: PhaseBoundary[] = [];

  for (let i = 0; i < jsds.length; i++) {
    if (jsds[i] >= threshold) {
      boundaries.push({
        index: thoughts[i + 1].index,
        divergence: Math.round(jsds[i] * 1000) / 1000,
        beforeTopTerms: topTerms(distributions[i]),
        afterTopTerms: topTerms(distributions[i + 1]),
      });
    }
  }

  return boundaries;
}

/**
 * Extract coherent phase segments between boundaries.
 *
 * Each segment is a contiguous run of thoughts within the same "phase"
 * — i.e., thoughts between two consecutive Poincaré crossings.
 *
 * @param thoughts   - Ordered array of thoughts
 * @param boundaries - Detected phase boundaries
 * @returns Array of PhaseSegment objects
 */
export function extractPhaseSegments(
  thoughts: ThoughtInput[],
  boundaries: PhaseBoundary[],
): PhaseSegment[] {
  if (thoughts.length === 0) return [];

  const boundaryIndices = new Set(boundaries.map((b) => b.index));
  const segments: PhaseSegment[] = [];

  let segStart = 0;

  for (let i = 0; i < thoughts.length; i++) {
    if (boundaryIndices.has(thoughts[i].index) && i > segStart) {
      // End current segment, start new one
      segments.push(buildSegment(thoughts, segStart, i - 1));
      segStart = i;
    }
  }

  // Final segment
  if (segStart < thoughts.length) {
    segments.push(buildSegment(thoughts, segStart, thoughts.length - 1));
  }

  return segments;
}

function buildSegment(
  thoughts: ThoughtInput[],
  startIdx: number,
  endIdx: number,
): PhaseSegment {
  const slice = thoughts.slice(startIdx, endIdx + 1);
  const avgConf = slice.reduce((sum, t) => sum + t.confidence, 0) / slice.length;
  const combinedText = slice.map((t) => t.content).join(' ');
  const dist = textToDistribution(combinedText);

  return {
    startIndex: thoughts[startIdx].index,
    endIndex: thoughts[endIdx].index,
    length: slice.length,
    avgConfidence: Math.round(avgConf * 10) / 10,
    topTerms: topTerms(dist, 5),
  };
}

/**
 * Full phase analysis of a thinking chain.
 *
 * Combines boundary detection and segment extraction to produce
 * a complete phase decomposition with preservation indices.
 *
 * Preservation strategy:
 * - Always preserve first and last thought
 * - Preserve all boundary thoughts (Poincaré crossings)
 * - Preserve the highest-confidence thought in each segment
 *
 * @param thoughts  - Ordered array of thoughts
 * @param threshold - JSD threshold (default 0.35)
 */
export function analyzePhases(
  thoughts: ThoughtInput[],
  threshold: number = PHASE.BOUNDARY_THRESHOLD,
): PhaseAnalysis {
  if (thoughts.length === 0) {
    return { boundaries: [], segments: [], preserveIndices: [], phaseCount: 0 };
  }

  if (thoughts.length === 1) {
    return {
      boundaries: [],
      segments: [buildSegment(thoughts, 0, 0)],
      preserveIndices: [thoughts[0].index],
      phaseCount: 1,
    };
  }

  const boundaries = detectPhaseBoundaries(thoughts, threshold);
  const segments = extractPhaseSegments(thoughts, boundaries);

  // Build preservation set
  const preserveSet = new Set<number>();

  // Always preserve first and last
  preserveSet.add(thoughts[0].index);
  preserveSet.add(thoughts[thoughts.length - 1].index);

  // Preserve all boundary thoughts
  for (const b of boundaries) {
    preserveSet.add(b.index);
  }

  // Preserve highest-confidence thought per segment
  for (const seg of segments) {
    const segThoughts = thoughts.filter(
      (t) => t.index >= seg.startIndex && t.index <= seg.endIndex,
    );
    if (segThoughts.length > 0) {
      const best = segThoughts.reduce((a, b) =>
        a.confidence >= b.confidence ? a : b,
      );
      preserveSet.add(best.index);
    }
  }

  const preserveIndices = [...preserveSet].sort((a, b) => a - b);

  return {
    boundaries,
    segments,
    preserveIndices,
    phaseCount: segments.length,
  };
}
