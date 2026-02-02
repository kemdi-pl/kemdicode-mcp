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

import { z } from 'zod';
import { promises as fs } from 'fs';
import * as path from 'path';
import { UnifiedTool } from '../registry.js';
import { executeAI, parseFiles, type AgentType } from '../../ai/index.js';
import { getEnhancedContextString } from '../../utils/projectContext.enhanced.js';
import { Logger } from '../../utils/logger.js';
import { validatePath } from '../../utils/validation.js';
import { recordSuggestion } from '../../context/feedback-loop.js';
import { isSilent } from '../../config/silent.js';

const FOCUS_MAP: Record<string, string> = {
  security: 'SECURITY: SQL injection, XSS, CSRF, auth bypass, hardcoded secrets',
  performance: 'PERFORMANCE: N+1 queries, missing cache, inefficient loops, memory leaks',
  quality: 'QUALITY: SOLID violations, code duplication, missing error handling, magic values',
  all: 'ALL: Security + Performance + Quality + Best practices',
};

const schema = z.object({
  files: z.string().describe('Files to fix. Use @path/file syntax for multiple files, or plain paths separated by spaces'),
  focus: z.enum(['security', 'performance', 'quality', 'all']).default('all'),
  severity: z
    .enum(['critical', 'all'])
    .default('critical')
    .describe('critical = urgent fixes only'),
  dryRun: z.boolean().default(false).describe('Preview changes without applying'),
});

interface FixEdit {
  file: string;
  search: string;
  replace: string;
  description: string;
  severity: string;
}

interface FixResult {
  file: string;
  description: string;
  severity: string;
  success: boolean;
  error?: string;
  backup?: string;
}

/**
 * Parse AI response to extract structured edits
 * Expects JSON block with array of edits
 */
function parseAIEdits(response: string): FixEdit[] {
  const edits: FixEdit[] = [];

  // Try to find JSON block in response
  const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1]);
      if (Array.isArray(parsed)) {
        for (const edit of parsed) {
          if (edit.file && edit.search && edit.replace !== undefined) {
            edits.push({
              file: edit.file,
              search: edit.search,
              replace: edit.replace,
              description: edit.description || 'No description',
              severity: edit.severity || 'medium',
            });
          }
        }
      }
    } catch (e) {
      Logger.warn(`auto-fix: Failed to parse JSON edits: ${e}`);
    }
  }

  // Fallback: try to find raw JSON array
  if (edits.length === 0) {
    const rawJsonMatch = response.match(/\[\s*\{[\s\S]*?\}\s*\]/);
    if (rawJsonMatch) {
      try {
        const parsed = JSON.parse(rawJsonMatch[0]);
        if (Array.isArray(parsed)) {
          for (const edit of parsed) {
            if (edit.file && edit.search && edit.replace !== undefined) {
              edits.push({
                file: edit.file,
                search: edit.search,
                replace: edit.replace,
                description: edit.description || 'No description',
                severity: edit.severity || 'medium',
              });
            }
          }
        }
      } catch (e) {
        Logger.warn(`auto-fix: Failed to parse raw JSON: ${e}`);
      }
    }
  }

  return edits;
}

