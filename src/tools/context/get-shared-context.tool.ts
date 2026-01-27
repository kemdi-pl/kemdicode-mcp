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
 * Get Shared Context Tool
 *
 * Retrieves context shared by other MCP servers in the current session.
 * Useful for understanding what information has been gathered during analysis.
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import {
  getSessionId,
  getSessionContext,
  getContextFromServer,
  isContextEnabled,
} from '../../context/index.js';
import { ServerIdentifier } from '../../context/types.js';

const schema = z.object({
  from_server: z.string().optional().describe('Filter by source MCP server ID'),
  tool_name: z.string().optional().describe('Filter by tool name'),
  limit: z.number().min(1).max(50).default(10).describe('Max entries to return'),
});

export const getSharedContextTool: UnifiedTool = {
  name: 'get-shared-context',
  description: 'Get context shared by other MCP servers (database info, API docs, model info)',
  zodSchema: schema,
  skipContextShare: true, // Don't share this tool's output
  execute: async (args) => {
    const fromServer = args.from_server as string | undefined;
    const toolName = args.tool_name as string | undefined;
    const limit = typeof args.limit === 'number' ? args.limit : 10;

    if (!isContextEnabled()) {
      return JSON.stringify(
        {
          success: false,
          message: 'Context sharing is disabled. Start server with --redis-host to enable.',
        },
        null,
        2
      );
    }

    const sessionId = getSessionId();
    let entries = fromServer
      ? await getContextFromServer(fromServer as ServerIdentifier, limit)
      : await getSessionContext(limit);

    // Filter by tool name if specified
    if (toolName) {
      entries = entries.filter((e) => e.toolName.includes(toolName));
    }

    // Format for display
    const formatted = entries.map((entry) => ({
      id: entry.id,
      server: entry.serverId,
      tool: entry.toolName,
      summary: entry.summary,
      tags: entry.tags,
      timestamp: new Date(entry.timestamp).toISOString(),
      age: `${Math.round((Date.now() - entry.timestamp) / 1000)}s ago`,
      output: entry.output,
    }));

    // Group by server
    const byServer: Record<string, typeof formatted> = {};
    for (const entry of formatted) {
      if (!byServer[entry.server]) {
        byServer[entry.server] = [];
      }
      byServer[entry.server].push(entry);
    }

    return JSON.stringify(
      {
        success: true,
        session_id: sessionId,
        total_entries: entries.length,
        servers: Object.keys(byServer),
        entries: formatted,
        by_server: byServer,
      },
      null,
      2
    );
  },
};
