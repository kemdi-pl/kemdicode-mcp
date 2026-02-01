/**
 * KemdiCode MCP Server
 * Copyright (C) 2025-2026 Kemdi Sp. z o.o. (Dawid Irzyk <dawid@kemdi.pl>)
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

/**
 * Thinking Chain Module
 *
 * Exports types and store functions for the thinking chain system.
 *
 * @module thinking
 */

export type { ThinkingChain, Thought, ChainStatus } from './types.js';
export { THINKING_KEYS, THINKING_TTL } from './types.js';
export {
  createChain,
  getChain,
  addThought,
  reviseThought,
  branchChain,
  concludeChain,
  listChains,
} from './thinking-store.js';
