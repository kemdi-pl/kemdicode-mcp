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
 * Cluster Bus Types — Unit Tests
 *
 * Tests for meta-tag parsing/serialization, Redis key sanitization,
 * config loading, custom endpoint parsing, and Zod payload schemas.
 *
 * Self-contained: no Redis, no mocks.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  parseMetaTag,
  serializeMetaTag,
  loadClusterBusConfig,
  CLUSTER_KEYS,
  LLMRequestPayload,
  LLMResultPayload,
  HeartbeatPayload,
  PassConfigSchema,
} from '../../../src/cluster-bus/types.js';

// ---------------------------------------------------------------------------
// Meta-Tags
// ---------------------------------------------------------------------------

describe('Meta-tag parsing', () => {
  it('should parse "key:value" format', () => {
    expect(parseMetaTag('env:production')).toEqual({ key: 'env', value: 'production' });
  });

  it('should handle colons in value', () => {
    expect(parseMetaTag('url:http://example.com')).toEqual({ key: 'url', value: 'http://example.com' });
  });

  it('should handle key-only (no colon)', () => {
    expect(parseMetaTag('standalone')).toEqual({ key: 'standalone', value: '' });
  });

  it('should serialize back to string', () => {
    expect(serializeMetaTag({ key: 'env', value: 'test' })).toBe('env:test');
  });

  it('should round-trip parse → serialize', () => {
    const original = 'model:gpt-4o';
    expect(serializeMetaTag(parseMetaTag(original))).toBe(original);
  });
});

// ---------------------------------------------------------------------------
// Redis Key Sanitization
// ---------------------------------------------------------------------------

describe('CLUSTER_KEYS sanitization', () => {
  it('should sanitize special characters in node key', () => {
    const key = CLUSTER_KEYS.node('cluster/../../../etc/passwd');
    // Regex allows [a-zA-Z0-9\-_.] — dots are kept but slashes are stripped
    expect(key).not.toContain('/');
    // Result: "cluster......etcpasswd" — dots preserved, slashes removed
    expect(key).toBe('mcp:cluster:cluster......etcpasswd');
  });

  it('should truncate long IDs to 64 chars', () => {
    const longId = 'a'.repeat(200);
    const key = CLUSTER_KEYS.node(longId);
    // After prefix, the sanitized part should be <= 64 chars
    const sanitizedPart = key.replace('mcp:cluster:', '');
    expect(sanitizedPart.length).toBeLessThanOrEqual(64);
  });

  it('should preserve valid characters', () => {
    const key = CLUSTER_KEYS.node('cluster-123_test.node');
    expect(key).toBe('mcp:cluster:cluster-123_test.node');
  });

  it('should create distinct channel keys for different src/tgt', () => {
    const key1 = CLUSTER_KEYS.channelUnicast('a', 'b');
    const key2 = CLUSTER_KEYS.channelUnicast('b', 'a');
    expect(key1).not.toBe(key2);
  });
});

// ---------------------------------------------------------------------------
// Config Loading
// ---------------------------------------------------------------------------

