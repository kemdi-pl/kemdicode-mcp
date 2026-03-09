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
 * Redis Mock for Testing
 *
 * Provides an in-memory Redis mock using ioredis-mock for isolated testing.
 * Supports all Redis operations used by the KemdiCode MCP system.
 */

import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';

// Track all created mock instances for cleanup
const mockInstances: RedisMock[] = [];

/**
 * Create a new Redis mock instance
 *
 * @param options - Optional configuration
 * @returns Redis mock instance
 */
export function createRedisMock(options: { db?: number; keyPrefix?: string } = {}): Redis {
  const mock = new RedisMock({
    data: {},
    ...options,
  });

  mockInstances.push(mock);
  return mock as unknown as Redis;
}

/**
 * Clear all data in a Redis mock
 *
 * @param redis - Redis mock instance
 */
export async function clearRedisMock(redis: Redis): Promise<void> {
  await redis.flushdb();
}

/**
 * Disconnect and cleanup all Redis mocks
 */
export async function cleanupAllMocks(): Promise<void> {
  for (const mock of mockInstances) {
    try {
      await mock.flushdb();
      await mock.quit();
    } catch {
      // Ignore cleanup errors
    }
  }
  mockInstances.length = 0;
}

/**
 * Create a mock Redis configuration for testing
 */
export function createMockRedisConfig() {
  return {
    host: '127.0.0.1',
    port: 6379,
    db: 3, // Use DB 3 for testing to avoid conflicts
  };
}

/**
 * Mock data generators for testing
 */
export const MockData = {
  /**
   * Generate a test agent
   */
  agent: (overrides: Partial<TestAgent> = {}): TestAgent => ({
    id: `agent_${randomId()}`,
    name: 'test-agent',
    role: 'worker',
    status: 'active',
    sessionId: `sess_${randomId()}`,
    serverId: 'opencode-mcp',
    model: 'test-model',
    registeredAt: Date.now(),
    lastHeartbeat: Date.now(),
    metadata: {},
    ...overrides,
  }),

  /**
   * Generate a test session
   */
  session: (overrides: Partial<TestSession> = {}): TestSession => ({
    sessionId: `sess_${randomId()}`,
    cwd: '/test/project',
    model: 'test-model',
    projectType: 'node',
    projectName: 'test-project',
    createdAt: Date.now(),
    lastAccessedAt: Date.now(),
    metadata: {},
    ...overrides,
  }),

  /**
   * Generate a test context entry
   */
  contextEntry: (overrides: Partial<TestContextEntry> = {}): TestContextEntry => ({
    id: randomId(),
    sessionId: `sess_${randomId()}`,
    serverId: 'opencode-mcp',
    toolName: 'ask-ai',
    timestamp: Date.now(),
    ttl: 3600,
    input: { files: '@src/test.ts' },
    output: { success: true },
    summary: 'Test context entry',
    tags: ['test'],
    ...overrides,
  }),

  /**
   * Generate a test message
   */
  message: (overrides: Partial<TestMessage> = {}): TestMessage => ({
    id: `msg_${randomId()}`,
    fromAgentId: 'supervisor',
    toAgentId: `agent_${randomId()}`,
    sessionId: `sess_${randomId()}`,
    type: 'chat',
    priority: 'normal',
    content: 'Test message',
    timestamp: Date.now(),
    acknowledged: false,
    ...overrides,
  }),
};

// Helper function for random IDs
function randomId(): string {
  return Math.random().toString(36).substring(2, 10);
}

// Type definitions for test data
export interface TestAgent {
  id: string;
  name: string;
  role: 'supervisor' | 'worker' | 'specialist' | 'coordinator';
  status: 'active' | 'idle' | 'processing' | 'terminated';
  sessionId: string;
  serverId: string;
  model?: string;
  currentTask?: string;
  registeredAt: number;
  lastHeartbeat: number;
  metadata: Record<string, unknown>;
}

export interface TestSession {
  sessionId: string;
  cwd: string;
  model: string;
  fallbackModel?: string;
  projectType?: string;
  projectName?: string;
  createdAt: number;
  lastAccessedAt: number;
  metadata: Record<string, unknown>;
}

export interface TestContextEntry {
  id: string;
  sessionId: string;
  serverId: string;
  toolName: string;
  timestamp: number;
  ttl: number;
  input: Record<string, unknown>;
  output: unknown;
  summary?: string;
  tags: string[];
  relatedFiles?: string[];
  errorState?: boolean;
}

export interface TestMessage {
  id: string;
  fromAgentId: string;
  toAgentId: string;
  sessionId: string;
  type: 'chat' | 'alert' | 'directive' | 'context' | 'query' | 'response' | 'status' | 'system';
  priority: 'low' | 'normal' | 'high' | 'critical';
  content: string;
  data?: Record<string, unknown>;
  timestamp: number;
  acknowledged: boolean;
  replyTo?: string;
}
