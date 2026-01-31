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
 * Monitor Tool
 *
 * Comprehensive session monitoring with multiple views:
 * - overview: Quick summary of session state
 * - agents: Detailed agent status with activity
 * - tasks: Kanban board state
 * - hierarchy: Tree view of session structure
 * - activity: Recent activity feed
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { getAgentMonitor } from '../../context/agent-monitor.js';
import type { SessionOverview } from '../../context/types.js';

const schema = z.object({
  sessionId: z.string().describe('Session ID to monitor'),
  view: z
    .enum(['overview', 'agents', 'tasks', 'hierarchy', 'activity'])
    .default('overview')
    .describe('View type: overview, agents, tasks, hierarchy, or activity'),
  agentId: z.string().optional().describe('Filter to specific agent'),
  boardId: z.string().optional().describe('Filter to specific board'),
  depth: z
    .enum(['shallow', 'deep'])
    .default('shallow')
    .describe('Detail depth: shallow for summary, deep for full details'),
  includeQueues: z.boolean().default(false).describe('Include message queue info'),
  limit: z.number().min(5).max(100).default(20).describe('Limit for activity entries'),
});

function formatAgentStatus(status: string): string {
  return (
    {
      active: '🟢',
      processing: '🔄',
      idle: '💤',
      terminated: '⛔',
    }[status] || '❓'
  );
}

function formatAgentRole(role: string): string {
  return (
    {
      supervisor: '👑',
      coordinator: '🎯',
      worker: '⚙️',
      specialist: '🔬',
    }[role] || '👤'
  );
}

function renderOverview(overview: SessionOverview, includeQueues: boolean): string {
  const { sessionId, stats, agents, boards } = overview;
  const lines: string[] = [];

  lines.push('╔══════════════════════════════════════════════════════════════════╗');
  lines.push(`║              SESSION MONITOR: ${sessionId.padEnd(28)}║`);
  lines.push('╠══════════════════════════════════════════════════════════════════╣');
  lines.push('║ SUMMARY                                                          ║');
  lines.push(`║ ├─ Workspaces: ${String(stats.workspaceCount).padEnd(48)}║`);
  lines.push(`║ ├─ Boards: ${String(stats.boardCount).padEnd(52)}║`);
  lines.push(
    `║ ├─ Tasks: ${stats.totalTasks} (${stats.tasksInProgress} in_progress)`.padEnd(67) + '║'
  );
  lines.push(`║ └─ Agents: ${stats.totalAgents} (${stats.activeAgents} active)`.padEnd(67) + '║');

  if (includeQueues) {
    lines.push(`║    Pending Messages: ${String(stats.pendingMessages).padEnd(42)}║`);
  }

  lines.push('╠══════════════════════════════════════════════════════════════════╣');
  lines.push('║ ACTIVE AGENTS                                                    ║');

  const activeAgents = agents.filter((a) => a.status === 'active' || a.status === 'processing');
  if (activeAgents.length === 0) {
    lines.push('║   (no active agents)                                             ║');
  } else {
    for (const agent of activeAgents.slice(0, 5)) {
      const icon = formatAgentStatus(agent.status);
      lines.push(`║ ${icon} ${agent.name} (${agent.role})`.padEnd(67) + '║');
      if (agent.summary?.activity) {
        const activity =
          agent.summary.activity.length > 50
            ? agent.summary.activity.slice(0, 47) + '...'
            : agent.summary.activity;
        const progress = agent.summary.progress ? ` (${agent.summary.progress}%)` : '';
        lines.push(`║    └─ ${activity}${progress}`.padEnd(67) + '║');
      }
    }
    if (activeAgents.length > 5) {
      lines.push(`║    ... and ${activeAgents.length - 5} more agent(s)`.padEnd(67) + '║');
    }
  }

  lines.push('╠══════════════════════════════════════════════════════════════════╣');
  lines.push('║ BOARDS                                                           ║');

  if (boards.length === 0) {
    lines.push('║   (no boards)                                                    ║');
  } else {
    for (const board of boards.slice(0, 5)) {
      const inProgress = board.byStatus.in_progress;
      lines.push(
        `║ 📋 ${board.name} (${board.taskCount} tasks, ${inProgress} in progress)`.padEnd(67) + '║'
      );
    }
  }

  lines.push('╚══════════════════════════════════════════════════════════════════╝');

  return lines.join('\n');
}

