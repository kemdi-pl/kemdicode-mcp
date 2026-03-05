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

import { registerLazyTool } from './registry.js';

/**
 * Lazy Tool Loader Registry — v3.0.0 "Lorenz"
 *
 * 39 tools removed (file/git/edit/project/symbol/code-nav/AI-specialized).
 * IDE AI (Claude Code, Cursor, etc.) provides native equivalents.
 * Internal helpers (utils/file-utils.ts, git-utils.ts) are preserved.
 */

// ─── Core AI Tools ──────────────────────────────────────────────────────────
registerLazyTool({
  name: 'ask-ai',
  description: 'Direct AI API call with full control over model, prompt, and options',
  loader: () => import('./ask-ai.tool.js').then((m) => m.askAITool),
});
registerLazyTool({
  name: 'plan',
  description: 'Deep analysis and planning mode using the plan agent',
  loader: () => import('./simple-tools.js').then((m) => m.planTool),
});
registerLazyTool({
  name: 'build',
  description: 'Immediate code execution mode using the build agent',
  loader: () => import('./simple-tools.js').then((m) => m.buildTool),
});
registerLazyTool({
  name: 'brainstorm',
  description: 'Creative ideation using SCAMPER and Design Thinking methodologies',
  loader: () => import('./brainstorm.tool.js').then((m) => m.brainstormTool),
});
registerLazyTool({
  name: 'batch',
  description: 'Execute multiple tools in parallel for efficient multi-operation workflows',
  loader: () => import('./batch.tool.js').then((m) => m.batchTool),
});
registerLazyTool({
  name: 'pipeline',
  description: 'Sequential tool execution pipeline with step output interpolation',
  loader: () => import('./pipeline.tool.js').then((m) => m.pipelineTool),
});

// ─── Specialized AI (kept: write-tests only) ────────────────────────────────
registerLazyTool({
  name: 'write-tests',
  description: 'Generate unit tests for code using AI',
  loader: () => import('./specialized/index.js').then((m) => m.writeTestsTool),
});

// ─── Context Sharing & Learning ─────────────────────────────────────────────
registerLazyTool({
  name: 'get-shared-context',
  description: 'Retrieve shared context from other MCP servers',
  loader: () => import('./context/index.js').then((m) => m.getSharedContextTool),
});
registerLazyTool({
  name: 'feedback',
  description: 'Record and retrieve feedback for learning loops',
  loader: () => import('./context/index.js').then((m) => m.feedbackTool),
});
registerLazyTool({
  name: 'shared-thoughts',
  description: 'Access collective knowledge base from all agents',
  loader: () => import('./context/index.js').then((m) => m.sharedThoughtsTool),
});

// ─── Agent Monitoring & Supervision ─────────────────────────────────────────
registerLazyTool({
  name: 'agent-list',
  description: 'List all active agents in the system',
  loader: () => import('./agents/index.js').then((m) => m.agentListTool),
});
registerLazyTool({
  name: 'agent-register',
  description: 'Register one or more agents (batch: 1-20)',
  loader: () => import('./agents/index.js').then((m) => m.agentRegisterTool),
});
registerLazyTool({
  name: 'agent-alert',
  description: 'Send alerts to specific agents or broadcast',
  loader: () => import('./agents/index.js').then((m) => m.agentAlertTool),
});
registerLazyTool({
  name: 'agent-inject',
  description: 'Inject context or directives into running agents',
  loader: () => import('./agents/index.js').then((m) => m.agentInjectTool),
});
registerLazyTool({
  name: 'agent-history',
  description: 'View message history for an agent',
  loader: () => import('./agents/index.js').then((m) => m.agentHistoryTool),
});
registerLazyTool({
  name: 'monitor',
  description: 'Session monitoring with multiple views (overview/agents/tasks/hierarchy/activity)',
  loader: () => import('./agents/index.js').then((m) => m.monitorTool),
});
registerLazyTool({
  name: 'agent-summary',
  description: 'Update agent summaries (batch: 1-20)',
  loader: () => import('./agents/index.js').then((m) => m.agentSummaryTool),
});
registerLazyTool({
  name: 'queue-message',
  description: 'Queue messages to agents with priority (batch: 1-20, supports broadcast)',
  loader: () => import('./agents/index.js').then((m) => m.queueMessageTool),
});
registerLazyTool({
  name: 'agent-init',
  description:
    'One-call agent onboarding: register, list tasks, auto-claim, set intent, record confidence',
  loader: () => import('./agents/index.js').then((m) => m.agentInitTool),
});

