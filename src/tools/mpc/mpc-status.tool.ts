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
 * MPC Status Tool
 *
 * View status of a shared secret including distribution info.
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import {
  getMpcStore,
  calculateDistributionStats,
  verifyMpcAuthorization,
} from '../../mpc/index.js';

const schema = z.object({
  secretId: z.string().optional().describe('Specific secret ID to check'),
  sessionId: z.string().describe('Session ID'),
  agentId: z.string().optional().describe('Filter by agent holding shares'),
  viewingAgentId: z
    .string()
    .optional()
    .describe('Agent ID viewing status (for authorization). Defaults to agentId if provided.'),
});

export const mpcStatusTool: UnifiedTool<typeof schema> = {
  name: 'mpc-status',
  description:
    'View status of shared secrets including distribution, holders, and reconstructability.',
  zodSchema: schema,
  skipContextShare: true,

  execute: async (args) => {
    const { secretId, sessionId, agentId, viewingAgentId } = args;

    // SECURITY: Verify agent authorization (viewStatus allows more roles)
    const agentForAuth = viewingAgentId || agentId;
    if (agentForAuth) {
      const authResult = await verifyMpcAuthorization(agentForAuth, 'viewStatus');
      if (!authResult.authorized) {
        return `🚫 Authorization Error: ${authResult.error}`;
      }
    }
    // Note: If no agent specified, we allow viewing session-level info
    // This could be tightened in production

    const store = getMpcStore();
    if (!store.isConnected()) {
      await store.connect();
    }

    // If specific secret requested
    if (secretId) {
      const status = await store.getSecretStatus(sessionId, secretId);
      if (!status) {
        return `Secret ${secretId} not found in session ${sessionId}`;
      }

      const stats = calculateDistributionStats(status.metadata);
      const holdersList = status.distribution
        .map(
          (d) =>
            `║   ${d.agentId}: Share #${d.shareIndex} ${d.delivered ? '✓' : '✗'}`.padEnd(66) + ' ║'
        )
        .join('\n');

      return [
        '╔══════════════════════════════════════════════════════════════════╗',
        '║ 🔐 SECRET STATUS                                                 ║',
        '╠══════════════════════════════════════════════════════════════════╣',
        `║ Secret ID:      ${status.metadata.id.padEnd(48)} ║`,
        `║ Session:        ${sessionId.padEnd(48)} ║`,
        status.metadata.label ? `║ Label:          ${status.metadata.label.padEnd(48)} ║` : null,
        `║ Type:           ${(status.metadata.secretType || 'generic').padEnd(48)} ║`,
        `║ Created:        ${new Date(status.metadata.createdAt).toISOString().padEnd(48)} ║`,
        `║ Creator:        ${status.metadata.creatorAgentId.padEnd(48)} ║`,
        '╠──────────────────────────────────────────────────────────────────╣',
        `║ Total Shares:   ${String(stats.totalShares).padEnd(48)} ║`,
        `║ Distributed:    ${String(stats.distributed).padEnd(48)} ║`,
        `║ Threshold:      ${String(stats.threshold).padEnd(48)} ║`,
        `║ Redundancy:     ${String(Math.max(0, stats.redundancy)).padEnd(48)} ║`,
        `║ Reconstructable: ${(stats.reconstructable ? '✅ Yes' : '❌ No').padEnd(47)} ║`,
        '╠──────────────────────────────────────────────────────────────────╣',
        '║ Holders:                                                         ║',
        holdersList || '║   (none)                                                         ║',
        '╚══════════════════════════════════════════════════════════════════╝',
      ]
        .filter(Boolean)
        .join('\n');
    }

    // List all secrets for session (optionally filtered by agent)
    let secrets = await store.getSessionSecrets(sessionId);

    if (agentId) {
      const agentSecretIds = await store.getAgentSecrets(agentId);
      const agentSecretSet = new Set(agentSecretIds);
      secrets = secrets.filter((s) => agentSecretSet.has(s.id));
    }

    if (secrets.length === 0) {
      if (agentId) {
        return `No secrets found for agent ${agentId} in session ${sessionId}`;
      }
      return `No secrets found in session ${sessionId}`;
    }

    const secretRows = secrets
      .map((s) => {
        const stats = calculateDistributionStats(s);
        const statusIcon = stats.reconstructable ? '✅' : '⚠️';
        const label = s.label ? ` (${s.label})` : '';
        return (
          `║ ${statusIcon} ${s.id}${label}`.padEnd(66) +
          ' ║\n' +
          `║    ${stats.distributed}/${stats.totalShares} shares, threshold: ${stats.threshold}`.padEnd(
            66
          ) +
          ' ║'
        );
      })
      .join('\n');

    return [
      '╔══════════════════════════════════════════════════════════════════╗',
      `║ 🔐 SECRETS IN SESSION`.padEnd(67) + '║',
      `║    Session: ${sessionId}`.padEnd(67) + '║',
      agentId ? `║    Filter: Agent ${agentId}`.padEnd(67) + '║' : null,
      '╠══════════════════════════════════════════════════════════════════╣',
      secretRows,
      '╠──────────────────────────────────────────────────────────────────╣',
      `║ Total: ${secrets.length} secret(s)`.padEnd(67) + '║',
      '║ ✅ = reconstructable, ⚠️ = needs more shares                      ║',
      '╚══════════════════════════════════════════════════════════════════╝',
    ]
      .filter(Boolean)
      .join('\n');
  },
};
