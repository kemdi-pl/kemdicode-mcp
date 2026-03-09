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
 * Agentic Loop Engine
 *
 * Executes an iterative AI -> tool-call -> result -> AI loop.
 *
 * Supports two modes:
 * 1. **Native function calling** (default): Uses OpenAI-compatible `tools`
 *    parameter for reliable tool invocation via structured tool_calls.
 * 2. **Text-based parsing** (fallback): Parses ```tool-call blocks from
 *    AI text output (~70% reliability, kept for backward compatibility).
 *
 * Supports sub-agent spawning with depth tracking and
 * dependency injection via ToolExecutor interface.
 *
 * @module recursive/agentic-loop
 */

import { v4 as uuidv4 } from 'uuid';
import { executeAI, completeWithTools } from '../ai/execute.js';
import type { Message } from '../ai/client.js';
import type { FunctionTool } from '../ai/providers/types.js';
import { getAgentConfig, getAgentMaxTokens, getAgentTemperature, type AgentType } from '../ai/agents.js';
import { Logger } from '../utils/logger.js';
import { getGlobalEventBus } from '../events/global-bus.js';
import type { EventMetadata } from '../events/types.js';
import { getSharedRedis } from '../infrastructure/redis/connection.js';
import { rankByPerturbationImpact } from '../cognition/ctc-math.js';
import { analyzeOrbits } from '../cognition/orbit-compressor.js';

// ---------------------------------------------------------------------------
// Live Orchestration Status (Redis-backed)
// ---------------------------------------------------------------------------

const ORCH_PREFIX = 'mcp:orchestration:';
const ORCH_INDEX_KEY = 'mcp:orchestration:active';
const ORCH_TTL = 3600; // 1 hour

export interface OrchestrationStatus {
  id: string;
  parentOrchestrationId?: string;
  sessionId: string;
  agent: string;
  task: string;
  status: 'running' | 'completed' | 'error';
  iteration: number;
  maxIterations: number;
  depth: number;
  startedAt: number;
  updatedAt: number;
  lastToolCall?: string;
  lastToolResult?: string;
  toolCallsTotal: number;
  parallelIndex?: number;
  parallelTotal?: number;
  answer?: string;
  stopReason?: string;
}

/** In-memory orchestration state — single source of truth, serialized to Redis */
const orchStateCache = new Map<string, OrchestrationStatus>();

async function updateOrchStatus(id: string, update: Partial<OrchestrationStatus>): Promise<void> {
  try {
    const current = orchStateCache.get(id) ?? {} as OrchestrationStatus;
    const merged = { ...current, ...update, updatedAt: Date.now() };
    orchStateCache.set(id, merged as OrchestrationStatus);
    const redis = await getSharedRedis();
    await redis.setex(`${ORCH_PREFIX}${id}`, ORCH_TTL, JSON.stringify(merged));
  } catch (err) {
    Logger.warn(`updateOrchStatus(${id}): ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function registerOrchestration(id: string): Promise<void> {
  try {
    const redis = await getSharedRedis();
    await redis.sadd(ORCH_INDEX_KEY, id);
  } catch { /* non-critical */ }
}

async function unregisterOrchestration(id: string): Promise<void> {
  orchStateCache.delete(id);
  try {
    const redis = await getSharedRedis();
    await redis.srem(ORCH_INDEX_KEY, id);
  } catch { /* non-critical */ }
}

/**
 * Get live status of all active orchestrations
 */
export async function getActiveOrchestrations(): Promise<OrchestrationStatus[]> {
  try {
    const redis = await getSharedRedis();
    const ids = await redis.smembers(ORCH_INDEX_KEY);
    if (!ids.length) return [];

    const pipeline = redis.pipeline();
    for (const id of ids) {
      pipeline.get(`${ORCH_PREFIX}${id}`);
    }
    const results = await pipeline.exec();
    if (!results) return [];

    const statuses: OrchestrationStatus[] = [];
    const staleIds: string[] = [];

    for (let i = 0; i < results.length; i++) {
      const [err, raw] = results[i];
      if (err || !raw) {
        staleIds.push(ids[i]);
        continue;
      }
      try {
        const status = JSON.parse(raw as string) as OrchestrationStatus;
        // Clean up completed entries older than 5 min
        if (status.status !== 'running' && Date.now() - status.updatedAt > 300_000) {
          staleIds.push(ids[i]);
        } else {
          statuses.push(status);
        }
      } catch {
        staleIds.push(ids[i]);
      }
    }

    // Cleanup stale entries
    if (staleIds.length) {
      const cleanPipeline = redis.pipeline();
      for (const id of staleIds) {
        cleanPipeline.srem(ORCH_INDEX_KEY, id);
        cleanPipeline.del(`${ORCH_PREFIX}${id}`);
      }
      await cleanPipeline.exec();
    }

    return statuses;
  } catch {
    return [];
  }
}

/**
 * Get status of a single orchestration by ID
 */
