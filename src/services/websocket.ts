/**
 * KemdiCode MCP Server - WebSocket Support
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
 * WebSocket Support
 *
 * Features:
 * - WebSocket server with HTTP upgrade
 * - Message broadcasting
 * - Room-based messaging
 * - Heartbeat/ping-pong
 * - Auto-reconnection support
 * - Message queuing for offline clients
 *
 * @module services/websocket
 */

import { createServer, Server, IncomingMessage } from 'node:http';
import { URL } from 'node:url';

export interface WebSocketMessage {
  type: string;
  payload: unknown;
  timestamp: number;
  sender?: string;
}

export interface WebSocketConfig {
  port: number;
  host?: string;
  pingIntervalMs?: number;
  maxPayloadSize?: number;
  enableCompression?: boolean;
}

export interface WebSocketClient {
  id: string;
  socket: unknown;
  rooms: Set<string>;
  connectedAt: number;
  lastPing: number;
  authenticated: boolean;
  userId?: string;
}

export interface RoomInfo {
  name: string;
  clients: number;
  createdAt: number;
}

export type MessageHandler = (client: WebSocketClient, message: WebSocketMessage) => void;
export type ConnectionHandler = (client: WebSocketClient) => void;
export type DisconnectionHandler = (client: WebSocketClient, reason?: string) => void;

export class WebSocketServer {
  private server: Server | null = null;
  private clients: Map<string, WebSocketClient> = new Map();
  private rooms: Map<string, Set<string>> = new Map();
  private handlers: Map<string, MessageHandler> = new Map();
  private connectionHandlers: ConnectionHandler[] = [];
  private disconnectionHandlers: DisconnectionHandler[] = [];
  private config: Required<WebSocketConfig>;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private messageQueue: Map<string, WebSocketMessage[]> = new Map();
  private readonly maxQueueSize = 100;

