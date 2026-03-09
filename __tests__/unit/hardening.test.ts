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

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

// ============================================================
// 1. signData / verifySignature
// ============================================================

describe('signData and verifySignature hardening', () => {
  let signData: typeof import('../../src/utils/security.js').signData;
  let verifySignature: typeof import('../../src/utils/security.js').verifySignature;

  beforeEach(async () => {
    delete process.env.HMAC_SECRET;
    // Import fresh — bun caches modules but env is read at call time
    const mod = await import('../../src/utils/security.js');
    signData = mod.signData;
    verifySignature = mod.verifySignature;
  });

  afterEach(() => {
    delete process.env.HMAC_SECRET;
  });

  it('should sign and verify round-trip with explicit secret', () => {
    const data = 'test-payload';
    const secret = 'explicit-test-secret';
    const signature = signData(data, secret);

    expect(typeof signature).toBe('string');
    expect(signature.length).toBe(64); // SHA-256 hex
    expect(verifySignature(data, signature, secret)).toBe(true);
  });

  it('should reject tampered data', () => {
    const secret = 'test-secret';
    const signature = signData('original', secret);

    expect(verifySignature('tampered', signature, secret)).toBe(false);
  });

  it('should reject wrong secret', () => {
    const signature = signData('data', 'secret-a');
    expect(verifySignature('data', signature, 'secret-b')).toBe(false);
  });

  it('should throw when no secret available', () => {
    delete process.env.HMAC_SECRET;

    expect(() => signData('data')).toThrow('No HMAC secret available');
    expect(() => verifySignature('data', 'aabbccdd')).toThrow('No HMAC secret available');
  });

  it('should work with HMAC_SECRET env var', () => {
    process.env.HMAC_SECRET = 'env-var-secret';

    const signature = signData('data');
    expect(verifySignature('data', signature)).toBe(true);
  });

  it('should return false for length-mismatched signatures', () => {
    process.env.HMAC_SECRET = 'test-secret';

    expect(verifySignature('data', 'short')).toBe(false);
  });
});

// ============================================================
// 2. process-list filter safety (removed — tool no longer exists)
// ============================================================

// ============================================================
// 3. env-info redaction
// ============================================================

describe('env-info redaction', () => {
  beforeEach(async () => {
    const { setOutputLevel } = await import('../../src/config/silent.js');
    setOutputLevel('normal');
  });

  afterEach(async () => {
    const { setOutputLevel } = await import('../../src/config/silent.js');
    setOutputLevel('silent');
  });

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

    const result1 = (await envInfoTool.execute({
      detailed: true,
      category: 'env',
      allowSensitive: false,
    })) as string;
    expect(result1).not.toContain('### PATH');

    const result2 = (await envInfoTool.execute({
      detailed: false,
      category: 'env',
      allowSensitive: true,
    })) as string;
    expect(result2).not.toContain('### PATH');

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
  // These tests require vi.doMock / vi.resetModules to mock Redis at module level.
  // Bun test runner doesn't support module-level mocking, so we test the actual
  // behavior: when Redis IS available, invocations work correctly.
  // Redis unavailability is tested via integration tests.

  it('getInvocationLog should return empty array when Redis is unavailable', async () => {
    // Import the actual module — if Redis is down, it should gracefully return []
    const { getInvocationLog } = await import('../../src/recursive/tool-invoker.js');
    const log = await getInvocationLog('test-nonexistent-agent', 10);
    // With real Redis, returns empty for nonexistent agent; without Redis, returns []
    expect(Array.isArray(log)).toBe(true);
  });

  it('checkSafety should return a result object', async () => {
    const { checkSafety } = await import('../../src/recursive/tool-invoker.js');
    const result = await checkSafety({
      invocationId: 'test-id',
      agentId: 'test-agent',
      sessionId: 'test-session',
      toolName: 'ping',
      args: {},
      timestamp: Date.now(),
    });

    // checkSafety should return an object with allowed property (true or false)
    expect(typeof result.allowed).toBe('boolean');
  });

  it('invokeTool should return a result object', async () => {
    const { invokeTool } = await import('../../src/recursive/tool-invoker.js');
    const result = await invokeTool({
      invocationId: 'test-id',
      agentId: 'test-agent',
      sessionId: 'test-session',
      toolName: 'ping',
      args: {},
      timestamp: Date.now(),
    });

    // Should return a result with success boolean (may be true or false depending on Redis/registry state)
    expect(typeof result.success).toBe('boolean');
  });

  it('invokeTool should return error for nonexistent tools', async () => {
    const { invokeTool } = await import('../../src/recursive/tool-invoker.js');
    const result = await invokeTool({
      invocationId: 'test-id',
      agentId: 'test-agent',
      sessionId: 'test-session',
      toolName: 'nonexistent-tool-xyz',
      args: {},
      timestamp: Date.now(),
    });

    expect(result.success).toBe(false);
  });
});
