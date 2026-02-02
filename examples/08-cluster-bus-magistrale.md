# Cluster Bus & Magistrale

Distributed LLM orchestration across cluster nodes with signal routing, topology management, and multi-pass quality control.

## Architecture Overview

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Cluster A  │◄───►│  Cluster B  │◄───►│  Cluster C  │
│  (hub)      │     │  (worker)   │     │  (worker)   │
│  gemini-pro │     │  gpt-4o     │     │  claude     │
└──────┬──────┘     └──────┬──────┘     └──────┬──────┘
       │                   │                   │
       └───────────┬───────┘───────────────────┘
                   │
           ┌───────┴───────┐
           │  Redis Pub/Sub │
           │  Signal Bus    │
           └───────────────┘
```

## 1. Check cluster bus status

```
cluster-bus-status --view "summary"
cluster-bus-status --view "topology"
cluster-bus-status --view "mermaid"
cluster-bus-status --view "nodes"
```

## 2. Register a cluster node with capabilities

```json
cluster-bus-topology --action "register" --limit 50 \
  --clusterId "backend-cluster" \
  --clusterName "Backend LLM Node" \
  --capabilities '["code-generation", "code-review", "typescript"]' \
  --metaTags '["role:worker", "lang:typescript", "tier:pro"]' \
  --ttlSeconds 3600
```

## 3. List all registered nodes and providers

```
cluster-bus-topology --action "list" --limit 50
cluster-bus-topology --action "providers" --limit 50
cluster-bus-topology --action "history" --limit 100
```

## 4. Send signals between clusters

### Unicast — direct to a specific cluster

```json
cluster-bus-send --mode "unicast" \
  --targetCluster "backend-cluster" \
  --signalType "llm:request" \
  --payload '{"prompt": "Review this auth middleware", "files": ["src/auth/middleware.ts"]}' \
  --direction "downstream" \
  --priority 2
```

### Broadcast — to all connected clusters

```json
cluster-bus-send --mode "broadcast" \
  --signalType "data:broadcast" \
  --payload '{"message": "New coding standard: use Zod for all validations", "scope": "all"}' \
  --direction "duplex" \
  --priority 1
```

### Routed — via meta-tag rules

```json
cluster-bus-send --mode "routed" \
  --signalType "llm:request" \
  --payload '{"prompt": "Optimize this SQL query", "context": "PostgreSQL 16"}' \
  --direction "downstream" \
  --priority 2
```

Meta-tag routing delivers signals only to clusters matching `role:worker` + `lang:sql` tags.

## 5. Magistrale — distributed LLM dispatch

The Magistrale dispatches a single prompt across multiple cluster nodes in parallel, then aggregates results using configurable strategies.

### First-wins (fastest response)

```json
cluster-bus-magistrale \
  --prompt "Explain the Observer pattern with a TypeScript example" \
  --strategy "first-wins" \
  --maxTargets 3 \
  --timeoutMs 30000 \
  --minResponses 1 \
  --qualityThreshold 0.7 \
  --passStrategy "min-passes"
```

### Best-of-N (highest quality)

```json
cluster-bus-magistrale \
  --prompt "Design a rate limiter for a REST API handling 10k req/s" \
  --strategy "best-of-n" \
  --maxTargets 3 \
  --timeoutMs 60000 \
  --minResponses 2 \
  --qualityThreshold 0.85 \
  --passStrategy "quality-target" \
  --maxPasses 5
```

### Consensus (agreement between clusters)

```json
cluster-bus-magistrale \
  --prompt "Should we use Redis or PostgreSQL for session storage? Context: 50k concurrent users, need sub-10ms reads" \
  --strategy "consensus" \
  --maxTargets 3 \
  --timeoutMs 45000 \
  --minResponses 2 \
  --qualityThreshold 0.8 \
  --passStrategy "min-passes"
```

### Fallback-chain (cascade on failure)

```json
cluster-bus-magistrale \
  --prompt "Generate unit tests for the payment service" \
  --strategy "fallback-chain" \
  --maxTargets 3 \
  --timeoutMs 30000 \
  --minResponses 1 \
  --qualityThreshold 0.7 \
  --passStrategy "fixed" \
  --maxPasses 1 \
  --preferredProvider "anthropic"
```

## 6. Multi-pass quality control

The Pass Controller supports 3 strategies:

| Strategy | Behavior |
|----------|----------|
| `min-passes` | LLM self-assesses complexity, declares minimum passes, early-stops on quality |
| `quality-target` | Iterates until quality >= threshold or budget exhausted |
| `fixed` | Executes exactly N passes, no assessment |

```json
cluster-bus-magistrale \
  --prompt "Refactor this 500-line function into clean modules" \
  --strategy "best-of-n" \
  --maxTargets 2 \
  --timeoutMs 90000 \
  --minResponses 1 \
  --qualityThreshold 0.9 \
  --passStrategy "quality-target" \
  --maxPasses 10
```

## 7. Signal flow control

The Signal Flow Controller provides:
- **Backpressure** — queues signals when rate limits are hit
- **Rate limiting** — per-signal-type throughput caps
- **Priority filtering** — drops low-priority signals under pressure
- **Directional control** — upstream (leaf→hub), downstream (hub→leaf), duplex

## 8. Generate Mermaid topology diagram

```
cluster-bus-topology --action "mermaid" --limit 50
```

Outputs a Mermaid graph showing all registered clusters, their capabilities, and connections.
