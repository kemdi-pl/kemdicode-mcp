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
 * Project Info Tool
 *
 * Reads project configuration files (package.json, composer.json, Cargo.toml)
 * and returns project metadata including name, version, and dependencies.
 *
 * @module tools/project/project-info
 */

import { z } from 'zod';
import { existsSync } from 'fs';
import { join, basename } from 'path';
import { UnifiedTool } from '../registry.js';
import { Logger } from '../../utils/logger.js';
import { isSilent } from '../../config/silent.js';
import { cachedReadFile } from '../../utils/async-file.js';

/**
 * Module-level cache for project info (30s TTL)
 */
let cachedInfo: { data: ProjectInfo; cwd: string; timestamp: number } | null = null;
const CACHE_TTL_MS = 30_000; // 30 seconds

/**
 * Project type enumeration
 */
type ProjectType = 'node' | 'php' | 'rust' | 'python' | 'go' | 'unknown';

/**
 * Dependency info structure
 */
interface DependencyInfo {
  name: string;
  version: string;
  dev?: boolean;
}

/**
 * Project info result structure
 */
interface ProjectInfo {
  name: string;
  version: string;
  description?: string;
  type: ProjectType;
  configFile: string;
  dependencies: DependencyInfo[];
  devDependencies: DependencyInfo[];
  scripts?: Record<string, string>;
  engines?: Record<string, string>;
  license?: string;
  author?: string;
  repository?: string;
}

const schema = z.object({
  cwd: z.string().optional().describe('Project directory'),
  includeDevDeps: z.boolean().default(true).describe('Include dev dependencies'),
  includeScripts: z.boolean().default(true).describe('Include scripts'),
});

/**
 * Parse package.json for Node.js projects
 */
async function parsePackageJson(filePath: string, includeDevDeps: boolean): Promise<ProjectInfo | null> {
  try {
    const content = JSON.parse(await cachedReadFile(filePath));
    const deps: DependencyInfo[] = [];
    const devDeps: DependencyInfo[] = [];

    if (content.dependencies) {
      for (const [name, version] of Object.entries(content.dependencies)) {
        deps.push({ name, version: String(version) });
      }
    }

    if (includeDevDeps && content.devDependencies) {
      for (const [name, version] of Object.entries(content.devDependencies)) {
        devDeps.push({ name, version: String(version), dev: true });
      }
    }

    return {
      name: content.name || basename(filePath.replace('/package.json', '')),
      version: content.version || '0.0.0',
      description: content.description,
      type: 'node',
      configFile: filePath,
      dependencies: deps,
      devDependencies: devDeps,
      scripts: content.scripts,
      engines: content.engines,
      license: content.license,
      author: typeof content.author === 'string' ? content.author : content.author?.name,
      repository:
        typeof content.repository === 'string' ? content.repository : content.repository?.url,
    };
  } catch (error) {
    Logger.warn(`Failed to parse package.json: ${error}`);
    return null;
  }
}

/**
 * Parse composer.json for PHP projects
 */
async function parseComposerJson(filePath: string, includeDevDeps: boolean): Promise<ProjectInfo | null> {
  try {
    const content = JSON.parse(await cachedReadFile(filePath));
    const deps: DependencyInfo[] = [];
    const devDeps: DependencyInfo[] = [];

    if (content.require) {
      for (const [name, version] of Object.entries(content.require)) {
        if (name !== 'php' && !name.startsWith('ext-')) {
          deps.push({ name, version: String(version) });
        }
      }
    }

    if (includeDevDeps && content['require-dev']) {
      for (const [name, version] of Object.entries(content['require-dev'])) {
        devDeps.push({ name, version: String(version), dev: true });
      }
    }

    return {
      name: content.name || basename(filePath.replace('/composer.json', '')),
      version: content.version || '0.0.0',
      description: content.description,
      type: 'php',
      configFile: filePath,
      dependencies: deps,
      devDependencies: devDeps,
      scripts: content.scripts,
      license: Array.isArray(content.license) ? content.license[0] : content.license,
      author: content.authors?.[0]?.name,
    };
  } catch (error) {
    Logger.warn(`Failed to parse composer.json: ${error}`);
    return null;
  }
}

