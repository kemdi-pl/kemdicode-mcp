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
 * Orbit Compressor — Lorenz Attractor Pattern Detection
 *
 * In Lorenz's system, trajectories orbit around two "eyes" of the
 * strange attractor, tracing similar paths repeatedly. Each orbit
 * is slightly different but follows the same qualitative pattern.
 *
 * Applied to AI reasoning:
 * - "Orbit" = a repeating pattern in the thinking chain
 *   (e.g., analyzing the same problem from similar angles)
 * - "Orbital cycle" = one complete traversal of a repeating pattern
 * - Compression: keep one representative cycle, prune duplicates
 *
 * Detection uses n-gram fingerprinting on thought content to find
 * subsequences with high similarity, then collapses them.
 *
 * All functions are pure (no side effects, no Redis, no I/O).
 *
 * @module cognition/orbit-compressor
 */

import { tfidfCosineSimilarity } from './ctc-math.js';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

export const ORBIT = {
  /** Minimum similarity for two thoughts to be considered orbital duplicates */
  SIMILARITY_THRESHOLD: 0.5,
  /** Minimum orbital cycle length (thoughts) */
  MIN_CYCLE_LENGTH: 2,
  /** Maximum orbital cycle length to search for */
  MAX_CYCLE_LENGTH: 10,
  /** Minimum number of repetitions to qualify as an orbit */
  MIN_REPETITIONS: 2,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ThoughtInput {
  index: number;
  content: string;
  confidence: number;
}

export interface OrbitalCycle {
  /** Start index of the first occurrence of this cycle */
  startIndex: number;
  /** Length of one cycle (number of thoughts) */
  cycleLength: number;
  /** Number of times this cycle repeats */
  repetitions: number;
  /** Average similarity between cycle repetitions */
  avgSimilarity: number;
  /** Indices of all thoughts in this orbital pattern */
  allIndices: number[];
  /** Indices to KEEP (one representative cycle) */
  keepIndices: number[];
  /** Indices to PRUNE (duplicate cycles) */
  pruneIndices: number[];
}

export interface OrbitAnalysis {
  /** Detected orbital cycles */
  orbits: OrbitalCycle[];
  /** All indices that should be pruned (deduplicated) */
  pruneIndices: number[];
  /** All indices that should be kept */
  keepIndices: number[];
  /** Compression ratio: kept/total */
  compressionRatio: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Core Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute similarity matrix between all thoughts.
 *
 * sim[i][j] = tfidfCosineSimilarity(thought[i].content, thought[j].content)
 *
 * @param thoughts - Ordered array of thoughts
 * @returns 2D similarity matrix
 */
export function computeSimilarityMatrix(thoughts: ThoughtInput[]): number[][] {
  const n = thoughts.length;
  const matrix: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));

  for (let i = 0; i < n; i++) {
    matrix[i][i] = 1.0;
    for (let j = i + 1; j < n; j++) {
      const sim = tfidfCosineSimilarity(thoughts[i].content, thoughts[j].content);
      matrix[i][j] = sim;
      matrix[j][i] = sim;
    }
  }

  return matrix;
}

/**
 * Detect if a cycle of length `cycleLen` starting at `start` repeats.
 *
 * Checks if thoughts[start..start+cycleLen-1] is similar to
 * thoughts[start+cycleLen..start+2*cycleLen-1], etc.
 *
 * @param simMatrix  - Precomputed similarity matrix
 * @param start      - Starting index
 * @param cycleLen   - Length of one cycle
 * @param threshold  - Minimum average similarity for match
 * @returns Number of repetitions found (≥1 means the original exists)
 */
export function detectCycleRepetitions(
  simMatrix: number[][],
  start: number,
  cycleLen: number,
  threshold: number = ORBIT.SIMILARITY_THRESHOLD,
): { repetitions: number; avgSimilarity: number } {
  const n = simMatrix.length;
  let repetitions = 1;
  let totalSim = 0;
  let totalPairs = 0;

  let nextStart = start + cycleLen;

  while (nextStart + cycleLen <= n) {
    // Compare each element of the original cycle with the candidate
    let cycleSim = 0;
    for (let k = 0; k < cycleLen; k++) {
      cycleSim += simMatrix[start + k][nextStart + k];
    }
    const avgCycleSim = cycleSim / cycleLen;

    if (avgCycleSim >= threshold) {
      repetitions++;
      totalSim += avgCycleSim;
      totalPairs++;
      nextStart += cycleLen;
    } else {
      break;
    }
  }

  return {
    repetitions,
    avgSimilarity: totalPairs > 0 ? Math.round((totalSim / totalPairs) * 1000) / 1000 : 0,
  };
}

