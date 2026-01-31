#!/usr/bin/env bun
/**
 * KemdiCode MCP Server - Simple Concurrent Load Test
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
 * Simple Concurrent Load Test Benchmark
 *
 * Tests server performance under concurrent load using curl subprocesses.
 */

import { spawn } from 'bun';

const SERVER_URL = 'http://127.0.0.1:3100';
const CONCURRENCY_LEVELS = [10, 50, 100];
const TEST_TOOL = 'ping'; // Use lightweight tool for load testing

interface LoadTestResult {
  concurrency: number;
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  errorRate: number;
  throughput: number;
  duration: number;
  latencies: number[];
  minLatency: number;
  avgLatency: number;
  maxLatency: number;
  p95Latency: number;
  p99Latency: number;
}

/**
 * Execute a single request using curl and measure latency
 */
async function executeRequest(requestId: number): Promise<{ success: boolean; latency: number }> {
  const requestBody = JSON.stringify({
    jsonrpc: '2.0',
    id: requestId,
    method: 'tools/call',
    params: {
      name: TEST_TOOL,
      arguments: {},
    },
  });

  const startTime = performance.now();

  try {
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
      return { success: false, latency: performance.now() - startTime };
    }

    // Parse time in seconds and convert to milliseconds
    const timeInSeconds = parseFloat(output.trim());
    return { success: true, latency: timeInSeconds * 1000 };
  } catch (error) {
    return { success: false, latency: performance.now() - startTime };
  }
}

/**
 * Run load test with specified concurrency
 */
async function runLoadTest(concurrency: number): Promise<LoadTestResult> {
  const startTime = performance.now();

  // Create array of concurrent requests
  const requests = Array.from({ length: concurrency }, (_, i) => executeRequest(i));

  // Execute all requests concurrently
  const results = await Promise.all(requests);

  const endTime = performance.now();
  const duration = endTime - startTime;

  // Calculate statistics
  const successfulRequests = results.filter(r => r.success).length;
  const failedRequests = results.filter(r => !r.success).length;
  const errorRate = (failedRequests / concurrency) * 100;
  const throughput = (concurrency / duration) * 1000; // requests per second

  const latencies = results.map(r => r.latency).sort((a, b) => a - b);
  const minLatency = latencies[0];
  const maxLatency = latencies[latencies.length - 1];
  const avgLatency = latencies.reduce((sum, lat) => sum + lat, 0) / latencies.length;
  const p95Index = Math.floor(latencies.length * 0.95);
  const p99Index = Math.floor(latencies.length * 0.99);
  const p95Latency = latencies[p95Index];
  const p99Latency = latencies[p99Index];

  return {
    concurrency,
    totalRequests: concurrency,
    successfulRequests,
    failedRequests,
    errorRate,
    throughput,
    duration,
    latencies,
    minLatency,
    avgLatency,
    maxLatency,
    p95Latency,
    p99Latency,
  };
}

/**
 * Format number to fixed decimal places
 */
function formatNum(num: number, decimals: number = 2): string {
  return num.toFixed(decimals);
}

/**
 * Print results table
 */
function printResults(results: LoadTestResult[]) {
  console.log('\n╔═══════════════════════════════════════════════════════════════╗');
  console.log('║         KEMDICODE MCP - CONCURRENT LOAD TEST                 ║');
  console.log('╠═══════════════════════════════════════════════════════════════╣');
  console.log(`║  Server: ${SERVER_URL.padEnd(50)} ║`);
  console.log(`║  Test tool: ${TEST_TOOL.padEnd(47)} ║`);
  console.log('╚═══════════════════════════════════════════════════════════════╝\n');

  // Summary table
  console.log('┌────────────┬──────────┬──────────┬───────────┬──────────────┐');
  console.log('│ Concurrent │ Requests │ Success  │ Error (%) │ Throughput   │');
  console.log('│ Requests   │ Total    │ Rate (%) │           │ (req/s)      │');
  console.log('├────────────┼──────────┼──────────┼───────────┼──────────────┤');

  for (const result of results) {
    const concurrent = result.concurrency.toString().padStart(10);
    const total = result.totalRequests.toString().padStart(8);
    const successRate = formatNum((result.successfulRequests / result.totalRequests) * 100, 1).padStart(8);
    const errorRate = formatNum(result.errorRate, 1).padStart(9);
    const throughput = formatNum(result.throughput, 2).padStart(12);

    console.log(`│ ${concurrent} │ ${total} │ ${successRate} │ ${errorRate} │ ${throughput} │`);
  }

  console.log('└────────────┴──────────┴──────────┴───────────┴──────────────┘\n');

  // Latency details
  console.log('Latency Statistics (ms):');
  console.log('┌────────────┬─────────┬─────────┬─────────┬─────────┬─────────┐');
  console.log('│ Concurrent │ Min     │ Avg     │ Max     │ P95     │ P99     │');
  console.log('├────────────┼─────────┼─────────┼─────────┼─────────┼─────────┤');

  for (const result of results) {
    const concurrent = result.concurrency.toString().padStart(10);
    const min = formatNum(result.minLatency).padStart(7);
    const avg = formatNum(result.avgLatency).padStart(7);
    const max = formatNum(result.maxLatency).padStart(7);
    const p95 = formatNum(result.p95Latency).padStart(7);
    const p99 = formatNum(result.p99Latency).padStart(7);

    console.log(`│ ${concurrent} │ ${min} │ ${avg} │ ${max} │ ${p95} │ ${p99} │`);
  }

  console.log('└────────────┴─────────┴─────────┴─────────┴─────────┴─────────┘\n');

  // Performance insights
  console.log('Performance Insights:');
  const bestThroughput = Math.max(...results.map(r => r.throughput));
  const bestConcurrency = results.find(r => r.throughput === bestThroughput)?.concurrency;
  console.log(`  • Best throughput: ${formatNum(bestThroughput)} req/s at ${bestConcurrency} concurrent requests`);

  const avgErrorRate = results.reduce((sum, r) => sum + r.errorRate, 0) / results.length;
  console.log(`  • Average error rate: ${formatNum(avgErrorRate, 2)}%`);

  const totalRequests = results.reduce((sum, r) => sum + r.totalRequests, 0);
  const totalDuration = results.reduce((sum, r) => sum + r.duration, 0);
  console.log(`  • Total requests: ${totalRequests}`);
  console.log(`  • Total test duration: ${formatNum(totalDuration / 1000, 2)} seconds\n`);
}

/**
 * Main benchmark execution
 */
async function main() {
  console.log('Starting concurrent load test benchmark...\n');

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

  const results: LoadTestResult[] = [];

  // Run tests for each concurrency level
  for (const concurrency of CONCURRENCY_LEVELS) {
    process.stdout.write(`Testing with ${concurrency} concurrent requests... `);

    try {
      const result = await runLoadTest(concurrency);
      results.push(result);

      const successRate = ((result.successfulRequests / result.totalRequests) * 100).toFixed(1);
      process.stdout.write(`✓ (${successRate}% success, ${formatNum(result.throughput)} req/s)\n`);

      // Cool-down period between tests
      await Bun.sleep(1000);
    } catch (error) {
      process.stdout.write('✗ FAILED\n');
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
