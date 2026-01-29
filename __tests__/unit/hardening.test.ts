/**
 * KemdiCode MCP Server - Hardening Tests
 * Copyright (C) 2025-2026 Kemdi Sp. z o.o.
 *
 * Tests for:
 * - Recursive tools graceful degradation without Redis
 * - signData/verifySignature secret logic
 * - process-list filter safety
 * - env-info redaction
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ============================================================
// 1. signData / verifySignature
// ============================================================

describe('signData and verifySignature hardening', () => {
  let signData: typeof import('../../src/utils/security.js').signData;
  let verifySignature: typeof import('../../src/utils/security.js').verifySignature;

  beforeEach(async () => {
    // Reset modules so env changes take effect
    vi.resetModules();
    delete process.env.HMAC_SECRET;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.HMAC_SECRET;
  });

  it('should sign and verify round-trip with explicit secret', async () => {
    const mod = await import('../../src/utils/security.js');
    signData = mod.signData;
    verifySignature = mod.verifySignature;

    const data = 'test-payload';
    const secret = 'explicit-test-secret';
    const signature = signData(data, secret);

    expect(typeof signature).toBe('string');
    expect(signature.length).toBe(64); // SHA-256 hex
    expect(verifySignature(data, signature, secret)).toBe(true);
  });

  it('should reject tampered data', async () => {
    const mod = await import('../../src/utils/security.js');
    signData = mod.signData;
    verifySignature = mod.verifySignature;

    const secret = 'test-secret';
    const signature = signData('original', secret);

    expect(verifySignature('tampered', signature, secret)).toBe(false);
  });

  it('should reject wrong secret', async () => {
    const mod = await import('../../src/utils/security.js');
    signData = mod.signData;
    verifySignature = mod.verifySignature;

    const signature = signData('data', 'secret-a');
    expect(verifySignature('data', signature, 'secret-b')).toBe(false);
  });

  it('should throw when no secret available', async () => {
    // Ensure no env var and no secure storage secret
    delete process.env.HMAC_SECRET;

    const mod = await import('../../src/utils/security.js');
    signData = mod.signData;
    verifySignature = mod.verifySignature;

    expect(() => signData('data')).toThrow('No HMAC secret available');
    expect(() => verifySignature('data', 'aabbccdd')).toThrow('No HMAC secret available');
  });

  it('should work with HMAC_SECRET env var', async () => {
    process.env.HMAC_SECRET = 'env-var-secret';

    const mod = await import('../../src/utils/security.js');
    signData = mod.signData;
    verifySignature = mod.verifySignature;

    const signature = signData('data');
    expect(verifySignature('data', signature)).toBe(true);
  });

  it('should return false for length-mismatched signatures', async () => {
    process.env.HMAC_SECRET = 'test-secret';

    const mod = await import('../../src/utils/security.js');
    verifySignature = mod.verifySignature;

    expect(verifySignature('data', 'short')).toBe(false);
  });
});

// ============================================================
// 2. process-list filter safety
// ============================================================

describe('process-list filter safety', () => {
  // We test the filtering logic by importing the tool and checking
  // that special regex characters don't cause errors.
  // The tool uses execSync internally so we mock it.

  it('should not throw on special regex characters in filter', async () => {
    const { processListTool } = await import(
      '../../src/tools/system/process-list.tool.js'
    );

    // These would cause RegExp constructor to throw with old code
    const dangerousFilters = ['(((', '.*+?', '[invalid', '\\', 'a{9999}'];

    for (const filter of dangerousFilters) {
      // Should not throw - it will return "No processes found" or similar
      // because the subprocess might fail, but the tool itself handles errors
      const result = await processListTool.execute({
        filter,
        sortBy: 'cpu',
        limit: 5,
        all: false,
      });

      expect(typeof result).toBe('string');
    }
  });
});

// ============================================================
// 3. env-info redaction
// ============================================================

describe('env-info redaction', () => {
  it('should redact hostname and username by default', async () => {
    const { envInfoTool } = await import('../../src/tools/system/env-info.tool.js');
    const result = (await envInfoTool.execute({
      detailed: false,
      category: 'os',
      allowSensitive: false,
    })) as string;

    expect(result).toContain('<redacted>');
    expect(result).toContain('Hostname: <redacted>');
    expect(result).toContain('User: <redacted>');
  });

  it('should show hostname and username when allowSensitive is true', async () => {
    const { envInfoTool } = await import('../../src/tools/system/env-info.tool.js');
    const result = (await envInfoTool.execute({
      detailed: false,
      category: 'os',
      allowSensitive: true,
    })) as string;

    // Should NOT contain <redacted> for hostname/user
    expect(result).not.toMatch(/Hostname: <redacted>/);
    expect(result).not.toMatch(/User: <redacted>/);
  });

  it('should redact home directory by default', async () => {
    const { envInfoTool } = await import('../../src/tools/system/env-info.tool.js');
    const result = (await envInfoTool.execute({
      detailed: false,
      category: 'env',
      allowSensitive: false,
    })) as string;

    expect(result).toContain('Home: <redacted>');
  });

  it('should not show PATH unless detailed AND allowSensitive', async () => {
    const { envInfoTool } = await import('../../src/tools/system/env-info.tool.js');

    // detailed=true but allowSensitive=false -> no PATH
    const result1 = (await envInfoTool.execute({
      detailed: true,
      category: 'env',
      allowSensitive: false,
    })) as string;
    expect(result1).not.toContain('### PATH');

    // detailed=false, allowSensitive=true -> no PATH
    const result2 = (await envInfoTool.execute({
      detailed: false,
      category: 'env',
      allowSensitive: true,
    })) as string;
    expect(result2).not.toContain('### PATH');

    // detailed=true AND allowSensitive=true -> shows PATH
    const result3 = (await envInfoTool.execute({
      detailed: true,
      category: 'env',
      allowSensitive: true,
    })) as string;
    expect(result3).toContain('### PATH');
  });
});

// ============================================================
// 4. Recursive tools graceful degradation
// ============================================================

describe('Recursive tools Redis degradation', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('getInvocationLog should return empty array when Redis is unavailable', async () => {
    // Mock Redis to throw
    vi.doMock('../../src/infrastructure/redis/connection.js', () => ({
      getSharedRedis: vi.fn().mockRejectedValue(new Error('Redis is not available')),
    }));

    const { getInvocationLog } = await import('../../src/recursive/tool-invoker.js');
    const log = await getInvocationLog('test-agent', 10);

    expect(log).toEqual([]);
  });

  it('checkSafety should allow invocation when Redis rate-limit check fails', async () => {
    // Mock Redis to throw
    vi.doMock('../../src/infrastructure/redis/connection.js', () => ({
      getSharedRedis: vi.fn().mockRejectedValue(new Error('Redis is not available')),
    }));

    // Mock tool registry to return a tool
    vi.doMock('../../src/tools/registry.js', () => ({
      getToolByName: vi.fn().mockReturnValue({ name: 'ping' }),
      executeTool: vi.fn().mockResolvedValue('"pong"'),
    }));

    const { checkSafety } = await import('../../src/recursive/tool-invoker.js');
    const result = await checkSafety({
      invocationId: 'test-id',
      agentId: 'test-agent',
      sessionId: 'test-session',
      toolName: 'ping',
      args: {},
      timestamp: Date.now(),
    });

    // Should be allowed because Redis failure causes rate limit to return default (count: 0)
    expect(result.allowed).toBe(true);
  });

  it('invokeTool should succeed with warning when Redis is unavailable', async () => {
    // Mock Redis to throw
    vi.doMock('../../src/infrastructure/redis/connection.js', () => ({
      getSharedRedis: vi.fn().mockRejectedValue(new Error('Redis is not available')),
    }));

    // Mock tool registry
    vi.doMock('../../src/tools/registry.js', () => ({
      getToolByName: vi.fn().mockReturnValue({ name: 'ping' }),
      executeTool: vi.fn().mockResolvedValue('"pong"'),
    }));

    const { invokeTool } = await import('../../src/recursive/tool-invoker.js');
    const result = await invokeTool({
      invocationId: 'test-id',
      agentId: 'test-agent',
      sessionId: 'test-session',
      toolName: 'ping',
      args: {},
      timestamp: Date.now(),
    });

    expect(result.success).toBe(true);
    expect(result.result).toBe('pong');
    expect(result.warning).toContain('Redis unavailable');
  });

  it('invokeTool catch block should not throw unhandled rejection when Redis is down', async () => {
    // Mock Redis to throw
    vi.doMock('../../src/infrastructure/redis/connection.js', () => ({
      getSharedRedis: vi.fn().mockRejectedValue(new Error('Redis is not available')),
    }));

    // Mock tool registry - tool throws an error
    vi.doMock('../../src/tools/registry.js', () => ({
      getToolByName: vi.fn().mockReturnValue({ name: 'failing-tool' }),
      executeTool: vi.fn().mockRejectedValue(new Error('Tool execution failed')),
    }));

    const { invokeTool } = await import('../../src/recursive/tool-invoker.js');
    const result = await invokeTool({
      invocationId: 'test-id',
      agentId: 'test-agent',
      sessionId: 'test-session',
      toolName: 'failing-tool',
      args: {},
      timestamp: Date.now(),
    });

    // Should return error result without unhandled rejection
    expect(result.success).toBe(false);
    expect(result.error).toBe('Tool execution failed');
  });
});
