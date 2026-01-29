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
 * MPC (Multi-Party Computation) Type Definitions
 *
 * Types for Shamir Secret Sharing based threshold cryptography
 * for secure secret distribution among agents.
 */

/**
 * Individual share from Shamir Secret Sharing
 */
export interface MpcShare {
  /** Unique share identifier */
  id: string;
  /** Index of this share (1-based for Shamir) */
  index: number;
  /** The share data (hex-encoded) */
  data: string;
  /** Agent ID this share is assigned to */
  agentId: string;
  /** Secret ID this share belongs to */
  secretId: string;
  /** Session ID */
  sessionId: string;
  /** When the share was created */
  createdAt: number;
  /** Optional encryption metadata */
  encrypted?: boolean;
  /** IV if encrypted */
  iv?: string;
}

/**
 * Metadata about a shared secret
 */
export interface MpcSecretMetadata {
  /** Unique secret identifier */
  id: string;
  /** Session this secret belongs to */
  sessionId: string;
  /** Total number of shares created */
  totalShares: number;
  /** Minimum shares required to reconstruct */
  threshold: number;
  /** Agent IDs holding shares */
  holders: string[];
  /** Who created/split the secret */
  creatorAgentId: string;
  /** When the secret was split */
  createdAt: number;
  /** Optional TTL in seconds */
  ttl?: number;
  /** Human-readable label */
  label?: string;
  /** Optional tags for categorization */
  tags?: string[];
  /** Secret type hint */
  secretType?: 'api-key' | 'password' | 'private-key' | 'generic';
  /** Hash of original secret for verification */
  verificationHash?: string;
}

/**
 * Configuration for splitting a secret
 */
export interface MpcSplitConfig {
  /** The secret to split */
  secret: string;
  /** Total number of shares to create */
  totalShares: number;
  /** Minimum shares needed to reconstruct */
  threshold: number;
  /** Session ID */
  sessionId: string;
  /** Agent who is splitting */
  creatorAgentId: string;
  /** Optional label */
  label?: string;
  /** Optional TTL in seconds */
  ttl?: number;
  /** Optional tags */
  tags?: string[];
  /** Secret type hint */
  secretType?: MpcSecretMetadata['secretType'];
}

/**
 * Result of splitting a secret
 */
export interface MpcSplitResult {
  /** The secret metadata */
  metadata: MpcSecretMetadata;
  /** Generated shares (not yet distributed) */
  shares: MpcShare[];
}

/**
 * Distribution assignment
 */
export interface MpcDistribution {
  /** Secret ID */
  secretId: string;
  /** Share index to agent mapping */
  assignments: Array<{
    shareIndex: number;
    agentId: string;
  }>;
}

/**
 * Request to collect shares for reconstruction
 */
export interface MpcReconstructRequest {
  /** Secret ID to reconstruct */
  secretId: string;
  /** Session ID */
  sessionId: string;
  /** Agent requesting reconstruction */
  requestingAgentId: string;
  /** Agent IDs to request shares from */
  targetAgentIds?: string[];
}

/**
 * Result of reconstruction attempt
 */
export interface MpcReconstructResult {
  /** Whether reconstruction succeeded */
  success: boolean;
  /** The reconstructed secret (if successful) */
  secret?: string;
  /** Number of shares collected */
  sharesCollected: number;
  /** Threshold required */
  thresholdRequired: number;
  /** Error message if failed */
  error?: string;
}

/**
 * Status of a secret
 */
export interface MpcSecretStatus {
  /** Secret metadata */
  metadata: MpcSecretMetadata;
  /** Distribution status per agent */
  distribution: Array<{
    agentId: string;
    shareIndex: number;
    delivered: boolean;
    acknowledgedAt?: number;
  }>;
  /** Whether enough shares exist to reconstruct */
  reconstructable: boolean;
  /** Agents that have acknowledged receipt */
  acknowledgedCount: number;
}

/**
 * MPC-specific message types for inter-agent communication
 */
export type MpcMessageType =
  | 'mpc-share-request'
  | 'mpc-share-response'
  | 'mpc-share-delivery'
  | 'mpc-share-acknowledgment'
  | 'mpc-reconstruct-request'
  | 'mpc-reconstruct-contribution';

/**
 * MPC share request message
 */
export interface MpcShareRequestMessage {
  type: 'mpc-share-request';
  secretId: string;
  requestingAgentId: string;
  reason?: string;
}

/**
 * MPC share response message
 */
export interface MpcShareResponseMessage {
  type: 'mpc-share-response';
  secretId: string;
  shareIndex: number;
  shareData: string;
  fromAgentId: string;
}

/**
 * Redis key patterns for MPC
 */
export const MPC_KEYS = {
  /** Share storage: mpc:shares:{sessionId}:{secretId}:{agentId} */
  share: (sessionId: string, secretId: string, agentId: string) =>
    `mpc:shares:${sessionId}:${secretId}:${agentId}`,

  /** Secret metadata: mpc:secrets:{sessionId}:{secretId} */
  secret: (sessionId: string, secretId: string) => `mpc:secrets:${sessionId}:${secretId}`,

  /** Agent's secrets index: mpc:index:agent:{agentId} */
  agentIndex: (agentId: string) => `mpc:index:agent:${agentId}`,

  /** Session's secrets index: mpc:index:session:{sessionId} */
  sessionIndex: (sessionId: string) => `mpc:index:session:${sessionId}`,

  /** Pending share requests: mpc:pending:{secretId} */
  pending: (secretId: string) => `mpc:pending:${secretId}`,
} as const;

/**
 * Agent roles allowed to perform MPC operations
 */
export const MPC_ALLOWED_ROLES = {
  split: ['supervisor', 'coordinator'] as const,
  distribute: ['supervisor', 'coordinator'] as const,
  reconstruct: ['supervisor', 'coordinator'] as const,
  viewStatus: ['supervisor', 'coordinator', 'worker', 'specialist'] as const,
} as const;
