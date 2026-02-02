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
import { getAgentMaxTokens, getAgentTemperature, type AgentType } from '../ai/agents.js';
import { Logger } from '../utils/logger.js';
import { getGlobalEventBus } from '../events/global-bus.js';
import type { EventMetadata } from '../events/types.js';

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

  /** Progress callback */
  onProgress?: (message: string) => void;

  /** Injected tool executor (DI) */
  toolExecutor?: ToolExecutor;
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
 * Default-deny safe tools list.
 * When allowedTools is not explicitly configured, only these read-only,
 * non-destructive tools are available to agents.
 */
const SAFE_TOOLS: readonly string[] = [
  // Read-only code analysis
  'code-review', 'explain-code', 'find-definition', 'find-references',
  'find-symbols', 'semantic-search', 'code-outline', 'analyze-deps',
  // Read-only file operations
  'file-read', 'file-search', 'file-tree', 'file-diff',
  // Read-only project info
  'project-info', 'env-info', 'help', 'ping',
  // Read-only git
  'git-status', 'git-diff', 'git-log', 'git-blame',
  // Read-only memory
  'read-memory', 'list-memories',
  // Read-only session/context
  'session-info', 'session-list', 'get-shared-context', 'shared-thoughts',
  // AI tools (non-destructive)
  'ask-ai', 'brainstorm', 'multi-prompt', 'consensus-prompt',
  // Cognition (read + record)
  'decision-journal', 'confidence-tracker', 'mental-model', 'intent-tracker',
  'error-pattern', 'self-critique', 'context-budget',
  // Kanban read
  'task-list', 'task-get', 'board-status',
  // Thinking
  'thinking-chain',
] as const;

/**
 * Global sub-agent budget to prevent fork-bomb resource exhaustion.
 * Shared across all loops in the same process.
 */
let globalSubAgentCount = 0;
const MAX_TOTAL_SUB_AGENTS = 10;

function acquireSubAgentSlot(): boolean {
  if (globalSubAgentCount >= MAX_TOTAL_SUB_AGENTS) return false;
  globalSubAgentCount++;
  return true;
}

