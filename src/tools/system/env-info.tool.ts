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
 * Environment Info Tool
 *
 * Shows environment information including:
 * - Node.js version
 * - npm/pnpm/yarn version
 * - PHP version (if available)
 * - Git version
 * - OS info
 *
 * @module tools/system/env-info
 */

import { z } from 'zod';
import { platform, release, arch, cpus, totalmem, hostname, userInfo } from 'os';
import { UnifiedTool } from '../registry.js';
import { isSilent } from '../../config/silent.js';
import { asyncExec } from '../../utils/async-exec.js';

/**
 * Module-level cache for environment info (cached indefinitely - static data)
 */
let cachedEnvInfo: EnvInfo | null = null;

/**
 * Environment info structure
 */
interface EnvInfo {
  os: {
    platform: string;
    release: string;
    arch: string;
    hostname: string;
    user: string;
  };
  hardware: {
    cpuModel: string;
    cpuCores: number;
    totalMemory: string;
  };
  runtime: {
    nodeVersion?: string;
    npmVersion?: string;
    pnpmVersion?: string;
    yarnVersion?: string;
    bunVersion?: string;
    denoVersion?: string;
  };
  languages: {
    phpVersion?: string;
    pythonVersion?: string;
    rubyVersion?: string;
    goVersion?: string;
    rustVersion?: string;
    javaVersion?: string;
  };
  tools: {
    gitVersion?: string;
    dockerVersion?: string;
    composerVersion?: string;
    makeVersion?: string;
  };
  env: {
    shell: string;
    path: string[];
    cwd: string;
    home: string;
  };
}

const schema = z.object({
  detailed: z.boolean().default(false).describe('Include PATH details'),
  category: z
    .enum(['all', 'os', 'runtime', 'languages', 'tools', 'env'])
    .default('all')
    .describe('Category to show'),
  allowSensitive: z
    .boolean()
    .default(false)
    .describe('Show sensitive info (hostname, username, home)'),
});

/**
 * Safely execute command and return output
 */
async function safeExec(command: string): Promise<string | undefined> {
  try {
    return await asyncExec(command, 5000);
  } catch {
    return undefined;
  }
}

/**
 * Get version from command output
 */
async function getVersion(command: string, pattern?: RegExp): Promise<string | undefined> {
  const output = await safeExec(command);
  if (!output) return undefined;

  if (pattern) {
    const match = output.match(pattern);
    return match ? match[1] || match[0] : undefined;
  }

  const versionMatch = output.match(/v?(\d+\.\d+(?:\.\d+)?(?:-[a-zA-Z0-9.]+)?)/);
  return versionMatch ? versionMatch[1] : output.split('\n')[0];
}

/**
 * Collect environment information
 */
async function collectEnvInfo(): Promise<EnvInfo> {
  const cpuInfo = cpus();

  return {
    os: {
      platform: platform(),
      release: release(),
      arch: arch(),
      hostname: hostname(),
      user: userInfo().username,
    },
    hardware: {
      cpuModel: cpuInfo[0]?.model || 'Unknown',
      cpuCores: cpuInfo.length,
      totalMemory: `${(totalmem() / 1024 / 1024 / 1024).toFixed(2)} GB`,
    },
    runtime: {
      nodeVersion: process.version.replace('v', ''),
      npmVersion: await getVersion('npm --version'),
      pnpmVersion: await getVersion('pnpm --version'),
      yarnVersion: await getVersion('yarn --version'),
      bunVersion: await getVersion('bun --version'),
      denoVersion: await getVersion('deno --version', /deno\s+(\d+\.\d+\.\d+)/),
    },
    languages: {
      phpVersion: await getVersion('php --version', /PHP\s+(\d+\.\d+\.\d+)/),
      pythonVersion:
        (await getVersion('python3 --version', /Python\s+(\d+\.\d+\.\d+)/)) ||
        (await getVersion('python --version', /Python\s+(\d+\.\d+\.\d+)/)),
      rubyVersion: await getVersion('ruby --version', /ruby\s+(\d+\.\d+\.\d+)/),
      goVersion: await getVersion('go version', /go(\d+\.\d+(?:\.\d+)?)/),
      rustVersion: await getVersion('rustc --version', /rustc\s+(\d+\.\d+\.\d+)/),
      javaVersion: await getVersion('java -version 2>&1', /version\s+"?(\d+(?:\.\d+)*)"?/),
    },
    tools: {
      gitVersion: await getVersion('git --version', /git version\s+(\d+\.\d+\.\d+)/),
      dockerVersion: await getVersion('docker --version', /Docker version\s+(\d+\.\d+\.\d+)/),
      composerVersion: await getVersion(
        'composer --version',
        /Composer\s+(?:version\s+)?(\d+\.\d+\.\d+)/
      ),
      makeVersion: await getVersion('make --version', /GNU Make\s+(\d+\.\d+)/),
    },
    env: {
      shell: process.env.SHELL || process.env.ComSpec || 'unknown',
      path: (process.env.PATH || '').split(platform() === 'win32' ? ';' : ':'),
      cwd: process.cwd(),
      home: process.env.HOME || process.env.USERPROFILE || 'unknown',
    },
  };
}

/**
 * Format environment info for display
 */
