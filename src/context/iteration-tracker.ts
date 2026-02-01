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
 * Iteration Tracker
 *
 * Enables iterative improvements by tracking:
 * - Previous attempts at solving problems
 * - Error patterns and corrections
 * - Successful strategies to reuse
 */

import { Logger } from '../utils/logger.js';
import { getContextStorage } from './storage.js';

export interface Attempt {
  id: string;
  timestamp: number;
  toolName: string;
  taskDescription: string;
  approach: string;
  result: 'success' | 'partial' | 'failure';
  errorMessage?: string;
  corrections?: string[];
  duration: number;
  files: string[];
}

export interface Iteration {
  id: string;
  taskId: string;
  startedAt: number;
  attempts: Attempt[];
  status: 'in_progress' | 'completed' | 'abandoned';
  finalResult?: string;
  lessonsLearned?: string[];
}

export interface IterationContext {
  currentIteration?: Iteration;
  recentIterations: Iteration[];
  errorPatterns: ErrorPattern[];
  successfulStrategies: Strategy[];
}

export interface ErrorPattern {
  pattern: string;
  occurrences: number;
  lastSeen: number;
  commonFixes: string[];
}

export interface Strategy {
  description: string;
  toolName: string;
  successRate: number;
  uses: number;
  lastUsed: number;
}

const ITERATIONS_KEY = 'kemdicode:iterations';
const PATTERNS_KEY = 'kemdicode:error_patterns';
const STRATEGIES_KEY = 'kemdicode:strategies';
const MAX_ITERATIONS = 50;
const MAX_PATTERNS = 30;

/**
 * Start a new iteration for a task
 */
