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
 * Pipeline Tool - Execute a sequence of tools where output feeds into next steps
 *
 * This tool allows chaining multiple tool calls sequentially,
 * with the ability to reference previous step results in subsequent step arguments
 * using the {{stepId.result}} template syntax.
 *
 * Use cases:
 * - Read a file, then review it, then generate tests
 * - Run lint, then auto-fix, then run lint again
 * - Analyze deps, then review code with that context
 *
 * @module tools/pipeline
 */

import { z } from 'zod';
import { UnifiedTool, executeTool, type ToolArguments } from './registry.js';
import { Logger } from '../utils/logger.js';

const stepSchema = z.object({
  id: z.string().describe('Step identifier'),
  tool: z.string().describe('Tool name to execute'),
  args: z
    .record(z.string(), z.unknown())
    .describe('Tool arguments. Use {{stepId.result}} to reference previous step output'),
  continueOnError: z.boolean().default(false).describe('Continue pipeline if this step fails'),
  condition: z
    .string()
    .optional()
    .describe('Skip step unless condition is true. Supports: {{stepId.success}}, {{stepId.result}} contains "text", true, false. Examples: "{{lint.success}}", "{{read.result}} contains error"'),
});

const schema = z.object({
  steps: z.array(stepSchema).min(1).max(10).describe('Pipeline steps (1-10, executed sequentially)'),
  stopOnFirstError: z.boolean().default(true).describe('Stop entire pipeline on first error'),
});

interface StepResult {
  id: string;
  tool: string;
  success: boolean;
  result?: string;
  error?: string;
  durationMs: number;
  skipped?: boolean;
  skipReason?: string;
}

/**
 * Evaluate a simple condition expression for pipeline step gating.
 *
 * Supported expressions:
 *   - "{{stepId.success}}" → boolean check
 *   - "{{stepId.success}} === true" / "=== false"
 *   - "{{stepId.result}} contains text" → substring check
 *   - "true" / "false" → literal boolean
 *
 * All {{stepId.success}} / {{stepId.result}} references are resolved first.
 */
function evaluateCondition(
  condition: string,
  resultsMap: Map<string, string>,
  successMap: Map<string, boolean>
): boolean {
  // Replace {{stepId.success}} → "true"/"false"
  let resolved = condition.replace(/\{\{(\w+)\.success\}\}/g, (_m, stepId: string) => {
    const s = successMap.get(stepId);
    return s === undefined ? 'false' : String(s);
  });
  // Replace {{stepId.result}} → actual result string
  resolved = resolved.replace(/\{\{(\w+)\.result\}\}/g, (_m, stepId: string) => {
    return resultsMap.get(stepId) ?? '';
  });

  const trimmed = resolved.trim().toLowerCase();

  // Literal booleans
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;

  // "x === true" / "x === false"
  const eqMatch = trimmed.match(/^(.+?)\s*===\s*(true|false)$/);
  if (eqMatch) {
    const left = eqMatch[1].trim().toLowerCase();
    const right = eqMatch[2] === 'true';
    return (left === 'true') === right;
  }

  // "x contains text"
  const containsMatch = resolved.trim().match(/^(.+?)\s+contains\s+(.+)$/i);
  if (containsMatch) {
    const haystack = containsMatch[1].toLowerCase();
    const needle = containsMatch[2].toLowerCase();
    return haystack.includes(needle);
  }

  Logger.warn(`Pipeline: unrecognized condition "${condition}", treating as true`);
  return true;
}

/**
 * Replace {{stepId.result}} placeholders in args with actual results from previous steps.
 */
function resolveTemplates(
  args: Record<string, unknown>,
  resultsMap: Map<string, string>
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'string') {
      resolved[key] = value.replace(/\{\{(\w+)\.result\}\}/g, (_match, stepId: string) => {
        const stepResult = resultsMap.get(stepId);
        if (stepResult === undefined) {
          Logger.warn(`Pipeline: template {{${stepId}.result}} references unknown step`);
          return `{{${stepId}.result}}`;
        }
        return stepResult;
      });
    } else {
      resolved[key] = value;
    }
  }

  return resolved;
}

