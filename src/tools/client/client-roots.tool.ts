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

import { z } from 'zod';
import type { UnifiedTool } from '../registry.js';
import { clientListRoots, hasCapability, getClientVersion } from '../../client/bridge.js';

const schema = z.object({});

export const clientRootsTool: UnifiedTool = {
  name: 'client-roots',
  description:
    'List workspace roots (directories/projects) from the connected MCP client. ' +
    'Returns file URIs and optional names for each root the client has open.',
  zodSchema: schema,
  skipContextShare: true,
  metadata: {
    category: 'client',
    tags: ['client', 'roots', 'workspace', 'mcp'],
    relatedTools: ['client-sampling', 'client-elicit', 'project-info'],
  },
  execute: async () => {
    if (!hasCapability('roots')) {
      return JSON.stringify({
        error: 'Client does not support roots/list',
        client: getClientVersion(),
        hint: 'Roots listing requires client-side support. Check if your client advertises the roots capability.',
      });
    }

    try {
      const result = await Promise.race([
        clientListRoots(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('roots/list request timed out')), 5000),
        ),
      ]);

      return JSON.stringify(
        {
          roots: result.roots.map((r) => ({
            uri: r.uri,
            name: r.name || undefined,
          })),
          count: result.roots.length,
        },
        null,
        2,
      );
    } catch (err) {
      return JSON.stringify({
        error: `roots/list failed: ${err instanceof Error ? err.message : err}`,
        client: getClientVersion(),
        hint: 'The client may advertise roots capability but not fully implement it.',
      });
    }
  },
};
