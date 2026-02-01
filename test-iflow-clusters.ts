/**
 * iFlow Multi-Cluster Test — Coding + Thinking models, no rate limit
 *
 * Cluster Code:  qwen3-coder-plus, deepseek-v3.2
 * Cluster Think: deepseek-r1, qwen3-235b-a22b-thinking-2507
 * Cluster General: qwen3-max, kimi-k2
 *
 * All parallel — iFlow has no rate limit.
 */

import {
  registerCustomEndpoint,
  registerBuiltinProviders,
} from './src/ai/providers/registry.js';
import {
  registerCluster,
  listClusters,
  getTopology,
  topologyToMermaid,
} from './src/cluster-bus/cluster-registry.js';
import { ClusterProviderPool } from './src/cluster-bus/provider-pool.js';
import { complete, initAIClient } from './src/ai/client.js';
import { getSharedRedis } from './src/infrastructure/redis/connection.js';

const IFLOW_URL = 'https://apis.iflow.cn/v1';
const IFLOW_KEY = 'sk-4a7083e46dce88ddf3c43b1629553c6c';

const CODING_PROMPT = `Write a TypeScript function that implements a simple LRU cache with get() and put() methods. Max 20 lines. No comments needed.`;

const THINKING_PROMPT = `A farmer has 3 wolves and 3 sheep. He needs to transport them across a river in a boat that holds max 2 animals. Wolves can never outnumber sheep on either side. What is the minimum number of crossings? Show your reasoning step by step.`;

function log(section: string, msg: string) {
  console.log(`\n[${'='.repeat(60)}]`);
  console.log(`[${section}] ${msg}`);
  console.log(`[${'='.repeat(60)}]`);
}

function info(msg: string) {
  console.log(`  → ${msg}`);
}

async function timedComplete(
  model: string,
  prompt: string,
  maxTokens = 1024,
): Promise<{ content: string; ms: number; model: string; tokens?: number }> {
  const start = Date.now();
  try {
    const result = await complete({
      model,
      messages: [{ role: 'user', content: prompt }],
      maxTokens,
      temperature: 0.3,
    });
    const ms = Date.now() - start;
    return {
      content: result.content.trim(),
      ms,
      model: result.model,
      tokens: result.usage?.completionTokens,
    };
  } catch (err) {
    const ms = Date.now() - start;
    return { content: `ERROR: ${err instanceof Error ? err.message : String(err)}`, ms, model };
  }
}

