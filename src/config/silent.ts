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
 * Silent Mode Configuration
 *
 * Controls output verbosity across all tools. Three levels:
 * - silent: Minimal output (IDs, raw data). Like Claude Code internal tools.
 * - compact: Essential fields only. No metadata, no decorations.
 * - normal: Full output (backward compatible, current behavior).
 *
 * @module config/silent
 */

export type OutputLevel = 'silent' | 'compact' | 'normal';

let globalOutputLevel: OutputLevel = 'silent';

/**
 * Check if running in silent mode (silent or compact).
 */
export function isSilent(): boolean {
  return globalOutputLevel !== 'normal';
}

/**
 * Check if running in strict silent mode (not compact).
 */
export function isStrictSilent(): boolean {
  return globalOutputLevel === 'silent';
}

/**
 * Get the current output level.
 */
export function getOutputLevel(): OutputLevel {
  return globalOutputLevel;
}

/**
 * Set the global output level.
 * Called once at startup from CLI args or env var.
 */
export function setOutputLevel(level: OutputLevel): void {
  globalOutputLevel = level;
}

/**
 * Initialize output level from environment variable.
 * KEMDICODE_OUTPUT=verbose or KEMDICODE_OUTPUT=normal -> normal (full output)
 * KEMDICODE_OUTPUT=compact -> compact
 * KEMDICODE_OUTPUT=silent -> silent (default anyway)
 * Also supports legacy KEMDICODE_SILENT for backward compatibility.
 */
export function initSilentFromEnv(): void {
  const env = process.env.KEMDICODE_OUTPUT || process.env.KEMDICODE_SILENT;
  if (!env) return;

  if (env === 'verbose' || env === 'normal' || env === '0' || env === 'false') {
    globalOutputLevel = 'normal';
  } else if (env === 'compact') {
    globalOutputLevel = 'compact';
  } else if (env === '1' || env === 'true' || env === 'silent') {
    globalOutputLevel = 'silent';
  }
}

/**
 * Resolve effective output level for a single tool call.
 * Per-call _silent arg overrides global setting.
 */
export function resolveOutputLevel(perCallSilent?: boolean | string): OutputLevel {
  if (perCallSilent === true || perCallSilent === 'true' || perCallSilent === 'silent') {
    return 'silent';
  }
  if (perCallSilent === 'compact') {
    return 'compact';
  }
  return globalOutputLevel;
}
