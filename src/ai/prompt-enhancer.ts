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

import { z } from 'zod';
import { generateObject } from './structured-output.js';
import { getClientConfig } from './client.js';
import { loadFileContexts, formatFileContextForPrompt, parseFilePath } from './file-context.js';
import { getEnhancedContextString } from '../utils/projectContext.enhanced.js';
import { Logger } from '../utils/logger.js';

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface PromptAnalysis {
  /** Vagueness score 0-10 (0 = crystal clear, 10 = completely vague) */
  vaguenessScore: number;
  /** What specific information is missing from the prompt */
  missingContext: string[];
  /** File paths that might be relevant (based on project structure) */
  suggestedFiles: string[];
  /** Recognized user intent in one sentence */
  intent: string;
  /** Whether enhancement would improve the prompt */
  shouldEnhance: boolean;
}

export interface EnhancerOptions {
  /** Override the model used for enhancement (default: cheapest available) */
  model?: string;
  /** Max files to auto-load from suggestions (default: 5) */
  maxFiles?: number;
  /** Force enhancement even for long/detailed prompts */
  forceEnhance?: boolean;
  /** Skip analysis phase, go straight to rewrite */
  skipAnalysis?: boolean;
  /** Project root for resolving file paths */
  projectRoot?: string;
}

export interface EnhancerResult {
  /** Original user prompt */
  original: string;
  /** Enhanced prompt (same as original if skipped) */
  enhanced: string;
  /** Analysis results */
  analysis: PromptAnalysis;
  /** Files that were loaded for context */
  filesLoaded: string[];
  /** Model used for enhancement */
  model: string;
  /** Total duration in milliseconds */
  duration: number;
  /** True if enhancement was skipped (prompt was already clear) */
  skipped: boolean;
}

// ─── Constants ─────────────────────────────────────────────────────────────────

/** Prompts shorter than this are candidates for enhancement */
const SHORT_PROMPT_THRESHOLD = 500;

/** Vagueness score below this means the prompt is clear enough */
const VAGUENESS_THRESHOLD = 4;

/** Maximum files to auto-load */
const DEFAULT_MAX_FILES = 5;

/** Maximum enhanced prompt length to prevent runaway generation */
const MAX_ENHANCED_LENGTH = 4000;

/** Vague words/phrases that suggest the prompt needs clarification */
const VAGUE_MARKERS = [
  /\bfix\s+(the|a|this|it)\b/i,
  /\bthe\s+bug\b/i,
  /\bmake\s+(it|this)\s+(better|work|faster)\b/i,
  /\brefactor\s+(it|this|the)\b/i,
  /\bimprove\s+(it|this|the)\b/i,
  /\bchange\s+(it|this)\b/i,
  /\bupdate\s+(it|this)\b/i,
  /\bdo\s+(something|stuff)\b/i,
  /\bhelp\s+(me\s+)?(with|on)\s+(this|it)\b/i,
  /\blook\s+at\s+(this|it)\b/i,
  /\bcheck\s+(this|it)\b/i,
];

// ─── Zod Schema for Analysis ───────────────────────────────────────────────────

const PromptAnalysisSchema = z.object({
  vaguenessScore: z
    .number()
    .min(0)
    .max(10)
    .describe('Vagueness score: 0 = crystal clear, 10 = completely vague'),
  missingContext: z.array(z.string()).describe('List of specific missing information'),
  suggestedFiles: z.array(z.string()).describe('File paths that might be relevant'),
  intent: z.string().describe('The user intent in one clear sentence'),
  shouldEnhance: z.boolean().describe('Whether this prompt would benefit from enhancement'),
});

// ─── Model Selection ───────────────────────────────────────────────────────────

/** Provider cascade ordered by cost (cheapest first) */
const MODEL_CASCADE: Array<{ envKey: string; model: string; label: string }> = [
  { envKey: 'OLLAMA_BASE_URL', model: 'l:llama3.2:latest', label: 'ollama' },
  { envKey: 'GROQ_API_KEY', model: 'q:llama-3.1-8b-instant', label: 'groq' },
  { envKey: 'GOOGLE_API_KEY', model: 'g:gemini-2.5-flash', label: 'gemini' },
  { envKey: 'DEEPSEEK_API_KEY', model: 'd:deepseek-chat', label: 'deepseek' },
];

/**
 * Select the cheapest available model for prompt enhancement.
 * Falls back to the primary configured model if no cheap option is available.
 */
export function selectEnhancerModel(): string | null {
  // Check cascade in cost order
  for (const { envKey, model } of MODEL_CASCADE) {
    if (process.env[envKey]) {
      return model;
    }
  }

  // Fall back to primary configured model
  const config = getClientConfig();
  if (config?.defaultModel) {
    return config.defaultModel;
  }

  return null;
}

// ─── Quick Heuristic ───────────────────────────────────────────────────────────

/**
 * Fast check whether a prompt likely needs enhancement (no LLM call).
 * Returns true if the prompt appears vague or too short.
 */
