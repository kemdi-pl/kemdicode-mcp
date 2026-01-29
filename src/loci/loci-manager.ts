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
 * Loci Manager
 *
 * Manages mnemonic locations (loci) in the memory palace.
 */

import { RedisBackedService } from '../infrastructure/redis/redis-backed-service.js';
import type { Loci, LociCategory, LociRecall, GraphNode, LociTemplate } from './types.js';
import { LOCI_KEYS, LOCI_TEMPLATES } from './types.js';
import { getGraphStorage } from './graph-storage.js';
import { randomBytes } from 'crypto';

/**
 * Loci Manager configuration
 */
export interface LociManagerConfig {
  /** TTL for loci in seconds */
  lociTtl?: number;
}

/**
 * Loci Manager
 */
export class LociManager extends RedisBackedService {
  protected get serviceName() { return 'LociManager'; }
  private config: LociManagerConfig;

  constructor(config: LociManagerConfig = {}) {
    super();
    this.config = {
      lociTtl: config.lociTtl || 7200,
    };
  }

  /**
   * Generate a unique loci ID
   */
  generateLociId(): string {
    return `loci_${Date.now()}_${randomBytes(4).toString('hex')}`;
  }

  /**
   * Create a new loci
   */
  async createLoci(
    name: string,
    description: string,
    category: LociCategory,
    sessionId: string,
    options: {
      associations?: string[];
      icon?: string;
      color?: string;
      parentLociId?: string;
      order?: number;
    } = {}
  ): Promise<Loci | null> {
    if (!this.isConnected() || !this.redis) return null;

    try {
      const loci: Loci = {
        id: this.generateLociId(),
        name,
        description,
        category,
        associations: options.associations || [],
        nodeIds: [],
        parentLociId: options.parentLociId,
        childLociIds: [],
        order: options.order || 0,
        sessionId,
        createdAt: Date.now(),
        icon: options.icon,
        color: options.color,
      };

      // Store loci
      const key = LOCI_KEYS.loci(loci.id);
      await this.redis.hset(key, this.serializeLoci(loci));

      // Add to name index
      const normalizedName = name.toLowerCase().replace(/\s+/g, '-');
      await this.redis.set(LOCI_KEYS.lociByName(normalizedName), loci.id);

      // Add to category index
      await this.redis.sadd(LOCI_KEYS.lociByCategory(category), loci.id);

      // Add to session index
      await this.redis.sadd(LOCI_KEYS.lociBySession(sessionId), loci.id);

      // If has parent, update parent's children
      if (options.parentLociId) {
        await this.addChildToLoci(options.parentLociId, loci.id);
      }

      // Set TTL
      await this.redis.expire(key, this.config.lociTtl!);

      return loci;
    } catch (error) {
      console.error('[LociManager] Error creating loci:', error);
      return null;
    }
  }

  /**
   * Create loci from a template
   */
  async createFromTemplate(
    templateName: string,
    sessionId: string,
    overrides: Partial<LociTemplate> = {}
  ): Promise<Loci | null> {
    const template = LOCI_TEMPLATES[templateName];
    if (!template) {
      console.error(`[LociManager] Template not found: ${templateName}`);
      return null;
    }

    return this.createLoci(
      overrides.name || template.name,
      overrides.description || template.description,
      overrides.category || template.category,
      sessionId,
      {
        associations: overrides.associations || template.associations,
        icon: overrides.icon || template.icon,
        color: overrides.color || template.color,
      }
    );
  }

  /**
   * Get a loci by ID
   */
  async getLoci(lociId: string): Promise<Loci | null> {
    if (!this.isConnected() || !this.redis) return null;

    try {
      const key = LOCI_KEYS.loci(lociId);
      const data = await this.redis.hgetall(key);

      if (!data || Object.keys(data).length === 0) {
        return null;
      }

      return this.parseLoci(data);
    } catch (error) {
      console.error('[LociManager] Error getting loci:', error);
      return null;
    }
  }

  /**
   * Get loci by name
   */
  async getLociByName(name: string): Promise<Loci | null> {
    if (!this.isConnected() || !this.redis) return null;

    try {
      const normalizedName = name.toLowerCase().replace(/\s+/g, '-');
      const lociId = await this.redis.get(LOCI_KEYS.lociByName(normalizedName));

      if (!lociId) return null;

      return this.getLoci(lociId);
    } catch (error) {
      console.error('[LociManager] Error getting loci by name:', error);
      return null;
    }
  }

