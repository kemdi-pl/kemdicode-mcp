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
 * Multi-Agent Context Sharing Types
 *
 * Enables context sharing between any MCP servers via Redis.
 * Server identifiers are strings that can be configured per deployment.
 */

import { config } from '../config/index.js';

/** Server identifier - any string identifying an MCP server */
export type ServerIdentifier = string;

/**
 * Single context entry stored in Redis
 */
export interface McpContextEntry {
  /** UUID v4 identifier */
  id: string;
  /** Session identifier (sess_xxx format) */
  sessionId: string;
  /** MCP server that created this entry */
  serverId: ServerIdentifier;
  /** Tool name that produced the result */
  toolName: string;
  /** Unix timestamp in milliseconds */
  timestamp: number;
  /** Time-to-live in seconds */
  ttl: number;
  /** Tool input parameters */
  input: Record<string, unknown>;
  /** Tool output (JSON-serializable) */
  output: unknown;
  /** Human-readable summary for AI consumption */
  summary?: string;
  /** Tags for filtering (e.g., ['model', 'database', 'api']) */
  tags: string[];
  /** Files involved in this context */
  relatedFiles?: string[];
  /** Whether this was an error response */
  errorState?: boolean;
}

/**
 * Session metadata
 */
export interface McpSession {
  /** Session identifier */
  id: string;
  /** Creation timestamp (ms) */
  createdAt: number;
  /** Last access timestamp (ms) */
  lastAccessedAt: number;
  /** Servers that have contributed to this session */
  serverHistory: ServerIdentifier[];
  /** IDs of context entries in this session */
  contextEntryIds: string[];
  /** Additional metadata */
  metadata: Record<string, unknown>;
}

/**
 * Query parameters for retrieving context
 */
export interface ContextQuery {
  /** Filter by session */
  sessionId?: string;
  /** Filter by source server */
  serverId?: ServerIdentifier;
  /** Filter by tool name */
  toolName?: string;
  /** Filter by tags (any match) */
  tags?: string[];
  /** Entries newer than this timestamp */
  since?: number;
  /** Maximum entries to return */
  limit?: number;
}

/**
 * Redis configuration for context storage
 */
export interface RedisConfig {
  host?: string;
  port?: number;
  password?: string;
  db?: number;
}

/**
 * Get TTL configuration from config manager
 * @returns TTL values in seconds
 */
function getContextTTL() {
  const ctx = config.get('context');
  return {
    SCHEMA: ctx.schema,
    API_DOCS: ctx.apiDocs,
    QUERY: ctx.query,
    ANALYSIS: ctx.analysis,
    SESSION: ctx.session,
    DEFAULT: ctx.default,
  };
}

/**
 * TTL constants in seconds
 *
 * Note: These values are now read from config at runtime.
 * Use getContextTTL() for the most up-to-date values.
 */
export const TTL = {
  /** Model and schema info - rarely changes */
  get SCHEMA() {
    return getContextTTL().SCHEMA;
  },
  /** API endpoint documentation */
  get API_DOCS() {
    return getContextTTL().API_DOCS;
  },
  /** Database query results */
  get QUERY() {
    return getContextTTL().QUERY;
  },
  /** Code analysis results */
  get ANALYSIS() {
    return getContextTTL().ANALYSIS;
  },
  /** Session lifetime */
  get SESSION() {
    return getContextTTL().SESSION;
  },
  /** Default TTL */
  get DEFAULT() {
    return getContextTTL().DEFAULT;
  },
} as const;

/**
 * Redis key prefixes
 */
