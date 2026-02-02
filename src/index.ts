#!/usr/bin/env node
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
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║                         KEMDICODE MCP SERVER                                  ║
 * ╠═══════════════════════════════════════════════════════════════════════════╣
 * ║  Model Context Protocol server integrating AI CLI with Claude Code        ║
 * ╠═══════════════════════════════════════════════════════════════════════════╣
 * ║                                                                           ║
 * ║  ARCHITECTURE:                                                            ║
 * ║  ├─ src/server/types.ts     : Type definitions                           ║
 * ║  ├─ src/server/progress.ts  : Progress tracking & SSE                    ║
 * ║  ├─ src/server/session-server.ts : Session & MCP management              ║
 * ║  ├─ src/server/http-server.ts    : HTTP server & routing                 ║
 * ║  └─ src/index.ts            : Main entry point (this file)               ║
 * ║                                                                           ║
 * ║  ENDPOINTS:                                                               ║
 * ║  ├─ GET  /health           : Server status                                ║
 * ║  ├─ GET  /sse              : SSE stream (main)                            ║
 * ║  ├─ POST /message          : Tool calls (JSON-RPC)                        ║
 * ║  ├─ GET  /stream/:requestId: Tool execution stream                        ║
 * ║  ├─ GET  /tools            : List available tools                         ║
 * ║  └─ GET  /mcp              : MCP endpoint                                 ║
 * ║                                                                           ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 */

// IMPORTANT: Import tools first to ensure registration side-effects run
// before any code that depends on getToolDefinitions()
import './tools/index.js';

import { Command } from 'commander';
import { Logger } from './utils/logger.js';
import { config } from './config/index.js';
import { appConfigSchema } from './config/schema.js';
import { initSilentFromEnv, setOutputLevel, getOutputLevel } from './config/silent.js';
import { initContext, initAgentMonitor, getSessionId } from './context/index.js';
import { initAIClient } from './ai/index.js';
import { registerBuiltinProviders, setProviderConfig, loadCustomEndpointsFromRedis } from './ai/providers/registry.js';
import type { ProviderId } from './ai/providers/types.js';
import { VERSION, type ServerConfig, startHttpServer, stopHttpServer, broadcastNotification } from './server/index.js';
import { initToolsBroadcast, warmupLazySchemas } from './tools/registry.js';
import { initGlobalEventSystem } from './events/index.js';
import { getRedisConnectionManager } from './infrastructure/redis/connection.js';
import { initClusterBusSystem, shutdownClusterBusSystem } from './cluster-bus/init.js';

// Re-export for backwards compatibility
export {
  VERSION,
  SSEEventType,
  type ServerConfig,
  type SessionConfig,
  type ProgressState,
  type ProgressData,
  type ToolArguments,
} from './server/index.js';

export {
  sendSSEEvent,
  sendProgress,
  startProgress,
  stopProgress,
  updateProgressOutput,
  getProgressState,
  setProgressSSEResponse,
  deleteProgressState,
} from './server/index.js';

export {
  resolveCwd,
  getSessionConfig,
  setSessionConfig,
  deleteSessionConfig,
  getAllSessionConfigs,
  createSessionServer,
  getOrCreateTransport,
  generateSessionId,
} from './server/index.js';

export { startHttpServer } from './server/index.js';

/**
 * Get current server configuration
 * @returns Server configuration object
 */
export function getServerConfig(): ServerConfig {
  const serverCfg = config.get('server');
  return {
    primaryModel: serverCfg.primaryModel,
    fallbackModel: serverCfg.fallbackModel,
    apiBaseUrl: serverCfg.apiBaseUrl,
    apiKey: serverCfg.apiKey,
  };
}

/**
 * Update server configuration at runtime
 * @param updates - Configuration updates
 * @returns Updated configuration
 */
export function updateServerConfig(updates: Partial<ServerConfig>): ServerConfig {
  config.set('server', updates);
  return getServerConfig();
}

