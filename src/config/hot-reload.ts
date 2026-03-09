/**
 * KemdiCode MCP Server - Config Hot-Reload System
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

import { readFileSync, watch, unwatchFile, existsSync, statSync } from 'node:fs';
import { Logger } from '../utils/logger.js';

export interface ConfigSchema {
  [key: string]: {
    type: 'string' | 'number' | 'boolean' | 'array' | 'object';
    required?: boolean;
    default?: unknown;
    validate?: (value: unknown) => boolean;
    description?: string;
  };
}

export interface ConfigChange {
  key: string;
  oldValue: unknown;
  newValue: unknown;
  timestamp: number;
  source: 'file' | 'env' | 'api';
}

export interface ConfigSource {
  type: 'file' | 'env' | 'default';
  path?: string;
  priority: number;
}

export interface HotReloadConfig {
  enableFileWatching: boolean;
  watchDebounceMs: number;
  enableValidation: boolean;
  enableRollback: boolean;
  maxRollbackAttempts: number;
}

export type ConfigCallback = (changes: ConfigChange[]) => void;

export class ConfigHotReload<T extends Record<string, unknown>> {
  private config: T;
  private schema: ConfigSchema;
  private sources: ConfigSource[] = [];
  private callbacks: ConfigCallback[] = [];
  private watchers: Map<string, () => void> = new Map();
  private version = 0;
  private history: ConfigChange[] = [];
  private pendingChanges: Map<string, { value: unknown; timestamp: number }> = new Map();
  private debounceTimer: NodeJS.Timeout | null = null;
  private hotReloadConfig: Required<HotReloadConfig>;

  constructor(initialConfig: T, schema: ConfigSchema, hotReloadConfig?: Partial<HotReloadConfig>) {
    this.config = { ...initialConfig };
    this.schema = schema;
    this.hotReloadConfig = {
      enableFileWatching: hotReloadConfig?.enableFileWatching ?? true,
      watchDebounceMs: hotReloadConfig?.watchDebounceMs ?? 500,
      enableValidation: hotReloadConfig?.enableValidation ?? true,
      enableRollback: hotReloadConfig?.enableRollback ?? true,
      maxRollbackAttempts: hotReloadConfig?.maxRollbackAttempts ?? 3,
    };
  }

  addSource(source: ConfigSource): void {
    this.sources.push(source);
    this.sources.sort((a, b) => a.priority - b.priority);
  }

  addFileSource(path: string, priority = 100): void {
    this.addSource({ type: 'file', path, priority });
    if (this.hotReloadConfig.enableFileWatching) {
      this.watchFile(path);
    }
  }

  addEnvPrefix(prefix: string, priority = 10): void {
    this.addSource({ type: 'env', priority });

    const envValues: Record<string, unknown> = {};
    for (const [key, schema] of Object.entries(this.schema)) {
      const envKey = `${prefix}_${key}`.toUpperCase().replace(/-/g, '_');
      const envValue = process.env[envKey];
      if (envValue !== undefined) {
        envValues[key] = this.parseEnvValue(envValue, schema.type);
      }
    }

    this.applyValues(envValues, 'env');
  }

  private parseEnvValue(value: string, type: string): unknown {
    let num: number;
    switch (type) {
      case 'number':
        num = parseFloat(value);
        return isNaN(num) ? value : num;
      case 'boolean':
        return value.toLowerCase() === 'true' || value === '1';
      case 'array':
        try {
          return JSON.parse(value);
        } catch {
          return value.split(',').map((v) => v.trim());
        }
      case 'object':
        try {
          return JSON.parse(value);
        } catch {
          return value;
        }
      default:
        return value;
    }
  }

  private watchFile(path: string): void {
    if (!existsSync(path)) {
      Logger.warn(`Config file not found: ${path}`);
      return;
    }

    if (this.watchers.has(path)) return;

    let lastModified = 0;
    const watcher = () => {
      try {
        const stats = statSync(path);
        if (stats.mtimeMs <= lastModified) return;
        lastModified = stats.mtimeMs;

        this.pendingChanges.set(path, {
          value: readFileSync(path, 'utf-8'),
          timestamp: Date.now(),
        });

        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
          this.processPendingChanges();
        }, this.hotReloadConfig.watchDebounceMs);
      } catch (error) {
        Logger.error(`Error watching config file ${path}:`, error);
      }
    };

    watch(path, watcher);
    this.watchers.set(path, () => unwatchFile(path));
  }

  private processPendingChanges(): void {
    for (const [path, change] of this.pendingChanges) {
      try {
        const content = change.value as string;
        let parsed: Record<string, unknown>;

        if (path.endsWith('.json')) {
          parsed = JSON.parse(content);
        } else if (path.endsWith('.js')) {
          const module = { exports: {} };
          new Function('module', 'exports', content)({ exports: module.exports }, module.exports);
          parsed = module.exports as Record<string, unknown>;
        } else {
          Logger.warn(`Unsupported config format: ${path}`);
          continue;
        }

        this.applyValues(parsed, 'file');
        this.pendingChanges.delete(path);
      } catch (error) {
        Logger.error(`Error processing config change for ${path}:`, error);
        if (this.hotReloadConfig.enableRollback) {
          this.rollback();
        }
      }
    }
  }

  private applyValues(values: Record<string, unknown>, source: ConfigChange['source']): void {
    const changes: ConfigChange[] = [];

    for (const [key, newValue] of Object.entries(values)) {
      if (!(key in this.schema)) continue;

      const oldValue = this.config[key];
      if (oldValue === newValue) continue;

      if (this.hotReloadConfig.enableValidation) {
        const schema = this.schema[key];
        if (schema.validate && !schema.validate(newValue)) {
          Logger.warn(`Invalid value for ${key}, skipping`);
          continue;
        }
      }

      changes.push({
        key,
        oldValue,
        newValue,
        timestamp: Date.now(),
        source,
      });
    }

    if (changes.length === 0) return;

    this.version++;
    for (const change of changes) {
      const key = change.key as keyof T;
      this.config[key] = change.newValue as T[typeof key];
      this.history.push(change);
      if (this.history.length > 1000) {
        this.history = this.history.slice(-500);
      }
    }

    for (const callback of this.callbacks) {
      try {
        callback(changes);
      } catch (error) {
        Logger.error('Config callback error:', error);
      }
    }

    Logger.info(`Config updated: ${changes.length} changes (version ${this.version})`);
  }

  set(key: string, value: unknown, source: ConfigChange['source'] = 'api'): void {
    if (!(key in this.schema)) {
      throw new Error(`Unknown config key: ${key}`);
    }

    if (this.hotReloadConfig.enableValidation) {
      const schema = this.schema[key];
      if (schema.validate && !schema.validate(value)) {
        throw new Error(`Invalid value for ${key}`);
      }
    }

    this.applyValues({ [key]: value }, source);
  }

  get<K extends keyof T>(key: K): T[K] {
    return this.config[key];
  }

  getAll(): T {
    return { ...this.config };
  }

  onChange(callback: ConfigCallback): () => void {
    this.callbacks.push(callback);
    return () => {
      const idx = this.callbacks.indexOf(callback);
      if (idx > -1) this.callbacks.splice(idx, 1);
    };
  }

  getVersion(): number {
    return this.version;
  }

  getHistory(): ConfigChange[] {
    return [...this.history];
  }

  rollback(targetVersion?: number): boolean {
    if (!this.hotReloadConfig.enableRollback) return false;

    const target = targetVersion ?? this.version - 1;
    const rollbackChanges = this.history.filter((c) => c.timestamp > this.version);

    if (rollbackChanges.length === 0) return false;

    for (const change of rollbackChanges.reverse()) {
      const key = change.key as keyof T;
      this.config[key] = change.oldValue as T[typeof key];
    }

    this.version = target;
    Logger.info(`Rolled back to version ${target}`);

    return true;
  }

  validate(): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    for (const [key, schema] of Object.entries(this.schema)) {
      if (schema.required && !(key in this.config)) {
        errors.push(`Missing required config: ${key}`);
      }

      if (key in this.config && schema.validate) {
        if (!schema.validate(this.config[key])) {
          errors.push(`Invalid value for ${key}`);
        }
      }
    }

    return { valid: errors.length === 0, errors };
  }

  watch(): void {
    for (const source of this.sources) {
      if (source.type === 'file' && source.path) {
        this.watchFile(source.path);
      }
    }
  }

  unwatch(): void {
    for (const [_path, unwatch] of this.watchers) {
      unwatch();
    }
    this.watchers.clear();
  }

  destroy(): void {
    this.unwatch();
    this.callbacks = [];
    this.history = [];
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
  }
}

export function createConfigHotReload<T extends Record<string, unknown>>(
  config: T,
  schema: ConfigSchema,
  hotReloadConfig?: Partial<HotReloadConfig>
): ConfigHotReload<T> {
  return new ConfigHotReload<T>(config, schema, hotReloadConfig);
}
