/**
 * KemdiCode MCP Server - Plugin System
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
 * Plugin System
 *
 * Features:
 * - Dynamic plugin loading/unloading
 * - Hook system (before/after hooks)
 * - Middleware support
 * - Lifecycle management
 *
 * @module plugins/system
 */

export interface PluginManifest {
  name: string;
  version: string;
  description?: string;
  author?: string;
  license?: string;
}

export interface PluginContext {
  id: string;
  name: string;
  version: string;
  logger: PluginLogger;
  config: PluginConfig;
}

export interface PluginLogger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface PluginConfig {
  get<T = unknown>(key: string): T | undefined;
  set(key: string, value: unknown): void;
}

export interface PluginHooks {
  onLoad?: (context: PluginContext) => Promise<void>;
  onUnload?: () => Promise<void>;
}

export interface Plugin {
  manifest: PluginManifest;
  load(context: PluginContext): Promise<void>;
  unload(): Promise<void>;
  hooks?: PluginHooks;
}

export interface PluginLoadOptions {
  enabled?: boolean;
  priority?: number;
}

export interface PluginStats {
  loaded: number;
  failed: number;
  total: number;
  plugins: Array<{
    name: string;
    status: 'loaded' | 'failed' | 'unloaded';
    loadTime: number;
    error?: string;
  }>;
}

export class PluginSystem {
  private plugins = new Map<
    string,
    {
      manifest: PluginManifest;
      instance: Plugin;
      status: 'loaded' | 'failed' | 'unloaded';
      loadTime: number;
      error?: string;
    }
  >();
  private hooks: {
    onLoad: Array<(context: PluginContext) => Promise<void>>;
    onUnload: Array<() => Promise<void>>;
  } = { onLoad: [], onUnload: [] };
  private loadOrder: string[] = [];

  constructor() {}

  async load(manifest: PluginManifest, instance: Plugin): Promise<void> {
    const startTime = Date.now();
    const pluginId = `${manifest.name}@${manifest.version}`;

    try {
      const context: PluginContext = {
        id: pluginId,
        name: manifest.name,
        version: manifest.version,
        logger: new PluginLoggerImpl(manifest.name),
        config: new PluginConfigImpl(pluginId),
      };

      if (instance.load.length > 0) {
        await instance.load(context);
      } else {
        (instance as Plugin & { load: () => void }).load(context);
      }

      this.plugins.set(pluginId, {
        manifest,
        instance,
        status: 'loaded',
        loadTime: Date.now() - startTime,
      });

      this.loadOrder.push(pluginId);

      if (instance.hooks?.onLoad) {
        this.hooks.onLoad.push(async (ctx: PluginContext) => {
          await instance.hooks!.onLoad!(ctx);
        });
      }

      console.info(`[PluginSystem] Loaded: ${pluginId}`);
    } catch (error) {
      this.plugins.set(pluginId, {
        manifest,
        instance: null as unknown as Plugin,
        status: 'failed',
        loadTime: Date.now() - startTime,
        error: String(error),
      });
      console.error(`[PluginSystem] Failed to load ${pluginId}:`, error);
      throw error;
    }
  }

  async unload(name: string): Promise<void> {
    const plugin = this.plugins.get(name);
    if (!plugin) return;

    try {
      if (plugin.instance.hooks?.onUnload) {
        if (plugin.instance.hooks.onUnload.length > 0) {
          await plugin.instance.hooks.onUnload();
        } else {
          (plugin.instance.hooks.onUnload as () => void)();
        }
      }

      if (plugin.instance.unload.length > 0) {
        await plugin.instance.unload();
      } else {
        (plugin.instance as Plugin & { unload: () => void }).unload();
      }

      plugin.status = 'unloaded';
      this.plugins.delete(name);
      this.loadOrder = this.loadOrder.filter((p) => p !== name);

      console.info(`[PluginSystem] Unloaded: ${name}`);
    } catch (error) {
      console.error(`[PluginSystem] Error unloading ${name}:`, error);
      throw error;
    }
  }

  getPlugin(name: string): Plugin | undefined {
    return this.plugins.get(name)?.instance;
  }

  listPlugins(): PluginStats {
    const plugins: PluginStats['plugins'] = [];
    let loaded = 0;
    let failed = 0;

    for (const [id, plugin] of this.plugins) {
      plugins.push({
        name: id,
        status: plugin.status,
        loadTime: plugin.loadTime,
        error: plugin.error,
      });

      if (plugin.status === 'loaded') loaded++;
      else if (plugin.status === 'failed') failed++;
    }

    return { loaded, failed, total: this.plugins.size, plugins };
  }

  async reload(name: string): Promise<void> {
    const plugin = this.plugins.get(name);
    if (!plugin) throw new Error(`Plugin not found: ${name}`);

    const manifest = { ...plugin.manifest };
    const instance = plugin.instance;
    await this.unload(name);
    await this.load(manifest, instance);
  }

  async destroy(): Promise<void> {
    for (const name of [...this.plugins.keys()]) {
      await this.unload(name);
    }
    this.hooks = { onLoad: [], onUnload: [] };
    this.loadOrder = [];
  }
}

class PluginLoggerImpl implements PluginLogger {
  constructor(private pluginName: string) {}

  debug(message: string): void {
    console.debug(`[${this.pluginName}] DEBUG: ${message}`);
  }

  info(message: string): void {
    console.info(`[${this.pluginName}] INFO: ${message}`);
  }

  warn(message: string): void {
    console.warn(`[${this.pluginName}] WARN: ${message}`);
  }

  error(message: string): void {
    console.error(`[${this.pluginName}] ERROR: ${message}`);
  }
}

class PluginConfigImpl implements PluginConfig {
  private store = new Map<string, unknown>();

  constructor(private prefix: string) {}

  get<T = unknown>(key: string): T | undefined {
    return this.store.get(`${this.prefix}.${key}`) as T | undefined;
  }

  set(key: string, value: unknown): void {
    this.store.set(`${this.prefix}.${key}`, value);
  }
}

export const pluginSystem = new PluginSystem();