/**
 * Parse Cargo.toml for Rust projects
 */
async function parseCargoToml(filePath: string, includeDevDeps: boolean): Promise<ProjectInfo | null> {
  try {
    const content = await cachedReadFile(filePath);
    const deps: DependencyInfo[] = [];
    const devDeps: DependencyInfo[] = [];

    // Parse [package] section
    const packageMatch = content.match(/\[package\]([\s\S]*?)(?=\[|$)/);
    const packageSection = packageMatch ? packageMatch[1] : '';

    const nameMatch = packageSection.match(/name\s*=\s*"([^"]+)"/);
    const versionMatch = packageSection.match(/version\s*=\s*"([^"]+)"/);
    const descMatch = packageSection.match(/description\s*=\s*"([^"]+)"/);
    const licenseMatch = packageSection.match(/license\s*=\s*"([^"]+)"/);
    const authorsMatch = packageSection.match(/authors\s*=\s*\[([^\]]+)\]/);

    // Parse [dependencies] section
    const depsMatch = content.match(/\[dependencies\]([\s\S]*?)(?=\[|$)/);
    if (depsMatch) {
      const depsLines = depsMatch[1].split('\n');
      for (const line of depsLines) {
        const depMatch = line.match(/^(\S+)\s*=\s*(?:"([^"]+)"|{[^}]*version\s*=\s*"([^"]+)")/);
        if (depMatch) {
          deps.push({ name: depMatch[1], version: depMatch[2] || depMatch[3] });
        }
      }
    }

    // Parse [dev-dependencies] section
    if (includeDevDeps) {
      const devDepsMatch = content.match(/\[dev-dependencies\]([\s\S]*?)(?=\[|$)/);
      if (devDepsMatch) {
        const depsLines = devDepsMatch[1].split('\n');
        for (const line of depsLines) {
          const depMatch = line.match(/^(\S+)\s*=\s*(?:"([^"]+)"|{[^}]*version\s*=\s*"([^"]+)")/);
          if (depMatch) {
            devDeps.push({ name: depMatch[1], version: depMatch[2] || depMatch[3], dev: true });
          }
        }
      }
    }

    return {
      name: nameMatch?.[1] || basename(filePath.replace('/Cargo.toml', '')),
      version: versionMatch?.[1] || '0.0.0',
      description: descMatch?.[1],
      type: 'rust',
      configFile: filePath,
      dependencies: deps,
      devDependencies: devDeps,
      license: licenseMatch?.[1],
      author: authorsMatch?.[1]?.replace(/"/g, '').split(',')[0]?.trim(),
    };
  } catch (error) {
    Logger.warn(`Failed to parse Cargo.toml: ${error}`);
    return null;
  }
}

/**
 * Parse pyproject.toml for Python projects
 */
async function parsePyprojectToml(filePath: string, includeDevDeps: boolean): Promise<ProjectInfo | null> {
  try {
    const content = await cachedReadFile(filePath);
    const deps: DependencyInfo[] = [];
    const devDeps: DependencyInfo[] = [];

    // Parse [project] or [tool.poetry] section
    const projectMatch = content.match(/\[project\]([\s\S]*?)(?=\[|$)/);
    const poetryMatch = content.match(/\[tool\.poetry\]([\s\S]*?)(?=\[|$)/);
    const section = projectMatch?.[1] || poetryMatch?.[1] || '';

    const nameMatch = section.match(/name\s*=\s*"([^"]+)"/);
    const versionMatch = section.match(/version\s*=\s*"([^"]+)"/);
    const descMatch = section.match(/description\s*=\s*"([^"]+)"/);
    const licenseMatch = section.match(/license\s*=\s*"([^"]+)"/);

    // Parse dependencies
    const depsMatch = content.match(/dependencies\s*=\s*\[([\s\S]*?)\]/);
    if (depsMatch) {
      const depLines = depsMatch[1].split('\n');
      for (const line of depLines) {
        const depMatch = line.match(/"([^">=<]+)([><=!~][^"]+)?"/);
        if (depMatch) {
          deps.push({ name: depMatch[1], version: depMatch[2] || '*' });
        }
      }
    }

    // Parse optional/dev dependencies
    if (includeDevDeps) {
      const devMatch = content.match(/\[project\.optional-dependencies\]([\s\S]*?)(?=\[|$)/);
      if (devMatch) {
        const devDepMatch = devMatch[1].match(/\[([\s\S]*?)\]/g);
        if (devDepMatch) {
          for (const block of devDepMatch) {
            const depMatches = block.matchAll(/"([^">=<]+)([><=!~][^"]+)?"/g);
            for (const match of depMatches) {
              devDeps.push({ name: match[1], version: match[2] || '*', dev: true });
            }
          }
        }
      }
    }

    return {
      name: nameMatch?.[1] || basename(filePath.replace('/pyproject.toml', '')),
      version: versionMatch?.[1] || '0.0.0',
      description: descMatch?.[1],
      type: 'python',
      configFile: filePath,
      dependencies: deps,
      devDependencies: devDeps,
      license: licenseMatch?.[1],
    };
  } catch (error) {
    Logger.warn(`Failed to parse pyproject.toml: ${error}`);
    return null;
  }
}

