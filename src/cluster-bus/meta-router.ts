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
 * MetaTag Router — Signal routing engine based on meta-tag matching.
 *
 * Routes incoming cluster signals to destination clusters based on
 * meta-tag rules. Supports exact match, wildcard, regex, and
 * composite (AND/OR) routing predicates.
 *
 * @module cluster-bus/meta-router
 */

import { Logger } from '../utils/logger.js';
import type { ClusterSignal, ClusterMetaTag, ClusterNode, SignalType } from './types.js';
import { listClusters } from './cluster-registry.js';

// ---------------------------------------------------------------------------
// Route Rule Types
// ---------------------------------------------------------------------------

/** Match mode for meta-tag routing */
export type MatchMode = 'exact' | 'wildcard' | 'regex' | 'prefix';

/** A single meta-tag predicate */
export interface TagPredicate {
  key: string;
  value: string;
  mode: MatchMode;
}

/** Composite routing rule with AND/OR logic */
export interface RouteRule {
  /** Unique rule ID */
  id: string;
  /** Human-readable label */
  label: string;
  /** Signal types this rule applies to (empty = all) */
  signalTypes: SignalType[];
  /** Tag predicates (combined via logic operator) */
  predicates: TagPredicate[];
  /** Logic for combining predicates */
  logic: 'and' | 'or';
  /** Priority — higher = evaluated first */
  priority: number;
  /** Whether to stop evaluating further rules after match */
  terminal: boolean;
  /** Enabled flag */
  enabled: boolean;
}

/** Result of routing a signal */
export interface RouteResult {
  /** Matching cluster node IDs */
  targets: string[];
  /** Which rules matched */
  matchedRules: string[];
  /** Number of clusters evaluated */
  evaluated: number;
}

// ---------------------------------------------------------------------------
// MetaTagRouter
// ---------------------------------------------------------------------------

/**
 * MetaTagRouter — routes signals to clusters via meta-tag matching.
 *
 * Usage:
 *   const router = new MetaTagRouter();
 *   router.addRule({ ... });
 *   const result = await router.route(signal);
 *   // result.targets => cluster IDs to deliver to
 */
/** Maximum allowed regex pattern length to prevent ReDoS */
const MAX_REGEX_LENGTH = 200;

export class MetaTagRouter {
  private rules: RouteRule[] = [];
  private rulesSorted = false;
  /** Cache of compiled regex patterns to avoid recompilation per signal (bounded to 500 entries) */
  private regexCache = new Map<string, RegExp | null>();
  private readonly maxRegexCacheSize = 500;

  // -------------------------------------------------------------------------
  // Rule Management
  // -------------------------------------------------------------------------

  /** Add a routing rule. */
  addRule(rule: RouteRule): void {
    this.rules.push(rule);
    this.rulesSorted = false;
  }

  /** Remove a routing rule by ID. */
  removeRule(ruleId: string): boolean {
    const idx = this.rules.findIndex((r) => r.id === ruleId);
    if (idx === -1) return false;
    this.rules.splice(idx, 1);
    return true;
  }

  /** Get all rules (sorted by priority desc). */
  getRules(): readonly RouteRule[] {
    this.ensureSorted();
    return this.rules;
  }

  /** Clear all rules. */
  clearRules(): void {
    this.rules = [];
    this.rulesSorted = true;
    this.regexCache.clear();
  }

  // -------------------------------------------------------------------------
  // Routing
  // -------------------------------------------------------------------------

  /**
   * Route a signal to matching clusters.
   *
   * 1. Fetches all active clusters from registry
   * 2. Evaluates rules (priority desc) against each cluster's meta-tags
   * 3. Returns matching cluster IDs
   */
  async route(signal: ClusterSignal): Promise<RouteResult> {
    this.ensureSorted();

    const clusters = await listClusters();

    if (!clusters || clusters.length === 0) {
      return { targets: [], matchedRules: [], evaluated: 0 };
    }

    const targets = new Set<string>();
    const matchedRules: string[] = [];
    let evaluated = 0;

    const applicableRules = this.rules.filter(
      (r) => r.enabled && (r.signalTypes.length === 0 || r.signalTypes.includes(signal.type))
    );

    for (const cluster of clusters) {
      if (cluster.id === signal.sourceCluster) continue;
      evaluated++;

      const clusterTags = cluster.metaTags ?? [];
      for (const rule of applicableRules) {
        if (this.matchesRule(rule, clusterTags)) {
          targets.add(cluster.id);
          if (!matchedRules.includes(rule.id)) {
            matchedRules.push(rule.id);
          }
          if (rule.terminal) break;
        }
      }
    }

    Logger.debug(
      `[MetaRouter] Routed ${signal.type} → ${targets.size} targets via ${matchedRules.length} rules (evaluated ${evaluated} clusters)`
    );

    return { targets: [...targets], matchedRules, evaluated };
  }

