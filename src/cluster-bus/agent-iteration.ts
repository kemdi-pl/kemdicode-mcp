/**
 * KemdiCode MCP Server - Agent Iteration Loop
 * Copyright (C) 2025-2026 Kemdi Sp. z o.o. (Dawid Irzyk <dawid@kemdi.pl>)
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

/**
 * Agent Iteration Loop — Multi-Agent Peer-to-Peer Refinement
 *
 * Implements a producer/reviewer pattern where agents iterate
 * on each other's responses until quality convergence:
 *
 *   Pass 1: Producer generates initial response
 *   Pass 2: Reviewer evaluates quality + gives feedback
 *   Pass 3: Producer refines based on feedback
 *   Pass 4: Reviewer re-evaluates
 *   ... repeat until quality >= threshold or maxPasses exhausted
 *
 * @module cluster-bus/agent-iteration
 */

import { Logger } from '../utils/logger.js';
import { complete } from '../ai/client.js';
import { safeJsonParseNoProto } from '../utils/security.js';

/** Timeout for individual LLM calls within the iteration loop (60s) */
const PER_CALL_TIMEOUT_MS = 60_000;

/** Wrap a promise with a timeout to prevent indefinite hangs */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ]);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentIterationConfig {
  /** Model spec for LLM calls (provider:model syntax or plain model name) */
  model?: string;
  /** Number of agents (1 = pass-through, 2+ = producer/reviewer iteration) */
  agentCount: number;
  /** Maximum iteration passes (producer + reviewer calls combined) */
  maxPasses: number;
  /** Quality threshold for early convergence (0.0-1.0) */
  qualityThreshold: number;
}

export interface AgentIterationResult {
  /** Best content produced */
  content: string;
  /** Final quality score (0.0-1.0) */
  finalQuality: number;
  /** Total passes executed */
  totalPasses: number;
  /** Per-pass execution details */
  passHistory: PassEntry[];
  /** Whether quality threshold was reached */
  converged: boolean;
  /** Total tokens consumed across all passes */
  totalTokens: number;
  /** Total latency in milliseconds */
  totalLatencyMs: number;
}

interface PassEntry {
  pass: number;
  role: 'producer' | 'reviewer';
  quality: number;
  latencyMs: number;
  tokensUsed: number;
}

interface ReviewResult {
  quality: number;
  feedback: string;
  refinedContent?: string;
}

// ---------------------------------------------------------------------------
// System Prompts
// ---------------------------------------------------------------------------

const PRODUCER_SYSTEM_PROMPT = `You are an expert analyst providing thorough, accurate responses.
When you receive reviewer feedback, carefully refine your response to address each point.
Focus on completeness, accuracy, and actionability.`;

const REVIEWER_SYSTEM_PROMPT = `You are a critical reviewer evaluating another agent's response.
Assess the response on these criteria:
- Completeness: Does it fully address the question?
- Accuracy: Are the claims correct and well-supported?
- Actionability: Are suggestions practical and specific?
- Clarity: Is the response well-structured and easy to follow?

You MUST respond with ONLY a valid JSON object (no markdown, no explanation):
{
  "quality": <number 0.0 to 1.0>,
  "feedback": "<specific improvements needed or 'No improvements needed' if quality >= 0.9>",
  "refinedContent": "<optional: your improved version if you can do significantly better, omit if not>"
}`;

// ---------------------------------------------------------------------------
// AgentIterationLoop
// ---------------------------------------------------------------------------

export class AgentIterationLoop {
  private config: AgentIterationConfig;

  constructor(config: AgentIterationConfig) {
    this.config = {
      model: config.model,
      agentCount: Math.max(1, Math.min(5, config.agentCount)),
      maxPasses: Math.max(1, Math.min(10, config.maxPasses)),
      qualityThreshold: Math.max(0, Math.min(1, config.qualityThreshold)),
    };
  }