// ─── Code Intelligence (kept: AST + semantic) ───────────────────────────────
registerLazyTool({
  name: 'find-definition',
  description: 'Find symbol definitions using Tree-sitter AST',
  loader: () => import('./code/index.js').then((m) => m.findDefinitionTool),
});
registerLazyTool({
  name: 'find-references',
  description: 'Find all usages of a symbol across codebase',
  loader: () => import('./code/index.js').then((m) => m.findReferencesTool),
});
registerLazyTool({
  name: 'semantic-search',
  description: 'AI-powered semantic code search',
  loader: () => import('./code/index.js').then((m) => m.semanticSearchTool),
});

// ─── System Tools ───────────────────────────────────────────────────────────
registerLazyTool({
  name: 'env-info',
  description: 'Get environment information (Node.js version, OS, etc.)',
  loader: () => import('./system/index.js').then((m) => m.envInfoTool),
});
registerLazyTool({
  name: 'memory-usage',
  description: 'Get memory usage statistics',
  loader: () => import('./system/index.js').then((m) => m.memoryUsageTool),
});
registerLazyTool({
  name: 'config',
  description: 'View or update server configuration',
  loader: () => import('./system/index.js').then((m) => m.configTool),
});
registerLazyTool({
  name: 'ping',
  description: 'Health check endpoint',
  loader: () => import('./simple-tools.js').then((m) => m.pingTool),
});
registerLazyTool({
  name: 'help',
  description: 'Get help information about available tools',
  loader: () => import('./simple-tools.js').then((m) => m.helpTool),
});
registerLazyTool({
  name: 'tool-health',
  description: 'Check availability of all tools including AI provider status',
  loader: () => import('./system/tool-health.tool.js').then((m) => m.toolHealthTool),
});
registerLazyTool({
  name: 'ai-config',
  description: 'Manage AI provider settings and API keys',
  loader: () => import('./system/ai-config.tool.js').then((m) => m.aiConfigTool),
});
registerLazyTool({
  name: 'ai-models',
  description: 'List and select AI models from provider',
  loader: () => import('./system/ai-models.tool.js').then((m) => m.aiModelsTool),
});

// ─── MPC (Multi-Party Computation) ──────────────────────────────────────────
registerLazyTool({
  name: 'mpc-split',
  description: 'Split secret into MPC shares',
  loader: () => import('./mpc/index.js').then((m) => m.mpcSplitTool),
});
registerLazyTool({
  name: 'mpc-distribute',
  description: 'Distribute MPC shares to agents',
  loader: () => import('./mpc/index.js').then((m) => m.mpcDistributeTool),
});
registerLazyTool({
  name: 'mpc-reconstruct',
  description: 'Reconstruct secret from MPC shares',
  loader: () => import('./mpc/index.js').then((m) => m.mpcReconstructTool),
});
registerLazyTool({
  name: 'mpc-status',
  description: 'Get status of MPC operations',
  loader: () => import('./mpc/index.js').then((m) => m.mpcStatusTool),
});

// ─── RL (Reinforcement Learning) ────────────────────────────────────────────
registerLazyTool({
  name: 'rl-reward-stats',
  description: 'Get reinforcement learning reward statistics',
  loader: () => import('./rl/index.js').then((m) => m.rlRewardStatsTool),
});
registerLazyTool({
  name: 'rl-dopamine-log',
  description: 'View dopamine (reward) event log',
  loader: () => import('./rl/index.js').then((m) => m.rlDopamineLogTool),
});

