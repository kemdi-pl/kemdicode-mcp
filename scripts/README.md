# KemdiCode MCP Benchmark Scripts

This directory contains benchmark and performance testing scripts for the KemdiCode MCP server.

## Available Benchmarks

### 1. Baseline Latency (`benchmark-baseline.sh`)

Measures baseline response times for key MCP tools using curl.

**Usage:**
```bash
./scripts/benchmark-baseline.sh
```

**What it tests:**
- ping
- task-list
- env-info
- project-info

**Output:**
- Min/Avg/Max/P95 latency for each tool
- 10 iterations per tool
- Results in milliseconds

**Requirements:**
- curl
- awk
- netcat (nc)
- Server running on port 3100

### 2. Startup Time (`benchmark-startup.sh`)

Measures how long it takes for the server to start and become ready to accept connections.

**Usage:**
```bash
./scripts/benchmark-startup.sh
```

**What it measures:**
- Time from server start to port 3100 being available
- Runs 5 iterations
- Reports min/avg/max startup time

**Requirements:**
- bun
- netcat (nc)
- Server must NOT be running (script stops/starts it)

### 3. Tool Latency Suite (`benchmark-latency.ts`)

Comprehensive latency testing for multiple tools via HTTP/MCP protocol.

**Usage:**
```bash
bun scripts/benchmark-latency.ts
```

**What it tests:**
- ping
- task-list
- file-read (package.json)
- git-status
- env-info
- project-info

**Output:**
- Detailed statistics table
- 10 iterations per tool
- Min/Avg/Max/P95 latency

**Requirements:**
- Bun runtime
- Server running on port 3100

### 4. Concurrent Load Test (`benchmark-concurrent.ts`)

Tests server performance under concurrent load.

**Usage:**
```bash
bun scripts/benchmark-concurrent.ts
```

**What it tests:**
- 10 concurrent requests
- 50 concurrent requests
- 100 concurrent requests

**Output:**
- Throughput (requests/second)
- Error rate
- Latency distribution (Min/Avg/Max/P95/P99)

**Requirements:**
- Bun runtime
- Server running on port 3100

## Running All Benchmarks

To run a complete benchmark suite:

```bash
# 1. Measure baseline (with server running)
./scripts/benchmark-baseline.sh

# 2. Measure startup time (stops and restarts server)
./scripts/benchmark-startup.sh

# 3. Start server again for remaining tests
./start-server.sh

# 4. Run latency tests
bun scripts/benchmark-latency.ts

# 5. Run load tests
bun scripts/benchmark-concurrent.ts
```

## Interpreting Results

### Latency Metrics

- **Min**: Best case performance
- **Avg**: Typical performance
- **Max**: Worst case performance
- **P95**: 95% of requests faster than this
- **P99**: 99% of requests faster than this (only in concurrent tests)

### Good Baseline Values

Based on typical performance:

- Simple tools (ping, env-info): < 5ms
- Database tools (task-list): < 10ms
- File operations (file-read): < 15ms
- Git operations (git-status): < 20ms

### Startup Time

- Cold start: 500-2000ms
- With warm cache: 200-500ms

### Concurrent Load

- 10 concurrent: Should handle with minimal latency increase
- 50 concurrent: Some latency increase expected
- 100 concurrent: Higher latency, watch for errors

## Troubleshooting

### Server Not Reachable

```bash
# Check if server is running
nc -z 127.0.0.1 3100 && echo "Running" || echo "Not running"

# Start server
./start-server.sh

# Check logs
tail -f /tmp/kemdicode-mcp.log
```

### High Latency

- Check CPU usage: `top` or `htop`
- Check memory: `free -h`
- Check Redis: `redis-cli ping`
- Review server logs for errors

### Errors in Load Tests

- May indicate server overload
- Check max connections limit
- Consider tuning Redis connection pool
- Review system file descriptor limits

## Continuous Monitoring

For continuous performance monitoring, consider:

1. Running baseline tests after each release
2. Comparing results over time
3. Setting up alerts for regression
4. Tracking P95/P99 latencies in production

## Contributing

When adding new benchmarks:

1. Add GPL-3.0 license header
2. Document in this README
3. Follow existing naming convention: `benchmark-*.{ts,sh}`
4. Make scripts executable: `chmod +x scripts/benchmark-*.sh`