  /**
   * Execute the agent iteration loop.
   *
   * For agentCount=1: single-shot pass-through (no iteration).
   * For agentCount>=2: producer/reviewer iteration until convergence.
   */
  async execute(prompt: string, systemPrompt?: string): Promise<AgentIterationResult> {
    const startTime = Date.now();
    const passHistory: PassEntry[] = [];
    let totalTokens = 0;

    // Single agent = pass-through (no iteration)
    if (this.config.agentCount <= 1) {
      return this.executeSingleShot(prompt, systemPrompt, startTime);
    }

    // Multi-agent: producer/reviewer iteration
    let bestContent = '';
    let bestQuality = 0;
    let passNumber = 0;

    // Pass 1: Producer generates initial response
    const producerResult = await this.callProducer(prompt, systemPrompt);
    passNumber++;
    totalTokens += producerResult.tokens;
    bestContent = producerResult.content;
    passHistory.push({
      pass: passNumber,
      role: 'producer',
      quality: 0, // Unknown until reviewer evaluates
      latencyMs: producerResult.latencyMs,
      tokensUsed: producerResult.tokens,
    });

    Logger.debug(
      `[AgentIteration] Pass ${passNumber}: Producer generated ${producerResult.content.length} chars (${producerResult.latencyMs}ms)`
    );

    // Iteration loop: reviewer evaluates, producer refines
    while (passNumber < this.config.maxPasses) {
      // Reviewer pass
      const review = await this.callReviewer(prompt, bestContent);
      passNumber++;
      totalTokens += review.tokens;
      bestQuality = review.result.quality;

      passHistory.push({
        pass: passNumber,
        role: 'reviewer',
        quality: review.result.quality,
        latencyMs: review.latencyMs,
        tokensUsed: review.tokens,
      });

      Logger.debug(
        `[AgentIteration] Pass ${passNumber}: Reviewer quality=${review.result.quality.toFixed(2)} (${review.latencyMs}ms)`
      );

      // If reviewer provided a refined version and it's better, use it
      if (review.result.refinedContent && review.result.quality < this.config.qualityThreshold) {
        bestContent = review.result.refinedContent;
      }

      // Check convergence
      if (review.result.quality >= this.config.qualityThreshold) {
        Logger.info(
          `[AgentIteration] Converged at pass ${passNumber}: quality ${review.result.quality.toFixed(2)} >= ${this.config.qualityThreshold}`
        );
        break;
      }

      // Check budget
      if (passNumber >= this.config.maxPasses) {
        Logger.info(
          `[AgentIteration] Budget exhausted at pass ${passNumber}: quality ${review.result.quality.toFixed(2)}`
        );
        break;
      }

      // Producer refines based on feedback
      const refinement = await this.callProducerRefinement(
        prompt,
        bestContent,
        review.result.feedback,
        systemPrompt
      );
      passNumber++;
      totalTokens += refinement.tokens;
      bestContent = refinement.content;

      passHistory.push({
        pass: passNumber,
        role: 'producer',
        quality: bestQuality, // Carry forward last known quality
        latencyMs: refinement.latencyMs,
        tokensUsed: refinement.tokens,
      });

      Logger.debug(
        `[AgentIteration] Pass ${passNumber}: Producer refined (${refinement.latencyMs}ms)`
      );
    }

    return {
      content: bestContent,
      finalQuality: bestQuality,
      totalPasses: passNumber,
      passHistory,
      converged: bestQuality >= this.config.qualityThreshold,
      totalTokens,
      totalLatencyMs: Date.now() - startTime,
    };
  }

  // -------------------------------------------------------------------------
  // Internal: LLM Calls
  // -------------------------------------------------------------------------

  private async executeSingleShot(
    prompt: string,
    systemPrompt: string | undefined,
    startTime: number
  ): Promise<AgentIterationResult> {
    const messages = [
      ...(systemPrompt
        ? [{ role: 'system' as const, content: systemPrompt }]
        : [{ role: 'system' as const, content: PRODUCER_SYSTEM_PROMPT }]),
      { role: 'user' as const, content: prompt },
    ];

    const response = await withTimeout(
      complete({
        model: this.config.model ?? undefined,
        messages,
      }),
      PER_CALL_TIMEOUT_MS,
      'AgentIteration single-shot'
    );

    return {
      content: response.content,
      finalQuality: 1.0, // No review = assumed good
      totalPasses: 1,
      passHistory: [{
        pass: 1,
        role: 'producer',
        quality: 1.0,
        latencyMs: Date.now() - startTime,
        tokensUsed: response.usage?.totalTokens ?? 0,
      }],
      converged: true,
      totalTokens: response.usage?.totalTokens ?? 0,
      totalLatencyMs: Date.now() - startTime,
    };
  }

