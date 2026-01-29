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
 * MPC Redis Store
 *
 * Persistent storage for MPC shares and secret metadata using Redis.
 */

import { RedisBackedService } from '../infrastructure/redis/redis-backed-service.js';
import type { MpcShare, MpcSecretMetadata, MpcSecretStatus } from './types.js';
import { MPC_KEYS } from './types.js';
import { getKeyManager, type EncryptedData } from './crypto.js';

/**
 * MPC Redis Store configuration
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface MpcRedisStoreConfig {
}

/**
 * MPC Redis Store
 */
export class MpcRedisStore extends RedisBackedService {
  protected get serviceName() { return 'MpcRedisStore'; }

  constructor(_config: MpcRedisStoreConfig = {}) {
    super();
  }

  /**
   * Save secret metadata
   */
  async saveSecretMetadata(metadata: MpcSecretMetadata): Promise<boolean> {
    if (!this.isConnected() || !this.redis) return false;

    try {
      const key = MPC_KEYS.secret(metadata.sessionId, metadata.id);
      await this.redis.hset(key, {
        ...metadata,
        holders: JSON.stringify(metadata.holders),
        tags: JSON.stringify(metadata.tags || []),
      });

      // Set TTL if specified
      if (metadata.ttl) {
        await this.redis.expire(key, metadata.ttl);
      }

      // Add to session index
      const sessionIndexKey = MPC_KEYS.sessionIndex(metadata.sessionId);
      await this.redis.sadd(sessionIndexKey, metadata.id);

      return true;
    } catch (error) {
      console.error('[MPC Store] Error saving secret metadata:', error);
      return false;
    }
  }

  /**
   * Get secret metadata
   */
  async getSecretMetadata(sessionId: string, secretId: string): Promise<MpcSecretMetadata | null> {
    if (!this.isConnected() || !this.redis) return null;

    try {
      const key = MPC_KEYS.secret(sessionId, secretId);
      const data = await this.redis.hgetall(key);

      if (!data || Object.keys(data).length === 0) {
        return null;
      }

      return {
        id: data.id,
        sessionId: data.sessionId,
        totalShares: parseInt(data.totalShares, 10),
        threshold: parseInt(data.threshold, 10),
        holders: JSON.parse(data.holders || '[]'),
        creatorAgentId: data.creatorAgentId,
        createdAt: parseInt(data.createdAt, 10),
        ttl: data.ttl ? parseInt(data.ttl, 10) : undefined,
        label: data.label || undefined,
        tags: JSON.parse(data.tags || '[]'),
        secretType: data.secretType as MpcSecretMetadata['secretType'],
        verificationHash: data.verificationHash || undefined,
      };
    } catch (error) {
      console.error('[MPC Store] Error getting secret metadata:', error);
      return null;
    }
  }

  /**
   * Update holders list in metadata
   */
  async updateHolders(sessionId: string, secretId: string, holders: string[]): Promise<boolean> {
    if (!this.isConnected() || !this.redis) return false;

    try {
      const key = MPC_KEYS.secret(sessionId, secretId);
      await this.redis.hset(key, 'holders', JSON.stringify(holders));
      return true;
    } catch (error) {
      console.error('[MPC Store] Error updating holders:', error);
      return false;
    }
  }

  /**
   * Save a share (always encrypted)
   *
   * SECURITY: Shares are always encrypted with AES-256-GCM using session-derived keys.
   * Plaintext storage is not supported to prevent accidental data exposure.
   */
  async saveShare(share: MpcShare): Promise<boolean> {
    if (!this.isConnected() || !this.redis) return false;

    try {
      const key = MPC_KEYS.share(share.sessionId, share.secretId, share.agentId);

      // Always encrypt shares - plaintext storage is a security risk
      const keyManager = getKeyManager();
      const encrypted = keyManager.encryptForSession(share.sessionId, share.data);
      const shareData: Record<string, string | number | boolean> = {
        id: share.id,
        index: share.index,
        data: JSON.stringify(encrypted),
        agentId: share.agentId,
        secretId: share.secretId,
        sessionId: share.sessionId,
        createdAt: share.createdAt,
        encrypted: true,
      };

      await this.redis.hset(key, shareData);

      // Add to agent index
      const agentIndexKey = MPC_KEYS.agentIndex(share.agentId);
      await this.redis.sadd(agentIndexKey, share.secretId);

      return true;
    } catch (error) {
      console.error('[MPC Store] Error saving share:', error);
      return false;
    }
  }

