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
 * Kanban Tools
 *
 * Tools for agent task management with supervisor oversight.
 * Includes multi-board, workspace, and membership tools.
 *
 * @module tools/kanban
 */

// Task tools (legacy + extended)
export { taskCreateTool } from './task-create.tool.js';
export { taskGetTool } from './task-get.tool.js';
export { taskListTool } from './task-list.tool.js';
export { taskClaimTool } from './task-claim.tool.js';
export { taskAssignTool } from './task-assign.tool.js';
export { taskUpdateTool } from './task-update.tool.js';
export { taskDeleteTool } from './task-delete.tool.js';
export { boardStatusTool } from './board-status.tool.js';

// Task comments/notes
export { taskCommentTool } from './task-comment.tool.js';

// Multi-agent push
export { taskPushMultiTool } from './task-push-multi.tool.js';

// Complexity analysis
export { taskComplexityTool } from './task-complexity.tool.js';

// Clustering
export { taskClusterTool } from './task-cluster.tool.js';

// Workspace tools
export { workspaceCreateTool } from './workspace-create.tool.js';
export { workspaceListTool } from './workspace-list.tool.js';
export { workspaceJoinTool } from './workspace-join.tool.js';
export { workspaceLeaveTool } from './workspace-leave.tool.js';
export { workspaceDeleteTool } from './workspace-delete.tool.js';

// Board tools
export { boardCreateTool } from './board-create.tool.js';
export { boardListTool } from './board-list.tool.js';
export { boardShareTool } from './board-share.tool.js';
export { boardMembersTool } from './board-members.tool.js';
export { boardInviteTool } from './board-invite.tool.js';
export { boardDeleteTool } from './board-delete.tool.js';

// Subtask hierarchy
export { taskSubtaskTool } from './task-subtask.tool.js';

// Board workflow (auto board switching)
export { boardWorkflowTool } from './board-workflow.tool.js';
