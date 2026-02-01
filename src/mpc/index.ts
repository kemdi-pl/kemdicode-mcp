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
 * MPC (Multi-Party Computation) Module
 *
 * Provides Shamir Secret Sharing based threshold cryptography
 * for secure secret distribution among agents.
 */

// Types
export type {
  MpcShare,
  MpcSecretMetadata,
  MpcSplitConfig,
  MpcSplitResult,
  MpcDistribution,
  MpcReconstructRequest,
  MpcReconstructResult,
  MpcSecretStatus,
  MpcMessageType,
  MpcShareRequestMessage,
  MpcShareResponseMessage,
} from './types.js';

export { MPC_KEYS, MPC_ALLOWED_ROLES } from './types.js';

// Crypto utilities
export {
  generateKey,
  generateIV,
  deriveKey,
  deriveSessionKey,
  encrypt,
  decrypt,
  sha256,
  generateVerificationHash,
  verifySecretHash,
  generateSecretId,
  generateShareId,
  encryptShare,
  decryptShare,
  MpcKeyManager,
  getKeyManager,
  resetKeyManager,
  type EncryptedData,
} from './crypto.js';

// Share management
export {
  splitSecret,
  distributeShares,
  validateSharesForReconstruction,
  reconstructSecret,
  generateRandomSecret,
  canPerformMpcOperation,
  calculateDistributionStats,
} from './share-manager.js';

// Redis store
export {
  MpcRedisStore,
  getMpcStore,
  resetMpcStore,
  type MpcRedisStoreConfig,
} from './redis-store.js';

// Authorization
export {
  verifyMpcAuthorization,
  requiresElevatedRole,
  getRequiredRolesDescription,
  generateAgentSignature,
  verifyAgentSignature,
  type MpcOperation,
  type MpcAuthResult,
} from './auth.js';
