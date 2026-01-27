/**
 * Level 2 Integration Tests: Tool Chain Integration
 *
 * Tests tools working together, context sharing between tools,
 * batch operations, schema validation, and error handling.
 *
 * Test Cases:
 * - I2.22: Tool schema validation consistency
 * - I2.23: Tool context sharing between executions
 * - I2.24: Batch tool operations
 * - I2.25: Tool error handling and recovery
 * - I2.26: Tool execution concurrency
 * - I2.27: Cross-tool data flow
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { ContextStorage } from '../../src/context/storage.js';
import {
  createSharedRedisMock,
  runConcurrentTasks,
  calculateConcurrencyMetrics,
  IntegrationIds,
  suppressConsoleForIntegration,
} from './fixtures.js';

// Mock tool implementations for testing
interface MockToolResult {
  toolName: string;
  success: boolean;
  output: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

class MockToolExecutor {
  private executionLog: MockToolResult[] = [];
  private contextStorage: ContextStorage;
  private sessionId: string;
  private executionCounter = 0;

  constructor(contextStorage: ContextStorage, sessionId: string) {
    this.contextStorage = contextStorage;
    this.sessionId = sessionId;
  }

  async executeTool(
    toolName: string,
    args: Record<string, unknown>,
    options: { delay?: number; shouldFail?: boolean } = {}
  ): Promise<MockToolResult> {
    const { delay = 10, shouldFail = false } = options;

    // Get unique execution number (thread-safe increment)
    const execNum = this.executionCounter++;

    // Simulate async execution
    await new Promise((r) => setTimeout(r, delay));

    if (shouldFail) {
      throw new Error(`Tool ${toolName} failed`);
    }

    // Use unique timestamp with counter to avoid collisions
    const timestamp = Date.now() * 1000 + execNum;

    const result: MockToolResult = {
      toolName,
      success: true,
      output: `${toolName} executed with ${JSON.stringify(args)}`,
      timestamp,
      metadata: { args },
    };

    this.executionLog.push(result);

    // Save to context storage with unique ID
    const uniqueId = `tool_${toolName}_${timestamp}_${Math.random().toString(36).slice(2, 8)}`;
    await this.contextStorage.saveContext({
      id: uniqueId,
      sessionId: this.sessionId,
      serverId: 'opencode-mcp',
      toolName,
      timestamp,
      ttl: 3600,
      args,
      output: result.output,
      summary: `Executed ${toolName}`,
      tags: [toolName, 'mock'],
    });

    return result;
  }

  async executeToolChain(
    tools: Array<{ name: string; args: Record<string, unknown> }>
  ): Promise<MockToolResult[]> {
    const results: MockToolResult[] = [];

    for (const tool of tools) {
      const result = await this.executeTool(tool.name, tool.args);
      results.push(result);
    }

    return results;
  }

  async executeToolBatch(
    tools: Array<{ name: string; args: Record<string, unknown> }>,
    parallel: boolean = true
  ): Promise<MockToolResult[]> {
    if (parallel) {
      const tasks = tools.map((tool) => ({
        name: tool.name,
        fn: () => this.executeTool(tool.name, tool.args),
      }));

      const results = await runConcurrentTasks(tasks);
      return results.map((r) => r.result!);
    } else {
      return this.executeToolChain(tools);
    }
  }

  getExecutionLog(): MockToolResult[] {
    return [...this.executionLog];
  }

  clearLog(): void {
    this.executionLog = [];
  }
}

// Mock tool schemas for testing
const toolSchemas = {
  'code-review': z.object({
    files: z.string().describe('Files to review'),
    focus: z.enum(['security', 'performance', 'quality', 'all']).default('all'),
    severity: z.enum(['critical', 'all']).default('all'),
  }),
  'explain-code': z.object({
    files: z.string().describe('Files to explain'),
    depth: z.enum(['quick', 'detailed', 'deep']).default('detailed'),
    audience: z.enum(['junior', 'senior', 'non-tech']).default('senior'),
  }),
  'fix-bug': z.object({
    files: z.string().describe('Files with bug'),
    description: z.string().describe('Bug description'),
    steps: z.string().optional(),
    errorLog: z.string().optional(),
  }),
  'refactor': z.object({
    files: z.string().describe('Files to refactor'),
    goal: z.enum(['readability', 'performance', 'solid', 'laravel-patterns', 'dry']),
    scope: z.enum(['minimal', 'moderate', 'aggressive']).default('moderate'),
  }),
  'find-references': z.object({
    symbol: z.string().describe('Symbol to find'),
    fileType: z.string().optional(),
    excludeDefinitions: z.boolean().default(false),
    maxResults: z.number().default(50),
    context: z.number().default(0),
  }),
};

describe('Level 2 Integration: Tool Chain', () => {
  suppressConsoleForIntegration();

  let contextStorage: ContextStorage;
  let toolExecutor: MockToolExecutor;
  let sessionId: string;

  beforeEach(async () => {
    sessionId = IntegrationIds.session();
    contextStorage = new ContextStorage({ db: 3 });

    const mockRedis = createSharedRedisMock();
    (contextStorage as unknown as { redis: unknown }).redis = mockRedis;
    (contextStorage as unknown as { connected: boolean }).connected = true;

    toolExecutor = new MockToolExecutor(contextStorage, sessionId);
  });

  afterEach(async () => {
    try {
      await contextStorage.disconnect();
    } catch {
      // Ignore
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // I2.22: Tool Schema Validation Consistency
  // ═══════════════════════════════════════════════════════════════════════════

  describe('I2.22: Tool schema validation consistency', () => {
    it('should validate all tool schemas are well-formed', () => {
      for (const [_toolName, schema] of Object.entries(toolSchemas)) {
        // Zod 4 uses instanceof check
        expect(schema instanceof z.ZodObject).toBe(true);
        expect(() => schema.parse({})).toThrow(); // Required fields missing
      }
    });

    it('should validate required fields in code-review schema', () => {
      const schema = toolSchemas['code-review'];

      // Valid input
      const valid = schema.parse({
        files: '@src/test.ts',
      });
      expect(valid.files).toBe('@src/test.ts');
      expect(valid.focus).toBe('all'); // Default
      expect(valid.severity).toBe('all'); // Default

      // Invalid input - missing required
      expect(() => schema.parse({})).toThrow();

      // Invalid enum value
      expect(() => schema.parse({ files: '@test.ts', focus: 'invalid' })).toThrow();
    });

    it('should validate fix-bug schema with optional fields', () => {
      const schema = toolSchemas['fix-bug'];

      // Minimal valid input
      const minimal = schema.parse({
        files: '@src/buggy.ts',
        description: 'Button does not respond',
      });
      expect(minimal.files).toBe('@src/buggy.ts');
      expect(minimal.steps).toBeUndefined();
      expect(minimal.errorLog).toBeUndefined();

      // Full input
      const full = schema.parse({
        files: '@src/buggy.ts',
        description: 'Button does not respond',
        steps: '1. Click button 2. Nothing happens',
        errorLog: 'TypeError: undefined is not a function',
      });
      expect(full.steps).toBe('1. Click button 2. Nothing happens');
    });

    it('should handle concurrent schema validations', async () => {
      const inputs = Array.from({ length: 50 }, (_, i) => ({
        files: `@src/file${i}.ts`,
        focus: 'security' as const,
      }));

      const tasks = inputs.map((input, i) => ({
        name: `validate-${i}`,
        fn: async () => {
          const result = toolSchemas['code-review'].safeParse(input);
          return result.success;
        },
      }));

      const results = await runConcurrentTasks(tasks);
      expect(results.every((r) => r.result === true)).toBe(true);
    });

    it('should provide helpful error messages for invalid inputs', () => {
      const result = toolSchemas['code-review'].safeParse({
        focus: 'invalid-focus',
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        // Zod 4 uses 'issues' instead of 'errors'
        const issues = result.error.issues;
        expect(issues.length).toBeGreaterThan(0);
        expect(issues.some((e) => e.path.includes('files'))).toBe(true);
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // I2.23: Tool Context Sharing Between Executions
  // ═══════════════════════════════════════════════════════════════════════════

  describe('I2.23: Tool context sharing between executions', () => {
    it('should store context from tool execution', async () => {
      await toolExecutor.executeTool('code-review', { files: '@src/test.ts' });

      const history = await contextStorage.getSessionHistory(sessionId, 10);
      expect(history.length).toBe(1);
      expect(history[0].toolName).toBe('code-review');
    });

    it('should accumulate context from multiple tool executions', async () => {
      await toolExecutor.executeTool('code-review', { files: '@src/a.ts' });
      await toolExecutor.executeTool('explain-code', { files: '@src/b.ts' });
      await toolExecutor.executeTool('fix-bug', {
        files: '@src/c.ts',
        description: 'Bug',
      });

      const history = await contextStorage.getSessionHistory(sessionId, 10);
      expect(history.length).toBe(3);

      const toolNames = history.map((h) => h.toolName);
      expect(toolNames).toContain('code-review');
      expect(toolNames).toContain('explain-code');
      expect(toolNames).toContain('fix-bug');
    });

    it('should allow querying context by tool name', async () => {
      await toolExecutor.executeTool('code-review', { files: '@src/a.ts' });
      await toolExecutor.executeTool('code-review', { files: '@src/b.ts' });
      await toolExecutor.executeTool('explain-code', { files: '@src/c.ts' });

      const codeReviewContext = await contextStorage.queryContext({
        sessionId,
        toolName: 'code-review',
        limit: 10,
      });

      expect(codeReviewContext.length).toBe(2);
      expect(codeReviewContext.every((c) => c.toolName === 'code-review')).toBe(true);
    });

    it('should preserve execution order in context', async () => {
      for (let i = 0; i < 5; i++) {
        await toolExecutor.executeTool('refactor', {
          files: `@src/file${i}.ts`,
          goal: 'readability',
        });
        await new Promise((r) => setTimeout(r, 10)); // Ensure timestamp difference
      }

      const history = await contextStorage.getSessionHistory(sessionId, 10);

      // Should be in reverse chronological order (newest first)
      for (let i = 1; i < history.length; i++) {
        expect(history[i - 1].timestamp).toBeGreaterThanOrEqual(history[i].timestamp);
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // I2.24: Batch Tool Operations
  // ═══════════════════════════════════════════════════════════════════════════

  describe('I2.24: Batch tool operations', () => {
    it('should execute multiple tools in parallel', async () => {
      const tools = [
        { name: 'code-review', args: { files: '@src/a.ts' } },
        { name: 'explain-code', args: { files: '@src/b.ts' } },
        { name: 'find-references', args: { symbol: 'MyClass' } },
      ];

      const results = await toolExecutor.executeToolBatch(tools, true);

      expect(results.length).toBe(3);
      expect(results.every((r) => r.success)).toBe(true);
    });

    it('should execute multiple tools sequentially', async () => {
      const tools = [
        { name: 'code-review', args: { files: '@src/a.ts' } },
        { name: 'explain-code', args: { files: '@src/b.ts' } },
      ];

      const results = await toolExecutor.executeToolBatch(tools, false);

      expect(results.length).toBe(2);

      // Sequential execution should preserve order
      expect(results[0].toolName).toBe('code-review');
      expect(results[1].toolName).toBe('explain-code');
      expect(results[1].timestamp).toBeGreaterThanOrEqual(results[0].timestamp);
    });

    it('should be faster in parallel than sequential', async () => {
      const tools = Array.from({ length: 10 }, (_, i) => ({
        name: 'code-review',
        args: { files: `@src/file${i}.ts` },
      }));

      // Parallel execution
      const parallelStart = Date.now();
      await toolExecutor.executeToolBatch(tools, true);
      const parallelDuration = Date.now() - parallelStart;
      toolExecutor.clearLog();

      // Sequential execution
      const sequentialStart = Date.now();
      await toolExecutor.executeToolBatch(tools, false);
      const sequentialDuration = Date.now() - sequentialStart;

      // Parallel should be significantly faster
      expect(parallelDuration).toBeLessThan(sequentialDuration);
    });

    it('should handle mixed tool types in batch', async () => {
      const tools = [
        { name: 'code-review', args: { files: '@src/test.ts', focus: 'security' } },
        { name: 'explain-code', args: { files: '@src/test.ts', depth: 'deep' } },
        { name: 'fix-bug', args: { files: '@src/test.ts', description: 'Fix memory leak' } },
        { name: 'refactor', args: { files: '@src/test.ts', goal: 'performance' } },
        { name: 'find-references', args: { symbol: 'processData' } },
      ];

      const results = await toolExecutor.executeToolBatch(tools, true);

      expect(results.length).toBe(5);
      const toolNames = results.map((r) => r.toolName);
      expect(new Set(toolNames).size).toBe(5); // All unique
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // I2.25: Tool Error Handling and Recovery
  // ═══════════════════════════════════════════════════════════════════════════

  describe('I2.25: Tool error handling and recovery', () => {
    it('should handle individual tool failures gracefully', async () => {
      // Successful execution
      const result1 = await toolExecutor.executeTool('code-review', { files: '@src/test.ts' });
      expect(result1.success).toBe(true);

      // Failed execution
      await expect(
        toolExecutor.executeTool('code-review', { files: '@src/test.ts' }, { shouldFail: true })
      ).rejects.toThrow('Tool code-review failed');

      // Successful execution after failure (recovery)
      const result2 = await toolExecutor.executeTool('explain-code', { files: '@src/test.ts' });
      expect(result2.success).toBe(true);
    });

    it('should continue batch execution despite individual failures', async () => {
      const executedTools: string[] = [];

      // Create a custom executor that tracks execution
      const tasks = [
        {
          name: 'tool-1',
          fn: async () => {
            executedTools.push('tool-1');
            return { success: true };
          },
        },
        {
          name: 'tool-2',
          fn: async () => {
            executedTools.push('tool-2');
            throw new Error('Tool 2 failed');
          },
        },
        {
          name: 'tool-3',
          fn: async () => {
            executedTools.push('tool-3');
            return { success: true };
          },
        },
      ];

      const results = await runConcurrentTasks(tasks);

      // All tools should have been attempted
      expect(executedTools.length).toBe(3);

      // Results should reflect success/failure
      expect(results.find((r) => r.name === 'tool-1')?.error).toBeUndefined();
      expect(results.find((r) => r.name === 'tool-2')?.error).toBeDefined();
      expect(results.find((r) => r.name === 'tool-3')?.error).toBeUndefined();
    });

    it('should report detailed error information', async () => {
      const invalidInput = { focus: 'invalid' }; // Missing required 'files'

      const result = toolSchemas['code-review'].safeParse(invalidInput);
      expect(result.success).toBe(false);

      if (!result.success) {
        // Zod 4 uses 'issues' instead of 'errors'
        const errorMessages = result.error.issues.map((e) => ({
          path: e.path.join('.'),
          message: e.message,
        }));

        expect(errorMessages.some((e) => e.path === 'files')).toBe(true);
      }
    });

    it('should preserve successful results when some operations fail', async () => {
      const tasks = Array.from({ length: 10 }, (_, i) => ({
        name: `op-${i}`,
        fn: async () => {
          // Indices 0, 3, 6, 9 will fail (i % 3 === 0)
          if (i % 3 === 0) {
            throw new Error(`Operation ${i} failed`);
          }
          return { index: i, success: true };
        },
      }));

      const results = await runConcurrentTasks(tasks);
      const metrics = calculateConcurrencyMetrics(results);

      // Indices 0, 3, 6, 9 fail = 4 failures, 6 successes
      expect(metrics.successCount).toBe(6);
      expect(metrics.errorCount).toBe(4);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // I2.26: Tool Execution Concurrency
  // ═══════════════════════════════════════════════════════════════════════════

  describe('I2.26: Tool execution concurrency', () => {
    it('should handle high concurrency tool execution', async () => {
      const concurrencyLevel = 50;

      const tasks = Array.from({ length: concurrencyLevel }, (_, i) => ({
        name: `concurrent-${i}`,
        fn: () =>
          toolExecutor.executeTool(
            'code-review',
            { files: `@src/file${i}.ts` },
            { delay: Math.random() * 20 }
          ),
      }));

      const results = await runConcurrentTasks(tasks);
      const metrics = calculateConcurrencyMetrics(results);

      expect(metrics.successCount).toBe(concurrencyLevel);
      expect(metrics.errorCount).toBe(0);
      expect(metrics.parallelismFactor).toBeGreaterThan(1);
    });

    it('should maintain data integrity under concurrent load', async () => {
      const tasks = Array.from({ length: 30 }, (_, i) => ({
        name: `integrity-${i}`,
        fn: async () => {
          const result = await toolExecutor.executeTool('refactor', {
            files: `@src/unique${i}.ts`,
            goal: 'readability',
            uniqueMarker: `marker_${i}`,
          });
          return result;
        },
      }));

      await runConcurrentTasks(tasks);

      const history = await contextStorage.getSessionHistory(sessionId, 50);
      expect(history.length).toBe(30);

      // Each entry should have unique args
      const argsSet = new Set(history.map((h) => JSON.stringify(h.args)));
      expect(argsSet.size).toBe(30);
    });

    it('should measure parallelism factor accurately', async () => {
      const taskCount = 20;
      const perTaskDelay = 50;

      const tasks = Array.from({ length: taskCount }, (_, i) => ({
        name: `measure-${i}`,
        fn: async () => {
          await new Promise((r) => setTimeout(r, perTaskDelay));
          return { index: i };
        },
      }));

      const results = await runConcurrentTasks(tasks);
      const metrics = calculateConcurrencyMetrics(results);

      // With parallelism, total time should be less than sequential time
      const expectedSequentialTime = taskCount * perTaskDelay;
      expect(metrics.totalDurationMs).toBeLessThan(expectedSequentialTime * 0.5);
      expect(metrics.parallelismFactor).toBeGreaterThan(5);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // I2.27: Cross-Tool Data Flow
  // ═══════════════════════════════════════════════════════════════════════════

  describe('I2.27: Cross-tool data flow', () => {
    it('should allow tool output to inform next tool input', async () => {
      // First tool: code review
      const _reviewResult = await toolExecutor.executeTool('code-review', {
        files: '@src/component.tsx',
        focus: 'security',
      });

      // Second tool uses context from first
      const history = await contextStorage.getSessionHistory(sessionId, 1);
      expect(history[0].toolName).toBe('code-review');

      // Third tool: fix issues found
      const fixResult = await toolExecutor.executeTool('fix-bug', {
        files: '@src/component.tsx',
        description: `Fix issues from review: ${history[0].summary}`,
      });

      expect(fixResult.success).toBe(true);
      expect(toolExecutor.getExecutionLog().length).toBe(2);
    });

    it('should support tool chain workflows', async () => {
      const workflow = [
        { name: 'explain-code', args: { files: '@src/complex.ts', depth: 'deep' } },
        { name: 'code-review', args: { files: '@src/complex.ts', focus: 'quality' } },
        { name: 'refactor', args: { files: '@src/complex.ts', goal: 'readability' } },
      ];

      const results = await toolExecutor.executeToolChain(workflow);

      expect(results.length).toBe(3);

      // Verify sequential execution
      for (let i = 1; i < results.length; i++) {
        expect(results[i].timestamp).toBeGreaterThanOrEqual(results[i - 1].timestamp);
      }

      // Verify all context was saved
      const history = await contextStorage.getSessionHistory(sessionId, 10);
      expect(history.length).toBe(3);
    });

    it('should aggregate context from multiple tool executions', async () => {
      // Execute various tools
      await toolExecutor.executeTool('find-references', { symbol: 'UserService' });
      await toolExecutor.executeTool('explain-code', { files: '@src/services/user.ts' });
      await toolExecutor.executeTool('code-review', {
        files: '@src/services/user.ts',
        focus: 'security',
      });

      // Query all context for the session
      const allContext = await contextStorage.queryContext({
        sessionId,
        limit: 20,
      });

      expect(allContext.length).toBe(3);

      // Each tool's context should be available
      const toolNames = allContext.map((c) => c.toolName);
      expect(toolNames).toContain('find-references');
      expect(toolNames).toContain('explain-code');
      expect(toolNames).toContain('code-review');
    });

    it('should support tagging for context grouping', async () => {
      // Execute with different tag patterns (via context storage directly for testing)
      await contextStorage.saveContext({
        id: 'auth_review_1',
        sessionId,
        serverId: 'opencode-mcp',
        toolName: 'code-review',
        timestamp: Date.now(),
        ttl: 3600,
        args: { files: '@src/auth.ts' },
        output: 'Review complete',
        summary: 'Auth module review',
        tags: ['auth', 'security', 'review'],
      });

      await contextStorage.saveContext({
        id: 'auth_fix_1',
        sessionId,
        serverId: 'opencode-mcp',
        toolName: 'fix-bug',
        timestamp: Date.now(),
        ttl: 3600,
        args: { files: '@src/auth.ts' },
        output: 'Fixed',
        summary: 'Auth fix',
        tags: ['auth', 'bugfix'],
      });

      await contextStorage.saveContext({
        id: 'perf_review_1',
        sessionId,
        serverId: 'opencode-mcp',
        toolName: 'code-review',
        timestamp: Date.now(),
        ttl: 3600,
        args: { files: '@src/perf.ts' },
        output: 'Review complete',
        summary: 'Perf review',
        tags: ['performance', 'review'],
      });

      // Query by tag
      const authContext = await contextStorage.queryContext({
        sessionId,
        tags: ['auth'],
        limit: 10,
      });
      expect(authContext.length).toBe(2);

      const reviewContext = await contextStorage.queryContext({
        sessionId,
        tags: ['review'],
        limit: 10,
      });
      expect(reviewContext.length).toBe(2);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Integration Scenario: Complete Tool Chain Workflow
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Complete tool chain workflow scenario', () => {
    it('should execute a full code improvement workflow', async () => {
      // Step 1: Initial code review
      await toolExecutor.executeTool('code-review', {
        files: '@src/legacy-component.tsx',
        focus: 'all',
        severity: 'all',
      });

      // Step 2: Understand the code
      await toolExecutor.executeTool('explain-code', {
        files: '@src/legacy-component.tsx',
        depth: 'deep',
        audience: 'senior',
      });

      // Step 3: Find all usages
      await toolExecutor.executeTool('find-references', {
        symbol: 'LegacyComponent',
        maxResults: 20,
      });

      // Step 4: Refactor for readability
      await toolExecutor.executeTool('refactor', {
        files: '@src/legacy-component.tsx',
        goal: 'readability',
        scope: 'moderate',
      });

      // Step 5: Fix any remaining issues
      await toolExecutor.executeTool('fix-bug', {
        files: '@src/legacy-component.tsx',
        description: 'Address code review findings and ensure tests pass',
      });

      // Verify the workflow was completed
      const log = toolExecutor.getExecutionLog();
      expect(log.length).toBe(5);

      // Verify all context was saved
      const history = await contextStorage.getSessionHistory(sessionId, 10);
      expect(history.length).toBe(5);

      // Verify tool diversity
      const uniqueTools = new Set(history.map((h) => h.toolName));
      expect(uniqueTools.size).toBe(5);
    });
  });
});