export async function getOrchestrationStatus(id: string): Promise<OrchestrationStatus | null> {
  try {
    const redis = await getSharedRedis();
    const raw = await redis.get(`${ORCH_PREFIX}${id}`);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Env helpers (used by constants below)
// ---------------------------------------------------------------------------

/**
 * Read an integer from environment variable with a fallback default.
 */
function envInt(key: string, fallback: number): number {
  const val = process.env[key];
  if (val !== undefined) {
    const parsed = parseInt(val, 10);
    if (!isNaN(parsed)) return parsed;
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// Dependency Injection Interface
// ---------------------------------------------------------------------------

/**
 * ToolExecutor — injectable interface for executing MCP tools.
 * Default implementation uses `executeTool` from registry.
 * Tests or sub-agents can provide custom implementations.
 */
export interface ToolExecutor {
  execute(toolName: string, args: Record<string, unknown>): Promise<string>;
  listAvailable?(): string[];
  /** Get tool definitions with JSON schemas for function calling */
  getDefinitions?(): Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgenticLoopConfig {
  /** Task description for the AI */
  task: string;

  /** Agent type for AI calls (plan/build/explore/general) */
  agent: AgentType;

  /** Optional model override (provider:model syntax) */
  model?: string;

  /** Session ID for conversation continuity */
  sessionId: string;

  /** Maximum iterations before stopping (default: 10) */
  maxIterations?: number;

  /** Maximum sub-agent depth (default: 2) */
  maxSubAgentDepth?: number;

  /** Current depth for sub-agent tracking (default: 0) */
  currentDepth?: number;

  /** History of sub-agent task descriptions to prevent infinite loops */
  subAgentHistory?: string[];

  /** Tools allowed for this agent (empty = all) */
  allowedTools?: string[];

  /** Tools blocked for this agent */
  blockedTools?: string[];

  /** Enable cognitive tools (decision-journal, confidence-tracker, etc.) */
  enableCognition?: boolean;

  /** Override the default cognitive tool set (used when enableCognition is true) */
  cognitiveTools?: string[];

  /** Use native function calling (true, default) or text-based parsing (false) */
  useFunctionCalling?: boolean;

  /** Override max tokens for AI responses (default: from agent config) */
  maxTokens?: number;

  /** Override temperature for AI responses (default: from agent config) */
  temperature?: number;

  /** Parent orchestration ID (for sub-agent lineage tracking) */
  parentOrchestrationId?: string;

  /** Hard time budget in ms for the entire orchestration (default: 10 minutes, env: MCP_ORCH_TIMEOUT) */
  timeoutMs?: number;

  /** Progress callback */
  onProgress?: (message: string) => void;

  /** Injected tool executor (DI) */
  toolExecutor?: ToolExecutor;

  /** Hint: this orchestration runs alongside other clusters (enables collaboration nudges) */
  isMultiCluster?: boolean;

  /** Total number of clusters in this dispatch (for collaboration scaling) */
  totalClusters?: number;

  /** Cluster index (0-based) within the dispatch — used for work partitioning */
  clusterIndex?: number;

  /** Assigned focus area for this cluster (from work partitioning) */
  clusterFocus?: string;
}

export interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
  id?: string;
}

export interface IterationResult {
  iteration: number;
  aiResponse: string;
  toolCalls: Array<{
    tool: string;
    args: Record<string, unknown>;
    result: string;
    success: boolean;
    duration: number;
  }>;
}

export interface AgenticLoopResult {
  /** Orchestration ID for live monitoring */
  orchestrationId: string;

  /** Final answer from the AI */
  answer: string;

  /** Total iterations executed */
  iterations: number;

  /** Detailed log of each iteration */
  log: IterationResult[];

  /** Whether the AI completed naturally or was stopped */
  completed: boolean;

  /** Reason for stopping */
  stopReason: 'completed' | 'max_iterations' | 'no_tool_calls' | 'error';

  /** Total duration in ms */
  duration: number;

  /** Sub-agent results (if any were spawned) */
  subAgentResults?: Array<{
    task: string;
    answer: string;
    iterations: number;
  }>;
}

// ---------------------------------------------------------------------------
// Tool Call Parser (text-based fallback)
// ---------------------------------------------------------------------------

// Safer regex with possessive-like behavior via atomic groups workaround
// Input is already truncated to MAX_PARSE_LENGTH before these are applied
const TOOL_CALL_REGEX = /```tool-call\s*([^`]*(?:`(?!``)[^`]*)*)\s*```/g;
const RESULT_REGEX = /```result\s*([^`]*(?:`(?!``)[^`]*)*)\s*```/g;
const SUB_AGENT_REGEX = /```sub-agent\s*([^`]*(?:`(?!``)[^`]*)*)\s*```/g;

/**
 * Alternative tool call formats emitted by models that don't support native function calling.
 * Matches: [TOOL_CALL]...[/TOOL_CALL] and ```json {"tool":"name",...}``` patterns.
 * Input is already truncated to MAX_PARSE_LENGTH before these are applied.
 */
const ALT_TOOL_CALL_REGEX = /\[TOOL_CALL\]\s*\{([^]*?)\}\s*\[\/TOOL_CALL\]/g;
const ALT_JSON_TOOL_REGEX = /```(?:json)?\s*(\{[^`]*?"tool"\s*:\s*"[^`]*?\})\s*```/g;

/**
 * All kemdicode-mcp tools are internal (read files, create kanban/thinking chains,
 * query code intelligence). No tool can overwrite user files or run shell commands.
 * Agents get access to all tools by default — use allowedTools/blockedTools to restrict.
 */

/**
 * Global sub-agent budget to prevent fork-bomb resource exhaustion.
 * Shared across all loops in the same process.
 *
 * Thread-safety: Node.js is single-threaded, and acquireSubAgentSlot() is
 * synchronous (check + increment without await), so there is no TOCTOU race.
 * releaseSubAgentSlot() is always called from a `finally` block ensuring
 * cleanup even on error paths.
 */
let globalSubAgentCount = 0;
const MAX_TOTAL_SUB_AGENTS = 10;

function acquireSubAgentSlot(): boolean {
  if (globalSubAgentCount >= MAX_TOTAL_SUB_AGENTS) return false;
  globalSubAgentCount++;
  return true;
}

function releaseSubAgentSlot(): void {
  globalSubAgentCount = Math.max(0, globalSubAgentCount - 1);
}

/** Exported for testing */
export function getSubAgentCount(): number { return globalSubAgentCount; }
export function resetSubAgentCount(): void { globalSubAgentCount = 0; }

/**
 * Recursively strip prototype pollution keys from parsed JSON.
 */
function sanitizeParsedJSON(obj: unknown): unknown {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(sanitizeParsedJSON);
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    clean[key] = sanitizeParsedJSON(value);
  }
  return clean;
}

/** Maximum input length for regex parsing to prevent ReDoS (500KB) */
const MAX_PARSE_LENGTH = envInt('MCP_MAX_PARSE_LENGTH', 512_000);

/**
 * Parse ```tool-call JSON blocks from AI response.
 */
export function parseToolCalls(response: string): ToolCall[] {
  if (response.length > MAX_PARSE_LENGTH) {
    Logger.warn(`agentic-loop: parseToolCalls input too large (${response.length} chars), truncating to ${MAX_PARSE_LENGTH}`);
    response = response.slice(0, MAX_PARSE_LENGTH);
  }

  const calls: ToolCall[] = [];

  // Try standard ```tool-call format first
  let match: RegExpExecArray | null;
  TOOL_CALL_REGEX.lastIndex = 0;
  while ((match = TOOL_CALL_REGEX.exec(response)) !== null) {
    const parsed = tryParseToolJSON(match[1]);
    if (parsed) calls.push(parsed);
  }

  // If no standard calls found, try alternative formats
  if (calls.length === 0) {
    // [TOOL_CALL]{...}[/TOOL_CALL] format (MiniMax, some custom models)
    ALT_TOOL_CALL_REGEX.lastIndex = 0;
    while ((match = ALT_TOOL_CALL_REGEX.exec(response)) !== null) {
      const parsed = tryParseToolJSON(`{${match[1]}}`);
      if (parsed) calls.push(parsed);
    }
  }

  if (calls.length === 0) {
    // ```json {"tool":"name",...}``` format
    ALT_JSON_TOOL_REGEX.lastIndex = 0;
    while ((match = ALT_JSON_TOOL_REGEX.exec(response)) !== null) {
      const parsed = tryParseToolJSON(match[1]);
      if (parsed) calls.push(parsed);
    }
  }

  if (calls.length === 0) {
    // Last resort: {tool => "name", args => {...}} format (MiniMax arrow syntax)
    const arrowMatches = response.matchAll(/\{tool\s*=>\s*"([^"]+)",\s*args\s*=>\s*\{([^}]*)\}\}/g);
    for (const m of arrowMatches) {
      const toolName = m[1];
      // Try to parse the args part as key-value pairs
      const argsStr = m[2];
      const args: Record<string, unknown> = {};
      // Match patterns like: --query "value" or key "value"
      const argMatches = argsStr.matchAll(/--?(\w+)\s+"([^"]*)"/g);
      for (const am of argMatches) {
        args[am[1]] = am[2];
      }
      if (toolName) {
        calls.push({ tool: toolName, args, id: uuidv4() });
      }
    }
  }

  return calls;
}

/** Helper: try to parse a JSON string as a tool call */
function tryParseToolJSON(jsonStr: string): ToolCall | null {
  try {
    const raw = JSON.parse(jsonStr);
    const parsed = sanitizeParsedJSON(raw) as Record<string, unknown>;
    if (parsed.tool && typeof parsed.tool === 'string') {
      return {
        tool: parsed.tool as string,
        args: (parsed.args || {}) as Record<string, unknown>,
        id: (parsed.id as string) || uuidv4(),
      };
    }
    // Alternative key names: name/function instead of tool
    const name = (parsed.name || parsed.function) as string | undefined;
    if (name && typeof name === 'string') {
      return {
        tool: name,
        args: (parsed.args || parsed.arguments || parsed.parameters || {}) as Record<string, unknown>,
        id: (parsed.id as string) || uuidv4(),
      };
    }
  } catch {
    Logger.warn(`agentic-loop: failed to parse tool-call block: ${jsonStr.slice(0, 100)}`);
  }
  return null;
}

/**
 * Parse ```result block from AI response (final answer).
 */
export function parseFinalResult(response: string): string | null {
  if (response.length > MAX_PARSE_LENGTH) {
    response = response.slice(0, MAX_PARSE_LENGTH);
  }
  RESULT_REGEX.lastIndex = 0;
  const match = RESULT_REGEX.exec(response);
  return match ? match[1].trim() : null;
}

/**
 * Parse ```sub-agent blocks from AI response.
 */
export function parseSubAgentRequests(response: string): Array<{ task: string; agent?: AgentType }> {
  if (response.length > MAX_PARSE_LENGTH) {
    response = response.slice(0, MAX_PARSE_LENGTH);
  }

  const requests: Array<{ task: string; agent?: AgentType }> = [];

  SUB_AGENT_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SUB_AGENT_REGEX.exec(response)) !== null) {
    try {
      const raw = JSON.parse(match[1]);
      const parsed = sanitizeParsedJSON(raw) as Record<string, unknown>;
      if (parsed.task && typeof parsed.task === 'string') {
        requests.push({
          task: parsed.task as string,
          agent: (parsed.agent as AgentType) || 'general',
        });
      }
    } catch {
      Logger.warn(`agentic-loop: failed to parse sub-agent block`);
    }
  }

  return requests;
}

// ---------------------------------------------------------------------------
// Default ToolExecutor (uses registry)
// ---------------------------------------------------------------------------

let defaultExecutor: ToolExecutor | null = null;

