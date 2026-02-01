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
 * Runtime Abstraction Layer
 *
 * Provides cross-runtime compatibility between Bun and Node.js.
 * Detects the current runtime and exports appropriate implementations.
 *
 * @module runtime
 */

import type { RuntimeType } from './types.js';

// Declare Bun global for TypeScript
declare const Bun: unknown;

/**
 * Check if running in Bun runtime
 */
export const isBun: boolean = typeof Bun !== 'undefined';

/**
 * Check if running in Node.js runtime
 */
export const isNode: boolean = !isBun && typeof process !== 'undefined';

/**
 * Current runtime identifier
 */
export const runtime: RuntimeType = isBun ? 'bun' : 'node';

/**
 * Runtime version string
 */
export const runtimeVersion: string = isBun
  ? `Bun ${(Bun as { version?: string })?.version || 'unknown'}`
  : `Node.js ${process.version}`;

// Re-export types
export * from './types.js';

// Re-export modules
export * from './process.js';
export * from './crypto.js';
export * from './net.js';
export * from './http.js';
