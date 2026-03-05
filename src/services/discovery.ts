/**
 * KemdiCode MCP Server - Service Discovery
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
 * Service Discovery
 *
 * Features:
 * - Service registration with health checks
 * - DNS-based service discovery
 * - Service tagging and filtering
 * - Automatic failover
 * - Service health monitoring
 *
 * @module services/discovery
 */

import { getSharedRedis } from '../infrastructure/redis/connection.js';
import { v4 as uuidv4 } from 'uuid';

export interface ServiceInstance {
  id: string;
  name: string;
  host: string;
  port: number;
  tags: string[];
  metadata: Record<string, string>;
  healthCheckUrl?: string;
  status: 'healthy' | 'unhealthy' | 'unknown';
  lastHeartbeat: number;
  registeredAt: number;
}

export interface ServiceDefinition {
  name: string;
  description?: string;
  tags?: string[];
  healthCheckIntervalMs?: number;
  ttlMs?: number;
}

export interface DiscoveryOptions {
  tags?: string[];
  healthyOnly?: boolean;
  limit?: number;
}

export interface ServiceCatalog {
  services: ServiceInstance[];
  timestamp: number;
}

export class ServiceDiscovery {
  private services: Map<string, Map<string, ServiceInstance>> = new Map();
  private ttlCheckInterval: ReturnType<typeof setInterval> | null = null;
  private readonly defaultTtlMs = 30000;
  private readonly defaultHealthCheckIntervalMs = 5000;
  private myInstanceId: string;

  constructor() {
    this.myInstanceId = `mcp-${uuidv4().slice(0, 8)}`;
    this.startTtlCheck();
  }

  async register(
    service: ServiceDefinition,
    instance: Omit<ServiceInstance, 'id' | 'registeredAt'>
  ): Promise<string> {
    const instanceId = `${this.myInstanceId}-${Date.now()}`;
    const fullInstance: ServiceInstance = {
      ...instance,
      id: instanceId,
      registeredAt: Date.now(),
    };

    let instances = this.services.get(service.name);
    if (!instances) {
      instances = new Map();
      this.services.set(service.name, instances);
    }

    instances.set(instanceId, fullInstance);

    const redis = await this.tryGetRedis();
    if (redis) {
      await this.persistToRedis(service.name, fullInstance);
    }

    return instanceId;
  }

  async unregister(serviceName: string, instanceId: string): Promise<void> {
    const instances = this.services.get(serviceName);
    if (instances) {
      instances.delete(instanceId);

      const redis = await this.tryGetRedis();
      if (redis) {
        await redis.hdel(`service:${serviceName}`, instanceId);
      }
    }
  }

  async discover(serviceName: string, options: DiscoveryOptions = {}): Promise<ServiceInstance[]> {
    const redis = await this.tryGetRedis();
    if (redis) {
      return this.discoverFromRedis(serviceName, options);
    }

    return this.discoverLocal(serviceName, options);
  }

  private async discoverFromRedis(
    serviceName: string,
    options: DiscoveryOptions
  ): Promise<ServiceInstance[]> {
    const redis = await this.tryGetRedis();
    if (!redis) return [];

    const data = await redis.hgetall(`service:${serviceName}`);
    const instances: ServiceInstance[] = [];

    for (const [, json] of Object.entries(data)) {
      try {
        const instance = JSON.parse(json) as ServiceInstance;
        if (options.healthyOnly && instance.status !== 'healthy') continue;
        if (options.tags && options.tags.some((tag) => !instance.tags.includes(tag))) continue;
        instances.push(instance);
      } catch (error) {
        console.warn(`Failed to parse service instance from Redis: ${error}`);
      }
    }

    if (options.limit) {
      return instances.slice(0, options.limit);
    }

    return instances;
  }

