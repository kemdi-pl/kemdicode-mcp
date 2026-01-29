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

/**
 * Agent Monitor - Real-time multi-agent supervision via Redis Pub/Sub
 *
 * Enables:
 * - Real-time monitoring of agent conversations
 * - Sending alerts/directives to agents
 * - Context injection during execution
 * - Agent lifecycle management
 */

import { Redis } from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import { Logger } from '../utils/logger.js';
import {
  McpAgent,
  AgentMessage,
  SupervisorAlert,
  ConversationSnapshot,
  RedisConfig,
  REDIS_KEYS,
  TTL,
  AgentStatus,
  AgentRole,
  MessageType,
  MessagePriority,
  ServerIdentifier,
  AgentSummary,
  QueuedMessage,
  SessionOverview,
  AgentOverview,
  WorkspaceOverview,
  BoardOverview,
  ActivityEntry,
  SessionStats,
  TaskStatus,
} from './types.js';

type MessageHandler = (message: AgentMessage) => void;
type AlertHandler = (alert: SupervisorAlert) => void;
type StatusHandler = (agent: McpAgent) => void;

export class AgentMonitor {
  private redis: Redis | null = null;
  private subscriber: Redis | null = null;
  private connected = false;
  private messageHandlers: MessageHandler[] = [];
  private alertHandlers: AlertHandler[] = [];
  private statusHandlers: StatusHandler[] = [];

  constructor(private readonly config: RedisConfig = {}) {}

  /**
   * Initialize Redis connections (main + subscriber)
   */
  async connect(): Promise<boolean> {
    if (this.connected) return true;

    try {
      const redisConfig = {
        host: this.config.host || process.env.REDIS_HOST || '127.0.0.1',
        port: this.config.port || parseInt(process.env.REDIS_PORT || '6379'),
        password: this.config.password || process.env.REDIS_PASSWORD || undefined,
        db: this.config.db ?? 2,
        keyPrefix: REDIS_KEYS.PREFIX,
        lazyConnect: false,
        maxRetriesPerRequest: 3,
      };

      // Main connection for commands
      this.redis = new Redis(redisConfig);
      await this.redis.ping();

      // Separate connection for Pub/Sub (required by Redis)
      this.subscriber = new Redis({
        ...redisConfig,
        keyPrefix: '', // No prefix for pub/sub channels
      });
      await this.subscriber.ping();

      this.connected = true;
      Logger.debug('AgentMonitor connected to Redis');
      return true;
    } catch (error) {
      Logger.error('AgentMonitor connection failed:', error);
      this.redis = null;
      this.subscriber = null;
      this.connected = false;
      return false;
    }
  }

  isConnected(): boolean {
    return this.connected && this.redis !== null;
  }

