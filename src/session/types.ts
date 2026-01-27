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
 * Session Management Types
 *
 * Defines types for session configuration, project detection,
 * and dynamic CWD resolution.
 */

import { config } from '../config/index.js';

/**
 * Supported project types for auto-detection
 */
export type ProjectType =
  | 'node'
  | 'php'
  | 'python'
  | 'rust'
  | 'go'
  | 'ruby'
  | 'java'
  | 'dotnet'
  | 'unknown';

/**
 * Session configuration for per-client state
 */
export interface SessionConfig {
  /** Unique session identifier (sess_xxx format) */
  sessionId: string;
  /** Working directory for this session */
  cwd: string;
  /** Primary model to use */
  model: string;
  /** Fallback model on quota exceeded */
  fallbackModel?: string;
  /** Auto-detected project type */
  projectType?: ProjectType;
  /** Project name (from package.json, composer.json, etc.) */
  projectName?: string;
  /** Creation timestamp (ms) */
  createdAt: number;
  /** Last access timestamp (ms) */
  lastAccessedAt: number;
  /** Custom tools enabled for this session */
  enabledTools?: string[];
  /** Session-specific environment variables */
  env?: Record<string, string>;
  /** Session metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Session update payload (partial)
 */
export type SessionUpdate = Partial<Omit<SessionConfig, 'sessionId' | 'createdAt'>>;

/**
 * CWD resolution result
 */
export interface CwdResolutionResult {
  /** Resolved working directory */
  cwd: string;
  /** How the CWD was determined */
  source: CwdSource;
  /** Whether this is a git repository */
  isGitRepo: boolean;
  /** Git root directory (if applicable) */
  gitRoot?: string;
  /** Detected project type */
  projectType: ProjectType;
  /** Project name */
  projectName?: string;
}

/**
 * Source of CWD resolution
 */
export type CwdSource =
  | 'header' // X-Project-Path header
  | 'parameter' // cwd parameter in request
  | 'env' // KEMDICODE_PROJECT_PATH environment variable
  | 'git-root' // Auto-detected git root
  | 'process-cwd' // process.cwd() fallback
  | 'explicit'; // Explicitly set via API

/**
 * Project detection result
 */
export interface ProjectInfo {
  /** Project type */
  type: ProjectType;
  /** Project name */
  name?: string;
  /** Project version */
  version?: string;
  /** Main configuration file found */
  configFile?: string;
  /** Package manager (npm, yarn, pnpm, composer, cargo, etc.) */
  packageManager?: string;
  /** Whether this is a monorepo */
  isMonorepo?: boolean;
  /** Framework detected (laravel, next, express, etc.) */
  framework?: string;
}

/**
 * Session creation options
 */
export interface CreateSessionOptions {
  /** Optional session ID (auto-generated if not provided) */
  sessionId?: string;
  /** Working directory */
  cwd?: string;
  /** Model to use */
  model: string;
  /** Fallback model */
  fallbackModel?: string;
  /** Skip project detection */
  skipProjectDetection?: boolean;
  /** Initial metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Session list query options
 */
export interface SessionListOptions {
  /** Filter by project type */
  projectType?: ProjectType;
  /** Filter by active within last N milliseconds */
  activeWithin?: number;
  /** Maximum sessions to return */
  limit?: number;
  /** Include expired sessions */
  includeExpired?: boolean;
}

/**
 * Redis keys for session storage
 */
export const SESSION_REDIS_KEYS = {
  /** Prefix for all session keys */
  PREFIX: 'mcp:session:',
  /** Session config storage */
  CONFIG: 'config:',
  /** Session index (sorted set by last access) */
  INDEX: 'index:active',
  /** Project type index */
  INDEX_PROJECT: 'index:project:',
  /** CWD index */
  INDEX_CWD: 'index:cwd:',
} as const;

/**
 * Session TTL constants (in seconds)
 *
 * Note: These values are now read from config at runtime.
 * This allows configuration via environment variables or CLI args.
 */
export const SESSION_TTL = {
  /** Active session timeout */
  get ACTIVE(): number {
    return config.get('session').activeTtl;
  },
  /** Idle session timeout */
  get IDLE(): number {
    return config.get('session').idleTtl;
  },
  /** Cleanup interval */
  get CLEANUP_INTERVAL(): number {
    return config.get('session').cleanupInterval;
  },
} as const;