async function getDefaultExecutor(): Promise<ToolExecutor> {
  if (!defaultExecutor) {
    const { executeTool, getToolDefinitions, warmupLazySchemas, invalidateToolDefinitionsCache } = await import('../tools/registry.js');

    // Ensure lazy tool schemas are loaded before building function definitions.
    // Without this, lazy tools get empty schemas {properties:{}} and the LLM
    // cannot construct valid tool calls.
    await warmupLazySchemas();
    invalidateToolDefinitionsCache();

    defaultExecutor = {
      execute: (toolName: string, args: Record<string, unknown>) =>
        executeTool(toolName, args as import('../tools/registry.js').ToolArguments),
      listAvailable: () => getToolDefinitions().map((t) => t.name),
      getDefinitions: () => getToolDefinitions().map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema as Record<string, unknown>,
      })),
    };
  }
  return defaultExecutor;
}

// ---------------------------------------------------------------------------
// Cognitive Tools
// ---------------------------------------------------------------------------

const COGNITIVE_TOOLS: Array<{ name: string; desc: string; example: string }> = [
  {
    name: 'decision-journal',
    desc: 'Record decisions with reasoning and alternatives',
    example: '{"tool": "decision-journal", "args": {"action": "record", "sessionId": "SESSION_ID", "agentId": "AGENT_ID", "question": "What approach to use?", "chosen": "Centralized error handling", "reasoning": "Provides consistency across tools", "alternatives": ["Per-tool handling", "No handling"], "confidence": 0.85, "tags": ["architecture"], "limit": 1}}',
  },
  {
    name: 'confidence-tracker',
    desc: 'Track confidence on findings (0-1 scale)',
    example: '{"tool": "confidence-tracker", "args": {"action": "record", "sessionId": "SESSION_ID", "agentId": "AGENT_ID", "area": "security-review", "level": 0.7, "evidence": "Found 3 SQL injection risks", "limit": 1}}',
  },
  {
    name: 'thinking-chain',
    desc: 'Register reasoning steps: start -> think -> conclude',
    example: '{"tool": "thinking-chain", "args": {"action": "start", "sessionId": "SESSION_ID", "agentId": "AGENT_ID", "topic": "Error handling analysis"}}',
  },
  {
    name: 'error-pattern',
    desc: 'Record error patterns for cross-session learning',
    example: '{"tool": "error-pattern", "args": {"action": "record", "sessionId": "SESSION_ID", "agentId": "AGENT_ID", "errorType": "missing-validation", "pattern": "No input check before DB query", "context": "src/api/users.ts:42", "fix": "Add zod schema validation", "severity": "high", "limit": 1}}',
  },
  {
    name: 'shared-thoughts',
    desc: 'Write insights to collective knowledge base for other agents',
    example: '{"tool": "shared-thoughts", "args": {"action": "write", "scope": "code", "content": "Finding: error handling uses centralized handleToolError with custom error classes"}}',
  },
  {
    name: 'self-critique',
    desc: 'Post-task reflection and lessons learned',
    example: '{"tool": "self-critique", "args": {"action": "record", "sessionId": "SESSION_ID", "agentId": "AGENT_ID", "taskDescription": "Error handling review", "whatWorked": "File search found all patterns", "whatFailed": "Missed some edge cases", "lessonsLearned": ["Always check catch blocks"], "efficiency": 0.8, "limit": 1}}',
  },
];

const COGNITIVE_TOOL_NAMES = COGNITIVE_TOOLS.map((t) => t.name);

// ---------------------------------------------------------------------------
// System Prompt (text-based mode)
// ---------------------------------------------------------------------------

function buildTextModePrompt(config: AgenticLoopConfig, availableTools?: string[]): string {
  const blocked = config.blockedTools?.length
    ? `\nBlocked tools (DO NOT use): ${config.blockedTools.join(', ')}`
    : '';

  const canSpawnSubAgents = (config.maxSubAgentDepth ?? 2) > (config.currentDepth ?? 0);
  const subAgentInstr = canSpawnSubAgents
    ? `

## Sub-Agents
You can delegate sub-tasks to specialized agents. Emit:
\`\`\`sub-agent
{"task": "description of sub-task", "agent": "plan|build|explore|general"}
\`\`\`
Sub-agents have their own tool access and iterations. Use them for parallel analysis or specialized tasks.
You can spawn multiple sub-agents in one response.`
    : '';

  // Build cognitive tools section with real session/agent IDs
  let cognitiveSection = '';
  if (config.enableCognition) {
    const sessionId = config.sessionId;
    const agentId = `orchestrate-d${config.currentDepth ?? 0}`;

    const cognitiveExamples = COGNITIVE_TOOLS.map(
      (t) => `- **${t.name}**: ${t.desc}\n  \`\`\`tool-call\n  ${t.example.replace(/SESSION_ID/g, sessionId).replace(/AGENT_ID/g, agentId)}\n  \`\`\``
    ).join('\n');
    cognitiveSection = `

## Cognitive Tools
Use these to record findings, decisions, and share knowledge:

${cognitiveExamples}

IMPORTANT: Always use sessionId="${sessionId}" and agentId="${agentId}" in cognitive tool calls.
Use cognitive tools after making important findings or decisions.`;
  }

  return `You are an autonomous tool-calling agent. You MUST use tools to gather information — NEVER guess or make up answers.

## How to Call Tools
Output EXACTLY this format (with triple backticks):

\`\`\`tool-call
{"tool": "file-tree", "args": {"path": "src/"}}
\`\`\`

\`\`\`tool-call
{"tool": "file-read", "args": {"path": "src/index.ts"}}
\`\`\`

You can emit multiple tool-call blocks in one response. You will receive the results, then continue.

## How to Finish
When DONE, output your final answer inside:
\`\`\`result
Your final answer here.
\`\`\`

## Available Tools
${availableTools?.join(', ') || 'all tools'}
${blocked}${cognitiveSection}${subAgentInstr}

## Rules
- MUST emit tool-call blocks — never fabricate results.
- Use cognitive tools to record important findings and decisions.
- Be thorough but efficient.
- NEVER write truncated content to files. If a file-read result was truncated, re-read the file with a smaller line range before writing.
- When using file-write, ALWAYS write the COMPLETE file content. Never include "... (truncated" markers in file content.`;
}

// ---------------------------------------------------------------------------
// System Prompt (function calling mode)
// ---------------------------------------------------------------------------