/**
 * Parse go.mod for Go projects
 */
async function parseGoMod(filePath: string): Promise<ProjectInfo | null> {
  try {
    const content = await cachedReadFile(filePath);
    const deps: DependencyInfo[] = [];

    // Parse module name
    const moduleMatch = content.match(/module\s+(\S+)/);
    const goVersionMatch = content.match(/go\s+(\d+\.\d+)/);

    // Parse require block
    const requireMatch = content.match(/require\s*\(([\s\S]*?)\)/);
    if (requireMatch) {
      const depLines = requireMatch[1].split('\n');
      for (const line of depLines) {
        const depMatch = line.match(/^\s*(\S+)\s+(\S+)/);
        if (depMatch && !depMatch[1].startsWith('//')) {
          deps.push({ name: depMatch[1], version: depMatch[2] });
        }
      }
    }

    // Single require statements
    const singleRequires = content.matchAll(/require\s+(\S+)\s+(\S+)/g);
    for (const match of singleRequires) {
      if (!deps.some((d) => d.name === match[1])) {
        deps.push({ name: match[1], version: match[2] });
      }
    }

    return {
      name: moduleMatch?.[1] || basename(filePath.replace('/go.mod', '')),
      version: '0.0.0',
      type: 'go',
      configFile: filePath,
      dependencies: deps,
      devDependencies: [],
      engines: goVersionMatch ? { go: goVersionMatch[1] } : undefined,
    };
  } catch (error) {
    Logger.warn(`Failed to parse go.mod: ${error}`);
    return null;
  }
}

/**
 * Detect project type and parse configuration
 */
async function detectAndParseProject(cwd: string, includeDevDeps: boolean): Promise<ProjectInfo | null> {
  const configFiles = [
    { file: 'package.json', parser: parsePackageJson },
    { file: 'composer.json', parser: parseComposerJson },
    { file: 'Cargo.toml', parser: parseCargoToml },
    { file: 'pyproject.toml', parser: parsePyprojectToml },
    { file: 'go.mod', parser: parseGoMod },
  ];

  for (const { file, parser } of configFiles) {
    const filePath = join(cwd, file);
    if (existsSync(filePath)) {
      if (file === 'go.mod') {
        return await parseGoMod(filePath);
      }
      return await parser(filePath, includeDevDeps);
    }
  }

  return null;
}

/**
 * Format project info as readable output
 */
