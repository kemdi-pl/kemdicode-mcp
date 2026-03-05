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
 * Memory Usage Tool
 *
 * Shows memory usage information:
 * - Process memory (Node.js heap, RSS, external)
 * - System memory stats
 * - V8 heap info
 *
 * @module tools/system/memory-usage
 */

import { z } from 'zod';
import { freemem, totalmem, platform } from 'os';
import * as v8 from 'v8';
import { UnifiedTool } from '../registry.js';
import { isSilent } from '../../config/silent.js';
import { asyncExec } from '../../utils/async-exec.js';

/**
 * Memory stats structure
 */
interface MemoryStats {
  process: {
    heapUsed: number;
    heapTotal: number;
    external: number;
    rss: number;
    arrayBuffers: number;
  };
  system: {
    total: number;
    free: number;
    used: number;
    usedPercent: number;
  };
  v8Heap: {
    totalHeapSize: number;
    usedHeapSize: number;
    heapSizeLimit: number;
    mallocedMemory: number;
    peakMallocedMemory: number;
  };
  swap?: {
    total: number;
    used: number;
    free: number;
  };
}

const schema = z.object({
  detailed: z.boolean().default(false).describe('Show detailed V8 heap stats'),
  gc: z
    .boolean()
    .default(false)
    .describe('Force GC before measuring'),
});

/**
 * Format bytes to human readable
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * Get swap memory info (Linux/macOS)
 */
async function getSwapInfo(): Promise<{ total: number; used: number; free: number } | undefined> {
  const os = platform();

  try {
    if (os === 'linux') {
      const output = await asyncExec('free -b');
      const swapLine = output.split('\n').find((l) => l.startsWith('Swap:'));
      if (swapLine) {
        const parts = swapLine.split(/\s+/);
        return {
          total: parseInt(parts[1], 10),
          used: parseInt(parts[2], 10),
          free: parseInt(parts[3], 10),
        };
      }
    } else if (os === 'darwin') {
      const output = await asyncExec('sysctl -n vm.swapusage');
      const match = output.match(
        /total\s*=\s*([\d.]+)M\s+used\s*=\s*([\d.]+)M\s+free\s*=\s*([\d.]+)M/
      );
      if (match) {
        return {
          total: parseFloat(match[1]) * 1024 * 1024,
          used: parseFloat(match[2]) * 1024 * 1024,
          free: parseFloat(match[3]) * 1024 * 1024,
        };
      }
    }
  } catch {
    // Swap info not available
  }

  return undefined;
}

/**
 * Collect memory statistics
 */
async function collectMemoryStats(forceGC: boolean): Promise<MemoryStats> {
  if (forceGC && global.gc) {
    global.gc();
  }

  const processMemory = process.memoryUsage();

  const totalMem = totalmem();
  const freeMem = freemem();
  const usedMem = totalMem - freeMem;

  const heapStats = v8.getHeapStatistics();

  return {
    process: {
      heapUsed: processMemory.heapUsed,
      heapTotal: processMemory.heapTotal,
      external: processMemory.external,
      rss: processMemory.rss,
      arrayBuffers: processMemory.arrayBuffers,
    },
    system: {
      total: totalMem,
      free: freeMem,
      used: usedMem,
      usedPercent: (usedMem / totalMem) * 100,
    },
    v8Heap: {
      totalHeapSize: heapStats.total_heap_size,
      usedHeapSize: heapStats.used_heap_size,
      heapSizeLimit: heapStats.heap_size_limit,
      mallocedMemory: heapStats.malloced_memory,
      peakMallocedMemory: heapStats.peak_malloced_memory,
    },
    swap: await getSwapInfo(),
  };
}

/**
 * Format memory stats for display
 */
