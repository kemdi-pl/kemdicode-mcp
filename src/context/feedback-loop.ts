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
 * Feedback Loop System
 *
 * Tracks suggestions made by the AI and detects whether they were applied.
 * Provides learning feedback for better future suggestions.
 */

import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { Logger } from '../utils/logger.js';
import { getContextStorage } from './storage.js';

export interface Suggestion {
  id: string;
  timestamp: number;
  toolName: string;
  filePath: string;
  suggestionType: 'fix' | 'refactor' | 'feature' | 'review' | 'test';
  description: string;
  codeSnippet?: string;
  originalHash?: string; // Hash of file before suggestion
  applied?: boolean;
  appliedAt?: number;
  feedback?: 'helpful' | 'not_helpful' | 'partial';
}

export interface FeedbackStats {
  totalSuggestions: number;
  applied: number;
  notApplied: number;
  pending: number;
  applicationRate: number;
  byType: Record<string, { total: number; applied: number }>;
  byTool: Record<string, { total: number; applied: number }>;
}

const SUGGESTIONS_KEY = 'kemdicode:suggestions';
const MAX_SUGGESTIONS = 100; // Keep last 100 suggestions

/**
 * Generate a hash of file content for comparison
 */
function hashFile(filePath: string): string | null {
  try {
    if (!existsSync(filePath)) return null;
    const content = readFileSync(filePath, 'utf-8');
    return createHash('md5').update(content).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Record a new suggestion
 */
export async function recordSuggestion(
  toolName: string,
  filePath: string,
  suggestionType: Suggestion['suggestionType'],
  description: string,
  codeSnippet?: string
): Promise<string> {
  const storage = getContextStorage();
  if (!storage) {
    Logger.warn('Feedback loop: storage not available');
    return '';
  }

  const suggestion: Suggestion = {
    id: `sug_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    toolName,
    filePath,
    suggestionType,
    description,
    codeSnippet,
    originalHash: hashFile(filePath) || undefined,
    applied: false,
  };

  try {
    // Get existing suggestions
    const existing = await storage.get(SUGGESTIONS_KEY);
    const suggestions: Suggestion[] = existing ? JSON.parse(existing) : [];

    // Add new suggestion
    suggestions.unshift(suggestion);

    // Keep only last N suggestions
    if (suggestions.length > MAX_SUGGESTIONS) {
      suggestions.length = MAX_SUGGESTIONS;
    }

    await storage.set(SUGGESTIONS_KEY, JSON.stringify(suggestions));
    Logger.debug(`Recorded suggestion: ${suggestion.id} for ${filePath}`);

    return suggestion.id;
  } catch (error) {
    Logger.error('Failed to record suggestion:', error);
    return '';
  }
}

/**
 * Check if suggestions were applied by comparing file hashes
 */
export async function checkAppliedSuggestions(): Promise<{
  newlyApplied: Suggestion[];
  stillPending: Suggestion[];
}> {
  const storage = getContextStorage();
  if (!storage) return { newlyApplied: [], stillPending: [] };

  try {
    const existing = await storage.get(SUGGESTIONS_KEY);
    if (!existing) return { newlyApplied: [], stillPending: [] };

    const suggestions: Suggestion[] = JSON.parse(existing);
    const newlyApplied: Suggestion[] = [];
    const stillPending: Suggestion[] = [];

    for (const suggestion of suggestions) {
      if (suggestion.applied) continue;

      const currentHash = hashFile(suggestion.filePath);

      // File was modified since suggestion
      if (currentHash && suggestion.originalHash && currentHash !== suggestion.originalHash) {
        suggestion.applied = true;
        suggestion.appliedAt = Date.now();
        newlyApplied.push(suggestion);
      } else if (!suggestion.applied) {
        stillPending.push(suggestion);
      }
    }

    // Save updated suggestions
    if (newlyApplied.length > 0) {
      await storage.set(SUGGESTIONS_KEY, JSON.stringify(suggestions));
      Logger.debug(`Detected ${newlyApplied.length} applied suggestions`);
    }

    return { newlyApplied, stillPending };
  } catch (error) {
    Logger.error('Failed to check applied suggestions:', error);
    return { newlyApplied: [], stillPending: [] };
  }
}

/**
 * Get feedback statistics
 */
export async function getFeedbackStats(): Promise<FeedbackStats> {
  const storage = getContextStorage();
  if (!storage) {
    return {
      totalSuggestions: 0,
      applied: 0,
      notApplied: 0,
      pending: 0,
      applicationRate: 0,
      byType: {},
      byTool: {},
    };
  }

  try {
    const existing = await storage.get(SUGGESTIONS_KEY);
    if (!existing) {
      return {
        totalSuggestions: 0,
        applied: 0,
        notApplied: 0,
        pending: 0,
        applicationRate: 0,
        byType: {},
        byTool: {},
      };
    }

    const suggestions: Suggestion[] = JSON.parse(existing);
    const stats: FeedbackStats = {
      totalSuggestions: suggestions.length,
      applied: 0,
      notApplied: 0,
      pending: 0,
      applicationRate: 0,
      byType: {},
      byTool: {},
    };

    const now = Date.now();
    const OLD_THRESHOLD = 24 * 60 * 60 * 1000; // 24 hours

    for (const suggestion of suggestions) {
      // Initialize type stats
      if (!stats.byType[suggestion.suggestionType]) {
        stats.byType[suggestion.suggestionType] = { total: 0, applied: 0 };
      }
      stats.byType[suggestion.suggestionType].total++;

      // Initialize tool stats
      if (!stats.byTool[suggestion.toolName]) {
        stats.byTool[suggestion.toolName] = { total: 0, applied: 0 };
      }
      stats.byTool[suggestion.toolName].total++;

      if (suggestion.applied) {
        stats.applied++;
        stats.byType[suggestion.suggestionType].applied++;
        stats.byTool[suggestion.toolName].applied++;
      } else if (now - suggestion.timestamp > OLD_THRESHOLD) {
        // Old and not applied = probably not helpful
        stats.notApplied++;
      } else {
        stats.pending++;
      }
    }

    stats.applicationRate =
      stats.totalSuggestions > 0
        ? Math.round((stats.applied / (stats.applied + stats.notApplied || 1)) * 100)
        : 0;

    return stats;
  } catch (error) {
    Logger.error('Failed to get feedback stats:', error);
    return {
      totalSuggestions: 0,
      applied: 0,
      notApplied: 0,
      pending: 0,
      applicationRate: 0,
      byType: {},
      byTool: {},
    };
  }
}

/**
 * Get recent suggestions for a file
 */
export async function getSuggestionsForFile(filePath: string): Promise<Suggestion[]> {
  const storage = getContextStorage();
  if (!storage) return [];

  try {
    const existing = await storage.get(SUGGESTIONS_KEY);
    if (!existing) return [];

    const suggestions: Suggestion[] = JSON.parse(existing);
    return suggestions.filter((s) => s.filePath === filePath);
  } catch {
    return [];
  }
}

/**
 * Provide manual feedback on a suggestion
 */
export async function provideFeedback(
  suggestionId: string,
  feedback: 'helpful' | 'not_helpful' | 'partial'
): Promise<boolean> {
  const storage = getContextStorage();
  if (!storage) return false;

  try {
    const existing = await storage.get(SUGGESTIONS_KEY);
    if (!existing) return false;

    const suggestions: Suggestion[] = JSON.parse(existing);
    const suggestion = suggestions.find((s) => s.id === suggestionId);

    if (suggestion) {
      suggestion.feedback = feedback;
      await storage.set(SUGGESTIONS_KEY, JSON.stringify(suggestions));
      Logger.debug(`Feedback recorded for ${suggestionId}: ${feedback}`);
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Get learning insights from feedback data
 */
export async function getLearningInsights(): Promise<string[]> {
  const stats = await getFeedbackStats();
  const insights: string[] = [];

  if (stats.totalSuggestions === 0) {
    return ['No suggestions recorded yet. Start using tools to build feedback history.'];
  }

  // Overall effectiveness
  if (stats.applicationRate >= 70) {
    insights.push(
      `✅ High effectiveness: ${stats.applicationRate}% of suggestions are being applied.`
    );
  } else if (stats.applicationRate >= 40) {
    insights.push(
      `⚠️ Moderate effectiveness: ${stats.applicationRate}% application rate. Consider more targeted suggestions.`
    );
  } else {
    insights.push(
      `❌ Low effectiveness: Only ${stats.applicationRate}% of suggestions applied. Review suggestion quality.`
    );
  }

  // Best performing tools
  const toolEffectiveness = Object.entries(stats.byTool)
    .map(([tool, data]) => ({
      tool,
      rate: data.total > 0 ? (data.applied / data.total) * 100 : 0,
      total: data.total,
    }))
    .filter((t) => t.total >= 3) // At least 3 suggestions
    .sort((a, b) => b.rate - a.rate);

  if (toolEffectiveness.length > 0) {
    const best = toolEffectiveness[0];
    insights.push(`🏆 Most effective tool: ${best.tool} (${Math.round(best.rate)}% applied)`);

    if (toolEffectiveness.length > 1) {
      const worst = toolEffectiveness[toolEffectiveness.length - 1];
      if (worst.rate < 50) {
        insights.push(`📉 Needs improvement: ${worst.tool} (${Math.round(worst.rate)}% applied)`);
      }
    }
  }

  // Suggestion type analysis
  const typeEffectiveness = Object.entries(stats.byType)
    .map(([type, data]) => ({
      type,
      rate: data.total > 0 ? (data.applied / data.total) * 100 : 0,
      total: data.total,
    }))
    .filter((t) => t.total >= 2)
    .sort((a, b) => b.rate - a.rate);

  if (typeEffectiveness.length > 0) {
    const bestType = typeEffectiveness[0];
    insights.push(
      `📊 Best suggestion type: ${bestType.type} (${Math.round(bestType.rate)}% success)`
    );
  }

  return insights;
}
