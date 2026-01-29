/**
 * AI Models Tool Tests
 *
 * Focus:
 * - SSRF guard via validateUrl()
 * - Request timeout via AbortController
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { aiModelsTool } from '../../src/tools/system/ai-models.tool.js';
import { config } from '../../src/config/index.js';

describe('ai-models tool', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    // Force config to be loaded so subsequent set/reset doesn't get overwritten
    // by a lazy load triggered from within the tool.
    config.load();
    // Ensure predictable config per test
    config.reset('server');
    config.reset('timeouts');
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('blocks private/localhost base URLs (SSRF guard)', async () => {
    config.set('server', {
      apiBaseUrl: 'http://127.0.0.1:8080',
      apiKey: 'test-key',
    });

    // Even if fetch is mocked, it should not be called due to URL validation
    globalThis.fetch = vi.fn(() => {
      throw new Error('fetch should not be called');
    }) as unknown as typeof fetch;

    const out = await aiModelsTool.execute({ action: 'list', limit: 10, category: 'all' } as any);

    expect(out).toContain('Failed to fetch models:');
    expect(out).toContain('Invalid API base URL');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('returns a timeout error message on AbortError', async () => {
    config.set('server', {
      apiBaseUrl: 'https://example.com',
      apiKey: 'test-key',
    });
    config.set('timeouts', { safeExec: 5_000 });

    globalThis.fetch = vi.fn(async () => {
      throw new DOMException('aborted', 'AbortError');
    }) as unknown as typeof fetch;

    const out = await aiModelsTool.execute({ action: 'list', limit: 10, category: 'all' } as any);

    expect(out).toContain('Failed to fetch models:');
    expect(out).toContain('timed out');
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('formats model list when API returns data', async () => {
    config.set('server', {
      apiBaseUrl: 'https://example.com',
      apiKey: 'test-key',
    });

    globalThis.fetch = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          data: [{ id: 'openai/gpt-4o' }, { id: 'anthropic/claude-3.5-sonnet' }],
        }),
      } as any;
    }) as unknown as typeof fetch;

    const out = await aiModelsTool.execute({ action: 'list', limit: 50, category: 'all' } as any);

    expect(out).toContain('Found 2 models:');
    expect(out).toContain('openai/gpt-4o');
    expect(out).toContain('anthropic/claude-3.5-sonnet');
  });
});
