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
 * MCP Client Capabilities Bridge
 *
 * Provides tools with access to client-side MCP features:
 * - Sampling (LLM completions via the client)
 * - Elicitation (structured user input forms)
 * - Roots (workspace directory listing)
 *
 * Uses the active session ID to locate the correct Server instance,
 * then delegates to the MCP SDK's built-in client request methods.
 *
 * @module client/bridge
 */

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { ClientCapabilities } from '@modelcontextprotocol/sdk/types.js';
import { getActiveSessionId } from '../kanban/resolvers.js';
import { getAllSessionServers } from '../server/session-server.js';

type ClientCapabilityName = 'sampling' | 'elicitation' | 'roots';

/** Get the Server instance for the current active session */
export function getActiveServer(): Server | undefined {
  const sessionId = getActiveSessionId();
  if (!sessionId) return undefined;
  return getAllSessionServers().get(sessionId);
}

/** Get capabilities of the connected client, or undefined if not initialized */
export function getClientCapabilities(): ClientCapabilities | undefined {
  const server = getActiveServer();
  return server?.getClientCapabilities();
}

/** Check if a specific capability is supported by the connected client */
export function hasCapability(cap: ClientCapabilityName): boolean {
  const caps = getClientCapabilities();
  if (!caps) return false;
  switch (cap) {
    case 'sampling':
      return !!caps.sampling;
    case 'elicitation':
      return !!caps.elicitation;
    case 'roots':
      return !!caps.roots;
  }
}

/** Get all supported capabilities as a record */
export function getSupportedCapabilities(): Record<ClientCapabilityName, boolean> {
  return {
    sampling: hasCapability('sampling'),
    elicitation: hasCapability('elicitation'),
    roots: hasCapability('roots'),
  };
}

/** Get client name/version string */
export function getClientVersion(): string {
  const server = getActiveServer();
  const version = server?.getClientVersion();
  return version ? `${version.name} ${version.version}` : 'unknown';
}

/**
 * Send a sampling/createMessage request to the connected client.
 * The client's LLM will process the messages and return a response.
 */
export async function clientCreateMessage(
  params: {
    messages: Array<{ role: 'user' | 'assistant'; content: { type: string; text?: string; data?: string; mimeType?: string } }>;
    systemPrompt?: string;
    maxTokens: number;
    temperature?: number;
    modelPreferences?: {
      hints?: Array<{ name?: string }>;
      costPriority?: number;
      speedPriority?: number;
      intelligencePriority?: number;
    };
    includeContext?: 'none' | 'thisServer' | 'allServers';
  },
): Promise<{ role: string; content: { type: string; text?: string }; model: string; stopReason: string }> {
  if (!hasCapability('sampling')) {
    throw new Error(`Client does not support sampling. Connected client: ${getClientVersion()}`);
  }
  const server = getActiveServer();
  if (!server) throw new Error('No active session server');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return server.createMessage(params as any) as any;
}

/**
 * Send an elicitation/create request to the connected client.
 * The client will display a form to the user and return their response.
 */
export async function clientElicitInput(
  params: {
    message: string;
    requestedSchema: {
      type: 'object';
      properties: Record<string, unknown>;
      required?: string[];
    };
  },
): Promise<{ action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> }> {
  if (!hasCapability('elicitation')) {
    throw new Error(`Client does not support elicitation. Connected client: ${getClientVersion()}`);
  }
  const server = getActiveServer();
  if (!server) throw new Error('No active session server');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return server.elicitInput(params as any) as any;
}

/**
 * Send a roots/list request to the connected client.
 * Returns the workspace directories the client has open.
 */
export async function clientListRoots(): Promise<{ roots: Array<{ uri: string; name?: string }> }> {
  if (!hasCapability('roots')) {
    throw new Error(`Client does not support roots/list. Connected client: ${getClientVersion()}`);
  }
  const server = getActiveServer();
  if (!server) throw new Error('No active session server');
  return server.listRoots();
}