export const REDIS_KEYS = {
  PREFIX: 'mcp:',
  SESSION: 'session:',
  CONTEXT: 'context:',
  INDEX_SERVER: 'index:server:',
  INDEX_TOOL: 'index:tool:',
  INDEX_TAG: 'index:tag:',
  INDEX_SESSION: 'index:session:',
  // Agent monitoring keys
  AGENTS: 'agents:',
  AGENT_MESSAGES: 'agent:messages:',
  AGENT_ALERTS: 'agent:alerts:',
  AGENT_HEARTBEAT: 'agent:heartbeat:',
  // Pub/Sub channels
  CHANNEL_MESSAGES: 'channel:messages',
  CHANNEL_ALERTS: 'channel:alerts',
  CHANNEL_AGENT_STATUS: 'channel:agent:status',
  CHANNEL_AGENT_SUMMARY: 'channel:agent:summary',
  // Agent monitoring extensions
  AGENT_SUMMARY: 'agent:summary:',
  AGENT_QUEUE: 'agent:queue:',
  // MPC (Multi-Party Computation) keys
  MPC_SHARES: 'mpc:shares:',
  MPC_SECRETS: 'mpc:secrets:',
  MPC_INDEX_AGENT: 'mpc:index:agent:',
  MPC_INDEX_SESSION: 'mpc:index:session:',
  MPC_PENDING: 'mpc:pending:',
  // RL (Reinforcement Learning) keys
  RL_STATE: 'rl:state:',
  RL_STATE_HISTORY: 'rl:state_history:',
  RL_REWARDS: 'rl:rewards:',
  RL_DOPAMINE: 'rl:dopamine:',
  RL_STATS: 'rl:stats:',
  RL_TOOLS: 'rl:tools:',
  RL_SESSION: 'rl:session:',
  // Loci/Graph keys
  GRAPH_NODE: 'mcp:graph:node:',
  GRAPH_TYPE: 'mcp:graph:type:',
  GRAPH_SESSION: 'mcp:graph:session:',
  GRAPH_EDGES_OUT: 'mcp:graph:edges:out:',
  GRAPH_EDGES_IN: 'mcp:graph:edges:in:',
  GRAPH_EDGE: 'mcp:graph:edge:',
  LOCI: 'mcp:loci:',
  LOCI_NAME: 'mcp:loci:name:',
  LOCI_CATEGORY: 'mcp:loci:category:',
  LOCI_SESSION: 'mcp:loci:session:',
  SEQUENCES: 'mcp:sequences:',
  CHAIN: 'mcp:chain:',
  TRANSITIONS: 'mcp:transitions',
} as const;

/**
 * Agent status
 */
export type AgentStatus = 'active' | 'idle' | 'processing' | 'terminated';

/**
 * Agent type/role
 */
export type AgentRole = 'supervisor' | 'worker' | 'specialist' | 'coordinator';

/**
 * Registered agent in the system
 */
export interface McpAgent {
  /** Unique agent identifier */
  id: string;
  /** Human-readable name */
  name: string;
  /** Agent role */
  role: AgentRole;
  /** Current status */
  status: AgentStatus;
  /** Session this agent belongs to */
  sessionId: string;
  /** Server running this agent */
  serverId: ServerIdentifier;
  /** Model being used */
  model?: string;
  /** Current task description */
  currentTask?: string;
  /** Registration timestamp */
  registeredAt: number;
  /** Last heartbeat */
  lastHeartbeat: number;
  /** Metadata */
  metadata: Record<string, unknown>;
}

/**
 * Message types for inter-agent communication
 */
export type MessageType =
  | 'chat' // Regular conversation
  | 'alert' // Important notification [ALERT: ...]
  | 'directive' // Instruction to change behavior
  | 'context' // Context injection
  | 'query' // Question to agent
  | 'response' // Response to query
  | 'status' // Status update
  | 'system' // System message
  // MPC-specific message types
  | 'mpc-share-request' // Request for share contribution
  | 'mpc-share-response' // Share contribution response
  | 'mpc-share-delivery' // Delivering share to agent
  | 'mpc-share-acknowledgment' // Acknowledging share receipt
  | 'mpc-reconstruct-request' // Request to reconstruct secret
  | 'mpc-reconstruct-contribution'; // Contributing share for reconstruction

/**
 * Priority levels for messages
 */
export type MessagePriority = 'low' | 'normal' | 'high' | 'critical';

/**
 * Inter-agent message
 */
export interface AgentMessage {
  /** Message UUID */
  id: string;
  /** Sender agent ID (or 'supervisor' for external) */
  fromAgentId: string;
  /** Target agent ID (or '*' for broadcast) */
  toAgentId: string;
  /** Session ID */
  sessionId: string;
  /** Message type */
  type: MessageType;
  /** Priority */
  priority: MessagePriority;
  /** Message content */
  content: string;
  /** Optional structured data */
  data?: Record<string, unknown>;
  /** Timestamp */
  timestamp: number;
  /** Whether message was read/acknowledged */
  acknowledged: boolean;
  /** Response to message ID (if applicable) */
  replyTo?: string;
}