function formatProjectInfo(info: ProjectInfo, includeScripts: boolean): string {
  const lines: string[] = [];

  lines.push(`# Project: ${info.name}`);
  lines.push(`Version: ${info.version}`);
  lines.push(`Type: ${info.type.toUpperCase()}`);
  lines.push(`Config: ${info.configFile}`);

  if (info.description) {
    lines.push(`Description: ${info.description}`);
  }
  if (info.author) {
    lines.push(`Author: ${info.author}`);
  }
  if (info.license) {
    lines.push(`License: ${info.license}`);
  }
  if (info.repository) {
    lines.push(`Repository: ${info.repository}`);
  }

  if (info.engines && Object.keys(info.engines).length > 0) {
    lines.push('\n## Engines');
    for (const [engine, version] of Object.entries(info.engines)) {
      lines.push(`- ${engine}: ${version}`);
    }
  }

  if (info.dependencies.length > 0) {
    lines.push(`\n## Dependencies (${info.dependencies.length})`);
    for (const dep of info.dependencies.slice(0, 20)) {
      lines.push(`- ${dep.name}: ${dep.version}`);
    }
    if (info.dependencies.length > 20) {
      lines.push(`... and ${info.dependencies.length - 20} more`);
    }
  }

  if (info.devDependencies.length > 0) {
    lines.push(`\n## Dev Dependencies (${info.devDependencies.length})`);
    for (const dep of info.devDependencies.slice(0, 15)) {
      lines.push(`- ${dep.name}: ${dep.version}`);
    }
    if (info.devDependencies.length > 15) {
      lines.push(`... and ${info.devDependencies.length - 15} more`);
    }
  }

  if (includeScripts && info.scripts && Object.keys(info.scripts).length > 0) {
    lines.push(`\n## Scripts (${Object.keys(info.scripts).length})`);
    for (const [name, command] of Object.entries(info.scripts)) {
      const truncCmd = command.length > 60 ? command.slice(0, 57) + '...' : command;
      lines.push(`- ${name}: ${truncCmd}`);
    }
  }

  return lines.join('\n');
}

export const projectInfoTool: UnifiedTool = {
  name: 'project-info',
  description: 'Get project metadata from package.json/composer.json/Cargo.toml',
  zodSchema: schema,
  skipContextShare: true,
  metadata: {
    category: 'project',
    tags: ['info', 'metadata', 'package'],
    examples: [
      { args: {}, description: 'Get metadata for current project' },
      { args: { cwd: '/var/www/app', includeScripts: true, includeDevDeps: false }, description: 'Get project info without dev dependencies' },
    ],
    relatedTools: ['env-info', 'file-tree'],
  },
  execute: async (args) => {
    const cwd = (args.cwd as string) || process.cwd();
    const includeDevDeps = args.includeDevDeps !== false;
    const includeScripts = args.includeScripts !== false;

    if (!existsSync(cwd)) {
      throw new Error(`Directory not found: ${cwd}`);
    }

    // Check cache: valid if same CWD and within TTL
    const now = Date.now();
    if (cachedInfo && cachedInfo.cwd === cwd && now - cachedInfo.timestamp < CACHE_TTL_MS) {
      const info = cachedInfo.data;
      if (isSilent()) {
        return JSON.stringify({ name: info.name, version: info.version, type: info.type, deps: info.dependencies.length });
      }
      return formatProjectInfo(info, includeScripts);
    }

    // Cache miss or expired - fetch fresh data
    const info = await detectAndParseProject(cwd, includeDevDeps);

    if (!info) {
      return `No project configuration found in ${cwd}\nSearched for: package.json, composer.json, Cargo.toml, pyproject.toml, go.mod`;
    }

    // Update cache
    cachedInfo = { data: info, cwd, timestamp: now };

    if (isSilent()) {
      return JSON.stringify({ name: info.name, version: info.version, type: info.type, deps: info.dependencies.length });
    }

    return formatProjectInfo(info, includeScripts);
  },
};
