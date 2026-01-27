/**
 * KemdiCode MCP Server
 * Copyright (C) 2025-2026 Kemdi Sp. z o.o.
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
 * Kanban Types
 *
 * TypeScript interfaces for the Agent Kanban system.
 *
 * @module kanban/types
 */

/** Task status */
export type TaskStatus = 'backlog' | 'in_progress' | 'review' | 'done';

/** Task priority */
export type TaskPriority = 'critical' | 'high' | 'normal' | 'low';

/** Priority scores for sorting */
export const PRIORITY_SCORES: Record<TaskPriority, number> = {
  critical: 100,
  high: 75,
  normal: 50,
  low: 25,
};

/** Kanban task */
export interface KanbanTask {
  id: string;
  sessionId: string;
  /** Board ID (optional for backward compatibility, auto-assigned to default board) */
  boardId?: string;
  title: string;
  description?: string;
  status: TaskStatus;
  priority: TaskPriority;
  assignee?: string; // agent ID
  createdBy: string; // agent ID
  blockedBy: string[]; // task IDs
  blocks: string[]; // task IDs
  relatedFiles: string[];
  labels: string[];
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  estimatedMinutes?: number;
  actualMinutes?: number;
}

/** Task creation input */
export interface CreateTaskInput {
  sessionId: string;
  /** Board ID (optional - uses default board if not specified) */
  boardId?: string;
  title: string;
  description?: string;
  priority?: TaskPriority;
  createdBy: string;
  blockedBy?: string[];
  relatedFiles?: string[];
  labels?: string[];
  estimatedMinutes?: number;
}

/** Task update input */
export interface UpdateTaskInput {
  title?: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  assignee?: string | null;
  blockedBy?: string[];
  addBlockedBy?: string[];
  addBlocks?: string[];
  relatedFiles?: string[];
  labels?: string[];
  estimatedMinutes?: number;
}

/** Task event types */
export type TaskEventType =
  | 'task-created'
  | 'task-updated'
  | 'task-claimed'
  | 'task-assigned'
  | 'task-started'
  | 'task-completed'
  | 'task-blocked'
  | 'task-unblocked';

/** Task event */
export interface TaskEvent {
  type: TaskEventType;
  taskId: string;
  agentId: string;
  sessionId: string;
  timestamp: number;
  data?: Record<string, unknown>;
}

/** Board summary */
export interface BoardSummary {
  sessionId: string;
  totalTasks: number;
  byStatus: Record<TaskStatus, number>;
  byPriority: Record<TaskPriority, number>;
  blockedTasks: number;
  assignedTasks: number;
  unassignedTasks: number;
  agents: Array<{
    agentId: string;
    taskCount: number;
    inProgress: number;
  }>;
  recentActivity: TaskEvent[];
}

/** Task filter options */
export interface TaskFilter {
  status?: TaskStatus | TaskStatus[];
  priority?: TaskPriority | TaskPriority[];
  assignee?: string;
  unassigned?: boolean;
  blocked?: boolean;
  labels?: string[];
  createdBy?: string;
  /** Filter by board ID */
  boardId?: string;
  /** Filter by multiple board IDs */
  boardIds?: string[];
}