function releaseSubAgentSlot(): void {
  if (globalSubAgentCount > 0) globalSubAgentCount--;
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
  let match: RegExpExecArray | null;

  TOOL_CALL_REGEX.lastIndex = 0;
  while ((match = TOOL_CALL_REGEX.exec(response)) !== null) {
    try {
      const raw = JSON.parse(match[1]);
      // Sanitize to prevent prototype pollution from AI-generated JSON
      const parsed = sanitizeParsedJSON(raw) as Record<string, unknown>;
      if (parsed.tool && typeof parsed.tool === 'string') {
        calls.push({
          tool: parsed.tool as string,
          args: (parsed.args || {}) as Record<string, unknown>,
          id: (parsed.id as string) || uuidv4(),
        });
      }
    } catch {
      Logger.warn(`agentic-loop: failed to parse tool-call block: ${match[1].slice(0, 100)}`);
    }
  }

  return calls;
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
    const { executeTool, getToolDefinitions } = await import('../tools/registry.js');
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

function buildFunctionCallingPrompt(config: AgenticLoopConfig): string {
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

  return `You are an autonomous tool-calling agent. You MUST use the provided tools to gather information — NEVER guess or make up answers.

Call the tools you need. You will receive the results and can continue calling more tools.
When you have enough information, respond with your final answer in plain text (no tool calls).
${cognitiveSection}${subAgentInstr}

## Rules
- ALWAYS call tools to gather information — never fabricate results.
- Be thorough but efficient.
- When done, respond with your final answer as plain text.
- NEVER write truncated content to files. If a file-read result was truncated, re-read it with a smaller line range.
- When using file-write, ALWAYS write the COMPLETE file content — never include "... (truncated" markers.`;
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
  'file-read', 'file-write', 'file-search', 'file-diff', 'file-copy',
  'code-review', 'explain-code', 'find-definition', 'find-references',
  'find-symbols', 'code-outline',
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

/** Max messages in conversation history before pruning older turns (env: MCP_MAX_HISTORY_MESSAGES, default: 80) */
const MAX_HISTORY_MESSAGES = envInt('MCP_MAX_HISTORY_MESSAGES', 80);

/**
 * Prune conversation history to prevent unbounded memory growth.
 * Keeps the system message (index 0), the initial user message (index 1),
 * and the most recent messages up to the limit.
 */
function pruneMessages(messages: Message[], limit: number): void {
  if (messages.length <= limit) return;
  // Keep first 2 messages (system + initial task) and the latest (limit - 2)
  const keep = limit - 2;
  const toRemove = messages.length - 2 - keep;
  if (toRemove > 0) {
    messages.splice(2, toRemove);
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
    const result = await executor.execute(call.tool, call.args);
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
): Promise<AgenticLoopResult> {
  const startTime = Date.now();
  const log: IterationResult[] = [];
  const subAgentResults: AgenticLoopResult['subAgentResults'] = [];

  // Build function tools from definitions
  const functionTools = buildFunctionTools(executor, availableTools, config.blockedTools);
  progress(`Function calling mode: ${functionTools.length} tools available`);

  // Build system prompt
  const systemPrompt = buildFunctionCallingPrompt(config);

  // Multi-turn message history
  const messages: Message[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `## Your Task\n\n${config.task}` },
  ];

  let lastAnswer = '';
  let stopReason: AgenticLoopResult['stopReason'] = 'max_iterations';

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    progress(`Iteration ${iteration}/${maxIterations}`);
    emitLoop?.('loop:iteration', { iteration, maxIterations });

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

        // Add tool result message to conversation
        messages.push({
          role: 'tool',
          content: result.result,
          toolCallId: tc.id,
        });
      }

      log.push(iterationLog);

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
              onProgress: (msg) => progress(`  [sub-agent] ${msg}`),
              subAgentHistory: updatedHistory,
            });

            subAgentResults.push({
              task: req.task,
              answer: subResult.answer,
              iterations: subResult.iterations,
            });

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

  return {
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
): Promise<AgenticLoopResult> {
  const startTime = Date.now();
  const log: IterationResult[] = [];
  const subAgentResults: AgenticLoopResult['subAgentResults'] = [];

  // Build orchestrator system instructions
  const orchestratorPrompt = buildTextModePrompt(config, availableTools);

  // Conversation state: accumulate tool results as context
  let conversationContext = '';
  let lastAnswer = '';
  let stopReason: AgenticLoopResult['stopReason'] = 'max_iterations';

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    progress(`Iteration ${iteration}/${maxIterations}`);
    emitLoop?.('loop:iteration', { iteration, maxIterations });

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
      conversationContext += `\n[${call.tool}] (${result.duration}ms):\n${result.result}\n`;
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

          conversationContext += `\n[sub-agent: ${req.task.slice(0, 40)}] Result:\n${subResult.answer.slice(0, SUB_AGENT_ANSWER_LIMIT)}\n`;
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
    sourceModule: 'recursive',
  };
  const emitLoop = (type: string, extra: Record<string, unknown>, publishToRedis = false) =>
    bus.emit(type, { loopId, ...extra }, loopMeta, publishToRedis ? { publishToRedis: true } : undefined);

  // Build available tools list — DEFAULT-DENY policy
  // When allowedTools is not explicitly set, only safe read-only tools are available.
  // This prevents agents from accessing file-write, file-delete etc. by default.
  let availableTools: string[];
  if (config.allowedTools?.length) {
    availableTools = [...config.allowedTools];
  } else {
    availableTools = [...SAFE_TOOLS];
    Logger.debug(`agentic-loop: default-deny policy applied, ${availableTools.length} safe tools available`);
  }

  // Auto-add cognitive tools when enableCognition is set
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

  // Emit loop:started
  emitLoop('loop:started', {
    task: config.task.slice(0, 200),
    agent: config.agent,
    maxIterations,
    depth: currentDepth,
  }, true);

  const startTime = Date.now();
  let result: AgenticLoopResult;

  // Choose mode: native function calling or text-based
  if (useFunctionCalling && executor.getDefinitions) {
    progress('Using native function calling mode');
    result = await executeWithFunctionCalling(
      config, executor, availableTools, maxIterations, currentDepth, maxSubAgentDepth, subAgentHistory,
      progress, emitLoop,
    );
  } else {
    progress('Using text-based parsing mode');
    result = await executeWithTextParsing(
      config, executor, availableTools, maxIterations, currentDepth, maxSubAgentDepth, subAgentHistory,
      progress, emitLoop,
    );
  }

  // Emit loop:completed
  emitLoop('loop:completed', {
    iterations: result.iterations,
    stopReason: result.stopReason,
    duration: Date.now() - startTime,
    success: result.completed,
  }, true);

  return result;
}