export async function startIteration(_taskDescription: string): Promise<string> {
  const storage = getContextStorage();
  if (!storage) return '';

  const iteration: Iteration = {
    id: `iter_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    taskId: `task_${Date.now()}`,
    startedAt: Date.now(),
    attempts: [],
    status: 'in_progress',
  };

  try {
    const existing = await storage.get(ITERATIONS_KEY);
    const iterations: Iteration[] = existing ? JSON.parse(existing) : [];

    iterations.unshift(iteration);
    if (iterations.length > MAX_ITERATIONS) {
      iterations.length = MAX_ITERATIONS;
    }

    await storage.set(ITERATIONS_KEY, JSON.stringify(iterations));
    Logger.debug(`Started iteration: ${iteration.id}`);

    return iteration.id;
  } catch (error) {
    Logger.error('Failed to start iteration:', error);
    return '';
  }
}

/**
 * Record an attempt within an iteration
 */
export async function recordAttempt(
  iterationId: string,
  toolName: string,
  approach: string,
  result: 'success' | 'partial' | 'failure',
  options: {
    errorMessage?: string;
    corrections?: string[];
    duration: number;
    files: string[];
  }
): Promise<void> {
  const storage = getContextStorage();
  if (!storage) return;

  try {
    const existing = await storage.get(ITERATIONS_KEY);
    if (!existing) return;

    const iterations: Iteration[] = JSON.parse(existing);
    const iteration = iterations.find((i) => i.id === iterationId);

    if (!iteration) {
      Logger.warn(`Iteration not found: ${iterationId}`);
      return;
    }

    const attempt: Attempt = {
      id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      timestamp: Date.now(),
      toolName,
      taskDescription: iteration.taskId,
      approach,
      result,
      ...options,
    };

    iteration.attempts.push(attempt);

    // Track error pattern if failure
    if (result === 'failure' && options.errorMessage) {
      await trackErrorPattern(options.errorMessage, options.corrections || []);
    }

    // Track successful strategy
    if (result === 'success') {
      await trackSuccessfulStrategy(toolName, approach);
    }

    await storage.set(ITERATIONS_KEY, JSON.stringify(iterations));
    Logger.debug(`Recorded attempt ${attempt.id} for iteration ${iterationId}: ${result}`);
  } catch (error) {
    Logger.error('Failed to record attempt:', error);
  }
}

/**
 * Complete an iteration with final result
 */
export async function completeIteration(
  iterationId: string,
  finalResult: string,
  lessonsLearned?: string[]
): Promise<void> {
  const storage = getContextStorage();
  if (!storage) return;

  try {
    const existing = await storage.get(ITERATIONS_KEY);
    if (!existing) return;

    const iterations: Iteration[] = JSON.parse(existing);
    const iteration = iterations.find((i) => i.id === iterationId);

    if (iteration) {
      iteration.status = 'completed';
      iteration.finalResult = finalResult;
      iteration.lessonsLearned = lessonsLearned;
      await storage.set(ITERATIONS_KEY, JSON.stringify(iterations));
      Logger.debug(`Completed iteration: ${iterationId}`);
    }
  } catch (error) {
    Logger.error('Failed to complete iteration:', error);
  }
}

/**
 * Track an error pattern for learning
 */
async function trackErrorPattern(errorMessage: string, fixes: string[]): Promise<void> {
  const storage = getContextStorage();
  if (!storage) return;

  try {
    // Extract pattern from error (normalize)
    const pattern = normalizeErrorPattern(errorMessage);

    const existing = await storage.get(PATTERNS_KEY);
    const patterns: ErrorPattern[] = existing ? JSON.parse(existing) : [];

    const existingPattern = patterns.find((p) => p.pattern === pattern);

    if (existingPattern) {
      existingPattern.occurrences++;
      existingPattern.lastSeen = Date.now();
      // Add new fixes if not already present
      for (const fix of fixes) {
        if (!existingPattern.commonFixes.includes(fix)) {
          existingPattern.commonFixes.push(fix);
        }
      }
      // Keep only top 5 fixes
      if (existingPattern.commonFixes.length > 5) {
        existingPattern.commonFixes = existingPattern.commonFixes.slice(-5);
      }
    } else {
      patterns.unshift({
        pattern,
        occurrences: 1,
        lastSeen: Date.now(),
        commonFixes: fixes,
      });
    }

    if (patterns.length > MAX_PATTERNS) {
      patterns.length = MAX_PATTERNS;
    }

    await storage.set(PATTERNS_KEY, JSON.stringify(patterns));
  } catch (error) {
    Logger.error('Failed to track error pattern:', error);
  }
}

/**
 * Track a successful strategy
 */
async function trackSuccessfulStrategy(toolName: string, approach: string): Promise<void> {
  const storage = getContextStorage();
  if (!storage) return;

  try {
    const existing = await storage.get(STRATEGIES_KEY);
    const strategies: Strategy[] = existing ? JSON.parse(existing) : [];

    const existingStrategy = strategies.find(
      (s) => s.toolName === toolName && s.description === approach
    );

    if (existingStrategy) {
      existingStrategy.uses++;
      existingStrategy.successRate = Math.min(
        100,
        existingStrategy.successRate + 5 // Increase confidence
      );
      existingStrategy.lastUsed = Date.now();
    } else {
      strategies.unshift({
        description: approach,
        toolName,
        successRate: 70, // Initial confidence
        uses: 1,
        lastUsed: Date.now(),
      });
    }

    // Sort by success rate
    strategies.sort((a, b) => b.successRate - a.successRate);

    if (strategies.length > MAX_PATTERNS) {
      strategies.length = MAX_PATTERNS;
    }

    await storage.set(STRATEGIES_KEY, JSON.stringify(strategies));
  } catch (error) {
    Logger.error('Failed to track strategy:', error);
  }
}

/**
 * Normalize error message to extract pattern
 */
function normalizeErrorPattern(error: string): string {
  return (
    error
      // Remove file paths
      .replace(/\/[\w\-./]+\.(ts|js|php|py|go)/g, '[FILE]')
      // Remove line numbers
      .replace(/:\d+:\d+/g, ':[LINE]')
      .replace(/line \d+/gi, 'line [N]')
      // Remove specific variable names
      .replace(/'[\w$]+'/g, "'[VAR]'")
      // Remove numbers
      .replace(/\b\d+\b/g, '[N]')
      // Trim and limit length
      .trim()
      .slice(0, 200)
  );
}

/**
 * Get context for current iteration
 */
export async function getIterationContext(): Promise<IterationContext> {
  const storage = getContextStorage();
  if (!storage) {
    return {
      recentIterations: [],
      errorPatterns: [],
      successfulStrategies: [],
    };
  }

  try {
    const [iterationsRaw, patternsRaw, strategiesRaw] = await Promise.all([
      storage.get(ITERATIONS_KEY),
      storage.get(PATTERNS_KEY),
      storage.get(STRATEGIES_KEY),
    ]);

    const iterations: Iteration[] = iterationsRaw ? JSON.parse(iterationsRaw) : [];
    const patterns: ErrorPattern[] = patternsRaw ? JSON.parse(patternsRaw) : [];
    const strategies: Strategy[] = strategiesRaw ? JSON.parse(strategiesRaw) : [];

    const currentIteration = iterations.find((i) => i.status === 'in_progress');

    return {
      currentIteration,
      recentIterations: iterations.slice(0, 10),
      errorPatterns: patterns.slice(0, 10),
      successfulStrategies: strategies.slice(0, 10),
    };
  } catch (error) {
    Logger.error('Failed to get iteration context:', error);
    return {
      recentIterations: [],
      errorPatterns: [],
      successfulStrategies: [],
    };
  }
}

/**
 * Get suggestions for an error based on history
 */
export async function getSuggestionsForError(errorMessage: string): Promise<string[]> {
  const storage = getContextStorage();
  if (!storage) return [];

  try {
    const pattern = normalizeErrorPattern(errorMessage);
    const patternsRaw = await storage.get(PATTERNS_KEY);

    if (!patternsRaw) return [];

    const patterns: ErrorPattern[] = JSON.parse(patternsRaw);

    // Find matching or similar patterns
    const matches = patterns.filter(
      (p) =>
        p.pattern === pattern ||
        p.pattern.includes(pattern.slice(0, 50)) ||
        pattern.includes(p.pattern.slice(0, 50))
    );

    if (matches.length === 0) return [];

    // Collect all fixes from matching patterns
    const fixes = new Set<string>();
    for (const match of matches) {
      for (const fix of match.commonFixes) {
        fixes.add(fix);
      }
    }

    return Array.from(fixes).slice(0, 5);
  } catch {
    return [];
  }
}

/**
 * Get iteration summary for display
 */
export async function getIterationSummary(): Promise<string> {
  const context = await getIterationContext();

  const lines: string[] = [];

  if (context.currentIteration) {
    const iter = context.currentIteration;
    lines.push('📍 **Current Iteration**');
    lines.push(`   Task: ${iter.taskId}`);
    lines.push(`   Attempts: ${iter.attempts.length}`);

    const successes = iter.attempts.filter((a) => a.result === 'success').length;
    const failures = iter.attempts.filter((a) => a.result === 'failure').length;
    lines.push(`   Results: ${successes} ✓ | ${failures} ✗`);
    lines.push('');
  }

  if (context.successfulStrategies.length > 0) {
    lines.push('🏆 **Top Strategies**');
    for (const strategy of context.successfulStrategies.slice(0, 3)) {
      lines.push(`   • ${strategy.toolName}: ${strategy.description} (${strategy.successRate}%)`);
    }
    lines.push('');
  }

  if (context.errorPatterns.length > 0) {
    lines.push('⚠️ **Common Error Patterns**');
    for (const pattern of context.errorPatterns.slice(0, 3)) {
      lines.push(`   • ${pattern.pattern.slice(0, 60)}... (${pattern.occurrences}x)`);
      if (pattern.commonFixes.length > 0) {
        lines.push(`     Fix: ${pattern.commonFixes[0]}`);
      }
    }
  }

  return lines.length > 0 ? lines.join('\n') : 'No iteration data yet.';
}