// ─── Loci / Knowledge Graph ─────────────────────────────────────────────────
registerLazyTool({
  name: 'graph-query',
  description: 'Query the knowledge graph',
  loader: () => import('./loci/index.js').then((m) => m.graphQueryTool),
});
registerLazyTool({
  name: 'graph-find-path',
  description: 'Find path between nodes in knowledge graph',
  loader: () => import('./loci/index.js').then((m) => m.graphFindPathTool),
});
registerLazyTool({
  name: 'loci-recall',
  description:
    'Recall memories, view timeline events, resurrect context after compaction, or link sessions',
  loader: () => import('./loci/index.js').then((m) => m.lociRecallTool),
});
registerLazyTool({
  name: 'sequence-recommend',
  description: 'Recommend next tool in sequence based on history',
  loader: () => import('./loci/index.js').then((m) => m.sequenceRecommendTool),
});

// ─── Project Memory ─────────────────────────────────────────────────────────
registerLazyTool({
  name: 'write-memory',
  description: 'Store named memory with tags and TTL',
  loader: () => import('./memory/index.js').then((m) => m.writeMemoryTool),
});
registerLazyTool({
  name: 'read-memory',
  description: 'Retrieve memory by name',
  loader: () => import('./memory/index.js').then((m) => m.readMemoryTool),
});
registerLazyTool({
  name: 'list-memories',
  description: 'List all project memories with filters',
  loader: () => import('./memory/index.js').then((m) => m.listMemoriesTool),
});
registerLazyTool({
  name: 'delete-memory',
  description: 'Delete a memory entry',
  loader: () => import('./memory/index.js').then((m) => m.deleteMemoryTool),
});
registerLazyTool({
  name: 'edit-memory',
  description: 'Modify memory content and tags',
  loader: () => import('./memory/index.js').then((m) => m.editMemoryTool),
});
registerLazyTool({
  name: 'checkpoint-save',
  description: 'Save temporary state snapshot to Redis (7-day TTL)',
  loader: () => import('./memory/index.js').then((m) => m.checkpointSaveTool),
});
registerLazyTool({
  name: 'checkpoint-restore',
  description: 'Restore a previously saved checkpoint',
  loader: () => import('./memory/index.js').then((m) => m.checkpointRestoreTool),
});
registerLazyTool({
  name: 'checkpoint-diff',
  description: 'Compare current files with saved checkpoint',
  loader: () => import('./memory/index.js').then((m) => m.checkpointDiffTool),
});

