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
 * Ambient Learner
 *
 * Silently gathers knowledge from every tool execution to build
 * project-level insights without explicit user intervention.
 * All data persists permanently (no TTL) at the project level.
 *
 * Knowledge categories:
 * 1. Tool sequence patterns (A -> B -> C common sequences)
 * 2. File relationship graphs (files edited together)
 * 3. Time-of-day patterns
 * 4. Agent effectiveness per task type
 *
 * @module cognition/ambient-learner
 */

import { createHash } from 'crypto';
import { RedisBackedService } from '../infrastructure/redis/redis-backed-service.js';

/** A detected tool sequence pattern */
export interface ToolSequencePattern {
  sequence: string[];
  frequency: number;
  successRate: number;
  lastSeen: number;
}

/** A detected file co-edit relationship */
export interface FileRelationship {
  fileA: string;
  fileB: string;
  coEditFrequency: number;
  avgTimeBetween: number;
  relationshipType: 'test-impl' | 'config-code' | 'sibling' | 'import' | 'unknown';
}

/** Time-of-day activity pattern */
export interface TimeOfDayPattern {
  hourOfDay: number;
  toolPatterns: Record<string, number>;
  totalCalls: number;
  successRate: number;
}

/** Agent effectiveness for a task type */
export interface AgentEffectiveness {
  agentId: string;
  taskType: string;
  successRate: number;
  avgDuration: number;
  sampleSize: number;
}

/** Aggregated ambient insights */
export interface AmbientInsights {
  commonSequences: Array<{ sequence: string[]; frequency: number; successRate: number }>;
  fileRelationships: Array<{ files: string[]; frequency: number; type: string }>;
  peakHours: number[];
  topAgents: Array<{ agentId: string; taskType: string; successRate: number }>;
}

/** Redis key prefix */
const PREFIX = 'mcp:ambient:';

/**
 * Ambient Learner Service.
 */
export class AmbientLearner extends RedisBackedService {
  protected get serviceName(): string {
    return 'AmbientLearner';
  }

  // In-memory buffers for sequence and file tracking
  private recentTools: Map<string, Array<{ tool: string; ts: number }>> = new Map();
  private recentFiles: Map<string, Array<{ file: string; ts: number }>> = new Map();

  /**
   * Process a tool execution for ambient learning.
   * Called from RL middleware — fire-and-forget.
   */
  async processToolExecution(
    toolName: string,
    args: Record<string, unknown>,
    success: boolean,
    durationMs: number,
    sessionId: string,
    agentId: string
  ): Promise<void> {
    if (!this.isConnected() || !this.redis) return;

    const projectHash = this.getProjectHash();

    // Run all learners in parallel (non-blocking)
    await Promise.allSettled([
      this.learnToolSequence(projectHash, sessionId, toolName, success),
      this.learnFileRelationships(projectHash, sessionId, args),
      this.learnTimePattern(projectHash, toolName, success),
      this.learnAgentEffectiveness(projectHash, agentId, toolName, success, durationMs),
    ]);
  }

  /**
   * Get aggregated insights for a project.
   */
  async getInsights(limit: number = 20): Promise<AmbientInsights> {
    if (!this.isConnected() || !this.redis) {
      return { commonSequences: [], fileRelationships: [], peakHours: [], topAgents: [] };
    }

    const projectHash = this.getProjectHash();

    // Sequences
    const seqKey = `${PREFIX}${projectHash}:sequences`;
    const seqData = await this.redis.hgetall(seqKey);
    const sequences = Object.values(seqData)
      .map((v) => JSON.parse(v) as ToolSequencePattern)
      .sort((a, b) => b.frequency - a.frequency)
      .slice(0, limit)
      .map((p) => ({
        sequence: p.sequence,
        frequency: p.frequency,
        successRate: p.successRate,
      }));

    // File relationships
    const fileKey = `${PREFIX}${projectHash}:file-relations`;
    const fileData = await this.redis.hgetall(fileKey);
    const fileRels = Object.values(fileData)
      .map((v) => JSON.parse(v) as FileRelationship)
      .sort((a, b) => b.coEditFrequency - a.coEditFrequency)
      .slice(0, limit)
      .map((r) => ({
        files: [r.fileA, r.fileB],
        frequency: r.coEditFrequency,
        type: r.relationshipType,
      }));

    // Time patterns
    const timeKey = `${PREFIX}${projectHash}:time-patterns`;
    const timeData = await this.redis.hgetall(timeKey);
    const timePatterns = Object.values(timeData)
      .map((v) => JSON.parse(v) as TimeOfDayPattern)
      .sort((a, b) => b.totalCalls - a.totalCalls);
    const peakHours = timePatterns.slice(0, 5).map((t) => t.hourOfDay);

    // Agent effectiveness
    const agentKey = `${PREFIX}${projectHash}:agent-effectiveness`;
    const agentData = await this.redis.hgetall(agentKey);
    const topAgents = Object.values(agentData)
      .map((v) => JSON.parse(v) as AgentEffectiveness)
      .filter((a) => a.sampleSize >= 3)
      .sort((a, b) => b.successRate - a.successRate)
      .slice(0, limit)
      .map((a) => ({
        agentId: a.agentId,
        taskType: a.taskType,
        successRate: a.successRate,
      }));

    return { commonSequences: sequences, fileRelationships: fileRels, peakHours, topAgents };
  }