  async disconnect(): Promise<void> {
    if (this.subscriber) {
      await this.subscriber.quit();
      this.subscriber = null;
    }
    if (this.redis) {
      await this.redis.quit();
      this.redis = null;
    }
    this.connected = false;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // AGENT REGISTRATION & LIFECYCLE
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Register a new agent in the system
   */
  async registerAgent(
    name: string,
    role: AgentRole,
    sessionId: string,
    serverId: ServerIdentifier,
    model?: string,
    metadata: Record<string, unknown> = {}
  ): Promise<McpAgent | null> {
    if (!this.redis) return null;

    const agent: McpAgent = {
      id: `agent_${uuidv4().slice(0, 8)}`,
      name,
      role,
      status: 'active',
      sessionId,
      serverId,
      model,
      registeredAt: Date.now(),
      lastHeartbeat: Date.now(),
      metadata,
    };

    try {
      const key = `${REDIS_KEYS.AGENTS}${agent.id}`;
      await this.redis.setex(key, TTL.SESSION, JSON.stringify(agent));

      // Add to session's agent list
      await this.redis.sadd(`${REDIS_KEYS.AGENTS}session:${sessionId}`, agent.id);

      // Publish status update
      await this.publishStatusUpdate(agent);

      Logger.debug(`Agent registered: ${agent.id} (${name})`);
      return agent;
    } catch (error) {
      Logger.error('Failed to register agent:', error);
      return null;
    }
  }

  /**
   * Update agent status
   */
  async updateAgentStatus(
    agentId: string,
    status: AgentStatus,
    currentTask?: string
  ): Promise<boolean> {
    if (!this.redis) return false;

    try {
      const agent = await this.getAgent(agentId);
      if (!agent) return false;

      agent.status = status;
      agent.currentTask = currentTask;
      agent.lastHeartbeat = Date.now();

      const key = `${REDIS_KEYS.AGENTS}${agentId}`;
      await this.redis.setex(key, TTL.SESSION, JSON.stringify(agent));
      await this.publishStatusUpdate(agent);

      return true;
    } catch (error) {
      Logger.error('Failed to update agent status:', error);
      return false;
    }
  }

  /**
   * Get agent by ID
   */
  async getAgent(agentId: string): Promise<McpAgent | null> {
    if (!this.redis) return null;

    try {
      const data = await this.redis.get(`${REDIS_KEYS.AGENTS}${agentId}`);
      return data ? JSON.parse(data) : null;
    } catch {
      return null;
    }
  }

  /**
   * List all active agents (optionally filtered by session)
   */
  async listAgents(sessionId?: string): Promise<McpAgent[]> {
    if (!this.redis) return [];

    try {
      let agentIds: string[];

      if (sessionId) {
        agentIds = await this.redis.smembers(`${REDIS_KEYS.AGENTS}session:${sessionId}`);
      } else {
        // Scan for all agent keys
        const keys = await this.redis.keys(`${REDIS_KEYS.AGENTS}agent_*`);
        agentIds = keys.map((k) => k.replace(REDIS_KEYS.PREFIX + REDIS_KEYS.AGENTS, ''));
      }

      const agents: McpAgent[] = [];
      for (const id of agentIds) {
        const agent = await this.getAgent(id);
        if (agent && agent.status !== 'terminated') {
          agents.push(agent);
        }
      }

      return agents.sort((a, b) => b.lastHeartbeat - a.lastHeartbeat);
    } catch (error) {
      Logger.error('Failed to list agents:', error);
      return [];
    }
  }

  /**
   * Send heartbeat for an agent
   */
  async heartbeat(agentId: string): Promise<boolean> {
    if (!this.redis) return false;

    try {
      const agent = await this.getAgent(agentId);
      if (!agent) return false;

      agent.lastHeartbeat = Date.now();
      const key = `${REDIS_KEYS.AGENTS}${agentId}`;
      await this.redis.setex(key, TTL.SESSION, JSON.stringify(agent));

      // Update heartbeat timestamp
      await this.redis.setex(
        `${REDIS_KEYS.AGENT_HEARTBEAT}${agentId}`,
        60, // 1 minute TTL
        Date.now().toString()
      );

      return true;
    } catch {
      return false;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MESSAGE HANDLING
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Send a message between agents or from supervisor
   */
  async sendMessage(
    fromAgentId: string,
    toAgentId: string,
    sessionId: string,
    content: string,
    type: MessageType = 'chat',
    priority: MessagePriority = 'normal',
    data?: Record<string, unknown>,
    replyTo?: string
  ): Promise<AgentMessage | null> {
    if (!this.redis) return null;

    const message: AgentMessage = {
      id: `msg_${uuidv4().slice(0, 12)}`,
      fromAgentId,
      toAgentId,
      sessionId,
      type,
      priority,
      content,
      data,
      timestamp: Date.now(),
      acknowledged: false,
      replyTo,
    };

    try {
      // Store message in history
      const key = `${REDIS_KEYS.AGENT_MESSAGES}${sessionId}`;
      await this.redis.zadd(key, message.timestamp, JSON.stringify(message));
      await this.redis.expire(key, TTL.SESSION);

      // Publish to channel for real-time subscribers
      await this.redis.publish(
        REDIS_KEYS.PREFIX + REDIS_KEYS.CHANNEL_MESSAGES,
        JSON.stringify(message)
      );

      Logger.debug(`Message sent: ${message.id} (${type})`);
      return message;
    } catch (error) {
      Logger.error('Failed to send message:', error);
      return null;
    }
  }

  /**
   * Send an alert from supervisor (e.g., "[ALERT: Słowo od Claude Opus 4.5]")
   */
  async sendAlert(
    targetAgentIds: string[] | '*',
    content: string,
    source: string = 'Claude Opus 4.5',
    priority: MessagePriority = 'high',
    interrupt: boolean = false,
    sessionId?: string
  ): Promise<SupervisorAlert | null> {
    if (!this.redis) return null;

    const alert: SupervisorAlert = {
      id: `alert_${uuidv4().slice(0, 8)}`,
      targetAgentIds: targetAgentIds === '*' ? ['*'] : targetAgentIds,
      content,
      source,
      priority,
      timestamp: Date.now(),
      interrupt,
    };

    try {
      // Store alert
      const key = sessionId
        ? `${REDIS_KEYS.AGENT_ALERTS}${sessionId}`
        : `${REDIS_KEYS.AGENT_ALERTS}global`;

      await this.redis.zadd(key, alert.timestamp, JSON.stringify(alert));
      await this.redis.expire(key, TTL.SESSION);

      // Publish to alerts channel
      await this.redis.publish(
        REDIS_KEYS.PREFIX + REDIS_KEYS.CHANNEL_ALERTS,
        JSON.stringify(alert)
      );

      // Also send as message to each target agent
      const targets =
        targetAgentIds === '*'
          ? (await this.listAgents(sessionId)).map((a) => a.id)
          : targetAgentIds;

      for (const agentId of targets) {
        await this.sendMessage(
          'supervisor',
          agentId,
          sessionId || 'global',
          `[ALERT: ${source}] ${content}`,
          'alert',
          priority
        );
      }

      Logger.debug(`Alert sent: ${alert.id} to ${targets.length} agents`);
      return alert;
    } catch (error) {
      Logger.error('Failed to send alert:', error);
      return null;
    }
  }

  /**
   * Inject context into an agent's stream
   */
  async injectContext(
    agentId: string,
    sessionId: string,
    context: string,
    data?: Record<string, unknown>
  ): Promise<boolean> {
    const message = await this.sendMessage(
      'supervisor',
      agentId,
      sessionId,
      context,
      'context',
      'high',
      data
    );
    return message !== null;
  }

  /**
   * Send directive to change agent behavior
   */
  async sendDirective(
    agentId: string,
    sessionId: string,
    directive: string,
    data?: Record<string, unknown>
  ): Promise<boolean> {
    const message = await this.sendMessage(
      'supervisor',
      agentId,
      sessionId,
      `[DIRECTIVE] ${directive}`,
      'directive',
      'critical',
      data
    );
    return message !== null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MESSAGE HISTORY & QUERIES
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get message history for a session
   */
  async getMessageHistory(
    sessionId: string,
    limit: number = 50,
    since?: number
  ): Promise<AgentMessage[]> {
    if (!this.redis) return [];

    try {
      const key = `${REDIS_KEYS.AGENT_MESSAGES}${sessionId}`;
      const minScore = since || 0;

      const rawMessages = await this.redis.zrangebyscore(key, minScore, '+inf', 'LIMIT', 0, limit);

      return rawMessages
        .map((m) => {
          try {
            return JSON.parse(m);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    } catch (error) {
      Logger.error('Failed to get message history:', error);
      return [];
    }
  }

  /**
   * Get recent messages for an agent
   */
  async getAgentMessages(
    agentId: string,
    sessionId: string,
    limit: number = 20
  ): Promise<AgentMessage[]> {
    const history = await this.getMessageHistory(sessionId, limit * 2);
    return history
      .filter((m) => m.toAgentId === agentId || m.fromAgentId === agentId)
      .slice(0, limit);
  }

  /**
   * Get pending alerts for an agent
   */
  async getPendingAlerts(agentId: string, sessionId?: string): Promise<SupervisorAlert[]> {
    if (!this.redis) return [];

    try {
      const keys = sessionId
        ? [`${REDIS_KEYS.AGENT_ALERTS}${sessionId}`]
        : [`${REDIS_KEYS.AGENT_ALERTS}global`];

      const alerts: SupervisorAlert[] = [];

      for (const key of keys) {
        const rawAlerts = await this.redis.zrange(key, 0, -1);
        for (const raw of rawAlerts) {
          const alert: SupervisorAlert = JSON.parse(raw);
          if (alert.targetAgentIds.includes('*') || alert.targetAgentIds.includes(agentId)) {
            alerts.push(alert);
          }
        }
      }

      return alerts.sort((a, b) => b.timestamp - a.timestamp);
    } catch {
      return [];
    }
  }

  /**
   * Get full conversation snapshot
   */
  async getConversationSnapshot(
    sessionId: string,
    messageLimit: number = 30
  ): Promise<ConversationSnapshot> {
    const [agents, messages] = await Promise.all([
      this.listAgents(sessionId),
      this.getMessageHistory(sessionId, messageLimit),
    ]);

    // Get pending alerts for all agents in session
    const alertSets = await Promise.all(agents.map((a) => this.getPendingAlerts(a.id, sessionId)));
    const pendingAlerts = [...new Map(alertSets.flat().map((a) => [a.id, a])).values()];

    return {
      sessionId,
      agents,
      recentMessages: messages,
      pendingAlerts,
      snapshotAt: Date.now(),
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // REAL-TIME SUBSCRIPTIONS (Pub/Sub)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Subscribe to real-time message updates
   */
  async subscribeToMessages(handler: MessageHandler): Promise<void> {
    if (!this.subscriber) return;

    this.messageHandlers.push(handler);

    if (this.messageHandlers.length === 1) {
      await this.subscriber.subscribe(REDIS_KEYS.PREFIX + REDIS_KEYS.CHANNEL_MESSAGES);

      this.subscriber.on('message', (channel, data) => {
        if (channel.endsWith(REDIS_KEYS.CHANNEL_MESSAGES)) {
          try {
            const message: AgentMessage = JSON.parse(data);
            this.messageHandlers.forEach((h) => h(message));
          } catch {
            /* ignore parse errors */
          }
        }
      });
    }
  }

  /**
   * Subscribe to alerts
   */
  async subscribeToAlerts(handler: AlertHandler): Promise<void> {
    if (!this.subscriber) return;

    this.alertHandlers.push(handler);

    if (this.alertHandlers.length === 1) {
      await this.subscriber.subscribe(REDIS_KEYS.PREFIX + REDIS_KEYS.CHANNEL_ALERTS);

      this.subscriber.on('message', (channel, data) => {
        if (channel.endsWith(REDIS_KEYS.CHANNEL_ALERTS)) {
          try {
            const alert: SupervisorAlert = JSON.parse(data);
            this.alertHandlers.forEach((h) => h(alert));
          } catch {
            /* ignore */
          }
        }
      });
    }
  }

  /**
   * Subscribe to agent status changes
   */
  async subscribeToStatusUpdates(handler: StatusHandler): Promise<void> {
    if (!this.subscriber) return;

    this.statusHandlers.push(handler);

    if (this.statusHandlers.length === 1) {
      await this.subscriber.subscribe(REDIS_KEYS.PREFIX + REDIS_KEYS.CHANNEL_AGENT_STATUS);

      this.subscriber.on('message', (channel, data) => {
        if (channel.endsWith(REDIS_KEYS.CHANNEL_AGENT_STATUS)) {
          try {
            const agent: McpAgent = JSON.parse(data);
            this.statusHandlers.forEach((h) => h(agent));
          } catch {
            /* ignore */
          }
        }
      });
    }
  }

  private async publishStatusUpdate(agent: McpAgent): Promise<void> {
    if (!this.redis) return;

    try {
      await this.redis.publish(
        REDIS_KEYS.PREFIX + REDIS_KEYS.CHANNEL_AGENT_STATUS,
        JSON.stringify(agent)
      );
    } catch {
      /* ignore */
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // AGENT ACTIVITY SUMMARIES
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Update agent activity summary (agent reports what they're doing)
   */
  async updateAgentSummary(
    agentId: string,
    summary: Omit<AgentSummary, 'agentId' | 'updatedAt'>
  ): Promise<boolean> {
    if (!this.redis) return false;

    try {
      const fullSummary: AgentSummary = {
        ...summary,
        agentId,
        updatedAt: Date.now(),
      };

      const key = `${REDIS_KEYS.AGENT_SUMMARY}${agentId}`;
      await this.redis.setex(key, 3600, JSON.stringify(fullSummary)); // 1 hour TTL

      // Publish update for real-time monitoring
      await this.redis.publish(
        REDIS_KEYS.PREFIX + REDIS_KEYS.CHANNEL_AGENT_SUMMARY,
        JSON.stringify(fullSummary)
      );

      Logger.debug(`Agent summary updated: ${agentId}`);
      return true;
    } catch (error) {
      Logger.error('Failed to update agent summary:', error);
      return false;
    }
  }

  /**
   * Get current activity summary for an agent
   */
  async getAgentSummary(agentId: string): Promise<AgentSummary | null> {
    if (!this.redis) return null;

    try {
      const data = await this.redis.get(`${REDIS_KEYS.AGENT_SUMMARY}${agentId}`);
      return data ? JSON.parse(data) : null;
    } catch {
      return null;
    }
  }

  /**
   * Get all activity summaries for agents in a session
   */
  async getSessionSummaries(sessionId: string): Promise<AgentSummary[]> {
    if (!this.redis) return [];

    try {
      const agents = await this.listAgents(sessionId);
      const summaries: AgentSummary[] = [];

      for (const agent of agents) {
        const summary = await this.getAgentSummary(agent.id);
        if (summary) {
          summaries.push(summary);
        }
      }

      return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
    } catch (error) {
      Logger.error('Failed to get session summaries:', error);
      return [];
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MESSAGE QUEUE - Supervisor pushes messages to agents
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Queue a message for an agent
   * Messages are stored in a ZSET with priority-based scoring
   */
  async queueMessage(
    targetAgentId: string,
    sessionId: string,
    content: string,
    options: {
      priority?: MessagePriority;
      files?: string[];
      context?: Record<string, unknown>;
      forceContextChange?: boolean;
      fromAgentId?: string;
      expiresAt?: number;
    } = {}
  ): Promise<QueuedMessage | null> {
    if (!this.redis) return null;

    const priorityLevel = {
      critical: 0,
      high: 1,
      normal: 2,
      low: 3,
    };

    const priority = options.priority || 'normal';
    const message: QueuedMessage = {
      id: `qmsg_${uuidv4().slice(0, 12)}`,
      targetAgentId,
      sessionId,
      content,
      priority,
      files: options.files,
      context: options.context,
      forceContextChange: options.forceContextChange,
      createdAt: Date.now(),
      expiresAt: options.expiresAt,
      fromAgentId: options.fromAgentId || 'supervisor',
    };

    try {
      const key = `${REDIS_KEYS.AGENT_QUEUE}${targetAgentId}`;
      // Score: (4 - priorityLevel) * 1e12 + timestamp
      // Higher priority = higher score, earlier timestamp = lower score within priority
      const score = (4 - priorityLevel[priority]) * 1e12 + message.createdAt;

      await this.redis.zadd(key, score, JSON.stringify(message));
      await this.redis.expire(key, TTL.SESSION);

      Logger.debug(`Message queued for ${targetAgentId}: ${message.id} (${priority})`);
      return message;
    } catch (error) {
      Logger.error('Failed to queue message:', error);
      return null;
    }
  }

  /**
   * Get messages from agent's queue without removing them
   */
  async getMessageQueue(
    agentId: string,
    options: { limit?: number; priority?: MessagePriority } = {}
  ): Promise<QueuedMessage[]> {
    if (!this.redis) return [];

    try {
      const key = `${REDIS_KEYS.AGENT_QUEUE}${agentId}`;
      const limit = options.limit || 50;

      // Get messages in reverse order (highest score/priority first)
      const rawMessages = await this.redis.zrevrange(key, 0, limit - 1);

      const messages: QueuedMessage[] = rawMessages
        .map((m) => {
          try {
            return JSON.parse(m);
          } catch {
            return null;
          }
        })
        .filter((m: QueuedMessage | null) => {
          if (!m) return false;
          // Filter expired messages
          if (m.expiresAt && m.expiresAt < Date.now()) return false;
          // Filter by priority if specified
          if (options.priority && m.priority !== options.priority) return false;
          return true;
        });

      return messages;
    } catch (error) {
      Logger.error('Failed to get message queue:', error);
      return [];
    }
  }

  /**
   * Pop the next message from agent's queue (removes it)
   */
  async popMessage(agentId: string): Promise<QueuedMessage | null> {
    if (!this.redis) return null;

    try {
      const key = `${REDIS_KEYS.AGENT_QUEUE}${agentId}`;

      // Get and remove highest priority message
      // Using ZPOPMAX to get the message with highest score
      const result = await this.redis.zpopmax(key, 1);

      if (!result || result.length === 0) return null;

      const message: QueuedMessage = JSON.parse(result[0]);

      // Check if expired
      if (message.expiresAt && message.expiresAt < Date.now()) {
        // Message expired, try next one
        return this.popMessage(agentId);
      }

      Logger.debug(`Message popped for ${agentId}: ${message.id}`);
      return message;
    } catch (error) {
      Logger.error('Failed to pop message:', error);
      return null;
    }
  }

  /**
   * Clear all messages from agent's queue
   */
  async clearMessageQueue(agentId: string): Promise<number> {
    if (!this.redis) return 0;

    try {
      const key = `${REDIS_KEYS.AGENT_QUEUE}${agentId}`;
      const count = await this.redis.zcard(key);
      await this.redis.del(key);
      Logger.debug(`Cleared ${count} messages from queue for ${agentId}`);
      return count;
    } catch (error) {
      Logger.error('Failed to clear message queue:', error);
      return 0;
    }
  }

  /**
   * Get queue depth (number of pending messages) for an agent
   */
  async getQueueDepth(agentId: string): Promise<number> {
    if (!this.redis) return 0;

    try {
      const key = `${REDIS_KEYS.AGENT_QUEUE}${agentId}`;
      return await this.redis.zcard(key);
    } catch {
      return 0;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SESSION OVERVIEW - Hierarchical view of session state
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get comprehensive overview of a session
   * Includes: workspaces, boards, agents, tasks, activity
   */
  async getSessionOverview(sessionId: string): Promise<SessionOverview> {
    if (!this.redis) {
      return this.emptySessionOverview(sessionId);
    }

    try {
      // Get agents and their summaries
      const agents = await this.listAgents(sessionId);
      const agentOverviews: AgentOverview[] = [];

      for (const agent of agents) {
        const overview = await this.getAgentOverview(agent.id);
        if (overview) {
          agentOverviews.push(overview);
        }
      }

      // Get workspaces this session belongs to
      const workspaceIds = await this.redis.smembers(`mcp:kanban:workspaces:session:${sessionId}`);
      const workspaces: WorkspaceOverview[] = [];

      for (const wsId of workspaceIds) {
        const wsData = await this.redis.get(`mcp:kanban:workspace:${wsId}`);
        if (wsData) {
          const ws = JSON.parse(wsData);
          const boardCount = await this.redis.scard(`mcp:kanban:boards:workspace:${wsId}`);
          workspaces.push({
            id: ws.id,
            name: ws.name,
            memberCount: ws.memberSessions?.length || 0,
            boardCount,
            isOwner: ws.ownerSessionId === sessionId,
          });
        }
      }

      // Get boards for this session (including from workspaces)
      const boardIds = await this.redis.smembers(`mcp:kanban:boards:session:${sessionId}`);
      const boards: BoardOverview[] = [];

      for (const boardId of boardIds) {
        const boardData = await this.redis.get(`mcp:kanban:board:${boardId}`);
        if (boardData) {
          const board = JSON.parse(boardData);
          const taskCount = await this.redis.zcard(`mcp:kanban:board:${boardId}:tasks`);

          // Get tasks by status
          const byStatus: Record<TaskStatus, number> = {
            backlog: 0,
            in_progress: 0,
            review: 0,
            done: 0,
          };

          // Count tasks per status
          const statusKeys: TaskStatus[] = ['backlog', 'in_progress', 'review', 'done'];
          for (const status of statusKeys) {
            const count = await this.redis.scard(`mcp:kanban:status:${sessionId}:${status}`);
            byStatus[status] = count;
          }

          // Get active agents on this board
          const activeAgents = agentOverviews
            .filter((a) => a.currentTask?.boardId === boardId && a.status === 'active')
            .map((a) => a.id);

          boards.push({
            id: board.id,
            name: board.name,
            workspaceId: board.workspaceId,
            taskCount,
            byStatus,
            activeAgents,
          });
        }
      }

      // Get recent activity from messages
      const messages = await this.getMessageHistory(sessionId, 20);
      const recentActivity: ActivityEntry[] = messages.map((msg) => ({
        type: 'message' as const,
        timestamp: msg.timestamp,
        agentId: msg.fromAgentId,
        description: `${msg.fromAgentId} → ${msg.toAgentId}: ${msg.content.slice(0, 50)}...`,
        data: { messageType: msg.type },
      }));

      // Calculate stats
      const stats: SessionStats = {
        totalAgents: agents.length,
        activeAgents: agents.filter((a) => a.status === 'active' || a.status === 'processing')
          .length,
        totalTasks: boards.reduce((sum, b) => sum + b.taskCount, 0),
        tasksInProgress: boards.reduce((sum, b) => sum + b.byStatus.in_progress, 0),
        pendingMessages: await this.getTotalPendingMessages(agents.map((a) => a.id)),
        workspaceCount: workspaces.length,
        boardCount: boards.length,
      };

      return {
        sessionId,
        workspaces,
        boards,
        agents: agentOverviews,
        recentActivity: recentActivity.slice(0, 10),
        stats,
        snapshotAt: Date.now(),
      };
    } catch (error) {
      Logger.error('Failed to get session overview:', error);
      return this.emptySessionOverview(sessionId);
    }
  }

  /**
   * Get detailed overview of a single agent
   */
  async getAgentOverview(agentId: string): Promise<AgentOverview | null> {
    const agent = await this.getAgent(agentId);
    if (!agent) return null;

    const summary = await this.getAgentSummary(agentId);
    const pendingMessages = await this.getQueueDepth(agentId);

    // Get current task from kanban (if any)
    let currentTask: AgentOverview['currentTask'];
    if (this.redis) {
      try {
        const taskIds = await this.redis.smembers(`mcp:kanban:agent:${agentId}`);
        for (const taskId of taskIds) {
          const taskData = await this.redis.get(`mcp:kanban:task:${taskId}`);
          if (taskData) {
            const task = JSON.parse(taskData);
            if (task.status === 'in_progress') {
              currentTask = {
                id: task.id,
                title: task.title,
                status: task.status,
                boardId: task.boardId,
              };
              break;
            }
          }
        }
      } catch {
        /* ignore errors */
      }
    }

    return {
      id: agent.id,
      name: agent.name,
      role: agent.role,
      status: agent.status,
      summary: summary || undefined,
      currentTask,
      pendingMessages,
    };
  }

  /**
   * Helper: Get total pending messages for multiple agents
   */
  private async getTotalPendingMessages(agentIds: string[]): Promise<number> {
    let total = 0;
    for (const id of agentIds) {
      total += await this.getQueueDepth(id);
    }
    return total;
  }

  /**
   * Helper: Create empty session overview
   */
  private emptySessionOverview(sessionId: string): SessionOverview {
    return {
      sessionId,
      workspaces: [],
      boards: [],
      agents: [],
      recentActivity: [],
      stats: {
        totalAgents: 0,
        activeAgents: 0,
        totalTasks: 0,
        tasksInProgress: 0,
        pendingMessages: 0,
        workspaceCount: 0,
        boardCount: 0,
      },
      snapshotAt: Date.now(),
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // WATCH MODE - Continuous monitoring
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Watch session in real-time (returns formatted output)
   */
  async watchSession(
    sessionId: string,
    durationMs: number = 10000,
    onUpdate?: (output: string) => void
  ): Promise<string> {
    const _startTime = Date.now(); // Track for potential future timing metrics
    const outputs: string[] = [];

    const formatMessage = (msg: AgentMessage): string => {
      const time = new Date(msg.timestamp).toLocaleTimeString();
      const priority =
        msg.priority === 'critical'
          ? '🔴'
          : msg.priority === 'high'
            ? '🟠'
            : msg.priority === 'normal'
              ? '🟢'
              : '⚪';
      const type = msg.type.toUpperCase().padEnd(9);
      return `[${time}] ${priority} ${type} ${msg.fromAgentId} → ${msg.toAgentId}: ${msg.content.slice(0, 100)}`;
    };

    // Get initial snapshot
    const snapshot = await this.getConversationSnapshot(sessionId);
    outputs.push(`\n═══════════════════════════════════════════════════════════════`);
    outputs.push(`  AGENT MONITOR - Session: ${sessionId}`);
    outputs.push(`═══════════════════════════════════════════════════════════════`);
    outputs.push(`\n📊 ACTIVE AGENTS (${snapshot.agents.length}):`);

    for (const agent of snapshot.agents) {
      const status =
        agent.status === 'active'
          ? '🟢'
          : agent.status === 'processing'
            ? '🔄'
            : agent.status === 'idle'
              ? '💤'
              : '⛔';
      outputs.push(`  ${status} ${agent.name} (${agent.id}) - ${agent.role} @ ${agent.serverId}`);
      if (agent.currentTask) {
        outputs.push(`     └─ Task: ${agent.currentTask}`);
      }
    }

    outputs.push(`\n💬 RECENT MESSAGES (${snapshot.recentMessages.length}):`);
    for (const msg of snapshot.recentMessages.slice(-10)) {
      outputs.push(`  ${formatMessage(msg)}`);
    }

    if (snapshot.pendingAlerts.length > 0) {
      outputs.push(`\n⚠️  PENDING ALERTS (${snapshot.pendingAlerts.length}):`);
      for (const alert of snapshot.pendingAlerts) {
        outputs.push(`  [${alert.source}] ${alert.content}`);
      }
    }

    // Subscribe to real-time updates
    let messageCount = 0;
    await this.subscribeToMessages((msg) => {
      if (msg.sessionId === sessionId) {
        messageCount++;
        const line = `  ${formatMessage(msg)}`;
        outputs.push(line);
        if (onUpdate) onUpdate(line);
      }
    });

    // Wait for duration
    await new Promise((resolve) => setTimeout(resolve, durationMs));

    outputs.push(`\n───────────────────────────────────────────────────────────────`);
    outputs.push(`  Monitoring ended. New messages during watch: ${messageCount}`);
    outputs.push(`───────────────────────────────────────────────────────────────\n`);

    return outputs.join('\n');
  }
}

// Singleton
let monitorInstance: AgentMonitor | null = null;

export function getAgentMonitor(config?: RedisConfig): AgentMonitor {
  if (!monitorInstance) {
    monitorInstance = new AgentMonitor(config);
  }
  return monitorInstance;
}

export async function initAgentMonitor(config?: RedisConfig): Promise<AgentMonitor> {
  const monitor = getAgentMonitor(config);
  await monitor.connect();
  return monitor;
}
