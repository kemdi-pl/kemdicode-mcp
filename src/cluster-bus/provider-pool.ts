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
 * Cluster Provider Pool
 *
 * Maintains an aggregate view of AI providers available across all
 * cluster nodes. Merges local providers with remote cluster capabilities
 * to enable intelligent routing of LLM requests.
 *
 * @module cluster-bus/provider-pool
 */

import type { ClusterNode } from './types.js';
import { listClusters } from './cluster-registry.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Aggregated provider info from across clusters */
export interface PooledProvider {
  /** Provider ID (e.g., 'anthropic', 'openai', 'custom:vllm') */
  providerId: string;
  /** Cluster IDs that have this provider */
  clusterIds: string[];
  /** Total number of clusters with this provider */
  clusterCount: number;
  /** Whether any cluster with this provider is online */
  available: boolean;
  /** Average load across clusters with this provider (0-1, if reported) */
  avgLoad: number;
  /** Whether this is a custom endpoint */
  custom?: boolean;
  /** Base URL for custom endpoints */
  baseURL?: string;
  /** Available models (from custom endpoint config) */
  models?: string[];
}

/** Provider pool snapshot */
export interface PoolSnapshot {
  /** All available providers across the cluster mesh */
  providers: PooledProvider[];
  /** Total unique providers */
  totalProviders: number;
  /** Total online clusters with at least one provider */
  totalClusters: number;
  /** Snapshot timestamp */
  snapshotAt: number;
}

/** Selection criteria for picking a provider cluster */
export interface SelectionCriteria {
  /** Required provider ID */
  providerId: string;
  /** Prefer cluster with lowest load */
  preferLowLoad?: boolean;
  /** Exclude specific cluster IDs */
  excludeClusters?: string[];
  /** Only include specific cluster IDs */
  includeClusters?: string[];
}

// ---------------------------------------------------------------------------
// ClusterProviderPool
// ---------------------------------------------------------------------------

/**
 * ClusterProviderPool — aggregate view of AI providers across clusters.
 *
 * Usage:
 *   const pool = new ClusterProviderPool();
 *   const snapshot = await pool.getSnapshot();
 *   const target = await pool.selectCluster({ providerId: 'anthropic' });
 */
export class ClusterProviderPool {
  private localClusterId: string;
  private cachedSnapshot: PoolSnapshot | null = null;
  private cacheMaxAgeMs = 5000; // 5-second cache
  private lastRefreshAt = 0;

  constructor(localClusterId: string) {
    this.localClusterId = localClusterId;
  }

  // -------------------------------------------------------------------------
  // Snapshot
  // -------------------------------------------------------------------------

  /** Get an aggregated provider pool snapshot. */
  async getSnapshot(forceRefresh = false): Promise<PoolSnapshot> {
    const now = Date.now();
    if (!forceRefresh && this.cachedSnapshot && now - this.lastRefreshAt < this.cacheMaxAgeMs) {
      return this.cachedSnapshot;
    }

    const nodes = await listClusters();
    const onlineNodes = nodes.filter((n) => n.status === 'online');
    const providerMap = new Map<string, {
      clusterIds: string[];
      loads: number[];
      custom?: boolean;
      baseURL?: string;
      models?: string[];
    }>();

    for (const node of onlineNodes) {
      // Built-in + custom providers from connectedProviders list
      for (const providerId of node.connectedProviders) {
        if (!providerMap.has(providerId)) {
          providerMap.set(providerId, { clusterIds: [], loads: [] });
        }
        const entry = providerMap.get(providerId)!;
        entry.clusterIds.push(node.id);
        if (node.load !== undefined) {
          entry.loads.push(node.load);
        }
      }

      // Merge custom endpoint details
      for (const ep of node.customEndpoints || []) {
        const customId = `custom:${ep.name}`;
        if (!providerMap.has(customId)) {
          providerMap.set(customId, {
            clusterIds: [],
            loads: [],
            custom: true,
            baseURL: ep.baseURL,
            models: ep.models,
          });
        }
        const entry = providerMap.get(customId)!;
        if (!entry.clusterIds.includes(node.id)) {
          entry.clusterIds.push(node.id);
          if (node.load !== undefined) {
            entry.loads.push(node.load);
          }
        }
      }
    }

    const providers: PooledProvider[] = [];
    for (const [providerId, data] of providerMap) {
      providers.push({
        providerId,
        clusterIds: data.clusterIds,
        clusterCount: data.clusterIds.length,
        available: true,
        avgLoad: data.loads.length > 0
          ? data.loads.reduce((a, b) => a + b, 0) / data.loads.length
          : 0,
        ...(data.custom && { custom: true }),
        ...(data.baseURL && { baseURL: data.baseURL }),
        ...(data.models?.length && { models: data.models }),
      });
    }

    // Sort by cluster count (most available first)
    providers.sort((a, b) => b.clusterCount - a.clusterCount);

    const snapshot: PoolSnapshot = {
      providers,
      totalProviders: providers.length,
      totalClusters: onlineNodes.length,
      snapshotAt: now,
    };

    this.cachedSnapshot = snapshot;
    this.lastRefreshAt = now;

    return snapshot;
  }

