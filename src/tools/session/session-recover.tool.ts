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
 * Session Recovery Tool
 *
 * Orchestrates comprehensive session recovery after compaction or restart.
 * Aggregates context from multiple sources into a single recovery package.
 *
 * @module tools/session/session-recover
 */

import { z } from 'zod';
import type { UnifiedTool } from '../registry.js';
import { getAvailabilityChecker } from '../availability-checker.js';
import { getAgentRankStore } from '../../cognition/agent-rank-store.js';
import { getAmbientLearner } from '../../cognition/ambient-learner.js';
import { listProviders } from '../../ai/providers/registry.js';

const schema = z.object({
  sessionId: z.string().optional().describe('Session ID to recover (auto-detected if omitted)'),
  includeAmbientLearning: z.boolean().default(true).describe('Include learned project patterns'),
  includeAgentRankings: z.boolean().default(true).describe('Include agent performance data'),
  includeToolHealth: z.boolean().default(true).describe('Include tool availability status'),
  verboseOutput: z.boolean().default(false).describe('Include detailed JSON data'),
});

/** AI tool names for health check */
const AI_TOOLS = [
  'ask-ai', 'plan', 'build', 'brainstorm',
  'code-review', 'write-tests', 'explain-code', 'fix-bug',
  'refactor', 'auto-fix', 'auto-fix-agent', 'analyze-deps',
  'semantic-search', 'multi-prompt', 'consensus-prompt',
];