function renderAgents(overview: SessionOverview, includeQueues: boolean): string {
  const { sessionId, agents } = overview;
  const lines: string[] = [];

  lines.push('╔══════════════════════════════════════════════════════════════════╗');
  lines.push(`║              AGENTS: ${sessionId.padEnd(37)}║`);
  lines.push('╠══════════════════════════════════════════════════════════════════╣');

  if (agents.length === 0) {
    lines.push('║   (no agents in session)                                         ║');
  } else {
    for (const agent of agents) {
      const statusIcon = formatAgentStatus(agent.status);
      const roleIcon = formatAgentRole(agent.role);

      lines.push(`║ ${statusIcon} ${agent.id} ${roleIcon} ${agent.role}`.padEnd(67) + '║');
      lines.push(`║    Name: ${agent.name}`.padEnd(67) + '║');

      if (agent.summary) {
        const activity =
          agent.summary.activity.length > 45
            ? agent.summary.activity.slice(0, 42) + '...'
            : agent.summary.activity;
        const progress = agent.summary.progress ? ` (${agent.summary.progress}%)` : '';
        lines.push(`║    Activity: ${activity}${progress}`.padEnd(67) + '║');

        if (agent.summary.lastAction) {
          lines.push(`║    Last action: ${agent.summary.lastAction}`.padEnd(67) + '║');
        }
      }

      if (agent.currentTask) {
        const taskTitle =
          agent.currentTask.title.length > 40
            ? agent.currentTask.title.slice(0, 37) + '...'
            : agent.currentTask.title;
        lines.push(`║    Task: ${taskTitle}`.padEnd(67) + '║');
      }

      if (includeQueues && agent.pendingMessages > 0) {
        lines.push(`║    📬 Pending messages: ${agent.pendingMessages}`.padEnd(67) + '║');
      }

      lines.push('╠──────────────────────────────────────────────────────────────────╣');
    }
    lines.pop(); // Remove last separator
  }

  lines.push('╚══════════════════════════════════════════════════════════════════╝');
  lines.push(`\nTotal: ${agents.length} agent(s)`);

  return lines.join('\n');
}

function renderTasks(overview: SessionOverview): string {
  const { sessionId, boards, stats } = overview;
  const lines: string[] = [];

  lines.push('╔══════════════════════════════════════════════════════════════════╗');
  lines.push(`║              KANBAN BOARDS: ${sessionId.padEnd(30)}║`);
  lines.push('╠══════════════════════════════════════════════════════════════════╣');

  if (boards.length === 0) {
    lines.push('║   (no boards)                                                    ║');
  } else {
    for (const board of boards) {
      lines.push(`║ 📋 ${board.name} (${board.id})`.padEnd(67) + '║');
      lines.push(`║    Tasks: ${board.taskCount} total`.padEnd(67) + '║');
      lines.push(`║    ├─ Backlog: ${board.byStatus.backlog}`.padEnd(67) + '║');
      lines.push(`║    ├─ In Progress: ${board.byStatus.in_progress}`.padEnd(67) + '║');
      lines.push(`║    ├─ Review: ${board.byStatus.review}`.padEnd(67) + '║');
      lines.push(`║    └─ Done: ${board.byStatus.done}`.padEnd(67) + '║');

      if (board.activeAgents.length > 0) {
        lines.push(`║    Active agents: ${board.activeAgents.join(', ')}`.padEnd(67) + '║');
      }

      lines.push('╠──────────────────────────────────────────────────────────────────╣');
    }
    lines.pop();
  }

  lines.push('╚══════════════════════════════════════════════════════════════════╝');
  lines.push(`\nSummary: ${stats.totalTasks} tasks across ${boards.length} board(s)`);

  return lines.join('\n');
}

