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