function buildFunctionCallingPrompt(config: AgenticLoopConfig, toolNames?: string[], maxIterations?: number): string {
  const canSpawnSubAgents = (config.maxSubAgentDepth ?? 2) > (config.currentDepth ?? 0);
  const subAgentInstr = canSpawnSubAgents
    ? `

## Sub-Agents
You can delegate sub-tasks to specialized agents by including a sub-agent block in your text response:
\`\`\`sub-agent
{"task": "description of sub-task", "agent": "plan|build|explore|general"}
\`\`\`
Sub-agents have their own tool access and iterations.`
    : '';

  let cognitiveSection = '';
  if (config.enableCognition) {
    const sessionId = config.sessionId;
    const agentId = `orchestrate-d${config.currentDepth ?? 0}`;
    cognitiveSection = `

## Cognitive Tools
Use cognitive tools (decision-journal, confidence-tracker, thinking-chain, error-pattern, shared-thoughts, self-critique) to record findings and decisions.
Always use sessionId="${sessionId}" and agentId="${agentId}" in cognitive tool calls.`;
  }

  // Include agent-specific expertise from agents.ts when available
  let agentExpertise = '';
  if (config.agent) {
    const agentConfig = getAgentConfig(config.agent);
    if (agentConfig) {
      agentExpertise = `\n\n## Your Role\n${agentConfig.systemPrompt}`;
    }
  }

  // List available tools with budget and phase milestones
  let toolListing = '';
  if (toolNames && toolNames.length > 0) {
    const budget = maxIterations ?? 10;
    const phase1End = Math.max(2, Math.floor(budget * 0.3));
    const phase2End = Math.max(phase1End + 2, Math.floor(budget * 0.7));

    toolListing = `\n\n## Available Tools (${toolNames.length})
${toolNames.join(', ')}

## Budget: ${budget} iterations — use ALL of them
- Iterations 1-${phase1End}: EXPLORE — use search/read tools to scan broadly
- Iterations ${phase1End + 1}-${phase2End}: ANALYZE — use different queries, dig into suspicious areas
- Iterations ${phase2End + 1}-${budget}: RECORD — create tasks for each finding, share thoughts, synthesize

CRITICAL: You must call tools in EVERY iteration until your budget runs out. Do NOT give a final answer before iteration ${phase2End}. Each iteration should use a DIFFERENT tool or the SAME tool with DIFFERENT arguments.`;
  }

  // Work partitioning for multi-cluster
  let focusSection = '';
  if (config.clusterFocus) {
    focusSection = `\n\n## Your Assigned Focus
You have been assigned a SPECIFIC area to investigate: **${config.clusterFocus}**
Focus your searches and analysis on this area. Other clusters are covering other areas.
Do NOT investigate areas outside your focus — trust other clusters to handle theirs.`;
  }

  let collaborationSection = '';
  if (config.isMultiCluster) {
    const totalClusters = config.totalClusters ?? 2;
    const clusterIdx = config.clusterIndex ?? 0;

    // Adaptive collaboration frequency based on cluster count
    // 2-5 clusters: share every 4 iterations
    // 6-20 clusters: share every 6 iterations
    // 20+: share every 8 iterations (reduce Redis pressure)
    const shareFreq = totalClusters <= 5 ? 4 : totalClusters <= 20 ? 6 : 8;

    collaborationSection = `

## Collaboration (you are cluster ${clusterIdx + 1} of ${totalClusters})
You are one of ${totalClusters} agents working in parallel.

### How to collaborate:
1. **PUBLISH findings** with "shared-thoughts": call it after every ${shareFreq} iterations with a summary of what you found.
   Example: shared-thoughts with thought="Found race condition in bus.ts:245 — concurrent send() calls can interleave correlationIds"
2. **READ others' findings** with "get-shared-context": call it at iteration ${Math.max(3, shareFreq)} and before your final answer.
3. **RECORD each finding** with "task" (action="create"): create ONE task per finding. You should create at least 3-5 tasks for a thorough investigation.

### Task creation pattern (call "task" with these args):
\`\`\`json
{"action": "create", "title": "[FINDING] Short description", "description": "Detailed explanation with file:line references", "priority": "high"}
\`\`\`
Call "task" multiple times with different titles — one per distinct finding. Do NOT batch findings into a single task.`;
  } else if (toolNames?.includes('task')) {
    // Single cluster but kanban is enabled
    collaborationSection = `

## Recording Findings
Use the "task" tool (action="create") to record each finding as a separate kanban task.
You should create at least 3 tasks for a thorough investigation.

### Task creation pattern:
\`\`\`json
{"action": "create", "title": "[FINDING] Short description", "description": "Detailed explanation with file:line references", "priority": "high"}
\`\`\`
Call "task" MULTIPLE times — one task per finding. Each task should have a DIFFERENT title describing a specific issue.`;
  }

  return `You are an autonomous tool-calling agent. You MUST use the provided tools to gather information — NEVER guess or fabricate results.
${agentExpertise}${toolListing}${focusSection}

## Workflow
1. EXPLORE: Scan the codebase broadly using search/read tools with varied queries.
2. ANALYZE: When you find something interesting, dig deeper — read the full function, check callers, look for edge cases.
3. RECORD: For EACH distinct finding, create a separate kanban task AND share via collaboration tools.
4. SYNTHESIZE: Only after using most of your iteration budget AND recording all findings, provide your final answer.

## Rules
- ALWAYS call tools to gather information — never fabricate results.
- NEVER call the same tool with the SAME arguments twice — you already have that result.
- Calling the same tool with DIFFERENT arguments is expected and encouraged.
- Use your FULL iteration budget. Do NOT stop early.
- When done, respond with your final answer as plain text (no tool calls).
- NEVER write truncated content to files.
${cognitiveSection}${collaborationSection}${subAgentInstr}`;
}

// ---------------------------------------------------------------------------
// Convert tool definitions to FunctionTool[]
// ---------------------------------------------------------------------------

function buildFunctionTools(
  executor: ToolExecutor,
  availableTools?: string[],
  blockedTools?: string[],
): FunctionTool[] {
  const definitions = executor.getDefinitions?.() ?? [];
  const allowedSet = availableTools ? new Set(availableTools) : null;
  const blockedSet = blockedTools?.length ? new Set(blockedTools) : null;

  const tools: FunctionTool[] = [];
  for (const def of definitions) {
    if (allowedSet && !allowedSet.has(def.name)) continue;
    if (blockedSet?.has(def.name)) continue;

    tools.push({
      type: 'function',
      function: {
        name: def.name,
        description: def.description || def.name,
        parameters: def.inputSchema || { type: 'object', properties: {} },
      },
    });
  }
  return tools;
}

// ---------------------------------------------------------------------------
// Execute a single tool call with safety checks
// ---------------------------------------------------------------------------

/**
 * Tools that deal with file content need higher truncation limits
 * so the agent can read full files and write them back without corruption.
 */
const FILE_CONTENT_TOOLS = new Set([
  'find-definition', 'find-references', 'semantic-search',
  'cluster-bus-file-read',
]);

/** Truncation marker pattern — used to detect corrupted content */
const TRUNCATION_MARKER_RE = /\.\.\. \(truncated, \d+ total chars\)/;

/** Default truncation limit for most tools (env: MCP_TOOL_RESULT_LIMIT, default: 16000) */
const DEFAULT_TRUNCATION_LIMIT = envInt('MCP_TOOL_RESULT_LIMIT', 16000);

/** Higher limit for file-content tools (env: MCP_FILE_RESULT_LIMIT, default: 50000) */
const FILE_CONTENT_TRUNCATION_LIMIT = envInt('MCP_FILE_RESULT_LIMIT', 50000);

/** Max iterations for sub-agents (env: MCP_SUB_AGENT_MAX_ITER, default: 5) */
const SUB_AGENT_MAX_ITERATIONS = envInt('MCP_SUB_AGENT_MAX_ITER', 5);

/** Max chars of sub-agent answer injected back to parent (env: MCP_SUB_AGENT_ANSWER_LIMIT, default: 4000) */
const SUB_AGENT_ANSWER_LIMIT = envInt('MCP_SUB_AGENT_ANSWER_LIMIT', 4000);

/** Default orchestration timeout in ms (env: MCP_ORCH_TIMEOUT, default: 600000 = 10 min) */
const DEFAULT_ORCH_TIMEOUT_MS = envInt('MCP_ORCH_TIMEOUT', 10 * 60 * 1000);

/** Per-tool execution timeout in ms (env: MCP_TOOL_EXEC_TIMEOUT, default: 120000) */
const TOOL_EXEC_TIMEOUT_MS = envInt('MCP_TOOL_EXEC_TIMEOUT', 120_000);

/** File-content tools get a longer timeout (env: MCP_FILE_TOOL_TIMEOUT, default: 180000) */
const FILE_TOOL_EXEC_TIMEOUT_MS = envInt('MCP_FILE_TOOL_TIMEOUT', 180_000);

/** Max messages in conversation history before pruning older turns (env: MCP_MAX_HISTORY_MESSAGES, default: 80) */
const MAX_HISTORY_MESSAGES = envInt('MCP_MAX_HISTORY_MESSAGES', 80);

/** Max stored sub-agent results to prevent memory bloat (env: MCP_MAX_SUB_AGENT_RESULTS, default: 20) */
const MAX_SUB_AGENT_RESULTS = envInt('MCP_MAX_SUB_AGENT_RESULTS', 20);

/** Threshold at which Lorenz-aware pruning activates (below this, use simple FIFO) */
const LORENZ_PRUNE_THRESHOLD = envInt('MCP_LORENZ_PRUNE_THRESHOLD', 30);

/**
 * Lorenz-aware conversation pruning.
 *
 * Instead of simple FIFO (drop oldest), uses perturbation impact to identify
 * which middle messages contribute least to the overall context distribution.
 * High-impact messages are preserved even if old; low-impact ones are pruned.
 *
 * Always preserves: system prompt (index 0), initial task (index 1),
 * and the most recent 6 messages (active turn context).
 *
 * Falls back to simple FIFO for small conversations (< LORENZ_PRUNE_THRESHOLD).
 */