export const autoFixTool: UnifiedTool = {
  name: 'auto-fix',
  description: 'Automatic AI-powered code fixes with apply or dry-run mode. For simple regex find/replace, use replace-content instead',
  zodSchema: schema,
  prompt: { description: 'Auto-fix code issues' },
  metadata: {
    category: 'specialized',
    tags: ['fix', 'auto', 'ai'],
    longRunning: true,
    aiRequired: { fallbackTools: ['replace-content', 'replace-lines'] },
    aiRouting: 'hybrid',
    examples: [
      { args: { files: '@src/auth.ts', focus: 'security', dryRun: true }, description: 'Preview security fixes without applying' },
      { args: { files: '@src/service.ts', focus: 'all', severity: 'critical' }, description: 'Apply critical fixes across all categories' },
    ],
    relatedTools: ['replace-content', 'code-review', 'fix-bug'],
  },
  execute: async (args, onProgress) => {
    const { files, focus = 'all', severity = 'critical', dryRun } = args;
    if (!files?.toString().trim()) throw new Error('Files required. Use @path/file.php syntax.');

    const filesStr = String(files);
    const isDryRun = Boolean(dryRun);
    const agent: AgentType = 'plan'; // Always use plan to get structured analysis

    const prompt = `${getEnhancedContextString()}
# Auto-Fix Request

## Mode: ${isDryRun ? 'DRY-RUN (analysis only)' : 'AUTO-FIX (will apply changes)'}

## Focus: ${FOCUS_MAP[focus as string]}
${severity === 'critical' ? '**CRITICAL ONLY** - Fix only issues requiring immediate attention.' : ''}

## Files
${filesStr}

## CRITICAL INSTRUCTIONS

You MUST output fixes in the following JSON format. This is REQUIRED for the fixes to be applied.

\`\`\`json
[
  {
    "file": "path/to/file.ts",
    "search": "exact code to find and replace",
    "replace": "new code to replace it with",
    "description": "Brief description of the fix",
    "severity": "critical|high|medium|low"
  }
]
\`\`\`

## Rules for edits:
1. The "search" field must be an EXACT match of existing code (including whitespace)
2. Keep search strings short enough to be unique but include enough context
3. The "replace" field should contain the fixed code
4. Only include fixes that are necessary and safe
5. Each fix should be atomic and self-contained

## Output Format

First, briefly describe what issues you found.
Then output the JSON block with all fixes.
Finally, summarize what was fixed.

Begin analysis:`;

    onProgress?.(`Auto-fix (${focus}, ${isDryRun ? 'dry-run' : 'apply'}): ${filesStr}`);

    // Get AI analysis with structured edits
    const aiResponse = await executeAI({ prompt, agent, files: parseFiles(filesStr), onProgress, enhancePrompt: true });

    // Parse edits from AI response
    const edits = parseAIEdits(aiResponse);

    if (edits.length === 0) {
      return JSON.stringify({
        success: true,
        mode: isDryRun ? 'dry-run' : 'apply',
        message: 'No actionable fixes found or AI did not provide structured edits',
        aiResponse: aiResponse.slice(0, 2000), // Include truncated AI response for context
        editsFound: 0,
        editsApplied: 0,
      });
    }

    // In dry-run mode, just show what would be done
    if (isDryRun) {
      return JSON.stringify({
        success: true,
        mode: 'dry-run',
        message: `Found ${edits.length} fixes (not applied)`,
        edits: edits.map((e) => ({
          file: e.file,
          description: e.description,
          severity: e.severity,
          searchPreview: e.search.slice(0, 100) + (e.search.length > 100 ? '...' : ''),
          replacePreview: e.replace.slice(0, 100) + (e.replace.length > 100 ? '...' : ''),
        })),
        editsFound: edits.length,
        editsApplied: 0,
      });
    }

    // Group edits by file to apply atomically
    const editsByFile = new Map<string, FixEdit[]>();
    for (const edit of edits) {
      const filePath = path.isAbsolute(edit.file)
        ? edit.file
        : path.resolve(process.cwd(), edit.file);

      // Validate path to prevent path traversal from AI-generated edits
      try {
        await validatePath(filePath, { allowSymlinks: false, operation: 'write', requireWithinProject: false });
      } catch {
        Logger.warn(`auto-fix: Skipping unsafe path: ${filePath}`);
        continue;
      }

      const existing = editsByFile.get(filePath) || [];
      existing.push({ ...edit, file: filePath });
      editsByFile.set(filePath, existing);
    }

    // Apply all edits to each file atomically
    const results: FixResult[] = [];
    for (const [filePath, fileEdits] of editsByFile) {
      try {
        // Read file once
        let content = await fs.readFile(filePath, 'utf8');

        // Create backup before any changes
        const backupPath = `${filePath}.bak`;
        await fs.copyFile(filePath, backupPath);

        // Apply all edits to this file
        for (const edit of fileEdits) {
          if (content.includes(edit.search)) {
            content = content.replace(edit.search, edit.replace);
            results.push({
              file: edit.file,
              description: edit.description,
              severity: edit.severity,
              success: true,
              backup: backupPath,
            });
          } else {
            results.push({
              file: edit.file,
              description: edit.description,
              severity: edit.severity,
              success: false,
              error: 'Search string not found in file',
            });
          }
        }

        // Write file once with all changes
        await fs.writeFile(filePath, content, 'utf8');
        Logger.info(`auto-fix: Applied ${fileEdits.length} fixes to ${filePath}`);
      } catch (error) {
        // Mark all edits for this file as failed
        for (const edit of fileEdits) {
          results.push({
            file: edit.file,
            description: edit.description,
            severity: edit.severity,
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    const successful = results.filter((r) => r.success);
    const failed = results.filter((r) => !r.success);

    // Record suggestions for feedback tracking
    for (const result of successful) {
      recordSuggestion(
        'auto-fix',
        result.file,
        'fix',
        result.description,
        `Severity: ${result.severity}`
      ).catch(() => {
        /* ignore errors */
      });
    }

    if (isSilent()) {
      return JSON.stringify({ applied: successful.length, failed: failed.length });
    }

    return JSON.stringify({
      success: failed.length === 0,
      mode: 'apply',
      message: `Applied ${successful.length}/${edits.length} fixes`,
      results,
      editsFound: edits.length,
      editsApplied: successful.length,
      editsFailed: failed.length,
      summary: {
        successful: successful.map((r) => `${r.file}: ${r.description}`),
        failed: failed.map((r) => `${r.file}: ${r.error}`),
      },
    });
  },
};
