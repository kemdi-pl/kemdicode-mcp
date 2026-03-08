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
 * Cluster Bus Initialization
 *
 * Orchestrates startup of the entire cluster bus subsystem:
 * 1. Load config from environment
 * 2. Initialize ClusterBus (connect Redis Pub/Sub)
 * 3. Register custom endpoints into provider registry
 * 4. Register this node in the cluster registry
 * 5. Start health monitor (heartbeats + pruning)
 * 6. Connect bus bridges (L1 ↔ L2 ↔ L3)
 * 7. Apply default flow policies
 *
 * @module cluster-bus/init
 */

import { promises as fs } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { Logger } from '../utils/logger.js';
import { validatePathSafe } from '../utils/validation.js';
import { loadClusterBusConfig } from './types.js';
import type {
  SignalPayloadMap,
  ClusterSignal,
  CIMulticastPayloadType,
  CIResultPayloadType,
} from './types.js';
import { initClusterBus, shutdownClusterBus, getClusterBus } from './bus.js';
import { complete } from '../ai/client.js';
import { registerCluster, deregisterCluster, markVirtualLocal } from './cluster-registry.js';
import { ClusterHealthMonitor } from './health-monitor.js';
import { connectBridges } from './bridges.js';
import type { BridgeHandle } from './bridges.js';
import { defaultLLMPolicy, defaultControlPolicy, defaultHeartbeatPolicy } from './signal-flow.js';
import { routeToAnyLLM } from './meta-router.js';
import { registerCustomEndpoint, listCustomEndpoints } from '../ai/providers/registry.js';
import type { ClusterCustomEndpoint } from './types.js';
import { PassController } from './pass-controller.js';
import { startAggregation, addResult } from './fan-in-aggregator.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let healthMonitor: ClusterHealthMonitor | null = null;
let bridgeHandle: BridgeHandle | null = null;
let registeredClusterId: string | null = null;

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

/**
 * Initialize the cluster bus subsystem.
 *
 * Reads config from environment (MCP_CLUSTER_*), connects Redis,
 * registers in the cluster mesh, starts heartbeats, and wires bridges.
 *
 * Returns false if cluster bus is disabled (MCP_CLUSTER_ENABLED=0).
 */
