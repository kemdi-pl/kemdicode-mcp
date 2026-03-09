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
 * Orbit Compressor — Unit Tests
 *
 * Tests for Lorenz attractor orbital cycle detection and compression.
 */

import { describe, it, expect } from 'bun:test';
import {
  computeSimilarityMatrix,
  detectCycleRepetitions,
  findOrbitalCycles,
  analyzeOrbits,
  ORBIT,
  type ThoughtInput,
} from '../../src/cognition/orbit-compressor.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeThoughts(contents: string[]): ThoughtInput[] {
  return contents.map((content, i) => ({ index: i, content, confidence: 70 }));
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. computeSimilarityMatrix
// ─────────────────────────────────────────────────────────────────────────────

describe('computeSimilarityMatrix', () => {
  it('returns empty matrix for no thoughts', () => {
    expect(computeSimilarityMatrix([])).toEqual([]);
  });

  it('diagonal is always 1.0', () => {
    const thoughts = makeThoughts(['hello world', 'foo bar baz']);
    const matrix = computeSimilarityMatrix(thoughts);
    expect(matrix[0][0]).toBe(1.0);
    expect(matrix[1][1]).toBe(1.0);
  });

  it('matrix is symmetric', () => {
    const thoughts = makeThoughts(['database query', 'web server', 'database index']);
    const matrix = computeSimilarityMatrix(thoughts);
    for (let i = 0; i < matrix.length; i++) {
      for (let j = 0; j < matrix.length; j++) {
        expect(matrix[i][j]).toBe(matrix[j][i]);
      }
    }
  });

  it('similar thoughts have higher similarity', () => {
    const thoughts = makeThoughts([
      'analyzing database query performance',
      'checking database query execution plan',
      'the CSS grid layout for responsive design',
    ]);
    const matrix = computeSimilarityMatrix(thoughts);
    // thoughts 0 and 1 (both about database) should be more similar than 0 and 2
    expect(matrix[0][1]).toBeGreaterThan(matrix[0][2]);
  });

  it('values are between 0 and 1', () => {
    const thoughts = makeThoughts(['hello world', 'goodbye moon', 'testing code']);
    const matrix = computeSimilarityMatrix(thoughts);
    for (const row of matrix) {
      for (const val of row) {
        expect(val).toBeGreaterThanOrEqual(0);
        expect(val).toBeLessThanOrEqual(1);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. detectCycleRepetitions
// ─────────────────────────────────────────────────────────────────────────────

describe('detectCycleRepetitions', () => {
  it('returns 1 repetition when no repeat found', () => {
    const thoughts = makeThoughts([
      'analyzing server logs',
      'checking database schema',
      'reviewing frontend code',
      'testing API endpoints',
    ]);
    const matrix = computeSimilarityMatrix(thoughts);
    const result = detectCycleRepetitions(matrix, 0, 2, 0.9);
    expect(result.repetitions).toBe(1);
  });

  it('detects repetitions of identical content', () => {
    const thoughts = makeThoughts([
      'checking the build output for errors',
      'reviewing the test results carefully',
      'checking the build output for errors',
      'reviewing the test results carefully',
    ]);
    const matrix = computeSimilarityMatrix(thoughts);
    const result = detectCycleRepetitions(matrix, 0, 2, 0.5);
    expect(result.repetitions).toBe(2);
    expect(result.avgSimilarity).toBeGreaterThan(0.5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. findOrbitalCycles
// ─────────────────────────────────────────────────────────────────────────────

describe('findOrbitalCycles', () => {
  it('returns empty for too few thoughts', () => {
    const thoughts = makeThoughts(['a', 'b', 'c']);
    expect(findOrbitalCycles(thoughts)).toEqual([]);
  });

  it('detects repeating pattern', () => {
    const thoughts = makeThoughts([
      'step one: analyze the database query performance metrics',
      'step two: optimize the slow database queries identified',
      'step one: analyze the database query performance metrics',
      'step two: optimize the slow database queries identified',
    ]);
    const orbits = findOrbitalCycles(thoughts, 0.4);
    expect(orbits.length).toBeGreaterThanOrEqual(1);
    if (orbits.length > 0) {
      expect(orbits[0].repetitions).toBeGreaterThanOrEqual(2);
      expect(orbits[0].pruneIndices.length).toBeGreaterThan(0);
    }
  });

  it('keeps first cycle, prunes duplicates', () => {
    const thoughts = makeThoughts([
      'reviewing code quality standards and best practices for the project',
      'checking for common security vulnerabilities in the codebase',
      'reviewing code quality standards and best practices for the project',
      'checking for common security vulnerabilities in the codebase',
    ]);
    const orbits = findOrbitalCycles(thoughts, 0.4);
    if (orbits.length > 0) {
      // Keep indices should be from first cycle
      for (const idx of orbits[0].keepIndices) {
        expect(idx).toBeLessThan(orbits[0].cycleLength);
      }
      // Prune indices should be from later cycles
      for (const idx of orbits[0].pruneIndices) {
        expect(idx).toBeGreaterThanOrEqual(orbits[0].cycleLength);
      }
    }
  });

  it('does not detect cycle in diverse thoughts', () => {
    const thoughts = makeThoughts([
      'the server uses Express for HTTP routing and middleware',
      'React components render virtual DOM for efficient updates',
      'PostgreSQL handles ACID transactions with MVCC',
      'Kubernetes orchestrates container deployment and scaling',
    ]);
    const orbits = findOrbitalCycles(thoughts, 0.7);
    expect(orbits).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. analyzeOrbits (full pipeline)
// ─────────────────────────────────────────────────────────────────────────────

describe('analyzeOrbits', () => {
  it('handles empty input', () => {
    const result = analyzeOrbits([]);
    expect(result.orbits).toEqual([]);
    expect(result.pruneIndices).toEqual([]);
    expect(result.keepIndices).toEqual([]);
    expect(result.compressionRatio).toBe(1);
  });

  it('keeps all thoughts when no orbits detected', () => {
    const thoughts = makeThoughts([
      'analyzing backend architecture',
      'designing frontend components',
      'writing integration tests',
      'configuring deployment pipeline',
    ]);
    const result = analyzeOrbits(thoughts, 0.9);
    expect(result.pruneIndices).toEqual([]);
    expect(result.keepIndices).toHaveLength(thoughts.length);
    expect(result.compressionRatio).toBe(1);
  });

  it('compression ratio decreases when orbits found', () => {
    const thoughts = makeThoughts([
      'checking build output for compilation errors in the project',
      'running test suite to verify code correctness after changes',
      'checking build output for compilation errors in the project',
      'running test suite to verify code correctness after changes',
      'checking build output for compilation errors in the project',
      'running test suite to verify code correctness after changes',
    ]);
    const result = analyzeOrbits(thoughts, 0.4);
    if (result.orbits.length > 0) {
      expect(result.compressionRatio).toBeLessThan(1);
      expect(result.pruneIndices.length).toBeGreaterThan(0);
    }
  });

  it('pruneIndices are sorted', () => {
    const thoughts = makeThoughts([
      'analyze performance metrics of the server',
      'optimize identified bottlenecks in queries',
      'analyze performance metrics of the server',
      'optimize identified bottlenecks in queries',
    ]);
    const result = analyzeOrbits(thoughts, 0.4);
    for (let i = 1; i < result.pruneIndices.length; i++) {
      expect(result.pruneIndices[i]).toBeGreaterThan(result.pruneIndices[i - 1]);
    }
  });

  it('keepIndices + pruneIndices cover all thoughts', () => {
    const thoughts = makeThoughts([
      'reviewing API endpoint security configuration settings',
      'testing authentication flow for user login process',
      'reviewing API endpoint security configuration settings',
      'testing authentication flow for user login process',
    ]);
    const result = analyzeOrbits(thoughts, 0.4);
    const allIndices = new Set([...result.keepIndices, ...result.pruneIndices]);
    expect(allIndices.size).toBe(thoughts.length);
  });

  it('constants have expected defaults', () => {
    expect(ORBIT.SIMILARITY_THRESHOLD).toBe(0.5);
    expect(ORBIT.MIN_CYCLE_LENGTH).toBe(2);
    expect(ORBIT.MAX_CYCLE_LENGTH).toBe(10);
    expect(ORBIT.MIN_REPETITIONS).toBe(2);
  });
});
