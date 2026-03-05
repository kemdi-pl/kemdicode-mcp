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
 * Thinking Chain Tool
 *
 * Registers and embeds chains of thought with branching support.
 * Forward-only constraint: cannot backtrack until ≥90% confidence
 * or revising the latest thought.
 *
 * @module tools/thinking/thinking-chain
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { Logger } from '../../utils/logger.js';
import { executeWithGuard } from '../tool-shared.js';
import { resolveSessionId } from '../../kanban/resolvers.js';
import {
  createChain,
  getChain,
  addThought,
  reviseThought,
  branchChain,
  concludeChain,
  listChains,
  compactChain,
} from '../../thinking/index.js';
import type { ThinkingChain } from '../../thinking/index.js';

// --- Sub-schemas for each action ---

const startSchema = z.object({
  action: z.literal('start'),
  title: z.string().min(1).max(200).describe('Title for the thinking chain'),
  agentId: z.string().min(1).max(100).optional().default('default-agent').describe('Agent ID'),
  sessionId: z.string().optional().describe('Session ID (auto-resolved if omitted)'),
  content: z.string().min(1).max(10000).describe('First thought content'),
  confidence: z.number().min(0).max(100).describe('Confidence level (0-100%)'),
  reasoning: z.string().max(2000).optional().describe('Reasoning for this confidence'),
  tags: z.array(z.string().max(50)).max(10).optional().describe('Tags for categorization'),
});

const thinkSchema = z.object({
  action: z.literal('think'),
  chainId: z.string().min(1).describe('Chain ID to add thought to'),
  content: z.string().min(1).max(10000).describe('Thought content'),
  confidence: z.number().min(0).max(100).describe('Confidence level (0-100%)'),
  reasoning: z.string().max(2000).optional().describe('Reasoning for this confidence'),
});

const branchSchema = z.object({
  action: z.literal('branch'),
  chainId: z.string().min(1).describe('Source chain ID to branch from'),
  thoughtIndex: z.number().int().min(0).describe('Thought index to branch from'),
  title: z.string().min(1).max(200).describe('Title for the new branch'),
  content: z.string().min(1).max(10000).describe('First thought in the new branch'),
  confidence: z.number().min(0).max(100).describe('Confidence level (0-100%)'),
  reasoning: z.string().max(2000).optional().describe('Reasoning for this confidence'),
});

const reviseSchema = z.object({
  action: z.literal('revise'),
  chainId: z.string().min(1).describe('Chain ID'),
  thoughtIndex: z.number().int().min(0).describe('Index of thought to revise'),
  content: z.string().min(1).max(10000).describe('Revised thought content'),
  confidence: z.number().min(0).max(100).describe('New confidence level (0-100%)'),
  reasoning: z.string().max(2000).optional().describe('Reasoning for revision'),
});

const concludeSchema = z.object({
  action: z.literal('conclude'),
  chainId: z.string().min(1).describe('Chain ID to conclude'),
  conclusion: z.string().min(1).max(10000).describe('Final conclusion'),
});

const getSchema = z.object({
  action: z.literal('get'),
  chainId: z.string().min(1).describe('Chain ID to retrieve'),
});

const listSchema = z.object({
  action: z.literal('list'),
  sessionId: z.string().optional().describe('Filter by session (auto-resolved if omitted)'),
  agentId: z.string().optional().describe('Filter by agent'),
  status: z.enum(['active', 'concluded', 'abandoned']).optional().describe('Filter by status: active (in progress), concluded (finished with conclusion), abandoned (stopped without conclusion)'),
  limit: z.number().int().min(1).max(50).optional().describe('Max results (default: 20)'),
});

const compactSchema = z.object({
  action: z.literal('compact'),
  chainId: z.string().min(1).describe('Chain ID of a concluded chain to compact via Lorenz pipeline'),
});

const schema = z.discriminatedUnion('action', [
  startSchema,
  thinkSchema,
  branchSchema,
  reviseSchema,
  concludeSchema,
  getSchema,
  listSchema,
  compactSchema,
]);

type ThinkingChainArgs = z.infer<typeof schema>;

/**
 * Format a chain for display with box-drawing characters
 */