export async function initClusterBusSystem(): Promise<boolean> {
  const config = loadClusterBusConfig();

  if (!config.enabled) {
    Logger.debug('[ClusterBus] Disabled (MCP_CLUSTER_ENABLED=0)');
    return false;
  }

  try {
    Logger.info(
      `[ClusterBus] Initializing cluster bus: ${config.clusterId} (${config.clusterName})`
    );

    // 1. Initialize ClusterBus (Redis connections)
    const bus = await initClusterBus(config);

    // 2. Register custom endpoints from config into provider registry
    const customProviderIds: string[] = [];
    for (const ep of config.customEndpoints) {
      const providerId = registerCustomEndpoint({
        name: ep.name,
        displayName: ep.displayName,
        baseURL: ep.baseURL,
        apiKey: ep.requiresApiKey
          ? process.env[`MCP_CUSTOM_${ep.name.toUpperCase()}_KEY`] || ''
          : '',
        defaultModel: ep.defaultModel,
        models: ep.models,
      });
      customProviderIds.push(providerId);
    }

    // 2b. Merge runtime custom endpoints (loaded from Redis by loadCustomEndpointsFromRedis)
    //     These are registered via ai-config add-custom at runtime and persisted in Redis.
    const runtimeEndpoints = listCustomEndpoints();
    for (const ep of runtimeEndpoints) {
      const name = ep.name;
      const providerId = `custom:${name}`;
      // Skip if already registered from env config
      if (!customProviderIds.includes(providerId)) {
        customProviderIds.push(providerId);
      }
    }

    // Build combined custom endpoint list for cluster advertisement
    const allCustomEndpoints: ClusterCustomEndpoint[] = [
      ...config.customEndpoints,
      ...runtimeEndpoints
        .filter((ep) => !config.customEndpoints.some((ce) => ce.name === ep.name))
        .map((ep) => ({
          name: ep.name,
          displayName: ep.displayName,
          baseURL: ep.baseURL,
          requiresApiKey: Boolean(ep.apiKey),
          defaultModel: ep.defaultModel,
          models: ep.models,
        })),
    ];

    // 3. Register this node in the cluster registry
    await registerCluster({
      id: config.clusterId,
      name: config.clusterName,
      metaTags: config.metaTags,
      connectedProviders: customProviderIds,
      customEndpoints: allCustomEndpoints,
      capabilities: ['llm', 'code-analysis', 'kanban', 'memory', 'cognition'],
    });
    registeredClusterId = config.clusterId;
    // Mark self-cluster as virtualLocal (exempt from stale detection)
    await markVirtualLocal(config.clusterId, true);

    // 4. Apply default flow policies
    bus.flowController.addPolicy(defaultLLMPolicy());
    bus.flowController.addPolicy(defaultControlPolicy());
    bus.flowController.addPolicy(defaultHeartbeatPolicy());

    // 5. Add default routing rule
    bus.router.addRule(routeToAnyLLM());

    // 6. Start health monitor
    healthMonitor = new ClusterHealthMonitor(bus, config);
    healthMonitor.start();

    // 7. Connect bridges (L1 ↔ L2 ↔ L3)
    bridgeHandle = connectBridges(bus);

    // 8. Register local llm:request handler (single-shot or multi-pass via PassController)
    // Permanent subscription (ttlMs: 0) — must not be cleaned up by idle subscription reaper
    bus.onSignal<SignalPayloadMap['llm:request']>(
      'llm:request',
      (signal: ClusterSignal<SignalPayloadMap['llm:request']>) => {
        const startTime = Date.now();
        const correlationId = signal.correlationId || signal.id;
        const payload = signal.payload;
        const replyTo = signal.sourceCluster;

        // Guard against double-response (timeout vs async completion race)
        let responded = false;

        const sendResult = (result: SignalPayloadMap['llm:result']) => {
          if (responded) return;
          responded = true;
          bus
            .send(replyTo, 'llm:result', result, {
              correlationId,
              priority: 2,
              direction: 'upstream',
            })
            .catch((err) => {
              Logger.warn(
                `[ClusterBus] Failed to send llm:result: ${err instanceof Error ? err.message : String(err)}`
              );
            });
        };

        const sendError = (error: string) => {
          if (responded) return;
          responded = true;
          bus
            .send(
              replyTo,
              'llm:error',
              {
                requestId: correlationId,
                error,
              } satisfies SignalPayloadMap['llm:error'],
              {
                correlationId,
                priority: 2,
                direction: 'upstream',
              }
            )
            .catch((err) => {
              Logger.debug(`[ClusterBus] Failed to send llm:error signal: ${err instanceof Error ? err.message : String(err)}`);
            });
        };

        // Full agentic orchestration — cluster spawns a supervisor with tool access
        if (payload.orchestrate) {
          const orchConfig = payload.orchestrate;

          (async () => {
            const { executeAgenticLoop } = await import('../recursive/agentic-loop.js');
            const sessionId = `cluster-orch-${correlationId.slice(0, 8)}`;

            const result = await executeAgenticLoop({
              task: payload.prompt,
              agent: (orchConfig.agent as 'plan' | 'build' | 'explore' | 'general') || 'plan',
              model: payload.model ?? undefined,
              sessionId,
              maxIterations: orchConfig.maxIterations ?? 10,
              maxSubAgentDepth: 0, // no sub-agent nesting within cluster
              allowedTools: orchConfig.allowedTools,
              blockedTools: orchConfig.blockedTools,
              enableCognition: orchConfig.enableCognition ?? false,
              useFunctionCalling: true,
              timeoutMs: Math.min(payload.orchestrate!.maxIterations ?? 10, 30) * 15_000, // ~15s per iteration budget
            });

            const totalToolCalls = result.log.reduce((sum, iter) => sum + iter.toolCalls.length, 0);

            sendResult({
              requestId: correlationId,
              content: result.answer || result.log.map((i) => i.aiResponse).join('\n'),
              model: payload.model || 'unknown',
              provider: 'local',
              promptTokens: undefined,
              completionTokens: undefined,
              finishReason: result.completed ? 'orchestration-complete' : `stopped:${result.stopReason}`,
              latencyMs: Date.now() - startTime,
            });

            Logger.info(
              `[ClusterBus] Orchestration complete: ${result.iterations} iterations, ${totalToolCalls} tool calls, stopReason=${result.stopReason}`
            );
          })().catch((err) => {
            sendError(err instanceof Error ? err.message : String(err));
          });

          return;
        }

        // Multi-agent iteration (producer/reviewer loop)
        if (payload.agentIteration) {
          const iterConfig = payload.agentIteration;

          (async () => {
            const { AgentIterationLoop } = await import('./agent-iteration.js');
            const loop = new AgentIterationLoop({
              model: payload.model ?? undefined,
              agentCount: iterConfig.agentCount ?? 2,
              maxPasses: iterConfig.maxPasses ?? 3,
              qualityThreshold: iterConfig.qualityThreshold ?? 0.8,
            });

            const iterResult = await loop.execute(payload.prompt, payload.systemPrompt);

            sendResult({
              requestId: correlationId,
              content: iterResult.content,
              model: payload.model || 'unknown',
              provider: 'local',
              promptTokens: undefined,
              completionTokens: undefined,
              totalTokens: iterResult.totalTokens,
              finishReason: iterResult.converged ? 'converged' : 'budget-exhausted',
              latencyMs: iterResult.totalLatencyMs,
              passReport: {
                totalPasses: iterResult.totalPasses,
                minPassesDeclared: iterConfig.agentCount ?? 2,
                qualityAchieved: iterResult.finalQuality,
                passHistory: iterResult.passHistory.map((p) => ({
                  pass: p.pass,
                  quality: p.quality,
                  sufficient: p.quality >= (iterConfig.qualityThreshold ?? 0.8),
                  tokensUsed: p.tokensUsed,
                  latencyMs: p.latencyMs,
                })),
              },
            });

            Logger.info(
              `[ClusterBus] Agent iteration complete: ${iterResult.totalPasses} passes, quality=${iterResult.finalQuality.toFixed(2)}, converged=${iterResult.converged}, ${iterResult.totalTokens} tokens`
            );
          })().catch((err) => {
            sendError(err instanceof Error ? err.message : String(err));
          });

          return;
        }

        // Multi-pass execution with PassController
        if (payload.passConfig) {
          const controller = new PassController(payload.passConfig, payload.model ?? undefined);

          (async () => {
            // Pass 0: Assessment (skipped for 'fixed' strategy)
            const assessment = await controller.assess(payload.prompt);

            if (assessment.minPasses > payload.passConfig!.maxPasses) {
              Logger.info(
                `[ClusterBus] Task assessed at ${assessment.minPasses} passes but budget is ${payload.passConfig!.maxPasses} — capping to budget (complexity: ${assessment.complexity})`
              );
            }

            // Pass 1..N: Execute + Refine loop with safety guards
            const maxLoopIterations = Math.max(payload.passConfig!.maxPasses * 2, 40);
            const loopTimeoutMs = 5 * 60 * 1000; // 5 min hard timeout
            const loopStartTime = Date.now();
            let loopCount = 0;
            let lastContent: string | undefined;
            while (controller.shouldContinue()) {
              if (++loopCount > maxLoopIterations) {
                Logger.warn(
                  `[ClusterBus] PassController hit max iterations (${maxLoopIterations}), breaking`
                );
                break;
              }
              const perPassTimeoutMs = 60_000; // 60s per pass to prevent single slow pass blocking pipeline
              const elapsed = Date.now() - loopStartTime;
              if (elapsed > loopTimeoutMs || elapsed + perPassTimeoutMs > loopTimeoutMs) {
                Logger.warn(
                  `[ClusterBus] PassController hit timeout (elapsed=${elapsed}ms, budget=${loopTimeoutMs}ms), breaking before next pass`
                );
                break;
              }
              const passResult = await Promise.race([
                controller.execute(payload.prompt, payload.systemPrompt, lastContent),
                new Promise<never>((_, reject) =>
                  setTimeout(
                    () =>
                      reject(new Error(`Pass ${loopCount} timed out after ${perPassTimeoutMs}ms`)),
                    perPassTimeoutMs
                  )
                ),
              ]).catch((err) => {
                Logger.warn(`[ClusterBus] ${err instanceof Error ? err.message : String(err)}`);
                return null;
              });
              if (passResult) {
                lastContent = passResult.content || lastContent;
              }
            }

            const report = controller.getReport();
            const finalContent = controller.getFinalContent();

            sendResult({
              requestId: correlationId,
              content: finalContent,
              model: payload.model || 'unknown',
              provider: 'local',
              promptTokens: controller.getTotalTokens(),
              completionTokens: undefined,
              finishReason: controller.isBudgetExceeded() ? 'budget-exceeded' : 'pass-complete',
              latencyMs: Date.now() - startTime,
              passReport: report,
            });

            Logger.info(
              `[ClusterBus] Multi-pass complete: ${report.totalPasses} passes, quality=${report.qualityAchieved.toFixed(2)}, ${controller.getTotalTokens()} tokens`
            );
          })().catch((err) => {
            sendError(err instanceof Error ? err.message : String(err));
          });

          return;
        }

        // Single-shot execution (no passConfig)
        complete({
          model: payload.model ?? undefined,
          messages: [
            ...(payload.systemPrompt
              ? [{ role: 'system' as const, content: payload.systemPrompt }]
              : []),
            { role: 'user' as const, content: payload.prompt },
          ],
          maxTokens: payload.maxTokens ?? undefined,
          temperature:
            payload.temperature !== null &&
            payload.temperature !== undefined &&
            !Number.isNaN(payload.temperature)
              ? Math.min(2, Math.max(0, payload.temperature))
              : undefined,
        })
          .then((response) => {
            sendResult({
              requestId: correlationId,
              content: response.content,
              model: response.model || payload.model || 'unknown',
              provider: 'local',
              promptTokens: response.usage?.promptTokens,
              completionTokens: response.usage?.completionTokens,
              finishReason: response.finishReason,
              latencyMs: Date.now() - startTime,
            });
          })
          .catch((err) => {
            sendError(err instanceof Error ? err.message : String(err));
          });
      },
      undefined,
      { ttlMs: 0 }
    );

    // 9. Register CI multicast handler — auto-start fan-in aggregation
    bus.onSignal<CIMulticastPayloadType>(
      'ci:multicast',
      (signal: ClusterSignal<CIMulticastPayloadType>) => {
        try {
          const result = startAggregation(signal.payload);
          Logger.info(
            `[ClusterBus] CI multicast received — started aggregation for pipeline ${result.pipelineId} (expected: ${result.totalExpected})`
          );
        } catch (err) {
          Logger.warn(
            `[ClusterBus] Failed to start aggregation: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      },
      undefined,
      { ttlMs: 0 }
    );

    // 10. Register CI result handler — feed results into fan-in aggregator
    bus.onSignal<CIResultPayloadType>(
      'ci:result',
      (signal: ClusterSignal<CIResultPayloadType>) => {
        try {
          const result = addResult(signal.payload);
          if (result) {
            Logger.info(
              `[ClusterBus] CI result from ${signal.payload.targetCluster}: ${signal.payload.success ? 'success' : 'failure'} (${result.receivedCount}/${result.totalExpected})`
            );
            if (result.state === 'completed' || result.state === 'failed') {
              Logger.info(
                `[ClusterBus] Aggregation ${result.pipelineId} ${result.state}: ${result.successCount} success, ${result.failureCount} failed`
              );
            }
          }
        } catch (err) {
          Logger.warn(
            `[ClusterBus] Failed to add CI result: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      },
      undefined,
      { ttlMs: 0 }
    );

    // 11. Register file:read handler — enables AI to read files from this cluster
    //     Security: validates all paths, caps array size, whitelists encoding
    const FILE_READ_MAX_PATHS = 50;
    const FILE_READ_MAX_LINES = 10_000;
    const FILE_READ_ALLOWED_ENCODINGS = new Set(['utf-8', 'utf8', 'base64']);
    // Resolve the working directory once at init time for sandboxing
    const fileReadBasePath = resolvePath(process.cwd());

    bus.onSignal<SignalPayloadMap['file:read']>(
      'file:read',
      async (signal: ClusterSignal<SignalPayloadMap['file:read']>) => {
        Logger.debug(`[ClusterBus] file:read handler invoked for signal ${signal.id.slice(0, 8)}`);
        const correlationId = signal.correlationId || signal.id;
        const { paths, encoding = 'utf-8', maxLines } = signal.payload;
        const replyTo = signal.sourceCluster;

        if (!paths || paths.length === 0) {
          bus
            .send(
              replyTo,
              'file:read-result',
              {
                requestId: correlationId,
                files: {},
              } satisfies SignalPayloadMap['file:read-result'],
              {
                correlationId,
                priority: 2,
                direction: 'upstream',
              }
            )
            .catch((err) => {
              Logger.warn(`[ClusterBus] Failed to send empty file:read-result: ${err}`);
            });
          return;
        }

        // Validate encoding against whitelist
        const safeEncoding: BufferEncoding = FILE_READ_ALLOWED_ENCODINGS.has(encoding)
          ? (encoding as BufferEncoding)
          : 'utf-8';

        // Cap maxLines to prevent DoS
        const safeMaxLines = maxLines && maxLines > 0
          ? Math.min(maxLines, FILE_READ_MAX_LINES)
          : undefined;

        // Cap paths array size to prevent file descriptor exhaustion
        const safePaths = paths.slice(0, FILE_READ_MAX_PATHS);

        const files: Record<string, { content: string; error?: string }> = {};

        for (const filePath of safePaths) {
          // Validate each path against traversal attacks
          const validation = await validatePathSafe(filePath, {
            projectRoot: fileReadBasePath,
            operation: 'read',
          }, 'cluster-bus:file:read');

          if (!validation.ok) {
            files[filePath] = {
              content: '',
              error: 'File not accessible',
            };
            continue;
          }

          try {
            let content = await fs.readFile(validation.path, safeEncoding);
            if (safeMaxLines) {
              const lines = content.split('\n');
              content =
                lines.slice(0, safeMaxLines).join('\n') +
                (lines.length > safeMaxLines ? `\n... (${lines.length - safeMaxLines} more lines)` : '');
            }
            files[filePath] = { content };
          } catch (err) {
            // Sanitize error — don't leak internal paths or OS details to remote clusters
            Logger.warn(`[ClusterBus] file:read error for ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
            files[filePath] = {
              content: '',
              error: 'File not accessible',
            };
          }
        }

        bus
          .send(
            replyTo,
            'file:read-result',
            {
              requestId: correlationId,
              files,
            } satisfies SignalPayloadMap['file:read-result'],
            {
              correlationId,
              priority: 2,
              direction: 'upstream',
            }
          )
          .catch((err) => {
            Logger.warn(`[ClusterBus] Failed to send file:read-result: ${err}`);
          });
      },
      undefined,
      { ttlMs: 0 }
    );

    Logger.info(
      `[ClusterBus] System ready: ${config.clusterId} | tags: ${config.metaTags.map((t) => `${t.key}:${t.value}`).join(', ') || 'none'}`
    );

    return true;
  } catch (err) {
    Logger.error(`[ClusterBus] Initialization failed:`, err);
    // Attempt cleanup
    await shutdownClusterBusSystem().catch((shutdownErr) => {
      Logger.debug(`[ClusterBus] Cleanup during init failure also failed: ${shutdownErr instanceof Error ? shutdownErr.message : String(shutdownErr)}`);
    });
    return false;
  }
}

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

/**
 * Gracefully shut down the cluster bus subsystem.
 */
export async function shutdownClusterBusSystem(): Promise<void> {
  // Disconnect bridges
  if (bridgeHandle) {
    bridgeHandle.disconnect();
    bridgeHandle = null;
  }

  // Stop health monitor
  if (healthMonitor) {
    healthMonitor.stop();
    healthMonitor = null;
  }

  // Deregister from cluster mesh
  if (registeredClusterId) {
    try {
      await deregisterCluster(registeredClusterId);
    } catch {
      // Ignore deregistration errors during shutdown
    }
    registeredClusterId = null;
  }

  // Shutdown bus
  await shutdownClusterBus();

  Logger.info('[ClusterBus] System shut down');
}

// ---------------------------------------------------------------------------
// Accessors
// ---------------------------------------------------------------------------

/** Get the health monitor instance (null if not initialized). */
export function getHealthMonitor(): ClusterHealthMonitor | null {
  return healthMonitor;
}

/** Get the bridge handle (null if not initialized). */
export function getBridgeHandle(): BridgeHandle | null {
  return bridgeHandle;
}

/** Check if the cluster bus subsystem is active. */
export function isClusterBusActive(): boolean {
  const bus = getClusterBus();
  return bus !== null && bus.isConnected;
}

/** Get a summary of the cluster bus system state. */
export function getClusterBusSystemStatus(): {
  active: boolean;
  clusterId: string | null;
  healthMonitorRunning: boolean;
  bridgesConnected: boolean;
  busStats: ReturnType<NonNullable<ReturnType<typeof getClusterBus>>['getStats']> | null;
  healthStats: ReturnType<ClusterHealthMonitor['getStats']> | null;
  bridgeStats: ReturnType<NonNullable<BridgeHandle>['getStats']> | null;
} {
  const bus = getClusterBus();

  return {
    active: bus !== null && bus.isConnected,
    clusterId: registeredClusterId,
    healthMonitorRunning: healthMonitor?.isRunning ?? false,
    bridgesConnected: bridgeHandle !== null,
    busStats: bus?.getStats() ?? null,
    healthStats: healthMonitor?.getStats() ?? null,
    bridgeStats: bridgeHandle?.getStats() ?? null,
  };
}
