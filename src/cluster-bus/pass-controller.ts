/**
 * KemdiCode MCP Server - Pass Controller
 * Copyright (C) 2025-2026 Kemdi Sp. z o.o. (Dawid Irzyk <dawid@kemdi.pl>)
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

/**
 * Pass Controller — Self-Regulating LLM Invocation Budget
 *
 * Each cluster node uses a PassController to manage multi-pass execution.
 * The LLM itself assesses task complexity and declares minimum passes needed,
 * then iterates with quality self-assessment until sufficient or budget exhausted.
 *
 * Strategies:
 * - min-passes: LLM declares minimum in assessment, executes that many (early-stop if quality met)
 * - quality-target: iterate until quality >= threshold or maxPasses
 * - fixed: skip assessment, execute exactly maxPasses
 *
 * @module cluster-bus/pass-controller
 */

import { Logger } from '../utils/logger.js';
import { complete } from '../ai/client.js';
import type { z } from 'zod';
import type { PassConfigSchema, PassReportSchema } from './types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PassConfig = z.infer<typeof PassConfigSchema>;

export interface PassRecord {
  pass: number;
  content: string;
  quality: number;
  sufficient: boolean;
  tokensUsed: number;
  latencyMs: number;
  refinementNote?: string;
}

export interface PassReport {
  totalPasses: number;
  minPassesDeclared: number;
  qualityAchieved: number;
  passHistory: Array<{
    pass: number;
    quality: number;
    sufficient: boolean;
    tokensUsed: number;
    latencyMs: number;
  }>;
}

interface AssessmentResult {
  minPasses: number;
  reasoning: string;
  complexity: string;
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const ASSESSMENT_SYSTEM_PROMPT = `You are evaluating a task to determine the minimum number of LLM passes needed.
Respond with ONLY a valid JSON object, no markdown, no explanation:
{
  "minPasses": <number 1-N>,
  "reasoning": "<brief reason why this many passes>",
  "complexity": "<simple|moderate|complex|multi-step>"
}

Guidelines:
- simple factual question or lookup → 1 pass
- analysis, review, or explanation → 1-2 passes
- multi-step reasoning or code generation → 2-3 passes
- complex refactoring or architecture design → 3-5 passes
- ALWAYS prefer fewer passes. Optimize for minimum invocations.
- Never exceed 10 passes for any task.`;

const QUALITY_ASSESSMENT_SUFFIX = `

---
After your response above, output a quality assessment on the LAST LINE as a JSON object (no other text on that line):
{"quality":<0.0-1.0>,"sufficient":<true|false>,"refinementNeeded":"<what to improve or empty>"}`;

const REFINEMENT_PREFIX = `Your previous response needs improvement. Here is what you produced:

---PREVIOUS---
`;

const REFINEMENT_SUFFIX = `
---END PREVIOUS---

Please provide an improved version addressing the quality gaps. Focus on completeness and accuracy.`;

// ---------------------------------------------------------------------------
// PassController
// ---------------------------------------------------------------------------

export class PassController {
  private config: PassConfig;
  private model: string | undefined;
  private history: PassRecord[] = [];
  private minPassesDeclared = 1;
  private status: 'idle' | 'assessing' | 'executing' | 'complete' | 'budget-exceeded' = 'idle';

  constructor(config: PassConfig, model?: string) {
    this.config = config;
    this.model = model;
  }