export const sessionRecoverTool: UnifiedTool<typeof schema> = {
  name: 'session-recover',
  description:
    'Comprehensive session recovery after compaction. Restores memory, handoff, tool health, rankings, and ambient insights in one call.',
  zodSchema: schema,
  metadata: {
    category: 'session',
    tags: ['recovery', 'compaction', 'context', 'handoff'],
    longRunning: true,
    examples: [
      { args: {}, description: 'Full session recovery with all components' },
      {
        args: { includeAmbientLearning: false, includeAgentRankings: false },
        description: 'Minimal recovery (memory + handoff + health only)',
      },
    ],
    relatedTools: ['read-memory', 'smart-handoff', 'loci-recall', 'agent-rank', 'tool-health'],
  },

  execute: async (args, onProgress) => {
    const {
      sessionId: explicitSessionId,
      includeAmbientLearning,
      includeAgentRankings,
      includeToolHealth,
      verboseOutput,
    } = args;

    const sections: string[] = [];
    const recommendations: string[] = [];

    onProgress?.('Starting session recovery...\n');

    // Step 1: Active session memory
    onProgress?.('[1/6] Reading active-session memory...\n');
    let activeMemoryContent: string | null = null;
    try {
      // Use executeTool internally to read memory
      const { executeTool } = await import('../registry.js');
      const memoryResult = await executeTool('read-memory', {
        names: ['active-session'],
      });
      activeMemoryContent = memoryResult;
      sections.push(`## Active Session Memory\n\n${memoryResult}`);
      onProgress?.('  -> Active session memory recovered\n');
    } catch {
      sections.push('## Active Session Memory\n\nNo active-session memory found.');
      recommendations.push('Save session state via: write-memory --name active-session --content <state>');
      onProgress?.('  -> No active session memory found\n');
    }

    // Step 2: Latest handoff
    onProgress?.('[2/6] Loading latest handoff report...\n');
    try {
      const { executeTool } = await import('../registry.js');
      const sessionId = explicitSessionId || 'default-session';
      const handoffResult = await executeTool('smart-handoff', {
        action: 'get-latest',
        sessionId,
        agentId: 'recovery-agent',
      });
      sections.push(`## Latest Handoff\n\n${handoffResult}`);
      onProgress?.('  -> Handoff report loaded\n');
    } catch {
      sections.push('## Latest Handoff\n\nNo handoff reports found.');
      onProgress?.('  -> No handoff reports found\n');
    }

    // Step 3: Loci resurrection
    onProgress?.('[3/6] Resurrecting knowledge context...\n');
    try {
      const { executeTool } = await import('../registry.js');
      const lociResult = await executeTool('loci-recall', {
        action: 'resurrect',
        projectPath: process.cwd(),
      });
      sections.push(`## Knowledge Context\n\n${lociResult}`);
      onProgress?.('  -> Knowledge context resurrected\n');
    } catch {
      sections.push('## Knowledge Context\n\nNo loci context available.');
      onProgress?.('  -> No loci context available\n');
    }

    // Step 4: Tool health
    if (includeToolHealth) {
      onProgress?.('[4/6] Checking tool availability...\n');
      const providers = listProviders();
      const available = providers.filter((p) => p.available);

      let healthOutput = `## Tool Health\n\n`;
      healthOutput += `AI providers configured: ${available.length}/${providers.length}\n`;
      for (const p of providers) {
        healthOutput += `  ${p.available ? '+' : '-'} ${p.id}\n`;
      }

      if (available.length === 0) {
        healthOutput += `\nWARNING: No AI providers configured. ${AI_TOOLS.length} tools unavailable.\n`;
        recommendations.push('Configure AI provider: ai-config --action set --provider openai --apiKey <key>');
      }

      sections.push(healthOutput);
      onProgress?.(`  -> ${available.length} providers configured\n`);
    } else {
      onProgress?.('[4/6] Skipped (tool health disabled)\n');
    }

    // Step 5: Agent rankings
    if (includeAgentRankings) {
      onProgress?.('[5/6] Loading agent rankings...\n');
      try {
        const store = getAgentRankStore();
        if (!store.isConnected()) await store.connect();

        const board = await store.getLeaderboard(5);
        if (board.length > 0) {
          let rankOutput = `## Agent Rankings (Top ${board.length})\n\n`;
          for (const agent of board) {
            rankOutput += `  [${agent.rank}] ${agent.agentId} - score: ${agent.score}/1000 (${(agent.components.successRate * 100).toFixed(0)}% success)\n`;
          }
          sections.push(rankOutput);
          recommendations.push(`Top agent: ${board[0].agentId} (${board[0].rank})`);
          onProgress?.(`  -> ${board.length} agents ranked\n`);
        } else {
          sections.push('## Agent Rankings\n\nNo agents ranked yet.');
          onProgress?.('  -> No agents ranked yet\n');
        }
      } catch {
        sections.push('## Agent Rankings\n\nRanking data unavailable.');
        onProgress?.('  -> Ranking data unavailable\n');
      }
    } else {
      onProgress?.('[5/6] Skipped (agent rankings disabled)\n');
    }

    // Step 6: Ambient insights
    if (includeAmbientLearning) {
      onProgress?.('[6/6] Gathering learned patterns...\n');
      try {
        const learner = getAmbientLearner();
        if (!learner.isConnected()) await learner.connect();

        const insights = await learner.getInsights(10);
        let ambientOutput = `## Ambient Learning Insights\n\n`;

        if (insights.commonSequences.length > 0) {
          ambientOutput += `### Common Tool Sequences\n`;
          for (const seq of insights.commonSequences.slice(0, 5)) {
            ambientOutput += `  ${seq.sequence.join(' -> ')} (${seq.frequency}x, ${(seq.successRate * 100).toFixed(0)}% success)\n`;
          }
          ambientOutput += '\n';
        }

        if (insights.fileRelationships.length > 0) {
          ambientOutput += `### Related Files (often edited together)\n`;
          for (const rel of insights.fileRelationships.slice(0, 5)) {
            ambientOutput += `  ${rel.files.join(' <-> ')} (${rel.frequency}x, ${rel.type})\n`;
          }
          ambientOutput += '\n';
        }

        if (insights.peakHours.length > 0) {
          ambientOutput += `### Peak Activity Hours: ${insights.peakHours.map((h) => `${h}:00`).join(', ')}\n`;
        }

        sections.push(ambientOutput);
        onProgress?.(`  -> ${insights.commonSequences.length} patterns found\n`);
      } catch {
        sections.push('## Ambient Learning Insights\n\nNo ambient data available yet.');
        onProgress?.('  -> No ambient data available\n');
      }
    } else {
      onProgress?.('[6/6] Skipped (ambient learning disabled)\n');
    }

    // Build final output
    onProgress?.('\n=== Recovery Complete ===\n');

    let output = `# Session Recovery Package\n\n`;

    if (recommendations.length > 0) {
      output += `## Recommendations\n`;
      for (const rec of recommendations) {
        output += `  - ${rec}\n`;
      }
      output += '\n';
    }

    output += sections.join('\n\n');

    return output;
  },
};
