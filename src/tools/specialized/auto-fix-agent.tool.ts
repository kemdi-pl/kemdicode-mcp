/**
 * KemdiCode MCP Server
 * Copyright (C) 2025-2026 Kemdi Sp. z o.o.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

/**
 * Auto-Fix Agent Tool
 *
 * Multi-agent code fixing using OpenAI Agents SDK.
 * Uses applyPatchTool with WorkspaceEditor for reliable file modifications.
 *
 * @module tools/specialized/auto-fix-agent
 */

import { z } from 'zod';
import { Agent, run, applyPatchTool } from '@openai/agents';
import { UnifiedTool } from '../registry.js';
import { createWorkspaceEditor } from '../../ai/workspace-editor.js';
import { parseFiles } from '../../ai/index.js';
import { getEnhancedContextString } from '../../utils/projectContext.enhanced.js';
import { Logger } from '../../utils/logger.js';
import { config } from '../../config/index.js';
import { readFile } from 'node:fs/promises';
import { recordSuggestion } from '../../context/feedback-loop.js';

const FOCUS_MAP: Record<string, string> = {
  security: 'SECURITY: SQL injection, XSS, CSRF, auth bypass, hardcoded secrets',
  performance: 'PERFORMANCE: N+1 queries, missing cache, inefficient loops, memory leaks',
  quality: 'QUALITY: SOLID violations, code duplication, missing error handling, type safety',
  all: 'ALL: Security + Performance + Quality + Best practices',
};

const schema = z.object({
  files: z.string().describe('Files to fix (@path/file syntax)'),
  focus: z.enum(['security', 'performance', 'quality', 'all']).default('all'),
  severity: z
    .enum(['critical', 'all'])
    .default('critical')
    .describe('critical = urgent fixes only'),
  dryRun: z.boolean().default(false).describe('Preview changes without applying'),
  approve: z.boolean().default(true).describe('Auto-approve patches'),
});

type AutoFixAgentArgs = z.infer<typeof schema>;

export const autoFixAgentTool: UnifiedTool = {
  name: 'auto-fix-agent',
  description: 'Multi-agent code fixing via OpenAI Agents SDK with diff-based patching',
  zodSchema: schema,

  execute: async (args, onProgress) => {
    const input = args as unknown as AutoFixAgentArgs;
    const { files, focus = 'all', severity = 'critical', dryRun = false, approve = true } = input;

    if (!files?.toString().trim()) {
      throw new Error('Files required. Use @path/file.ts syntax.');
    }

    const filesStr = String(files);
    onProgress?.(`Auto-fix agent (${focus}, ${dryRun ? 'dry-run' : 'apply'}): ${filesStr}`);

    // Parse and read files
    const parsedFiles = parseFiles(filesStr);
    let fileContents = '';

    for (const filePath of parsedFiles) {
      try {
        const content = await readFile(filePath, 'utf8');
        fileContents += `\n### File: ${filePath}\n\`\`\`\n${content}\n\`\`\`\n`;
      } catch (error) {
        fileContents += `\n### File: ${filePath}\nError reading file: ${error}\n`;
      }
    }

    // Get model from config
    const serverConfig = config.get('server');
    const model = serverConfig?.primaryModel || 'gpt-4o';

    // Create workspace editor for file operations
    const editor = createWorkspaceEditor({
      root: process.cwd(),
      createBackups: true,
    });

    // Create the fixer agent with applyPatchTool
    const fixerAgent = new Agent({
      name: 'CodeFixer',
      instructions: `${getEnhancedContextString()}

You are an expert code analyzer and fixer. Your job is to analyze code, identify issues, and fix them.

## Mode: ${dryRun ? 'DRY-RUN (describe what you would change, do NOT use tools)' : 'APPLY (use apply_patch tool to fix issues)'}

## Focus: ${FOCUS_MAP[focus]}
${severity === 'critical' ? '**CRITICAL ONLY** - Only fix issues requiring immediate attention.' : ''}

## Code to Analyze:
${fileContents}

## Your Task:
1. Analyze the code thoroughly for issues in the focus area
2. For each issue found:
   - Explain what the problem is
   - Why it's a problem
   - ${dryRun ? 'Describe the fix you would apply' : 'Use apply_patch tool to fix it'}
3. ${dryRun ? 'Summarize all proposed changes' : 'Report what was fixed'}

## Rules for Patches:
- Make minimal, targeted changes
- Preserve existing code style
- Each patch should be atomic and safe
- Use proper diff format for patches`,
      model,
      tools: dryRun
        ? [] // No tools in dry-run mode
        : [
            applyPatchTool({
              editor,
              needsApproval: !approve,
              onApproval: async (_ctx, approvalItem) => {
                if (approve) {
                  return { approve: true };
                }
                const op =
                  approvalItem.rawItem.type === 'apply_patch_call'
                    ? (approvalItem.rawItem as { operation?: { type?: string; path?: string } })
                        .operation
                    : undefined;
                Logger.info(`auto-fix-agent: Patch requires approval: ${op?.type} ${op?.path}`);
                return { approve: true };
              },
            }),
          ],
    });

    try {
      onProgress?.('Running code fixer agent...');

      // Run the agent
      const result = await run(
        fixerAgent,
        `Analyze the code and ${dryRun ? 'describe fixes' : 'apply fixes'}. Focus: ${focus}, Severity: ${severity}`
      );

      onProgress?.('Analysis and fixes complete.');

      // Extract results
      const output = result.finalOutput || 'No output from agent';

      // Record suggestions for feedback tracking (only when fixes were applied)
      if (!dryRun) {
        for (const file of parsedFiles) {
          recordSuggestion(
            'auto-fix-agent',
            file,
            'fix',
            `Auto-fix agent (${focus}, ${severity})`,
            output.slice(0, 500)
          ).catch(() => {
            /* ignore errors */
          });
        }
      }

      return JSON.stringify({
        success: true,
        mode: dryRun ? 'dry-run' : 'apply',
        focus,
        severity,
        filesAnalyzed: parsedFiles.length,
        model,
        agentOutput: output,
        message: dryRun
          ? 'Dry-run complete. No changes were made.'
          : 'Fixes applied using OpenAI Agents SDK.',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      Logger.error(`auto-fix-agent: Error: ${message}`);

      return JSON.stringify({
        success: false,
        error: message,
        mode: dryRun ? 'dry-run' : 'apply',
      });
    }
  },
};