// ─── Kanban Tasks ───────────────────────────────────────────────────────────
registerLazyTool({
  name: 'task-create',
  description: 'Create tasks (batch: 1-20)',
  loader: () => import('./kanban/index.js').then((m) => m.taskCreateTool),
});
registerLazyTool({
  name: 'task-get',
  description: 'Get full task details by ID',
  loader: () => import('./kanban/index.js').then((m) => m.taskGetTool),
});
registerLazyTool({
  name: 'task-list',
  description: 'List tasks with filters (status, priority, assignee, boardId)',
  loader: () => import('./kanban/index.js').then((m) => m.taskListTool),
});
registerLazyTool({
  name: 'task-claim',
  description: 'Worker claims an available task',
  loader: () => import('./kanban/index.js').then((m) => m.taskClaimTool),
});
registerLazyTool({
  name: 'task-assign',
  description: 'Assign tasks to agents (batch: 1-20)',
  loader: () => import('./kanban/index.js').then((m) => m.taskAssignTool),
});
registerLazyTool({
  name: 'task-update',
  description: 'Update tasks (batch: 1-20)',
  loader: () => import('./kanban/index.js').then((m) => m.taskUpdateTool),
});
registerLazyTool({
  name: 'task-delete',
  description: 'Delete tasks (batch: 1-20)',
  loader: () => import('./kanban/index.js').then((m) => m.taskDeleteTool),
});
registerLazyTool({
  name: 'task-comment',
  description: 'Add comments to tasks (batch: 1-20, append-only)',
  loader: () => import('./kanban/index.js').then((m) => m.taskCommentTool),
});
registerLazyTool({
  name: 'board-status',
  description: 'Get board summary and statistics',
  loader: () => import('./kanban/index.js').then((m) => m.boardStatusTool),
});
registerLazyTool({
  name: 'task-push-multi',
  description: 'Push task to N agents (assign/clone/notify)',
  loader: () => import('./kanban/index.js').then((m) => m.taskPushMultiTool),
});
registerLazyTool({
  name: 'task-complexity',
  description: 'LLM-scored complexity analysis (1-10) with subtask recommendations',
  loader: () => import('./kanban/index.js').then((m) => m.taskComplexityTool),
});
registerLazyTool({
  name: 'task-cluster',
  description: 'LLM-driven task clustering: auto-group, context extraction, checklists, digests',
  loader: () => import('./kanban/index.js').then((m) => m.taskClusterTool),
});
registerLazyTool({
  name: 'task-subtask',
  description: 'Manage subtask hierarchies: create subtasks, list subtasks, promote to standalone',
  loader: () => import('./kanban/index.js').then((m) => m.taskSubtaskTool),
});

// ─── Kanban Workspaces ──────────────────────────────────────────────────────
registerLazyTool({
  name: 'workspace-create',
  description: 'Create workspace for cross-session collaboration',
  loader: () => import('./kanban/index.js').then((m) => m.workspaceCreateTool),
});
registerLazyTool({
  name: 'workspace-list',
  description: 'List available workspaces',
  loader: () => import('./kanban/index.js').then((m) => m.workspaceListTool),
});
registerLazyTool({
  name: 'workspace-join',
  description: 'Join session to workspace',
  loader: () => import('./kanban/index.js').then((m) => m.workspaceJoinTool),
});
registerLazyTool({
  name: 'workspace-leave',
  description: 'Leave workspace',
  loader: () => import('./kanban/index.js').then((m) => m.workspaceLeaveTool),
});
registerLazyTool({
  name: 'workspace-delete',
  description: 'Delete workspace (with ownership check, cascade option)',
  loader: () => import('./kanban/index.js').then((m) => m.workspaceDeleteTool),
});

// ─── Kanban Boards ──────────────────────────────────────────────────────────
registerLazyTool({
  name: 'board-create',
  description: 'Create new board in session or workspace',
  loader: () => import('./kanban/index.js').then((m) => m.boardCreateTool),
});
registerLazyTool({
  name: 'board-list',
  description: 'List boards (session + workspace)',
  loader: () => import('./kanban/index.js').then((m) => m.boardListTool),
});
registerLazyTool({
  name: 'board-share',
  description: 'Share board with session or workspace',
  loader: () => import('./kanban/index.js').then((m) => m.boardShareTool),
});
registerLazyTool({
  name: 'board-members',
  description: 'Manage board members',
  loader: () => import('./kanban/index.js').then((m) => m.boardMembersTool),
});
registerLazyTool({
  name: 'board-invite',
  description: 'Invite agent to board with role',
  loader: () => import('./kanban/index.js').then((m) => m.boardInviteTool),
});
registerLazyTool({
  name: 'board-delete',
  description: 'Delete board (with cascade task deletion option)',
  loader: () => import('./kanban/index.js').then((m) => m.boardDeleteTool),
});
registerLazyTool({
  name: 'board-workflow',
  description: 'Auto board switching: when all tasks on board are done, auto-advance to next board',
  loader: () => import('./kanban/index.js').then((m) => m.boardWorkflowTool),
});

