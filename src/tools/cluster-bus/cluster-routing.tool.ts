/**
 * KemdiCode MCP Server - Cluster Bus Routing Tool
 * Copyright (C) 2025-2026 Kemdi Sp. z o.o. (Dawid Irzyk <dawid@kemdi.pl>)
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import { z } from 'zod';
import type { UnifiedTool } from '../registry.js';
import {
  isClusterBusActive,
  getClusterBus,
  ClusterProviderPool,
  routeByProvider,
  routeByCapability,
  routeByRegion,
  routeToAnyLLM,
  listClusters,
} from '../../cluster-bus/index.js';
import type { RouteRule, MatchMode, SignalType } from '../../cluster-bus/index.js';

const schema = z.object({
  action: z
    .enum([
      'list-rules',
      'add-rule',
      'add-preset',
      'remove-rule',
      'clear-rules',
      'test-route',
      'pool-snapshot',
      'select-cluster',
      'available-providers',
    ])
    .describe('Action: list-rules (show routing rules), add-rule (create routing rule), add-preset (use preset builder), remove-rule (delete rule by ID), clear-rules (remove all rules), test-route (test which clusters match a signal), pool-snapshot (view provider pool state), select-cluster (pick cluster for provider), available-providers (list registered providers)'),

  // For add-rule
  ruleId: z.string().optional().describe('Rule ID (for add-rule, remove-rule)'),
  label: z.string().optional().describe('Human-readable rule label'),
  signalTypes: z.array(z.string()).optional().describe('Signal types this rule applies to (empty = all)'),
  predicates: z
    .array(
      z.object({
        key: z.string().describe('Meta-tag key'),
        value: z.string().describe('Match value'),
        mode: z.enum(['exact', 'wildcard', 'regex', 'prefix']).default('exact').describe('Match mode: exact (literal match), wildcard (glob patterns with *), regex (regular expression), prefix (starts-with match)'),
      }),
    )
    .optional()
    .describe('Tag predicates for routing'),
  logic: z.enum(['and', 'or']).optional().describe('Predicate combination logic: and (all predicates must match), or (any predicate can match)'),
  priority: z.number().min(0).max(100).optional().describe('Rule priority (higher = evaluated first)'),
  terminal: z.boolean().optional().describe('Stop evaluating after this rule matches'),

  // For add-preset
  preset: z
    .enum(['by-provider', 'by-capability', 'by-region', 'any-llm'])
    .optional()
    .describe('Preset routing rule builder: by-provider (route by LLM provider name), by-capability (route by model capability), by-region (route by geographic region), any-llm (route to any cluster with LLM provider)'),
  presetValue: z.string().optional().describe('Value for preset (provider name, capability, region)'),

  // For test-route
  testSignalType: z.string().optional().describe('Signal type to test routing for'),

  // For select-cluster, available-providers
  providerId: z.string().optional().describe('Provider ID for cluster selection'),
  excludeClusters: z.array(z.string()).optional().describe('Cluster IDs to exclude from selection'),
  maxCount: z.number().min(1).max(20).optional().describe('Max clusters to select'),
});

export const clusterRoutingTool: UnifiedTool<typeof schema> = {
  name: 'cluster-bus-routing',
  description:
    'Manage meta-tag routing rules and provider pool: add/remove rules, test routing, discover providers, select clusters',
  zodSchema: schema,
  metadata: {
    category: 'cluster-bus',
    tags: ['cluster', 'routing', 'meta-tags', 'providers', 'pool'],
    examples: [
      { args: { action: 'list-rules' }, description: 'List all routing rules' },
      {
        args: {
          action: 'add-rule',
          ruleId: 'route-gpt5-llm',
          label: 'Route LLM to GPT-5.2 clusters',
          signalTypes: ['llm:request'],
          predicates: [{ key: 'model', value: 'gpt-5.2', mode: 'exact' }],
          logic: 'and',
          priority: 10,
          terminal: false,
        },
        description: 'Add a custom routing rule',
      },
      {
        args: { action: 'add-preset', preset: 'by-provider', presetValue: 'custom:navy' },
        description: 'Add preset rule routing to a specific provider',
      },
      { args: { action: 'test-route', testSignalType: 'llm:request' }, description: 'Test which clusters match' },
      { args: { action: 'pool-snapshot' }, description: 'Get aggregated provider pool view' },
      {
        args: { action: 'select-cluster', providerId: 'custom:navy', maxCount: 3 },
        description: 'Select best clusters for a provider',
      },
      { args: { action: 'available-providers' }, description: 'List all available providers across clusters' },
    ],
    relatedTools: ['cluster-bus-flow', 'cluster-bus-topology', 'cluster-bus-magistrale'],
  },

  execute: async (args) => {
    if (!isClusterBusActive()) {
      return 'Cluster bus is not active. Check Redis connectivity and server logs.';
    }

    const bus = getClusterBus();
    if (!bus) return 'Cluster bus not initialized.';

    const router = bus.router;

    switch (args.action) {
      case 'list-rules': {
        const rules = router.getRules();
        if (rules.length === 0) return 'No routing rules configured.';

        const lines = ['# Routing Rules', '', `Total: ${rules.length}`, ''];
        for (const rule of rules) {
          const predicateStr = rule.predicates
            .map((p) => `${p.key}${p.mode === 'exact' ? '=' : ` [${p.mode}] `}${p.value}`)
            .join(rule.logic === 'and' ? ' AND ' : ' OR ');

          lines.push(
            `### ${rule.label} (\`${rule.id}\`)`,
            `- **Signal Types:** ${rule.signalTypes.length > 0 ? rule.signalTypes.join(', ') : 'all'}`,
            `- **Predicates:** ${predicateStr || 'none (matches all)'}`,
            `- **Logic:** ${rule.logic} | **Priority:** ${rule.priority} | **Terminal:** ${rule.terminal ? 'yes' : 'no'} | **Enabled:** ${rule.enabled ? 'yes' : 'no'}`,
            '',
          );
        }
        return lines.join('\n');
      }

      case 'add-rule': {
        if (!args.ruleId || !args.label) {
          return 'Error: ruleId and label are required for add-rule.';
        }

        const rule: RouteRule = {
          id: args.ruleId,
          label: args.label,
          signalTypes: (args.signalTypes || []) as SignalType[],
          predicates: (args.predicates || []).map((p) => ({
            key: p.key,
            value: p.value,
            mode: p.mode as MatchMode,
          })),
          logic: args.logic || 'and',
          priority: args.priority ?? 5,
          terminal: args.terminal ?? false,
          enabled: true,
        };

        router.addRule(rule);

        return [
          `Routing rule added: **${rule.label}** (\`${rule.id}\`)`,
          `- Priority: ${rule.priority}`,
          `- Predicates: ${rule.predicates.length}`,
          `- Total rules: ${router.getRules().length}`,
        ].join('\n');
      }

      case 'add-preset': {
        if (!args.preset) return 'Error: preset is required for add-preset.';

        let rule: RouteRule;
        switch (args.preset) {
          case 'by-provider':
            if (!args.presetValue) return 'Error: presetValue (provider name) is required.';
            rule = routeByProvider(args.presetValue, (args.signalTypes || []) as SignalType[]);
            break;
          case 'by-capability':
            if (!args.presetValue) return 'Error: presetValue (capability) is required.';
            rule = routeByCapability(args.presetValue, (args.signalTypes || []) as SignalType[]);
            break;
          case 'by-region':
            if (!args.presetValue) return 'Error: presetValue (region) is required.';
            rule = routeByRegion(args.presetValue, (args.signalTypes || []) as SignalType[]);
            break;
          case 'any-llm':
            rule = routeToAnyLLM();
            break;
        }

        router.addRule(rule);
        return `Preset rule added: **${rule.label}** (\`${rule.id}\`), priority=${rule.priority}. Total rules: ${router.getRules().length}`;
      }

      case 'remove-rule': {
        if (!args.ruleId) return 'Error: ruleId is required for remove-rule.';
        const removed = router.removeRule(args.ruleId);
        return removed
          ? `Rule '${args.ruleId}' removed. Remaining: ${router.getRules().length}`
          : `Rule '${args.ruleId}' not found.`;
      }

      case 'clear-rules': {
        const beforeCount = router.getRules().length;
        router.clearRules();
        return `Cleared all ${beforeCount} routing rules.`;
      }

      case 'test-route': {
        const signalType = (args.testSignalType || 'llm:request') as SignalType;
        const clusters = await listClusters();
        const onlineClusters = clusters.filter((c) => c.status === 'online');

        const lines = [
          `# Route Test: ${signalType}`,
          '',
          `Testing against ${onlineClusters.length} online clusters:`,
          '',
        ];

        for (const cluster of onlineClusters) {
          const matches = router.matches(cluster, signalType);
          const tags = cluster.metaTags.map((t) => `${t.key}:${t.value}`).join(', ');
          lines.push(
            `- ${matches ? '✓' : '✗'} **${cluster.name}** (\`${cluster.id}\`) — tags: ${tags || 'none'}`,
          );
        }

        const matchCount = onlineClusters.filter((c) => router.matches(c, signalType)).length;
        lines.push('', `**Result:** ${matchCount}/${onlineClusters.length} clusters match for \`${signalType}\``);

        return lines.join('\n');
      }

      case 'pool-snapshot': {
        const pool = new ClusterProviderPool(bus.clusterId);
        const snapshot = await pool.getSnapshot(true);

        if (snapshot.providers.length === 0) {
          return 'No providers available across the cluster mesh.';
        }

        const lines = [
          '# Provider Pool Snapshot',
          '',
          `- **Total Providers:** ${snapshot.totalProviders}`,
          `- **Online Clusters:** ${snapshot.totalClusters}`,
          `- **Snapshot:** ${new Date(snapshot.snapshotAt).toISOString()}`,
          '',
        ];

        for (const p of snapshot.providers) {
          lines.push(
            `### ${p.providerId}${p.custom ? ' (custom)' : ''}`,
            `- **Clusters:** ${p.clusterIds.join(', ')} (${p.clusterCount})`,
            `- **Available:** ${p.available ? 'yes' : 'no'}`,
            `- **Avg Load:** ${(p.avgLoad * 100).toFixed(0)}%`,
            ...(p.baseURL ? [`- **Base URL:** ${p.baseURL}`] : []),
            ...(p.models?.length ? [`- **Models:** ${p.models.join(', ')}`] : []),
            '',
          );
        }

        return lines.join('\n');
      }

      case 'select-cluster': {
        if (!args.providerId) return 'Error: providerId is required for select-cluster.';

        const pool = new ClusterProviderPool(bus.clusterId);
        const maxCount = args.maxCount || 1;

        if (maxCount === 1) {
          const selected = await pool.selectCluster({
            providerId: args.providerId,
            excludeClusters: args.excludeClusters,
          });

          if (!selected) return `No available cluster for provider '${args.providerId}'.`;

          const tags = selected.metaTags.map((t) => `${t.key}:${t.value}`).join(', ');
          return [
            `Selected cluster for **${args.providerId}**:`,
            `- **Name:** ${selected.name}`,
            `- **ID:** ${selected.id}`,
            `- **Status:** ${selected.status}`,
            `- **Tags:** ${tags || 'none'}`,
          ].join('\n');
        }

        const selected = await pool.selectClusters(
          { providerId: args.providerId, excludeClusters: args.excludeClusters },
          maxCount,
        );

        if (selected.length === 0) return `No available clusters for provider '${args.providerId}'.`;

        const lines = [`# Selected ${selected.length} Clusters for ${args.providerId}`, ''];
        for (const node of selected) {
          const tags = node.metaTags.map((t) => `${t.key}:${t.value}`).join(', ');
          lines.push(`- **${node.name}** (\`${node.id}\`) — ${node.status}, tags: ${tags || 'none'}`);
        }
        return lines.join('\n');
      }

      case 'available-providers': {
        const pool = new ClusterProviderPool(bus.clusterId);
        const providers = await pool.getAvailableProviders();

        if (providers.length === 0) return 'No providers available across the cluster mesh.';

        const lines = ['# Available Providers', '', `Total: ${providers.length}`, ''];
        for (const pid of providers) {
          const clusters = await pool.getClustersForProvider(pid);
          lines.push(`- **${pid}**: ${clusters.length} cluster(s) — ${clusters.join(', ')}`);
        }
        return lines.join('\n');
      }

      default:
        return 'Unknown action.';
    }
  },
};
