/**
 * KemdiCode MCP Server
 * Copyright (C) 2025-2026 Kemdi Sp. z o.o.
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

import { z } from 'zod';
import { existsSync, readFileSync } from 'fs';
import { UnifiedTool } from '../registry.js';
import { executeAI, parseFiles } from '../../ai/index.js';
import {
  getEnhancedContextString,
  getCurrentProjectRoot,
} from '../../utils/projectContext.enhanced.js';
import { detectLanguage, detectLanguageFromExtension } from '../../utils/languageDetection.js';
import { recordSuggestion } from '../../context/feedback-loop.js';

const FOCUS_PROMPTS: Record<string, string> = {
  security: `**FOCUS: SECURITY** - SQL Injection, XSS, CSRF, auth bypass, hardcoded secrets, OWASP Top 10`,
  performance: `**FOCUS: PERFORMANCE** - N+1 queries, missing cache, inefficient loops, memory leaks`,
  quality: `**FOCUS: QUALITY** - SOLID violations, duplication, complex methods, missing error handling`,
  all: `**COMPREHENSIVE** - Security + Performance + Quality + Best Practices`,
};

const schema = z.object({
  files: z.string().describe('Files to review (@path/file syntax)'),
  focus: z.enum(['security', 'performance', 'quality', 'all']).default('all'),
  severity: z.enum(['critical', 'all']).default('all').describe('critical = urgent issues only'),
  concise: z.boolean().default(false).describe('Short descriptions only'),
  withDeps: z.boolean().default(false).describe('Analyze imports and DI'),
  continueSession: z.boolean().default(false).describe('Continue last session'),
});

/**
 * Extract the first file path from files string
 */
function extractFirstFile(filesStr: string): string | null {
  // Match @path/to/file.ext pattern
  const match = filesStr.match(/@([^\s@]+)/);
  if (match) {
    return match[1];
  }
  // Try plain path
  const parts = filesStr.trim().split(/\s+/);
  return parts[0]?.replace('@', '') || null;
}

/**
 * Detect language from files - uses extension first, then ML for content
 */
async function detectLanguageFromFiles(filesStr: string): Promise<string> {
  const firstFile = extractFirstFile(filesStr);
  if (!firstFile) return 'text';

  // Try extension-based detection first (fast)
  const extResult = detectLanguageFromExtension(firstFile);
  if (extResult) {
    return extResult.syntaxHighlight;
  }

  // Try reading file content for ML detection
  const projectRoot = getCurrentProjectRoot();
  const fullPath = firstFile.startsWith('/') ? firstFile : `${projectRoot}/${firstFile}`;

  if (existsSync(fullPath)) {
    try {
      const content = readFileSync(fullPath, 'utf-8').slice(0, 10000); // First 10KB
      const result = await detectLanguage(firstFile, content);
      return result.syntaxHighlight;
    } catch {
      // Ignore read errors
    }
  }

  return 'text';
}

export const codeReviewTool: UnifiedTool = {
  name: 'code-review',
  description: 'Security/performance/quality code review with optional dependency analysis',
  zodSchema: schema,
  prompt: { description: 'Code review for source files' },
  metadata: { category: 'specialized', tags: ['review', 'security', 'quality'], longRunning: true },
  execute: async (args, onProgress) => {
    const { files, focus = 'all', severity = 'all', concise, withDeps, continueSession } = args;
    if (!files?.toString().trim()) throw new Error('Files required. Use @path/file syntax.');

    const filesStr = String(files);

    // Auto-detect language using ML or extension
    const codeBlockLang = await detectLanguageFromFiles(filesStr);

    const prompt = `${getEnhancedContextString()}
# Code Review Request

${FOCUS_PROMPTS[focus as string]}
${severity === 'critical' ? '\n**CRITICAL ONLY** - Report only issues requiring immediate fix.' : ''}
${concise ? '\n**CONCISE MODE** - Short descriptions, direct fixes only.' : ''}
${withDeps ? '\n**WITH DEPENDENCIES** - Analyze imported modules and their usage.' : ''}

## Files
${filesStr}

## Output Format
### [SEVERITY] Issue Title
**File:** \`path:LINE\`
**Category:** Security|Performance|Quality
**Problem:** Brief description
**Fix:**
\`\`\`${codeBlockLang}
// suggested fix
\`\`\`

---

## Summary
- Critical: X | Warning: Y | Info: Z

## Priority Actions
1. [action 1]
2. [action 2]

Begin review:`;

    onProgress?.(`Code review (${focus}) for: ${filesStr}`);

    const result = await executeAI({
      prompt,
      agent: 'plan',
      files: parseFiles(filesStr),
      continueSession: Boolean(continueSession),
      onProgress,
    });

    // Record suggestions for feedback tracking
    const parsedFiles = parseFiles(filesStr);
    for (const file of parsedFiles) {
      recordSuggestion(
        'code-review',
        file,
        'review',
        `Code review (${focus}) - ${severity === 'critical' ? 'critical issues' : 'all issues'}`,
        result.slice(0, 500) // First 500 chars as snippet
      ).catch(() => {
        /* ignore errors */
      });
    }

    return result;
  },
};