  /**
   * Add a node to a loci
   */
  async addNodeToLoci(lociId: string, nodeId: string): Promise<boolean> {
    if (!this.isConnected() || !this.redis) return false;

    try {
      const loci = await this.getLoci(lociId);
      if (!loci) return false;

      if (!loci.nodeIds.includes(nodeId)) {
        loci.nodeIds.push(nodeId);
        const key = LOCI_KEYS.loci(lociId);
        await this.redis.hset(key, 'nodeIds', JSON.stringify(loci.nodeIds));
      }

      return true;
    } catch (error) {
      console.error('[LociManager] Error adding node to loci:', error);
      return false;
    }
  }

  /**
   * Remove a node from a loci
   */
  async removeNodeFromLoci(lociId: string, nodeId: string): Promise<boolean> {
    if (!this.isConnected() || !this.redis) return false;

    try {
      const loci = await this.getLoci(lociId);
      if (!loci) return false;

      const index = loci.nodeIds.indexOf(nodeId);
      if (index > -1) {
        loci.nodeIds.splice(index, 1);
        const key = LOCI_KEYS.loci(lociId);
        await this.redis.hset(key, 'nodeIds', JSON.stringify(loci.nodeIds));
      }

      return true;
    } catch (error) {
      console.error('[LociManager] Error removing node from loci:', error);
      return false;
    }
  }

  /**
   * Add child loci
   */
  private async addChildToLoci(parentLociId: string, childLociId: string): Promise<boolean> {
    if (!this.redis) return false;

    try {
      const parent = await this.getLoci(parentLociId);
      if (!parent) return false;

      if (!parent.childLociIds.includes(childLociId)) {
        parent.childLociIds.push(childLociId);
        const key = LOCI_KEYS.loci(parentLociId);
        await this.redis.hset(key, 'childLociIds', JSON.stringify(parent.childLociIds));
      }

      return true;
    } catch (error) {
      console.error('[LociManager] Error adding child to loci:', error);
      return false;
    }
  }

  /**
   * Get loci by category
   */
  async getLociByCategory(category: LociCategory): Promise<Loci[]> {
    if (!this.isConnected() || !this.redis) return [];

    try {
      const lociIds = await this.redis.smembers(LOCI_KEYS.lociByCategory(category));
      const lociList: Loci[] = [];

      for (const lociId of lociIds) {
        const loci = await this.getLoci(lociId);
        if (loci) lociList.push(loci);
      }

      return lociList.sort((a, b) => a.order - b.order);
    } catch (error) {
      console.error('[LociManager] Error getting loci by category:', error);
      return [];
    }
  }

  /**
   * Get loci for a session
   */
  async getSessionLoci(sessionId: string): Promise<Loci[]> {
    if (!this.isConnected() || !this.redis) return [];

    try {
      const lociIds = await this.redis.smembers(LOCI_KEYS.lociBySession(sessionId));
      const lociList: Loci[] = [];

      for (const lociId of lociIds) {
        const loci = await this.getLoci(lociId);
        if (loci) lociList.push(loci);
      }

      return lociList.sort((a, b) => a.order - b.order);
    } catch (error) {
      console.error('[LociManager] Error getting session loci:', error);
      return [];
    }
  }

  /**
   * Walk the memory palace - recall memories from a loci
   */
  async recall(lociId: string): Promise<LociRecall | null> {
    if (!this.isConnected() || !this.redis) return null;

    try {
      const loci = await this.getLoci(lociId);
      if (!loci) return null;

      const storage = getGraphStorage();
      if (!storage.isConnected()) {
        await storage.connect();
      }

      // Get nodes in this loci
      const nodes: GraphNode[] = [];
      for (const nodeId of loci.nodeIds) {
        const node = await storage.getNode(nodeId);
        if (node) nodes.push(node);
      }

      // Get connected memories (nodes connected to loci nodes)
      const connectedMemories: GraphNode[] = [];
      const seenIds = new Set(loci.nodeIds);

      for (const node of nodes) {
        const neighbors = await storage.getNeighbors(node.id, 'both');
        for (const neighbor of neighbors) {
          if (!seenIds.has(neighbor.id)) {
            connectedMemories.push(neighbor);
            seenIds.add(neighbor.id);
          }
        }
      }

      // Suggest next loci to walk
      const suggestedNext: Loci[] = [];

      // Children first
      for (const childId of loci.childLociIds) {
        const child = await this.getLoci(childId);
        if (child) suggestedNext.push(child);
      }

      // Siblings (same category)
      const categoryLoci = await this.getLociByCategory(loci.category);
      for (const sibling of categoryLoci) {
        if (sibling.id !== loci.id && !suggestedNext.find((l) => l.id === sibling.id)) {
          suggestedNext.push(sibling);
        }
      }

      return {
        loci,
        nodes,
        associationsTriggered: loci.associations,
        connectedMemories: connectedMemories.slice(0, 10), // Limit
        suggestedNext: suggestedNext.slice(0, 5),
      };
    } catch (error) {
      console.error('[LociManager] Error recalling from loci:', error);
      return null;
    }
  }