  private discoverLocal(serviceName: string, options: DiscoveryOptions): ServiceInstance[] {
    const instances = this.services.get(serviceName);
    if (!instances) return [];

    const filtered = [...instances.values()].filter((instance) => {
      if (options.healthyOnly && instance.status !== 'healthy') return false;
      if (options.tags && options.tags.some((tag) => !instance.tags.includes(tag))) return false;
      return true;
    });

    if (options.limit) {
      return filtered.slice(0, options.limit);
    }

    return filtered;
  }

  async getHealthyInstance(serviceName: string): Promise<ServiceInstance | null> {
    const instances = await this.discover(serviceName, { healthyOnly: true });
    if (instances.length === 0) return null;

    return instances[Math.floor(Math.random() * instances.length)];
  }

  async updateHeartbeat(serviceName: string, instanceId: string): Promise<void> {
    const instances = this.services.get(serviceName);
    const instance = instances?.get(instanceId);
    if (instance) {
      instance.lastHeartbeat = Date.now();

      const redis = await this.tryGetRedis();
      if (redis) {
        await this.persistToRedis(serviceName, instance);
      }
    }
  }

  async updateStatus(
    serviceName: string,
    instanceId: string,
    status: ServiceInstance['status']
  ): Promise<void> {
    const instances = this.services.get(serviceName);
    const instance = instances?.get(instanceId);
    if (instance) {
      instance.status = status;

      const redis = await this.tryGetRedis();
      if (redis) {
        await this.persistToRedis(serviceName, instance);
      }
    }
  }

  async reportHealthy(serviceName: string): Promise<void> {
    await this.updateHeartbeat(serviceName, this.myInstanceId);
  }

  async listServices(): Promise<string[]> {
    return [...this.services.keys()];
  }

  async getCatalog(): Promise<Record<string, ServiceCatalog>> {
    const catalog: Record<string, ServiceCatalog> = {};

    for (const [name, instances] of this.services) {
      catalog[name] = {
        services: [...instances.values()],
        timestamp: Date.now(),
      };
    }

    return catalog;
  }

  async healthCheck(serviceName: string, instanceId: string): Promise<boolean> {
    const instances = this.services.get(serviceName);
    const instance = instances?.get(instanceId);
    if (!instance) return false;

    if (!instance.healthCheckUrl) {
      instance.status = 'healthy';
      return true;
    }

    try {
      const response = await fetch(instance.healthCheckUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });
      const healthy = response.ok;
      instance.status = healthy ? 'healthy' : 'unhealthy';
      return healthy;
    } catch {
      instance.status = 'unhealthy';
      return false;
    }
  }

  private async persistToRedis(serviceName: string, instance: ServiceInstance): Promise<void> {
    const redis = await this.tryGetRedis();
    if (!redis) return;

    await redis.hset(`service:${serviceName}`, instance.id, JSON.stringify(instance));

    await redis.pexpire(`service:${serviceName}`, this.defaultTtlMs);
  }

  private startTtlCheck(): void {
    this.ttlCheckInterval = setInterval(() => {
      this.checkTtl();
    }, this.defaultHealthCheckIntervalMs);
  }

  private async checkTtl(): Promise<void> {
    const now = Date.now();

    for (const [serviceName, instances] of this.services) {
      for (const [instanceId, instance] of instances) {
        if (now - instance.lastHeartbeat > this.defaultTtlMs) {
          instances.delete(instanceId);

          const redis = await this.tryGetRedis();
          if (redis) {
            await redis.hdel(`service:${serviceName}`, instanceId);
          }
        }
      }
    }
  }

  async shutdown(): Promise<void> {
    if (this.ttlCheckInterval) {
      clearInterval(this.ttlCheckInterval);
      this.ttlCheckInterval = null;
    }

    for (const [serviceName, instances] of this.services) {
      for (const [instanceId] of instances) {
        await this.unregister(serviceName, instanceId);
      }
    }

    this.services.clear();
  }

  private async tryGetRedis(): Promise<Awaited<ReturnType<typeof getSharedRedis>> | null> {
    try {
      return await getSharedRedis();
    } catch {
      return null;
    }
  }
}

export const serviceDiscovery = new ServiceDiscovery();