function pruneMessages(messages: Message[], limit: number): void {
  if (messages.length <= limit) return;

  const excess = messages.length - limit;

  // For small conversations or small excess, simple FIFO is fine
  if (messages.length < LORENZ_PRUNE_THRESHOLD || excess <= 4) {
    const keep = limit - 2;
    const toRemove = messages.length - 2 - keep;
    if (toRemove > 0) {
      messages.splice(2, toRemove);
    }
    return;
  }

  // Lorenz-aware pruning: rank middle messages by perturbation impact
  const protectedHead = 2; // system + initial task
  const protectedTail = 6; // recent active context
  const middleStart = protectedHead;
  const middleEnd = messages.length - protectedTail;

  if (middleEnd <= middleStart) {
    // Not enough middle messages to prune intelligently
    messages.splice(2, excess);
    return;
  }

  // Extract text from middle messages for impact ranking
  const middleTexts = messages.slice(middleStart, middleEnd).map((m) =>
    typeof m.content === 'string' ? m.content.slice(0, 500) : ''
  );

  const rankings = rankByPerturbationImpact(middleTexts);

  // Identify low-impact indices to remove (lowest impact first)
  const toRemoveCount = Math.min(excess, rankings.length);
  const removeIndices = new Set(
    rankings
      .slice(-toRemoveCount) // lowest impact items are at the end (sorted desc)
      .map((r) => r.index + middleStart) // convert to absolute message index
  );

  // Remove from end to start to preserve indices
  const sortedRemove = [...removeIndices].sort((a, b) => b - a);
  for (const idx of sortedRemove) {
    messages.splice(idx, 1);
  }
}

function getTruncationLimit(toolName: string): number {
  return FILE_CONTENT_TOOLS.has(toolName)
    ? FILE_CONTENT_TRUNCATION_LIMIT
    : DEFAULT_TRUNCATION_LIMIT;
}

