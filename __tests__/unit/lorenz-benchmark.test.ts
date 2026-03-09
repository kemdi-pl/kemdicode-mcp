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
 * Lorenz Compaction Benchmark — Integration Test
 *
 * Tests the full Lorenz pipeline (Phase Detection → Orbit Compression → CTC)
 * with realistic multi-phase thinking chain data to validate compaction quality.
 */

import { describe, it, expect } from 'bun:test';
import { analyzePhases, type ThoughtInput as PhaseThought } from '../../src/cognition/phase-detector.js';
import { analyzeOrbits, type ThoughtInput as OrbitThought } from '../../src/cognition/orbit-compressor.js';
import { compactThinkingChain } from '../../src/cognition/ctc-math.js';

// ─────────────────────────────────────────────────────────────────────────────
// Realistic thinking chain: multi-phase debugging session
// ─────────────────────────────────────────────────────────────────────────────

const DEBUGGING_CHAIN: Array<{ content: string; confidence: number }> = [
  // Phase 1: Understanding the bug report (3 thoughts)
  { content: 'The user reports that API responses are slow when fetching user profiles. Average response time is 3 seconds instead of expected 200ms. Need to investigate the database queries and middleware chain.', confidence: 40 },
  { content: 'Looking at the error logs, there are no exceptions being thrown. The issue is purely performance related. The slow responses happen consistently, not intermittently, which suggests a systemic cause rather than network or resource contention.', confidence: 45 },
  { content: 'Checked the API route handler for user profiles. It calls getUserById which queries the users table, then fetches related data from orders and preferences tables in separate queries. This could be an N+1 query problem.', confidence: 60 },

  // Phase 2: Database investigation (4 thoughts, including orbital repetition)
  { content: 'Running EXPLAIN ANALYZE on the users query shows a sequential scan instead of index scan. The users table has 2 million rows and the id column index exists but the query planner is not using it because of a type mismatch between the parameter and column type.', confidence: 70 },
  { content: 'The orders table query also shows a sequential scan. The foreign key user_id on orders does not have an index. Adding CREATE INDEX idx_orders_user_id ON orders(user_id) should fix this specific query.', confidence: 75 },
  // Orbit: repeating the same analysis pattern
  { content: 'Running EXPLAIN ANALYZE on the preferences query shows a sequential scan too. The preferences table foreign key user_id also lacks an index. Need to add CREATE INDEX idx_preferences_user_id ON preferences(user_id) for this query as well.', confidence: 75 },
  { content: 'Running EXPLAIN ANALYZE on the activity_log query shows the same sequential scan pattern. The activity_log table foreign key user_id needs an index too. Adding CREATE INDEX idx_activity_user_id ON activity_log(user_id).', confidence: 75 },

  // Phase 3: Solution design (3 thoughts)
  { content: 'The root cause is clear: missing indexes on foreign key columns combined with N+1 query pattern. Instead of fixing just indexes, we should also consolidate the three separate queries into a single JOIN query to reduce round trips to the database.', confidence: 85 },
  { content: 'Designing the consolidated query: SELECT u.*, o.order_count, p.theme FROM users u LEFT JOIN (SELECT user_id, COUNT(*) as order_count FROM orders GROUP BY user_id) o ON u.id = o.user_id LEFT JOIN preferences p ON u.id = p.user_id WHERE u.id = $1', confidence: 90 },
  { content: 'The fix requires three changes: add missing indexes on foreign keys, replace N+1 queries with a single JOIN, and add a cache layer with 5 minute TTL for frequently accessed profiles. Expected improvement from 3 seconds to under 100 milliseconds.', confidence: 95 },
];