function quickNeedsEnhancement(prompt: string, forceEnhance?: boolean): boolean {
  if (forceEnhance) return true;

  // Long, detailed prompts likely don't need enhancement
  if (prompt.length > SHORT_PROMPT_THRESHOLD) {
    // Unless they contain vague markers
    return VAGUE_MARKERS.some((pattern) => pattern.test(prompt));
  }

  // Short prompts are usually vague
  return true;
}

// ─── Phase 1: Analyze ──────────────────────────────────────────────────────────

/**
 * Analyze a user prompt for vagueness, missing context, and intent.
 * Uses a cheap LLM with structured output (Zod schema).
 */
export async function analyzePrompt(
  prompt: string,
  model: string,
  projectContext?: string
): Promise<PromptAnalysis> {
  const contextSnippet = projectContext
    ? projectContext.slice(0, 1000) // Keep context brief for analysis
    : 'No project context available.';

  const result = await generateObject({
    model,
    schema: PromptAnalysisSchema,
    system:
      'You are a prompt quality analyst for an AI coding assistant. Evaluate the user prompt and determine if it needs clarification or enhancement before being sent to the main AI model.',
    prompt: [
      `Evaluate this user prompt:`,
      ``,
      `"""`,
      prompt,
      `"""`,
      ``,
      `Project context (abbreviated):`,
      contextSnippet,
      ``,
      `Analyze:`,
      `1. How vague is this prompt? (0=crystal clear with all needed details, 10=completely unclear)`,
      `2. What specific information is missing? (e.g., "which file", "what error", "expected behavior")`,
      `3. What project files might be relevant? (suggest concrete paths based on project structure)`,
      `4. What is the user's actual intent?`,
      `5. Would rewriting this prompt improve the AI's response?`,
    ].join('\n'),
    temperature: 0.2,
    maxTokens: 1024,
  });

  return result.object;
}

// ─── Phase 2: Enhance ──────────────────────────────────────────────────────────

/**
 * Rewrite a vague prompt into a clear, actionable instruction.
 * Incorporates analysis results, project context, and file contents.
 */
async function rewritePrompt(
  original: string,
  analysis: PromptAnalysis,
  model: string,
  projectContext: string,
  fileContext?: string
): Promise<string> {
  const parts = [
    `Rewrite this user prompt into a clear, specific, actionable instruction for an AI coding assistant.`,
    ``,
    `Original prompt:`,
    `"""`,
    original,
    `"""`,
    ``,
    `Analysis of what's missing:`,
    `- Intent: ${analysis.intent}`,
    `- Missing: ${analysis.missingContext.join(', ') || 'nothing major'}`,
    `- Vagueness: ${analysis.vaguenessScore}/10`,
    ``,
    `Project context:`,
    projectContext.slice(0, 2000),
  ];

  if (fileContext) {
    parts.push(``, `Relevant file contents:`, fileContext.slice(0, 3000));
  }

  parts.push(
    ``,
    `Rules:`,
    `- Keep the user's original intent — do NOT add new requirements`,
    `- Add specificity: which files, what behavior, what outcome`,
    `- Include relevant technical context from the project`,
    `- Be concise — max 3-4 sentences`,
    `- Write in the same language as the original prompt`,
    `- Output ONLY the enhanced prompt text, nothing else`
  );

  const response = await generateObject({
    model,
    schema: z.object({
      enhancedPrompt: z.string().describe('The rewritten, enhanced prompt'),
    }),
    system:
      'You are a prompt engineer. Output only the enhanced prompt in a structured JSON response.',
    prompt: parts.join('\n'),
    temperature: 0.3,
    maxTokens: 1024,
  });

  let enhanced = response.object.enhancedPrompt;

  // Safety: truncate if somehow too long
  if (enhanced.length > MAX_ENHANCED_LENGTH) {
    enhanced = enhanced.slice(0, MAX_ENHANCED_LENGTH);
  }

  return enhanced;
}

// ─── Main API ──────────────────────────────────────────────────────────────────

/**
 * Enhance a user prompt through analysis and rewriting.
 *
 * Flow:
 * 1. Quick heuristic check (no LLM) — skip if prompt is clearly detailed
 * 2. Phase 1: Analyze with cheap LLM — detect vagueness and missing context
 * 3. Decision gate — skip if vagueness < threshold
 * 4. Load suggested files for additional context
 * 5. Phase 2: Rewrite prompt with full understanding
 * 6. Return enhanced result with metadata
 *
 * Safe degradation: always returns a valid result, even on errors.
 */