async function executeSingleToolCall(
  call: { tool: string; args: Record<string, unknown>; id?: string },
  executor: ToolExecutor,
  availableTools: string[] | undefined,
  blockedTools: string[] | undefined,
  progress: (msg: string) => void,
): Promise<{ tool: string; args: Record<string, unknown>; result: string; success: boolean; duration: number }> {
  // Safety: check blocked
  if (blockedTools?.includes(call.tool)) {
    return {
      tool: call.tool,
      args: call.args,
      result: `BLOCKED: Tool '${call.tool}' is not allowed`,
      success: false,
      duration: 0,
    };
  }

  if (availableTools && !availableTools.includes(call.tool)) {
    return {
      tool: call.tool,
      args: call.args,
      result: `ERROR: Tool '${call.tool}' not found. Available: ${availableTools.slice(0, 20).join(', ')}...`,
      success: false,
      duration: 0,
    };
  }

  // Guard: prevent writing truncated content to files
  if (call.tool === 'file-write' && typeof call.args.content === 'string') {
    if (TRUNCATION_MARKER_RE.test(call.args.content)) {
      return {
        tool: call.tool,
        args: { ...call.args, content: '<content omitted from error>' },
        result: 'ERROR: Refusing to write truncated content to file. The content contains a truncation marker ("... (truncated, N total chars)"). Re-read the full file first, then write the complete content.',
        success: false,
        duration: 0,
      };
    }
  }

  const callStart = Date.now();
  try {
    progress(`Executing ${call.tool}`);
    const timeoutMs = FILE_CONTENT_TOOLS.has(call.tool) ? FILE_TOOL_EXEC_TIMEOUT_MS : TOOL_EXEC_TIMEOUT_MS;
    const result = await Promise.race([
      executor.execute(call.tool, call.args),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Tool '${call.tool}' timed out after ${timeoutMs}ms`)), timeoutMs),
      ),
    ]);
    const duration = Date.now() - callStart;

    // Truncate large results to prevent context explosion
    // File-content tools get a much higher limit to preserve full file content
    const limit = getTruncationLimit(call.tool);
    const truncated = result.length > limit
      ? result.slice(0, limit) + `\n... (truncated, ${result.length} total chars — use line range or smaller scope)`
      : result;

    return { tool: call.tool, args: call.args, result: truncated, success: true, duration };
  } catch (error) {
    const duration = Date.now() - callStart;
    const errMsg = error instanceof Error ? error.message : String(error);
    return { tool: call.tool, args: call.args, result: `ERROR: ${errMsg}`, success: false, duration };
  }
}

// ---------------------------------------------------------------------------
// Sub-agent loop detection
// ---------------------------------------------------------------------------

/**
 * Normalize task description for dedup comparison (lowercase, collapse whitespace).
 */
function normalizeTask(task: string): string {
  return task.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 200);
}

/**
 * Check if a sub-agent task is a duplicate of a previous one.
 */
function isSubAgentLoop(task: string, history: string[]): boolean {
  const normalized = normalizeTask(task);
  return history.some((h) => h === normalized);
}

// ---------------------------------------------------------------------------
// Main Loop — Native Function Calling Mode
// ---------------------------------------------------------------------------

async function executeWithFunctionCalling(
  config: AgenticLoopConfig,
  executor: ToolExecutor,
  availableTools: string[] | undefined,
  maxIterations: number,
  currentDepth: number,
  maxSubAgentDepth: number,
  subAgentHistory: string[],
  progress: (msg: string) => void,
  emitLoop?: (type: string, extra: Record<string, unknown>, publishToRedis?: boolean) => void,
  loopId?: string,
): Promise<AgenticLoopResult> {
  const startTime = Date.now();
  const deadlineMs = config.timeoutMs ?? DEFAULT_ORCH_TIMEOUT_MS;
  const log: IterationResult[] = [];
  const subAgentResults: AgenticLoopResult['subAgentResults'] = [];

  // Build function tools from definitions
  const functionTools = buildFunctionTools(executor, availableTools, config.blockedTools);
  const toolNames = functionTools.map((t) => t.function.name);
  progress(`Function calling mode: ${functionTools.length} tools available`);

  // Build system prompt (with tool names and agent expertise)
  const systemPrompt = buildFunctionCallingPrompt(config, toolNames, maxIterations);

  // Multi-turn message history
  const messages: Message[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `## Your Task\n\n${config.task}` },
  ];

  let lastAnswer = '';
  let stopReason: AgenticLoopResult['stopReason'] = 'max_iterations';

  // Track recent tool calls to detect repetition
  const recentToolCalls: Array<{ name: string; argsHash: string }> = [];
  const MAX_CONSECUTIVE_SAME_TOOL = 3;

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    // Time budget check: stop before starting a new iteration if budget is exhausted
    const elapsed = Date.now() - startTime;
    if (elapsed > deadlineMs) {
      progress(`Time budget exhausted (${Math.round(elapsed / 1000)}s / ${Math.round(deadlineMs / 1000)}s) — stopping`);
      stopReason = 'max_iterations';
      break;
    }

    progress(`Iteration ${iteration}/${maxIterations}`);
    emitLoop?.('loop:iteration', { iteration, maxIterations });

    // Update live status in Redis
    if (loopId) {
      void updateOrchStatus(loopId, { iteration, updatedAt: Date.now() });
    }

    let response;
    try {
      response = await completeWithTools({
        messages,
        agent: config.agent,
        model: config.model,
        tools: functionTools.length > 0 ? functionTools : undefined,
        toolChoice: functionTools.length > 0 ? 'auto' : undefined,
        temperature: config.temperature ?? getAgentTemperature(config.agent),
        maxTokens: config.maxTokens ?? getAgentMaxTokens(config.agent),
      });
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      progress(`AI error (attempt 1): ${errMsg} — retrying...`);
      // Retry once: client.ts will attempt fallback model internally
      try {
        await new Promise((r) => setTimeout(r, 1000));
        response = await completeWithTools({
          messages,
          agent: config.agent,
          model: config.model,
          tools: functionTools.length > 0 ? functionTools : undefined,
          toolChoice: functionTools.length > 0 ? 'auto' : undefined,
          temperature: config.temperature ?? getAgentTemperature(config.agent),
          maxTokens: config.maxTokens ?? getAgentMaxTokens(config.agent),
        });
      } catch (retryError) {
        progress(`AI error (attempt 2): ${retryError instanceof Error ? retryError.message : String(retryError)}`);
        stopReason = 'error';
        break;
      }
    }

    const aiContent = response.content || '';
    const nativeToolCalls = response.toolCalls;
    lastAnswer = aiContent;

    // Check for sub-agent requests in text (these don't have a function calling equivalent)
    const subAgentReqs = parseSubAgentRequests(aiContent);

    // If AI returned tool calls via native function calling
    if (nativeToolCalls?.length) {
      // Add assistant message with tool calls to conversation
      messages.push({
        role: 'assistant',
        content: aiContent,
        toolCalls: nativeToolCalls,
      });

      const iterationLog: IterationResult = { iteration, aiResponse: aiContent, toolCalls: [] };

      // Execute each tool call and add results to conversation
      for (const tc of nativeToolCalls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function.arguments);
        } catch {
          Logger.warn(`agentic-loop: failed to parse tool arguments for ${tc.function.name}`);
        }

        emitLoop?.('loop:tool-called', { iteration, toolName: tc.function.name, args });

        const result = await executeSingleToolCall(
          { tool: tc.function.name, args, id: tc.id },
          executor,
          availableTools,
          config.blockedTools,
          progress,
        );

        emitLoop?.('loop:tool-result', {
          iteration,
          toolName: tc.function.name,
          success: result.success,
          duration: result.duration,
        });

        iterationLog.toolCalls.push(result);

        // Update live status with latest tool call info
        if (loopId) {
          const totalCalls = log.reduce((s, i) => s + i.toolCalls.length, 0) + iterationLog.toolCalls.length;
          void updateOrchStatus(loopId, {
            lastToolCall: tc.function.name,
            lastToolResult: result.result.slice(0, 200),
            toolCallsTotal: totalCalls,
          });
        }

        // Add tool result message to conversation
        messages.push({
          role: 'tool',
          content: result.result,
          toolCallId: tc.id,
        });
      }

      log.push(iterationLog);

      // Track tool calls for repetition detection
      for (const tc of nativeToolCalls) {
        const argsHash = tc.function.arguments.slice(0, 200);
        recentToolCalls.push({ name: tc.function.name, argsHash });
      }

      // Detect repetitive tool usage — nudge LLM to move on
      if (recentToolCalls.length >= MAX_CONSECUTIVE_SAME_TOOL) {
        const lastN = recentToolCalls.slice(-MAX_CONSECUTIVE_SAME_TOOL);
        const allSameCall = lastN.every((c) => c.name === lastN[0].name && c.argsHash === lastN[0].argsHash);
        const allSameTool = allSameCall; // Only nudge when same tool + same args (not just same tool name)
        if (allSameTool) {
          const otherTools = toolNames.filter((t) => t !== lastN[0].name);
          const nudge = otherTools.length > 0
            ? `You have called "${lastN[0].name}" ${MAX_CONSECUTIVE_SAME_TOOL} times in a row. You already have those results. Now move to the NEXT step: use a different tool (${otherTools.join(', ')}) or provide your final answer.`
            : `You have called "${lastN[0].name}" ${MAX_CONSECUTIVE_SAME_TOOL} times in a row. You already have sufficient results. Provide your final answer now.`;
          messages.push({ role: 'user', content: nudge });
          progress(`Nudge: ${lastN[0].name} called ${MAX_CONSECUTIVE_SAME_TOOL}x — prompting to move on`);
        }
      }

      // Collaboration nudge: adaptive frequency based on cluster count
      if (config.isMultiCluster && iteration > 0) {
        const totalClusters = config.totalClusters ?? 2;
        // Scale nudge frequency: 2-5 clusters → every 4, 6-20 → every 6, 20+ → every 8
        const nudgeFreq = totalClusters <= 5 ? 4 : totalClusters <= 20 ? 6 : 8;
        if (iteration % nudgeFreq === 0) {
          const hasSharedThoughts = toolNames.includes('shared-thoughts');
          const hasGetContext = toolNames.includes('get-shared-context');
          const hasTask = toolNames.includes('task');
          if (hasSharedThoughts || hasGetContext || hasTask) {
            const actions = [];
            if (hasSharedThoughts) actions.push('publish your findings with "shared-thoughts"');
            if (hasGetContext) actions.push('check others\' work with "get-shared-context"');
            if (hasTask) actions.push('record each finding with "task" (action="create") — one task per issue');
            messages.push({
              role: 'user',
              content: `CHECKPOINT (iteration ${iteration}/${maxIterations}): ${actions.join('. ')}. How many tasks have you created so far? If fewer than 3, search harder.`,
            });
            progress(`Collaboration nudge at iteration ${iteration} (freq=${nudgeFreq})`);
          }
        }
      }

      // Handle sub-agent requests from text
      if (subAgentReqs.length > 0 && currentDepth < maxSubAgentDepth) {
        for (const req of subAgentReqs) {
          if (isSubAgentLoop(req.task, subAgentHistory)) {
            progress(`Skipping duplicate sub-agent task: ${req.task.slice(0, 60)}...`);
            messages.push({ role: 'user', content: `Sub-agent skipped (loop detected): "${req.task.slice(0, 60)}"` });
            continue;
          }
          if (!acquireSubAgentSlot()) {
            progress(`Sub-agent budget exhausted (max ${MAX_TOTAL_SUB_AGENTS}), skipping: ${req.task.slice(0, 60)}...`);
            messages.push({ role: 'user', content: `Sub-agent skipped (global budget exhausted, max ${MAX_TOTAL_SUB_AGENTS}): "${req.task.slice(0, 60)}"` });
            continue;
          }
          progress(`Spawning sub-agent: ${req.task.slice(0, 60)}...`);
          emitLoop?.('loop:sub-agent-spawned', {
            subTask: req.task.slice(0, 200),
            subAgent: req.agent || 'general',
            depth: currentDepth + 1,
          }, true);
          const updatedHistory = [...subAgentHistory, normalizeTask(req.task)];
          try {
            const subResult = await executeAgenticLoop({
              ...config,
              task: req.task,
              agent: req.agent || 'general',
              currentDepth: currentDepth + 1,
              maxIterations: Math.min(maxIterations, SUB_AGENT_MAX_ITERATIONS),
              sessionId: `${config.sessionId}:sub:${uuidv4().slice(0, 8)}`,
              parentOrchestrationId: loopId,
              onProgress: (msg) => progress(`  [sub-agent] ${msg}`),
              subAgentHistory: updatedHistory,
            });

            if (subAgentResults.length < MAX_SUB_AGENT_RESULTS) {
              subAgentResults.push({
                task: req.task,
                answer: subResult.answer,
                iterations: subResult.iterations,
              });
            }

            // Inject sub-agent result as user message
            messages.push({
              role: 'user',
              content: `Sub-agent result for "${req.task.slice(0, 40)}":\n${subResult.answer.slice(0, SUB_AGENT_ANSWER_LIMIT)}`,
            });
          } catch (error) {
            const errMsg = error instanceof Error ? error.message : String(error);
            messages.push({ role: 'user', content: `Sub-agent error: ${errMsg}` });
          } finally {
            releaseSubAgentSlot();
          }
        }
      }

      // Prune conversation history to prevent unbounded growth
      pruneMessages(messages, MAX_HISTORY_MESSAGES);

      continue;
    }

    // No native tool calls — try text-based fallback
    const textToolCalls = parseToolCalls(aiContent);

    // Check for ```result block
    const finalResult = parseFinalResult(aiContent);
    if (finalResult) {
      lastAnswer = finalResult;
      log.push({ iteration, aiResponse: aiContent, toolCalls: [] });
      stopReason = 'completed';
      progress('AI emitted final result');
      break;
    }

    // If text-based tool calls found (fallback)
    if (textToolCalls.length > 0) {
      progress(`Fallback: parsed ${textToolCalls.length} text-based tool calls`);
      messages.push({ role: 'assistant', content: aiContent });

      const iterationLog: IterationResult = { iteration, aiResponse: aiContent, toolCalls: [] };

      let toolResultsText = '';
      for (const call of textToolCalls) {
        const result = await executeSingleToolCall(
          call, executor, availableTools, config.blockedTools, progress,
        );
        iterationLog.toolCalls.push(result);
        toolResultsText += `\n[${call.tool}] (${result.duration}ms):\n${result.result}\n`;

        // Update live status with latest tool call info
        if (loopId) {
          const totalCalls = log.reduce((s, i) => s + i.toolCalls.length, 0) + iterationLog.toolCalls.length;
          void updateOrchStatus(loopId, {
            lastToolCall: call.tool,
            lastToolResult: result.result.slice(0, 200),
            toolCallsTotal: totalCalls,
          });
        }
      }

      // Feed results back as user message
      messages.push({ role: 'user', content: `Tool results:\n${toolResultsText}\n\nContinue or provide your final answer.` });

      log.push(iterationLog);
      pruneMessages(messages, MAX_HISTORY_MESSAGES);
      continue;
    }

    // No tool calls at all — AI is done
    if (subAgentReqs.length === 0) {
      log.push({ iteration, aiResponse: aiContent, toolCalls: [] });
      stopReason = 'completed';
      progress('AI responded without tool calls — treating as final answer');
      break;
    }

    // Only sub-agent requests
    log.push({ iteration, aiResponse: aiContent, toolCalls: [] });
    messages.push({ role: 'assistant', content: aiContent });

    if (currentDepth < maxSubAgentDepth) {
      for (const req of subAgentReqs) {
        if (isSubAgentLoop(req.task, subAgentHistory)) {
          progress(`Skipping duplicate sub-agent task: ${req.task.slice(0, 60)}...`);
          messages.push({ role: 'user', content: `Sub-agent skipped (loop detected): "${req.task.slice(0, 60)}"` });
          continue;
        }
        if (!acquireSubAgentSlot()) {
          progress(`Sub-agent budget exhausted (max ${MAX_TOTAL_SUB_AGENTS}), skipping: ${req.task.slice(0, 60)}...`);
          messages.push({ role: 'user', content: `Sub-agent skipped (global budget exhausted): "${req.task.slice(0, 60)}"` });
          continue;
        }
        progress(`Spawning sub-agent: ${req.task.slice(0, 60)}...`);
        const updatedHistory = [...subAgentHistory, normalizeTask(req.task)];
        try {
          const subResult = await executeAgenticLoop({
            ...config,
            task: req.task,
            agent: req.agent || 'general',
            currentDepth: currentDepth + 1,
            maxIterations: Math.min(maxIterations, SUB_AGENT_MAX_ITERATIONS),
            sessionId: `${config.sessionId}:sub:${uuidv4().slice(0, 8)}`,
            onProgress: (msg) => progress(`  [sub-agent] ${msg}`),
            subAgentHistory: updatedHistory,
          });

          subAgentResults.push({
            task: req.task,
            answer: subResult.answer,
            iterations: subResult.iterations,
          });

          messages.push({
            role: 'user',
            content: `Sub-agent result for "${req.task.slice(0, 40)}":\n${subResult.answer.slice(0, SUB_AGENT_ANSWER_LIMIT)}`,
          });
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error);
          messages.push({ role: 'user', content: `Sub-agent error: ${errMsg}` });
        } finally {
          releaseSubAgentSlot();
        }
      }
    } else {
      messages.push({
        role: 'user',
        content: `Max sub-agent depth (${maxSubAgentDepth}) reached, cannot spawn sub-agents. Continue with available tools or provide your final answer.`,
      });
    }
  }

  // If loop ended without a clean completion (max_iterations, timeout, etc.),
  // ask the model for a final synthesis of all findings so far.
  if (stopReason !== 'completed' && stopReason !== 'error' && log.length > 0) {
    const toolResults = log
      .flatMap((iter) => iter.toolCalls.map((tc) => `[${tc.tool}]: ${tc.result.slice(0, 500)}`))
      .join('\n');
    if (toolResults.length > 0) {
      try {
        const synthesisPrompt = `You have run out of iterations. Based on ALL the tool results you gathered, provide your COMPLETE final answer now. Do not call any more tools. Summarize all findings clearly.\n\nTool results collected:\n${toolResults.slice(0, 8000)}`;
        messages.push({ role: 'user', content: synthesisPrompt });
        const synthesis = await completeWithTools({
          messages,
          agent: config.agent,
          model: config.model,
          tools: undefined, // no tools — force text response
          maxTokens: config.maxTokens ?? getAgentMaxTokens(config.agent),
        });
        if (synthesis.content && synthesis.content.length > lastAnswer.length) {
          lastAnswer = synthesis.content;
          stopReason = 'completed';
          progress('Synthesized final answer from accumulated tool results');
        }
      } catch {
        // Synthesis failed — keep existing lastAnswer
        progress('Synthesis call failed — returning partial answer');
      }
    }
  }

  return {
    orchestrationId: loopId || '',
    answer: lastAnswer,
    iterations: log.length,
    log,
    completed: stopReason === 'completed',
    stopReason,
    duration: Date.now() - startTime,
    subAgentResults: subAgentResults.length > 0 ? subAgentResults : undefined,
  };
}

