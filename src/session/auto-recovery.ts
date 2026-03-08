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
 * Auto-Recovery Module
 *
 * Detects new session connections and prepares recovery context.
 * Saves pre-compaction snapshots when context budget is high.
 *
 * @module session/auto-recovery
 */

import { Logger } from '../utils/logger.js';

/** Auto-recovery configuration */
export interface AutoRecoveryConfig {
  enabled: boolean;
  prepareInBackground: boolean;
}

let config: AutoRecoveryConfig = {
  enabled: true,
  prepareInBackground: true,
};

/**
 * Configure auto-recovery behavior.
 */
export function configureAutoRecovery(newConfig: Partial<AutoRecoveryConfig>): void {
  config = { ...config, ...newConfig };
}

/**
 * Handle new session connection event.
 * Called from the main server when a new SSE connection is established.
 */
export async function onNewSessionConnected(sessionId: string): Promise<void> {
  if (!config.enabled) return;

  Logger.info(`[AutoRecovery] New session connected: ${sessionId}`);

  if (config.prepareInBackground) {
    // Prepare recovery context in background (fire-and-forget)
    prepareRecoveryContext(sessionId).catch((err) => {
      Logger.debug(
        () => `[AutoRecovery] Background recovery prep failed: ${err instanceof Error ? err.message : String(err)}`
      );
    });
  }
}

/**
 * Prepare recovery context for a session (background).
 */
async function prepareRecoveryContext(sessionId: string): Promise<void> {
  try {
    // Dynamically import to avoid circular dependencies
    const { executeTool } = await import('../tools/registry.js');

    await executeTool('session', {
      action: 'recover',
      sessionId,
      includeAmbientLearning: true,
      includeAgentRankings: true,
      includeToolHealth: true,
    });

    Logger.info(`[AutoRecovery] Recovery context prepared for session ${sessionId}`);
  } catch (error) {
    Logger.debug(
      () =>
        `[AutoRecovery] Failed to prepare recovery: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