  // --- Private learners ---

  private async learnToolSequence(
    projectHash: string,
    sessionId: string,
    toolName: string,
    success: boolean
  ): Promise<void> {
    const bufferKey = `${projectHash}:${sessionId}`;
    const sequence = this.recentTools.get(bufferKey) || [];
    sequence.push({ tool: toolName, ts: Date.now() });

    // Keep last 10
    if (sequence.length > 10) sequence.shift();
    this.recentTools.set(bufferKey, sequence);

    if (sequence.length < 3) return;

    // Record patterns of length 3-5
    const redisKey = `${PREFIX}${projectHash}:sequences`;
    for (let len = 3; len <= Math.min(5, sequence.length); len++) {
      const tools = sequence.slice(-len).map((s) => s.tool);
      const patternKey = tools.join(' -> ');

      const existing = await this.redis!.hget(redisKey, patternKey);
      let pattern: ToolSequencePattern;

      if (existing) {
        pattern = JSON.parse(existing);
        const oldTotal = pattern.frequency;
        pattern.frequency++;
        pattern.successRate = (pattern.successRate * oldTotal + (success ? 1 : 0)) / pattern.frequency;
        pattern.lastSeen = Date.now();
      } else {
        pattern = {
          sequence: tools,
          frequency: 1,
          successRate: success ? 1 : 0,
          lastSeen: Date.now(),
        };
      }

      await this.redis!.hset(redisKey, patternKey, JSON.stringify(pattern));
    }
  }

  private async learnFileRelationships(
    projectHash: string,
    sessionId: string,
    args: Record<string, unknown>
  ): Promise<void> {
    const files = this.extractFiles(args);
    if (files.length === 0) return;

    const bufferKey = `${projectHash}:${sessionId}`;
    const edits = this.recentFiles.get(bufferKey) || [];
    for (const file of files) {
      edits.push({ file, ts: Date.now() });
    }
    if (edits.length > 20) edits.splice(0, edits.length - 20);
    this.recentFiles.set(bufferKey, edits);

    // Correlate files edited within 5 minutes
    const fiveMin = 5 * 60 * 1000;
    const cutoff = Date.now() - fiveMin;
    const recent = edits.filter((e) => e.ts > cutoff);

    const redisKey = `${PREFIX}${projectHash}:file-relations`;
    for (let i = 0; i < recent.length - 1; i++) {
      for (let j = i + 1; j < recent.length; j++) {
        if (recent[i].file === recent[j].file) continue;

        const [f1, f2] = [recent[i].file, recent[j].file].sort();
        const relKey = `${f1} <> ${f2}`;
        const timeBetween = Math.abs(recent[j].ts - recent[i].ts);

        const existing = await this.redis!.hget(redisKey, relKey);
        let rel: FileRelationship;

        if (existing) {
          rel = JSON.parse(existing);
          const oldCount = rel.coEditFrequency;
          rel.coEditFrequency++;
          rel.avgTimeBetween = (rel.avgTimeBetween * oldCount + timeBetween) / rel.coEditFrequency;
        } else {
          rel = {
            fileA: f1,
            fileB: f2,
            coEditFrequency: 1,
            avgTimeBetween: timeBetween,
            relationshipType: this.detectRelType(f1, f2),
          };
        }

        await this.redis!.hset(redisKey, relKey, JSON.stringify(rel));
      }
    }
  }