// ---------------------------------------------------------------------------
// Main Loop — Text-Based Mode (legacy)
// ---------------------------------------------------------------------------

async function executeWithTextParsing(
  config: AgenticLoopConfig,
  executor: ToolExecutor,
  availableTools: string[] | undefined,
  maxIterations: number,
  currentDepth: number,
  maxSubAgentDepth: number,
  subAgentHistory: string[],
  progress: (msg: string) => void,
  emitLoop?: (type: string, extra: Record<string, unknown>, publishToRedis?: boolean) => void,
  loopId?: string,
): Promise<AgenticLoopResult> {
  const startTime = Date.now();
  const deadlineMs = config.timeoutMs ?? DEFAULT_ORCH_TIMEOUT_MS;
  const log: IterationResult[] = [];
  const subAgentResults: AgenticLoopResult['subAgentResults'] = [];

  // Build orchestrator system instructions
  const orchestratorPrompt = buildTextModePrompt(config, availableTools);

  // Conversation state: accumulate tool results as context
  let conversationContext = '';
  /** Individual tool result blocks — used for orbit compression when context grows large */
  const contextBlocks: string[] = [];
  let lastAnswer = '';
  let stopReason: AgenticLoopResult['stopReason'] = 'max_iterations';

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    // Time budget check: stop before starting a new iteration if budget is exhausted
    const elapsed = Date.now() - startTime;
    if (elapsed > deadlineMs) {
      progress(`Time budget exhausted (${Math.round(elapsed / 1000)}s / ${Math.round(deadlineMs / 1000)}s) — stopping`);
      stopReason = 'max_iterations';
      break;
    }

    progress(`Iteration ${iteration}/${maxIterations}`);
    emitLoop?.('loop:iteration', { iteration, maxIterations });

    // Update live status in Redis
    if (loopId) {
      void updateOrchStatus(loopId, { iteration, updatedAt: Date.now() });
    }

    // Build prompt: task in first iteration, tool results in subsequent ones
    const iterationPrompt = iteration === 1
      ? `## Your Task\n\n${config.task}\n\nStart by calling the appropriate tools now using \`\`\`tool-call blocks.`
      : `Previous tool results:\n${conversationContext}\n\nContinue solving the task. Emit more \`\`\`tool-call blocks or emit a \`\`\`result block when done.`;

    // Call AI with orchestrator as system prompt (overrides agent default)
    let aiResponse: string;
    const aiCallArgs = {
      prompt: iterationPrompt,
      agent: config.agent,
      model: config.model,
      systemPrompt: orchestratorPrompt,
      sessionId: `${config.sessionId}:orchestrate:${currentDepth}`,
      continueSession: iteration > 1,
      temperature: config.temperature ?? getAgentTemperature(config.agent),
      maxTokens: config.maxTokens ?? getAgentMaxTokens(config.agent),
    };
    try {
      aiResponse = await executeAI(aiCallArgs);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      progress(`AI error (attempt 1): ${errMsg} — retrying...`);
      try {
        await new Promise((r) => setTimeout(r, 1000));
        aiResponse = await executeAI(aiCallArgs);
      } catch (retryError) {
        progress(`AI error (attempt 2): ${retryError instanceof Error ? retryError.message : String(retryError)}`);
        stopReason = 'error';
        break;
      }
    }

    lastAnswer = aiResponse;

    // Check for final result
    const finalResult = parseFinalResult(aiResponse);
    if (finalResult) {
      lastAnswer = finalResult;
      log.push({ iteration, aiResponse, toolCalls: [] });
      stopReason = 'completed';
      progress('AI emitted final result');
      break;
    }

    // Parse tool calls
    const toolCalls = parseToolCalls(aiResponse);

    // Parse sub-agent requests
    const subAgentReqs = parseSubAgentRequests(aiResponse);

    // No tool calls and no sub-agents = AI is done (or stuck)
    if (toolCalls.length === 0 && subAgentReqs.length === 0) {
      log.push({ iteration, aiResponse, toolCalls: [] });
      stopReason = 'no_tool_calls';
      progress('No tool calls emitted, stopping');
      break;
    }

    // Execute tool calls
    const iterationLog: IterationResult = {
      iteration,
      aiResponse,
      toolCalls: [],
    };

    for (const call of toolCalls) {
      emitLoop?.('loop:tool-called', { iteration, toolName: call.tool, args: call.args });

      const result = await executeSingleToolCall(
        call, executor, availableTools, config.blockedTools, progress,
      );

      emitLoop?.('loop:tool-result', {
        iteration,
        toolName: call.tool,
        success: result.success,
        duration: result.duration,
      });

      iterationLog.toolCalls.push(result);
      const block = `\n[${call.tool}] (${result.duration}ms):\n${result.result}\n`;
      contextBlocks.push(block);
      conversationContext += block;

      // Update live status with latest tool call info
      if (loopId) {
        const totalCalls = log.reduce((s, i) => s + i.toolCalls.length, 0) + iterationLog.toolCalls.length;
        void updateOrchStatus(loopId, {
          lastToolCall: call.tool,
          lastToolResult: result.result.slice(0, 200),
          toolCallsTotal: totalCalls,
        });
      }
    }

    // Lorenz orbit compression: detect repeating tool result patterns
    // and rebuild context with redundant blocks removed
    if (contextBlocks.length >= 12) {
      try {
        const indexed = contextBlocks.map((b, i) => ({ index: i, content: b, confidence: 50 }));
        const orbits = analyzeOrbits(indexed);
        if (orbits.pruneIndices.length > 0) {
          const pruneSet = new Set(orbits.pruneIndices);
          const kept = contextBlocks.filter((_, i) => !pruneSet.has(i));
          progress(`Lorenz orbit compression: ${contextBlocks.length} → ${kept.length} blocks (${orbits.orbits.length} cycles detected)`);
          contextBlocks.length = 0;
          contextBlocks.push(...kept);
          conversationContext = kept.join('');
        }
      } catch {
        // Compression is best-effort — continue without it
      }
    }

    // Execute sub-agents (if allowed by depth)
    if (subAgentReqs.length > 0 && currentDepth < maxSubAgentDepth) {
      for (const req of subAgentReqs) {
        if (isSubAgentLoop(req.task, subAgentHistory)) {
          progress(`Skipping duplicate sub-agent task: ${req.task.slice(0, 60)}...`);
          conversationContext += `\n[sub-agent] Skipped (loop detected): "${req.task.slice(0, 60)}"\n`;
          continue;
        }
        if (!acquireSubAgentSlot()) {
          progress(`Sub-agent budget exhausted (max ${MAX_TOTAL_SUB_AGENTS}), skipping: ${req.task.slice(0, 60)}...`);
          conversationContext += `\n[sub-agent] Skipped (global budget exhausted, max ${MAX_TOTAL_SUB_AGENTS}): "${req.task.slice(0, 60)}"\n`;
          continue;
        }
        progress(`Spawning sub-agent: ${req.task.slice(0, 60)}...`);
        emitLoop?.('loop:sub-agent-spawned', {
          subTask: req.task.slice(0, 200),
          subAgent: req.agent || 'general',
          depth: currentDepth + 1,
        }, true);
        const updatedHistory = [...subAgentHistory, normalizeTask(req.task)];
        try {
          const subResult = await executeAgenticLoop({
            ...config,
            task: req.task,
            agent: req.agent || 'general',
            currentDepth: currentDepth + 1,
            maxIterations: Math.min(maxIterations, SUB_AGENT_MAX_ITERATIONS),
            sessionId: `${config.sessionId}:sub:${uuidv4().slice(0, 8)}`,
            onProgress: (msg) => progress(`  [sub-agent] ${msg}`),
            subAgentHistory: updatedHistory,
          });

          subAgentResults.push({
            task: req.task,
            answer: subResult.answer,
            iterations: subResult.iterations,
          });

          const saBlock = `\n[sub-agent: ${req.task.slice(0, 40)}] Result:\n${subResult.answer.slice(0, SUB_AGENT_ANSWER_LIMIT)}\n`;
          contextBlocks.push(saBlock);
          conversationContext += saBlock;
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error);
          conversationContext += `\n[sub-agent ERROR]: ${errMsg}\n`;
        } finally {
          releaseSubAgentSlot();
        }
      }
    } else if (subAgentReqs.length > 0) {
      conversationContext += `\n[sub-agent] Max depth (${maxSubAgentDepth}) reached, cannot spawn sub-agents\n`;
    }

    log.push(iterationLog);
  }

  return {
    orchestrationId: loopId || '',
    answer: lastAnswer,
    iterations: log.length,
    log,
    completed: stopReason === 'completed',
    stopReason,
    duration: Date.now() - startTime,
    subAgentResults: subAgentResults.length > 0 ? subAgentResults : undefined,
  };
}