export async function enhancePrompt(
  prompt: string,
  options: EnhancerOptions = {}
): Promise<EnhancerResult> {
  const startTime = Date.now();
  const {
    model: modelOverride,
    maxFiles = DEFAULT_MAX_FILES,
    forceEnhance = false,
    skipAnalysis = false,
    projectRoot,
  } = options;

  // Select model
  const model = modelOverride || selectEnhancerModel();
  if (!model) {
    Logger.debug('[Enhancer] No model available, skipping enhancement');
    return makeSkippedResult(prompt, 'no-model', startTime);
  }

  // Quick heuristic — skip if prompt doesn't need enhancement
  if (!quickNeedsEnhancement(prompt, forceEnhance)) {
    Logger.debug('[Enhancer] Quick heuristic: prompt is detailed enough, skipping');
    return makeSkippedResult(prompt, model, startTime);
  }

  // Get project context (cached, fast)
  let projectContext: string;
  try {
    projectContext = getEnhancedContextString();
  } catch {
    projectContext = '';
  }

  let analysis: PromptAnalysis;

  if (skipAnalysis) {
    // Skip analysis, assume prompt needs enhancement
    analysis = {
      vaguenessScore: 7,
      missingContext: ['analysis skipped'],
      suggestedFiles: [],
      intent: prompt.slice(0, 200),
      shouldEnhance: true,
    };
  } else {
    // Phase 1: Analyze
    try {
      analysis = await analyzePrompt(prompt, model, projectContext);
    } catch (err) {
      Logger.warn(`[Enhancer] Analysis failed: ${err instanceof Error ? err.message : err}`);
      return makeSkippedResult(prompt, model, startTime);
    }

    // Decision gate: skip if prompt is clear enough
    if (!analysis.shouldEnhance || analysis.vaguenessScore < VAGUENESS_THRESHOLD) {
      Logger.debug(
        `[Enhancer] Prompt is clear (vagueness: ${analysis.vaguenessScore}/10), skipping`
      );
      return {
        original: prompt,
        enhanced: prompt,
        analysis,
        filesLoaded: [],
        model,
        duration: Date.now() - startTime,
        skipped: true,
      };
    }
  }

  // Load suggested files for context
  const filesLoaded: string[] = [];
  let fileContext = '';
  if (analysis.suggestedFiles.length > 0) {
    try {
      const filePaths = analysis.suggestedFiles.slice(0, maxFiles).map((f) => parseFilePath(f));
      const root = projectRoot || process.cwd();
      const loaded = await loadFileContexts(filePaths, root);
      if (loaded.length > 0) {
        fileContext = formatFileContextForPrompt(loaded);
        filesLoaded.push(...loaded.map((f) => f.relativePath));
      }
    } catch (err) {
      Logger.debug(`[Enhancer] File loading failed (non-critical): ${err}`);
    }
  }

  // Phase 2: Rewrite
  let enhanced: string;
  try {
    enhanced = await rewritePrompt(
      prompt,
      analysis,
      model,
      projectContext,
      fileContext || undefined
    );
  } catch (err) {
    Logger.warn(`[Enhancer] Rewrite failed: ${err instanceof Error ? err.message : err}`);
    return {
      original: prompt,
      enhanced: prompt,
      analysis,
      filesLoaded,
      model,
      duration: Date.now() - startTime,
      skipped: true,
    };
  }

  const duration = Date.now() - startTime;
  Logger.debug(
    `[Enhancer] Enhanced prompt (vagueness: ${analysis.vaguenessScore}/10, ` +
      `files: ${filesLoaded.length}, ${duration}ms)`
  );

  // Store in cognition memory (async, fire-and-forget)
  storeEnhancementResult(prompt, enhanced, analysis, model, duration).catch((err) => {
    Logger.debug(`[Enhancer] Failed to store enhancement result: ${err instanceof Error ? err.message : String(err)}`);
  });

  return {
    original: prompt,
    enhanced,
    analysis,
    filesLoaded,
    model,
    duration,
    skipped: false,
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function makeSkippedResult(prompt: string, model: string, startTime: number): EnhancerResult {
  return {
    original: prompt,
    enhanced: prompt,
    analysis: {
      vaguenessScore: 0,
      missingContext: [],
      suggestedFiles: [],
      intent: prompt.slice(0, 200),
      shouldEnhance: false,
    },
    filesLoaded: [],
    model,
    duration: Date.now() - startTime,
    skipped: true,
  };
}

/**
 * Store enhancement result in Redis memory for learning.
 * Max 50 entries, FIFO eviction.
 */
async function storeEnhancementResult(
  original: string,
  enhanced: string,
  analysis: PromptAnalysis,
  model: string,
  duration: number
): Promise<void> {
  try {
    const { getSharedRedis } = await import('../infrastructure/redis/connection.js');
    const redis = await getSharedRedis();
    if (!redis) return;

    const key = 'mcp:cognition:prompt-enhancements';
    const entry = {
      ts: new Date().toISOString(),
      original: original.slice(0, 500),
      enhanced: enhanced.slice(0, 500),
      vagueness: analysis.vaguenessScore,
      intent: analysis.intent,
      model,
      duration,
    };

    // Append to list, trim to 50
    await redis.lpush(key, JSON.stringify(entry));
    await redis.ltrim(key, 0, 49);
  } catch {
    // Non-critical, ignore
  }
}