  /**
   * Walk the entire palace in order
   */
  async walkPalace(sessionId: string): Promise<LociRecall[]> {
    const lociList = await this.getSessionLoci(sessionId);
    const recalls: LociRecall[] = [];

    for (const loci of lociList) {
      const recall = await this.recall(loci.id);
      if (recall) recalls.push(recall);
    }

    return recalls;
  }

  /**
   * Delete a loci
   */
  async deleteLoci(lociId: string): Promise<boolean> {
    if (!this.isConnected() || !this.redis) return false;

    try {
      const loci = await this.getLoci(lociId);
      if (!loci) return false;

      // Remove from indices
      const normalizedName = loci.name.toLowerCase().replace(/\s+/g, '-');
      await this.redis.del(LOCI_KEYS.lociByName(normalizedName));
      await this.redis.srem(LOCI_KEYS.lociByCategory(loci.category), lociId);
      await this.redis.srem(LOCI_KEYS.lociBySession(loci.sessionId), lociId);

      // Remove from parent if exists
      if (loci.parentLociId) {
        const parent = await this.getLoci(loci.parentLociId);
        if (parent) {
          const index = parent.childLociIds.indexOf(lociId);
          if (index > -1) {
            parent.childLociIds.splice(index, 1);
            await this.redis.hset(
              LOCI_KEYS.loci(loci.parentLociId),
              'childLociIds',
              JSON.stringify(parent.childLociIds)
            );
          }
        }
      }

      // Delete loci
      await this.redis.del(LOCI_KEYS.loci(lociId));

      return true;
    } catch (error) {
      console.error('[LociManager] Error deleting loci:', error);
      return false;
    }
  }

  /**
   * Get available templates
   */
  getTemplates(): Record<string, LociTemplate> {
    return LOCI_TEMPLATES;
  }

  /**
   * Serialize loci for Redis
   */
  private serializeLoci(loci: Loci): Record<string, string | number> {
    return {
      id: loci.id,
      name: loci.name,
      description: loci.description,
      category: loci.category,
      associations: JSON.stringify(loci.associations),
      nodeIds: JSON.stringify(loci.nodeIds),
      parentLociId: loci.parentLociId || '',
      childLociIds: JSON.stringify(loci.childLociIds),
      order: loci.order,
      sessionId: loci.sessionId,
      createdAt: loci.createdAt,
      icon: loci.icon || '',
      color: loci.color || '',
    };
  }

  /**
   * Parse loci from Redis data
   */
  private parseLoci(data: Record<string, string>): Loci {
    return {
      id: data.id,
      name: data.name,
      description: data.description,
      category: data.category as LociCategory,
      associations: JSON.parse(data.associations || '[]'),
      nodeIds: JSON.parse(data.nodeIds || '[]'),
      parentLociId: data.parentLociId || undefined,
      childLociIds: JSON.parse(data.childLociIds || '[]'),
      order: parseInt(data.order, 10),
      sessionId: data.sessionId,
      createdAt: parseInt(data.createdAt, 10),
      icon: data.icon || undefined,
      color: data.color || undefined,
    };
  }

}

// Singleton instance
let lociManager: LociManager | null = null;

/**
 * Get the global loci manager
 */
export function getLociManager(): LociManager {
  if (!lociManager) {
    lociManager = new LociManager();
  }
  return lociManager;
}

/**
 * Reset the global loci manager (for testing)
 */
export function resetLociManager(): void {
  if (lociManager) {
    lociManager.disconnect().catch(console.error);
  }
  lociManager = null;
}