  // -------------------------------------------------------------------------
  // Selection
  // -------------------------------------------------------------------------

  /**
   * Select the best cluster for a given provider.
   * Returns null if no matching cluster is found.
   */
  async selectCluster(criteria: SelectionCriteria): Promise<ClusterNode | null> {
    const nodes = await listClusters();
    const candidates = nodes.filter((n) => {
      if (n.status !== 'online') return false;
      if (n.id === this.localClusterId) return false;
      if (!n.connectedProviders.includes(criteria.providerId)) return false;
      if (criteria.excludeClusters?.includes(n.id)) return false;
      if (criteria.includeClusters?.length && !criteria.includeClusters.includes(n.id)) return false;
      return true;
    });

    if (candidates.length === 0) return null;

    // For now, pick randomly from candidates (simple load balancing)
    // In the future, we could use load metrics from heartbeats
    const idx = Math.floor(Math.random() * candidates.length);
    return candidates[idx];
  }

  /**
   * Select multiple clusters for parallel dispatch.
   */
  async selectClusters(criteria: SelectionCriteria, maxCount: number): Promise<ClusterNode[]> {
    const nodes = await listClusters();
    const candidates = nodes.filter((n) => {
      if (n.status !== 'online') return false;
      if (n.id === this.localClusterId) return false;
      if (!n.connectedProviders.includes(criteria.providerId)) return false;
      if (criteria.excludeClusters?.includes(n.id)) return false;
      if (criteria.includeClusters?.length && !criteria.includeClusters.includes(n.id)) return false;
      return true;
    });

    // Shuffle for load distribution
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }

    return candidates.slice(0, maxCount);
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  /** Check if a specific provider is available on any cluster. */
  async isProviderAvailable(providerId: string): Promise<boolean> {
    const snapshot = await this.getSnapshot();
    return snapshot.providers.some((p) => p.providerId === providerId && p.available);
  }

  /** Get all available provider IDs across the mesh. */
  async getAvailableProviders(): Promise<string[]> {
    const snapshot = await this.getSnapshot();
    return snapshot.providers.filter((p) => p.available).map((p) => p.providerId);
  }

  /** Get clusters that have a specific provider. */
  async getClustersForProvider(providerId: string): Promise<string[]> {
    const snapshot = await this.getSnapshot();
    const entry = snapshot.providers.find((p) => p.providerId === providerId);
    return entry ? entry.clusterIds : [];
  }

  // -------------------------------------------------------------------------
  // Cache Control
  // -------------------------------------------------------------------------

  /** Set cache TTL in milliseconds. */
  setCacheTtl(ms: number): void {
    this.cacheMaxAgeMs = ms;
  }

  /** Invalidate the cached snapshot. */
  invalidateCache(): void {
    this.cachedSnapshot = null;
    this.lastRefreshAt = 0;
  }
}