  private async callProducer(
    prompt: string,
    systemPrompt?: string
  ): Promise<{ content: string; tokens: number; latencyMs: number }> {
    const start = Date.now();
    const response = await withTimeout(
      complete({
        model: this.config.model ?? undefined,
        messages: [
          { role: 'system', content: systemPrompt || PRODUCER_SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
      }),
      PER_CALL_TIMEOUT_MS,
      'AgentIteration producer'
    );

    return {
      content: response.content,
      tokens: response.usage?.totalTokens ?? 0,
      latencyMs: Date.now() - start,
    };
  }

  private async callReviewer(
    originalPrompt: string,
    producerResponse: string
  ): Promise<{ result: ReviewResult; tokens: number; latencyMs: number }> {
    const start = Date.now();
    const response = await withTimeout(
      complete({
        model: this.config.model ?? undefined,
        messages: [
          { role: 'system', content: REVIEWER_SYSTEM_PROMPT },
          {
            role: 'user',
            content: `<original-question>\n${originalPrompt}\n</original-question>\n\n<response-to-review>\n${producerResponse}\n</response-to-review>`,
          },
        ],
        temperature: 0.3, // Lower temperature for consistent evaluation
      }),
      PER_CALL_TIMEOUT_MS,
      'AgentIteration reviewer'
    );

    const result = this.parseReviewJSON(response.content);

    return {
      result,
      tokens: response.usage?.totalTokens ?? 0,
      latencyMs: Date.now() - start,
    };
  }

  private async callProducerRefinement(
    originalPrompt: string,
    previousResponse: string,
    feedback: string,
    systemPrompt?: string
  ): Promise<{ content: string; tokens: number; latencyMs: number }> {
    const start = Date.now();
    const response = await withTimeout(
      complete({
        model: this.config.model ?? undefined,
        messages: [
          { role: 'system', content: systemPrompt || PRODUCER_SYSTEM_PROMPT },
          { role: 'user', content: originalPrompt },
          { role: 'assistant', content: previousResponse },
          {
            role: 'user',
            content: `A reviewer has evaluated your response and provided this feedback:\n\n${feedback}\n\nPlease refine your response to address the feedback. Provide the complete improved response.`,
          },
        ],
      }),
      PER_CALL_TIMEOUT_MS,
      'AgentIteration producer refinement'
    );

    return {
      content: response.content,
      tokens: response.usage?.totalTokens ?? 0,
      latencyMs: Date.now() - start,
    };
  }

  // -------------------------------------------------------------------------
  // JSON Parsing
  // -------------------------------------------------------------------------

  private parseReviewJSON(raw: string): ReviewResult {
    // Try to extract JSON from response (may be wrapped in markdown)
    // Non-greedy to avoid capturing beyond the intended JSON block
    const jsonMatch = raw.match(/\{[\s\S]*?"quality"[\s\S]*?\}/);
    if (jsonMatch) {
      try {
        const parsed = safeJsonParseNoProto<Record<string, unknown>>(jsonMatch[0]);
        if (!parsed) throw new Error('parse returned null');
        return {
          quality: typeof parsed.quality === 'number'
            ? Math.max(0, Math.min(1, parsed.quality))
            : 0.5,
          feedback: typeof parsed.feedback === 'string'
            ? parsed.feedback
            : 'No feedback provided',
          refinedContent: typeof parsed.refinedContent === 'string'
            ? parsed.refinedContent
            : undefined,
        };
      } catch {
        // Fall through to fallback
      }
    }

    Logger.warn('[AgentIteration] Failed to parse reviewer JSON, using fallback quality 0.5');
    return {
      quality: 0.5,
      feedback: raw.slice(0, 500),
    };
  }
}