  /**
   * Route a signal using provided clusters (no registry fetch).
   * Useful when caller already has the cluster list.
   */
  routeWithNodes(signal: ClusterSignal, clusters: ClusterNode[]): RouteResult {
    this.ensureSorted();

    if (!clusters || clusters.length === 0) {
      return { targets: [], matchedRules: [], evaluated: 0 };
    }

    const targets = new Set<string>();
    const matchedRules: string[] = [];
    let evaluated = 0;

    const applicableRules = this.rules.filter(
      (r) => r.enabled && (r.signalTypes.length === 0 || r.signalTypes.includes(signal.type))
    );

    for (const cluster of clusters) {
      if (cluster.id === signal.sourceCluster) continue;
      evaluated++;

      const clusterTags = cluster.metaTags ?? [];
      for (const rule of applicableRules) {
        if (this.matchesRule(rule, clusterTags)) {
          targets.add(cluster.id);
          if (!matchedRules.includes(rule.id)) {
            matchedRules.push(rule.id);
          }
          if (rule.terminal) break;
        }
      }
    }

    return { targets: [...targets], matchedRules, evaluated };
  }

  /**
   * Check if a single cluster matches any active rule for a signal type.
   */
  matches(cluster: ClusterNode, signalType: SignalType): boolean {
    this.ensureSorted();

    if (!cluster?.metaTags || cluster.metaTags.length === 0) {
      return false;
    }

    const applicableRules = this.rules.filter(
      (r) => r.enabled && (r.signalTypes.length === 0 || r.signalTypes.includes(signalType))
    );

    return applicableRules.some((rule) => this.matchesRule(rule, cluster.metaTags));
  }

  // -------------------------------------------------------------------------
  // Predicate Matching
  // -------------------------------------------------------------------------

  private matchesRule(rule: RouteRule, tags: ClusterMetaTag[]): boolean {
    if (rule.predicates.length === 0) return true;

    if (rule.logic === 'and') {
      return rule.predicates.every((pred) => this.matchesPredicate(pred, tags));
    } else {
      return rule.predicates.some((pred) => this.matchesPredicate(pred, tags));
    }
  }

  private matchesPredicate(predicate: TagPredicate, tags: ClusterMetaTag[]): boolean {
    return tags.some((tag) => {
      if (tag.key !== predicate.key) return false;
      return this.matchValue(predicate, tag.value);
    });
  }

