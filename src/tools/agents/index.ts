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
 * Agent Monitoring Tools
 *
 * Tools for real-time multi-agent supervision:
 * - agent-list: List active agents
 * - agent-register: Register 1-N agents at once
 * - agent-watch: Real-time monitoring
 * - agent-alert: Send alerts to agents (supports broadcast)
 * - agent-inject: Inject context/directives
 * - agent-history: View conversation history
 * - monitor: Comprehensive session monitoring
 * - agent-summary: Update 1-N agent summaries at once
 * - queue-message: Queue messages to 1-N agents at once
 */

export { agentListTool } from './agent-list.tool.js';
export { agentRegisterTool } from './agent-register.tool.js';
export { agentWatchTool } from './agent-watch.tool.js';
export { agentAlertTool } from './agent-alert.tool.js';
export { agentInjectTool } from './agent-inject.tool.js';
export { agentHistoryTool } from './agent-history.tool.js';
export { monitorTool } from './monitor.tool.js';
export { agentSummaryTool } from './agent-summary.tool.js';
export { queueMessageTool } from './queue-message.tool.js';
