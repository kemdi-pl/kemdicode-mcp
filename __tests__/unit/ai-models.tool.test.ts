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
 * AI Models Tool Tests
 *
 * Focus:
 * - SSRF guard via validateUrl()
 * - Request timeout via AbortController
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
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
  });

  it('blocks private/localhost base URLs (SSRF guard)', async () => {
    config.set('server', {
      apiBaseUrl: 'http://127.0.0.1:8080',
      apiKey: 'test-key',
    });

    // Even if fetch is mocked, it should not be called due to URL validation
    let fetchCalled = false;
    globalThis.fetch = (() => {
      fetchCalled = true;
      throw new Error('fetch should not be called');
    }) as unknown as typeof fetch;

    const out = await aiModelsTool.execute({ action: 'list', limit: 10, category: 'all' } as any);

    expect(out).toContain('Failed to fetch models:');
    expect(out).toContain('Invalid API base URL');
    expect(fetchCalled).toBe(false);
  });

  it('returns a timeout error message on AbortError', async () => {
    config.set('server', {
      apiBaseUrl: 'https://example.com',
      apiKey: 'test-key',
    });
    config.set('timeouts', { safeExec: 5_000 });

    let fetchCallCount = 0;
    globalThis.fetch = (async () => {
      fetchCallCount++;
      throw new DOMException('aborted', 'AbortError');
    }) as unknown as typeof fetch;

    const out = await aiModelsTool.execute({ action: 'list', limit: 10, category: 'all' } as any);

    expect(out).toContain('Failed to fetch models:');
    expect(out).toContain('timed out');
    expect(fetchCallCount).toBe(1);
  });

  it('formats model list when API returns data', async () => {
    config.set('server', {
      apiBaseUrl: 'https://example.com',
      apiKey: 'test-key',
    });

    globalThis.fetch = (async () => {
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