/**
 * Find all orbital cycles in a thinking chain.
 *
 * Scans for repeating patterns of length [MIN_CYCLE, MAX_CYCLE].
 * Uses greedy: once a cycle is found, its indices are marked and
 * won't be part of another detected cycle.
 *
 * @param thoughts  - Ordered array of thoughts
 * @param threshold - Similarity threshold (default 0.5)
 * @returns Array of detected OrbitalCycle objects
 */
export function findOrbitalCycles(
  thoughts: ThoughtInput[],
  threshold: number = ORBIT.SIMILARITY_THRESHOLD,
): OrbitalCycle[] {
  if (thoughts.length < ORBIT.MIN_CYCLE_LENGTH * ORBIT.MIN_REPETITIONS) {
    return [];
  }

  const simMatrix = computeSimilarityMatrix(thoughts);
  const claimed = new Set<number>();
  const orbits: OrbitalCycle[] = [];

  // Try longer cycles first (greedy: prefer longer patterns)
  for (let cycleLen = Math.min(ORBIT.MAX_CYCLE_LENGTH, Math.floor(thoughts.length / 2));
    cycleLen >= ORBIT.MIN_CYCLE_LENGTH;
    cycleLen--
  ) {
    for (let start = 0; start + cycleLen * ORBIT.MIN_REPETITIONS <= thoughts.length; start++) {
      // Skip if any thought in this window is already claimed
      let skip = false;
      for (let k = start; k < start + cycleLen; k++) {
        if (claimed.has(k)) { skip = true; break; }
      }
      if (skip) continue;

      const { repetitions, avgSimilarity } = detectCycleRepetitions(
        simMatrix, start, cycleLen, threshold,
      );

      if (repetitions >= ORBIT.MIN_REPETITIONS) {
        const allIndices: number[] = [];
        for (let r = 0; r < repetitions; r++) {
          for (let k = 0; k < cycleLen; k++) {
            allIndices.push(start + r * cycleLen + k);
          }
        }

        // Keep first cycle, prune rest
        const keepIndices = allIndices.slice(0, cycleLen).map((i) => thoughts[i].index);
        const pruneIndices = allIndices.slice(cycleLen).map((i) => thoughts[i].index);

        orbits.push({
          startIndex: thoughts[start].index,
          cycleLength: cycleLen,
          repetitions,
          avgSimilarity,
          allIndices: allIndices.map((i) => thoughts[i].index),
          keepIndices,
          pruneIndices,
        });

        // Mark all indices as claimed
        for (const idx of allIndices) {
          claimed.add(idx);
        }
      }
    }
  }

  return orbits;
}

/**
 * Full orbit analysis of a thinking chain.
 *
 * Finds orbital cycles, determines which thoughts to keep/prune,
 * and computes the compression ratio.
 *
 * @param thoughts  - Ordered array of thoughts
 * @param threshold - Similarity threshold (default 0.5)
 */
export function analyzeOrbits(
  thoughts: ThoughtInput[],
  threshold: number = ORBIT.SIMILARITY_THRESHOLD,
): OrbitAnalysis {
  if (thoughts.length === 0) {
    return { orbits: [], pruneIndices: [], keepIndices: [], compressionRatio: 1 };
  }

  const orbits = findOrbitalCycles(thoughts, threshold);

  const pruneSet = new Set<number>();
  for (const orbit of orbits) {
    for (const idx of orbit.pruneIndices) {
      pruneSet.add(idx);
    }
  }

  const allIndices = thoughts.map((t) => t.index);
  const keepIndices = allIndices.filter((idx) => !pruneSet.has(idx));
  const pruneIndices = [...pruneSet].sort((a, b) => a - b);

  const compressionRatio =
    thoughts.length > 0
      ? Math.round((keepIndices.length / thoughts.length) * 1000) / 1000
      : 1;

  return {
    orbits,
    pruneIndices,
    keepIndices,
    compressionRatio,
  };
}