export const pipelineTool: UnifiedTool<typeof schema> = {
  name: 'pipeline',
  description:
    'Execute a sequence of tools where output from one step can feed into the next via {{stepId.result}} templates. Max 10 steps.',
  zodSchema: schema,
  skipContextShare: true, // Individual tools share their own context
  metadata: {
    category: 'system',
    tags: ['pipeline', 'workflow', 'sequential'],
    examples: [
      { args: { steps: [{ id: 'search', tool: 'semantic-search', args: { query: 'auth middleware' } }, { id: 'record', tool: 'decision-journal', args: { action: 'record', question: 'Which auth middleware?', options: ['JWT', 'OAuth'], chosen: 'JWT', reasoning: 'simpler' } }] }, description: 'Search then record decision' },
      { args: { steps: [{ id: 'check', tool: 'error-pattern', args: { action: 'match', errorMessage: 'timeout', limit: 5 } }, { id: 'budget', tool: 'context-budget', args: { action: 'estimate', keepTop: 10 } }], stopOnFirstError: true }, description: 'Check errors then estimate context budget' },
    ],
    relatedTools: ['batch', 'invoke-batch'],
  },
  execute: async (args, onProgress) => {
    const { steps, stopOnFirstError = true } = args;

    const results: StepResult[] = [];
    const resultsMap = new Map<string, string>();
    const successMap = new Map<string, boolean>();
    const startTime = Date.now();

    onProgress?.(`Pipeline: ${steps.length} steps to execute sequentially`);

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const stepStart = Date.now();

      // Evaluate condition — skip step if condition is false
      if (step.condition) {
        const condResult = evaluateCondition(step.condition, resultsMap, successMap);
        if (!condResult) {
          const skipResult: StepResult = {
            id: step.id,
            tool: step.tool,
            success: true,
            skipped: true,
            skipReason: `Condition not met: ${step.condition}`,
            durationMs: 0,
          };
          results.push(skipResult);
          successMap.set(step.id, true); // Skipped steps are considered "success" for downstream conditions
          onProgress?.(`Step ${i + 1}/${steps.length}: ${step.id} SKIPPED (condition: ${step.condition})`);
          continue;
        }
      }

      onProgress?.(`Step ${i + 1}/${steps.length}: ${step.id} (${step.tool})`);

      try {
        // Resolve template references in args
        const resolvedArgs = resolveTemplates(step.args, resultsMap);

        // Execute tool via central execution path
        const result = await executeTool(step.tool, resolvedArgs as ToolArguments, (output) => {
          onProgress?.(`[${step.id}] ${output.slice(0, 200)}`);
        });

        const stepResult: StepResult = {
          id: step.id,
          tool: step.tool,
          success: true,
          result,
          durationMs: Date.now() - stepStart,
        };

        results.push(stepResult);
        resultsMap.set(step.id, result);
        successMap.set(step.id, true);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        Logger.error(`Pipeline step ${step.id} failed:`, error);

        const stepResult: StepResult = {
          id: step.id,
          tool: step.tool,
          success: false,
          error: errorMsg,
          durationMs: Date.now() - stepStart,
        };

        results.push(stepResult);
        // Store error message so subsequent steps can still reference it
        resultsMap.set(step.id, `[ERROR: ${errorMsg}]`);
        successMap.set(step.id, false);

        // Determine whether to stop the pipeline
        const shouldStop = stopOnFirstError && !step.continueOnError;
        if (shouldStop) {
          onProgress?.(`Pipeline stopped at step ${step.id} due to error`);
          break;
        }
      }
    }

    const totalDuration = Date.now() - startTime;
    const skippedResults = results.filter((r) => r.skipped).length;
    const successful = results.filter((r) => r.success && !r.skipped).length;
    const failed = results.filter((r) => !r.success).length;
    const skipped = steps.length - results.length + skippedResults;

    // Format output
    const output: string[] = [
      `# Pipeline Execution Results`,
      ``,
      `**Summary:** ${successful} successful, ${failed} failed, ${skipped} skipped, ${totalDuration}ms total`,
      `**Steps:** ${results.length}/${steps.length} executed`,
      ``,
      `## Step Results`,
      ``,
    ];

    for (const result of results) {
      output.push(`### ${result.id} (${result.tool})`);
      if (result.skipped) {
        output.push(`- **Status:** Skipped`);
        output.push(`- **Reason:** ${result.skipReason}`);
        output.push(``);
        continue;
      }
      output.push(`- **Status:** ${result.success ? 'Success' : 'Failed'}`);
      output.push(`- **Duration:** ${result.durationMs}ms`);

      if (result.error) {
        output.push(`- **Error:** ${result.error}`);
      }

      if (result.result) {
        output.push(``);
        output.push(result.result);
      }

      output.push(``);
    }

    return output.join('\n');
  },
};