// ─── Recursive Tool Invocation ──────────────────────────────────────────────
registerLazyTool({
  name: 'invoke-tool',
  description: 'Invoke MCP tool from agent context with safety checks',
  loader: () => import('./recursive/index.js').then((m) => m.invokeToolTool),
});
registerLazyTool({
  name: 'invoke-batch',
  description: 'Batch invoke multiple tools (parallel/sequential)',
  loader: () => import('./recursive/index.js').then((m) => m.invokeBatchTool),
});
registerLazyTool({
  name: 'invocation-log',
  description: 'View agent tool invocation history',
  loader: () => import('./recursive/index.js').then((m) => m.invocationLogTool),
});
registerLazyTool({
  name: 'agent-orchestrate',
  description: 'Launch autonomous AI agent loop: reasons → calls tools → iterates until done',
  loader: () => import('./recursive/index.js').then((m) => m.agentOrchestrateTool),
});

// ─── Session Management ─────────────────────────────────────────────────────
registerLazyTool({
  name: 'session-list',
  description: 'List all available sessions',
  loader: () => import('./session/index.js').then((m) => m.sessionListTool),
});
registerLazyTool({
  name: 'session-info',
  description: 'Get current session information',
  loader: () => import('./session/index.js').then((m) => m.sessionInfoTool),
});
registerLazyTool({
  name: 'session-create',
  description: 'Create a new session',
  loader: () => import('./session/index.js').then((m) => m.sessionCreateTool),
});
registerLazyTool({
  name: 'session-switch',
  description: 'Switch to a different session',
  loader: () => import('./session/index.js').then((m) => m.sessionSwitchTool),
});
registerLazyTool({
  name: 'session-delete',
  description: 'Delete a session and its data',
  loader: () => import('./session/index.js').then((m) => m.sessionDeleteTool),
});
registerLazyTool({
  name: 'session-recover',
  description: 'Comprehensive session recovery after compaction — restores all context in one call',
  loader: () => import('./session/session-recover.tool.js').then((m) => m.sessionRecoverTool),
});

// ─── Multi-LLM ──────────────────────────────────────────────────────────────
registerLazyTool({
  name: 'multi-prompt',
  description: 'Send same prompt to N models in parallel and collect responses',
  loader: () => import('./multi-llm/index.js').then((m) => m.multiPromptTool),
});
registerLazyTool({
  name: 'consensus-prompt',
  description: 'CEO-and-Board pattern: board models respond, CEO synthesizes decision',
  loader: () => import('./multi-llm/index.js').then((m) => m.consensusPromptTool),
});
registerLazyTool({
  name: 'enhance-prompt',
  description: 'Analyze and rewrite vague prompts into clear, actionable instructions',
  loader: () => import('./multi-llm/index.js').then((m) => m.enhancePromptTool),
});

// ─── Thinking Chain ─────────────────────────────────────────────────────────
registerLazyTool({
  name: 'thinking-chain',
  description: 'Manage chains of thought with branching and forward-only constraint',
  loader: () => import('./thinking/index.js').then((m) => m.thinkingChainTool),
});

// ─── Cognition (AI Self-Improvement) ────────────────────────────────────────
registerLazyTool({
  name: 'confidence-tracker',
  description: 'Track confidence levels to know when to ask humans for help',
  loader: () => import('./cognition/index.js').then((m) => m.confidenceTrackerTool),
});
registerLazyTool({
  name: 'decision-journal',
  description: 'Record decisions with reasoning, alternatives, and outcomes',
  loader: () => import('./cognition/index.js').then((m) => m.decisionJournalTool),
});
registerLazyTool({
  name: 'mental-model',
  description: 'Build and query persistent mental models of system architecture',
  loader: () => import('./cognition/index.js').then((m) => m.mentalModelTool),
});
registerLazyTool({
  name: 'error-pattern',
  description: 'Cross-session error pattern database for learning from mistakes',
  loader: () => import('./cognition/index.js').then((m) => m.errorPatternTool),
});
registerLazyTool({
  name: 'intent-tracker',
  description: "Track goal hierarchy to never lose the human's actual intent",
  loader: () => import('./cognition/index.js').then((m) => m.intentTrackerTool),
});
registerLazyTool({
  name: 'smart-handoff',
  description: 'Structured context transfer protocol for session handoffs',
  loader: () => import('./cognition/index.js').then((m) => m.smartHandoffTool),
});
registerLazyTool({
  name: 'self-critique',
  description: 'Post-session reflection and efficiency tracking',
  loader: () => import('./cognition/index.js').then((m) => m.selfCritiqueTool),
});
registerLazyTool({
  name: 'context-budget',
  description: 'Manage context window budget — decide what to keep vs evict',
  loader: () => import('./cognition/index.js').then((m) => m.contextBudgetTool),
});

