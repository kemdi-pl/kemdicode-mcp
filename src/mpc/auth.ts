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
 * MPC Authorization Module
 *
 * Provides role-based access control for MPC operations.
 * Only authorized agent roles can perform sensitive operations.
 *
 * SECURITY: Includes rate limiting to prevent brute-force attacks on agent IDs.
 */

import { getAgentMonitor } from '../context/agent-monitor.js';
import { MPC_ALLOWED_ROLES } from './types.js';
import type { AgentRole } from '../context/types.js';
import { createHmac } from 'crypto';

/**
 * Rate limiter for authorization attempts
 */
const authAttempts = new Map<string, { count: number; resetAt: number }>();
const MAX_AUTH_ATTEMPTS = 10;
const MAX_AUTH_KEYS = 1000;
const RATE_LIMIT_WINDOW_MS = 60000; // 1 minute

/**
 * MPC operation types
 */
export type MpcOperation = keyof typeof MPC_ALLOWED_ROLES;

/**
 * Authorization result
 */
export interface MpcAuthResult {
  /** Whether the agent is authorized */
  authorized: boolean;
  /** Agent's role (if found) */
  role?: AgentRole;
  /** Error message (if not authorized) */
  error?: string;
}

/**
 * Check rate limit for authorization attempts
 */
function checkRateLimit(agentId: string): { allowed: boolean; retryAfterMs?: number } {
  const now = Date.now();
  const key = `auth:${agentId}`;
  const record = authAttempts.get(key);

  if (record) {
    if (now > record.resetAt) {
      // Window expired, reset
      authAttempts.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
      return { allowed: true };
    }

    if (record.count >= MAX_AUTH_ATTEMPTS) {
      return { allowed: false, retryAfterMs: record.resetAt - now };
    }

    record.count++;
    return { allowed: true };
  }

  // Evict expired entries if map grows too large
  if (authAttempts.size > MAX_AUTH_KEYS) {
    for (const [k, v] of authAttempts) {
      if (now > v.resetAt) authAttempts.delete(k);
      if (authAttempts.size <= MAX_AUTH_KEYS) break;
    }
  }

  authAttempts.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
  return { allowed: true };
}

/**
 * Generate HMAC signature for agent verification
 * This creates a signature that can be verified later to prevent spoofing.
 */
export function generateAgentSignature(
  agentId: string,
  sessionId: string,
  timestamp: number
): string {
  const secret = process.env.MPC_MASTER_SECRET || '';
  if (!secret) {
    throw new Error('MPC_MASTER_SECRET required for agent signature generation');
  }
  const data = `${agentId}:${sessionId}:${timestamp}`;
  return createHmac('sha256', secret).update(data).digest('hex');
}

/**
 * Verify agent signature to prevent spoofing
 */
export function verifyAgentSignature(
  agentId: string,
  sessionId: string,
  timestamp: number,
  signature: string
): boolean {
  // Signature must not be older than 5 minutes
  const MAX_SIGNATURE_AGE_MS = 5 * 60 * 1000;
  if (Date.now() - timestamp > MAX_SIGNATURE_AGE_MS) {
    return false;
  }

  const expectedSignature = generateAgentSignature(agentId, sessionId, timestamp);

  // Constant-time comparison to prevent timing attacks
  if (signature.length !== expectedSignature.length) {
    return false;
  }
  let result = 0;
  for (let i = 0; i < signature.length; i++) {
    result |= signature.charCodeAt(i) ^ expectedSignature.charCodeAt(i);
  }
  return result === 0;
}

/**
 * Verify agent authorization for an MPC operation
 *
 * SECURITY: Includes rate limiting to prevent brute-force attacks.
 *
 * @param agentId - The agent ID to verify
 * @param operation - The MPC operation being performed
 * @param signature - Optional HMAC signature for enhanced security
 * @param sessionId - Session ID (required if signature provided)
 * @param timestamp - Timestamp (required if signature provided)
 * @returns Authorization result with role info or error
 */
export async function verifyMpcAuthorization(
  agentId: string,
  operation: MpcOperation,
  signature?: string,
  sessionId?: string,
  timestamp?: number
): Promise<MpcAuthResult> {
  // SECURITY: Check rate limit first
  const rateCheck = checkRateLimit(agentId);
  if (!rateCheck.allowed) {
    return {
      authorized: false,
      error:
        `Rate limit exceeded. Too many authorization attempts. ` +
        `Try again in ${Math.ceil((rateCheck.retryAfterMs || 0) / 1000)} seconds.`,
    };
  }

  const monitor = getAgentMonitor();

  // Get agent info from registry
  const agent = await monitor.getAgent(agentId);

  if (!agent) {
    return {
      authorized: false,
      error: `Agent ${agentId} not found in registry. Register agent first using agent-register tool.`,
    };
  }

  // SECURITY: If signature provided, verify it to prevent spoofing
  if (signature && sessionId && timestamp) {
    if (!verifyAgentSignature(agentId, sessionId, timestamp, signature)) {
      return {
        authorized: false,
        role: agent.role,
        error: 'Invalid or expired agent signature. Agent identity could not be verified.',
      };
    }
  }

  // Check if agent's role is allowed for this operation
  const allowedRoles = MPC_ALLOWED_ROLES[operation];
  const isAllowed = (allowedRoles as readonly string[]).includes(agent.role);

  if (!isAllowed) {
    return {
      authorized: false,
      role: agent.role,
      error:
        `Agent role '${agent.role}' is not authorized for '${operation}' operation. ` +
        `Required roles: ${allowedRoles.join(', ')}`,
    };
  }

  return {
    authorized: true,
    role: agent.role,
  };
}

/**
 * Check if an operation requires authorization
 *
 * All MPC operations except 'viewStatus' require supervisor/coordinator role.
 */
export function requiresElevatedRole(operation: MpcOperation): boolean {
  const roles = MPC_ALLOWED_ROLES[operation];
  // If workers are allowed, it's not elevated
  return !(roles as readonly string[]).includes('worker');
}

/**
 * Get human-readable description of required roles for an operation
 */
export function getRequiredRolesDescription(operation: MpcOperation): string {
  const roles = MPC_ALLOWED_ROLES[operation];
  return roles.join(' or ');
}
