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
 * Mental Model Store
 *
 * Redis-backed storage for persistent semantic understanding of systems.
 * Unlike code-outline (syntax), mental models capture meaning: what components
 * do, why they exist, how they relate, and what invariants they maintain.
 *
 * @module cognition/mental-model-store
 */

import { RedisBackedService } from '../infrastructure/redis/redis-backed-service.js';
import { Logger } from '../utils/logger.js';
import type { MentalModel, ModelComponent, ModelRelationship } from './types.js';
import { COGNITION_KEYS, COGNITION_TTL } from './types.js';
import { randomBytes } from 'crypto';

/**
 * Mental Model Store
 *
 * Stores and retrieves persistent mental models of system architecture.
 * Each model contains components (with roles, files, invariants) and
 * relationships (calls, depends-on, produces, consumes, extends, contains).
 */
export class MentalModelStore extends RedisBackedService {
  protected get serviceName() { return 'MentalModelStore'; }

  /**
   * Generate a unique model ID
   */
  generateId(): string {
    return `model_${Date.now()}_${randomBytes(4).toString('hex')}`;
  }

  /**
   * Create a new mental model and persist it to Redis.
   *
   * @param model - Model data without id, createdAt, updatedAt
   * @returns The created model with generated fields, or null on failure
   */
  async create(
    model: Omit<MentalModel, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<MentalModel | null> {
    try {
      await this.connect();
      if (!this.redis) return null;

      const now = Date.now();
      const fullModel: MentalModel = {
        ...model,
        id: this.generateId(),
        createdAt: now,
        updatedAt: now,
      };

      const key = COGNITION_KEYS.model(fullModel.id);
      const sessionKey = COGNITION_KEYS.modelsBySession(fullModel.sessionId);
      const nameKey = COGNITION_KEYS.modelByName(fullModel.name);

      const pipeline = this.redis.pipeline();

      // Store the model as a JSON string
      pipeline.set(key, JSON.stringify(fullModel));
      if (COGNITION_TTL.model > 0) {
        pipeline.expire(key, COGNITION_TTL.model);
      }

      // Add to session sorted set (score = creation timestamp for ordering)
      pipeline.zadd(sessionKey, now, fullModel.id);
      if (COGNITION_TTL.model > 0) {
        pipeline.expire(sessionKey, COGNITION_TTL.model);
      }

      // Store name lookup (normalized name -> model id)
      pipeline.set(nameKey, fullModel.id);
      if (COGNITION_TTL.model > 0) {
        pipeline.expire(nameKey, COGNITION_TTL.model);
      }

      await pipeline.exec();

      Logger.debug(`MentalModelStore: created model ${fullModel.id} "${fullModel.name}"`);
      return fullModel;
    } catch (error) {
      Logger.error('MentalModelStore: failed to create model', error);
      return null;
    }
  }

  /**
   * Get a mental model by ID.
   *
   * @param id - Model ID
   * @returns The model, or null if not found
   */
  async get(id: string): Promise<MentalModel | null> {
    try {
      await this.connect();
      if (!this.redis) return null;

      const raw = await this.redis.get(COGNITION_KEYS.model(id));
      if (!raw) return null;

      return JSON.parse(raw) as MentalModel;
    } catch (error) {
      Logger.error(`MentalModelStore: failed to get model ${id}`, error);
      return null;
    }
  }

  /**
   * Get a mental model by its normalized name.
   *
   * @param name - Human-readable model name
   * @returns The model, or null if not found
   */
  async getByName(name: string): Promise<MentalModel | null> {
    try {
      await this.connect();
      if (!this.redis) return null;

      const nameKey = COGNITION_KEYS.modelByName(name);
      const modelId = await this.redis.get(nameKey);
      if (!modelId) return null;

      return this.get(modelId);
    } catch (error) {
      Logger.error(`MentalModelStore: failed to get model by name "${name}"`, error);
      return null;
    }
  }

  /**
   * List all mental models in a session, ordered by creation time (newest first).
   *
   * @param sessionId - Session ID
   * @returns Array of models
   */
  async listBySession(sessionId: string): Promise<MentalModel[]> {
    try {
      await this.connect();
      if (!this.redis) return [];

      const sessionKey = COGNITION_KEYS.modelsBySession(sessionId);
      // Get all model IDs ordered by score descending (newest first)
      const modelIds = await this.redis.zrevrange(sessionKey, 0, -1);

      const models: MentalModel[] = [];
      for (const id of modelIds) {
        const model = await this.get(id);
        if (model) {
          models.push(model);
        }
      }

      return models;
    } catch (error) {
      Logger.error(`MentalModelStore: failed to list models for session ${sessionId}`, error);
      return [];
    }
  }

  /**
   * Add a component to an existing model.
   *
   * @param modelId - Model ID
   * @param component - Component to add
   * @returns true if successful
   */
  async addComponent(modelId: string, component: ModelComponent): Promise<boolean> {
    try {
      await this.connect();
      if (!this.redis) return false;

      const model = await this.get(modelId);
      if (!model) {
        Logger.error(`MentalModelStore: model not found for addComponent: ${modelId}`);
        return false;
      }

      // Check for duplicate component name
      const existingIndex = model.components.findIndex(
        (c) => c.name.toLowerCase() === component.name.toLowerCase()
      );
      if (existingIndex >= 0) {
        // Replace existing component with same name
        model.components[existingIndex] = component;
      } else {
        model.components.push(component);
      }

      model.updatedAt = Date.now();

      const key = COGNITION_KEYS.model(modelId);
      await this.redis.set(key, JSON.stringify(model));
      if (COGNITION_TTL.model > 0) {
        await this.redis.expire(key, COGNITION_TTL.model);
      }

      Logger.debug(`MentalModelStore: added component "${component.name}" to model ${modelId}`);
      return true;
    } catch (error) {
      Logger.error(`MentalModelStore: failed to add component to model ${modelId}`, error);
      return false;
    }
  }

  /**
   * Add a relationship between components in a model.
   *
   * @param modelId - Model ID
   * @param relationship - Relationship to add
   * @returns true if successful
   */
  async addRelationship(modelId: string, relationship: ModelRelationship): Promise<boolean> {
    try {
      await this.connect();
      if (!this.redis) return false;

      const model = await this.get(modelId);
      if (!model) {
        Logger.error(`MentalModelStore: model not found for addRelationship: ${modelId}`);
        return false;
      }

      // Check for duplicate relationship (same from, to, type)
      const existingIndex = model.relationships.findIndex(
        (r) =>
          r.from.toLowerCase() === relationship.from.toLowerCase() &&
          r.to.toLowerCase() === relationship.to.toLowerCase() &&
          r.type === relationship.type
      );
      if (existingIndex >= 0) {
        // Replace existing relationship
        model.relationships[existingIndex] = relationship;
      } else {
        model.relationships.push(relationship);
      }

      model.updatedAt = Date.now();

      const key = COGNITION_KEYS.model(modelId);
      await this.redis.set(key, JSON.stringify(model));
      if (COGNITION_TTL.model > 0) {
        await this.redis.expire(key, COGNITION_TTL.model);
      }

      Logger.debug(
        `MentalModelStore: added relationship ${relationship.from} --[${relationship.type}]--> ${relationship.to} to model ${modelId}`
      );
      return true;
    } catch (error) {
      Logger.error(`MentalModelStore: failed to add relationship to model ${modelId}`, error);
      return false;
    }
  }

  /**
   * Remove a component by name from a model.
   * Also removes any relationships that reference the component.
   *
   * @param modelId - Model ID
   * @param componentName - Name of the component to remove
   * @returns true if successful
   */
  async removeComponent(modelId: string, componentName: string): Promise<boolean> {
    try {
      await this.connect();
      if (!this.redis) return false;

      const model = await this.get(modelId);
      if (!model) {
        Logger.error(`MentalModelStore: model not found for removeComponent: ${modelId}`);
        return false;
      }

      const nameLower = componentName.toLowerCase();
      const initialCount = model.components.length;

      // Remove the component
      model.components = model.components.filter(
        (c) => c.name.toLowerCase() !== nameLower
      );

      if (model.components.length === initialCount) {
        Logger.debug(`MentalModelStore: component "${componentName}" not found in model ${modelId}`);
        return false;
      }

      // Remove relationships that reference the removed component
      model.relationships = model.relationships.filter(
        (r) =>
          r.from.toLowerCase() !== nameLower &&
          r.to.toLowerCase() !== nameLower
      );

      // Remove from other components' dependency lists
      for (const comp of model.components) {
        comp.dependencies = comp.dependencies.filter(
          (d) => d.toLowerCase() !== nameLower
        );
      }

      model.updatedAt = Date.now();

      const key = COGNITION_KEYS.model(modelId);
      await this.redis.set(key, JSON.stringify(model));
      if (COGNITION_TTL.model > 0) {
        await this.redis.expire(key, COGNITION_TTL.model);
      }

      Logger.debug(`MentalModelStore: removed component "${componentName}" from model ${modelId}`);
      return true;
    } catch (error) {
      Logger.error(`MentalModelStore: failed to remove component from model ${modelId}`, error);
      return false;
    }
  }

  /**
   * Mark a model as stale (underlying files have changed).
   *
   * @param modelId - Model ID
   * @returns true if successful
   */
  async markStale(modelId: string): Promise<boolean> {
    try {
      await this.connect();
      if (!this.redis) return false;

      const model = await this.get(modelId);
      if (!model) {
        Logger.error(`MentalModelStore: model not found for markStale: ${modelId}`);
        return false;
      }

      model.staleSince = Date.now();
      model.updatedAt = Date.now();

      const key = COGNITION_KEYS.model(modelId);
      await this.redis.set(key, JSON.stringify(model));
      if (COGNITION_TTL.model > 0) {
        await this.redis.expire(key, COGNITION_TTL.model);
      }

      Logger.debug(`MentalModelStore: marked model ${modelId} as stale`);
      return true;
    } catch (error) {
      Logger.error(`MentalModelStore: failed to mark model ${modelId} as stale`, error);
      return false;
    }
  }

  /**
   * Refresh a model, clearing its stale marker.
   *
   * @param modelId - Model ID
   * @returns true if successful
   */
  async refresh(modelId: string): Promise<boolean> {
    try {
      await this.connect();
      if (!this.redis) return false;

      const model = await this.get(modelId);
      if (!model) {
        Logger.error(`MentalModelStore: model not found for refresh: ${modelId}`);
        return false;
      }

      delete model.staleSince;
      model.updatedAt = Date.now();

      const key = COGNITION_KEYS.model(modelId);
      await this.redis.set(key, JSON.stringify(model));
      if (COGNITION_TTL.model > 0) {
        await this.redis.expire(key, COGNITION_TTL.model);
      }

      Logger.debug(`MentalModelStore: refreshed model ${modelId}`);
      return true;
    } catch (error) {
      Logger.error(`MentalModelStore: failed to refresh model ${modelId}`, error);
      return false;
    }
  }

  /**
   * Check which components in a model are affected by a set of changed files.
   * Returns the names of components whose source files overlap with the changed files.
   *
   * @param modelId - Model ID
   * @param changedFiles - Array of file paths that have changed
   * @returns Array of affected component names
   */
  async checkStaleness(modelId: string, changedFiles: string[]): Promise<string[]> {
    try {
      await this.connect();

      const model = await this.get(modelId);
      if (!model) {
        Logger.error(`MentalModelStore: model not found for checkStaleness: ${modelId}`);
        return [];
      }

      // Normalize changed file paths for comparison
      const changedSet = new Set(
        changedFiles.map((f) => f.replace(/^@/, '').replace(/\\/g, '/'))
      );

      const affectedComponents: string[] = [];

      for (const component of model.components) {
        const isAffected = component.files.some((file) => {
          const normalized = file.replace(/^@/, '').replace(/\\/g, '/');
          return changedSet.has(normalized);
        });

        if (isAffected) {
          affectedComponents.push(component.name);
        }
      }

      if (affectedComponents.length > 0) {
        Logger.debug(
          `MentalModelStore: ${affectedComponents.length} component(s) affected in model ${modelId}: ${affectedComponents.join(', ')}`
        );
      }

      return affectedComponents;
    } catch (error) {
      Logger.error(`MentalModelStore: failed to check staleness for model ${modelId}`, error);
      return [];
    }
  }
}

// Singleton instance
let mentalModelStore: MentalModelStore | null = null;

/**
 * Get the global MentalModelStore singleton
 */
export function getMentalModelStore(): MentalModelStore {
  if (!mentalModelStore) {
    mentalModelStore = new MentalModelStore();
  }
  return mentalModelStore;
}

/**
 * Reset the global MentalModelStore (for testing)
 */
export function resetMentalModelStore(): void {
  if (mentalModelStore) {
    mentalModelStore.disconnect().catch((err) => Logger.error(err));
  }
  mentalModelStore = null;
}
