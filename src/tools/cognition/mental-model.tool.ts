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
 * Mental Model Tool
 *
 * Store and query persistent mental models of system architecture.
 * Captures semantic understanding — not syntax (code-outline does that),
 * but meaning: what components do, why they exist, how they relate,
 * and what invariants they maintain.
 *
 * @module tools/cognition/mental-model
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { getMentalModelStore } from '../../cognition/mental-model-store.js';
import { Logger } from '../../utils/logger.js';
import { executeCognitionTool } from './cognition-shared.js';
import { resolveSessionId } from '../../kanban/resolvers.js';
import type { MentalModel } from '../../cognition/types.js';

const schema = z.object({
  action: z
    .enum([
      'create',
      'get',
      'list',
      'add-component',
      'add-relationship',
      'remove-component',
      'check-staleness',
      'refresh',
      'impact-analysis',
      'dependency-chain',
      'invariant-check',
    ])
    .describe('Action to perform'),
  sessionId: z.string().describe('Session ID'),

  // create / get by name
  name: z
    .string()
    .max(200)
    .optional()
    .describe('Model name (action=create, get)'),
  description: z
    .string()
    .max(2000)
    .optional()
    .describe('Model description (action=create)'),
  tags: z
    .array(z.string().max(50))
    .max(20)
    .optional()
    .describe('Tags for categorization'),

  // get by id / add-component / add-relationship / remove-component / check-staleness / refresh
  modelId: z
    .string()
    .optional()
    .describe('Model ID (required for get-by-id, add-component, add-relationship, remove-component, check-staleness, refresh)'),

  // add-component
  componentName: z
    .string()
    .max(200)
    .optional()
    .describe('Component name (action=add-component, remove-component)'),
  componentRole: z
    .string()
    .max(1000)
    .optional()
    .describe('Component role/responsibility (action=add-component)'),
  componentFiles: z
    .array(z.string().max(500))
    .max(50)
    .optional()
    .describe('Source files that implement this component (action=add-component)'),
  componentDependencies: z
    .array(z.string().max(200))
    .max(30)
    .optional()
    .describe('Dependency component names (action=add-component)'),
  componentInvariants: z
    .array(z.string().max(500))
    .max(20)
    .optional()
    .describe('Key invariants/rules this component must uphold (action=add-component)'),

  // add-relationship
  from: z
    .string()
    .max(200)
    .optional()
    .describe('Source component name (action=add-relationship)'),
  to: z
    .string()
    .max(200)
    .optional()
    .describe('Target component name (action=add-relationship)'),
  relationshipType: z
    .enum(['calls', 'depends-on', 'produces', 'consumes', 'extends', 'contains'])
    .optional()
    .describe('Relationship type (action=add-relationship)'),
  protocol: z
    .string()
    .max(200)
    .optional()
    .describe('Communication protocol, e.g. "Redis Pub/Sub", "direct import" (action=add-relationship)'),
  relationshipDescription: z
    .string()
    .max(500)
    .optional()
    .describe('Human-readable relationship description (action=add-relationship)'),

  // check-staleness
  changedFiles: z
    .array(z.string().max(500))
    .max(100)
    .optional()
    .describe('Files that changed — used to detect which components are stale (action=check-staleness)'),
});

type MentalModelArgs = z.infer<typeof schema>;

/**
 * Format a mental model for rich display using markdown.
 */
function formatModelDisplay(model: MentalModel): string {
  const lines: string[] = [];
  const staleLabel = model.staleSince
    ? ` (STALE since ${new Date(model.staleSince).toISOString()})`
    : '';

  lines.push(`# ${model.name}${staleLabel}`);
  lines.push('');
  lines.push(`**ID:** ${model.id}`);
  lines.push(`**Session:** ${model.sessionId}`);
  lines.push(`**Created:** ${new Date(model.createdAt).toISOString()}`);
  lines.push(`**Updated:** ${new Date(model.updatedAt).toISOString()}`);
  if (model.tags.length > 0) {
    lines.push(`**Tags:** ${model.tags.join(', ')}`);
  }
  lines.push('');
  lines.push(`> ${model.description}`);
  lines.push('');

  // Components
  lines.push(`## Components (${model.components.length})`);
  lines.push('');

  if (model.components.length === 0) {
    lines.push('_No components defined yet._');
  } else {
    for (const comp of model.components) {
      lines.push(`### ${comp.name}`);
      lines.push(`**Role:** ${comp.role}`);
      lines.push('');

      if (comp.files.length > 0) {
        lines.push('**Files:**');
        for (const f of comp.files) {
          lines.push(`- \`${f}\``);
        }
        lines.push('');
      }

      if (comp.dependencies.length > 0) {
        lines.push(`**Dependencies:** ${comp.dependencies.join(', ')}`);
        lines.push('');
      }

      if (comp.invariants.length > 0) {
        lines.push('**Invariants:**');
        for (const inv of comp.invariants) {
          lines.push(`- ${inv}`);
        }
        lines.push('');
      }
    }
  }

  // Relationships
  lines.push(`## Relationships (${model.relationships.length})`);
  lines.push('');

  if (model.relationships.length === 0) {
    lines.push('_No relationships defined yet._');
  } else {
    for (const rel of model.relationships) {
      const protocol = rel.protocol ? ` via ${rel.protocol}` : '';
      const desc = rel.description ? ` -- ${rel.description}` : '';
      lines.push(`- **${rel.from}** --[${rel.type}]--> **${rel.to}**${protocol}${desc}`);
    }
  }

  return lines.join('\n');
}

