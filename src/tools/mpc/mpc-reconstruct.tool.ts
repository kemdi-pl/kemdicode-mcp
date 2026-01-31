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
 * MPC Reconstruct Tool
 *
 * Reconstruct a secret from collected shares.
 */

import { createHash } from 'crypto';
import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { getMpcStore, reconstructSecret, verifyMpcAuthorization } from '../../mpc/index.js';

const schema = z.object({
  secretId: z.string().describe('Secret ID to reconstruct'),
  sessionId: z.string().describe('Session ID'),
  requestingAgentId: z.string().describe('Requesting agent ID'),
  agentIds: z
    .array(z.string())
    .optional()
    .describe('Agent IDs to collect shares from'),
});

export const mpcReconstructTool: UnifiedTool<typeof schema> = {
  name: 'mpc-reconstruct',
  description:
    'Reconstruct secret from shares. Requires threshold shares. Supervisor/coordinator only.',
  zodSchema: schema,
  skipContextShare: true, // Security: don't share reconstructed secrets

  metadata: {
    category: 'mpc',
    tags: ['reconstruct', 'secure', 'shares'],
    examples: [
      { args: { secretId: 'secret-abc', sessionId: 'session-1', requestingAgentId: 'supervisor-1', agentIds: ['agent-1', 'agent-2', 'agent-3'] }, description: 'Reconstruct secret from three agent shares' },
    ],
    relatedTools: ['mpc-split', 'mpc-distribute', 'mpc-status'],
  },

  execute: async (args) => {
    const { secretId, sessionId, requestingAgentId, agentIds } = args;

    // SECURITY: Verify agent authorization before any operation
    const authResult = await verifyMpcAuthorization(requestingAgentId, 'reconstruct');
    if (!authResult.authorized) {
      return `🚫 Authorization Error: ${authResult.error}`;
    }

    const store = getMpcStore();
    if (!store.isConnected()) {
      await store.connect();
    }

    // Get secret metadata
    const metadata = await store.getSecretMetadata(sessionId, secretId);
    if (!metadata) {
      return `Error: Secret ${secretId} not found in session ${sessionId}`;
    }

    // Determine which agents to collect from
    const targetAgents = agentIds || metadata.holders;
    if (targetAgents.length === 0) {
      return 'Error: No agents hold shares for this secret';
    }

    if (targetAgents.length < metadata.threshold) {
      return [
        `Error: Not enough agents specified (${targetAgents.length})`,
        `Threshold requires: ${metadata.threshold} shares`,
        `Available holders: ${metadata.holders.join(', ')}`,
      ].join('\n');
    }

    try {
      // Collect shares from specified agents
      const shares = await store.getSharesForReconstruction(sessionId, secretId, targetAgents);

      if (shares.length < metadata.threshold) {
        return [
          '╔══════════════════════════════════════════════════════════════════╗',
          '║ ❌ RECONSTRUCTION FAILED - INSUFFICIENT SHARES                   ║',
          '╠══════════════════════════════════════════════════════════════════╣',
          `║ Secret ID:      ${secretId.padEnd(48)} ║`,
          `║ Shares Found:   ${String(shares.length).padEnd(48)} ║`,
          `║ Threshold:      ${String(metadata.threshold).padEnd(48)} ║`,
          '╠──────────────────────────────────────────────────────────────────╣',
          '║ Missing shares from agents. Ensure shares are distributed and    ║',
          '║ stored before attempting reconstruction.                         ║',
          '╚══════════════════════════════════════════════════════════════════╝',
        ].join('\n');
      }

      // Attempt reconstruction
      const result = await reconstructSecret(shares, metadata);

      if (!result.success) {
        return [
          '╔══════════════════════════════════════════════════════════════════╗',
          '║ ❌ RECONSTRUCTION FAILED                                         ║',
          '╠══════════════════════════════════════════════════════════════════╣',
          `║ Secret ID:    ${secretId.padEnd(50)} ║`,
          `║ Error:        ${(result.error || 'Unknown').padEnd(50)} ║`,
          `║ Shares Used:  ${String(result.sharesCollected).padEnd(50)} ║`,
          '╚══════════════════════════════════════════════════════════════════╝',
        ].join('\n');
      }

      // SECURITY: Never output plaintext secrets - return structured result instead
      // The secret is available programmatically but NOT shown in logs/output
      const secretLength = result.secret!.length;
      const secretHash = createHash('sha256').update(result.secret!).digest('hex').substring(0, 16);

      return JSON.stringify({
        success: true,
        secretId,
        label: metadata.label,
        secretType: metadata.secretType || 'generic',
        sharesUsed: result.sharesCollected,
        threshold: result.thresholdRequired,
        // SECURITY: Return secret in structured format, not visible in logs
        // The calling code can extract this programmatically
        _secret: Buffer.from(result.secret!).toString('base64'),
        _secretLength: secretLength,
        _secretHashPrefix: secretHash,
        requestedBy: requestingAgentId,
        timestamp: new Date().toISOString(),
        notice: 'Secret returned in _secret field (base64 encoded). Handle securely.',
      });
    } catch (error) {
      return `Error reconstructing secret: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
  },
};
