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
 * CTC Math — Pure mathematical functions for context compaction & recovery.
 *
 * Inspired by Closed Timelike Curves from General Relativity:
 *
 * 1. CAUSAL STRUCTURE PRESERVATION — find minimal set of cognition items
 *    that preserves all causal paths from root causes to active intent.
 *
 * 2. HOLOGRAPHIC BOUNDARY ENCODING — use information-theoretic measures
 *    (Shannon entropy, Jensen-Shannon divergence) to compute information
 *    density of items relative to current goal.
 *
 * 3. NOWIKOV SELF-CONSISTENCY — find fixed-point thoughts in thinking chains
 *    that are self-consistent with the conclusion.
 *
 * 4. GRAVITATIONAL TIME DILATION — compute dynamic TTLs based on graph
 *    proximity to active intent.
 *
 * All functions are pure (no side effects, no Redis, no I/O).
 */

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

export const CTC = {
  /** Min TF-IDF cosine similarity for a thought to qualify as fixed point */
  CONSISTENCY_THRESHOLD: 0.4,
  /** Min TF-IDF cosine similarity for a thought to survive compaction */
  PRUNE_THRESHOLD: 0.2,
  /** Gravitational coupling constant for TTL dilation */
  GAMMA: 1.5,
  /** Max BFS depth for graph traversals */
  MAX_GRAPH_DEPTH: 10,
  /** Epsilon to prevent log(0) in entropy calculations */
  ENTROPY_EPSILON: 1e-10,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface CognitionItemRef {
  type: string;
  id: string;
}

export interface CausalEdge {
  from: CognitionItemRef;
  to: CognitionItemRef;
}

export interface CausalCoreOutput {
  /** Set of "type:id" strings for items that must survive compaction */
  coreItems: Set<string>;
  /** Edges in the transitive reduction (essential causal links) */
  essentialEdges: Array<[string, string]>;
  /** Edges removed by transitive reduction (redundant) */
  redundantEdges: Array<[string, string]>;
}

export interface FixedPointResult {
  /** Index of the thought most consistent with conclusion */
  fixedPointIndex: number;
  /** TF-IDF cosine similarity between fixed-point thought and conclusion */
  similarity: number;
  /** Whether similarity meets the consistency threshold */
  isConsistent: boolean;
}

export interface ChainCompactionOutput {
  /** Indices of thoughts kept after compaction */
  keptIndices: number[];
  /** Indices of thoughts pruned */
  prunedIndices: number[];
  /** Index of the fixed-point thought */
  fixedPointIndex: number;
  /** Fraction of kept thoughts above prune threshold (0-1) */
  consistencyScore: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Stop Words — delegated to shared utils/nlp.ts (v3.0.0)
// ─────────────────────────────────────────────────────────────────────────────

import { STOP_WORDS } from '../utils/nlp.js';

// ─────────────────────────────────────────────────────────────────────────────
// 1. CAUSAL DAG — Structure Preservation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert a CognitionItemRef to a unique string key.
 */
export function itemKey(item: CognitionItemRef): string {
  return `${item.type}:${item.id}`;
}

/**
 * Find the causal past of a set of root nodes via reverse BFS.
 *
 * Given a directed graph G = (V, E) where edges go from cause to effect,
 * the causal past of a set of roots R is:
 *
 *   Past(R) = { v ∈ V | ∃ r ∈ R : path(v, r) exists in G }
 *
 * We traverse edges in reverse (from effect to cause) starting from R.
 *
 * @param allNodes - All node keys ("type:id")
 * @param edges    - Directed edges as [from, to] tuples
 * @param roots    - Root node keys (typically active intents)
 * @returns Set of node keys reachable backward from roots
 */
export function findCausalPast(
  allNodes: string[],
  edges: Array<[string, string]>,
  roots: string[],
): Set<string> {
  // Build reverse adjacency: for edge (A→B), add A to reverseAdj[B]
  const reverseAdj = new Map<string, string[]>();
  for (const node of allNodes) {
    reverseAdj.set(node, []);
  }
  for (const [from, to] of edges) {
    const list = reverseAdj.get(to);
    if (list) list.push(from);
  }

  // BFS from roots following reverse edges
  const visited = new Set<string>();
  const queue: string[] = [];

  for (const root of roots) {
    if (!visited.has(root)) {
      visited.add(root);
      queue.push(root);
    }
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    const neighbors = reverseAdj.get(current) || [];
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }
  }

  return visited;
}

/**
 * Compute the transitive reduction of a DAG.
 *
 * The transitive reduction removes edge (u, v) if there exists an
 * alternative path u → w₁ → ... → wₖ → v with at least one
 * intermediate node.
 *
 * Algorithm: For each edge (u, v), do a BFS/DFS from u excluding the
 * direct edge to v. If v is still reachable, the edge is redundant.
 *
 * Time: O(|E| · (|V| + |E|)) — acceptable for |V| < 200
 *
 * @param nodes - All node keys
 * @param edges - Directed edges as [from, to] tuples
 * @returns Edges remaining after reduction (essential edges)
 */
export function transitiveReduction(
  nodes: string[],
  edges: Array<[string, string]>,
): Array<[string, string]> {
  // Build forward adjacency
  const adj = new Map<string, Set<string>>();
  for (const node of nodes) {
    adj.set(node, new Set());
  }
  for (const [from, to] of edges) {
    adj.get(from)?.add(to);
  }

  const essential: Array<[string, string]> = [];

  for (const [u, v] of edges) {
    // Check if v is reachable from u without the direct edge u→v
    // Temporarily remove the edge
    adj.get(u)?.delete(v);

    const reachable = bfsReachable(u, v, adj);

    // Restore the edge
    adj.get(u)?.add(v);

    if (!reachable) {
      // Edge is essential — no alternative path exists
      essential.push([u, v]);
    }
  }

  return essential;
}

/**
 * BFS to check if target is reachable from source.
 */
function bfsReachable(
  source: string,
  target: string,
  adj: Map<string, Set<string>>,
): boolean {
  const visited = new Set<string>();
  const queue: string[] = [source];
  visited.add(source);

  while (queue.length > 0) {
    const current = queue.shift()!;
    const neighbors = adj.get(current);
    if (!neighbors) continue;
    for (const neighbor of neighbors) {
      if (neighbor === target) return true;
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }
  }

  return false;
}

/**
 * Find the causal core — the minimal set of cognition items that
 * preserves all causal paths from any ancestor to the active intents.
 *
 * Algorithm:
 * 1. Find causal past of active intents (reverse BFS)
 * 2. Restrict graph to causal past subgraph
 * 3. Compute transitive reduction of subgraph
 * 4. Return all nodes that appear in the reduced subgraph
 *
 * The causal core items MUST survive compaction. Items outside the
 * core are candidates for eviction.
 *
 * @param allItems       - All cognition items in the system
 * @param edges          - All cross-links as causal edges
 * @param activeIntents  - Currently active intent(s)
 */
export function findCausalCore(
  allItems: CognitionItemRef[],
  edges: CausalEdge[],
  activeIntents: CognitionItemRef[],
): CausalCoreOutput {
  const allNodeKeys = allItems.map(itemKey);
  const edgeTuples: Array<[string, string]> = edges.map((e) => [
    itemKey(e.from),
    itemKey(e.to),
  ]);
  const rootKeys = activeIntents.map(itemKey);

  // Step 1: Find causal past
  const causalPast = findCausalPast(allNodeKeys, edgeTuples, rootKeys);

  // Step 2: Restrict to causal past subgraph
  const subNodes = allNodeKeys.filter((n) => causalPast.has(n));
  const subEdges = edgeTuples.filter(
    ([from, to]) => causalPast.has(from) && causalPast.has(to),
  );

  // Step 3: Transitive reduction
  const essentialEdges = transitiveReduction(subNodes, subEdges);
  const essentialEdgeSet = new Set(essentialEdges.map(([f, t]) => `${f}->${t}`));
  const redundantEdges = subEdges.filter(
    ([f, t]) => !essentialEdgeSet.has(`${f}->${t}`),
  );

  // Step 4: Core items = all nodes that appear in essential edges + roots
  const coreItems = new Set<string>(rootKeys.filter((r) => causalPast.has(r)));
  for (const [from, to] of essentialEdges) {
    coreItems.add(from);
    coreItems.add(to);
  }

  return { coreItems, essentialEdges, redundantEdges };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. INFORMATION THEORY — Holographic Boundary Encoding
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tokenize text for entropy computation.
 * Lowercase, strip non-alphanumeric, filter stop words and short tokens.
 */
export function tokenizeForEntropy(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

/**
 * Compute term probability distribution from text.
 *
 * P(term) = count(term) / total_tokens
 *
 * @returns Map<term, probability> where Σ values ≈ 1
 */
export function textToDistribution(text: string): Map<string, number> {
  const tokens = tokenizeForEntropy(text);
  const freq = new Map<string, number>();
  for (const token of tokens) {
    freq.set(token, (freq.get(token) || 0) + 1);
  }

  const total = tokens.length;
  if (total === 0) return new Map();

  const dist = new Map<string, number>();
  for (const [term, count] of freq) {
    dist.set(term, count / total);
  }
  return dist;
}

/**
 * Shannon entropy of a probability distribution.
 *
 *   H(p) = -Σ p(t) · log₂(p(t) + ε)
 *
 * Properties:
 * - H = 0 for a single-term distribution (certainty)
 * - H = log₂(n) for uniform distribution over n terms (maximum uncertainty)
 * - H ≥ 0 always
 *
 * @param dist - Probability distribution (Map<term, probability>)
 * @returns Entropy in bits
 */
export function shannonEntropy(dist: Map<string, number>): number {
  if (dist.size === 0) return 0;

  let entropy = 0;
  for (const p of dist.values()) {
    if (p > CTC.ENTROPY_EPSILON) {
      entropy -= p * Math.log2(p + CTC.ENTROPY_EPSILON);
    }
  }
  return Math.max(0, entropy);
}

/**
 * Jensen-Shannon divergence between two distributions.
 *
 *   M = (P + Q) / 2
 *   JSD(P ‖ Q) = H(M) - (H(P) + H(Q)) / 2
 *
 * Properties:
 * - Symmetric: JSD(P‖Q) = JSD(Q‖P)
 * - Bounded: 0 ≤ JSD ≤ log₂(2) ≈ 1.0
 * - JSD = 0 iff P = Q (identical distributions)
 * - Well-defined even for non-overlapping support (unlike KL divergence)
 *
 * @returns JSD value in [0, 1]
 */
export function jensenShannonDivergence(
  p: Map<string, number>,
  q: Map<string, number>,
): number {
  if (p.size === 0 && q.size === 0) return 0;
  if (p.size === 0 || q.size === 0) return 1; // max divergence

  // Compute M = (P + Q) / 2
  const m = new Map<string, number>();
  const allTerms = new Set([...p.keys(), ...q.keys()]);

  for (const term of allTerms) {
    const pVal = p.get(term) || 0;
    const qVal = q.get(term) || 0;
    m.set(term, (pVal + qVal) / 2);
  }

  const hM = shannonEntropy(m);
  const hP = shannonEntropy(p);
  const hQ = shannonEntropy(q);

  // JSD = H(M) - (H(P) + H(Q)) / 2
  const jsd = hM - (hP + hQ) / 2;
  return Math.max(0, Math.min(1, jsd)); // clamp to [0, 1]
}

/**
 * Approximate mutual information between two texts.
 *
 *   MI ≈ 1 - JSD(P_item ‖ P_goal) / log₂(2)
 *
 * Normalized to [0, 1] where:
 * - MI = 1: identical term distributions (maximum shared information)
 * - MI = 0: completely disjoint vocabularies (no shared information)
 *
 * This is the complement of normalized JSD, which serves as a
 * practical proxy for pointwise mutual information between text pairs.
 */
export function mutualInformationApprox(textA: string, textB: string): number {
  const distA = textToDistribution(textA);
  const distB = textToDistribution(textB);

  if (distA.size === 0 || distB.size === 0) return 0;

  const jsd = jensenShannonDivergence(distA, distB);
  // Normalize by log₂(2) = 1.0, then complement
  return Math.max(0, 1 - jsd);
}

/**
 * Information density of an item relative to a goal.
 *
 *   density = MI(item, goal) / log₂(1 + tokenCount)
 *
 * Rationale (Holographic Principle):
 * The boundary (summary) should encode maximum information about the
 * bulk (full session) per unit area (token cost). Items with high MI
 * but low token cost are the most efficient "boundary elements."
 *
 * The log₂(1 + tokens) denominator provides soft penalization:
 * - 1 token:   log₂(2) = 1.0
 * - 10 tokens:  log₂(11) ≈ 3.46
 * - 100 tokens: log₂(101) ≈ 6.66
 * - 1000 tokens: log₂(1001) ≈ 9.97
 *
 * @param itemText   - Text content of the item
 * @param goalText   - Text of the current goal/intent
 * @param tokenCount - Estimated token count of the item
 * @returns Density value (higher = more useful per token)
 */
export function informationDensity(
  itemText: string,
  goalText: string,
  tokenCount: number,
): number {
  if (tokenCount <= 0) return 0;

  const mi = mutualInformationApprox(itemText, goalText);
  const denominator = Math.log2(1 + tokenCount);
  if (denominator <= 0) return 0;

  return mi / denominator;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. FIXED-POINT DETECTION — Nowikov Self-Consistency
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute TF-IDF weighted cosine similarity between two texts.
 *
 * Uses binary 2-document IDF weighting (consistent with intent-store.ts):
 *   IDF(term) = 1.0 if term appears in both documents
 *   IDF(term) = 2.0 if term appears in only one document
 *
 * Weight vector: w(term, doc) = TF(term, doc) × IDF(term)
 *
 * Cosine similarity:
 *   cos(A, B) = Σ wA(t)·wB(t) / (‖wA‖ · ‖wB‖)
 *
 * @returns Similarity in [0, 1]
 */
export function tfidfCosineSimilarity(textA: string, textB: string): number {
  const tokensA = tokenizeForEntropy(textA);
  const tokensB = tokenizeForEntropy(textB);

  if (tokensA.length === 0 || tokensB.length === 0) return 0;

  // Term frequencies
  const tfA = new Map<string, number>();
  const tfB = new Map<string, number>();
  for (const t of tokensA) tfA.set(t, (tfA.get(t) || 0) + 1);
  for (const t of tokensB) tfB.set(t, (tfB.get(t) || 0) + 1);

  // All terms in union
  const allTerms = new Set([...tfA.keys(), ...tfB.keys()]);

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (const term of allTerms) {
    const freqA = tfA.get(term) || 0;
    const freqB = tfB.get(term) || 0;
    const inA = freqA > 0;
    const inB = freqB > 0;

    // Binary IDF: shared terms get weight 1.0, unique terms get 2.0
    const idf = inA && inB ? 1.0 : 2.0;

    const wA = freqA * idf;
    const wB = freqB * idf;

    dotProduct += wA * wB;
    normA += wA * wA;
    normB += wB * wB;
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;

  return dotProduct / denominator;
}

/**
 * Find the fixed-point thought in a thinking chain.
 *
 * Nowikov Self-Consistency Principle applied to thinking chains:
 * The fixed point t* is the thought whose content is most consistent
 * with the final conclusion — i.e., the thought that "survives the
 * closed timelike curve" of reasoning without contradiction.
 *
 * Formally:
 *   f(t_i) = sim_tfidf(t_i, conclusion)
 *   t* = argmax_i { f(t_i) }
 *   isConsistent = f(t*) ≥ θ_consistency
 *
 * @param thoughts    - Array of thoughts with content and confidence
 * @param conclusion  - The chain's conclusion text
 * @param threshold   - Consistency threshold (default 0.4)
 */
export function findFixedPoint(
  thoughts: Array<{ content: string; confidence: number }>,
  conclusion: string,
  threshold: number = CTC.CONSISTENCY_THRESHOLD,
): FixedPointResult {
  if (thoughts.length === 0) {
    return { fixedPointIndex: -1, similarity: 0, isConsistent: false };
  }

  let bestIndex = 0;
  let bestSim = -1;

  for (let i = 0; i < thoughts.length; i++) {
    const sim = tfidfCosineSimilarity(thoughts[i].content, conclusion);
    if (sim > bestSim) {
      bestSim = sim;
      bestIndex = i;
    }
  }

  return {
    fixedPointIndex: bestIndex,
    similarity: Math.round(bestSim * 1000) / 1000,
    isConsistent: bestSim >= threshold,
  };
}

/**
 * Compact a thinking chain using Nowikov self-consistency.
 *
 * Selects only those thoughts whose content is sufficiently similar
 * to the conclusion (above the prune threshold). This produces a
 * minimal self-consistent subsequence — the "closed timelike curve"
 * that loops from initial reasoning through the conclusion and back
 * without paradox.
 *
 * @param thoughts       - Indexed thoughts with content and confidence
 * @param conclusion     - The chain's conclusion
 * @param pruneThreshold - Min similarity to keep (default 0.2)
 */
export function compactThinkingChain(
  thoughts: Array<{ index: number; content: string; confidence: number }>,
  conclusion: string,
  pruneThreshold: number = CTC.PRUNE_THRESHOLD,
): ChainCompactionOutput {
  if (thoughts.length === 0) {
    return {
      keptIndices: [],
      prunedIndices: [],
      fixedPointIndex: -1,
      consistencyScore: 0,
    };
  }

  // Compute similarity of each thought to the conclusion
  const similarities = thoughts.map((t) => ({
    index: t.index,
    sim: tfidfCosineSimilarity(t.content, conclusion),
  }));

  // Find fixed point (highest similarity)
  let fixedPointIndex = similarities[0].index;
  let maxSim = similarities[0].sim;
  for (const s of similarities) {
    if (s.sim > maxSim) {
      maxSim = s.sim;
      fixedPointIndex = s.index;
    }
  }

  // Partition into kept (sim ≥ threshold) and pruned
  const keptIndices: number[] = [];
  const prunedIndices: number[] = [];

  for (const s of similarities) {
    if (s.sim >= pruneThreshold) {
      keptIndices.push(s.index);
    } else {
      prunedIndices.push(s.index);
    }
  }

  // Ensure fixed point is always kept
  if (!keptIndices.includes(fixedPointIndex)) {
    keptIndices.push(fixedPointIndex);
    const prunedIdx = prunedIndices.indexOf(fixedPointIndex);
    if (prunedIdx !== -1) prunedIndices.splice(prunedIdx, 1);
  }

  // Sort indices for consistency
  keptIndices.sort((a, b) => a - b);
  prunedIndices.sort((a, b) => a - b);

  // Consistency score: fraction of thoughts that are above threshold
  const consistencyScore =
    thoughts.length > 0
      ? Math.round((keptIndices.length / thoughts.length) * 1000) / 1000
      : 0;

  return {
    keptIndices,
    prunedIndices,
    fixedPointIndex,
    consistencyScore,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. GRAVITATIONAL TTL — Time Dilation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute effective TTL using gravitational time dilation.
 *
 * In General Relativity, clocks near massive objects experience time
 * dilation — they "age slower." Applied to context management:
 * items closer to the active intent (the "mass center") receive
 * longer effective TTLs.
 *
 * Formula:
 *   TTL_eff = TTL_base × (1 + γ / (1 + distance))
 *
 * Where:
 *   distance = shortest path length in cross-linker graph (BFS)
 *   γ = 1.5 (gravitational coupling constant)
 *
 * Examples (γ = 1.5):
 *   distance = 0 (self):      TTL × 2.5
 *   distance = 1 (direct):    TTL × 1.75
 *   distance = 2 (2-hop):     TTL × 1.5
 *   distance = 5:             TTL × 1.25
 *   distance = ∞ (isolated):  TTL × 1.0 (unchanged)
 *
 * The result is always ≥ baseTtlSeconds (TTL never decreases).
 * If baseTtlSeconds is 0 (permanent), returns 0 (stays permanent).
 *
 * @param baseTtlSeconds - Base TTL from COGNITION_TTL
 * @param graphDistance   - Hops from item to active intent (Infinity if disconnected)
 * @param gamma           - Coupling constant (default 1.5)
 */
export function gravitationalTtl(
  baseTtlSeconds: number,
  graphDistance: number,
  gamma: number = CTC.GAMMA,
): number {
  // Permanent items stay permanent
  if (baseTtlSeconds === 0) return 0;

  // Isolated items (no path to intent) keep their base TTL
  if (!isFinite(graphDistance) || graphDistance < 0) return baseTtlSeconds;

  const proximity = 1 / (1 + graphDistance);
  const dilationFactor = 1 + gamma * proximity;

  return Math.round(baseTtlSeconds * dilationFactor);
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. PERTURBATION IMPACT — Lorenz Sensitivity Analysis
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Measure how much removing an item perturbs the context distribution.
 *
 * Lorenz's key insight: small perturbations in initial conditions can
 * lead to vastly different trajectories. Applied to compaction:
 * removing an item with HIGH perturbation impact is "dangerous" —
 * it changes the information landscape significantly.
 *
 * Formula:
 *   impact = JSD(dist(context_full), dist(context_without_item))
 *
 * Where context_full is the concatenation of all items, and
 * context_without_item excludes the target item.
 *
 * @param items     - All context items (text content)
 * @param itemIndex - Index of the item to evaluate for removal
 * @returns Impact in [0, 1] where 1 = maximum perturbation
 */
export function perturbationImpact(
  items: string[],
  itemIndex: number,
): number {
  if (items.length <= 1) return 1; // removing the only item = max impact
  if (itemIndex < 0 || itemIndex >= items.length) return 0;

  const fullText = items.join(' ');
  const withoutText = items.filter((_, i) => i !== itemIndex).join(' ');

  const distFull = textToDistribution(fullText);
  const distWithout = textToDistribution(withoutText);

  if (distFull.size === 0) return 0;

  return jensenShannonDivergence(distFull, distWithout);
}

/**
 * Rank items by perturbation impact (descending).
 *
 * Items with highest impact are MOST CRITICAL to preserve.
 * Items with lowest impact are safest to remove during compaction.
 *
 * @param items - Array of text content items
 * @returns Array of { index, impact } sorted by impact descending
 */
export function rankByPerturbationImpact(
  items: string[],
): Array<{ index: number; impact: number }> {
  if (items.length === 0) return [];

  const rankings = items.map((_, index) => ({
    index,
    impact: Math.round(perturbationImpact(items, index) * 1000) / 1000,
  }));

  return rankings.sort((a, b) => b.impact - a.impact);
}
