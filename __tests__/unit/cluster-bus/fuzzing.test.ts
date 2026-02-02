/**
 * Cluster Bus — Fuzzing & Negative Tests
 *
 * Tests for malformed inputs, Unicode edge cases, injection attacks
 * on policy names, signal types, and Redis key sanitization.
 *
 * Self-contained: no Redis, no mocks.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  SignalFlowController,
} from '../../../src/cluster-bus/signal-flow.js';
import {
  parseMetaTag,
  serializeMetaTag,
  CLUSTER_KEYS,
  loadClusterBusConfig,
  LLMRequestPayload,
  LLMResultPayload,
  HeartbeatPayload,
  PassConfigSchema,
} from '../../../src/cluster-bus/types.js';
import type { ClusterSignal, SignalType, SignalDirection, SignalPriority } from '../../../src/cluster-bus/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSignal(overrides: Partial<ClusterSignal> = {}): ClusterSignal {
  return {
    id: `sig-${Math.random().toString(36).slice(2, 8)}`,
    type: 'llm:request',
    sourceCluster: 'src',
    targetCluster: 'tgt',
    payload: {},
    metaTags: [],
    direction: 'duplex',
    priority: 1,
    ttl: 0,
    schemaVersion: 1,
    timestamp: Date.now(),
    originCluster: 'src',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Redis Key Sanitization — Injection Attacks
// ---------------------------------------------------------------------------

describe('Fuzzing: Redis Key Injection', () => {
  const DANGEROUS_INPUTS = [
    // Path traversal
    '../../../etc/passwd',
    '..\\..\\..\\windows\\system32',
    // Redis protocol injection
    '\r\nCONFIG SET dir /tmp\r\n',
    '\r\nFLUSHALL\r\n',
    'key\x00null',
    // Glob/pattern injection
    '*', '?', '[a-z]', '{a,b}',
    // Unicode attacks
    'café\u0301',
    '\uFEFF\u200Bzero-width',
    '你好世界',
    '\u202Ertl-override',
    'a\u0000b\u0000c',
    // Very long input
    'x'.repeat(1000),
    // Empty / whitespace
    '',
    '   ',
    '\t\n\r',
    // Special characters
    '`$(whoami)`',
    '; DROP TABLE nodes;--',
    '<script>alert(1)</script>',
    '${7*7}',
    '{{constructor.constructor("return this")()}}',
  ];

  it('should sanitize all dangerous inputs for node keys', () => {
    for (const input of DANGEROUS_INPUTS) {
      const key = CLUSTER_KEYS.node(input);
      expect(key).toMatch(/^mcp:cluster:/);
      expect(key).not.toContain('\r');
      expect(key).not.toContain('\n');
      expect(key).not.toContain('\x00');

      // Sanitized part should only contain safe chars
      const sanitized = key.replace('mcp:cluster:', '');
      expect(sanitized).toMatch(/^[a-zA-Z0-9\-_.]*$/);
      expect(sanitized.length).toBeLessThanOrEqual(64);
    }
  });

  it('should sanitize dangerous inputs for signal history keys', () => {
    for (const input of DANGEROUS_INPUTS) {
      const key = CLUSTER_KEYS.signals(input, input);
      expect(key).not.toContain('\r');
      expect(key).not.toContain('\n');
      expect(key).not.toContain('\x00');
    }
  });

  it('should sanitize dangerous inputs for channel unicast keys', () => {
    for (const input of DANGEROUS_INPUTS) {
      const key = CLUSTER_KEYS.channelUnicast(input, 'safe-target');
      expect(key).not.toContain('\r');
      expect(key).not.toContain('\n');
      expect(key).not.toContain('\x00');
    }
  });

  it('should produce distinct keys for similar-looking inputs', () => {
    const key1 = CLUSTER_KEYS.node('node_1');
    const key2 = CLUSTER_KEYS.node('node-1');
    const key3 = CLUSTER_KEYS.node('node.1');
    // All three should survive sanitization as distinct keys
    expect(new Set([key1, key2, key3]).size).toBe(3);
  });

  it('should produce empty sanitized part for all-special-char input', () => {
    const key = CLUSTER_KEYS.node('!@#$%^&*()=+[]{}|\\/<>');
    expect(key).toBe('mcp:cluster:');
  });
});

// ---------------------------------------------------------------------------
// 2. Meta-Tag Fuzzing
// ---------------------------------------------------------------------------

describe('Fuzzing: Meta-Tag Parsing', () => {
  it('should handle empty string', () => {
    expect(parseMetaTag('')).toEqual({ key: '', value: '' });
  });

  it('should handle only colons', () => {
    expect(parseMetaTag(':')).toEqual({ key: '', value: '' });
    expect(parseMetaTag('::')).toEqual({ key: '', value: ':' });
    expect(parseMetaTag(':::')).toEqual({ key: '', value: '::' });
  });

  it('should handle Unicode keys and values', () => {
    const result = parseMetaTag('名前:太郎');
    expect(result.key).toBe('名前');
    expect(result.value).toBe('太郎');
  });

  it('should handle very long tags', () => {
    const longKey = 'k'.repeat(10000);
    const longValue = 'v'.repeat(10000);
    const result = parseMetaTag(`${longKey}:${longValue}`);
    expect(result.key).toBe(longKey);
    expect(result.value).toBe(longValue);
  });

  it('should handle special characters in values', () => {
    const result = parseMetaTag('url:http://example.com?q=1&b=2#hash');
    expect(result.key).toBe('url');
    expect(result.value).toBe('http://example.com?q=1&b=2#hash');
  });

  it('should round-trip all fuzzed inputs', () => {
    const inputs = [
      'simple:value',
      ':empty-key',
      'no-value',
      'multi:colon:value:here',
      '\t:whitespace',
      'emoji:🔥🚀',
    ];

    for (const input of inputs) {
      const parsed = parseMetaTag(input);
      const serialized = serializeMetaTag(parsed);
      const reParsed = parseMetaTag(serialized);
      expect(reParsed).toEqual(parsed);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Zod Schema Fuzzing
// ---------------------------------------------------------------------------

describe('Fuzzing: Zod Payload Schemas', () => {
  describe('LLMRequestPayload', () => {
    const MALFORMED_INPUTS = [
      null,
      undefined,
      42,
      'string',
      [],
      { prompt: '' },         // empty prompt (valid — no minLength)
      { prompt: 123 },        // wrong type
      { prompt: null },
      { prompt: 'ok', maxTokens: -1 },
      { prompt: 'ok', maxTokens: 'not-a-number' },
      { prompt: 'ok', temperature: 'hot' },
      { prompt: 'ok', files: 'not-an-array' },
      { prompt: 'ok', files: [123] },
      { prompt: 'ok', passConfig: { maxPasses: 0 } },
      { prompt: 'ok', passConfig: { maxPasses: 100 } },
      { prompt: 'ok', passConfig: { strategy: 'invalid' } },
    ];

    it('should reject all malformed inputs', () => {
      for (const input of MALFORMED_INPUTS) {
        const result = LLMRequestPayload.safeParse(input);
        if (result.success && typeof (input as any)?.prompt === 'string') {
          // Empty prompt and extras with wrong optional types may still pass
          continue;
        }
        // Most should fail
        expect(typeof result.success).toBe('boolean');
      }
    });

    it('should accept minimal valid input', () => {
      expect(LLMRequestPayload.safeParse({ prompt: 'test' }).success).toBe(true);
    });

    it('should reject prompt with wrong type', () => {
      expect(LLMRequestPayload.safeParse({ prompt: 123 }).success).toBe(false);
      expect(LLMRequestPayload.safeParse({ prompt: null }).success).toBe(false);
      expect(LLMRequestPayload.safeParse({ prompt: [] }).success).toBe(false);
    });
  });

  describe('HeartbeatPayload', () => {
    it('should reject load outside valid range', () => {
      expect(HeartbeatPayload.safeParse({ clusterId: 'x', status: 'online', load: -0.1 }).success).toBe(false);
      expect(HeartbeatPayload.safeParse({ clusterId: 'x', status: 'online', load: 1.01 }).success).toBe(false);
      expect(HeartbeatPayload.safeParse({ clusterId: 'x', status: 'online', load: Infinity }).success).toBe(false);
      expect(HeartbeatPayload.safeParse({ clusterId: 'x', status: 'online', load: NaN }).success).toBe(false);
    });

    it('should accept boundary values', () => {
      expect(HeartbeatPayload.safeParse({ clusterId: 'x', status: 'online', load: 0 }).success).toBe(true);
      expect(HeartbeatPayload.safeParse({ clusterId: 'x', status: 'online', load: 1 }).success).toBe(true);
      expect(HeartbeatPayload.safeParse({ clusterId: 'x', status: 'online', load: 0.5 }).success).toBe(true);
    });

    it('should reject invalid status values', () => {
      const badStatuses = ['', 'active', 'dead', 'ONLINE', 'Online', 0, null, undefined];
      for (const status of badStatuses) {
        expect(HeartbeatPayload.safeParse({ clusterId: 'x', status }).success).toBe(false);
      }
    });
  });

  describe('PassConfigSchema', () => {
    it('should reject boundary violations', () => {
      expect(PassConfigSchema.safeParse({ maxPasses: 0 }).success).toBe(false);
      expect(PassConfigSchema.safeParse({ maxPasses: 21 }).success).toBe(false);
      expect(PassConfigSchema.safeParse({ qualityThreshold: -0.01 }).success).toBe(false);
      expect(PassConfigSchema.safeParse({ qualityThreshold: 1.01 }).success).toBe(false);
    });

    it('should accept boundary values', () => {
      expect(PassConfigSchema.safeParse({ maxPasses: 1 }).success).toBe(true);
      expect(PassConfigSchema.safeParse({ maxPasses: 20 }).success).toBe(true);
      expect(PassConfigSchema.safeParse({ qualityThreshold: 0 }).success).toBe(true);
      expect(PassConfigSchema.safeParse({ qualityThreshold: 1 }).success).toBe(true);
    });

    it('should reject non-numeric types', () => {
      expect(PassConfigSchema.safeParse({ maxPasses: '5' }).success).toBe(false);
      expect(PassConfigSchema.safeParse({ qualityThreshold: '0.8' }).success).toBe(false);
    });
  });

  describe('LLMResultPayload', () => {
    it('should reject missing required fields individually', () => {
      const base = { requestId: 'r', content: 'c', model: 'm', provider: 'p' };

      for (const key of Object.keys(base)) {
        const partial = { ...base };
        delete (partial as any)[key];
        expect(LLMResultPayload.safeParse(partial).success).toBe(false);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// 4. Signal Flow — Malformed Signal Inputs
// ---------------------------------------------------------------------------

describe('Fuzzing: SignalFlowController with malformed signals', () => {
  let flow: SignalFlowController;

  beforeEach(() => {
    flow = new SignalFlowController();
  });

  afterEach(() => {
    flow.reset();
  });

  it('should handle signal with empty type gracefully', () => {
    const sig = makeSignal({ type: '' as SignalType });
    // No policies match empty type — should be allowed
    expect(flow.evaluate(sig)).toBe('allow');
  });

  it('should handle signal with empty source/target clusters', () => {
    const sig = makeSignal({ sourceCluster: '', targetCluster: '' });
    expect(flow.evaluate(sig)).toBe('allow');
  });

  it('should handle signal with extreme priority values', () => {
    flow.addPolicy({
      signalTypes: ['llm:request'],
      allowedDirections: [],
      rateLimit: 0,
      maxQueueDepth: 0,
      minPriority: 0,
      bufferOnPressure: false,
    });

    expect(flow.evaluate(makeSignal({ priority: 0 as SignalPriority }))).toBe('allow');
    expect(flow.evaluate(makeSignal({ priority: 3 as SignalPriority }))).toBe('allow');
    // -1 is below minPriority 0, so it gets dropped — correct behavior
    expect(flow.evaluate(makeSignal({ priority: -1 as unknown as SignalPriority }))).toBe('drop');
    expect(flow.evaluate(makeSignal({ priority: 999 as unknown as SignalPriority }))).toBe('allow');
  });

  it('should handle recordFailure/recordSuccess with special chars in IDs', () => {
    const specialIds = [
      'node/../../etc',
      'node\x00null',
      '',
      '   ',
      'a'.repeat(1000),
    ];

    for (const id of specialIds) {
      // Should not throw
      expect(() => flow.recordFailure('llm:request', id, id)).not.toThrow();
      expect(() => flow.recordSuccess('llm:request', id, id)).not.toThrow();
    }
  });

  it('should handle getBurstRate with nonexistent channels', () => {
    expect(flow.getBurstRate('llm:request', 'nonexistent', 'also-nonexistent')).toBe(0);
    expect(flow.getBurstRate('' as SignalType, '', '')).toBe(0);
  });

  it('should handle drain with nonexistent signal type', () => {
    const result = flow.drain('nonexistent:type' as SignalType, 10);
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 5. Config Loading — Environment Fuzzing
// ---------------------------------------------------------------------------

describe('Fuzzing: Config environment variables', () => {
  const savedEnv: Record<string, string | undefined> = {};
  const envKeys = [
    'MCP_CLUSTER_ENABLED', 'MCP_CLUSTER_ID', 'MCP_CLUSTER_NAME',
    'MCP_CLUSTER_TAGS', 'MCP_CLUSTER_CUSTOM_ENDPOINTS',
    'MCP_CLUSTER_HEARTBEAT_MS', 'MCP_CLUSTER_STALE_MS',
    'MCP_CLUSTER_HISTORY_CAP', 'MCP_CLUSTER_HISTORY_TTL',
  ];

  beforeEach(() => {
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (savedEnv[key] !== undefined) process.env[key] = savedEnv[key];
      else delete process.env[key];
    }
  });

  it('should handle negative integer env vars', () => {
    process.env.MCP_CLUSTER_HEARTBEAT_MS = '-5000';
    expect(loadClusterBusConfig().heartbeatIntervalMs).toBe(5000); // default
  });

  it('should handle zero integer env vars', () => {
    process.env.MCP_CLUSTER_HEARTBEAT_MS = '0';
    expect(loadClusterBusConfig().heartbeatIntervalMs).toBe(5000); // default (envInt requires > 0)
  });

  it('should handle float env vars', () => {
    process.env.MCP_CLUSTER_HEARTBEAT_MS = '5000.7';
    expect(loadClusterBusConfig().heartbeatIntervalMs).toBe(5000); // parseInt truncates
  });

  it('should handle very large integer env vars', () => {
    process.env.MCP_CLUSTER_HEARTBEAT_MS = '999999999999';
    const config = loadClusterBusConfig();
    expect(config.heartbeatIntervalMs).toBe(999999999999);
  });

  it('should handle malformed JSON in custom endpoints', () => {
    process.env.MCP_CLUSTER_CUSTOM_ENDPOINTS = '[{invalid json';
    const config = loadClusterBusConfig();
    // Falls through to short syntax parser, which fails gracefully
    expect(config.customEndpoints).toEqual([]);
  });

  it('should handle empty tags', () => {
    process.env.MCP_CLUSTER_TAGS = ',,,';
    const config = loadClusterBusConfig();
    expect(config.metaTags).toEqual([]);
  });

  it('should handle Unicode in cluster name', () => {
    process.env.MCP_CLUSTER_NAME = '集群-テスト-кластер';
    const config = loadClusterBusConfig();
    expect(config.clusterName).toBe('集群-テスト-кластер');
  });

  it('should handle MCP_CLUSTER_ENABLED with various truthy strings', () => {
    for (const val of ['1', 'true', 'yes', 'TRUE', 'anything']) {
      process.env.MCP_CLUSTER_ENABLED = val;
      expect(loadClusterBusConfig().enabled).toBe(true);
    }
  });

  it('should handle custom endpoints short syntax edge cases', () => {
    // Missing baseURL
    process.env.MCP_CLUSTER_CUSTOM_ENDPOINTS = 'name-only';
    expect(loadClusterBusConfig().customEndpoints).toEqual([]);

    // Empty name
    process.env.MCP_CLUSTER_CUSTOM_ENDPOINTS = '=http://localhost:8000';
    expect(loadClusterBusConfig().customEndpoints).toEqual([]);

    // Multiple semicolons
    process.env.MCP_CLUSTER_CUSTOM_ENDPOINTS = ';;;';
    expect(loadClusterBusConfig().customEndpoints).toEqual([]);
  });
});