/** Redis key prefixes for kanban */
export const KANBAN_KEYS = {
  // ─────────────────────────────────────────────────────────────────────────────
  // Legacy Session-Based Keys (backward compatibility)
  // ─────────────────────────────────────────────────────────────────────────────

  /** ZSET: tasks sorted by priority - mcp:kanban:tasks:{sessionId} */
  tasks: (sessionId: string) => `mcp:kanban:tasks:${sessionId}`,
  /** HASH: task data - mcp:kanban:task:{taskId} */
  task: (taskId: string) => `mcp:kanban:task:${taskId}`,
  /** SET: tasks by status - mcp:kanban:status:{sessionId}:{status} */
  byStatus: (sessionId: string, status: TaskStatus) => `mcp:kanban:status:${sessionId}:${status}`,
  /** SET: tasks by agent - mcp:kanban:agent:{agentId} */
  byAgent: (agentId: string) => `mcp:kanban:agent:${agentId}`,
  /** LIST: task events - mcp:kanban:events:{sessionId} */
  events: (sessionId: string) => `mcp:kanban:events:${sessionId}`,
  /** Pub/Sub channel (legacy) */
  channel: 'mcp:channel:kanban',

  // ─────────────────────────────────────────────────────────────────────────────
  // Workspace Keys (Multi-Board Extension)
  // ─────────────────────────────────────────────────────────────────────────────

  /** HASH: workspace data - mcp:kanban:workspace:{wsId} */
  workspace: (wsId: string) => `mcp:kanban:workspace:${wsId}`,
  /** SET: sessions in workspace - mcp:kanban:workspace:{wsId}:sessions */
  workspaceSessions: (wsId: string) => `mcp:kanban:workspace:${wsId}:sessions`,
  /** SET: workspaces session belongs to - mcp:kanban:workspaces:session:{sessionId} */
  workspacesBySession: (sessionId: string) => `mcp:kanban:workspaces:session:${sessionId}`,
  /** SET: all workspaces (for listing) - mcp:kanban:workspaces:all */
  allWorkspaces: 'mcp:kanban:workspaces:all',

  // ─────────────────────────────────────────────────────────────────────────────
  // Board Keys (Multi-Board Extension)
  // ─────────────────────────────────────────────────────────────────────────────

  /** HASH: board data - mcp:kanban:board:{boardId} */
  board: (boardId: string) => `mcp:kanban:board:${boardId}`,
  /** ZSET: tasks on board sorted by priority - mcp:kanban:board:{boardId}:tasks */
  boardTasks: (boardId: string) => `mcp:kanban:board:${boardId}:tasks`,
  /** SET: board members - mcp:kanban:board:{boardId}:members */
  boardMembers: (boardId: string) => `mcp:kanban:board:${boardId}:members`,
  /** SET: boards in session - mcp:kanban:boards:session:{sessionId} */
  boardsBySession: (sessionId: string) => `mcp:kanban:boards:session:${sessionId}`,
  /** SET: boards in workspace - mcp:kanban:boards:workspace:{wsId} */
  boardsByWorkspace: (wsId: string) => `mcp:kanban:boards:workspace:${wsId}`,
  /** LIST: board events - mcp:kanban:board:{boardId}:events */
  boardEvents: (boardId: string) => `mcp:kanban:board:${boardId}:events`,

  // ─────────────────────────────────────────────────────────────────────────────
  // Membership Keys (Multi-Board Extension)
  // ─────────────────────────────────────────────────────────────────────────────

  /** HASH: membership data - mcp:kanban:membership:{boardId}:{agentId} */
  membership: (boardId: string, agentId: string) => `mcp:kanban:membership:${boardId}:${agentId}`,
  /** SET: boards agent is member of - mcp:kanban:agent:{agentId}:boards */
  agentBoards: (agentId: string) => `mcp:kanban:agent:${agentId}:boards`,

  // ─────────────────────────────────────────────────────────────────────────────
  // Pub/Sub Channels (Multi-Board Extension)
  // ─────────────────────────────────────────────────────────────────────────────

  /** Pub/Sub: per-board events - mcp:channel:kanban:board:{boardId} */
  boardChannel: (boardId: string) => `mcp:channel:kanban:board:${boardId}`,
  /** Pub/Sub: per-workspace events - mcp:channel:kanban:workspace:{wsId} */
  workspaceChannel: (wsId: string) => `mcp:channel:kanban:workspace:${wsId}`,
};

/** Default task TTL (7 days) */
export const DEFAULT_TASK_TTL = 7 * 24 * 60 * 60;

/** Completed task TTL (1 day) */
export const COMPLETED_TASK_TTL = 24 * 60 * 60;

/** Max events to keep per session */
export const MAX_EVENTS = 100;

// ============================================================================
// WORKSPACE & BOARD TYPES (Multi-Board Kanban Extension)
// ============================================================================

/**
 * Board membership role
 * Determines what actions an agent can perform on a board
 */
export type BoardRole = 'owner' | 'admin' | 'member' | 'viewer';

/**
 * Board visibility level
 * - private: Only members can see
 * - workspace: All workspace members can see
 * - public: Anyone can see (read-only for non-members)
 */
export type BoardVisibility = 'private' | 'workspace' | 'public';

/**
 * Granular permissions for board operations
 */
