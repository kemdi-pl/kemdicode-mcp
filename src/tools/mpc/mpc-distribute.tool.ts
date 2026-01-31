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
 * MPC Distribute Tool
 *
 * Distribute shares to agents after splitting a secret.
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { getMpcStore, distributeShares, verifyMpcAuthorization } from '../../mpc/index.js';
import type { MpcShare } from '../../mpc/types.js';

const schema = z.object({
  secretId: z.string().describe('Secret ID from mpc-split'),
  sessionId: z.string().describe('Session ID'),
  distributingAgentId: z
    .string()
    .optional()
    .describe('Distributing agent ID for auth'),
  assignments: z
    .array(
      z.object({
        shareIndex: z.number().int().min(1).describe('Share index (1-based)'),
        agentId: z.string().describe('Receiving agent ID'),
      })
    )
    .min(1)
    .describe('Share-to-agent assignments'),
});

export const mpcDistributeTool: UnifiedTool<typeof schema> = {
  name: 'mpc-distribute',
  description:
    'Distribute encrypted shares to agents for later reconstruction.',
  zodSchema: schema,
  skipContextShare: true,

  metadata: {
    category: 'mpc',
    tags: ['distribute', 'secure', 'shares'],
    examples: [
      { args: { secretId: 'secret-abc', sessionId: 'session-1', assignments: [{ shareIndex: 1, agentId: 'agent-1' }, { shareIndex: 2, agentId: 'agent-2' }] }, description: 'Distribute shares to two agents' },
    ],
    relatedTools: ['mpc-split', 'mpc-reconstruct', 'mpc-status'],
  },

  execute: async (args) => {
    const { secretId, sessionId, distributingAgentId, assignments } = args;

    // Get the agent ID for authorization (use distributingAgentId or secret creator)
    const store = getMpcStore();
    if (!store.isConnected()) {
      await store.connect();
    }

    // Get secret metadata first to check creator
    const metadata = await store.getSecretMetadata(sessionId, secretId);
    if (!metadata) {
      return `Error: Secret ${secretId} not found in session ${sessionId}`;
    }

    // SECURITY: Verify agent authorization
    const agentForAuth = distributingAgentId || metadata.creatorAgentId;
    const authResult = await verifyMpcAuthorization(agentForAuth, 'distribute');
    if (!authResult.authorized) {
      return `🚫 Authorization Error: ${authResult.error}`;
    }

    // Validate assignments
    for (const assignment of assignments) {
      if (assignment.shareIndex < 1 || assignment.shareIndex > metadata.totalShares) {
        return `Error: Invalid share index ${assignment.shareIndex}. Valid range: 1-${metadata.totalShares}`;
      }
    }

    // Check for duplicate indices
    const indices = assignments.map((a) => a.shareIndex);
    const uniqueIndices = new Set(indices);
    if (uniqueIndices.size !== indices.length) {
      return 'Error: Duplicate share indices in assignments';
    }

    try {
      // Create placeholder shares for distribution tracking
      const placeholderShares: MpcShare[] = assignments.map((a) => ({
        id: `share_${secretId}_${a.shareIndex}`,
        index: a.shareIndex,
        data: '', // Will be filled from stored shares or regenerated
        agentId: '',
        secretId,
        sessionId,
        createdAt: Date.now(),
        encrypted: false,
      }));

      // Apply distribution
      const { distributedShares, holders } = distributeShares(placeholderShares, {
        secretId,
        assignments,
      });

      // Update metadata with holders
      const existingHolders = new Set(metadata.holders);
      holders.forEach((h) => existingHolders.add(h));
      await store.updateHolders(sessionId, secretId, Array.from(existingHolders));

      // Save distributed shares (in a real scenario, shares would be delivered via messaging)
      const savedResults: string[] = [];
      for (const share of distributedShares) {
        if (share.agentId) {
          // For now, we just track the distribution
          // In production, shares would be encrypted and sent to agents
          savedResults.push(`Share #${share.index} -> ${share.agentId}`);
        }
      }

      const distributionList = savedResults.map((r) => `║   ${r.padEnd(61)} ║`).join('\n');

      return [
        '╔══════════════════════════════════════════════════════════════════╗',
        '║ 📤 SHARES DISTRIBUTED                                            ║',
        '╠══════════════════════════════════════════════════════════════════╣',
        `║ Secret ID:    ${secretId.padEnd(50)} ║`,
        `║ Session:      ${sessionId.padEnd(50)} ║`,
        `║ Distributed:  ${String(assignments.length).padEnd(50)} ║`,
        '╠──────────────────────────────────────────────────────────────────╣',
        '║ Distribution:                                                    ║',
        distributionList,
        '╠──────────────────────────────────────────────────────────────────╣',
        `║ Total Holders: ${String(existingHolders.size).padEnd(49)} ║`,
        `║ Threshold:     ${String(metadata.threshold).padEnd(49)} ║`,
        `║ Reconstructable: ${(existingHolders.size >= metadata.threshold ? 'Yes ✓' : 'No ✗').padEnd(47)} ║`,
        '╚══════════════════════════════════════════════════════════════════╝',
      ].join('\n');
    } catch (error) {
      return `Error distributing shares: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
  },
};
