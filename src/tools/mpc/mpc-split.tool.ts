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
 * MPC Split Tool
 *
 * Split a secret into multiple shares using Shamir's Secret Sharing.
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { splitSecret, getMpcStore, verifyMpcAuthorization } from '../../mpc/index.js';

const schema = z.object({
  secret: z.string().min(1).describe('Secret to split'),
  totalShares: z
    .number()
    .int()
    .min(2)
    .max(255)
    .describe('Total shares to create'),
  threshold: z
    .number()
    .int()
    .min(2)
    .max(255)
    .describe('Min shares to reconstruct (must be <= totalShares)'),
  sessionId: z.string().describe('Session ID'),
  creatorAgentId: z.string().describe('Creator agent ID'),
  label: z.string().optional().describe('Secret label'),
  ttl: z.number().int().positive().optional().describe('TTL in seconds'),
  secretType: z
    .enum(['api-key', 'password', 'private-key', 'generic'])
    .default('generic')
    .describe('Secret type'),
  tags: z.array(z.string()).optional().describe('Categorization tags'),
});

export const mpcSplitTool: UnifiedTool<typeof schema> = {
  name: 'mpc-split',
  description:
    'Split secret into n shares with threshold t via Shamir Secret Sharing. Requires t shares to reconstruct.',
  zodSchema: schema,
  skipContextShare: true, // Security: don't share secrets to context

  execute: async (args) => {
    const {
      secret,
      totalShares,
      threshold,
      sessionId,
      creatorAgentId,
      label,
      ttl,
      secretType,
      tags,
    } = args;

    // SECURITY: Verify agent authorization
    const authResult = await verifyMpcAuthorization(creatorAgentId, 'split');
    if (!authResult.authorized) {
      return `🚫 Authorization Error: ${authResult.error}`;
    }

    // Validate threshold <= totalShares
    if (threshold > totalShares) {
      return `Error: Threshold (${threshold}) cannot be greater than total shares (${totalShares})`;
    }

    try {
      // Split the secret
      const result = await splitSecret({
        secret,
        totalShares,
        threshold,
        sessionId,
        creatorAgentId,
        label,
        ttl,
        tags,
        secretType,
      });

      // Store metadata
      const store = getMpcStore();
      if (!store.isConnected()) {
        await store.connect();
      }

      const saved = await store.saveSecretMetadata(result.metadata);
      if (!saved) {
        return 'Error: Failed to save secret metadata to Redis';
      }

      // Format share info (without revealing actual data)
      const shareInfo = result.shares.map((s) => `  Share #${s.index}: ${s.id}`).join('\n');

      return [
        '╔══════════════════════════════════════════════════════════════════╗',
        '║ 🔐 SECRET SPLIT SUCCESSFULLY                                     ║',
        '╠══════════════════════════════════════════════════════════════════╣',
        `║ Secret ID:    ${result.metadata.id.padEnd(50)} ║`,
        `║ Session:      ${sessionId.padEnd(50)} ║`,
        label ? `║ Label:        ${label.padEnd(50)} ║` : null,
        `║ Type:         ${secretType.padEnd(50)} ║`,
        '╠──────────────────────────────────────────────────────────────────╣',
        `║ Total Shares: ${String(totalShares).padEnd(50)} ║`,
        `║ Threshold:    ${String(threshold).padEnd(50)} ║`,
        ttl ? `║ TTL:          ${(ttl + ' seconds').padEnd(50)} ║` : null,
        '╠──────────────────────────────────────────────────────────────────╣',
        '║ Generated Shares:                                                ║',
        ...shareInfo.split('\n').map((line) => `║ ${line.padEnd(64)} ║`),
        '╠──────────────────────────────────────────────────────────────────╣',
        '║ Next Steps:                                                      ║',
        '║ 1. Use mpc-distribute to assign shares to agents                 ║',
        '║ 2. Shares will be encrypted and stored securely                  ║',
        '║ 3. Use mpc-reconstruct when you need the secret back             ║',
        '╚══════════════════════════════════════════════════════════════════╝',
      ]
        .filter(Boolean)
        .join('\n');
    } catch (error) {
      return `Error splitting secret: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
  },
};
