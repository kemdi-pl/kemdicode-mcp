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
 * Loci Recall Tool
 *
 * Walk the memory palace, recall memories, view timeline events,
 * resurrect context after compaction, and link sessions.
 */

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { getLociManager, LOCI_TEMPLATES } from '../../loci/index.js';
import { getTimelineRecorder } from '../../loci/timeline-recorder.js';
import { getCompactionEngine } from '../../loci/compaction-engine.js';
import type { CompactionLevel } from '../../loci/types.js';
import { getAmbientLearner } from '../../cognition/ambient-learner.js';

const schema = z.object({
  action: z.enum(['recall', 'walk', 'resurrect', 'timeline', 'link-session', 'ambient-insights']).default('recall')
    .describe('Action: recall (default), walk (all loci), resurrect (post-compaction), timeline (view events), link-session, ambient-insights'),
  lociId: z.string().optional().describe('Loci ID to recall from (action=recall)'),
  lociName: z.string().optional().describe('Loci name (action=recall)'),
  sessionId: z.string().describe('Session ID'),
  walkAll: z.boolean().default(false).describe('Walk all loci (deprecated, use action=walk)'),
  // Timeline/resurrection params
  projectPath: z.string().optional().describe('Project path (action=resurrect, link-session)'),
  level: z.enum(['L0', 'L1', 'L2', 'L3']).default('L0').describe('Compaction level (action=timeline)'),
  limit: z.number().default(20).describe('Max events/insights to return (action=timeline, ambient-insights)'),
  insightType: z.enum(['sequences', 'file-relations', 'time-patterns', 'agent-effectiveness', 'all']).default('all')
    .describe('Type of ambient insight (action=ambient-insights)'),
  currentGoal: z.string().optional().describe('Current goal for goal-oriented resurrection (action=resurrect)'),
  predecessorSessionId: z.string().optional().describe('Predecessor session (action=link-session)'),
});

export const lociRecallTool: UnifiedTool<typeof schema> = {
  name: 'loci-recall',
  description: 'Recall memories from memory palace, view timeline, resurrect context after compaction, or link sessions.',
  zodSchema: schema,

  metadata: {
    category: 'loci',
    tags: ['recall', 'memory', 'spatial', 'timeline', 'resurrection'],
    examples: [
      { args: { sessionId: 'session-1', action: 'walk' }, description: 'Walk all loci in the memory palace' },
      { args: { sessionId: 'session-1', action: 'recall', lociName: 'entrance-hall' }, description: 'Recall from a specific loci' },
      { args: { sessionId: 'session-1', action: 'resurrect', projectPath: '/opt/project' }, description: 'Resurrect context after compaction' },
      { args: { sessionId: 'session-1', action: 'timeline', level: 'L0', limit: 10 }, description: 'View L0 timeline events' },
      { args: { sessionId: 'session-1', action: 'link-session', projectPath: '/opt/project' }, description: 'Link session to continuity chain' },
    ],
    relatedTools: ['graph-query', 'sequence-recommend'],
  },

  execute: async (args) => {
    const { action, lociId, lociName, sessionId, walkAll } = args;

    // Handle ambient insights
    if (action === 'ambient-insights') {
      return handleAmbientInsights(args.insightType || 'all', args.limit);
    }

    // Handle timeline/resurrection/link-session actions
    if (action === 'resurrect') {
      return handleResurrect(args.projectPath || process.cwd(), args.currentGoal, sessionId);
    }

    if (action === 'timeline') {
      return handleTimeline(sessionId, args.level as CompactionLevel, args.limit);
    }

    if (action === 'link-session') {
      return handleLinkSession(sessionId, args.projectPath || process.cwd(), args.predecessorSessionId);
    }

    // Legacy walkAll support + action=walk
    if (walkAll || action === 'walk') {
      return handleWalk(sessionId);
    }

    // Default: recall from specific loci
    return handleRecall(sessionId, lociId, lociName);
  },
};