// ---------------------------------------------------------------------------
// Main Entry Point
// ---------------------------------------------------------------------------

export async function executeAgenticLoop(config: AgenticLoopConfig): Promise<AgenticLoopResult> {
  const maxIterations = config.maxIterations ?? 10;
  const currentDepth = config.currentDepth ?? 0;
  const maxSubAgentDepth = config.maxSubAgentDepth ?? 2;
  const useFunctionCalling = config.useFunctionCalling ?? true;
  const subAgentHistory = config.subAgentHistory ?? [];
  const executor = config.toolExecutor ?? await getDefaultExecutor();

  const progress = (msg: string) => {
    config.onProgress?.(msg);
    Logger.debug(`agentic-loop[d${currentDepth}]: ${msg}`);
  };

  // Event bus helpers
  const bus = getGlobalEventBus();
  const loopId = uuidv4();
  const loopMeta: EventMetadata = {
    sessionId: config.sessionId,
    orchestrationId: loopId,
    sourceModule: 'recursive',
  };
  const emitLoop = (type: string, extra: Record<string, unknown>, publishToRedis = false) =>
    bus.emit(type, { loopId, ...extra }, loopMeta, publishToRedis ? { publishToRedis: true } : undefined);

  // Build available tools list — all tools by default (kemdicode-mcp tools are read-only/internal)
  let availableTools: string[] | undefined = config.allowedTools?.length
    ? [...config.allowedTools]
    : undefined; // undefined = all tools

  // Auto-add cognitive tools when enableCognition is set and explicit allowlist is used
  if (config.enableCognition && availableTools) {
    const cognitiveNames = config.cognitiveTools ?? COGNITIVE_TOOL_NAMES;
    for (const name of cognitiveNames) {
      if (!availableTools.includes(name)) {
        availableTools.push(name);
      }
    }
  }

  // Filter out blocked tools
  if (config.blockedTools?.length && availableTools) {
    const blocked = new Set(config.blockedTools);
    availableTools = availableTools.filter((t) => !blocked.has(t));
  }

  // Register orchestration in Redis for live monitoring
  await registerOrchestration(loopId);
  await updateOrchStatus(loopId, {
    id: loopId,
    parentOrchestrationId: config.parentOrchestrationId,
    sessionId: config.sessionId,
    agent: config.agent,
    task: config.task.slice(0, 500),
    status: 'running',
    iteration: 0,
    maxIterations,
    depth: currentDepth,
    startedAt: Date.now(),
    toolCallsTotal: 0,
  });

  // Emit loop:started
  emitLoop('loop:started', {
    task: config.task.slice(0, 200),
    agent: config.agent,
    maxIterations,
    depth: currentDepth,
    orchestrationId: loopId,
  }, true);

  const startTime = Date.now();
  let result: AgenticLoopResult;

  // Choose mode: native function calling or text-based
  if (useFunctionCalling && executor.getDefinitions) {
    progress('Using native function calling mode');
    result = await executeWithFunctionCalling(
      config, executor, availableTools, maxIterations, currentDepth, maxSubAgentDepth, subAgentHistory,
      progress, emitLoop, loopId,
    );
  } else {
    progress('Using text-based parsing mode');
    result = await executeWithTextParsing(
      config, executor, availableTools, maxIterations, currentDepth, maxSubAgentDepth, subAgentHistory,
      progress, emitLoop, loopId,
    );
  }

  // Emit loop:completed
  emitLoop('loop:completed', {
    iterations: result.iterations,
    stopReason: result.stopReason,
    duration: Date.now() - startTime,
    success: result.completed,
    orchestrationId: loopId,
  }, true);

  // Update final status in Redis
  await updateOrchStatus(loopId, {
    status: result.completed ? 'completed' : 'error',
    iteration: result.iterations,
    stopReason: result.stopReason,
    answer: result.answer?.slice(0, 1000),
    toolCallsTotal: result.log.reduce((sum, i) => sum + i.toolCalls.length, 0),
  });
  await unregisterOrchestration(loopId);

  return { ...result, orchestrationId: loopId };
}