function formatEnvInfo(
  info: EnvInfo,
  category: string,
  detailed: boolean,
  allowSensitive: boolean
): string {
  const lines: string[] = [];
  const showAll = category === 'all';

  lines.push('# Environment Information');
  lines.push('');

  // OS Section
  if (showAll || category === 'os') {
    lines.push('## Operating System');
    lines.push(`- Platform: ${info.os.platform}`);
    lines.push(`- Release: ${info.os.release}`);
    lines.push(`- Architecture: ${info.os.arch}`);
    lines.push(`- Hostname: ${allowSensitive ? info.os.hostname : '<redacted>'}`);
    lines.push(`- User: ${allowSensitive ? info.os.user : '<redacted>'}`);
    lines.push('');

    lines.push('## Hardware');
    lines.push(`- CPU: ${info.hardware.cpuModel}`);
    lines.push(`- Cores: ${info.hardware.cpuCores}`);
    lines.push(`- Memory: ${info.hardware.totalMemory}`);
    lines.push('');
  }

  // Runtime Section
  if (showAll || category === 'runtime') {
    lines.push('## JavaScript Runtimes');
    if (info.runtime.nodeVersion) lines.push(`- Node.js: ${info.runtime.nodeVersion}`);
    if (info.runtime.npmVersion) lines.push(`- npm: ${info.runtime.npmVersion}`);
    if (info.runtime.pnpmVersion) lines.push(`- pnpm: ${info.runtime.pnpmVersion}`);
    if (info.runtime.yarnVersion) lines.push(`- Yarn: ${info.runtime.yarnVersion}`);
    if (info.runtime.bunVersion) lines.push(`- Bun: ${info.runtime.bunVersion}`);
    if (info.runtime.denoVersion) lines.push(`- Deno: ${info.runtime.denoVersion}`);
    lines.push('');
  }

  // Languages Section
  if (showAll || category === 'languages') {
    const langs = info.languages;
    const hasLanguages = Object.values(langs).some(Boolean);

    if (hasLanguages) {
      lines.push('## Programming Languages');
      if (langs.phpVersion) lines.push(`- PHP: ${langs.phpVersion}`);
      if (langs.pythonVersion) lines.push(`- Python: ${langs.pythonVersion}`);
      if (langs.rubyVersion) lines.push(`- Ruby: ${langs.rubyVersion}`);
      if (langs.goVersion) lines.push(`- Go: ${langs.goVersion}`);
      if (langs.rustVersion) lines.push(`- Rust: ${langs.rustVersion}`);
      if (langs.javaVersion) lines.push(`- Java: ${langs.javaVersion}`);
      lines.push('');
    }
  }

  // Tools Section
  if (showAll || category === 'tools') {
    const tools = info.tools;
    const hasTools = Object.values(tools).some(Boolean);

    if (hasTools) {
      lines.push('## Development Tools');
      if (tools.gitVersion) lines.push(`- Git: ${tools.gitVersion}`);
      if (tools.dockerVersion) lines.push(`- Docker: ${tools.dockerVersion}`);
      if (tools.composerVersion) lines.push(`- Composer: ${tools.composerVersion}`);
      if (tools.makeVersion) lines.push(`- Make: ${tools.makeVersion}`);
      lines.push('');
    }
  }

  // Environment Section
  if (showAll || category === 'env') {
    lines.push('## Environment');
    lines.push(`- Shell: ${info.env.shell}`);
    lines.push(`- CWD: ${info.env.cwd}`);
    lines.push(`- Home: ${allowSensitive ? info.env.home : '<redacted>'}`);

    if (detailed && allowSensitive) {
      lines.push('');
      lines.push('### PATH');
      for (const p of info.env.path.slice(0, 15)) {
        lines.push(`- ${p}`);
      }
      if (info.env.path.length > 15) {
        lines.push(`... and ${info.env.path.length - 15} more entries`);
      }
    }
  }

  return lines.join('\n');
}

export const envInfoTool: UnifiedTool = {
  name: 'env-info',
  description: 'Show environment info: runtimes, languages, tools, OS, hardware',
  zodSchema: schema,
  skipContextShare: true,
  metadata: {
    category: 'system',
    tags: ['environment', 'info', 'runtime'],
    examples: [
      { args: {}, description: 'Show all environment information' },
      { args: { category: 'runtime', detailed: true }, description: 'Show detailed JavaScript runtime versions' },
      { args: { category: 'languages' }, description: 'Show installed programming languages' },
    ],
    relatedTools: ['memory-usage', 'process-list', 'project-info'],
  },
  execute: async (args) => {
    const detailed = Boolean(args.detailed);
    const category = (args.category as string) || 'all';
    const allowSensitive = Boolean(args.allowSensitive);

    if (!cachedEnvInfo) {
      cachedEnvInfo = await collectEnvInfo();
    }

    const info = cachedEnvInfo;
    if (isSilent()) {
      if (category !== 'all') {
        return JSON.stringify((info as unknown as Record<string, unknown>)[category] ?? {});
      }
      return JSON.stringify({ os: `${info.os.platform} ${info.os.arch}`, node: info.runtime.nodeVersion, bun: info.runtime.bunVersion });
    }
    return formatEnvInfo(info, category, detailed, allowSensitive);
  },
};