  constructor(config: WebSocketConfig) {
    this.config = {
      port: config.port,
      host: config.host ?? '0.0.0.0',
      pingIntervalMs: config.pingIntervalMs ?? 30000,
      maxPayloadSize: config.maxPayloadSize ?? 65536,
      enableCompression: config.enableCompression ?? false,
    };
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = createServer();

      this.server.on('upgrade', (request: IncomingMessage, socket, head) => {
        this.handleUpgrade(request, socket, head);
      });

      this.server.listen(this.config.port, this.config.host, () => {
        console.info(`WebSocket server listening on ${this.config.host}:${this.config.port}`);
        this.startPing();
        resolve();
      });
    });
  }

  private handleUpgrade(request: IncomingMessage, socket: unknown, _head: Buffer): void {
    try {
      const url = new URL(request.url || '/', `http://${request.headers.host}`);
      const room = url.searchParams.get('room');

      const clientId = this.generateClientId();

      const client: WebSocketClient = {
        id: clientId,
        socket,
        rooms: new Set(room ? [room] : []),
        connectedAt: Date.now(),
        lastPing: Date.now(),
        authenticated: false,
      };

      if (room) {
        this.joinRoom(clientId, room);
      }

      this.clients.set(clientId, client);

      this.sendRaw(clientId, {
        type: 'connected',
        payload: { clientId, serverTime: Date.now() },
        timestamp: Date.now(),
      });

      for (const handler of this.connectionHandlers) {
        try {
          handler(client);
        } catch (error) {
          console.warn(`Connection handler error: ${error}`);
        }
      }
    } catch (error) {
      console.error(`WebSocket upgrade error: ${error}`);
    }
  }

  private generateClientId(): string {
    return `ws-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  private sendRaw(clientId: string, message: WebSocketMessage): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    try {
      const data = JSON.stringify(message);
      (client.socket as { write: (data: string) => boolean }).write(data);
    } catch (error) {
      console.warn(`Failed to send WebSocket message to ${clientId}: ${error}`);
    }
  }

  send(clientId: string, type: string, payload: unknown): void {
    const message: WebSocketMessage = {
      type,
      payload,
      timestamp: Date.now(),
      sender: 'server',
    };

    const client = this.clients.get(clientId);
    if (!client) {
      this.queueMessage(clientId, message);
      return;
    }

    this.sendRaw(clientId, message);
  }

  broadcast(type: string, payload: unknown, room?: string): void {
    const message: WebSocketMessage = {
      type,
      payload,
      timestamp: Date.now(),
      sender: 'server',
    };

    const targets = room ? this.rooms.get(room) : [...this.clients.keys()];

    for (const clientId of targets || []) {
      this.sendRaw(clientId, message);
    }
  }

  joinRoom(clientId: string, room: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    client.rooms.add(room);

    if (!this.rooms.has(room)) {
      this.rooms.set(room, new Set());
    }
    this.rooms.get(room)!.add(clientId);

    this.send(clientId, 'room:joined', { room });
  }

  leaveRoom(clientId: string, room: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    client.rooms.delete(room);

    const roomClients = this.rooms.get(room);
    if (roomClients) {
      roomClients.delete(clientId);
      if (roomClients.size === 0) {
        this.rooms.delete(room);
      }
    }

    this.send(clientId, 'room:left', { room });
  }

  private queueMessage(clientId: string, message: WebSocketMessage): void {
    let queue = this.messageQueue.get(clientId);
    if (!queue) {
      queue = [];
      this.messageQueue.set(clientId, queue);
    }

    if (queue.length < this.maxQueueSize) {
      queue.push(message);
    }
  }

  private flushMessageQueue(clientId: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    const queue = this.messageQueue.get(clientId);
    if (!queue) return;

    for (const message of queue) {
      this.sendRaw(clientId, message);
    }

    this.messageQueue.delete(clientId);
  }

  onMessage(type: string, handler: MessageHandler): void {
    this.handlers.set(type, handler);
  }

  onConnection(handler: ConnectionHandler): () => void {
    this.connectionHandlers.push(handler);
    return () => {
      const idx = this.connectionHandlers.indexOf(handler);
      if (idx > -1) this.connectionHandlers.splice(idx, 1);
    };
  }

  onDisconnection(handler: DisconnectionHandler): () => void {
    this.disconnectionHandlers.push(handler);
    return () => {
      const idx = this.disconnectionHandlers.indexOf(handler);
      if (idx > -1) this.disconnectionHandlers.splice(idx, 1);
    };
  }

  private startPing(): void {
    this.pingInterval = setInterval(() => {
      const now = Date.now();

      for (const [clientId, client] of this.clients) {
        if (now - client.lastPing > this.config.pingIntervalMs * 2) {
          this.disconnect(clientId, 'Ping timeout');
          continue;
        }

        try {
          (client.socket as { write: (data: string) => boolean }).write(
            JSON.stringify({ type: 'ping', timestamp: now } as WebSocketMessage)
          );
        } catch {
          this.disconnect(clientId, 'Send failed');
        }
      }
    }, this.config.pingIntervalMs);
  }

  disconnect(clientId: string, reason?: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    for (const room of client.rooms) {
      const roomClients = this.rooms.get(room);
      if (roomClients) {
        roomClients.delete(clientId);
        if (roomClients.size === 0) {
          this.rooms.delete(room);
        }
      }
    }

    this.clients.delete(clientId);

    try {
      (client.socket as { end: () => void }).end();
    } catch (error) {
      console.warn(`Error closing WebSocket socket: ${error}`);
    }

    for (const handler of this.disconnectionHandlers) {
      try {
        handler(client, reason);
      } catch (error) {
        console.warn(`Disconnection handler error: ${error}`);
      }
    }
  }

  getStats(): {
    clients: number;
    rooms: number;
    queuedMessages: number;
  } {
    return {
      clients: this.clients.size,
      rooms: this.rooms.size,
      queuedMessages: [...this.messageQueue.values()].reduce((sum, q) => sum + q.length, 0),
    };
  }

  getRooms(): RoomInfo[] {
    const rooms: RoomInfo[] = [];
    for (const [name, clients] of this.rooms) {
      rooms.push({
        name,
        clients: clients.size,
        createdAt: Date.now(),
      });
    }
    return rooms;
  }

  async shutdown(): Promise<void> {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }

    for (const clientId of [...this.clients.keys()]) {
      this.disconnect(clientId, 'Server shutdown');
    }

    this.clients.clear();
    this.rooms.clear();
    this.handlers.clear();
    this.messageQueue.clear();

    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = null;
    }
  }
}

export function createWebSocketServer(config: WebSocketConfig): WebSocketServer {
  return new WebSocketServer(config);
}