/**
 * Alert configuration for supervisor
 */
export interface SupervisorAlert {
  /** Alert ID */
  id: string;
  /** Target agent(s) */
  targetAgentIds: string[];
  /** Alert content */
  content: string;
  /** Source (e.g., "Claude Opus 4.5") */
  source: string;
  /** Priority */
  priority: MessagePriority;
  /** Timestamp */
  timestamp: number;
  /** Whether to interrupt current processing */
  interrupt: boolean;
}

/**
 * Conversation snapshot for monitoring
 */
export interface ConversationSnapshot {
  /** Session ID */
  sessionId: string;
  /** Agents involved */
  agents: McpAgent[];
  /** Recent messages */
  recentMessages: AgentMessage[];
  /** Pending alerts */
  pendingAlerts: SupervisorAlert[];
  /** Snapshot timestamp */
  snapshotAt: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// MONITOR TYPES - Agent Activity Tracking & Message Queue
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Agent activity summary - what an agent is currently doing
 */
export interface AgentSummary {
  /** Agent ID */
  agentId: string;
  /** Session ID */
  sessionId: string;
  /** Current kanban task ID */
  currentTaskId?: string;
  /** Human-readable activity description */
  activity: string;
  /** Progress percentage (0-100) */
  progress?: number;
  /** Last action taken */
  lastAction?: string;
  /** Last updated timestamp */
  updatedAt: number;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Queued message for an agent
 */
export interface QueuedMessage {
  /** Message UUID */
  id: string;
  /** Target agent ID */
  targetAgentId: string;
  /** Session ID */
  sessionId: string;
  /** Message content */
  content: string;
  /** Priority for ordering */
  priority: MessagePriority;
  /** Optional file paths to attach */
  files?: string[];
  /** Optional structured context data */
  context?: Record<string, unknown>;
  /** Whether this forces a context change */
  forceContextChange?: boolean;
  /** Created timestamp */
  createdAt: number;
  /** Expiration timestamp (optional) */
  expiresAt?: number;
  /** Sender (agent ID or 'supervisor') */
  fromAgentId: string;
}

/**
 * Task status type (from kanban)
 */
export type TaskStatus = 'backlog' | 'in_progress' | 'review' | 'done';

/**
 * Workspace overview for hierarchy view
 */
export interface WorkspaceOverview {
  id: string;
  name: string;
  memberCount: number;
  boardCount: number;
  isOwner: boolean;
}

/**
 * Board overview for hierarchy view
 */
export interface BoardOverview {
  id: string;
  name: string;
  workspaceId?: string;
  taskCount: number;
  byStatus: Record<TaskStatus, number>;
  activeAgents: string[];
}

/**
 * Agent overview including summary and task
 */
export interface AgentOverview {
  id: string;
  name: string;
  role: AgentRole;
  status: AgentStatus;
  /** Activity summary */
  summary?: AgentSummary;
  /** Current task (from kanban) */
  currentTask?: {
    id: string;
    title: string;
    status: TaskStatus;
    boardId?: string;
  };
  /** Pending messages in queue */
  pendingMessages: number;
}

/**
 * Activity entry for recent activity feed
 */
export interface ActivityEntry {
  type: 'message' | 'task_event' | 'agent_status';
  timestamp: number;
  agentId?: string;
  description: string;
  data?: Record<string, unknown>;
}

/**
 * Session statistics
 */
export interface SessionStats {
  totalAgents: number;
  activeAgents: number;
  totalTasks: number;
  tasksInProgress: number;
  pendingMessages: number;
  workspaceCount: number;
  boardCount: number;
}

/**
 * Full session overview - hierarchical view
 */
export interface SessionOverview {
  sessionId: string;
  /** Workspaces this session belongs to */
  workspaces: WorkspaceOverview[];
  /** Boards in this session (including from workspaces) */
  boards: BoardOverview[];
  /** Agents in this session */
  agents: AgentOverview[];
  /** Recent activity (messages + task events) */
  recentActivity: ActivityEntry[];
  /** Summary statistics */
  stats: SessionStats;
  /** Snapshot timestamp */
  snapshotAt: number;
}