  /**
   * Pass 0: Assessment — LLM evaluates task complexity and declares minimum passes.
   * Skipped for 'fixed' strategy.
   */
  async assess(prompt: string): Promise<AssessmentResult> {
    if (this.config.strategy === 'fixed') {
      this.minPassesDeclared = this.config.maxPasses;
      return { minPasses: this.config.maxPasses, reasoning: 'Fixed strategy', complexity: 'fixed' };
    }

    this.status = 'assessing';
    const startTime = Date.now();

    try {
      const response = await complete({
        model: this.model,
        messages: [
          { role: 'system', content: ASSESSMENT_SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        maxTokens: 200,
        temperature: 0,
      });

      const latencyMs = Date.now() - startTime;
      const tokensUsed = (response.usage?.promptTokens ?? 0) + (response.usage?.completionTokens ?? 0);

      // Parse assessment JSON from response
      const assessment = this.parseAssessment(response.content);

      this.minPassesDeclared = Math.max(1, Math.min(assessment.minPasses, 20));

      this.history.push({
        pass: 0,
        content: response.content,
        quality: 0,
        sufficient: false,
        tokensUsed,
        latencyMs,
        refinementNote: `Assessment: ${assessment.complexity}, ${assessment.reasoning}`,
      });

      Logger.info(
        `[PassController] Assessment: minPasses=${this.minPassesDeclared}, complexity=${assessment.complexity}`,
      );

      return assessment;
    } catch (err) {
      Logger.warn(`[PassController] Assessment failed, defaulting to 1 pass: ${err instanceof Error ? err.message : String(err)}`);
      this.minPassesDeclared = 1;
      return { minPasses: 1, reasoning: 'Assessment failed, using single pass', complexity: 'unknown' };
    }
  }

  /**
   * Execute a pass — generates content or refines previous result.
   * Returns the parsed quality assessment.
   */
  async execute(
    prompt: string,
    systemPrompt?: string,
    previousContent?: string,
  ): Promise<PassRecord> {
    this.status = 'executing';
    const passNumber = this.history.filter((h) => h.pass > 0).length + 1;
    const startTime = Date.now();

    // Build the user message: first pass = original prompt, subsequent = refinement
    let userMessage: string;
    if (previousContent && passNumber > 1) {
      userMessage = REFINEMENT_PREFIX + previousContent + REFINEMENT_SUFFIX + '\n\nOriginal task:\n' + prompt;
    } else {
      userMessage = prompt;
    }

    // Append quality self-assessment instruction
    userMessage += QUALITY_ASSESSMENT_SUFFIX;

    try {
      const response = await complete({
        model: this.model,
        messages: [
          ...(systemPrompt ? [{ role: 'system' as const, content: systemPrompt }] : []),
          { role: 'user' as const, content: userMessage },
        ],
        maxTokens: undefined,
        temperature: undefined,
      });

      const latencyMs = Date.now() - startTime;
      const tokensUsed = (response.usage?.promptTokens ?? 0) + (response.usage?.completionTokens ?? 0);

      // Extract quality assessment from last line
      const { content, qualityData } = this.extractQualityAssessment(response.content);

      const record: PassRecord = {
        pass: passNumber,
        content,
        quality: qualityData.quality,
        sufficient: qualityData.sufficient,
        tokensUsed,
        latencyMs,
        refinementNote: qualityData.refinementNeeded || undefined,
      };

      this.history.push(record);

      Logger.info(
        `[PassController] Pass ${passNumber}: quality=${qualityData.quality.toFixed(2)}, sufficient=${qualityData.sufficient}`,
      );

      return record;
    } catch (err) {
      const latencyMs = Date.now() - startTime;
      const record: PassRecord = {
        pass: passNumber,
        content: '',
        quality: 0,
        sufficient: false,
        tokensUsed: 0,
        latencyMs,
        refinementNote: `Error: ${err instanceof Error ? err.message : String(err)}`,
      };
      this.history.push(record);
      return record;
    }
  }

  /**
   * Determine whether execution should continue.
   */
  shouldContinue(): boolean {
    const executionPasses = this.history.filter((h) => h.pass > 0);
    const lastPass = executionPasses[executionPasses.length - 1];
    const passCount = executionPasses.length;

    // Hard limit
    if (passCount >= this.config.maxPasses) {
      this.status = 'budget-exceeded';
      return false;
    }

    // No passes executed yet — continue
    if (!lastPass) return true;

    switch (this.config.strategy) {
      case 'min-passes':
        // Execute at least minPasses, but early-stop if quality met
        if (passCount >= this.minPassesDeclared) {
          this.status = 'complete';
          return false;
        }
        if (lastPass.quality >= this.config.qualityThreshold && lastPass.sufficient) {
          this.status = 'complete';
          return false;
        }
        return true;

      case 'quality-target':
        // Iterate until quality met
        if (lastPass.quality >= this.config.qualityThreshold && lastPass.sufficient) {
          this.status = 'complete';
          return false;
        }
        return true;

      case 'fixed':
        // Execute exactly maxPasses
        if (passCount >= this.config.maxPasses) {
          this.status = 'complete';
          return false;
        }
        return true;

      default:
        return false;
    }
  }

  /**
   * Get the final content from the last successful pass.
   */
  getFinalContent(): string {
    const executionPasses = this.history.filter((h) => h.pass > 0 && h.content);
    return executionPasses.length > 0 ? executionPasses[executionPasses.length - 1].content : '';
  }

  /**
   * Get the execution report.
   */
  getReport(): PassReport {
    const executionPasses = this.history.filter((h) => h.pass > 0);
    const lastPass = executionPasses[executionPasses.length - 1];

    return {
      totalPasses: this.history.length,
      minPassesDeclared: this.minPassesDeclared,
      qualityAchieved: lastPass?.quality ?? 0,
      passHistory: this.history.map((h) => ({
        pass: h.pass,
        quality: h.quality,
        sufficient: h.sufficient,
        tokensUsed: h.tokensUsed,
        latencyMs: h.latencyMs,
      })),
    };
  }

  /**
   * Get total tokens used across all passes.
   */
  getTotalTokens(): number {
    return this.history.reduce((sum, h) => sum + h.tokensUsed, 0);
  }

  /**
   * Get total latency across all passes.
   */
  getTotalLatency(): number {
    return this.history.reduce((sum, h) => sum + h.latencyMs, 0);
  }

  /** Whether budget was exceeded */
  isBudgetExceeded(): boolean {
    return this.status === 'budget-exceeded';
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private parseAssessment(raw: string): AssessmentResult {
    try {
      // Try to find JSON in the response
      const jsonMatch = raw.match(/\{[\s\S]*?"minPasses"\s*:[\s\S]*?\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          minPasses: typeof parsed.minPasses === 'number' ? parsed.minPasses : 1,
          reasoning: String(parsed.reasoning || ''),
          complexity: String(parsed.complexity || 'unknown'),
        };
      }
    } catch {}

    // Fallback: try to extract a number
    const numMatch = raw.match(/(\d+)\s*pass/i);
    if (numMatch) {
      return { minPasses: parseInt(numMatch[1], 10), reasoning: 'Extracted from text', complexity: 'unknown' };
    }

    return { minPasses: 1, reasoning: 'Could not parse assessment', complexity: 'unknown' };
  }

  private extractQualityAssessment(raw: string): {
    content: string;
    qualityData: { quality: number; sufficient: boolean; refinementNeeded: string };
  } {
    // Try to find quality JSON on the last line
    const lines = raw.split('\n');

    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 5); i--) {
      const line = lines[i].trim();
      if (line.startsWith('{') && line.includes('"quality"')) {
        try {
          const parsed = JSON.parse(line);
          const content = lines.slice(0, i).join('\n').trim();
          return {
            content: content || raw,
            qualityData: {
              quality: Math.max(0, Math.min(1, Number(parsed.quality) || 0)),
              sufficient: Boolean(parsed.sufficient),
              refinementNeeded: String(parsed.refinementNeeded || ''),
            },
          };
        } catch {}
      }
    }

    // Fallback: no quality data found, assume moderate quality
    return {
      content: raw,
      qualityData: { quality: 0.5, sufficient: false, refinementNeeded: 'No self-assessment provided' },
    };
  }
}
