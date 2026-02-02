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

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFilePromise = promisify(execFile);

/**
 * Execute a command safely using execFile (no shell interpolation).
 * The first whitespace-delimited token is the binary; the rest are arguments.
 */
export async function asyncExec(cmd: string, timeoutMs = 5000): Promise<string> {
  const parts = cmd.split(/\s+/).filter(Boolean);
  if (parts.length === 0) throw new Error('asyncExec: empty command');

  const [binary, ...args] = parts;
  const { stdout } = await execFilePromise(binary, args, {
    encoding: 'utf-8',
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024 * 10,
    shell: false,
  });
  return stdout.trim();
}
