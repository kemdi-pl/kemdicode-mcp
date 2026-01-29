/**
 * AI execute guard tests
 *
 * Ensures provider-prefixed models can be used without initAIClient().
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

// Mock the client module so getClientConfig() returns null (not initialized)
vi.mock('../../src/ai/client.js', async () => {
  const actual = (await vi.importActual('../../src/ai/client.js')) as Record<string, unknown>;
  return {
    ...actual,
    getClientConfig: () => null,
    // complete() should still be callable; we'll stub it per-test using spyOn
  };
});

import * as client from '../../src/ai/client.js';
import { executeAI } from '../../src/ai/execute.js';

describe('executeAI init guard', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('allows provider-prefixed model without initAIClient()', async () => {
    vi.spyOn(client, 'complete').mockResolvedValue({
      content: 'ok',
      model: 'anthropic:claude-3.5-sonnet',
    });

    const out = await executeAI({
      prompt: 'hi',
      agent: 'general',
      model: 'anthropic:claude-3.5-sonnet',
    });

    expect(out).toBe('ok');
  });

  it('still requires initAIClient() when model is not provider-prefixed', async () => {
    await expect(
      executeAI({
        prompt: 'hi',
        agent: 'general',
        model: 'gpt-4o',
      })
    ).rejects.toThrow(/AI client not initialized/i);
  });
});

