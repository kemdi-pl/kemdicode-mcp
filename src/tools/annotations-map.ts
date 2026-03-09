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

import type { ToolAnnotations } from './registry.js';

/**
 * Default annotations for all registered tools.
 * Tools not listed here default to: { readOnlyHint: false, destructiveHint: false }
 */
export const TOOL_ANNOTATIONS: Record<string, ToolAnnotations> = {
  // ─── Read-Only Tools ────────────────────────────────────────────────────────
  // Code intelligence (read-only, kept: AST + semantic)
  'find-definition':   { title: 'Find Definition',   readOnlyHint: true },
  'find-references':   { title: 'Find References',   readOnlyHint: true },
  'semantic-search':   { title: 'Semantic Search',    readOnlyHint: true, openWorldHint: true },

  // System read-only
  'env-info':          { title: 'Environment Info',   readOnlyHint: true },
  'memory-usage':      { title: 'Memory Usage',       readOnlyHint: true },
  'ping':              { title: 'Health Check',        readOnlyHint: true },
  'help':              { title: 'Help',                readOnlyHint: true },
  'tool-health':       { title: 'Tool Health',        readOnlyHint: true },

  // Context read-only
  'get-shared-context': { title: 'Get Shared Context', readOnlyHint: true },

  // Kanban consolidated (action-based, contain both read and write actions)
  'task':              { title: 'Task Management',    destructiveHint: false },
  'task-multi':        { title: 'Task Bulk Ops',      destructiveHint: false, openWorldHint: true },
  'board':             { title: 'Board Management',   destructiveHint: false },
  'workspace':         { title: 'Workspace Management', destructiveHint: false },

  // Agent (consolidated)
  'agent':             { title: 'Agent',              destructiveHint: false },
  'agent-comm':        { title: 'Agent Communication', destructiveHint: false },
  'invocation-log':    { title: 'Invocation Log',     readOnlyHint: true },

  // Session (consolidated action-based tool)
  'session':           { title: 'Session',             destructiveHint: false },

  // Memory (consolidated — mixed read/write depending on action)
  'memory':            { title: 'Memory',             destructiveHint: false },
  'checkpoint':        { title: 'Checkpoint',         destructiveHint: false },

  // Cognition read-only
  'context-budget':    { title: 'Context Budget',     readOnlyHint: true },

  // Loci read-only
  'graph-query':       { title: 'Graph Query',        readOnlyHint: true },
  'graph-find-path':   { title: 'Graph Find Path',    readOnlyHint: true },
  'sequence-recommend': { title: 'Sequence Recommend', readOnlyHint: true },

  // Multi-LLM (read-only - only makes API calls, no state change)
  'multi-prompt':      { title: 'Multi-Prompt',       readOnlyHint: true, openWorldHint: true },
  'enhance-prompt':    { title: 'Enhance Prompt',     readOnlyHint: true, openWorldHint: true },
  'consensus-prompt':  { title: 'Consensus Prompt',   readOnlyHint: true, openWorldHint: true },
  'mind-chain':        { title: 'Mind Chain',         readOnlyHint: true, openWorldHint: true },

  // MPC read-only
  'mpc-status':        { title: 'MPC Status',         readOnlyHint: true },

  // Client capabilities
  'client-roots':      { title: 'Client Roots',       readOnlyHint: true },

  // Cluster Bus read-only
  'cluster-bus-status':    { title: 'Cluster Bus Status',    readOnlyHint: true },
  'cluster-bus-inspect':   { title: 'Cluster Bus Inspect',   readOnlyHint: true },
  'cluster-bus-file-read': { title: 'Cluster Bus File Read', readOnlyHint: true, openWorldHint: true },

  // ─── Mutating (Non-Destructive) Tools ──────────────────────────────────────
  // AI tools
  'ask-ai':            { title: 'Ask AI',             readOnlyHint: true, openWorldHint: true },
  'plan':              { title: 'Plan',               readOnlyHint: true, openWorldHint: true },
  'build':             { title: 'Build',              openWorldHint: true },
  'brainstorm':        { title: 'Brainstorm',         readOnlyHint: true, openWorldHint: true },
  // Kanban mutation — consolidated into 'task', 'task-multi', 'board', 'workspace' (see read-only section)

  // Memory mutation (consolidated into 'memory' and 'checkpoint' — see read-only section)

  // Cognition mutation
  'decision-journal':  { title: 'Decision Journal',   destructiveHint: false },
  'confidence-tracker': { title: 'Confidence Tracker', destructiveHint: false },
  'mental-model':      { title: 'Mental Model',       destructiveHint: false },
  'intent-tracker':    { title: 'Intent Tracker',     destructiveHint: false },
  'error-pattern':     { title: 'Error Pattern',      destructiveHint: false },
  'self-critique':     { title: 'Self Critique',      destructiveHint: false },
  'smart-handoff':     { title: 'Smart Handoff',      destructiveHint: false },

  // Agent mutation (monitor kept as-is, agent/agent-comm in read-only section)
  'monitor':           { title: 'Monitor',            readOnlyHint: true },
  'agent-orchestrate': { title: 'Orchestrate Agent',  openWorldHint: true },


  // Thinking
  'thinking-chain':    { title: 'Thinking Chain',     destructiveHint: false },

  // Context mutation
  'shared-thoughts':   { title: 'Shared Thoughts',    destructiveHint: false },
  'feedback':          { title: 'Feedback Loop',      destructiveHint: false },

  // System config mutation
  'ai-config':         { title: 'AI Config',          destructiveHint: false },
  'ai-models':         { title: 'AI Models',          readOnlyHint: true, openWorldHint: true },
  'config':            { title: 'Configuration',      destructiveHint: false },

  // Recursive tools
  'invoke-tool':       { title: 'Invoke Tool',        destructiveHint: false },
  'invoke-batch':      { title: 'Invoke Batch',       destructiveHint: false },

  // Pipeline
  'pipeline':          { title: 'Pipeline',           destructiveHint: false },
  'batch':             { title: 'Batch Operations',   destructiveHint: false },

  // Client capabilities
  'client-sampling':   { title: 'Client Sampling',    readOnlyHint: true, openWorldHint: true },
  'client-elicit':     { title: 'Client Elicit',      readOnlyHint: true },

  // Loci mutation
  'loci-recall':       { title: 'Loci Recall',        destructiveHint: false },

  // Cluster Bus mutation
  'cluster-bus-topology':  { title: 'Cluster Bus Topology',  destructiveHint: false },
  'cluster-bus-send':       { title: 'Cluster Bus Send',       destructiveHint: false, openWorldHint: true },
  'cluster-bus-magistrale': { title: 'Cluster Bus Magistrale', destructiveHint: false, openWorldHint: true },
  'cluster-bus-flow':       { title: 'Cluster Bus Flow',       destructiveHint: false },
  'cluster-bus-routing':    { title: 'Cluster Bus Routing',    destructiveHint: false },
  'audit-scheduler':        { title: 'Audit Scheduler',        destructiveHint: false, openWorldHint: true },

  // ─── Destructive Tools ─────────────────────────────────────────────────────
  // task-delete, board-delete, workspace-delete, workspace-leave consolidated into action-based tools above
};

/**
 * Get annotations for a tool by name.
 * Returns undefined if no annotations are defined.
 */
export function getToolAnnotations(toolName: string): ToolAnnotations | undefined {
  return TOOL_ANNOTATIONS[toolName];
}
