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
 * Run Script Tool
 *
 * Executes package manager scripts (npm, yarn, pnpm, composer)
 * with streaming output and timeout support.
 *
 * @module tools/project/run-script
 */

import { z } from 'zod';
import { existsSync } from 'fs';
import { join } from 'path';
import { UnifiedTool } from '../registry.js';
import {
  spawnProcess,
  formatCompletion,
  getCwd,
  validateCwd,
  DEFAULT_TIMEOUT,
} from '../../utils/process-utils.js';

/**
 * Package manager configuration
 */
interface PackageManager {
  name: string;
  configFile: string;
  command: string;
  runPrefix: string[];
  listCommand: string[];
}

const PACKAGE_MANAGERS: PackageManager[] = [
  {
    name: 'pnpm',
    configFile: 'pnpm-lock.yaml',
    command: 'pnpm',
    runPrefix: ['run'],
    listCommand: ['run', '--help'],
  },
  {
    name: 'yarn',
    configFile: 'yarn.lock',
    command: 'yarn',
    runPrefix: ['run'],
    listCommand: ['run', '--list'],
  },
  {
    name: 'npm',
    configFile: 'package-lock.json',
    command: 'npm',
    runPrefix: ['run'],
    listCommand: ['run'],
  },
  {
    name: 'composer',
    configFile: 'composer.json',
    command: 'composer',
    runPrefix: ['run-script'],
    listCommand: ['run-script', '--list'],
  },
];

const schema = z.object({
  script: z.string().min(1).describe('Script name to execute'),
  cwd: z.string().optional().describe('Working directory'),
  args: z.string().optional().describe('Extra arguments for script'),
  timeout: z.number().default(300000).describe('Timeout ms'),
  packageManager: z
    .enum(['auto', 'npm', 'yarn', 'pnpm', 'composer'])
    .default('auto')
    .describe('Package manager'),
});

/**
 * Detect the package manager used in the project
 */
function detectPackageManager(cwd: string): PackageManager | null {
  for (const pm of PACKAGE_MANAGERS) {
    const lockFile = join(cwd, pm.configFile);
    if (existsSync(lockFile)) {
      return pm;
    }
  }

  // Fallback: check for package.json (npm) or composer.json
  if (existsSync(join(cwd, 'package.json'))) {
    return PACKAGE_MANAGERS.find((pm) => pm.name === 'npm') || null;
  }
  if (existsSync(join(cwd, 'composer.json'))) {
    return PACKAGE_MANAGERS.find((pm) => pm.name === 'composer') || null;
  }

  return null;
}

/**
 * Get package manager by name
 */
function getPackageManager(name: string): PackageManager | null {
  return PACKAGE_MANAGERS.find((pm) => pm.name === name) || null;
}

/**
 * Execute a script with streaming output using shared process utilities
 */
async function executeScript(
  pm: PackageManager,
  script: string,
  cwd: string,
  additionalArgs: string[],
  timeout: number,
  onProgress?: (output: string) => void
): Promise<string> {
  const args = [...pm.runPrefix, script, ...additionalArgs];

  const result = await spawnProcess(pm.command, args, {
    cwd,
    timeout,
    onProgress,
    forceColor: true,
    ci: true,
  });

  let output = result.stdout;
  if (result.stderr) {
    output += (output ? '\n\nSTDERR:\n' : '') + result.stderr;
  }

  return output + formatCompletion(result);
}

export const runScriptTool: UnifiedTool = {
  name: 'run-script',
  description: 'Execute npm/yarn/pnpm/composer scripts with streaming',
  zodSchema: schema,
  execute: async (args, onProgress) => {
    const script = String(args.script);
    const cwd = getCwd(args.cwd as string | undefined);
    const timeout = (args.timeout as number) || DEFAULT_TIMEOUT;
    const pmChoice = (args.packageManager as string) || 'auto';
    const additionalArgs = args.args ? String(args.args).split(' ').filter(Boolean) : [];

    validateCwd(cwd, existsSync);

    let pm: PackageManager | null;

    if (pmChoice === 'auto') {
      pm = detectPackageManager(cwd);
      if (!pm) {
        throw new Error(
          `No package manager detected in ${cwd}. Expected package.json or composer.json`
        );
      }
    } else {
      pm = getPackageManager(pmChoice);
      if (!pm) {
        throw new Error(`Unknown package manager: ${pmChoice}`);
      }
    }

    onProgress?.(`Using ${pm.name} to run "${script}"...\n\n`);

    return executeScript(pm, script, cwd, additionalArgs, timeout, onProgress);
  },
};
