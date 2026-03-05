/**
 * KemdiCode MCP Server - Tool Annotations Map v3.0.0
 * Copyright (C) 2025-2026 Kemdi Sp. z o.o. (Dawid Irzyk <dawid@kemdi.pl>)
 *
 * Maps all tools to MCP-level annotations (readOnlyHint, destructiveHint, etc.)
 * These annotations help LLMs understand tool safety characteristics.
 *
 * v3.0.0: 39 tools removed (file/git/edit/project/symbol/code-nav/AI-specialized)
 *
 * @license GPL-3.0
 * @module tools/annotations-map
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

  // Kanban read-only
  'task-get':          { title: 'Get Task',           readOnlyHint: true },
  'task-list':         { title: 'List Tasks',         readOnlyHint: true },
  'board-status':      { title: 'Board Status',       readOnlyHint: true },
  'board-list':        { title: 'List Boards',        readOnlyHint: true },
  'workspace-list':    { title: 'List Workspaces',    readOnlyHint: true },

  // Agent read-only
  'agent-list':        { title: 'List Agents',        readOnlyHint: true },
  'agent-history':     { title: 'Agent History',      readOnlyHint: true },
  'invocation-log':    { title: 'Invocation Log',     readOnlyHint: true },
  'agent-rank':        { title: 'Agent Rankings',     readOnlyHint: true },

  // Session read-only
  'session-list':      { title: 'List Sessions',      readOnlyHint: true },
  'session-info':      { title: 'Session Info',       readOnlyHint: true },

  // Memory read-only
  'read-memory':       { title: 'Read Memory',        readOnlyHint: true },
  'list-memories':     { title: 'List Memories',      readOnlyHint: true },

  // Cognition read-only
  'context-budget':    { title: 'Context Budget',     readOnlyHint: true },

  // RL read-only
  'rl-reward-stats':   { title: 'RL Reward Stats',    readOnlyHint: true },
  'rl-dopamine-log':   { title: 'RL Dopamine Log',    readOnlyHint: true },

  // Loci read-only
  'graph-query':       { title: 'Graph Query',        readOnlyHint: true },
  'graph-find-path':   { title: 'Graph Find Path',    readOnlyHint: true },
  'loci-recall':       { title: 'Loci Recall',        readOnlyHint: true },
  'sequence-recommend': { title: 'Sequence Recommend', readOnlyHint: true },

  // Multi-LLM (read-only - only makes API calls, no state change)
  'multi-prompt':      { title: 'Multi-Prompt',       readOnlyHint: true, openWorldHint: true },
  'enhance-prompt':    { title: 'Enhance Prompt',     readOnlyHint: true, openWorldHint: true },
  'consensus-prompt':  { title: 'Consensus Prompt',   readOnlyHint: true, openWorldHint: true },

  // MPC read-only
  'mpc-status':        { title: 'MPC Status',         readOnlyHint: true },

  // Client capabilities
  'client-roots':      { title: 'Client Roots',       readOnlyHint: true },

  // Cluster Bus read-only
  'cluster-bus-status':    { title: 'Cluster Bus Status',    readOnlyHint: true },
  'cluster-bus-topology':  { title: 'Cluster Bus Topology',  readOnlyHint: true },
  'cluster-bus-inspect':   { title: 'Cluster Bus Inspect',   readOnlyHint: true },

  // ─── Mutating (Non-Destructive) Tools ──────────────────────────────────────
  // AI tools
  'ask-ai':            { title: 'Ask AI',             readOnlyHint: true, openWorldHint: true },
  'plan':              { title: 'Plan',               readOnlyHint: true, openWorldHint: true },
  'build':             { title: 'Build',              openWorldHint: true },
  'brainstorm':        { title: 'Brainstorm',         readOnlyHint: true, openWorldHint: true },
  'write-tests':       { title: 'Write Tests',        openWorldHint: true },

  // Kanban mutation
  'task-create':       { title: 'Create Task',        destructiveHint: false },
  'task-update':       { title: 'Update Task',        destructiveHint: false },
  'task-claim':        { title: 'Claim Task',         destructiveHint: false },
  'task-assign':       { title: 'Assign Task',        destructiveHint: false },
  'task-comment':      { title: 'Add Comment',        destructiveHint: false },
  'task-push-multi':   { title: 'Push Task Multi',    destructiveHint: false },
  'task-cluster':      { title: 'Task Clustering',    destructiveHint: false, openWorldHint: true },
  'task-subtask':      { title: 'Task Subtask',       destructiveHint: false },
  'task-complexity':   { title: 'Task Complexity',    readOnlyHint: true, openWorldHint: true },
  'board-create':      { title: 'Create Board',       destructiveHint: false },
  'board-share':       { title: 'Share Board',        destructiveHint: false },
  'board-members':     { title: 'Board Members',      destructiveHint: false },
  'board-invite':      { title: 'Invite to Board',    destructiveHint: false },
  'board-workflow':    { title: 'Board Workflow',      destructiveHint: false },
  'workspace-create':  { title: 'Create Workspace',   destructiveHint: false },
  'workspace-join':    { title: 'Join Workspace',     destructiveHint: false },

  // Memory mutation
  'write-memory':      { title: 'Write Memory',       destructiveHint: false },
  'edit-memory':       { title: 'Edit Memory',        destructiveHint: false },
  'checkpoint-save':   { title: 'Save Checkpoint',    destructiveHint: false },
  'checkpoint-restore': { title: 'Restore Checkpoint', destructiveHint: false },
  'checkpoint-diff':   { title: 'Checkpoint Diff',    readOnlyHint: true },

  // Cognition mutation
  'decision-journal':  { title: 'Decision Journal',   destructiveHint: false },
  'confidence-tracker': { title: 'Confidence Tracker', destructiveHint: false },
  'mental-model':      { title: 'Mental Model',       destructiveHint: false },
  'intent-tracker':    { title: 'Intent Tracker',     destructiveHint: false },
  'error-pattern':     { title: 'Error Pattern',      destructiveHint: false },
  'self-critique':     { title: 'Self Critique',      destructiveHint: false },
  'smart-handoff':     { title: 'Smart Handoff',      destructiveHint: false },

  // Agent mutation
  'agent-register':    { title: 'Register Agent',     destructiveHint: false },
  'agent-alert':       { title: 'Alert Agent',        destructiveHint: false },
  'agent-inject':      { title: 'Inject Context',     destructiveHint: false },
  'agent-summary':     { title: 'Agent Summary',      destructiveHint: false },
  'queue-message':     { title: 'Queue Message',      destructiveHint: false },
  'monitor':           { title: 'Monitor',            readOnlyHint: true },
  'agent-orchestrate': { title: 'Orchestrate Agent',  openWorldHint: true },
  'agent-init':        { title: 'Agent Init',         destructiveHint: false },

  // Session mutation
  'session-create':    { title: 'Create Session',     destructiveHint: false },
  'session-switch':    { title: 'Switch Session',     destructiveHint: false },
  'session-recover':   { title: 'Recover Session',    destructiveHint: false },

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

  // MPC mutation
  'mpc-split':         { title: 'MPC Split',          destructiveHint: false },
  'mpc-distribute':    { title: 'MPC Distribute',     destructiveHint: false },
  'mpc-reconstruct':   { title: 'MPC Reconstruct',    destructiveHint: false },

  // Cluster Bus mutation
  'cluster-bus-send':       { title: 'Cluster Bus Send',       destructiveHint: false, openWorldHint: true },
  'cluster-bus-magistrale': { title: 'Cluster Bus Magistrale', destructiveHint: false, openWorldHint: true },
  'cluster-bus-flow':       { title: 'Cluster Bus Flow',       destructiveHint: false },
  'cluster-bus-routing':    { title: 'Cluster Bus Routing',    destructiveHint: false },

  // ─── Destructive Tools ─────────────────────────────────────────────────────
  'task-delete':       { title: 'Delete Task',        destructiveHint: true },
  'board-delete':      { title: 'Delete Board',       destructiveHint: true },
  'workspace-delete':  { title: 'Delete Workspace',   destructiveHint: true },
  'workspace-leave':   { title: 'Leave Workspace',    destructiveHint: true },
  'session-delete':    { title: 'Delete Session',     destructiveHint: true },
  'delete-memory':     { title: 'Delete Memory',      destructiveHint: true },
};

/**
 * Get annotations for a tool by name.
 * Returns undefined if no annotations are defined.
 */
export function getToolAnnotations(toolName: string): ToolAnnotations | undefined {
  return TOOL_ANNOTATIONS[toolName];
}