  private async learnTimePattern(
    projectHash: string,
    toolName: string,
    success: boolean
  ): Promise<void> {
    const hour = new Date().getHours();
    const redisKey = `${PREFIX}${projectHash}:time-patterns`;

    const existing = await this.redis!.hget(redisKey, hour.toString());
    let pattern: TimeOfDayPattern;

    if (existing) {
      pattern = JSON.parse(existing);
      pattern.toolPatterns[toolName] = (pattern.toolPatterns[toolName] || 0) + 1;
      pattern.totalCalls++;
      const oldSuccessCount = pattern.successRate * (pattern.totalCalls - 1);
      pattern.successRate = (oldSuccessCount + (success ? 1 : 0)) / pattern.totalCalls;
    } else {
      pattern = {
        hourOfDay: hour,
        toolPatterns: { [toolName]: 1 },
        totalCalls: 1,
        successRate: success ? 1 : 0,
      };
    }

    await this.redis!.hset(redisKey, hour.toString(), JSON.stringify(pattern));
  }

  private async learnAgentEffectiveness(
    projectHash: string,
    agentId: string,
    toolName: string,
    success: boolean,
    durationMs: number
  ): Promise<void> {
    const taskType = this.inferTaskType(toolName);
    const effectKey = `${agentId}::${taskType}`;
    const redisKey = `${PREFIX}${projectHash}:agent-effectiveness`;

    const existing = await this.redis!.hget(redisKey, effectKey);
    let eff: AgentEffectiveness;

    if (existing) {
      eff = JSON.parse(existing);
      const oldSize = eff.sampleSize;
      eff.sampleSize++;
      eff.successRate = (eff.successRate * oldSize + (success ? 1 : 0)) / eff.sampleSize;
      eff.avgDuration = (eff.avgDuration * oldSize + durationMs) / eff.sampleSize;
    } else {
      eff = {
        agentId,
        taskType,
        successRate: success ? 1 : 0,
        avgDuration: durationMs,
        sampleSize: 1,
      };
    }

    await this.redis!.hset(redisKey, effectKey, JSON.stringify(eff));
  }

  // --- Helpers ---

  private getProjectHash(): string {
    return createHash('sha256').update(process.cwd()).digest('hex').substring(0, 16);
  }

  private extractFiles(args: Record<string, unknown>): string[] {
    const files: string[] = [];
    const keys = ['file', 'files', 'path', 'filePath', 'source', 'target'];
    for (const key of keys) {
      const val = args[key];
      if (typeof val === 'string' && val.length > 0) {
        // Handle @path syntax and space-separated lists
        const parts = val.split(/\s+/).map((p) => p.replace(/^@/, ''));
        files.push(...parts.filter((p) => p.length > 0));
      } else if (Array.isArray(val)) {
        files.push(...val.filter((v): v is string => typeof v === 'string'));
      }
    }
    return files;
  }

  private detectRelType(a: string, b: string): FileRelationship['relationshipType'] {
    if (a.includes('.test.') || a.includes('.spec.') || b.includes('.test.') || b.includes('.spec.'))
      return 'test-impl';
    if (a.includes('config') || b.includes('config')) return 'config-code';

    const dirA = a.split('/').slice(0, -1).join('/');
    const dirB = b.split('/').slice(0, -1).join('/');
    if (dirA === dirB) return 'sibling';

    return 'unknown';
  }

  private inferTaskType(toolName: string): string {
    const map: Record<string, string> = {
      'find-definition': 'exploration',
      'find-references': 'exploration',
      'semantic-search': 'exploration',
      'error-pattern': 'debugging',
      'decision-journal': 'planning',
      'thinking-chain': 'reasoning',
      'self-critique': 'review',
      'context-budget': 'optimization',
    };
    return map[toolName] || 'general';
  }
}

// --- Singleton ---

let instance: AmbientLearner | null = null;

export function getAmbientLearner(): AmbientLearner {
  if (!instance) {
    instance = new AmbientLearner();
  }
  return instance;
}
