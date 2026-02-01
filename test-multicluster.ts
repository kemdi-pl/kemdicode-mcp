/**
 * Multi-Cluster Test — 3 clusters with custom endpoints
 *
 * Cluster Alpha: iFlow (Chinese models — Qwen3, DeepSeek, Kimi)
 * Cluster Beta:  LiteRouter (Western models — GPT, Claude, Gemini)
 * Cluster Gamma: LiteRouter (Open-source — Llama, Mistral, Qwen3-32b)
 *
 * Tests:
 * 1. Register custom endpoints (hot-reload)
 * 2. Register 3 clusters in Redis
 * 3. List topology
 * 4. Dispatch prompt via provider pool
 * 5. Cross-cluster model comparison
 */

import {
  registerCustomEndpoint,
  listCustomEndpoints,
  listProviders,
} from './src/ai/providers/registry.js';
import { registerBuiltinProviders } from './src/ai/providers/registry.js';
import {
  registerCluster,
  listClusters,
  getTopology,
  topologyToMermaid,
} from './src/cluster-bus/cluster-registry.js';
import { ClusterProviderPool } from './src/cluster-bus/provider-pool.js';
import { complete } from './src/ai/client.js';
import { initAIClient } from './src/ai/client.js';
import { getSharedRedis } from './src/infrastructure/redis/connection.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const IFLOW_URL = 'https://apis.iflow.cn/v1';
const IFLOW_KEY = 'sk-4a7083e46dce88ddf3c43b1629553c6c';

const LITEROUTER_URL = 'https://api.literouter.com/v1';
const LITEROUTER_KEY = 'e2d61109024b0fa7ddc51450de708e9302cc399aab3ef588401a0daae4034b1e';

const TEST_PROMPT = 'What is the capital of Poland? Answer in one short sentence.';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(section: string, msg: string) {
  console.log(`\n[${'='.repeat(60)}]`);
  console.log(`[${section}] ${msg}`);
  console.log(`[${'='.repeat(60)}]`);
}

function info(msg: string) {
  console.log(`  → ${msg}`);
}

