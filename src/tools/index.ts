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
 * Lazy Tool Loader Registry — v4.3.0
 *
 * Consolidated to 62 action-based tools.
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

// ─── Agent Management & Communication ────────────────────────────────────────
registerLazyTool({
  name: 'agent',
  description: 'Unified agent management: register, list, init (onboarding), summary, rank',
  loader: () => import('./agents/index.js').then((m) => m.agentTool),
});
registerLazyTool({
  name: 'agent-comm',
  description: 'Unified agent communication: queue messages, alerts/directives, inject context, history',
  loader: () => import('./agents/index.js').then((m) => m.agentCommTool),
});
registerLazyTool({
  name: 'monitor',
  description: 'Session monitoring with multiple views (overview/agents/tasks/hierarchy/activity)',
  loader: () => import('./agents/index.js').then((m) => m.monitorTool),
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

// ─── Project Memory (consolidated: 8 → 2 tools) ────────────────────────────
registerLazyTool({
  name: 'memory',
  description: 'Unified project memory: write, read, list, edit, or delete named memories',
  loader: () => import('./memory/index.js').then((m) => m.memoryTool),
});
registerLazyTool({
  name: 'checkpoint',
  description: 'Unified checkpoint management: save, restore, or diff state snapshots',
  loader: () => import('./memory/index.js').then((m) => m.checkpointTool),
});

// ─── Kanban (Consolidated: 25 tools → 4) ────────────────────────────────────
registerLazyTool({
  name: 'task',
  description: 'Unified task management: create, get, list, update, delete, comment, claim, assign, subtask',
  loader: () => import('./kanban/index.js').then((m) => m.taskTool),
});
registerLazyTool({
  name: 'task-multi',
  description: 'Bulk task ops: push (distribute to agents), cluster (LLM grouping/context), complexity (LLM analysis)',
  loader: () => import('./kanban/index.js').then((m) => m.taskMultiTool),
});
registerLazyTool({
  name: 'board',
  description: 'Unified board management: create, list, delete, status, share, invite, members, workflow',
  loader: () => import('./kanban/index.js').then((m) => m.boardTool),
});
registerLazyTool({
  name: 'workspace',
  description: 'Unified workspace management: create, list, join, leave, delete',
  loader: () => import('./kanban/index.js').then((m) => m.workspaceTool),
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
  name: 'session',
  description: 'Manage sessions: list, info, create, switch, delete, recover',
  loader: () => import('./session/index.js').then((m) => m.sessionTool),
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
registerLazyTool({
  name: 'mind-chain',
  description:
    'Sequential Mind-to-Mind chain: each Mind builds on the previous (dialectical, adversarial, evidence, full-review, custom). Inspired by Ouroboros (Harry Munro).',
  loader: () => import('./multi-llm/index.js').then((m) => m.mindChainTool),
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