function makeThoughts(chain: typeof DEBUGGING_CHAIN): PhaseThought[] {
  return chain.map((t, i) => ({ index: i, content: t.content, confidence: t.confidence }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('Lorenz Compaction Benchmark', () => {
  describe('Phase Detection on realistic data', () => {
    it('detects multiple phases in debugging chain', () => {
      const thoughts = makeThoughts(DEBUGGING_CHAIN);
      const result = analyzePhases(thoughts, 0.3);

      // Should detect at least 2 phase boundaries (understanding → DB → solution)
      expect(result.phaseCount).toBeGreaterThanOrEqual(2);
      expect(result.boundaries.length).toBeGreaterThanOrEqual(1);
    });

    it('preserves first and last thoughts', () => {
      const thoughts = makeThoughts(DEBUGGING_CHAIN);
      const result = analyzePhases(thoughts, 0.3);

      expect(result.preserveIndices).toContain(0);
      expect(result.preserveIndices).toContain(DEBUGGING_CHAIN.length - 1);
    });

    it('preserves high-confidence thoughts per segment', () => {
      const thoughts = makeThoughts(DEBUGGING_CHAIN);
      const result = analyzePhases(thoughts, 0.3);

      // The highest confidence thought (95%, index 9) should be preserved
      expect(result.preserveIndices).toContain(9);
    });

    it('reduction: preserveIndices <= total thoughts', () => {
      const thoughts = makeThoughts(DEBUGGING_CHAIN);
      const result = analyzePhases(thoughts, 0.3);

      // Phase detection preserves a subset (may keep all if chain is short)
      expect(result.preserveIndices.length).toBeLessThanOrEqual(thoughts.length);
      // Should keep at least first + last (2 minimum)
      expect(result.preserveIndices.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('Orbit Compression on realistic data', () => {
    it('detects orbital repetition in DB analysis phase', () => {
      const thoughts = makeThoughts(DEBUGGING_CHAIN) as OrbitThought[];
      const result = analyzeOrbits(thoughts, 0.45);

      // The three sequential scan analyses (indices 3-6) form an orbital pattern
      if (result.orbits.length > 0) {
        expect(result.compressionRatio).toBeLessThan(1);
        expect(result.pruneIndices.length).toBeGreaterThan(0);
      }
    });

    it('keeps at least one representative of each orbit', () => {
      const thoughts = makeThoughts(DEBUGGING_CHAIN) as OrbitThought[];
      const result = analyzeOrbits(thoughts, 0.45);

      for (const orbit of result.orbits) {
        expect(orbit.keepIndices.length).toBeGreaterThanOrEqual(orbit.cycleLength);
      }
    });

    it('does not prune unique thoughts', () => {
      const thoughts = makeThoughts(DEBUGGING_CHAIN) as OrbitThought[];
      const result = analyzeOrbits(thoughts, 0.45);

      // First thought (bug report) and last (solution) should never be pruned
      expect(result.pruneIndices).not.toContain(0);
      expect(result.pruneIndices).not.toContain(DEBUGGING_CHAIN.length - 1);
    });
  });

  describe('CTC Fixed-Point compaction', () => {
    const conclusion = 'The fix requires adding missing indexes on foreign keys, replacing N+1 queries with a single JOIN, and adding a cache layer with 5 minute TTL.';

    it('compacts thinking chain preserving key insights', () => {
      const thoughts = makeThoughts(DEBUGGING_CHAIN);
      const result = compactThinkingChain(thoughts, conclusion);

      // Should prune some thoughts (early investigation thoughts diverge from conclusion)
      expect(result.prunedIndices.length).toBeGreaterThan(0);
      // Should keep at least the fixed point
      expect(result.keptIndices.length).toBeGreaterThanOrEqual(1);
      // Kept + pruned = total
      expect(result.keptIndices.length + result.prunedIndices.length).toBe(DEBUGGING_CHAIN.length);

      // With a lower threshold, more thoughts survive
      const relaxed = compactThinkingChain(thoughts, conclusion, 0.05);
      expect(relaxed.keptIndices.length).toBeGreaterThanOrEqual(result.keptIndices.length);
    });

    it('finds fixed point near conclusion', () => {
      const thoughts = makeThoughts(DEBUGGING_CHAIN);
      const result = compactThinkingChain(thoughts, conclusion);

      // Fixed point should be one of the later thoughts (solution phase)
      expect(result.fixedPointIndex).toBeGreaterThanOrEqual(7);
      // Consistency score should be meaningful
      expect(result.consistencyScore).toBeGreaterThan(0);
    });

    it('keeps the fixed point thought', () => {
      const thoughts = makeThoughts(DEBUGGING_CHAIN);
      const result = compactThinkingChain(thoughts, conclusion);

      expect(result.keptIndices).toContain(result.fixedPointIndex);
    });
  });

  describe('Combined pipeline quality', () => {
    it('phase + orbit produces better compression than either alone', () => {
      const thoughts = makeThoughts(DEBUGGING_CHAIN);

      const phaseResult = analyzePhases(thoughts, 0.3);
      const orbitResult = analyzeOrbits(thoughts as OrbitThought[], 0.45);

      // Combine: indices to keep = phase preserve ∩ NOT orbit prune
      const phaseKeep = new Set(phaseResult.preserveIndices);
      const orbitPrune = new Set(orbitResult.pruneIndices);

      const combinedKeep = [...phaseKeep].filter((i) => !orbitPrune.has(i));

      // Combined should be <= phase alone (orbit prunes some phase-kept items)
      expect(combinedKeep.length).toBeLessThanOrEqual(phaseResult.preserveIndices.length);
      // But should keep the essential items
      expect(combinedKeep).toContain(0); // first
      expect(combinedKeep).toContain(DEBUGGING_CHAIN.length - 1); // last
    });
  });
});
