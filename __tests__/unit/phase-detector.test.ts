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
 * Phase Detector — Unit Tests
 *
 * Tests for Poincaré section phase detection in thinking chains.
 */

import { describe, it, expect } from 'bun:test';
import {
  computeConsecutiveJSD,
  detectPhaseBoundaries,
  extractPhaseSegments,
  analyzePhases,
  PHASE,
  type ThoughtInput,
} from '../../src/cognition/phase-detector.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeThoughts(contents: string[]): ThoughtInput[] {
  return contents.map((content, i) => ({ index: i, content, confidence: 70 }));
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. computeConsecutiveJSD
// ─────────────────────────────────────────────────────────────────────────────

describe('computeConsecutiveJSD', () => {
  it('returns empty array for 0 or 1 thoughts', () => {
    expect(computeConsecutiveJSD([])).toEqual([]);
    expect(computeConsecutiveJSD(makeThoughts(['hello']))).toEqual([]);
  });

  it('returns JSD values for consecutive pairs', () => {
    const thoughts = makeThoughts(['hello world', 'hello world again']);
    const jsds = computeConsecutiveJSD(thoughts);
    expect(jsds).toHaveLength(1);
    expect(jsds[0]).toBeGreaterThanOrEqual(0);
    expect(jsds[0]).toBeLessThanOrEqual(1);
  });

  it('shows low JSD for similar thoughts', () => {
    const thoughts = makeThoughts([
      'the database query is slow because of missing index',
      'the database query performance issue is from missing index',
    ]);
    const jsds = computeConsecutiveJSD(thoughts);
    expect(jsds[0]).toBeLessThan(PHASE.BOUNDARY_THRESHOLD);
  });

  it('shows high JSD for dissimilar thoughts', () => {
    const thoughts = makeThoughts([
      'the database query optimization requires adding an index on the users table',
      'the frontend CSS layout uses flexbox with responsive breakpoints for mobile',
    ]);
    const jsds = computeConsecutiveJSD(thoughts);
    expect(jsds[0]).toBeGreaterThan(0.2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. detectPhaseBoundaries
// ─────────────────────────────────────────────────────────────────────────────

describe('detectPhaseBoundaries', () => {
  it('returns empty for fewer than 2 thoughts', () => {
    expect(detectPhaseBoundaries([])).toEqual([]);
    expect(detectPhaseBoundaries(makeThoughts(['single']))).toEqual([]);
  });

  it('detects fewer boundaries for similar thoughts than dissimilar ones', () => {
    const similar = makeThoughts([
      'analyzing the performance of SQL queries in the database',
      'checking SQL query execution plans for database optimization',
      'reviewing database query performance metrics and SQL plans',
    ]);
    const dissimilar = makeThoughts([
      'analyzing the performance of SQL queries in the database',
      'the React component uses hooks for managing frontend state',
      'Kubernetes pod scheduling and container orchestration setup',
    ]);
    const similarBoundaries = detectPhaseBoundaries(similar);
    const dissimilarBoundaries = detectPhaseBoundaries(dissimilar);
    expect(dissimilarBoundaries.length).toBeGreaterThanOrEqual(similarBoundaries.length);
  });

  it('detects boundary at topic change', () => {
    const thoughts = makeThoughts([
      'the server runs on Node.js with Express framework handling HTTP requests',
      'the server processes requests through middleware pipeline in Express',
      'the CSS stylesheet uses modern grid layout with custom properties for theming',
      'the responsive design adapts grid columns based on viewport width breakpoints',
    ]);
    const boundaries = detectPhaseBoundaries(thoughts, 0.25);
    expect(boundaries.length).toBeGreaterThanOrEqual(1);
    // Boundary should be between server and CSS thoughts
    const boundaryIndices = boundaries.map(b => b.index);
    expect(boundaryIndices).toContain(2);
  });

  it('boundary has divergence and top terms', () => {
    const thoughts = makeThoughts([
      'analyzing database performance with slow query logging enabled for MySQL',
      'the React component uses useState hook for managing local state and effects',
    ]);
    const boundaries = detectPhaseBoundaries(thoughts, 0.1);
    if (boundaries.length > 0) {
      expect(boundaries[0]).toHaveProperty('divergence');
      expect(boundaries[0]).toHaveProperty('beforeTopTerms');
      expect(boundaries[0]).toHaveProperty('afterTopTerms');
      expect(boundaries[0].divergence).toBeGreaterThan(0);
      expect(Array.isArray(boundaries[0].beforeTopTerms)).toBe(true);
      expect(Array.isArray(boundaries[0].afterTopTerms)).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. extractPhaseSegments
// ─────────────────────────────────────────────────────────────────────────────

describe('extractPhaseSegments', () => {
  it('returns empty for empty thoughts', () => {
    expect(extractPhaseSegments([], [])).toEqual([]);
  });

  it('returns single segment when no boundaries', () => {
    const thoughts = makeThoughts(['a', 'b', 'c']);
    const segments = extractPhaseSegments(thoughts, []);
    expect(segments).toHaveLength(1);
    expect(segments[0].startIndex).toBe(0);
    expect(segments[0].endIndex).toBe(2);
    expect(segments[0].length).toBe(3);
  });

  it('splits into segments at boundaries', () => {
    const thoughts = makeThoughts(['a', 'b', 'c', 'd']);
    const boundaries = [{ index: 2, divergence: 0.5, beforeTopTerms: [], afterTopTerms: [] }];
    const segments = extractPhaseSegments(thoughts, boundaries);
    expect(segments).toHaveLength(2);
    expect(segments[0].endIndex).toBe(1);
    expect(segments[1].startIndex).toBe(2);
  });

  it('segment has avgConfidence and topTerms', () => {
    const thoughts: ThoughtInput[] = [
      { index: 0, content: 'analyzing code quality', confidence: 80 },
      { index: 1, content: 'code review patterns', confidence: 90 },
    ];
    const segments = extractPhaseSegments(thoughts, []);
    expect(segments[0].avgConfidence).toBe(85);
    expect(Array.isArray(segments[0].topTerms)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. analyzePhases (full pipeline)
// ─────────────────────────────────────────────────────────────────────────────

describe('analyzePhases', () => {
  it('handles empty input', () => {
    const result = analyzePhases([]);
    expect(result.phaseCount).toBe(0);
    expect(result.boundaries).toEqual([]);
    expect(result.segments).toEqual([]);
    expect(result.preserveIndices).toEqual([]);
  });

  it('handles single thought', () => {
    const result = analyzePhases(makeThoughts(['only one']));
    expect(result.phaseCount).toBe(1);
    expect(result.preserveIndices).toEqual([0]);
  });

  it('preserves first and last thought', () => {
    const thoughts = makeThoughts([
      'start of analysis',
      'middle work',
      'end of analysis',
    ]);
    const result = analyzePhases(thoughts);
    expect(result.preserveIndices).toContain(0);
    expect(result.preserveIndices).toContain(2);
  });

  it('preserves boundary thoughts', () => {
    const thoughts = makeThoughts([
      'the server handles HTTP requests with express middleware and routing',
      'express middleware processes authentication and validation steps',
      'the CSS grid layout provides responsive columns for the dashboard UI',
      'dashboard UI components are styled with CSS custom properties and grid',
    ]);
    const result = analyzePhases(thoughts, 0.25);
    // Should preserve first, last, and any boundary thoughts
    expect(result.preserveIndices.length).toBeGreaterThanOrEqual(2);
    expect(result.preserveIndices).toContain(0);
    expect(result.preserveIndices).toContain(3);
  });

  it('preserveIndices are sorted', () => {
    const thoughts = makeThoughts([
      'database optimization analysis',
      'query execution plan review',
      'frontend component architecture',
      'React hooks implementation',
      'deployment configuration',
    ]);
    const result = analyzePhases(thoughts);
    for (let i = 1; i < result.preserveIndices.length; i++) {
      expect(result.preserveIndices[i]).toBeGreaterThan(result.preserveIndices[i - 1]);
    }
  });

  it('segments cover all thoughts', () => {
    const thoughts = makeThoughts([
      'analyzing server performance',
      'checking API response times',
      'reviewing frontend bundle size',
      'optimizing CSS delivery',
    ]);
    const result = analyzePhases(thoughts);
    const totalLength = result.segments.reduce((sum, s) => sum + s.length, 0);
    expect(totalLength).toBe(thoughts.length);
  });
});
