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
 * MPC Share Manager
 *
 * Manages splitting secrets into shares and reconstructing them using
 * Shamir's Secret Sharing scheme.
 */

import { split, combine } from 'shamir-secret-sharing';
import { randomBytes } from 'crypto';
import type {
  MpcShare,
  MpcSecretMetadata,
  MpcSplitConfig,
  MpcSplitResult,
  MpcDistribution,
  MpcReconstructResult,
} from './types.js';
import {
  generateSecretId,
  generateShareId,
  generateVerificationHash,
  verifySecretHash,
} from './crypto.js';

/**
 * Convert string to Uint8Array
 */
function stringToBytes(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

/**
 * Convert Uint8Array to string
 */
function bytesToString(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/**
 * Convert Uint8Array to hex string
 */
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Convert hex string to Uint8Array
 */
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Split a secret into shares
 */
export async function splitSecret(config: MpcSplitConfig): Promise<MpcSplitResult> {
  const {
    secret,
    totalShares,
    threshold,
    sessionId,
    creatorAgentId,
    label,
    ttl,
    tags,
    secretType,
  } = config;

  // Validate parameters
  if (totalShares < 2 || totalShares > 255) {
    throw new Error('Total shares must be between 2 and 255');
  }
  if (threshold < 2 || threshold > totalShares) {
    throw new Error('Threshold must be between 2 and totalShares');
  }
  if (!secret || secret.length === 0) {
    throw new Error('Secret cannot be empty');
  }

  // Generate secret ID
  const secretId = generateSecretId();
  const now = Date.now();

  // Convert secret to bytes and split
  const secretBytes = stringToBytes(secret);
  const shareBytes = await split(secretBytes, totalShares, threshold);

  // Create share objects
  const shares: MpcShare[] = shareBytes.map((shareData, index) => ({
    id: generateShareId(secretId, index + 1),
    index: index + 1, // 1-based indexing
    data: bytesToHex(shareData),
    agentId: '', // Will be assigned during distribution
    secretId,
    sessionId,
    createdAt: now,
    encrypted: false,
  }));

  // Create metadata
  const metadata: MpcSecretMetadata = {
    id: secretId,
    sessionId,
    totalShares,
    threshold,
    holders: [],
    creatorAgentId,
    createdAt: now,
    ttl,
    label,
    tags,
    secretType,
    verificationHash: generateVerificationHash(secret),
  };

  return { metadata, shares };
}

/**
 * Distribute shares to agents
 */
export function distributeShares(
  shares: MpcShare[],
  distribution: MpcDistribution
): { distributedShares: MpcShare[]; holders: string[] } {
  const { assignments } = distribution;

  // Validate assignments
  const assignedIndices = new Set<number>();
  const holders: string[] = [];

  for (const assignment of assignments) {
    if (assignedIndices.has(assignment.shareIndex)) {
      throw new Error(`Share index ${assignment.shareIndex} assigned multiple times`);
    }
    assignedIndices.add(assignment.shareIndex);
  }

  // Apply assignments
  const distributedShares = shares.map((share) => {
    const assignment = assignments.find((a) => a.shareIndex === share.index);
    if (assignment) {
      holders.push(assignment.agentId);
      return {
        ...share,
        agentId: assignment.agentId,
      };
    }
    return share;
  });

  return { distributedShares, holders };
}

/**
 * Validate shares before reconstruction
 */
export function validateSharesForReconstruction(
  shares: MpcShare[],
  metadata: MpcSecretMetadata
): { valid: boolean; error?: string } {
  // Check if we have enough shares
  if (shares.length < metadata.threshold) {
    return {
      valid: false,
      error: `Need at least ${metadata.threshold} shares, but only have ${shares.length}`,
    };
  }

  // Check if all shares belong to the same secret
  const secretIds = new Set(shares.map((s) => s.secretId));
  if (secretIds.size > 1) {
    return {
      valid: false,
      error: 'Shares belong to different secrets',
    };
  }

  // Check for duplicate indices
  const indices = shares.map((s) => s.index);
  const uniqueIndices = new Set(indices);
  if (uniqueIndices.size !== indices.length) {
    return {
      valid: false,
      error: 'Duplicate share indices detected',
    };
  }

  // Check indices are valid
  for (const index of indices) {
    if (index < 1 || index > metadata.totalShares) {
      return {
        valid: false,
        error: `Invalid share index: ${index}`,
      };
    }
  }

  return { valid: true };
}

/**
 * Reconstruct a secret from shares
 */
export async function reconstructSecret(
  shares: MpcShare[],
  metadata: MpcSecretMetadata
): Promise<MpcReconstructResult> {
  // Validate shares
  const validation = validateSharesForReconstruction(shares, metadata);
  if (!validation.valid) {
    return {
      success: false,
      sharesCollected: shares.length,
      thresholdRequired: metadata.threshold,
      error: validation.error,
    };
  }

  try {
    // Convert shares back to Uint8Array
    // Sort shares by index to ensure consistent reconstruction
    const sortedShares = [...shares].sort((a, b) => a.index - b.index);
    const shareBytes = sortedShares.map((s) => hexToBytes(s.data));

    // Reconstruct the secret
    const secretBytes = await combine(shareBytes);
    const secret = bytesToString(secretBytes);

    // Verify the reconstructed secret
    if (metadata.verificationHash) {
      if (!verifySecretHash(secret, metadata.verificationHash)) {
        return {
          success: false,
          sharesCollected: shares.length,
          thresholdRequired: metadata.threshold,
          error: 'Reconstructed secret verification failed',
        };
      }
    }

    return {
      success: true,
      secret,
      sharesCollected: shares.length,
      thresholdRequired: metadata.threshold,
    };
  } catch (error) {
    return {
      success: false,
      sharesCollected: shares.length,
      thresholdRequired: metadata.threshold,
      error: error instanceof Error ? error.message : 'Unknown reconstruction error',
    };
  }
}

/**
 * Generate a random secret for testing
 */
export function generateRandomSecret(length: number = 32): string {
  return randomBytes(length).toString('hex');
}

/**
 * Check if an agent role can perform an MPC operation
 */
export function canPerformMpcOperation(
  operation: 'split' | 'distribute' | 'reconstruct' | 'viewStatus',
  role: string
): boolean {
  const allowedRoles: Record<string, readonly string[]> = {
    split: ['supervisor', 'coordinator'],
    distribute: ['supervisor', 'coordinator'],
    reconstruct: ['supervisor', 'coordinator'],
    viewStatus: ['supervisor', 'coordinator', 'worker', 'specialist'],
  };

  const allowed = allowedRoles[operation];
  return allowed ? allowed.includes(role) : false;
}

/**
 * Calculate share distribution statistics
 */
export function calculateDistributionStats(metadata: MpcSecretMetadata): {
  totalShares: number;
  distributed: number;
  threshold: number;
  reconstructable: boolean;
  redundancy: number;
} {
  const distributed = metadata.holders.length;
  return {
    totalShares: metadata.totalShares,
    distributed,
    threshold: metadata.threshold,
    reconstructable: distributed >= metadata.threshold,
    redundancy: distributed - metadata.threshold,
  };
}