/**
 * Reset server configuration to initial values (from CLI args)
 * @returns Reset configuration
 */
export function resetServerConfig(): ServerConfig {
  config.reset('server');
  return getServerConfig();
}

/**
 * Get initial configuration (from CLI args at startup)
 * @returns Initial configuration
 */
export function getInitialConfig(): ServerConfig {
  const initialCfg = config.getInitial().server;
  return {
    primaryModel: initialCfg.primaryModel,
    fallbackModel: initialCfg.fallbackModel,
  };
}

/**
 * Main entry point - initializes HTTP MCP server
 * Parses CLI arguments, sets up Redis context, and starts HTTP transport
 * @throws Error On fatal initialization failure
 */
async function main(): Promise<void> {
  // Get default values from config before parsing CLI
  const defaults = config.get('server');
  const redisDefaults = config.get('redis');
  const program = new Command()
    .name('kemdicode-mcp')
    .description('MCP server for KemdiCode AI integration (HTTP only)')
    .version(VERSION)
    .option('-m, --model <model>', 'Primary model', defaults.primaryModel)
    .option(
      '-f, --fallback-model <model>',
      'Fallback model for quota errors',
      defaults.fallbackModel
    )
    .option('--redis-host <host>', 'Redis host for context sharing', redisDefaults.host)
    .option('--redis-port <port>', 'Redis port', String(redisDefaults.port))
    .option('--no-context', 'Disable context sharing')
    .option('--port <port>', 'HTTP server port', String(defaults.port))
    .option('--host <host>', 'HTTP server host', defaults.host)
    .option('-v, --verbose', 'Verbose mode: full output with decorations')
    .option('--compact', 'Compact mode: essential fields only')
    .parse();

  const opts = program.opts();

  // Default is silent. CLI flags override: --verbose for full output, --compact for middle ground.
  initSilentFromEnv();
  if (opts.verbose) setOutputLevel('normal');
  else if (opts.compact) setOutputLevel('compact');

  // Load configuration from CLI args (merges with defaults and env vars)
  config.load(opts);

  // Validate full configuration against Zod schema
  const fullConfig = config.getAll();
  const validationResult = appConfigSchema.safeParse(fullConfig);
  if (!validationResult.success) {
    for (const issue of validationResult.error.issues) {
      Logger.error(`Config validation: ${issue.path.join('.')} — ${issue.message}`);
    }
    Logger.error('Invalid configuration — aborting startup. Fix the above issues.');
    process.exit(1);
  }

  const serverConfig = config.get('server');
  const outputLevel = getOutputLevel();
  if (outputLevel === 'normal') {
    Logger.info(`Verbose mode enabled`);
  }
  Logger.debug(`KemdiCode MCP v${VERSION} initialized with model: ${serverConfig.primaryModel}`);

  // Initialize context sharing (Redis)
  if (opts.context !== false) {
    const redisConfig = config.get('redis');

    // Parallel init: context sharing + agent monitor are independent
    let contextEnabled = false;
    let monitor: { isConnected(): boolean } = { isConnected: () => false };
    try {
      [contextEnabled, monitor] = await Promise.all([
        initContext(redisConfig),
        initAgentMonitor(redisConfig),
      ]);
    } catch (initError) {
      Logger.error(`Context/agent init failed: ${initError instanceof Error ? initError.message : String(initError)}`);
    }
    Logger.debug(`Context sharing: ${contextEnabled ? 'enabled' : 'disabled'}`);
    Logger.debug(`Agent monitor: ${monitor.isConnected() ? 'connected' : 'disconnected'}`);

    // Display Session ID for multi-agent coordination
    if (contextEnabled) {
      const sessionId = getSessionId();
      Logger.info(`Session ID: ${sessionId}`);
      Logger.info(`Use this ID to share context between agents`);
    }
  }

  // Initialize AI client for direct API calls (OpenAI SDK)
  if (serverConfig.apiBaseUrl && serverConfig.apiKey) {
    initAIClient({
      baseURL: serverConfig.apiBaseUrl,
      apiKey: serverConfig.apiKey,
      defaultModel: serverConfig.primaryModel,
      fallbackModel: serverConfig.fallbackModel,
    });
    Logger.debug(`AI client initialized: ${serverConfig.primaryModel}`);
  } else if (!serverConfig.apiBaseUrl && !serverConfig.apiKey) {
    Logger.warn('AI client not initialized: both apiBaseUrl and apiKey are missing. Set via .kemdicode-mcp.json or ai-config tool.');
  } else if (!serverConfig.apiBaseUrl) {
    Logger.warn('AI client not initialized: apiBaseUrl not configured. Set KEMDICODE_SERVER_API_BASE_URL or use ai-config tool.');
  } else {
    Logger.warn('AI client not initialized: apiKey not configured. Set KEMDICODE_SERVER_API_KEY or use ai-config tool.');
  }

  // Initialize multi-provider registry with config values
  registerBuiltinProviders();
  const providersConfig = config.get('providers');
  const excludedKeys = new Set(['defaultProvider']);
  for (const [key, entry] of Object.entries(providersConfig)) {
    if (excludedKeys.has(key) || typeof entry === 'string') continue;
    if (entry && (entry.apiKey || entry.baseURL)) {
      setProviderConfig(key as ProviderId, {
        id: key as ProviderId,
        apiKey: entry.apiKey || '',
        baseURL: entry.baseURL,
      });
    }
  }

  // Restore custom endpoints from Redis (persisted across restarts)
  const restoredEndpoints = await loadCustomEndpointsFromRedis();
  if (restoredEndpoints > 0) {
    Logger.info(`Restored ${restoredEndpoints} custom endpoint(s) from Redis`);
  }

  // Initialize cluster bus (L1 → L2 → L3 bus architecture)
  const clusterBusActive = await initClusterBusSystem();
  Logger.debug(`Cluster bus: ${clusterBusActive ? 'active' : 'inactive'}`);

  // Initialize Redis connection manager early for reuse in shutdown
  const redisManager = getRedisConnectionManager();

  // Handle graceful shutdown
  let isShuttingDown = false;

  const shutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    Logger.debug(`${signal} received, shutting down gracefully...`);

    const shutdownTimeout = setTimeout(() => {
      Logger.error('Shutdown timeout exceeded, forcing exit');
      process.exit(1);
    }, 10000);

    try {
      await shutdownClusterBusSystem();
      await stopHttpServer();
      await redisManager.disconnect();
      Logger.debug('Shutdown complete');
    } catch (error) {
      Logger.error('Error during shutdown:', error);
    } finally {
      clearTimeout(shutdownTimeout);
      process.exit(0);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Start HTTP server
  await startHttpServer(serverConfig.host, serverConfig.port);

  // Enable runtime tool registration notifications
  initToolsBroadcast(() => broadcastNotification('notifications/tools/list_changed'));

  // Background warmup: load all lazy tool schemas (non-blocking).
  // Sends tools/list_changed notification when complete so clients refresh schemas.
  void warmupLazySchemas().catch((err) =>
    Logger.warn(`Schema warmup failed: ${err instanceof Error ? err.message : String(err)}`),
  );

  // Initialize global event system (cognition + kanban + loop handlers)
  initGlobalEventSystem();

  // Global error handlers to ensure graceful shutdown on unhandled errors
  process.on('unhandledRejection', (reason) => {
    Logger.error('Unhandled rejection:', reason);
    shutdown('unhandledRejection');
  });
  process.on('uncaughtException', (error) => {
    Logger.error('Uncaught exception:', error);
    shutdown('uncaughtException');
  });
}

main().catch((error) => {
  Logger.error('Fatal:', error);
  process.exit(1);
});