// ─── Agent Ranking ──────────────────────────────────────────────────────────
registerLazyTool({
  name: 'agent-rank',
  description: 'View and manage agent performance rankings (bronze-to-diamond)',
  loader: () => import('./agents/agent-rank.tool.js').then((m) => m.agentRankTool),
});

// ─── MCP Client Capabilities ────────────────────────────────────────────────
registerLazyTool({
  name: 'client-sampling',
  description: 'Request LLM sampling (completion) from the connected MCP client',
  loader: () => import('./client/index.js').then((m) => m.clientSamplingTool),
});
registerLazyTool({
  name: 'client-elicit',
  description: 'Ask the user questions through the MCP client UI with structured forms',
  loader: () => import('./client/index.js').then((m) => m.clientElicitTool),
});
registerLazyTool({
  name: 'client-roots',
  description: 'List workspace roots from the connected MCP client',
  loader: () => import('./client/index.js').then((m) => m.clientRootsTool),
});

// ─── Cluster Bus ────────────────────────────────────────────────────────────
registerLazyTool({
  name: 'cluster-bus-status',
  description: 'View cluster bus status, topology, and connected nodes',
  loader: () => import('./cluster-bus/index.js').then((m) => m.clusterStatusTool),
});
registerLazyTool({
  name: 'cluster-bus-send',
  description: 'Send signal via cluster bus (unicast, broadcast, or meta-tag routed)',
  loader: () => import('./cluster-bus/index.js').then((m) => m.clusterSendTool),
});
registerLazyTool({
  name: 'cluster-bus-topology',
  description:
    'Manage cluster bus topology: register/deregister nodes, list providers, view signal history',
  loader: () => import('./cluster-bus/index.js').then((m) => m.clusterTopologyTool),
});
registerLazyTool({
  name: 'cluster-bus-magistrale',
  description: 'Dispatch LLM prompt across multiple clusters in parallel with aggregation',
  loader: () => import('./cluster-bus/index.js').then((m) => m.clusterMagistraleTool),
});
registerLazyTool({
  name: 'cluster-bus-flow',
  description:
    'Manage cluster bus flow control: policies, circuit breakers, backpressure queues, burst detection',
  loader: () => import('./cluster-bus/index.js').then((m) => m.clusterFlowTool),
});
registerLazyTool({
  name: 'cluster-bus-routing',
  description:
    'Manage meta-tag routing rules and provider pool: add/remove rules, test routing, discover providers',
  loader: () => import('./cluster-bus/index.js').then((m) => m.clusterRoutingTool),
});
registerLazyTool({
  name: 'cluster-bus-inspect',
  description:
    'Deep inspection: signal history, health events, bridge stats, subscription diagnostics, bloom filter',
  loader: () => import('./cluster-bus/index.js').then((m) => m.clusterInspectTool),
});
registerLazyTool({
  name: 'cluster-bus-file-read',
  description:
    'Read files across cluster nodes via Cluster Bus. Enables AI to read files from remote cluster nodes.',
  loader: () => import('./cluster-bus/index.js').then((m) => m.clusterFileReadTool),
});

export * from './registry.js';
