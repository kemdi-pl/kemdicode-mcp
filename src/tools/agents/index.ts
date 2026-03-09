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
 * Agent Tools — Consolidated (v4.7.0)
 *
 * 10 tools consolidated into 3:
 * - agent: register, list, init, summary, rank (was 5 separate tools)
 * - agent-comm: queue, alert, inject, history (was 4 separate tools)
 * - monitor: kept as-is (already multi-view)
 *
 * Original tool files are preserved for internal delegation.
 */

export { agentTool } from './agent.tool.js';
export { agentCommTool } from './agent-comm.tool.js';
export { monitorTool } from './monitor.tool.js';

// Legacy exports kept for internal use by the consolidated tools
export { agentListTool } from './agent-list.tool.js';
export { agentRegisterTool } from './agent-register.tool.js';
export { agentAlertTool } from './agent-alert.tool.js';
export { agentInjectTool } from './agent-inject.tool.js';
export { agentHistoryTool } from './agent-history.tool.js';
export { agentSummaryTool } from './agent-summary.tool.js';
export { queueMessageTool } from './queue-message.tool.js';
export { agentInitTool } from './agent-init.tool.js';
export { agentRankTool } from './agent-rank.tool.js';
