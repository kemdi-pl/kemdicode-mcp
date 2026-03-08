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
 * Level 2 Integration Tests: Session Sharing
 *
 * Tests multiple agents sharing the same session, concurrent session access,
 * session lifecycle management, and cross-agent session coordination.
 *
 * Test Cases:
 * - I2.16: Multiple agents joining same session
 * - I2.17: Concurrent session access and updates
 * - I2.18: Session metadata synchronization
 * - I2.19: Session lifecycle across agents
 * - I2.20: Session statistics with multiple agents
 * - I2.21: Session expiration and cleanup with active agents
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SessionManager } from '../../src/session/manager.js';
import { AgentMonitor } from '../../src/context/agent-monitor.js';
import { ContextStorage } from '../../src/context/storage.js';
import {
  createSharedRedisMock,
  runConcurrentTasks,
  calculateConcurrencyMetrics,
  IntegrationIds,
  suppressConsoleForIntegration,
} from './fixtures.js';

describe('Level 2 Integration: Session Sharing', () => {
  suppressConsoleForIntegration();

  let sessionManager: SessionManager;
  let agentMonitor: AgentMonitor;
  let contextStorage: ContextStorage;
  let sharedRedis: ReturnType<typeof createSharedRedisMock>;
  let sessionId: string;

  beforeEach(async () => {
    sessionId = IntegrationIds.session();
    sharedRedis = createSharedRedisMock();

    // Initialize session manager with mock Redis
    sessionManager = new SessionManager({ db: 3 });
    (sessionManager as unknown as { redis: unknown }).redis = sharedRedis;
    (sessionManager as unknown as { redisConnected: boolean }).redisConnected = true;

    // Initialize agent monitor with mock Redis
    agentMonitor = new AgentMonitor({ db: 3 });
    (agentMonitor as unknown as { redis: unknown }).redis = sharedRedis;
    (agentMonitor as unknown as { subscriber: unknown }).subscriber = sharedRedis;
    (agentMonitor as unknown as { connected: boolean }).connected = true;

    // Initialize context storage with mock Redis
    contextStorage = new ContextStorage({ db: 3 });
    (contextStorage as unknown as { redis: unknown }).redis = sharedRedis;
    (contextStorage as unknown as { connected: boolean }).connected = true;
  });

  afterEach(async () => {
    try {
      await sessionManager.shutdown();
      await agentMonitor.disconnect();
      await contextStorage.disconnect();
    } catch {
      // Ignore cleanup errors
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // I2.16: Multiple Agents Joining Same Session
  // ═══════════════════════════════════════════════════════════════════════════

  describe('I2.16: Multiple agents joining same session', () => {
    it('should allow multiple agents to join the same session', async () => {
      // Create a session
      const session = await sessionManager.createSession({
        sessionId,
        model: 'test-model',
        cwd: '/test/project',
        skipProjectDetection: true,
      });

      // Register multiple agents in the same session
      const agents = [];
      for (let i = 0; i < 5; i++) {
        const agent = await agentMonitor.registerAgent(
          `Agent-${i}`,
          'worker',
          session.sessionId,
          'opencode-mcp'
        );
        agents.push(agent);
      }

      // Verify all agents are in the session
      const listedAgents = await agentMonitor.listAgents(session.sessionId);
      expect(listedAgents.length).toBe(5);
      expect(listedAgents.every((a) => a.sessionId === session.sessionId)).toBe(true);
    });

    it('should allow different agent roles in same session', async () => {
      const session = await sessionManager.createSession({
        sessionId,
        model: 'test-model',
        skipProjectDetection: true,
      });

      const _supervisor = await agentMonitor.registerAgent(
        'Supervisor',
        'supervisor',
        session.sessionId,
        'opencode-mcp'
      );
      const _coordinator = await agentMonitor.registerAgent(
        'Coordinator',
        'coordinator',
        session.sessionId,
        'opencode-mcp'
      );
      const workers = [];
      for (let i = 0; i < 3; i++) {
        const worker = await agentMonitor.registerAgent(
          `Worker-${i}`,
          'worker',
          session.sessionId,
          'opencode-mcp'
        );
        workers.push(worker);
      }

      const allAgents = await agentMonitor.listAgents(session.sessionId);
      expect(allAgents.length).toBe(5);

      const roles = allAgents.map((a) => a.role);
      expect(roles).toContain('supervisor');
      expect(roles).toContain('coordinator');
      expect(roles.filter((r) => r === 'worker').length).toBe(3);
    });

    it('should handle concurrent agent registration to same session', async () => {
      const session = await sessionManager.createSession({
        sessionId,
        model: 'test-model',
        skipProjectDetection: true,
      });

      const tasks = Array.from({ length: 10 }, (_, i) => ({
        name: `register-${i}`,
        fn: () =>
          agentMonitor.registerAgent(
            `ConcurrentAgent-${i}`,
            'worker',
            session.sessionId,
            'opencode-mcp'
          ),
      }));

      const results = await runConcurrentTasks(tasks);
      const metrics = calculateConcurrencyMetrics(results);

      expect(metrics.successCount).toBe(10);
      expect(metrics.errorCount).toBe(0);

      const allAgents = await agentMonitor.listAgents(session.sessionId);
      expect(allAgents.length).toBe(10);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // I2.17: Concurrent Session Access and Updates
  // ═══════════════════════════════════════════════════════════════════════════

  describe('I2.17: Concurrent session access and updates', () => {
    it('should handle concurrent getSession calls', async () => {
      const session = await sessionManager.createSession({
        sessionId,
        model: 'test-model',
        skipProjectDetection: true,
      });

      const tasks = Array.from({ length: 20 }, (_, i) => ({
        name: `get-${i}`,
        fn: () => sessionManager.getSession(session.sessionId),
      }));

      const results = await runConcurrentTasks(tasks);

      expect(results.every((r) => r.result !== null)).toBe(true);
      expect(results.every((r) => (r.result as { sessionId: string }).sessionId === session.sessionId)).toBe(true);
    });

    it('should handle concurrent session updates', async () => {
      const session = await sessionManager.createSession({
        sessionId,
        model: 'test-model',
        skipProjectDetection: true,
        metadata: { counter: 0 },
      });

      const tasks = Array.from({ length: 10 }, (_, i) => ({
        name: `update-${i}`,
        fn: () =>
          sessionManager.updateSession(session.sessionId, {
            metadata: { lastUpdatedBy: `agent-${i}`, timestamp: Date.now() + i },
          }),
      }));

      const results = await runConcurrentTasks(tasks);

      expect(results.every((r) => r.result !== null)).toBe(true);

      // Final session should have metadata from one of the updates
      const finalSession = await sessionManager.getSession(session.sessionId);
      expect(finalSession?.metadata.lastUpdatedBy).toMatch(/^agent-\d+$/);
    });

    it('should handle mixed read/write operations', async () => {
      const session = await sessionManager.createSession({
        sessionId,
        model: 'test-model',
        skipProjectDetection: true,
      });

      const readTasks = Array.from({ length: 10 }, (_, i) => ({
        name: `read-${i}`,
        fn: () => sessionManager.getSession(session.sessionId),
      }));

      const writeTasks = Array.from({ length: 5 }, (_, i) => ({
        name: `write-${i}`,
        fn: () =>
          sessionManager.updateSession(session.sessionId, {
            metadata: { writeOp: i },
          }),
      }));

      const allTasks = [...readTasks, ...writeTasks].sort(() => Math.random() - 0.5);
      const results = await runConcurrentTasks(allTasks);

      expect(results.every((r) => r.result !== null)).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // I2.18: Session Metadata Synchronization
  // ═══════════════════════════════════════════════════════════════════════════

  describe('I2.18: Session metadata synchronization', () => {
    it('should propagate session updates to all agents', async () => {
      const session = await sessionManager.createSession({
        sessionId,
        model: 'test-model',
        skipProjectDetection: true,
        metadata: { version: 1 },
      });

      // Register agents
      const agents = [];
      for (let i = 0; i < 3; i++) {
        const agent = await agentMonitor.registerAgent(
          `Agent-${i}`,
          'worker',
          session.sessionId,
          'opencode-mcp'
        );
        agents.push(agent);
      }

      // Update session
      await sessionManager.updateSession(session.sessionId, {
        metadata: { version: 2, newField: 'value' },
      });

      // All agents should see the updated session
      const updatedSession = await sessionManager.getSession(session.sessionId);
      expect(updatedSession?.metadata.version).toBe(2);
      expect(updatedSession?.metadata.newField).toBe('value');
    });

    it('should maintain session integrity with context writes', async () => {
      const session = await sessionManager.createSession({
        sessionId,
        model: 'test-model',
        skipProjectDetection: true,
      });

      // Write context entries
      for (let i = 0; i < 5; i++) {
        await contextStorage.saveContext({
          id: `ctx_${i}`,
          sessionId: session.sessionId,
          serverId: 'opencode-mcp',
          toolName: 'test-tool',
          timestamp: Date.now() + i,
          ttl: 3600,
          args: {},
          output: { index: i },
          summary: `Context ${i}`,
          tags: ['test'],
        });
      }

      // Session should still be accessible
      const retrievedSession = await sessionManager.getSession(session.sessionId);
      expect(retrievedSession).not.toBeNull();
      expect(retrievedSession?.sessionId).toBe(session.sessionId);

      // Context should be accessible
      const history = await contextStorage.getSessionHistory(session.sessionId, 10);
      expect(history.length).toBe(5);
    });

    it('should handle CWD updates across session', async () => {
      const session = await sessionManager.createSession({
        sessionId,
        model: 'test-model',
        cwd: '/initial/path',
        skipProjectDetection: true,
      });

      // Update CWD
      await sessionManager.updateSession(session.sessionId, {
        cwd: '/new/project/path',
      });

      const updated = await sessionManager.getSession(session.sessionId);
      expect(updated?.cwd).toBe('/new/project/path');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // I2.19: Session Lifecycle Across Agents
  // ═══════════════════════════════════════════════════════════════════════════

  describe('I2.19: Session lifecycle across agents', () => {
    it('should track session activity from multiple agents', async () => {
      const session = await sessionManager.createSession({
        sessionId,
        model: 'test-model',
        skipProjectDetection: true,
      });

      const initialAccess = session.lastAccessedAt;

      // Multiple agents access the session
      for (let i = 0; i < 3; i++) {
        await new Promise((r) => setTimeout(r, 50));
        await sessionManager.getSession(session.sessionId);
      }

      const finalSession = await sessionManager.getSession(session.sessionId);
      expect(finalSession?.lastAccessedAt).toBeGreaterThan(initialAccess);
    });

    it('should preserve session when agents terminate', async () => {
      const session = await sessionManager.createSession({
        sessionId,
        model: 'test-model',
        skipProjectDetection: true,
      });

      // Register and terminate agents
      const agent = await agentMonitor.registerAgent(
        'TempAgent',
        'worker',
        session.sessionId,
        'opencode-mcp'
      );
      await agentMonitor.updateAgentStatus(agent!.id, 'terminated');

      // Session should still exist
      const retrievedSession = await sessionManager.getSession(session.sessionId);
      expect(retrievedSession).not.toBeNull();
    });

    it('should handle getOrCreateSession for existing sessions', async () => {
      // Create session
      await sessionManager.createSession({
        sessionId,
        model: 'original-model',
        skipProjectDetection: true,
      });

      // Try to get or create with different model
      const session = await sessionManager.getOrCreateSession({
        sessionId,
        model: 'new-model',
        skipProjectDetection: true,
      });

      // Should return existing session with original model
      expect(session.model).toBe('original-model');
    });

    it('should create new session when none exists', async () => {
      const newSessionId = IntegrationIds.session();

      const session = await sessionManager.getOrCreateSession({
        sessionId: newSessionId,
        model: 'new-model',
        skipProjectDetection: true,
      });

      expect(session.sessionId).toBe(newSessionId);
      expect(session.model).toBe('new-model');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // I2.20: Session Statistics with Multiple Agents
  // ═══════════════════════════════════════════════════════════════════════════

  describe('I2.20: Session statistics with multiple agents', () => {
    it('should track session count correctly', async () => {
      const initialCount = sessionManager.getSessionCount();

      // Create multiple sessions
      for (let i = 0; i < 5; i++) {
        await sessionManager.createSession({
          sessionId: `${sessionId}_${i}`,
          model: 'test-model',
          skipProjectDetection: true,
        });
      }

      expect(sessionManager.getSessionCount()).toBe(initialCount + 5);
    });

    it('should track session statistics by project type', async () => {
      // Create sessions with different project types
      await sessionManager.createSession({
        sessionId: `${sessionId}_node`,
        model: 'test-model',
        skipProjectDetection: true,
      });
      await sessionManager.updateSession(`${sessionId}_node`, {
        projectType: 'node',
      });

      await sessionManager.createSession({
        sessionId: `${sessionId}_php`,
        model: 'test-model',
        skipProjectDetection: true,
      });
      await sessionManager.updateSession(`${sessionId}_php`, {
        projectType: 'php',
      });

      const stats = await sessionManager.getStats();
      expect(stats.totalSessions).toBeGreaterThanOrEqual(2);
    });

    it('should list sessions filtered by project type', async () => {
      // Create multiple sessions with different types
      for (let i = 0; i < 3; i++) {
        const sess = await sessionManager.createSession({
          sessionId: `${sessionId}_node_${i}`,
          model: 'test-model',
          skipProjectDetection: true,
        });
        await sessionManager.updateSession(sess.sessionId, { projectType: 'node' });
      }

      for (let i = 0; i < 2; i++) {
        const sess = await sessionManager.createSession({
          sessionId: `${sessionId}_php_${i}`,
          model: 'test-model',
          skipProjectDetection: true,
        });
        await sessionManager.updateSession(sess.sessionId, { projectType: 'php' });
      }

      const nodeSessions = await sessionManager.listSessions({ projectType: 'node' });
      const phpSessions = await sessionManager.listSessions({ projectType: 'php' });

      expect(nodeSessions.length).toBe(3);
      expect(phpSessions.length).toBe(2);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // I2.21: Session Expiration and Cleanup with Active Agents
  // ═══════════════════════════════════════════════════════════════════════════

  describe('I2.21: Session expiration and cleanup', () => {
    it('should handle session deletion while agents exist', async () => {
      const session = await sessionManager.createSession({
        sessionId,
        model: 'test-model',
        skipProjectDetection: true,
      });

      // Register agents
      await agentMonitor.registerAgent('Agent-1', 'worker', session.sessionId, 'opencode-mcp');
      await agentMonitor.registerAgent('Agent-2', 'worker', session.sessionId, 'opencode-mcp');

      // Delete session
      const deleted = await sessionManager.deleteSession(session.sessionId);
      expect(deleted).toBe(true);

      // Session should be gone
      const retrieved = await sessionManager.getSession(session.sessionId);
      expect(retrieved).toBeNull();

      // Agents should still exist (orphaned but valid)
      const agents = await agentMonitor.listAgents(session.sessionId);
      expect(agents.length).toBe(2);
    });

    it('should handle session with context clearing', async () => {
      const session = await sessionManager.createSession({
        sessionId,
        model: 'test-model',
        skipProjectDetection: true,
      });

      // Add context
      for (let i = 0; i < 5; i++) {
        await contextStorage.saveContext({
          id: `ctx_clear_${i}`,
          sessionId: session.sessionId,
          serverId: 'opencode-mcp',
          toolName: 'test-tool',
          timestamp: Date.now() + i,
          ttl: 3600,
          args: {},
          output: {},
          summary: `Context ${i}`,
          tags: [],
        });
      }

      // Clear context
      await contextStorage.clearSession(session.sessionId);

      // Context should be cleared
      const history = await contextStorage.getSessionHistory(session.sessionId, 10);
      expect(history.length).toBe(0);

      // Session should still exist
      const retrievedSession = await sessionManager.getSession(session.sessionId);
      expect(retrievedSession).not.toBeNull();
    });

    it('should maintain session integrity during concurrent deletions', async () => {
      // Create multiple sessions
      const sessions = [];
      for (let i = 0; i < 5; i++) {
        const sess = await sessionManager.createSession({
          sessionId: `${sessionId}_del_${i}`,
          model: 'test-model',
          skipProjectDetection: true,
        });
        sessions.push(sess);
      }

      // Delete some sessions concurrently
      const deleteTargets = sessions.slice(0, 3);
      const tasks = deleteTargets.map((s) => ({
        name: `delete-${s.sessionId}`,
        fn: () => sessionManager.deleteSession(s.sessionId),
      }));

      await runConcurrentTasks(tasks);

      // Verify deletions
      for (const s of deleteTargets) {
        const retrieved = await sessionManager.getSession(s.sessionId);
        expect(retrieved).toBeNull();
      }

      // Remaining sessions should be intact
      for (const s of sessions.slice(3)) {
        const retrieved = await sessionManager.getSession(s.sessionId);
        expect(retrieved).not.toBeNull();
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Integration Scenario: Full Session Sharing Workflow
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Full session sharing workflow scenario', () => {
    it('should coordinate multiple agents in a shared session workflow', async () => {
      // 1. Create a shared session
      const session = await sessionManager.createSession({
        sessionId,
        model: 'claude-sonnet',
        cwd: '/test/project',
        skipProjectDetection: true,
        metadata: { workflow: 'ask-ai', startedAt: Date.now() },
      });

      // 2. Register supervisor
      const supervisor = await agentMonitor.registerAgent(
        'Supervisor',
        'supervisor',
        session.sessionId,
        'opencode-mcp',
        'claude-opus'
      );

      // 3. Register workers
      const workers = [];
      for (let i = 0; i < 3; i++) {
        const worker = await agentMonitor.registerAgent(
          `Reviewer-${i}`,
          'worker',
          session.sessionId,
          'opencode-mcp',
          'claude-sonnet'
        );
        workers.push(worker);
      }

      // 4. Supervisor sends tasks to workers
      for (let i = 0; i < workers.length; i++) {
        await agentMonitor.sendMessage(
          supervisor!.id,
          workers[i]!.id,
          session.sessionId,
          `Review module ${i}`,
          'chat'
        );
        await agentMonitor.updateAgentStatus(workers[i]!.id, 'processing', `Reviewing module ${i}`);
      }

      // 5. Workers write context
      for (let i = 0; i < workers.length; i++) {
        await contextStorage.saveContext({
          id: `review_${i}`,
          sessionId: session.sessionId,
          serverId: 'opencode-mcp',
          toolName: 'ask-ai',
          timestamp: Date.now() + i,
          ttl: 3600,
          args: { files: `module${i}.ts` },
          output: { issues: [], score: 85 + i },
          summary: `Module ${i} review completed`,
          tags: ['review', 'automated'],
        });
      }

      // 6. Update session metadata
      await sessionManager.updateSession(session.sessionId, {
        metadata: {
          ...session.metadata,
          completedModules: workers.length,
          lastUpdate: Date.now(),
        },
      });

      // 7. Verify final state
      const finalSession = await sessionManager.getSession(session.sessionId);
      const allAgents = await agentMonitor.listAgents(session.sessionId);
      const allContext = await contextStorage.getSessionHistory(session.sessionId, 10);
      const messages = await agentMonitor.getMessageHistory(session.sessionId, 20);

      expect(finalSession).not.toBeNull();
      expect(finalSession?.metadata.completedModules).toBe(3);
      expect(allAgents.length).toBe(4); // 1 supervisor + 3 workers
      expect(allContext.length).toBe(3);
      expect(messages.length).toBeGreaterThanOrEqual(3);

      // 8. Supervisor sends completion alert
      await agentMonitor.sendAlert(
        workers.map((w) => w!.id),
        'All reviews completed. Summarizing results.',
        'Supervisor',
        'normal',
        false,
        session.sessionId
      );

      // 9. Workers complete
      for (const worker of workers) {
        await agentMonitor.updateAgentStatus(worker!.id, 'idle');
      }

      const finalAgents = await agentMonitor.listAgents(session.sessionId);
      expect(finalAgents.every((a) => a.role === 'supervisor' || a.status === 'idle')).toBe(true);
    });
  });
});
