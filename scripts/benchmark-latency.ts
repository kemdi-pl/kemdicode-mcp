#!/usr/bin/env bun
/**
 * KemdiCode MCP Server - Simple Tool Latency Benchmark
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
 * Simple Tool Latency Benchmark
 *
 * Uses Bun's subprocess to call curl for measuring HTTP response times.
 * Similar to benchmark-baseline.sh but with TypeScript for better data processing.
 */

import { spawn } from 'bun';

const SERVER_URL = 'http://127.0.0.1:3100';
const ITERATIONS = 10;

interface ToolTest {
  name: string;
  arguments: Record<string, unknown>;
}

interface LatencyStats {
  tool: string;
  min: number;
  avg: number;
  max: number;
  p95: number;
  samples: number[];
}

const TOOLS_TO_TEST: ToolTest[] = [
  { name: 'ping', arguments: {} },
  { name: 'task-list', arguments: {} },
  { name: 'file-read', arguments: { path: '/opt/kemdicode-mcp/package.json' } },
  { name: 'git-status', arguments: {} },
  { name: 'env-info', arguments: {} },
  { name: 'project-info', arguments: {} },
];

/**
 * Call a tool using curl and measure response time
 */
async function callToolWithCurl(tool: ToolTest): Promise<number> {
  const requestBody = JSON.stringify({
    jsonrpc: '2.0',
    id: Math.floor(Math.random() * 1000000),
    method: 'tools/call',
    params: {
      name: tool.name,
      arguments: tool.arguments,
    },
  });

  // Use curl with timing output
  const proc = spawn([
    'curl',
    '-s',
    '-w',
    '%{time_total}',
    '-o',
    '/dev/null',
    '-X',
    'POST',
    '-H',
    'Content-Type: application/json',
    '-d',
    requestBody,
    `${SERVER_URL}/message`,
  ]);

  const output = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new Error(`curl failed with exit code ${exitCode}`);
  }

  // Parse time in seconds and convert to milliseconds
  const timeInSeconds = parseFloat(output.trim());
  return timeInSeconds * 1000;
}

/**
 * Calculate statistics from latency samples
 */
function calculateStats(tool: string, samples: number[]): LatencyStats {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, val) => acc + val, 0);
  const avg = sum / sorted.length;
  const min = sorted[0];
  const max = sorted[sorted.length - 1];

  // Calculate 95th percentile
  const p95Index = Math.floor(sorted.length * 0.95);
  const p95 = sorted[p95Index];

  return { tool, min, avg, max, p95, samples: sorted };
}

/**
 * Format number to fixed decimal places
 */
function formatMs(ms: number): string {
  return ms.toFixed(2);
}

/**
 * Print results table
 */
function printResults(results: LatencyStats[]) {
  console.log('\n╔═══════════════════════════════════════════════════════════════╗');
  console.log('║         KEMDICODE MCP - TOOL LATENCY BENCHMARK               ║');
  console.log('╠═══════════════════════════════════════════════════════════════╣');
  console.log(`║  Server: ${SERVER_URL.padEnd(50)} ║`);
  console.log(`║  Iterations per tool: ${ITERATIONS.toString().padEnd(40)} ║`);
  console.log('╚═══════════════════════════════════════════════════════════════╝\n');

  // Table header
  console.log('┌────────────────────┬─────────┬─────────┬─────────┬─────────┐');
  console.log('│ Tool               │ Min (ms)│ Avg (ms)│ Max (ms)│ P95 (ms)│');
  console.log('├────────────────────┼─────────┼─────────┼─────────┼─────────┤');

  // Table rows
  for (const result of results) {
    const tool = result.tool.padEnd(18);
    const min = formatMs(result.min).padStart(7);
    const avg = formatMs(result.avg).padStart(7);
    const max = formatMs(result.max).padStart(7);
    const p95 = formatMs(result.p95).padStart(7);

    console.log(`│ ${tool} │ ${min} │ ${avg} │ ${max} │ ${p95} │`);
  }

  console.log('└────────────────────┴─────────┴─────────┴─────────┴─────────┘\n');

  // Summary statistics
  const allSamples = results.flatMap(r => r.samples);
  const totalCalls = allSamples.length;
  const totalTime = allSamples.reduce((acc, val) => acc + val, 0);
  const overallAvg = totalTime / totalCalls;

  console.log('Summary:');
  console.log(`  Total calls: ${totalCalls}`);
  console.log(`  Overall average latency: ${formatMs(overallAvg)} ms`);
  console.log(`  Total benchmark time: ${formatMs(totalTime)} ms\n`);
}

/**
 * Main benchmark execution
 */
async function main() {
  console.log('Starting tool latency benchmark...\n');

  // Check server connectivity using curl
  const proc = spawn(['curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '2', `${SERVER_URL}/health`]);
  const statusCode = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0 || statusCode.trim() !== '200') {
    console.error('❌ Error: Cannot connect to MCP server');
    console.error(`   Make sure the server is running at ${SERVER_URL}`);
    process.exit(1);
  }

  console.log('✓ Server is reachable\n');

  const results: LatencyStats[] = [];

  // Test each tool
  for (const tool of TOOLS_TO_TEST) {
    process.stdout.write(`Testing ${tool.name}...`);
    const samples: number[] = [];

    try {
      for (let i = 0; i < ITERATIONS; i++) {
        const latency = await callToolWithCurl(tool);
        samples.push(latency);

        // Small delay between iterations
        await Bun.sleep(100);
      }

      const stats = calculateStats(tool.name, samples);
      results.push(stats);
      process.stdout.write(` ✓ (avg: ${formatMs(stats.avg)} ms)\n`);
    } catch (error) {
      process.stdout.write(` ✗ FAILED\n`);
      console.error(`   Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Print results
  printResults(results);
}

// Run benchmark
main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
