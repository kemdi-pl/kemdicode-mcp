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
 * Process List Tool
 *
 * Lists running processes with optional filtering
 * and shows memory/CPU usage.
 *
 * @module tools/system/process-list
 */

import { z } from 'zod';
import { platform } from 'os';
import { UnifiedTool } from '../registry.js';
import { isSilent } from '../../config/silent.js';
import { Logger } from '../../utils/logger.js';
import { asyncExec } from '../../utils/async-exec.js';

/**
 * Process info structure
 */
interface ProcessInfo {
  pid: number;
  user: string;
  cpu: number;
  memory: number;
  command: string;
  started?: string;
}

const schema = z.object({
  filter: z.string().optional().describe('Filter by name pattern'),
  sortBy: z.enum(['cpu', 'memory', 'pid', 'name']).default('cpu').describe('Sort field'),
  limit: z.number().default(20).describe('Max processes to show'),
  all: z.boolean().default(false).describe('Show all processes'),
});

/**
 * Parse ps output (Linux/macOS)
 */
function parsePsOutput(output: string): ProcessInfo[] {
  const lines = output.trim().split('\n').slice(1); // Skip header
  const processes: ProcessInfo[] = [];

  for (const line of lines) {
    // Format: USER PID %CPU %MEM STARTED COMMAND
    const match = line.match(/^\s*(\S+)\s+(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\S+)\s+(.+)$/);
    if (match) {
      processes.push({
        user: match[1],
        pid: parseInt(match[2], 10),
        cpu: parseFloat(match[3]),
        memory: parseFloat(match[4]),
        started: match[5],
        command: match[6].slice(0, 100), // Truncate long commands
      });
    }
  }

  return processes;
}

/**
 * Parse tasklist output (Windows)
 */
function parseTasklistOutput(output: string): ProcessInfo[] {
  const lines = output.trim().split('\n').slice(3); // Skip header and separator
  const processes: ProcessInfo[] = [];

  for (const line of lines) {
    // Format: Image Name, PID, Session Name, Session#, Mem Usage
    const parts = line.split(/\s{2,}/);
    if (parts.length >= 5) {
      const memStr = parts[4].replace(/[^\d]/g, '');
      processes.push({
        user: 'N/A',
        pid: parseInt(parts[1], 10),
        cpu: 0, // Not available from tasklist
        memory: parseInt(memStr, 10) / 1024, // Convert KB to MB (approx)
        command: parts[0],
      });
    }
  }

  return processes;
}

/**
 * Get process list
 */
async function getProcessList(all: boolean, filter?: string): Promise<ProcessInfo[]> {
  const os = platform();

  try {
    if (os === 'win32') {
      const cmd = 'tasklist /FO TABLE';
      const output = await asyncExec(cmd, 10000);
      let processes = parseTasklistOutput(output);

      if (filter) {
        const lowerFilter = filter.toLowerCase();
        processes = processes.filter((p) => p.command.toLowerCase().includes(lowerFilter));
      }

      return processes;
    } else {
      const userFlag = all ? '-A' : '-u $(whoami)';
      const cmd = `ps ${userFlag} -o user,pid,%cpu,%mem,start,command --sort=-%cpu`;
      const output = await asyncExec(cmd, 10000);
      let processes = parsePsOutput(output);

      if (filter) {
        const lowerFilter = filter.toLowerCase();
        processes = processes.filter((p) => p.command.toLowerCase().includes(lowerFilter));
      }

      return processes;
    }
  } catch (error) {
    Logger.warn(`Failed to get process list: ${error}`);
    return [];
  }
}

/**
 * Sort processes
 */
function sortProcesses(processes: ProcessInfo[], sortBy: string): ProcessInfo[] {
  return [...processes].sort((a, b) => {
    switch (sortBy) {
      case 'cpu':
        return b.cpu - a.cpu;
      case 'memory':
        return b.memory - a.memory;
      case 'pid':
        return a.pid - b.pid;
      case 'name':
        return a.command.localeCompare(b.command);
      default:
        return 0;
    }
  });
}

/**
 * Format process list for display
 */
function formatProcessList(processes: ProcessInfo[], sortBy: string, limit: number): string {
  const lines: string[] = [];
  const os = platform();

  lines.push(`# Running Processes`);
  lines.push(`Platform: ${os}`);
  lines.push(`Sorted by: ${sortBy}`);
  lines.push(`Showing: ${Math.min(processes.length, limit)} of ${processes.length}`);
  lines.push('');

  // Table header
  if (os === 'win32') {
    lines.push('| PID | Memory (MB) | Process |');
    lines.push('|-----|-------------|---------|');
  } else {
    lines.push('| PID | CPU% | Mem% | User | Process |');
    lines.push('|-----|------|------|------|---------|');
  }

  // Table rows
  const sorted = sortProcesses(processes, sortBy);
  for (const proc of sorted.slice(0, limit)) {
    if (os === 'win32') {
      lines.push(`| ${proc.pid} | ${proc.memory.toFixed(1)} | ${proc.command} |`);
    } else {
      const truncCmd = proc.command.length > 40 ? proc.command.slice(0, 37) + '...' : proc.command;
      lines.push(
        `| ${proc.pid} | ${proc.cpu.toFixed(1)} | ${proc.memory.toFixed(1)} | ${proc.user.slice(0, 8)} | ${truncCmd} |`
      );
    }
  }

  // Summary
  if (processes.length > 0) {
    const totalCpu = processes.reduce((sum, p) => sum + p.cpu, 0);
    const totalMem = processes.reduce((sum, p) => sum + p.memory, 0);

    lines.push('');
    lines.push('## Summary');
    if (os !== 'win32') {
      lines.push(`- Total CPU usage: ${totalCpu.toFixed(1)}%`);
    }
    lines.push(`- Total Memory usage: ${totalMem.toFixed(1)}%`);
    lines.push(`- Process count: ${processes.length}`);
  }

  return lines.join('\n');
}

export const processListTool: UnifiedTool = {
  name: 'process-list',
  description: 'List running processes with CPU/memory usage',
  zodSchema: schema,
  skipContextShare: true,
  metadata: {
    category: 'system',
    tags: ['process', 'monitoring'],
    examples: [
      { args: {}, description: 'List top processes by CPU usage' },
      { args: { filter: 'node', sortBy: 'memory', limit: 10 }, description: 'List Node.js processes sorted by memory' },
      { args: { all: true, sortBy: 'cpu' }, description: 'List all system processes by CPU' },
    ],
    relatedTools: ['memory-usage', 'env-info'],
  },
  execute: async (args) => {
    const filter = args.filter as string | undefined;
    const sortBy = (args.sortBy as string) || 'cpu';
    const limit = (args.limit as number) || 20;
    const all = Boolean(args.all);

    const processes = await getProcessList(all, filter);

    if (processes.length === 0) {
      return filter ? `No processes matching "${filter}"` : 'No processes found';
    }

    if (isSilent()) {
      const sorted = sortProcesses(processes, sortBy).slice(0, limit);
      return JSON.stringify(sorted.map((p) => ({ pid: p.pid, cpu: p.cpu, mem: p.memory, cmd: p.command.slice(0, 60) })));
    }

    return formatProcessList(processes, sortBy, limit);
  },
};
