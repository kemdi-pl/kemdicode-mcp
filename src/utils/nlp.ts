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
 * Shared NLP utilities — unified stop words, tokenizer, text distribution.
 *
 * Eliminates duplication between ctc-math.ts and intent-store.ts.
 * All functions are pure (no side effects, no I/O).
 *
 * @module utils/nlp
 */

/**
 * English stop words — high-frequency words that carry little semantic meaning.
 * Merged superset from intent-store.ts and ctc-math.ts.
 */
export const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'need', 'must', 'to', 'of',
  'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into', 'about',
  'and', 'or', 'but', 'not', 'no', 'if', 'then', 'than', 'so', 'that',
  'this', 'it', 'its', 'i', 'we', 'you', 'he', 'she', 'they', 'me',
  'my', 'our', 'your', 'his', 'her', 'their', 'what', 'which', 'who',
  'how', 'when', 'where', 'why', 'all', 'each', 'some', 'any', 'just',
  'also', 'very', 'up', 'out', 'now', 'get', 'make', 'go', 'see',
  'like', 'use', 'used', 'using', 'one', 'two', 'new', 'more', 'only',
  'still', 'back', 'there', 'here', 'been', 'much', 'well', 'way',
  'them', 'him', 'after', 'before', 'over', 'such', 'through', 'too',
  'come', 'time', 'long', 'look', 'many', 'said', 'know', 'take',
  'between', 'because', 'does', 'while', 'those',
]);

/**
 * Tokenize text: lowercase, strip non-alphanumeric, filter stop words and short tokens.
 *
 * @param text - Input text
 * @param minLength - Minimum token length (default 3)
 * @returns Array of content tokens
 */
export function tokenize(text: string, minLength: number = 3): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .split(/\s+/)
    .filter((w) => w.length >= minLength && !STOP_WORDS.has(w));
}

/**
 * Compute term probability distribution from text.
 *
 *   P(term) = count(term) / total_tokens
 *
 * @returns Map<term, probability> where Σ values ≈ 1
 */
export function textToDistribution(text: string): Map<string, number> {
  const tokens = tokenize(text);
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
 * Extract bigrams from token array.
 *
 * @param tokens - Array of tokens
 * @returns Array of "token1_token2" bigrams
 */
export function extractBigrams(tokens: string[]): string[] {
  if (tokens.length < 2) return [];
  const bigrams: string[] = [];
  for (let i = 0; i < tokens.length - 1; i++) {
    bigrams.push(`${tokens[i]}_${tokens[i + 1]}`);
  }
  return bigrams;
}

/**
 * Compute TF-IDF weighted cosine similarity between two texts.
 *
 * Uses binary 2-document IDF weighting:
 *   IDF(term) = 1.0 if term appears in both documents
 *   IDF(term) = 2.0 if term appears in only one document
 *
 * @returns Similarity in [0, 1]
 */
export function tfidfCosineSimilarity(textA: string, textB: string): number {
  const tokensA = tokenize(textA);
  const tokensB = tokenize(textB);

  if (tokensA.length === 0 || tokensB.length === 0) return 0;

  const tfA = new Map<string, number>();
  const tfB = new Map<string, number>();
  for (const t of tokensA) tfA.set(t, (tfA.get(t) || 0) + 1);
  for (const t of tokensB) tfB.set(t, (tfB.get(t) || 0) + 1);

  const allTerms = new Set([...tfA.keys(), ...tfB.keys()]);

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (const term of allTerms) {
    const freqA = tfA.get(term) || 0;
    const freqB = tfB.get(term) || 0;
    const inA = freqA > 0;
    const inB = freqB > 0;
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