/**
 * Format a model summary for list display.
 */
function formatModelSummary(model: MentalModel): Record<string, unknown> {
  return {
    id: model.id,
    name: model.name,
    description:
      model.description.length > 120
        ? model.description.substring(0, 120) + '...'
        : model.description,
    components: model.components.length,
    relationships: model.relationships.length,
    stale: model.staleSince ? new Date(model.staleSince).toISOString() : null,
    tags: model.tags,
    updatedAt: new Date(model.updatedAt).toISOString(),
  };
}

export const mentalModelTool: UnifiedTool<typeof schema> = {
  name: 'mental-model',
  description:
    'Store and query persistent mental models of system architecture — semantic understanding, not just syntax. ' +
    'Actions: create, get, list, add-component, add-relationship, remove-component, check-staleness, refresh.',
  zodSchema: schema,

  metadata: {
    category: 'cognition',
    tags: ['model', 'architecture', 'understanding', 'knowledge'],
    examples: [
      {
        args: {
          action: 'create',
          sessionId: 'session-1',
          name: 'KemdiCode MCP Architecture',
          description:
            'High-level architecture of the KemdiCode MCP server: HTTP transport, tool registry, Redis-backed stores, multi-agent coordination.',
          tags: ['architecture', 'mcp'],
        },
        description: 'Create a new mental model of a system',
      },
      {
        args: {
          action: 'add-component',
          sessionId: 'session-1',
          modelId: 'model_xxx',
          componentName: 'Tool Registry',
          componentRole:
            'Central hub for all MCP tools. Validates input via Zod, converts to JSON Schema for protocol, dispatches execution, and auto-shares results to Redis.',
          componentFiles: ['@src/tools/registry.ts', '@src/tools/index.ts'],
          componentDependencies: ['Redis Context'],
          componentInvariants: [
            'Every tool must have a unique name',
            'Zod schema is the single source of truth for validation',
          ],
        },
        description: 'Add a component to an existing model',
      },
      {
        args: {
          action: 'add-relationship',
          sessionId: 'session-1',
          modelId: 'model_xxx',
          from: 'Tool Registry',
          to: 'Redis Context',
          relationshipType: 'calls',
          protocol: 'ioredis pipeline',
          relationshipDescription: 'Auto-shares tool outputs to Redis for cross-agent context',
        },
        description: 'Add a relationship between components',
      },
      {
        args: {
          action: 'check-staleness',
          sessionId: 'session-1',
          modelId: 'model_xxx',
          changedFiles: ['@src/tools/registry.ts', '@src/server/http-server.ts'],
        },
        description: 'Check which components are affected by file changes',
      },
    ],
    relatedTools: ['code-outline', 'thinking-chain', 'write-memory', 'graph-query'],
  },

  execute: async (args): Promise<string> => {
    const input = args as unknown as MentalModelArgs;

    return executeCognitionTool('mental-model', getMentalModelStore, async (store) => {
      switch (input.action) {
        // ─────────────────────────────────────────────────────────────────────
        // CREATE
        // ─────────────────────────────────────────────────────────────────────
        case 'create': {
          if (!input.name) {
            return JSON.stringify({
              success: false,
              error: 'name is required for action=create',
              code: 'MISSING_PARAM',
            });
          }

          // Resolve by name first: if a model with this name exists, return it
          const existing = await store.getByName(input.name);
          if (existing) {
            Logger.debug(`mental-model: found existing model by name "${input.name}"`);
            return JSON.stringify({
              success: true,
              existing: true,
              modelId: existing.id,
              name: existing.name,
              components: existing.components.length,
              relationships: existing.relationships.length,
              message: `Model "${existing.name}" already exists. Use modelId=${existing.id} to modify it.`,
            });
          }

          const sessionId = input.sessionId || resolveSessionId();
          const model = await store.create({
            sessionId,
            name: input.name,
            description: input.description || '',
            components: [],
            relationships: [],
            tags: input.tags || [],
          });

          if (!model) {
            return JSON.stringify({
              success: false,
              error: 'Failed to create model (Redis error)',
              code: 'STORE_ERROR',
            });
          }

          Logger.debug(`mental-model: created model ${model.id} "${model.name}"`);

          return JSON.stringify({
            success: true,
            existing: false,
            modelId: model.id,
            name: model.name,
            message: `Model "${model.name}" created. Add components with action=add-component.`,
          });
        }

        // ─────────────────────────────────────────────────────────────────────
        // GET
        // ─────────────────────────────────────────────────────────────────────
        case 'get': {
          let model: MentalModel | null = null;

          if (input.modelId) {
            model = await store.get(input.modelId);
          } else if (input.name) {
            model = await store.getByName(input.name);
          } else {
            return JSON.stringify({
              success: false,
              error: 'Either modelId or name is required for action=get',
              code: 'MISSING_PARAM',
            });
          }

          if (!model) {
            return JSON.stringify({
              success: false,
              error: `Model not found: ${input.modelId || input.name}`,
              code: 'NOT_FOUND',
            });
          }

          return formatModelDisplay(model);
        }

        // ─────────────────────────────────────────────────────────────────────
        // LIST
        // ─────────────────────────────────────────────────────────────────────
        case 'list': {
          const sessionId = input.sessionId || resolveSessionId();
          const models = await store.listBySession(sessionId);

          return JSON.stringify({
            success: true,
            count: models.length,
            models: models.map(formatModelSummary),
          });
        }

        // ─────────────────────────────────────────────────────────────────────
        // ADD-COMPONENT
        // ─────────────────────────────────────────────────────────────────────
        case 'add-component': {
          if (!input.modelId) {
            return JSON.stringify({
              success: false,
              error: 'modelId is required for action=add-component',
              code: 'MISSING_PARAM',
            });
          }
          if (!input.componentName) {
            return JSON.stringify({
              success: false,
              error: 'componentName is required for action=add-component',
              code: 'MISSING_PARAM',
            });
          }

          const ok = await store.addComponent(input.modelId, {
            name: input.componentName,
            role: input.componentRole || '',
            files: input.componentFiles || [],
            dependencies: input.componentDependencies || [],
            invariants: input.componentInvariants || [],
          });

          if (!ok) {
            return JSON.stringify({
              success: false,
              error: `Failed to add component to model ${input.modelId}`,
              code: 'STORE_ERROR',
            });
          }

          return JSON.stringify({
            success: true,
            modelId: input.modelId,
            componentName: input.componentName,
            message: `Component "${input.componentName}" added to model.`,
          });
        }

        // ─────────────────────────────────────────────────────────────────────
        // ADD-RELATIONSHIP
        // ─────────────────────────────────────────────────────────────────────
        case 'add-relationship': {
          if (!input.modelId) {
            return JSON.stringify({
              success: false,
              error: 'modelId is required for action=add-relationship',
              code: 'MISSING_PARAM',
            });
          }
          if (!input.from || !input.to || !input.relationshipType) {
            return JSON.stringify({
              success: false,
              error: 'from, to, and relationshipType are required for action=add-relationship',
              code: 'MISSING_PARAM',
            });
          }

          const ok = await store.addRelationship(input.modelId, {
            from: input.from,
            to: input.to,
            type: input.relationshipType,
            protocol: input.protocol,
            description: input.relationshipDescription,
          });

          if (!ok) {
            return JSON.stringify({
              success: false,
              error: `Failed to add relationship to model ${input.modelId}`,
              code: 'STORE_ERROR',
            });
          }

          return JSON.stringify({
            success: true,
            modelId: input.modelId,
            from: input.from,
            to: input.to,
            type: input.relationshipType,
            message: `Relationship ${input.from} --[${input.relationshipType}]--> ${input.to} added.`,
          });
        }

        // ─────────────────────────────────────────────────────────────────────
        // REMOVE-COMPONENT
        // ─────────────────────────────────────────────────────────────────────
        case 'remove-component': {
          if (!input.modelId) {
            return JSON.stringify({
              success: false,
              error: 'modelId is required for action=remove-component',
              code: 'MISSING_PARAM',
            });
          }
          if (!input.componentName) {
            return JSON.stringify({
              success: false,
              error: 'componentName is required for action=remove-component',
              code: 'MISSING_PARAM',
            });
          }

          const ok = await store.removeComponent(input.modelId, input.componentName);

          if (!ok) {
            return JSON.stringify({
              success: false,
              error: `Component "${input.componentName}" not found or failed to remove from model ${input.modelId}`,
              code: 'NOT_FOUND',
            });
          }

          return JSON.stringify({
            success: true,
            modelId: input.modelId,
            removedComponent: input.componentName,
            message: `Component "${input.componentName}" and its relationships removed from model.`,
          });
        }

        // ─────────────────────────────────────────────────────────────────────
        // CHECK-STALENESS
        // ─────────────────────────────────────────────────────────────────────
        case 'check-staleness': {
          if (!input.modelId) {
            return JSON.stringify({
              success: false,
              error: 'modelId is required for action=check-staleness',
              code: 'MISSING_PARAM',
            });
          }
          if (!input.changedFiles || input.changedFiles.length === 0) {
            return JSON.stringify({
              success: false,
              error: 'changedFiles is required for action=check-staleness',
              code: 'MISSING_PARAM',
            });
          }

          const affectedComponents = await store.checkStaleness(
            input.modelId,
            input.changedFiles
          );

          // Auto-mark stale if any components are affected
          if (affectedComponents.length > 0) {
            await store.markStale(input.modelId);
          }

          const model = await store.get(input.modelId);

          return JSON.stringify({
            success: true,
            modelId: input.modelId,
            modelName: model?.name || 'unknown',
            changedFilesCount: input.changedFiles.length,
            affectedComponentCount: affectedComponents.length,
            affectedComponents,
            isStale: affectedComponents.length > 0,
            message:
              affectedComponents.length > 0
                ? `${affectedComponents.length} component(s) affected: ${affectedComponents.join(', ')}. Model marked as stale.`
                : 'No components affected by these file changes. Model is fresh.',
          });
        }

        // ─────────────────────────────────────────────────────────────────────
        // REFRESH
        // ─────────────────────────────────────────────────────────────────────
        case 'refresh': {
          if (!input.modelId) {
            return JSON.stringify({
              success: false,
              error: 'modelId is required for action=refresh',
              code: 'MISSING_PARAM',
            });
          }

          const ok = await store.refresh(input.modelId);

          if (!ok) {
            return JSON.stringify({
              success: false,
              error: `Model not found or failed to refresh: ${input.modelId}`,
              code: 'STORE_ERROR',
            });
          }

          return JSON.stringify({
            success: true,
            modelId: input.modelId,
            message: 'Model refreshed. Stale marker cleared.',
          });
        }

        // ─────────────────────────────────────────────────────────────────────
        // IMPACT-ANALYSIS
        // ─────────────────────────────────────────────────────────────────────
        case 'impact-analysis': {
          if (!input.modelId) {
            return JSON.stringify({ success: false, error: 'modelId is required', code: 'MISSING_PARAM' });
          }
          if (!input.changedFiles || input.changedFiles.length === 0) {
            return JSON.stringify({ success: false, error: 'changedFiles is required', code: 'MISSING_PARAM' });
          }

          const model = await store.get(input.modelId);
          if (!model) {
            return JSON.stringify({ success: false, error: `Model not found: ${input.modelId}`, code: 'NOT_FOUND' });
          }

          // Find directly affected components (by file overlap)
          const directlyAffected = new Set<string>();
          for (const comp of model.components) {
            for (const file of input.changedFiles) {
              const normalized = file.replace(/^@/, '').replace(/\\/g, '/');
              if (comp.files.some((f) => f.replace(/^@/, '').replace(/\\/g, '/') === normalized)) {
                directlyAffected.add(comp.name);
              }
            }
          }

          // BFS through relationships to find transitive impact
          const transitivelyAffected = new Set<string>();
          const queue = [...directlyAffected];
          const visited = new Set<string>();

          while (queue.length > 0) {
            const current = queue.shift()!;
            if (visited.has(current.toLowerCase())) continue;
            visited.add(current.toLowerCase());

            for (const rel of model.relationships) {
              if (rel.to.toLowerCase() === current.toLowerCase() && !visited.has(rel.from.toLowerCase())) {
                transitivelyAffected.add(rel.from);
                queue.push(rel.from);
              }
              if (
                rel.from.toLowerCase() === current.toLowerCase() &&
                (rel.type === 'contains' || rel.type === 'extends') &&
                !visited.has(rel.to.toLowerCase())
              ) {
                transitivelyAffected.add(rel.to);
                queue.push(rel.to);
              }
            }
          }

          return JSON.stringify({
            success: true,
            modelId: input.modelId,
            changedFiles: input.changedFiles,
            directlyAffected: [...directlyAffected],
            transitivelyAffected: [...transitivelyAffected].filter((c) => !directlyAffected.has(c)),
            totalAffected: visited.size,
            impactChain: [...visited],
          });
        }

        // ─────────────────────────────────────────────────────────────────────
        // DEPENDENCY-CHAIN
        // ─────────────────────────────────────────────────────────────────────
        case 'dependency-chain': {
          if (!input.modelId || !input.componentName) {
            return JSON.stringify({
              success: false,
              error: 'modelId and componentName are required',
              code: 'MISSING_PARAM',
            });
          }

          const model = await store.get(input.modelId);
          if (!model) {
            return JSON.stringify({ success: false, error: `Model not found: ${input.modelId}`, code: 'NOT_FOUND' });
          }

          // Forward: what componentName depends on
          const dependencies: string[] = [];
          const visitedDeps = new Set<string>();
          const fwdQueue = [input.componentName];
          while (fwdQueue.length > 0) {
            const current = fwdQueue.shift()!;
            if (visitedDeps.has(current.toLowerCase())) continue;
            visitedDeps.add(current.toLowerCase());
            for (const rel of model.relationships) {
              if (
                rel.from.toLowerCase() === current.toLowerCase() &&
                (rel.type === 'depends-on' || rel.type === 'calls') &&
                !visitedDeps.has(rel.to.toLowerCase())
              ) {
                dependencies.push(rel.to);
                fwdQueue.push(rel.to);
              }
            }
          }

          // Backward: what depends on componentName
          const dependents: string[] = [];
          const visitedDependents = new Set<string>();
          const bwdQueue = [input.componentName];
          while (bwdQueue.length > 0) {
            const current = bwdQueue.shift()!;
            if (visitedDependents.has(current.toLowerCase())) continue;
            visitedDependents.add(current.toLowerCase());
            for (const rel of model.relationships) {
              if (
                rel.to.toLowerCase() === current.toLowerCase() &&
                (rel.type === 'depends-on' || rel.type === 'calls') &&
                !visitedDependents.has(rel.from.toLowerCase())
              ) {
                dependents.push(rel.from);
                bwdQueue.push(rel.from);
              }
            }
          }

          return JSON.stringify({
            success: true,
            component: input.componentName,
            dependencies,
            dependents,
          });
        }

        // ─────────────────────────────────────────────────────────────────────
        // INVARIANT-CHECK
        // ─────────────────────────────────────────────────────────────────────
        case 'invariant-check': {
          if (!input.modelId || !input.changedFiles || input.changedFiles.length === 0) {
            return JSON.stringify({
              success: false,
              error: 'modelId and changedFiles are required',
              code: 'MISSING_PARAM',
            });
          }

          const model = await store.get(input.modelId);
          if (!model) {
            return JSON.stringify({ success: false, error: `Model not found: ${input.modelId}`, code: 'NOT_FOUND' });
          }

          const atRiskInvariants: Array<{ component: string; invariant: string; files: string[] }> = [];

          for (const comp of model.components) {
            const hasAffectedFile = comp.files.some((f) => {
              const normalized = f.replace(/^@/, '').replace(/\\/g, '/');
              return input.changedFiles!.some(
                (cf) => cf.replace(/^@/, '').replace(/\\/g, '/') === normalized,
              );
            });

            if (hasAffectedFile && comp.invariants.length > 0) {
              for (const inv of comp.invariants) {
                atRiskInvariants.push({
                  component: comp.name,
                  invariant: inv,
                  files: comp.files,
                });
              }
            }
          }

          return JSON.stringify({
            success: true,
            changedFiles: input.changedFiles,
            atRiskInvariants,
            totalInvariants: atRiskInvariants.length,
            message:
              atRiskInvariants.length > 0
                ? `${atRiskInvariants.length} invariant(s) at risk. Review before committing.`
                : 'No invariants affected by these changes.',
          });
        }

        default:
          return JSON.stringify({
            success: false,
            error: `Unknown action: ${(input as { action: string }).action}`,
            code: 'INVALID_ACTION',
          });
      }
    });
  },
};