function renderHierarchy(overview: SessionOverview, deep: boolean): string {
  const { sessionId, workspaces, boards, agents } = overview;
  const lines: string[] = [];

  lines.push('╔══════════════════════════════════════════════════════════════════╗');
  lines.push(`║              SESSION HIERARCHY: ${sessionId.padEnd(26)}║`);
  lines.push('╠══════════════════════════════════════════════════════════════════╣');

  // Workspaces
  if (workspaces.length > 0) {
    for (const ws of workspaces) {
      const ownerBadge = ws.isOwner ? ' 👑' : '';
      lines.push(`║ 📁 Workspace: ${ws.name}${ownerBadge} (${ws.id})`.padEnd(67) + '║');
      lines.push(`║ │  Members: ${ws.memberCount}, Boards: ${ws.boardCount}`.padEnd(67) + '║');

      // Boards in this workspace
      const wsBoards = boards.filter((b) => b.workspaceId === ws.id);
      for (const board of wsBoards) {
        lines.push(`║ │  └─ 📋 ${board.name} (${board.taskCount} tasks)`.padEnd(67) + '║');

        if (deep) {
          // Agents working on this board
          const boardAgents = agents.filter((a) => a.currentTask?.boardId === board.id);
          for (const agent of boardAgents) {
            const icon = formatAgentStatus(agent.status);
            const activity = agent.summary?.activity
              ? ` - "${agent.summary.activity.slice(0, 20)}..."`
              : '';
            lines.push(`║ │     └─ ${icon} ${agent.name}${activity}`.padEnd(67) + '║');
          }
        }
      }
      lines.push('║ │'.padEnd(67) + '║');
    }
  }

  // Session-only boards (not in workspace)
  const sessionBoards = boards.filter((b) => !b.workspaceId);
  if (sessionBoards.length > 0) {
    lines.push('║ 📋 Session Boards (no workspace):'.padEnd(67) + '║');
    for (const board of sessionBoards) {
      lines.push(`║    └─ ${board.name} (${board.taskCount} tasks)`.padEnd(67) + '║');

      if (deep) {
        const boardAgents = agents.filter((a) => a.currentTask?.boardId === board.id);
        for (const agent of boardAgents) {
          const icon = formatAgentStatus(agent.status);
          lines.push(`║       └─ ${icon} ${agent.name}`.padEnd(67) + '║');
        }
      }
    }
  }

  // Agents without tasks
  const idleAgents = agents.filter((a) => !a.currentTask);
  if (idleAgents.length > 0 && deep) {
    lines.push('║ 👥 Idle Agents:'.padEnd(67) + '║');
    for (const agent of idleAgents) {
      const icon = formatAgentStatus(agent.status);
      lines.push(`║    └─ ${icon} ${agent.name} (${agent.role})`.padEnd(67) + '║');
    }
  }

  lines.push('╚══════════════════════════════════════════════════════════════════╝');

  return lines.join('\n');
}

function renderActivity(overview: SessionOverview, limit: number): string {
  const { sessionId, recentActivity } = overview;
  const lines: string[] = [];

  lines.push('╔══════════════════════════════════════════════════════════════════╗');
  lines.push(`║              RECENT ACTIVITY: ${sessionId.padEnd(28)}║`);
  lines.push('╠══════════════════════════════════════════════════════════════════╣');

  if (recentActivity.length === 0) {
    lines.push('║   (no recent activity)                                           ║');
  } else {
    for (const entry of recentActivity.slice(0, limit)) {
      const time = new Date(entry.timestamp).toLocaleTimeString();
      const icon = entry.type === 'message' ? '💬' : entry.type === 'task_event' ? '📋' : '🔄';
      const desc =
        entry.description.length > 50 ? entry.description.slice(0, 47) + '...' : entry.description;
      lines.push(`║ [${time}] ${icon} ${desc}`.padEnd(67) + '║');
    }
  }

  lines.push('╚══════════════════════════════════════════════════════════════════╝');
  lines.push(
    `\nShowing ${Math.min(recentActivity.length, limit)} of ${recentActivity.length} entries`
  );

  return lines.join('\n');
}

export const monitorTool: UnifiedTool = {
  name: 'monitor',
  description:
    'Session monitoring. Views: overview, agents, tasks, hierarchy, activity.',
  zodSchema: schema,
  skipContextShare: true,
  metadata: {
    category: 'agents',
    tags: ['monitor', 'overview', 'dashboard'],
    examples: [
      { args: { sessionId: 'sess-abc123' }, description: 'Show session overview dashboard' },
      { args: { sessionId: 'sess-abc123', view: 'hierarchy', depth: 'deep' }, description: 'Show deep hierarchy tree of session' },
      { args: { sessionId: 'sess-abc123', view: 'activity', limit: 50 }, description: 'Show last 50 activity entries' },
    ],
    relatedTools: ['agent-list', 'task-list', 'board-status'],
  },

  execute: async (args) => {
    const { sessionId, view, agentId, boardId, depth, includeQueues, limit } = args as z.infer<
      typeof schema
    >;

    try {
      const monitor = getAgentMonitor();
      if (!monitor.isConnected()) {
        await monitor.connect();
      }

      // Get full session overview
      let overview = await monitor.getSessionOverview(sessionId);

      // Apply filters
      if (agentId) {
        overview = {
          ...overview,
          agents: overview.agents.filter((a) => a.id === agentId),
        };
      }

      if (boardId) {
        overview = {
          ...overview,
          boards: overview.boards.filter((b) => b.id === boardId),
        };
      }

      // Render appropriate view
      switch (view) {
        case 'overview':
          return renderOverview(overview, includeQueues);
        case 'agents':
          return renderAgents(overview, includeQueues);
        case 'tasks':
          return renderTasks(overview);
        case 'hierarchy':
          return renderHierarchy(overview, depth === 'deep');
        case 'activity':
          return renderActivity(overview, limit);
        default:
          return renderOverview(overview, includeQueues);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return JSON.stringify({
        error: true,
        message: `Monitor failed: ${errorMessage}`,
        sessionId,
        view,
      });
    }
  },
};