  /**
   * Get a share (decrypted)
   */
  async getShare(sessionId: string, secretId: string, agentId: string): Promise<MpcShare | null> {
    if (!this.isConnected() || !this.redis) return null;

    try {
      const key = MPC_KEYS.share(sessionId, secretId, agentId);
      const data = await this.redis.hgetall(key);

      if (!data || Object.keys(data).length === 0) {
        return null;
      }

      let shareData = data.data;
      const isEncrypted = data.encrypted === 'true' || data.encrypted === '1';

      if (isEncrypted) {
        try {
          const keyManager = getKeyManager();
          // SECURITY: Validate JSON structure before parsing
          let encrypted: EncryptedData;
          try {
            const parsed = JSON.parse(data.data);
            // Validate required EncryptedData fields
            if (
              typeof parsed !== 'object' ||
              parsed === null ||
              typeof parsed.ciphertext !== 'string' ||
              typeof parsed.iv !== 'string' ||
              typeof parsed.authTag !== 'string'
            ) {
              throw new Error('Invalid encrypted data structure');
            }
            encrypted = parsed as EncryptedData;
          } catch (parseError) {
            console.error('[MPC Store] Invalid JSON in encrypted share:', parseError);
            return null;
          }
          shareData = keyManager.decryptForSession(sessionId, encrypted);
        } catch (decryptError) {
          console.error('[MPC Store] Error decrypting share:', decryptError);
          return null;
        }
      }

      return {
        id: data.id,
        index: parseInt(data.index, 10),
        data: shareData,
        agentId: data.agentId,
        secretId: data.secretId,
        sessionId: data.sessionId,
        createdAt: parseInt(data.createdAt, 10),
        encrypted: isEncrypted,
      };
    } catch (error) {
      console.error('[MPC Store] Error getting share:', error);
      return null;
    }
  }

  /**
   * Get all shares for a secret from specific agents
   */
  async getSharesForReconstruction(
    sessionId: string,
    secretId: string,
    agentIds: string[]
  ): Promise<MpcShare[]> {
    const shares: MpcShare[] = [];

    for (const agentId of agentIds) {
      const share = await this.getShare(sessionId, secretId, agentId);
      if (share) {
        shares.push(share);
      }
    }

    return shares;
  }

  /**
   * Get all secrets for a session
   */
  async getSessionSecrets(sessionId: string): Promise<MpcSecretMetadata[]> {
    if (!this.isConnected() || !this.redis) return [];

    try {
      const indexKey = MPC_KEYS.sessionIndex(sessionId);
      const secretIds = await this.redis.smembers(indexKey);

      const secrets: MpcSecretMetadata[] = [];
      for (const secretId of secretIds) {
        const metadata = await this.getSecretMetadata(sessionId, secretId);
        if (metadata) {
          secrets.push(metadata);
        }
      }

      return secrets;
    } catch (error) {
      console.error('[MPC Store] Error getting session secrets:', error);
      return [];
    }
  }

  /**
   * Get secrets held by an agent
   */
  async getAgentSecrets(agentId: string): Promise<string[]> {
    if (!this.isConnected() || !this.redis) return [];

    try {
      const indexKey = MPC_KEYS.agentIndex(agentId);
      return await this.redis.smembers(indexKey);
    } catch (error) {
      console.error('[MPC Store] Error getting agent secrets:', error);
      return [];
    }
  }

  /**
   * Get secret status including distribution info
   */
  async getSecretStatus(sessionId: string, secretId: string): Promise<MpcSecretStatus | null> {
    const metadata = await this.getSecretMetadata(sessionId, secretId);
    if (!metadata) return null;

    const distribution: MpcSecretStatus['distribution'] = [];

    for (const agentId of metadata.holders) {
      const share = await this.getShare(sessionId, secretId, agentId);
      distribution.push({
        agentId,
        shareIndex: share?.index || 0,
        delivered: share !== null,
        acknowledgedAt: share?.createdAt,
      });
    }

    return {
      metadata,
      distribution,
      reconstructable: distribution.filter((d) => d.delivered).length >= metadata.threshold,
      acknowledgedCount: distribution.filter((d) => d.delivered).length,
    };
  }

  /**
   * Delete a secret and all its shares
   */
  async deleteSecret(sessionId: string, secretId: string): Promise<boolean> {
    if (!this.isConnected() || !this.redis) return false;

    try {
      const metadata = await this.getSecretMetadata(sessionId, secretId);
      if (!metadata) return false;

      // Delete all shares
      for (const agentId of metadata.holders) {
        const shareKey = MPC_KEYS.share(sessionId, secretId, agentId);
        await this.redis.del(shareKey);

        // Remove from agent index
        const agentIndexKey = MPC_KEYS.agentIndex(agentId);
        await this.redis.srem(agentIndexKey, secretId);
      }

      // Delete metadata
      const metadataKey = MPC_KEYS.secret(sessionId, secretId);
      await this.redis.del(metadataKey);

      // Remove from session index
      const sessionIndexKey = MPC_KEYS.sessionIndex(sessionId);
      await this.redis.srem(sessionIndexKey, secretId);

      return true;
    } catch (error) {
      console.error('[MPC Store] Error deleting secret:', error);
      return false;
    }
  }

}

// Singleton instance
let mpcStore: MpcRedisStore | null = null;

/**
 * Get the global MPC store
 */
export function getMpcStore(): MpcRedisStore {
  if (!mpcStore) {
    mpcStore = new MpcRedisStore();
  }
  return mpcStore;
}

/**
 * Reset the global MPC store (for testing)
 */
export function resetMpcStore(): void {
  if (mpcStore) {
    mpcStore.disconnect().catch(console.error);
  }
  mpcStore = null;
}