async function handleAmbientInsights(insightType: string, limit: number): Promise<string> {
  const learner = getAmbientLearner();
  if (!learner.isConnected()) {
    await learner.connect().catch(() => {});
  }
  if (!learner.isConnected()) {
    return 'Ambient learning unavailable (Redis not connected).';
  }

  const insights = await learner.getInsights(limit);
  const hasData =
    insights.commonSequences.length > 0 ||
    insights.fileRelationships.length > 0 ||
    insights.peakHours.length > 0 ||
    insights.topAgents.length > 0;

  if (!hasData) {
    return 'No ambient insights collected yet. Insights are gathered passively as tools are used.';
  }

  const lines: string[] = ['## Ambient Learning Insights', ''];

  if ((insightType === 'all' || insightType === 'sequences') && insights.commonSequences.length > 0) {
    lines.push('### Tool Sequences (Common Patterns)');
    for (const seq of insights.commonSequences.slice(0, limit)) {
      lines.push(`- ${seq.sequence.join(' -> ')} (freq: ${seq.frequency}, success: ${(seq.successRate * 100).toFixed(0)}%)`);
    }
    lines.push('');
  }

  if ((insightType === 'all' || insightType === 'file-relations') && insights.fileRelationships.length > 0) {
    lines.push('### File Relationships (Co-edited)');
    for (const rel of insights.fileRelationships.slice(0, limit)) {
      lines.push(`- ${rel.files.join(' <-> ')} (${rel.frequency}x, ${rel.type})`);
    }
    lines.push('');
  }

  if ((insightType === 'all' || insightType === 'time-patterns') && insights.peakHours.length > 0) {
    lines.push('### Peak Activity Hours');
    lines.push(`- ${insights.peakHours.map((h) => `${h}:00`).join(', ')}`);
    lines.push('');
  }

  if ((insightType === 'all' || insightType === 'agent-effectiveness') && insights.topAgents.length > 0) {
    lines.push('### Agent Effectiveness');
    for (const ae of insights.topAgents.slice(0, limit)) {
      lines.push(`- ${ae.agentId}: ${ae.taskType} (success: ${(ae.successRate * 100).toFixed(0)}%)`);
    }
    lines.push('');
  }

  return lines.length <= 2 ? 'No ambient insights collected yet.' : lines.join('\n');
}

async function handleResurrect(projectPath: string, currentGoal?: string, sessionId?: string): Promise<string> {
  const engine = getCompactionEngine();
  if (!engine.isConnected()) {
    await engine.connect();
  }

  const context = await engine.generateResurrectionContext(projectPath, currentGoal, sessionId);

  const lines: string[] = [
    '## Resurrection Context',
    '',
  ];

  if (context.continuityChain.length > 0) {
    lines.push('### Session Continuity Chain');
    for (const c of context.continuityChain) {
      const status = c.endedAt ? `ended (${c.endReason || 'unknown'})` : 'active';
      lines.push(`- ${c.sessionId.slice(0, 16)}... [${status}]${c.predecessorSessionId ? ` <- ${c.predecessorSessionId.slice(0, 12)}...` : ''}`);
    }
    lines.push('');
  }

  if (context.keyFacts.length > 0) {
    lines.push('### Key Facts (Permanent)');
    for (const fact of context.keyFacts) {
      lines.push(`- ${fact}`);
    }
    lines.push('');
  }

  if (context.recentSummaries.length > 0) {
    lines.push('### Recent Activity');
    for (const summary of context.recentSummaries.slice(0, 10)) {
      lines.push(`- ${summary}`);
    }
    lines.push('');
  }

  if (context.activeFiles.length > 0) {
    lines.push('### Active Files');
    for (const file of context.activeFiles.slice(0, 10)) {
      lines.push(`- ${file}`);
    }
    lines.push('');
  }

  if (context.unresolvedErrors && context.unresolvedErrors.length > 0) {
    lines.push('### Unresolved Errors');
    for (const err of context.unresolvedErrors) {
      lines.push(`- ${err}`);
    }
    lines.push('');
  }

  if (context.graphInsights && context.graphInsights.length > 0) {
    lines.push('### Graph Insights (A* Search)');
    for (const insight of context.graphInsights) {
      lines.push(`- ${insight}`);
    }
    lines.push('');
  }

  if (context.lociAssociations && context.lociAssociations.length > 0) {
    lines.push('### Memory Palace');
    for (const assoc of context.lociAssociations) {
      lines.push(`- ${assoc}`);
    }
    lines.push('');
  }

  if (context.toolPatterns && context.toolPatterns.length > 0) {
    lines.push('### Learned Tool Patterns');
    for (const pattern of context.toolPatterns) {
      lines.push(`- ${pattern}`);
    }
    lines.push('');
  }

  if (context.suggestedActions.length > 0) {
    lines.push('### Suggested Actions');
    for (const action of context.suggestedActions) {
      lines.push(`- ${action}`);
    }
  }

  if (lines.length <= 2) {
    lines.push('No prior context found for this project. This may be a fresh session.');
  }

  return lines.join('\n');
}

async function handleTimeline(sessionId: string, level: CompactionLevel, limit: number): Promise<string> {
  const recorder = getTimelineRecorder();
  if (!recorder.isConnected()) {
    await recorder.connect();
  }

  const events = await recorder.getEvents(sessionId, level, limit);
  const count = await recorder.countEvents(sessionId, level);

  if (events.length === 0) {
    return `No ${level} events found for session ${sessionId}.`;
  }

  const lines: string[] = [
    `## Timeline: ${level} Events (${events.length}/${count} total)`,
    '',
  ];

  for (const event of events) {
    const time = new Date(event.timestamp).toISOString().slice(11, 19);
    const status = event.success === false ? ' [FAIL]' : '';
    lines.push(`- [${time}] ${event.summary}${status}`);
  }

  return lines.join('\n');
}

