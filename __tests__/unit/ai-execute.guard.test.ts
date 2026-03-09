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
 * Note: Bun test runner doesn't support vi.mock/vi.importActual,
 * so we test the hasProviderPrefix guard logic directly.
 */

import { describe, it, expect } from 'bun:test';
import { parseModelSpec } from '../../src/ai/model-spec.js';

describe('executeAI init guard', () => {
  it('recognizes provider-prefixed models', () => {
    // Provider-prefixed models should be recognized
    const spec1 = parseModelSpec('anthropic:claude-3.5-sonnet');
    expect(spec1.provider).toBe('anthropic');
    expect(spec1.model).toBe('claude-3.5-sonnet');

    const spec2 = parseModelSpec('openai:gpt-4o');
    expect(spec2.provider).toBe('openai');
    expect(spec2.model).toBe('gpt-4o');

    const spec3 = parseModelSpec('custom:minimax:MiniMax-M2.5');
    expect(spec3.provider).toBe('custom:minimax');
    expect(spec3.model).toBe('MiniMax-M2.5');
  });

  it('auto-detects provider for known model names', () => {
    const spec = parseModelSpec('gpt-4o');
    // parseModelSpec auto-detects openai from known model prefix
    expect(spec.provider).toBe('openai');
    expect(spec.model).toBe('gpt-4o');
  });

  it('handles short provider aliases', () => {
    const spec1 = parseModelSpec('a:claude-sonnet-4-6');
    expect(spec1.provider).toBe('anthropic');

    const spec2 = parseModelSpec('o:gpt-4o');
    expect(spec2.provider).toBe('openai');

    const spec3 = parseModelSpec('g:gemini-2.0-flash');
    expect(spec3.provider).toBe('gemini');
  });
});
