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
 * Level 2 Integration Tests: Multi-Agent Communication
 *
 * Tests the communication patterns between multiple agents using Pub/Sub,
 * message passing, alerts, and context injection.
 *
 * Test Cases:
 * - I2.1: Multiple agents register in same session
 * - I2.2: Agent-to-agent message exchange
 * - I2.3: Broadcast alerts to all agents
 * - I2.4: Context injection during execution
 * - I2.5: Message priority and ordering
 * - I2.6: Concurrent message sending from multiple agents
 * - I2.7: Agent status updates propagation
 * - I2.8: Directive handling by agents
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AgentMonitor } from '../../src/context/agent-monitor.js';
import {
  createSharedRedisMock,
  runConcurrentTasks,
  calculateConcurrencyMetrics,
  IntegrationIds,
  suppressConsoleForIntegration,
} from './fixtures.js';

describe('Level 2 Integration: Multi-Agent Communication', () => {
  suppressConsoleForIntegration();

  let agentMonitor: AgentMonitor;
  let sessionId: string;

  beforeEach(async () => {
    sessionId = IntegrationIds.session();
    agentMonitor = new AgentMonitor({ db: 3 });

    // Mock Redis connections
    const mockRedis = createSharedRedisMock();
    (agentMonitor as unknown as { redis: unknown }).redis = mockRedis;
    (agentMonitor as unknown as { subscriber: unknown }).subscriber = mockRedis;
    (agentMonitor as unknown as { connected: boolean }).connected = true;
  });

  afterEach(async () => {
    try {
      await agentMonitor.disconnect();
    } catch {
      // Ignore disconnect errors in tests
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // I2.1: Multiple Agents Register in Same Session
  // ═══════════════════════════════════════════════════════════════════════════

  describe('I2.1: Multiple agents register in same session', () => {
    it('should register 5 agents in the same session', async () => {
      const agentCount = 5;
      const agents = [];

      for (let i = 0; i < agentCount; i++) {
        const agent = await agentMonitor.registerAgent(
          `Worker-${i}`,
          'worker',
          sessionId,
          'opencode-mcp',
          'test-model'
        );
        agents.push(agent);
      }

      expect(agents).toHaveLength(agentCount);
      expect(agents.every((a) => a !== null)).toBe(true);
      expect(agents.every((a) => a!.sessionId === sessionId)).toBe(true);
    });

    it('should list all agents in the session', async () => {
      // Register multiple agents
      const agentIds: string[] = [];
      for (let i = 0; i < 3; i++) {
        const agent = await agentMonitor.registerAgent(
          `Agent-${i}`,
          'worker',
          sessionId,
          'opencode-mcp'
        );
        if (agent) agentIds.push(agent.id);
      }

      const listedAgents = await agentMonitor.listAgents(sessionId);
      expect(listedAgents.length).toBe(3);
      expect(listedAgents.map((a) => a.id).sort()).toEqual(agentIds.sort());
    });

    it('should assign unique IDs to each agent', async () => {
      const agents = [];
      for (let i = 0; i < 10; i++) {
        const agent = await agentMonitor.registerAgent(
          'Worker',
          'worker',
          sessionId,
          'opencode-mcp'
        );
        agents.push(agent);
      }

      const ids = agents.filter((a) => a !== null).map((a) => a!.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(10);
    });

    it('should support different agent roles in same session', async () => {
      const roles = ['supervisor', 'worker', 'specialist', 'coordinator'] as const;
      const agents = [];

      for (const role of roles) {
        const agent = await agentMonitor.registerAgent(
          `${role}-agent`,
          role,
          sessionId,
          'opencode-mcp'
        );
        agents.push(agent);
      }

      expect(agents.map((a) => a?.role).sort()).toEqual([...roles].sort());
    });

    it('should handle concurrent agent registration', async () => {
      const tasks = Array.from({ length: 10 }, (_, i) => ({
        name: `register-${i}`,
        fn: () =>
          agentMonitor.registerAgent(`Concurrent-${i}`, 'worker', sessionId, 'opencode-mcp'),
      }));

      const results = await runConcurrentTasks(tasks);
      const metrics = calculateConcurrencyMetrics(results);

      expect(metrics.successCount).toBe(10);
      expect(metrics.errorCount).toBe(0);
      // Mock Redis may not show true parallelism, so just verify it completed
      expect(metrics.parallelismFactor).toBeGreaterThanOrEqual(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // I2.2: Agent-to-Agent Message Exchange
  // ═══════════════════════════════════════════════════════════════════════════

  describe('I2.2: Agent-to-agent message exchange', () => {
    it('should send message from one agent to another', async () => {
      const sender = await agentMonitor.registerAgent(
        'Sender',
        'worker',
        sessionId,
        'opencode-mcp'
      );
      const receiver = await agentMonitor.registerAgent(
        'Receiver',
        'worker',
        sessionId,
        'opencode-mcp'
      );

      expect(sender).not.toBeNull();
      expect(receiver).not.toBeNull();

      const message = await agentMonitor.sendMessage(
        sender!.id,
        receiver!.id,
        sessionId,
        'Hello from sender'
      );

      expect(message).not.toBeNull();
      expect(message!.fromAgentId).toBe(sender!.id);
      expect(message!.toAgentId).toBe(receiver!.id);
      expect(message!.content).toBe('Hello from sender');
    });

    it('should retrieve messages for specific agent', async () => {
      const agent1 = await agentMonitor.registerAgent('A1', 'worker', sessionId, 'opencode-mcp');
      const agent2 = await agentMonitor.registerAgent('A2', 'worker', sessionId, 'opencode-mcp');

      // Send messages
      await agentMonitor.sendMessage(agent1!.id, agent2!.id, sessionId, 'Message 1');
      await agentMonitor.sendMessage(agent1!.id, agent2!.id, sessionId, 'Message 2');
      await agentMonitor.sendMessage(agent2!.id, agent1!.id, sessionId, 'Reply 1');

      const agent2Messages = await agentMonitor.getAgentMessages(agent2!.id, sessionId, 10);

      expect(agent2Messages.length).toBeGreaterThanOrEqual(2);
      expect(agent2Messages.some((m) => m.content === 'Message 1')).toBe(true);
    });

    it('should support all message types', async () => {
      const agent = await agentMonitor.registerAgent('MsgAgent', 'worker', sessionId, 'opencode-mcp');
      const types = ['chat', 'alert', 'directive', 'context', 'query', 'response'] as const;

      for (const type of types) {
        const msg = await agentMonitor.sendMessage(
          'supervisor',
          agent!.id,
          sessionId,
          `${type} message`,
          type
        );
        expect(msg).not.toBeNull();
        expect(msg!.type).toBe(type);
      }
    });

    it('should maintain message ordering in history', async () => {
      const agent = await agentMonitor.registerAgent('OrderAgent', 'worker', sessionId, 'opencode-mcp');

      // Send messages with slight delays to ensure ordering
      for (let i = 0; i < 5; i++) {
        await agentMonitor.sendMessage('supervisor', agent!.id, sessionId, `Message ${i}`);
        await new Promise((r) => setTimeout(r, 10));
      }

      const history = await agentMonitor.getMessageHistory(sessionId, 10);
      const contents = history.map((m) => m.content);

      expect(contents).toContain('Message 0');
      expect(contents).toContain('Message 4');

      // Verify chronological order
      for (let i = 1; i < history.length; i++) {
        expect(history[i].timestamp).toBeGreaterThanOrEqual(history[i - 1].timestamp);
      }
    });

    it('should handle bidirectional communication', async () => {
      const agent1 = await agentMonitor.registerAgent('Bi1', 'worker', sessionId, 'opencode-mcp');
      const agent2 = await agentMonitor.registerAgent('Bi2', 'worker', sessionId, 'opencode-mcp');

      // Simulate back-and-forth conversation
      const msg1 = await agentMonitor.sendMessage(
        agent1!.id,
        agent2!.id,
        sessionId,
        'Question?'
      );
      const msg2 = await agentMonitor.sendMessage(
        agent2!.id,
        agent1!.id,
        sessionId,
        'Answer!',
        'response',
        'normal',
        undefined,
        msg1!.id
      );

      expect(msg2!.replyTo).toBe(msg1!.id);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // I2.3: Broadcast Alerts to All Agents
  // ═══════════════════════════════════════════════════════════════════════════

  describe('I2.3: Broadcast alerts to all agents', () => {
    it('should broadcast alert to all agents in session', async () => {
      // Register multiple agents
      for (let i = 0; i < 3; i++) {
        await agentMonitor.registerAgent(`Worker-${i}`, 'worker', sessionId, 'opencode-mcp');
      }

      const alert = await agentMonitor.sendAlert(
        '*',
        'Important broadcast message',
        'Supervisor',
        'high',
        false,
        sessionId
      );

      expect(alert).not.toBeNull();
      expect(alert!.targetAgentIds).toContain('*');
      expect(alert!.content).toBe('Important broadcast message');
    });

    it('should send alert to specific agents', async () => {
      const agents = [];
      for (let i = 0; i < 3; i++) {
        const agent = await agentMonitor.registerAgent(
          `Worker-${i}`,
          'worker',
          sessionId,
          'opencode-mcp'
        );
        agents.push(agent);
      }

      const targetIds = [agents[0]!.id, agents[1]!.id];
      const alert = await agentMonitor.sendAlert(
        targetIds,
        'Targeted message',
        'Supervisor',
        'normal',
        false,
        sessionId
      );

      expect(alert!.targetAgentIds).toEqual(targetIds);
    });

    it('should support different priority levels', async () => {
      const agent = await agentMonitor.registerAgent('PrioAgent', 'worker', sessionId, 'opencode-mcp');
      const priorities = ['low', 'normal', 'high', 'critical'] as const;

      for (const priority of priorities) {
        const alert = await agentMonitor.sendAlert(
          [agent!.id],
          `${priority} priority alert`,
          'Supervisor',
          priority,
          false,
          sessionId
        );
        expect(alert!.priority).toBe(priority);
      }
    });

    it('should create interrupt alerts', async () => {
      const agent = await agentMonitor.registerAgent('IntAgent', 'worker', sessionId, 'opencode-mcp');

      const alert = await agentMonitor.sendAlert(
        [agent!.id],
        'STOP IMMEDIATELY',
        'Supervisor',
        'critical',
        true,
        sessionId
      );

      expect(alert!.interrupt).toBe(true);
    });

    it('should get pending alerts for agent', async () => {
      const agent = await agentMonitor.registerAgent('AlertAgent', 'worker', sessionId, 'opencode-mcp');

      await agentMonitor.sendAlert([agent!.id], 'Alert 1', 'Source1', 'normal', false, sessionId);
      await agentMonitor.sendAlert([agent!.id], 'Alert 2', 'Source2', 'high', false, sessionId);

      const pendingAlerts = await agentMonitor.getPendingAlerts(agent!.id, sessionId);
      expect(pendingAlerts.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // I2.4: Context Injection During Execution
  // ═══════════════════════════════════════════════════════════════════════════

  describe('I2.4: Context injection during execution', () => {
    it('should inject context into running agent', async () => {
      const agent = await agentMonitor.registerAgent('CtxAgent', 'worker', sessionId, 'opencode-mcp');
      await agentMonitor.updateAgentStatus(agent!.id, 'processing', 'Analyzing code');

      const success = await agentMonitor.injectContext(
        agent!.id,
        sessionId,
        'Additional context: The code uses React 18 with concurrent features'
      );

      expect(success).toBe(true);

      const messages = await agentMonitor.getAgentMessages(agent!.id, sessionId, 10);
      expect(messages.some((m) => m.type === 'context')).toBe(true);
    });

    it('should inject context with additional data', async () => {
      const agent = await agentMonitor.registerAgent('DataAgent', 'worker', sessionId, 'opencode-mcp');

      const contextData = {
        framework: 'React',
        version: '18.2',
        features: ['hooks', 'concurrent mode'],
      };

      const success = await agentMonitor.injectContext(
        agent!.id,
        sessionId,
        'Framework information attached',
        contextData
      );

      expect(success).toBe(true);

      const messages = await agentMonitor.getAgentMessages(agent!.id, sessionId, 10);
      const contextMsg = messages.find((m) => m.type === 'context');
      expect(contextMsg?.data).toEqual(contextData);
    });

    it('should handle multiple context injections', async () => {
      const agent = await agentMonitor.registerAgent('MultiCtx', 'worker', sessionId, 'opencode-mcp');

      for (let i = 0; i < 5; i++) {
        await agentMonitor.injectContext(agent!.id, sessionId, `Context piece ${i}`);
      }

      const messages = await agentMonitor.getAgentMessages(agent!.id, sessionId, 20);
      const contextMessages = messages.filter((m) => m.type === 'context');
      expect(contextMessages.length).toBeGreaterThanOrEqual(5);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // I2.5: Message Priority and Ordering
  // ═══════════════════════════════════════════════════════════════════════════

  describe('I2.5: Message priority and ordering', () => {
    it('should preserve message priority in history', async () => {
      const agent = await agentMonitor.registerAgent('PrioMsgAgent', 'worker', sessionId, 'opencode-mcp');
      const priorities = ['low', 'normal', 'high', 'critical'] as const;

      for (const priority of priorities) {
        await agentMonitor.sendMessage(
          'supervisor',
          agent!.id,
          sessionId,
          `${priority} message`,
          'chat',
          priority
        );
      }

      const history = await agentMonitor.getMessageHistory(sessionId, 10);
      expect(history.length).toBeGreaterThanOrEqual(4);

      // Check that all priorities are present
      const foundPriorities = history.map((m) => m.priority);
      for (const p of priorities) {
        expect(foundPriorities).toContain(p);
      }
    });

    it('should support filtering messages by timestamp', async () => {
      const agent = await agentMonitor.registerAgent('TimeAgent', 'worker', sessionId, 'opencode-mcp');

      const beforeTimestamp = Date.now();
      await new Promise((r) => setTimeout(r, 50));

      await agentMonitor.sendMessage('supervisor', agent!.id, sessionId, 'After timestamp');

      const history = await agentMonitor.getMessageHistory(sessionId, 10, beforeTimestamp);
      expect(history.length).toBeGreaterThanOrEqual(1);
      expect(history.every((m) => m.timestamp >= beforeTimestamp)).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // I2.6: Concurrent Message Sending
  // ═══════════════════════════════════════════════════════════════════════════

  describe('I2.6: Concurrent message sending from multiple agents', () => {
    it('should handle concurrent messages from multiple senders', async () => {
      const receiver = await agentMonitor.registerAgent(
        'Receiver',
        'coordinator',
        sessionId,
        'opencode-mcp'
      );

      const senders = [];
      for (let i = 0; i < 5; i++) {
        const sender = await agentMonitor.registerAgent(
          `Sender-${i}`,
          'worker',
          sessionId,
          'opencode-mcp'
        );
        senders.push(sender);
      }

      const tasks = senders.map((sender, i) => ({
        name: `send-${i}`,
        fn: () =>
          agentMonitor.sendMessage(
            sender!.id,
            receiver!.id,
            sessionId,
            `Message from sender ${i}`
          ),
      }));

      const results = await runConcurrentTasks(tasks);
      const metrics = calculateConcurrencyMetrics(results);

      expect(metrics.successCount).toBe(5);
      expect(metrics.errorCount).toBe(0);
    });

    it('should maintain message integrity under concurrent load', async () => {
      const agent = await agentMonitor.registerAgent('LoadAgent', 'worker', sessionId, 'opencode-mcp');
      const messageCount = 20;

      const tasks = Array.from({ length: messageCount }, (_, i) => ({
        name: `msg-${i}`,
        fn: () =>
          agentMonitor.sendMessage(
            'supervisor',
            agent!.id,
            sessionId,
            `Concurrent message ${i}: ${Date.now()}`
          ),
      }));

      await runConcurrentTasks(tasks);

      const history = await agentMonitor.getMessageHistory(sessionId, 50);
      expect(history.length).toBeGreaterThanOrEqual(messageCount);

      // Verify all messages are properly formed
      history.forEach((msg) => {
        expect(msg.id).toMatch(/^msg_/);
        expect(msg.sessionId).toBe(sessionId);
        expect(msg.timestamp).toBeGreaterThan(0);
      });
    });

    it('should handle bidirectional concurrent communication', async () => {
      const agent1 = await agentMonitor.registerAgent('BiConc1', 'worker', sessionId, 'opencode-mcp');
      const agent2 = await agentMonitor.registerAgent('BiConc2', 'worker', sessionId, 'opencode-mcp');

      const tasks = [
        ...Array.from({ length: 10 }, (_, i) => ({
          name: `a1-to-a2-${i}`,
          fn: () =>
            agentMonitor.sendMessage(agent1!.id, agent2!.id, sessionId, `1->2: ${i}`),
        })),
        ...Array.from({ length: 10 }, (_, i) => ({
          name: `a2-to-a1-${i}`,
          fn: () =>
            agentMonitor.sendMessage(agent2!.id, agent1!.id, sessionId, `2->1: ${i}`),
        })),
      ];

      const results = await runConcurrentTasks(tasks);
      expect(results.every((r) => !r.error)).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // I2.7: Agent Status Updates Propagation
  // ═══════════════════════════════════════════════════════════════════════════

  describe('I2.7: Agent status updates propagation', () => {
    it('should update agent status across all operations', async () => {
      const agent = await agentMonitor.registerAgent('StatusAgent', 'worker', sessionId, 'opencode-mcp');

      // Active -> Processing
      await agentMonitor.updateAgentStatus(agent!.id, 'processing', 'Running code review');
      let status = await agentMonitor.getAgent(agent!.id);
      expect(status?.status).toBe('processing');
      expect(status?.currentTask).toBe('Running code review');

      // Processing -> Idle
      await agentMonitor.updateAgentStatus(agent!.id, 'idle');
      status = await agentMonitor.getAgent(agent!.id);
      expect(status?.status).toBe('idle');

      // Idle -> Terminated
      await agentMonitor.updateAgentStatus(agent!.id, 'terminated');
      status = await agentMonitor.getAgent(agent!.id);
      expect(status?.status).toBe('terminated');
    });

    it('should filter out terminated agents from listing', async () => {
      const agent1 = await agentMonitor.registerAgent('Active1', 'worker', sessionId, 'opencode-mcp');
      const agent2 = await agentMonitor.registerAgent('ToTerminate', 'worker', sessionId, 'opencode-mcp');

      await agentMonitor.updateAgentStatus(agent2!.id, 'terminated');

      const activeAgents = await agentMonitor.listAgents(sessionId);
      expect(activeAgents.find((a) => a.id === agent1!.id)).toBeDefined();
      expect(activeAgents.find((a) => a.id === agent2!.id)).toBeUndefined();
    });

    it('should update heartbeat on status change', async () => {
      const agent = await agentMonitor.registerAgent('HeartAgent', 'worker', sessionId, 'opencode-mcp');
      const initialHeartbeat = agent!.lastHeartbeat;

      await new Promise((r) => setTimeout(r, 50));

      await agentMonitor.updateAgentStatus(agent!.id, 'processing');
      const updated = await agentMonitor.getAgent(agent!.id);

      expect(updated!.lastHeartbeat).toBeGreaterThan(initialHeartbeat);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // I2.8: Directive Handling by Agents
  // ═══════════════════════════════════════════════════════════════════════════

  describe('I2.8: Directive handling by agents', () => {
    it('should send directive to agent', async () => {
      const agent = await agentMonitor.registerAgent('DirAgent', 'worker', sessionId, 'opencode-mcp');

      const success = await agentMonitor.sendDirective(
        agent!.id,
        sessionId,
        'Stop current task and prioritize security review'
      );

      expect(success).toBe(true);

      const messages = await agentMonitor.getAgentMessages(agent!.id, sessionId, 10);
      const directive = messages.find((m) => m.type === 'directive');
      expect(directive).toBeDefined();
      expect(directive!.priority).toBe('critical');
    });

    it('should send directive with structured data', async () => {
      const agent = await agentMonitor.registerAgent('StructDir', 'worker', sessionId, 'opencode-mcp');

      const directiveData = {
        action: 'change_focus',
        newPriority: 'security',
        files: ['src/auth.ts', 'src/session.ts'],
      };

      await agentMonitor.sendDirective(
        agent!.id,
        sessionId,
        'Redirect focus to security-critical files',
        directiveData
      );

      const messages = await agentMonitor.getAgentMessages(agent!.id, sessionId, 10);
      const directive = messages.find((m) => m.type === 'directive');
      expect(directive?.data).toEqual(directiveData);
    });

    it('should handle multiple directives in sequence', async () => {
      const agent = await agentMonitor.registerAgent('SeqDir', 'worker', sessionId, 'opencode-mcp');

      const directives = [
        'Pause current operation',
        'Switch to high-priority task',
        'Resume normal operations',
      ];

      for (const directive of directives) {
        await agentMonitor.sendDirective(agent!.id, sessionId, directive);
        await new Promise((r) => setTimeout(r, 10));
      }

      const messages = await agentMonitor.getAgentMessages(agent!.id, sessionId, 20);
      const directiveMessages = messages.filter((m) => m.type === 'directive');
      expect(directiveMessages.length).toBeGreaterThanOrEqual(3);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Integration Scenario: Full Multi-Agent Workflow
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Full multi-agent workflow scenario', () => {
    it('should coordinate multiple agents in a code review workflow', async () => {
      // 1. Register supervisor and workers
      const supervisor = await agentMonitor.registerAgent(
        'Supervisor',
        'supervisor',
        sessionId,
        'opencode-mcp',
        'claude-opus'
      );
      const workers = [];
      for (let i = 0; i < 3; i++) {
        const worker = await agentMonitor.registerAgent(
          `CodeReviewer-${i}`,
          'worker',
          sessionId,
          'opencode-mcp',
          'claude-sonnet'
        );
        workers.push(worker);
      }

      expect(supervisor).not.toBeNull();
      expect(workers.every((w) => w !== null)).toBe(true);

      // 2. Supervisor assigns tasks to workers
      for (let i = 0; i < workers.length; i++) {
        await agentMonitor.sendMessage(
          supervisor!.id,
          workers[i]!.id,
          sessionId,
          `Review file src/module${i}.ts`,
          'chat'
        );
        await agentMonitor.updateAgentStatus(workers[i]!.id, 'processing', `Reviewing module${i}`);
      }

      // 3. Workers report progress
      for (const worker of workers) {
        await agentMonitor.sendMessage(
          worker!.id,
          supervisor!.id,
          sessionId,
          'Review in progress...',
          'status'
        );
      }

      // 4. Supervisor injects additional context
      await agentMonitor.injectContext(
        workers[0]!.id,
        sessionId,
        'Note: This module has known performance issues',
        { priority: 'performance' }
      );

      // 5. Supervisor broadcasts alert
      await agentMonitor.sendAlert(
        workers.map((w) => w!.id),
        'Time check: 5 minutes remaining',
        'Supervisor',
        'normal',
        false,
        sessionId
      );

      // 6. Verify conversation snapshot
      const snapshot = await agentMonitor.getConversationSnapshot(sessionId, 50);

      expect(snapshot.agents.length).toBeGreaterThanOrEqual(4);
      expect(snapshot.recentMessages.length).toBeGreaterThan(0);
      expect(snapshot.sessionId).toBe(sessionId);
    });
  });
});