function formatChainDisplay(chain: ThinkingChain): string {
  const lines: string[] = [];
  const w = 72;
  const hr = '─'.repeat(w);

  lines.push(`┌${hr}┐`);
  lines.push(`│ ${'THINKING CHAIN'.padEnd(w - 1)}│`);
  lines.push(`├${hr}┤`);
  lines.push(`│ ${'ID:'.padEnd(12)}${chain.id.padEnd(w - 13)}│`);
  lines.push(`│ ${'Title:'.padEnd(12)}${chain.title.substring(0, w - 13).padEnd(w - 13)}│`);
  lines.push(`│ ${'Agent:'.padEnd(12)}${chain.agentId.padEnd(w - 13)}│`);
  lines.push(`│ ${'Status:'.padEnd(12)}${chain.status.toUpperCase().padEnd(w - 13)}│`);
  lines.push(`│ ${'Thoughts:'.padEnd(12)}${String(chain.thoughts.length).padEnd(w - 13)}│`);

  if (chain.parentChainId) {
    lines.push(`│ ${'Branched:'.padEnd(12)}${(`from ${chain.parentChainId} #${chain.parentThoughtIndex}`).substring(0, w - 13).padEnd(w - 13)}│`);
  }

  if (chain.tags.length > 0) {
    lines.push(`│ ${'Tags:'.padEnd(12)}${chain.tags.join(', ').substring(0, w - 13).padEnd(w - 13)}│`);
  }

  lines.push(`├${hr}┤`);

  for (const thought of chain.thoughts) {
    const prefix = thought.revisedFrom !== undefined
      ? `  [REVISION of #${thought.revisedFrom}]`
      : '';
    const conf = `${thought.confidence}%`;
    const branchInfo = thought.branches && thought.branches.length > 0
      ? ` [${thought.branches.length} branch(es)]`
      : '';

    lines.push(`│ ${'#' + thought.index} [${conf}]${prefix}${branchInfo}`.padEnd(w) + ' │');

    // Wrap content to fit
    const contentLines = wrapText(thought.content, w - 6);
    for (const cl of contentLines) {
      lines.push(`│   ${cl.padEnd(w - 3)}│`);
    }

    if (thought.reasoning) {
      const reasonLines = wrapText(`Reasoning: ${thought.reasoning}`, w - 6);
      for (const rl of reasonLines) {
        lines.push(`│   ${rl.padEnd(w - 3)}│`);
      }
    }

    if (thought.index < chain.thoughts.length - 1) {
      lines.push(`│${'  │'.padEnd(w)}  │`);
      lines.push(`│${'  ▼'.padEnd(w)}  │`);
    }
  }

  if (chain.conclusion) {
    lines.push(`├${hr}┤`);
    lines.push(`│ ${'CONCLUSION:'.padEnd(w - 1)}│`);
    const conclusionLines = wrapText(chain.conclusion, w - 4);
    for (const cl of conclusionLines) {
      lines.push(`│  ${cl.padEnd(w - 2)}│`);
    }
  }

  lines.push(`└${hr}┘`);

  return lines.join('\n');
}

/**
 * Wrap text to a maximum line width
 */
function wrapText(text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let currentLine = '';

  for (const word of words) {
    if (currentLine.length + word.length + 1 > maxWidth) {
      if (currentLine) lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = currentLine ? `${currentLine} ${word}` : word;
    }
  }
  if (currentLine) lines.push(currentLine);

  return lines.length > 0 ? lines : [''];
}

export const thinkingChainTool: UnifiedTool = {
  name: 'thinking-chain',
  description:
    'Register and manage chains of thought with branching. Forward-only: cannot backtrack until ≥90% confidence or at last thought. Actions: start, think, branch, revise, conclude, compact, get, list.',
  zodSchema: schema,

  metadata: {
    category: 'thinking',
    tags: ['thinking', 'reasoning', 'chain-of-thought', 'branching', 'confidence'],
    examples: [
      {
        args: {
          action: 'start',
          title: 'Debug authentication issue',
          agentId: 'agent-1',
          content: 'The login fails with 401. First hypothesis: token expiration.',
          confidence: 40,
          reasoning: 'Multiple possible causes, starting with most common',
        },
        description: 'Start a new thinking chain',
      },
      {
        args: {
          action: 'think',
          chainId: 'chain_123',
          content: 'Confirmed: token expires after 1h but refresh is not called. Need to add refresh logic.',
          confidence: 85,
          reasoning: 'Logs show expired token in 90% of failed requests',
        },
        description: 'Add next thought to chain',
      },
      {
        args: {
          action: 'branch',
          chainId: 'chain_123',
          thoughtIndex: 0,
          title: 'Alternative: CORS issue',
          content: 'Could also be CORS blocking the auth header.',
          confidence: 25,
        },
        description: 'Branch from a thought to explore alternative',
      },
      {
        args: {
          action: 'revise',
          chainId: 'chain_123',
          thoughtIndex: 0,
          content: 'Revised: not just token expiration but also missing refresh token in storage.',
          confidence: 92,
        },
        description: 'Revise earlier thought (only when confidence ≥90%)',
      },
      {
        args: {
          action: 'conclude',
          chainId: 'chain_123',
          conclusion: 'Root cause: refresh token not persisted. Fix: save refresh token to localStorage on login.',
        },
        description: 'Conclude the chain with final answer',
      },
    ],
    relatedTools: ['graph-query', 'loci-recall', 'shared-thoughts', 'write-memory'],
  },

  execute: async (args): Promise<string> => {
    const input = args as unknown as ThinkingChainArgs;

    return executeWithGuard('thinking-chain', 'thinking-chain', async () => {
      switch (input.action) {
        case 'start': {
          const sessionId = input.sessionId || resolveSessionId();
          const chain = await createChain({
            title: input.title,
            agentId: input.agentId,
            sessionId,
            content: input.content,
            confidence: input.confidence,
            reasoning: input.reasoning,
            tags: input.tags,
          });

          Logger.debug(`thinking-chain: started chain ${chain.id}`);

          return JSON.stringify({
            success: true,
            chainId: chain.id,
            title: chain.title,
            thoughtCount: 1,
            currentConfidence: chain.thoughts[0].confidence,
          });
        }

        case 'think': {
          const thought = await addThought(input.chainId, {
            content: input.content,
            confidence: input.confidence,
            reasoning: input.reasoning,
          });

          Logger.debug(`thinking-chain: added thought #${thought.index} to ${input.chainId}`);

          return JSON.stringify({
            success: true,
            chainId: input.chainId,
            thoughtIndex: thought.index,
            confidence: thought.confidence,
            canReviseEarlier: thought.confidence >= 90,
          });
        }

        case 'branch': {
          const newChain = await branchChain({
            sourceChainId: input.chainId,
            thoughtIndex: input.thoughtIndex,
            title: input.title,
            content: input.content,
            confidence: input.confidence,
            reasoning: input.reasoning,
          });

          Logger.debug(`thinking-chain: branched ${newChain.id} from ${input.chainId}#${input.thoughtIndex}`);

          return JSON.stringify({
            success: true,
            newChainId: newChain.id,
            parentChainId: input.chainId,
            branchedFromThought: input.thoughtIndex,
            title: newChain.title,
          });
        }

        case 'revise': {
          const revised = await reviseThought(input.chainId, {
            thoughtIndex: input.thoughtIndex,
            content: input.content,
            confidence: input.confidence,
            reasoning: input.reasoning,
          });

          Logger.debug(
            `thinking-chain: revised thought #${input.thoughtIndex} in ${input.chainId} -> #${revised.index}`
          );

          return JSON.stringify({
            success: true,
            chainId: input.chainId,
            revisedThought: input.thoughtIndex,
            newThoughtIndex: revised.index,
            confidence: revised.confidence,
          });
        }

        case 'conclude': {
          const concluded = await concludeChain(input.chainId, input.conclusion);

          Logger.debug(`thinking-chain: concluded chain ${input.chainId}`);

          const finalConfidence =
            concluded.thoughts.length > 0
              ? concluded.thoughts[concluded.thoughts.length - 1].confidence
              : 0;

          return JSON.stringify({
            success: true,
            chainId: input.chainId,
            status: 'concluded',
            thoughtCount: concluded.thoughts.length,
            finalConfidence,
          });
        }

        case 'get': {
          const chain = await getChain(input.chainId);
          if (!chain) {
            return JSON.stringify({
              success: false,
              error: `Chain not found: ${input.chainId}`,
              code: 'NOT_FOUND',
            });
          }

          return formatChainDisplay(chain);
        }

        case 'compact': {
          const result = await compactChain(input.chainId);
          if (!result) {
            return JSON.stringify({
              success: false,
              error: `Cannot compact chain ${input.chainId}. Chain must be concluded with a non-empty conclusion.`,
              code: 'NOT_ELIGIBLE',
            });
          }

          Logger.debug(
            `thinking-chain: compacted ${input.chainId} — kept ${result.keptCount}/${result.originalThoughtCount} thoughts`
          );

          return JSON.stringify({
            success: true,
            chainId: result.chainId,
            originalThoughts: result.originalThoughtCount,
            keptThoughts: result.keptCount,
            prunedThoughts: result.prunedCount,
            fixedPointIndex: result.fixedPointIndex,
            consistencyScore: Math.round(result.consistencyScore * 1000) / 1000,
            pipeline: 'Lorenz (Phase Detection → Orbit Compression → CTC Fixed-Point)',
          });
        }

        case 'list': {
          const sessionId = input.sessionId || (input.agentId ? undefined : resolveSessionId());
          const chains = await listChains({
            sessionId,
            agentId: input.agentId,
            status: input.status,
            limit: input.limit,
          });

          return JSON.stringify({
            success: true,
            count: chains.length,
            chains: chains.map((c) => ({
              id: c.id,
              title: c.title,
              agentId: c.agentId,
              status: c.status,
              thoughtCount: c.thoughts.length,
              latestConfidence:
                c.thoughts.length > 0 ? c.thoughts[c.thoughts.length - 1].confidence : 0,
              parentChainId: c.parentChainId,
              tags: c.tags,
              updatedAt: new Date(c.updatedAt).toISOString(),
            })),
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