export interface BoardPermissions {
  canCreateTasks: boolean;
  canAssignTasks: boolean;
  canUpdateTasks: boolean;
  canDeleteTasks: boolean;
  canInviteMembers: boolean;
  canManageBoard: boolean;
}

/**
 * Default permissions by role
 */
export const DEFAULT_PERMISSIONS: Record<BoardRole, BoardPermissions> = {
  owner: {
    canCreateTasks: true,
    canAssignTasks: true,
    canUpdateTasks: true,
    canDeleteTasks: true,
    canInviteMembers: true,
    canManageBoard: true,
  },
  admin: {
    canCreateTasks: true,
    canAssignTasks: true,
    canUpdateTasks: true,
    canDeleteTasks: true,
    canInviteMembers: true,
    canManageBoard: false,
  },
  member: {
    canCreateTasks: true,
    canAssignTasks: false,
    canUpdateTasks: true,
    canDeleteTasks: false,
    canInviteMembers: false,
    canManageBoard: false,
  },
  viewer: {
    canCreateTasks: false,
    canAssignTasks: false,
    canUpdateTasks: false,
    canDeleteTasks: false,
    canInviteMembers: false,
    canManageBoard: false,
  },
};

/**
 * Workspace - groups sessions that can share boards
 *
 * @description A workspace enables cross-session collaboration by allowing
 *              multiple sessions to access the same boards
 */
export interface Workspace {
  /** Unique workspace ID (ws_xxxxxxxx) */
  id: string;
  /** Human-readable workspace name */
  name: string;
  /** Optional description */
  description?: string;
  /** Agent ID of the workspace creator */
  ownerId: string;
  /** Session that created the workspace */
  ownerSessionId: string;
  /** Session IDs that have joined this workspace */
  memberSessions: string[];
  /** Creation timestamp */
  createdAt: number;
  /** Last update timestamp */
  updatedAt: number;
  /** Optional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Kanban Board - a named collection of tasks
 *
 * @description Boards can exist standalone (per-session) or within a workspace
 *              (cross-session). This allows both single-session and
 *              collaborative workflows.
 */
export interface KanbanBoard {
  /** Unique board ID (board_xxxxxxxx) */
  id: string;
  /** Human-readable board name (e.g., "frontend", "backend") */
  name: string;
  /** Optional description */
  description?: string;
  /** Origin session ID (for backward compatibility) */
  sessionId: string;
  /** Optional workspace ID (enables cross-session access) */
  workspaceId?: string;
  /** Board visibility level */
  visibility: BoardVisibility;
  /** Creation timestamp */
  createdAt: number;
  /** Last update timestamp */
  updatedAt: number;
  /** Agent ID who created the board */
  createdBy: string;
  /** Board-level labels */
  labels?: string[];
  /** Denormalized task count for quick access */
  taskCount: number;
  /** Denormalized active agent count */
  activeAgentCount: number;
}

/**
 * Board membership - agent's role on a specific board
 */
export interface BoardMembership {
  /** Board ID */
  boardId: string;
  /** Agent ID */
  agentId: string;
  /** Agent's session ID */
  sessionId: string;
  /** Role on this board */
  role: BoardRole;
  /** When the agent joined the board */
  joinedAt: number;
  /** Agent ID who invited (if any) */
  invitedBy?: string;
  /** Effective permissions (may differ from role defaults) */
  permissions: BoardPermissions;
}

/**
 * Workspace creation input
 */
export interface CreateWorkspaceInput {
  name: string;
  description?: string;
  ownerSessionId: string;
  ownerId: string;
  initialMemberSessions?: string[];
}

/**
 * Board creation input
 */
export interface CreateBoardInput {
  name: string;
  description?: string;
  sessionId: string;
  workspaceId?: string;
  visibility?: BoardVisibility;
  createdBy: string;
  labels?: string[];
}

/**
 * Board event types (extension of task events)
 */
export type BoardEventType =
  | TaskEventType
  | 'board-created'
  | 'board-updated'
  | 'board-deleted'
  | 'board-shared'
  | 'member-joined'
  | 'member-left'
  | 'member-role-changed';

/**
 * Board event
 */
export interface BoardEvent {
  type: BoardEventType;
  boardId: string;
  agentId: string;
  sessionId: string;
  timestamp: number;
  data?: Record<string, unknown>;
}