async function timedComplete(model: string, label: string): Promise<{ content: string; ms: number; model: string }> {
  const start = Date.now();
  try {
    const result = await complete({
      model,
      messages: [{ role: 'user', content: TEST_PROMPT }],
      maxTokens: 100,
      temperature: 0.3,
    });
    const ms = Date.now() - start;
    return { content: result.content.trim(), ms, model: result.model };
  } catch (err) {
    const ms = Date.now() - start;
    return { content: `ERROR: ${err instanceof Error ? err.message : String(err)}`, ms, model };
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Ensure Redis is available
  try {
    const redis = await getSharedRedis();
    await redis.ping();
    info('Redis connected');
  } catch {
    console.error('Redis not available. Start Redis first.');
    process.exit(1);
  }

  // =========================================================================
  // STEP 1: Register custom endpoints (hot-reload)
  // =========================================================================
  log('STEP 1', 'Registering custom endpoints (hot-reload)');

  registerBuiltinProviders();

  // Initialize a dummy default client (needed for fallback path)
  try {
    initAIClient({
      baseURL: LITEROUTER_URL,
      apiKey: LITEROUTER_KEY,
      defaultModel: 'deepseek-v3',
    });
  } catch {
    // May already be initialized
  }

  const iflowId = registerCustomEndpoint({
    name: 'iflow',
    baseURL: IFLOW_URL,
    apiKey: IFLOW_KEY,
    defaultModel: 'qwen3-max',
    models: ['qwen3-max', 'deepseek-r1', 'deepseek-v3', 'kimi-k2', 'glm-4.6'],
  });
  info(`Registered: ${iflowId} → ${IFLOW_URL}`);

  const literouterId = registerCustomEndpoint({
    name: 'literouter',
    baseURL: LITEROUTER_URL,
    apiKey: LITEROUTER_KEY,
    defaultModel: 'deepseek-v3',
    models: ['gpt-4o', 'claude-sonnet-4.5', 'gemini-2.5-flash', 'deepseek-v3', 'grok-3-mini'],
  });
  info(`Registered: ${literouterId} → ${LITEROUTER_URL}`);

  const liteopenId = registerCustomEndpoint({
    name: 'liteopen',
    baseURL: LITEROUTER_URL,
    apiKey: LITEROUTER_KEY,
    defaultModel: 'llama-4-maverick',
    models: ['llama-4-maverick', 'mistral-large-latest', 'qwen3-32b', 'kimi-k2'],
  });
  info(`Registered: ${liteopenId} → ${LITEROUTER_URL}`);

  info(`Total custom endpoints: ${listCustomEndpoints().length}`);
  info(`Total providers (builtin + custom): ${listProviders().length}`);

  // =========================================================================
  // STEP 2: Register 3 clusters in Redis
  // =========================================================================
  log('STEP 2', 'Registering 3 clusters in Redis');

  const clusterAlpha = await registerCluster({
    id: 'cluster-alpha',
    name: 'Alpha (iFlow — Chinese Models)',
    metaTags: [
      { key: 'provider', value: 'iflow' },
      { key: 'region', value: 'cn' },
      { key: 'tier', value: 'primary' },
      { key: 'role', value: 'reasoning' },
    ],
    connectedProviders: ['custom:iflow'],
    customEndpoints: [{
      name: 'iflow',
      baseURL: IFLOW_URL,
      requiresApiKey: true,
      defaultModel: 'qwen3-max',
      models: ['qwen3-max', 'deepseek-r1', 'deepseek-v3', 'kimi-k2', 'glm-4.6'],
    }],
    capabilities: ['llm', 'reasoning', 'code-analysis'],
  });
  info(`Registered: ${clusterAlpha.id} — ${clusterAlpha.name}`);

  const clusterBeta = await registerCluster({
    id: 'cluster-beta',
    name: 'Beta (LiteRouter — Western Flagships)',
    metaTags: [
      { key: 'provider', value: 'literouter' },
      { key: 'region', value: 'us' },
      { key: 'tier', value: 'primary' },
      { key: 'role', value: 'general' },
    ],
    connectedProviders: ['custom:literouter'],
    customEndpoints: [{
      name: 'literouter',
      baseURL: LITEROUTER_URL,
      requiresApiKey: true,
      defaultModel: 'deepseek-v3',
      models: ['gpt-4o', 'claude-sonnet-4.5', 'gemini-2.5-flash', 'deepseek-v3', 'grok-3-mini'],
    }],
    capabilities: ['llm', 'general', 'code-review'],
  });
  info(`Registered: ${clusterBeta.id} — ${clusterBeta.name}`);

  const clusterGamma = await registerCluster({
    id: 'cluster-gamma',
    name: 'Gamma (LiteRouter — Open Source)',
    metaTags: [
      { key: 'provider', value: 'liteopen' },
      { key: 'region', value: 'us' },
      { key: 'tier', value: 'secondary' },
      { key: 'role', value: 'fast' },
    ],
    connectedProviders: ['custom:liteopen'],
    customEndpoints: [{
      name: 'liteopen',
      baseURL: LITEROUTER_URL,
      requiresApiKey: true,
      defaultModel: 'llama-4-maverick',
      models: ['llama-4-maverick', 'mistral-large-latest', 'qwen3-32b', 'kimi-k2'],
    }],
    capabilities: ['llm', 'fast', 'open-source'],
  });
  info(`Registered: ${clusterGamma.id} — ${clusterGamma.name}`);

  // =========================================================================
  // STEP 3: View topology
  // =========================================================================
  log('STEP 3', 'Cluster topology');

  const clusters = await listClusters();
  info(`Active clusters: ${clusters.length}`);
  for (const c of clusters) {
    info(`  ${c.id} | ${c.name} | providers: ${c.connectedProviders.join(', ')} | status: ${c.status}`);
    if (c.customEndpoints?.length) {
      for (const ep of c.customEndpoints) {
        info(`    custom:${ep.name} → ${ep.baseURL} | models: ${ep.models?.join(', ') || '?'}`);
      }
    }
  }

  const topology = await getTopology();
  info(`\nMermaid diagram:\n${topologyToMermaid(topology)}`);

  // =========================================================================
  // STEP 4: Provider pool snapshot
  // =========================================================================
  log('STEP 4', 'Provider pool snapshot');

  const pool = new ClusterProviderPool('test-orchestrator');
  const snapshot = await pool.getSnapshot(true);
  info(`Total providers in mesh: ${snapshot.totalProviders}`);
  info(`Total online clusters: ${snapshot.totalClusters}`);
  for (const p of snapshot.providers) {
    info(`  ${p.providerId} | clusters: ${p.clusterIds.join(', ')} | custom: ${p.custom || false}`);
    if (p.models?.length) info(`    models: ${p.models.join(', ')}`);
  }

  // =========================================================================
  // STEP 5: Dispatch prompts to models across clusters
  // =========================================================================
  log('STEP 5', `Dispatching prompt: "${TEST_PROMPT}"`);

  // Group by cluster — iFlow has no rate limit, LiteRouter needs 8s between requests
  const iflowModels = [
    { label: 'Alpha/Qwen3-Max', spec: 'custom:iflow:qwen3-max' },
    { label: 'Alpha/DeepSeek-V3', spec: 'custom:iflow:deepseek-v3' },
    { label: 'Alpha/Kimi-K2', spec: 'custom:iflow:kimi-k2' },
  ];

  const literouterModels = [
    { label: 'Beta/GPT-4o', spec: 'custom:literouter:gpt-4o' },
    { label: 'Beta/DeepSeek-V3', spec: 'custom:literouter:deepseek-v3' },
    { label: 'Gamma/Llama-4-Maverick', spec: 'custom:liteopen:llama-4-maverick' },
    { label: 'Gamma/Qwen3-32b', spec: 'custom:liteopen:qwen3-32b' },
  ];

  const allModels = [...iflowModels, ...literouterModels];
  info(`Dispatching to ${allModels.length} models (iFlow parallel, LiteRouter sequential with 8s delay)...\n`);

  // iFlow — parallel (no rate limit)
  const iflowResults = await Promise.allSettled(
    iflowModels.map((m) => timedComplete(m.spec, m.label)),
  );

  // LiteRouter — sequential with delay (rate limit: 7s between messages)
  const liteResults: PromiseSettledResult<{ content: string; ms: number; model: string }>[] = [];
  for (const m of literouterModels) {
    const result = await timedComplete(m.spec, m.label);
    liteResults.push({ status: 'fulfilled', value: result });
    info(`  ${m.label}: ${result.content.slice(0, 60)}... (${result.ms}ms)`);
    // Wait 8s for rate limit cooldown
    if (m !== literouterModels[literouterModels.length - 1]) {
      info('  (waiting 8s for LiteRouter rate limit...)');
      await new Promise((r) => setTimeout(r, 8000));
    }
  }

  const allResults = [...iflowResults, ...liteResults];

  console.log('\n' + '─'.repeat(80));
  console.log('RESULTS');
  console.log('─'.repeat(80));

  for (let i = 0; i < allModels.length; i++) {
    const m = allModels[i];
    const r = allResults[i];
    if (r.status === 'fulfilled') {
      const { content, ms } = r.value;
      console.log(`\n  [${m.label}] (${ms}ms)`);
      console.log(`    ${content.slice(0, 200)}`);
    } else {
      console.log(`\n  [${m.label}] FAILED`);
      console.log(`    ${r.reason}`);
    }
  }

  // =========================================================================
  // STEP 6: Hot-reload test — change iflow default model
  // =========================================================================
  log('STEP 6', 'Hot-reload: changing iflow default model to kimi-k2');

  registerCustomEndpoint({
    name: 'iflow',
    baseURL: IFLOW_URL,
    apiKey: IFLOW_KEY,
    defaultModel: 'kimi-k2',
    models: ['qwen3-max', 'deepseek-r1', 'kimi-k2', 'glm-4.6'],
  });
  info('Hot-reload complete — testing custom:iflow:kimi-k2...');

  const kimiResult = await timedComplete('custom:iflow:kimi-k2', 'iflow/kimi-k2');
  console.log(`\n  [iflow/kimi-k2] (${kimiResult.ms}ms)`);
  console.log(`    ${kimiResult.content.slice(0, 200)}`);

  // =========================================================================
  // DONE
  // =========================================================================
  log('DONE', 'Multi-cluster test complete');

  // Cleanup — don't deregister so the clusters remain visible for inspection
  process.exit(0);
}

main().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