async function handleLinkSession(sessionId: string, projectPath: string, predecessorSessionId?: string): Promise<string> {
  const recorder = getTimelineRecorder();
  if (!recorder.isConnected()) {
    await recorder.connect();
  }

  const continuity = await recorder.linkSession(sessionId, projectPath, predecessorSessionId);

  const lines: string[] = [
    '## Session Linked',
    '',
    `- Session: ${continuity.sessionId}`,
    `- Project: ${continuity.projectPath}`,
  ];

  if (continuity.predecessorSessionId) {
    lines.push(`- Predecessor: ${continuity.predecessorSessionId}`);
  } else {
    lines.push('- Predecessor: none (first session for this project)');
  }

  return lines.join('\n');
}

async function handleWalk(sessionId: string): Promise<string> {
  const manager = getLociManager();
  if (!manager.isConnected()) {
    await manager.connect();
  }

  const recalls = await manager.walkPalace(sessionId);

  if (recalls.length === 0) {
    return `No loci found in session ${sessionId}. Create loci first with loci-create.`;
  }

  const lines: string[] = [
    '## Memory Palace Walk',
    `Session: ${sessionId} | ${recalls.length} locations`,
    '',
  ];

  for (const recall of recalls) {
    const icon = recall.loci.icon || '';
    lines.push(`### ${icon} ${recall.loci.name}`);
    lines.push(`${recall.loci.description}`);
    lines.push(`Memories: ${recall.nodes.length}`);

    if (recall.associationsTriggered.length > 0) {
      lines.push(`Association: ${recall.associationsTriggered[0]}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

async function handleRecall(sessionId: string, lociId?: string, lociName?: string): Promise<string> {
  const manager = getLociManager();
  if (!manager.isConnected()) {
    await manager.connect();
  }

  let targetLociId = lociId;

  if (!targetLociId && lociName) {
    const loci = await manager.getLociByName(lociName);
    if (loci) {
      targetLociId = loci.id;
    } else {
      return `Loci not found: ${lociName}`;
    }
  }

  if (!targetLociId) {
    const lociList = await manager.getSessionLoci(sessionId);

    if (lociList.length === 0) {
      const templateList = Object.entries(LOCI_TEMPLATES)
        .map(([key, t]) => `  ${t.icon} ${key}: ${t.name}`)
        .join('\n');

      return [
        `No loci found in session ${sessionId}.`,
        '',
        'Create loci using templates:',
        templateList,
        '',
        'Or create custom loci with loci-create.',
      ].join('\n');
    }

    const lines: string[] = ['## Available Loci', ''];
    for (const loci of lociList) {
      const icon = loci.icon || '';
      lines.push(`- ${icon} ${loci.name} [${loci.nodeIds.length} memories] (ID: ${loci.id})`);
    }
    lines.push('', 'Specify lociId or lociName to recall from a specific location.');
    return lines.join('\n');
  }

  const recall = await manager.recall(targetLociId);
  if (!recall) {
    return `Loci not found: ${targetLociId}`;
  }

  const lines: string[] = [
    `## Recalling from: ${recall.loci.icon || ''} ${recall.loci.name}`,
    recall.loci.description,
    '',
  ];

  if (recall.associationsTriggered.length > 0) {
    lines.push('### Associations');
    for (const assoc of recall.associationsTriggered.slice(0, 5)) {
      lines.push(`- ${assoc}`);
    }
    lines.push('');
  }

  const typeIcons: Record<string, string> = {
    file: 'file', error: 'ERROR', solution: 'FIX', tool: 'tool',
    concept: 'concept', context: 'context', pattern: 'pattern',
  };

  lines.push(`### Memories (${recall.nodes.length} nodes)`);
  for (const node of recall.nodes.slice(0, 10)) {
    lines.push(`- [${typeIcons[node.type] || node.type}] ${node.label}`);
  }
  if (recall.nodes.length > 10) {
    lines.push(`- ... and ${recall.nodes.length - 10} more`);
  }

  if (recall.connectedMemories.length > 0) {
    lines.push('', `### Connected Memories (${recall.connectedMemories.length})`);
    for (const node of recall.connectedMemories.slice(0, 5)) {
      lines.push(`- [${typeIcons[node.type] || node.type}] ${node.label}`);
    }
  }

  if (recall.suggestedNext.length > 0) {
    lines.push('', '### Suggested Next');
    for (const next of recall.suggestedNext.slice(0, 3)) {
      lines.push(`- ${next.icon || ''} ${next.name}`);
    }
  }

  return lines.join('\n');
}