async function main() {
  const redis = await getSharedRedis();
  await redis.ping();

  registerBuiltinProviders();
  try {
    initAIClient({ baseURL: IFLOW_URL, apiKey: IFLOW_KEY, defaultModel: 'qwen3-max' });
  } catch { /* already init */ }

  // =========================================================================
  // Register 3 specialized endpoints on iFlow
  // =========================================================================
  log('SETUP', 'Registering 3 iFlow clusters');

  registerCustomEndpoint({
    name: 'iflow-code',
    baseURL: IFLOW_URL,
    apiKey: IFLOW_KEY,
    defaultModel: 'qwen3-coder-plus',
    models: ['qwen3-coder-plus', 'deepseek-v3.2'],
  });

  registerCustomEndpoint({
    name: 'iflow-think',
    baseURL: IFLOW_URL,
    apiKey: IFLOW_KEY,
    defaultModel: 'deepseek-r1',
    models: ['deepseek-r1', 'qwen3-235b-a22b-thinking-2507'],
  });

  registerCustomEndpoint({
    name: 'iflow-general',
    baseURL: IFLOW_URL,
    apiKey: IFLOW_KEY,
    defaultModel: 'qwen3-max',
    models: ['qwen3-max', 'kimi-k2'],
  });

  await registerCluster({
    id: 'cluster-code',
    name: 'Code Specialists (Qwen3-Coder, DeepSeek-V3.2)',
    metaTags: [
      { key: 'role', value: 'coding' },
      { key: 'provider', value: 'iflow' },
    ],
    connectedProviders: ['custom:iflow-code'],
    customEndpoints: [{
      name: 'iflow-code', baseURL: IFLOW_URL, requiresApiKey: true,
      defaultModel: 'qwen3-coder-plus',
      models: ['qwen3-coder-plus', 'deepseek-v3.2'],
    }],
    capabilities: ['llm', 'coding'],
  });

  await registerCluster({
    id: 'cluster-think',
    name: 'Thinking Specialists (DeepSeek-R1, Qwen3-235b-Thinking)',
    metaTags: [
      { key: 'role', value: 'reasoning' },
      { key: 'provider', value: 'iflow' },
    ],
    connectedProviders: ['custom:iflow-think'],
    customEndpoints: [{
      name: 'iflow-think', baseURL: IFLOW_URL, requiresApiKey: true,
      defaultModel: 'deepseek-r1',
      models: ['deepseek-r1', 'qwen3-235b-a22b-thinking-2507'],
    }],
    capabilities: ['llm', 'reasoning', 'thinking'],
  });

  await registerCluster({
    id: 'cluster-general',
    name: 'General Purpose (Qwen3-Max, Kimi-K2)',
    metaTags: [
      { key: 'role', value: 'general' },
      { key: 'provider', value: 'iflow' },
    ],
    connectedProviders: ['custom:iflow-general'],
    customEndpoints: [{
      name: 'iflow-general', baseURL: IFLOW_URL, requiresApiKey: true,
      defaultModel: 'qwen3-max',
      models: ['qwen3-max', 'kimi-k2'],
    }],
    capabilities: ['llm', 'general'],
  });

  // =========================================================================
  // Topology
  // =========================================================================
  log('TOPOLOGY', 'Cluster mesh');
  const clusters = await listClusters();
  for (const c of clusters) {
    if (!c.id.startsWith('cluster-')) continue;
    info(`${c.id} | ${c.name} | ${c.connectedProviders.join(', ')}`);
  }
  const topo = await getTopology();
  info(`\n${topologyToMermaid(topo)}`);

  const pool = new ClusterProviderPool('orchestrator');
  const snap = await pool.getSnapshot(true);
  info(`\nProvider pool: ${snap.totalProviders} providers across ${snap.totalClusters} clusters`);

  // =========================================================================
  // CODING TEST — all parallel
  // =========================================================================
  log('CODING TEST', CODING_PROMPT.slice(0, 80) + '...');

  const codeModels = [
    { label: 'Qwen3-Coder-Plus', spec: 'custom:iflow-code:qwen3-coder-plus' },
    { label: 'DeepSeek-V3.2', spec: 'custom:iflow-code:deepseek-v3.2' },
    { label: 'Qwen3-Max (general)', spec: 'custom:iflow-general:qwen3-max' },
    { label: 'Kimi-K2 (general)', spec: 'custom:iflow-general:kimi-k2' },
  ];

  info(`Dispatching to ${codeModels.length} models in parallel...\n`);
  const codeResults = await Promise.allSettled(
    codeModels.map((m) => timedComplete(m.spec, CODING_PROMPT)),
  );

  for (let i = 0; i < codeModels.length; i++) {
    const m = codeModels[i];
    const r = codeResults[i];
    if (r.status === 'fulfilled') {
      const { content, ms, tokens } = r.value;
      console.log(`\n  [${m.label}] ${ms}ms | ${tokens ?? '?'} tokens`);
      console.log('  ' + '─'.repeat(50));
      // Print first 500 chars
      for (const line of content.slice(0, 500).split('\n')) {
        console.log(`    ${line}`);
      }
      if (content.length > 500) console.log('    ...');
    } else {
      console.log(`\n  [${m.label}] FAILED: ${r.reason}`);
    }
  }

  // =========================================================================
  // THINKING TEST — all parallel
  // =========================================================================
  log('THINKING TEST', THINKING_PROMPT.slice(0, 80) + '...');

  const thinkModels = [
    { label: 'DeepSeek-R1 (thinking)', spec: 'custom:iflow-think:deepseek-r1' },
    { label: 'Qwen3-235b-Thinking', spec: 'custom:iflow-think:qwen3-235b-a22b-thinking-2507' },
    { label: 'Qwen3-Max (general)', spec: 'custom:iflow-general:qwen3-max' },
  ];

  info(`Dispatching to ${thinkModels.length} models in parallel...\n`);
  const thinkResults = await Promise.allSettled(
    thinkModels.map((m) => timedComplete(m.spec, THINKING_PROMPT, 2048)),
  );

  for (let i = 0; i < thinkModels.length; i++) {
    const m = thinkModels[i];
    const r = thinkResults[i];
    if (r.status === 'fulfilled') {
      const { content, ms, tokens } = r.value;
      console.log(`\n  [${m.label}] ${ms}ms | ${tokens ?? '?'} tokens`);
      console.log('  ' + '─'.repeat(50));
      for (const line of content.slice(0, 600).split('\n')) {
        console.log(`    ${line}`);
      }
      if (content.length > 600) console.log('    ...');
    } else {
      console.log(`\n  [${m.label}] FAILED: ${r.reason}`);
    }
  }

  // =========================================================================
  // HOT-RELOAD TEST
  // =========================================================================
  log('HOT-RELOAD', 'Switching iflow-code from qwen3-coder-plus → deepseek-v3.2 as default');

  registerCustomEndpoint({
    name: 'iflow-code',
    baseURL: IFLOW_URL,
    apiKey: IFLOW_KEY,
    defaultModel: 'deepseek-v3.2',
    models: ['qwen3-coder-plus', 'deepseek-v3.2'],
  });

  const reloadResult = await timedComplete(
    'custom:iflow-code:deepseek-v3.2',
    'Write a one-liner TypeScript arrow function that reverses a string.',
    200,
  );
  console.log(`\n  [Hot-reloaded DeepSeek-V3.2] ${reloadResult.ms}ms`);
  console.log(`    ${reloadResult.content.slice(0, 200)}`);

  log('DONE', 'All tests complete — 3 clusters, 6 models, 0 rate limit delays');
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