describe('loadClusterBusConfig', () => {
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

  it('should return sensible defaults', () => {
    const config = loadClusterBusConfig();
    expect(config.enabled).toBe(true);
    // crypto.randomUUID() produces a UUID when MCP_CLUSTER_ID is unset
    expect(config.clusterId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(config.heartbeatIntervalMs).toBe(5000);
    expect(config.staleThresholdMs).toBe(15000);
    expect(config.historyCap).toBe(500);
    expect(config.historyTtlSeconds).toBe(3600);
  });

  it('should disable when MCP_CLUSTER_ENABLED=0', () => {
    process.env.MCP_CLUSTER_ENABLED = '0';
    expect(loadClusterBusConfig().enabled).toBe(false);
  });

  it('should disable when MCP_CLUSTER_ENABLED=false', () => {
    process.env.MCP_CLUSTER_ENABLED = 'false';
    expect(loadClusterBusConfig().enabled).toBe(false);
  });

  it('should use provided cluster ID', () => {
    process.env.MCP_CLUSTER_ID = 'my-cluster';
    expect(loadClusterBusConfig().clusterId).toBe('my-cluster');
  });

  it('should parse comma-separated meta-tags', () => {
    process.env.MCP_CLUSTER_TAGS = 'env:prod,region:eu,role:worker';
    const config = loadClusterBusConfig();
    expect(config.metaTags).toHaveLength(3);
    expect(config.metaTags[0]).toEqual({ key: 'env', value: 'prod' });
    expect(config.metaTags[2]).toEqual({ key: 'role', value: 'worker' });
  });

  it('should parse JSON custom endpoints', () => {
    process.env.MCP_CLUSTER_CUSTOM_ENDPOINTS = JSON.stringify([
      { name: 'vllm', baseURL: 'http://gpu:8000/v1', defaultModel: 'llama3' },
    ]);
    const config = loadClusterBusConfig();
    expect(config.customEndpoints).toHaveLength(1);
    expect(config.customEndpoints[0].name).toBe('vllm');
    expect(config.customEndpoints[0].baseURL).toBe('http://gpu:8000/v1');
  });

  it('should parse short-syntax custom endpoints', () => {
    process.env.MCP_CLUSTER_CUSTOM_ENDPOINTS = 'vllm=http://gpu:8000/v1,model=llama3;lmstudio=http://localhost:1234/v1';
    const config = loadClusterBusConfig();
    expect(config.customEndpoints).toHaveLength(2);
    expect(config.customEndpoints[0].name).toBe('vllm');
    expect(config.customEndpoints[0].defaultModel).toBe('llama3');
    expect(config.customEndpoints[1].name).toBe('lmstudio');
  });

  it('should use custom integer env vars', () => {
    process.env.MCP_CLUSTER_HEARTBEAT_MS = '10000';
    process.env.MCP_CLUSTER_STALE_MS = '30000';
    const config = loadClusterBusConfig();
    expect(config.heartbeatIntervalMs).toBe(10000);
    expect(config.staleThresholdMs).toBe(30000);
  });

  it('should ignore invalid integer env vars', () => {
    process.env.MCP_CLUSTER_HEARTBEAT_MS = 'not-a-number';
    expect(loadClusterBusConfig().heartbeatIntervalMs).toBe(5000);
  });
});

// ---------------------------------------------------------------------------
// Zod Payload Schemas
// ---------------------------------------------------------------------------

describe('Zod payload schemas', () => {
  describe('LLMRequestPayload', () => {
    it('should validate minimal request', () => {
      const result = LLMRequestPayload.safeParse({ prompt: 'Hello' });
      expect(result.success).toBe(true);
    });

    it('should reject missing prompt', () => {
      const result = LLMRequestPayload.safeParse({});
      expect(result.success).toBe(false);
    });

    it('should accept full request with passConfig', () => {
      const result = LLMRequestPayload.safeParse({
        prompt: 'Analyze this code',
        model: 'a:claude-sonnet-4-5:4k',
        maxTokens: 1000,
        temperature: 0.7,
        files: ['src/main.ts'],
        passConfig: { maxPasses: 3, qualityThreshold: 0.8, strategy: 'quality-target' },
      });
      expect(result.success).toBe(true);
    });
  });

  describe('LLMResultPayload', () => {
    it('should validate minimal result', () => {
      const result = LLMResultPayload.safeParse({
        requestId: 'req-1',
        content: 'Response text',
        model: 'gpt-4',
        provider: 'openai',
      });
      expect(result.success).toBe(true);
    });

    it('should reject missing required fields', () => {
      const result = LLMResultPayload.safeParse({ requestId: 'req-1' });
      expect(result.success).toBe(false);
    });
  });

  describe('HeartbeatPayload', () => {
    it('should validate heartbeat', () => {
      const result = HeartbeatPayload.safeParse({
        clusterId: 'cluster-1',
        status: 'online',
      });
      expect(result.success).toBe(true);
    });

    it('should reject invalid status', () => {
      const result = HeartbeatPayload.safeParse({
        clusterId: 'cluster-1',
        status: 'invalid',
      });
      expect(result.success).toBe(false);
    });

    it('should accept optional load factor', () => {
      const result = HeartbeatPayload.safeParse({
        clusterId: 'cluster-1',
        status: 'degraded',
        load: 0.85,
      });
      expect(result.success).toBe(true);
    });

    it('should reject load outside 0-1 range', () => {
      const result = HeartbeatPayload.safeParse({
        clusterId: 'cluster-1',
        status: 'online',
        load: 1.5,
      });
      expect(result.success).toBe(false);
    });
  });

  describe('PassConfigSchema', () => {
    it('should provide defaults', () => {
      const result = PassConfigSchema.parse({});
      expect(result.maxPasses).toBe(5);
      expect(result.qualityThreshold).toBe(0.8);
      expect(result.strategy).toBe('min-passes');
    });

    it('should reject maxPasses > 20', () => {
      const result = PassConfigSchema.safeParse({ maxPasses: 25 });
      expect(result.success).toBe(false);
    });

    it('should reject invalid strategy', () => {
      const result = PassConfigSchema.safeParse({ strategy: 'invalid' });
      expect(result.success).toBe(false);
    });
  });
});