  private matchValue(predicate: TagPredicate, actual: string): boolean {
    switch (predicate.mode) {
      case 'exact':
        return predicate.value === actual;

      case 'wildcard':
        return predicate.value === '*' || predicate.value === actual;

      case 'prefix':
        return actual.startsWith(predicate.value);

      case 'regex': {
        if (predicate.value.length > MAX_REGEX_LENGTH) {
          Logger.warn(
            `[MetaRouter] Regex too long (${predicate.value.length} > ${MAX_REGEX_LENGTH}), rejecting`
          );
          return false;
        }
        let re = this.regexCache.get(predicate.value);
        if (re === undefined) {
          try {
            re = new RegExp(predicate.value);
          } catch {
            Logger.warn(`[MetaRouter] Invalid regex in predicate: ${predicate.value}`);
            re = null;
          }
          // Evict oldest entries when cache is full
          if (this.regexCache.size >= this.maxRegexCacheSize) {
            const firstKey = this.regexCache.keys().next().value;
            if (firstKey !== undefined) this.regexCache.delete(firstKey);
          }
          this.regexCache.set(predicate.value, re);
        }
        return re !== null && re.test(actual);
      }

      default:
        return false;
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private ensureSorted(): void {
    if (this.rulesSorted) return;
    this.rules.sort((a, b) => {
      const pa = typeof a.priority === 'number' && !isNaN(a.priority) ? a.priority : 0;
      const pb = typeof b.priority === 'number' && !isNaN(b.priority) ? b.priority : 0;
      return pb - pa;
    });
    this.rulesSorted = true;
  }
}

// ---------------------------------------------------------------------------
// Convenience: Common Route Rule Builders
// ---------------------------------------------------------------------------

let ruleCounter = 0;

/** Create a rule that routes to clusters with a specific provider. */
export function routeByProvider(provider: string, signalTypes: SignalType[] = []): RouteRule {
  return {
    id: `route-provider-${provider}-${++ruleCounter}`,
    label: `Route to provider: ${provider}`,
    signalTypes,
    predicates: [{ key: 'provider', value: provider, mode: 'exact' }],
    logic: 'and',
    priority: 10,
    terminal: false,
    enabled: true,
  };
}

/** Create a rule that routes to clusters with a specific capability. */
export function routeByCapability(capability: string, signalTypes: SignalType[] = []): RouteRule {
  return {
    id: `route-capability-${capability}-${++ruleCounter}`,
    label: `Route to capability: ${capability}`,
    signalTypes,
    predicates: [{ key: 'capability', value: capability, mode: 'exact' }],
    logic: 'and',
    priority: 5,
    terminal: false,
    enabled: true,
  };
}

/** Create a rule that routes to clusters in a specific region. */
export function routeByRegion(region: string, signalTypes: SignalType[] = []): RouteRule {
  return {
    id: `route-region-${region}-${++ruleCounter}`,
    label: `Route to region: ${region}`,
    signalTypes,
    predicates: [{ key: 'region', value: region, mode: 'exact' }],
    logic: 'and',
    priority: 3,
    terminal: false,
    enabled: true,
  };
}

/** Create a catch-all rule that routes to any cluster with LLM capability. */
export function routeToAnyLLM(): RouteRule {
  return {
    id: `route-any-llm-${++ruleCounter}`,
    label: 'Route to any LLM cluster',
    signalTypes: ['llm:request'],
    predicates: [{ key: 'capability', value: 'llm', mode: 'exact' }],
    logic: 'and',
    priority: 1,
    terminal: false,
    enabled: true,
  };
}

/** Create a rule that routes CI signals to build clusters. */
export function routeToCIBuild(): RouteRule {
  return {
    id: `route-ci-build-${++ruleCounter}`,
    label: 'Route CI build signals',
    signalTypes: ['ci:build', 'ci:multicast'],
    predicates: [{ key: 'capability', value: 'ci-build', mode: 'exact' }],
    logic: 'and',
    priority: 10,
    terminal: false,
    enabled: true,
  };
}

/** Create a rule that routes CI signals to test clusters. */
export function routeToCITest(): RouteRule {
  return {
    id: `route-ci-test-${++ruleCounter}`,
    label: 'Route CI test signals',
    signalTypes: ['ci:test', 'ci:multicast'],
    predicates: [{ key: 'capability', value: 'ci-test', mode: 'exact' }],
    logic: 'and',
    priority: 10,
    terminal: false,
    enabled: true,
  };
}

/** Create a rule that routes CI signals to deploy clusters. */
export function routeToCIDeploy(): RouteRule {
  return {
    id: `route-ci-deploy-${++ruleCounter}`,
    label: 'Route CI deploy signals',
    signalTypes: ['ci:deploy', 'ci:multicast'],
    predicates: [{ key: 'capability', value: 'ci-deploy', mode: 'exact' }],
    logic: 'and',
    priority: 10,
    terminal: false,
    enabled: true,
  };
}

/** Create a rule that routes any CI signal to CI-capable clusters. */
export function routeToAnyCI(): RouteRule {
  return {
    id: `route-any-ci-${++ruleCounter}`,
    label: 'Route to any CI cluster',
    signalTypes: ['ci:build', 'ci:test', 'ci:deploy', 'ci:result', 'ci:pipeline', 'ci:multicast'],
    predicates: [{ key: 'capability', value: 'ci', mode: 'exact' }],
    logic: 'and',
    priority: 5,
    terminal: false,
    enabled: true,
  };
}