function formatMemoryStats(stats: MemoryStats, detailed: boolean): string {
  const lines: string[] = [];

  lines.push('# Memory Usage');
  lines.push('');

  // System Memory
  lines.push('## System Memory');
  lines.push(`- Total: ${formatBytes(stats.system.total)}`);
  lines.push(`- Used: ${formatBytes(stats.system.used)} (${stats.system.usedPercent.toFixed(1)}%)`);
  lines.push(`- Free: ${formatBytes(stats.system.free)}`);

  // Swap
  if (stats.swap) {
    lines.push('');
    lines.push('## Swap');
    lines.push(`- Total: ${formatBytes(stats.swap.total)}`);
    lines.push(`- Used: ${formatBytes(stats.swap.used)}`);
    lines.push(`- Free: ${formatBytes(stats.swap.free)}`);
  }

  // Process Memory
  lines.push('');
  lines.push('## Process Memory (Node.js)');
  lines.push(`- RSS (Resident Set Size): ${formatBytes(stats.process.rss)}`);
  lines.push(`- Heap Used: ${formatBytes(stats.process.heapUsed)}`);
  lines.push(`- Heap Total: ${formatBytes(stats.process.heapTotal)}`);
  lines.push(`- External: ${formatBytes(stats.process.external)}`);
  lines.push(`- Array Buffers: ${formatBytes(stats.process.arrayBuffers)}`);

  // V8 Heap (detailed)
  if (detailed) {
    lines.push('');
    lines.push('## V8 Heap Statistics');
    lines.push(`- Total Heap Size: ${formatBytes(stats.v8Heap.totalHeapSize)}`);
    lines.push(`- Used Heap Size: ${formatBytes(stats.v8Heap.usedHeapSize)}`);
    lines.push(`- Heap Size Limit: ${formatBytes(stats.v8Heap.heapSizeLimit)}`);
    lines.push(`- Malloced Memory: ${formatBytes(stats.v8Heap.mallocedMemory)}`);
    lines.push(`- Peak Malloced Memory: ${formatBytes(stats.v8Heap.peakMallocedMemory)}`);

    // Calculate heap usage percentage
    const heapUsagePercent = (stats.v8Heap.usedHeapSize / stats.v8Heap.heapSizeLimit) * 100;
    lines.push(`- Heap Usage: ${heapUsagePercent.toFixed(1)}% of limit`);

    // Heap space breakdown
    try {
      const heapSpaces = v8.getHeapSpaceStatistics();
      lines.push('');
      lines.push('### Heap Spaces');
      for (const space of heapSpaces) {
        const usage = ((space.space_used_size / space.space_size) * 100).toFixed(1);
        lines.push(
          `- ${space.space_name}: ${formatBytes(space.space_used_size)} / ${formatBytes(space.space_size)} (${usage}%)`
        );
      }
    } catch {
      // Heap space stats not available
    }
  }

  // Summary
  lines.push('');
  lines.push('## Summary');
  const systemUsage = stats.system.usedPercent;
  const heapUsage = (stats.process.heapUsed / stats.process.heapTotal) * 100;

  let status = 'OK';
  if (systemUsage > 90) status = 'CRITICAL';
  else if (systemUsage > 75) status = 'WARNING';
  else if (heapUsage > 85) status = 'WARNING';

  lines.push(`- Status: ${status}`);
  lines.push(`- System Memory: ${stats.system.usedPercent.toFixed(1)}% used`);
  lines.push(`- Process Heap: ${heapUsage.toFixed(1)}% used`);

  if (status === 'CRITICAL') {
    lines.push('');
    lines.push('**WARNING: System memory is critically low!**');
  } else if (status === 'WARNING') {
    lines.push('');
    lines.push('*Note: Memory usage is elevated. Consider monitoring.*');
  }

  return lines.join('\n');
}

export const memoryUsageTool: UnifiedTool = {
  name: 'memory-usage',
  description: 'Show process heap, system memory, V8 stats. Use when: diagnosing performance issues or memory leaks.',
  zodSchema: schema,
  skipContextShare: true,
  metadata: {
    category: 'system',
    tags: ['memory', 'monitoring', 'resources'],
    examples: [
      { args: {}, description: 'Show basic memory usage' },
      { args: { detailed: true, gc: true }, description: 'Show detailed V8 heap stats after forced GC' },
    ],
    relatedTools: ['env-info'],
  },
  execute: async (args) => {
    const detailed = Boolean(args.detailed);
    const forceGC = Boolean(args.gc);

    if (forceGC && !global.gc) {
      if (isSilent()) {
        return JSON.stringify({ error: 'gc_unavailable' });
      }
      const stats = await collectMemoryStats(false);
      return (
        formatMemoryStats(stats, detailed) +
        '\n\n*Note: GC was requested but is not exposed. Start node with --expose-gc flag to enable.*'
      );
    }

    const stats = await collectMemoryStats(forceGC);

    if (isSilent()) {
      return JSON.stringify({
        rss: formatBytes(stats.process.rss),
        heap: formatBytes(stats.process.heapUsed),
        sysMem: `${stats.system.usedPercent.toFixed(0)}%`,
      });
    }

    return formatMemoryStats(stats, detailed);
  },
};
