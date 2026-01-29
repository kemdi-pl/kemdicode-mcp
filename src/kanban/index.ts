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
 * Kanban Module
 *
 * Agent task management with supervisor oversight.
 * Supports multi-board, workspace-based cross-session collaboration,
 * and role-based membership.
 *
 * @module kanban
 */

// Core types
export * from './types.js';

// Task management (legacy + multi-board)
export * from './kanban-store.js';

// Multi-board extension
export * from './workspace-store.js';
export * from './board-store.js';
export * from './membership-store.js';

// Migration utilities
export * from './migration.js';
