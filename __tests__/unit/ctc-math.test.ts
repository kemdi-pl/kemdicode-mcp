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
 * CTC Math — Unit Tests
 *
 * Tests for pure mathematical functions inspired by
 * Closed Timelike Curves from General Relativity.
 */

import { describe, it, expect } from 'vitest';
import {
  CTC,
  findCausalPast,
  transitiveReduction,
  findCausalCore,
  tokenizeForEntropy,
  textToDistribution,
  shannonEntropy,
  jensenShannonDivergence,
  mutualInformationApprox,
  informationDensity,
  tfidfCosineSimilarity,
  findFixedPoint,
  compactThinkingChain,
  gravitationalTtl,
  itemKey,
} from '../../src/cognition/ctc-math.js';

// ─────────────────────────────────────────────────────────────────────────────
// 1. Causal DAG Functions
// ─────────────────────────────────────────────────────────────────────────────

describe('Causal DAG', () => {
  describe('itemKey', () => {
    it('should format type:id', () => {
      expect(itemKey({ type: 'decision', id: 'abc123' })).toBe('decision:abc123');
    });
  });

  describe('findCausalPast', () => {
    it('should return only root for empty graph with root', () => {
      const result = findCausalPast([], [], ['root']);
      expect(result.size).toBe(1); // root is always included
      expect(result.has('root')).toBe(true);
    });

    it('should return roots even if isolated', () => {
      const result = findCausalPast(['A', 'B'], [], ['A']);
      expect(result.has('A')).toBe(true);
      expect(result.has('B')).toBe(false);
    });

    it('should find all ancestors of root via reverse BFS', () => {
      // Graph: A -> B -> C -> D (root is D)
      const nodes = ['A', 'B', 'C', 'D'];
      const edges: [string, string][] = [['A', 'B'], ['B', 'C'], ['C', 'D']];
      const result = findCausalPast(nodes, edges, ['D']);
      expect(result.has('A')).toBe(true);
      expect(result.has('B')).toBe(true);
      expect(result.has('C')).toBe(true);
      expect(result.has('D')).toBe(true);
    });

    it('should handle branching DAG', () => {
      // A -> C, B -> C, C -> D (root D)
      const nodes = ['A', 'B', 'C', 'D', 'E'];
      const edges: [string, string][] = [['A', 'C'], ['B', 'C'], ['C', 'D']];
      const result = findCausalPast(nodes, edges, ['D']);
      expect(result.has('A')).toBe(true);
      expect(result.has('B')).toBe(true);
      expect(result.has('C')).toBe(true);
      expect(result.has('D')).toBe(true);
      expect(result.has('E')).toBe(false); // isolated
    });
  });

  describe('transitiveReduction', () => {
    it('should keep all edges when no shortcuts exist', () => {
      // A -> B -> C (no shortcut A->C)
      const nodes = ['A', 'B', 'C'];
      const edges: [string, string][] = [['A', 'B'], ['B', 'C']];
      const result = transitiveReduction(nodes, edges);
      expect(result).toHaveLength(2);
    });

    it('should remove redundant edge when shortcut exists', () => {
      // A -> B -> C AND A -> C (A->C is redundant)
      const nodes = ['A', 'B', 'C'];
      const edges: [string, string][] = [['A', 'B'], ['B', 'C'], ['A', 'C']];
      const result = transitiveReduction(nodes, edges);
      expect(result).toHaveLength(2);
      // A->C should be removed
      const hasAC = result.some(([f, t]) => f === 'A' && t === 'C');
      expect(hasAC).toBe(false);
    });

    it('should handle diamond DAG', () => {
      // A -> B, A -> C, B -> D, C -> D, A -> D
      const nodes = ['A', 'B', 'C', 'D'];
      const edges: [string, string][] = [
        ['A', 'B'], ['A', 'C'], ['B', 'D'], ['C', 'D'], ['A', 'D'],
      ];
      const result = transitiveReduction(nodes, edges);
      // A->D is redundant (A->B->D or A->C->D)
      const hasAD = result.some(([f, t]) => f === 'A' && t === 'D');
      expect(hasAD).toBe(false);
      expect(result.length).toBe(4); // A->B, A->C, B->D, C->D
    });
  });

  describe('findCausalCore', () => {
    it('should return roots as core for isolated roots', () => {
      const items = [{ type: 'intent', id: '1' }];
      const result = findCausalCore(items, [], items);
      expect(result.coreItems.has('intent:1')).toBe(true);
    });

    it('should include all nodes on essential paths', () => {
      const items = [
        { type: 'decision', id: '1' },
        { type: 'decision', id: '2' },
        { type: 'intent', id: '3' },
      ];
      const edges = [
        { from: { type: 'decision', id: '1' }, to: { type: 'decision', id: '2' } },
        { from: { type: 'decision', id: '2' }, to: { type: 'intent', id: '3' } },
      ];
      const result = findCausalCore(items, edges, [{ type: 'intent', id: '3' }]);
      expect(result.coreItems.size).toBe(3);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Information Theory Functions
// ─────────────────────────────────────────────────────────────────────────────

describe('Information Theory', () => {
  describe('tokenizeForEntropy', () => {
    it('should lowercase and filter stop words', () => {
      const tokens = tokenizeForEntropy('The quick brown fox and the lazy dog');
      expect(tokens).not.toContain('the');
      expect(tokens).not.toContain('and');
      expect(tokens).toContain('quick');
      expect(tokens).toContain('brown');
    });

    it('should filter short tokens (len <= 2)', () => {
      const tokens = tokenizeForEntropy('A to be or no it');
      expect(tokens).toHaveLength(0);
    });

    it('should return empty for empty input', () => {
      expect(tokenizeForEntropy('')).toHaveLength(0);
    });
  });

  describe('textToDistribution', () => {
    it('should compute probability distribution', () => {
      const dist = textToDistribution('hello world hello');
      expect(dist.get('hello')).toBeCloseTo(2 / 3, 5);
      expect(dist.get('world')).toBeCloseTo(1 / 3, 5);
    });

    it('should return empty map for empty text', () => {
      expect(textToDistribution('').size).toBe(0);
    });
  });

  describe('shannonEntropy', () => {
    it('should return 0 for single-term distribution', () => {
      const dist = new Map([['a', 1.0]]);
      expect(shannonEntropy(dist)).toBeCloseTo(0, 3);
    });

    it('should return log2(n) for uniform distribution', () => {
      const dist = new Map([['a', 0.25], ['b', 0.25], ['c', 0.25], ['d', 0.25]]);
      expect(shannonEntropy(dist)).toBeCloseTo(2, 1); // log2(4) = 2
    });

    it('should return 0 for empty distribution', () => {
      expect(shannonEntropy(new Map())).toBe(0);
    });
  });

  describe('jensenShannonDivergence', () => {
    it('should return 0 for identical distributions', () => {
      const p = new Map([['a', 0.5], ['b', 0.5]]);
      const q = new Map([['a', 0.5], ['b', 0.5]]);
      expect(jensenShannonDivergence(p, q)).toBeCloseTo(0, 3);
    });

    it('should return ~1 for completely disjoint distributions', () => {
      const p = new Map([['a', 1.0]]);
      const q = new Map([['b', 1.0]]);
      const jsd = jensenShannonDivergence(p, q);
      expect(jsd).toBeGreaterThan(0.5);
      expect(jsd).toBeLessThanOrEqual(1);
    });

    it('should be symmetric', () => {
      const p = new Map([['a', 0.7], ['b', 0.3]]);
      const q = new Map([['a', 0.3], ['b', 0.7]]);
      const jsd1 = jensenShannonDivergence(p, q);
      const jsd2 = jensenShannonDivergence(q, p);
      expect(jsd1).toBeCloseTo(jsd2, 10);
    });
  });

  describe('mutualInformationApprox', () => {
    it('should return high MI for identical texts', () => {
      const mi = mutualInformationApprox(
        'machine learning neural networks deep learning',
        'machine learning neural networks deep learning',
      );
      expect(mi).toBeGreaterThan(0.8);
    });

    it('should return low MI for unrelated texts', () => {
      const mi = mutualInformationApprox(
        'quantum physics electron photon wavelength',
        'cooking recipe pasta tomato garlic basil',
      );
      expect(mi).toBeLessThan(0.3);
    });

    it('should return 0 for empty inputs', () => {
      expect(mutualInformationApprox('', 'hello')).toBe(0);
      expect(mutualInformationApprox('hello', '')).toBe(0);
    });
  });

  describe('informationDensity', () => {
    it('should return higher density for shorter relevant items', () => {
      const shortDensity = informationDensity(
        'neural networks deep learning',
        'deep learning model training',
        10,
      );
      const longDensity = informationDensity(
        'neural networks deep learning with additional irrelevant padding text that adds tokens without useful information',
        'deep learning model training',
        50,
      );
      expect(shortDensity).toBeGreaterThan(longDensity);
    });

    it('should return 0 for zero tokens', () => {
      expect(informationDensity('test', 'test', 0)).toBe(0);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Fixed-Point Detection (Nowikov Self-Consistency)
// ─────────────────────────────────────────────────────────────────────────────

describe('Fixed-Point Detection', () => {
  describe('tfidfCosineSimilarity', () => {
    it('should return ~1 for identical texts', () => {
      const sim = tfidfCosineSimilarity(
        'refactoring database connection pooling',
        'refactoring database connection pooling',
      );
      expect(sim).toBeGreaterThan(0.9);
    });

    it('should return 0 for completely different texts', () => {
      const sim = tfidfCosineSimilarity(
        'quantum mechanics electron spin',
        'cooking recipe garlic pasta tomato',
      );
      expect(sim).toBe(0);
    });

    it('should return 0 for empty inputs', () => {
      expect(tfidfCosineSimilarity('', 'test')).toBe(0);
      expect(tfidfCosineSimilarity('test', '')).toBe(0);
    });

    it('should give partial similarity for overlapping texts', () => {
      const sim = tfidfCosineSimilarity(
        'database connection pooling performance',
        'database optimization caching performance',
      );
      expect(sim).toBeGreaterThan(0);
      expect(sim).toBeLessThan(1);
    });
  });

  describe('findFixedPoint', () => {
    it('should find the thought most similar to conclusion', () => {
      const thoughts = [
        { content: 'We should consider redis caching', confidence: 60 },
        { content: 'The API endpoint needs pagination', confidence: 70 },
        { content: 'Redis caching with TTL will solve the performance issue', confidence: 85 },
      ];
      const conclusion = 'Implemented redis caching with TTL-based eviction for performance';
      const result = findFixedPoint(thoughts, conclusion);
      expect(result.fixedPointIndex).toBe(2);
      expect(result.similarity).toBeGreaterThan(0);
    });

    it('should return isConsistent=false if best similarity is below threshold', () => {
      const thoughts = [
        { content: 'random unrelated topic about cooking', confidence: 50 },
      ];
      const conclusion = 'quantum physics breakthrough in superconductivity';
      const result = findFixedPoint(thoughts, conclusion, 0.4);
      expect(result.isConsistent).toBe(false);
    });

    it('should handle empty thoughts array', () => {
      const result = findFixedPoint([], 'some conclusion');
      expect(result.fixedPointIndex).toBe(-1);
      expect(result.similarity).toBe(0);
    });
  });

  describe('compactThinkingChain', () => {
    it('should keep thoughts above prune threshold', () => {
      const thoughts = [
        { index: 0, content: 'redis caching strategy', confidence: 60 },
        { index: 1, content: 'unrelated tangent about UI colors', confidence: 40 },
        { index: 2, content: 'redis TTL-based cache eviction', confidence: 80 },
        { index: 3, content: 'another unrelated tangent about fonts', confidence: 30 },
      ];
      const conclusion = 'Implement redis caching with TTL eviction';
      const result = compactThinkingChain(thoughts, conclusion, 0.15);
      // Thoughts 0 and 2 should be kept (redis-related)
      expect(result.keptIndices).toContain(0);
      expect(result.keptIndices).toContain(2);
      expect(result.prunedIndices.length).toBeGreaterThan(0);
    });

    it('should always include fixed point even if below threshold', () => {
      const thoughts = [
        { index: 0, content: 'somewhat related thought about testing', confidence: 70 },
      ];
      const conclusion = 'testing is important for code quality';
      const result = compactThinkingChain(thoughts, conclusion, 0.99); // very high threshold
      expect(result.keptIndices).toContain(0); // fixed point forced in
    });

    it('should handle empty thoughts', () => {
      const result = compactThinkingChain([], 'conclusion');
      expect(result.keptIndices).toHaveLength(0);
      expect(result.fixedPointIndex).toBe(-1);
    });

    it('should compute consistency score as kept/total ratio', () => {
      const thoughts = [
        { index: 0, content: 'database optimization query', confidence: 80 },
        { index: 1, content: 'database index performance tuning', confidence: 85 },
      ];
      const conclusion = 'database optimization with proper indexing';
      const result = compactThinkingChain(thoughts, conclusion, 0.0);
      // All kept at threshold 0
      expect(result.consistencyScore).toBe(1);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Gravitational TTL
// ─────────────────────────────────────────────────────────────────────────────

describe('Gravitational TTL', () => {
  it('should return base TTL unchanged for infinite distance', () => {
    expect(gravitationalTtl(86400, Infinity)).toBe(86400);
  });

  it('should return base TTL * (1 + gamma) for distance 0', () => {
    // gamma = 1.5, so factor = 1 + 1.5/(1+0) = 2.5
    expect(gravitationalTtl(86400, 0)).toBe(Math.round(86400 * 2.5));
  });

  it('should return base TTL * (1 + gamma/2) for distance 1', () => {
    // gamma = 1.5, so factor = 1 + 1.5/(1+1) = 1.75
    expect(gravitationalTtl(86400, 1)).toBe(Math.round(86400 * 1.75));
  });

  it('should always return >= base TTL', () => {
    for (const dist of [0, 1, 2, 5, 10, 100]) {
      expect(gravitationalTtl(86400, dist)).toBeGreaterThanOrEqual(86400);
    }
  });

  it('should return 0 for permanent items (base TTL = 0)', () => {
    expect(gravitationalTtl(0, 0)).toBe(0);
    expect(gravitationalTtl(0, 5)).toBe(0);
  });

  it('should return base TTL for negative distance', () => {
    expect(gravitationalTtl(86400, -1)).toBe(86400);
  });

  it('should accept custom gamma', () => {
    // gamma = 3.0, distance = 0: factor = 1 + 3/(1+0) = 4.0
    expect(gravitationalTtl(1000, 0, 3.0)).toBe(4000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

describe('CTC Constants', () => {
  it('should have expected values', () => {
    expect(CTC.CONSISTENCY_THRESHOLD).toBe(0.4);
    expect(CTC.PRUNE_THRESHOLD).toBe(0.2);
    expect(CTC.GAMMA).toBe(1.5);
    expect(CTC.MAX_GRAPH_DEPTH).toBe(10);
    expect(CTC.ENTROPY_EPSILON).toBe(1e-10);
  });
});
