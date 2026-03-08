# 2-Layer Bus Architecture

The kemdiCode MCP server uses a 2-layer bus architecture for inter-process and inter-cluster communication. Each layer has its own Redis path, and bridges connect them with anti-amplification guards.

## Overview

```
+-----------------------------------------------------------------------+
|                                                                       |
|   CLUSTER A                              CLUSTER B                    |
|                                                                       |
|   +-----------+  +-----------+    +-----------+  +-----------+        |
|   | Anthropic |  |  Ollama   |    |  OpenAI   |  |  Gemini   |        |
|   +-----+-----+  +-----+-----+    +-----+-----+  +-----+-----+       |
|         |               |                |               |             |
|         +-------+-------+                +-------+-------+             |
|           ProviderPool                     ProviderPool                |
|                |                                |                      |
|   +------------+------------+    +------------+------------+          |
|   |     LLMMagistrale       |    |     LLMMagistrale       |          |
|   |  +------------------+   |    |  +------------------+   |          |
|   |  | PassController   |   |    |  | PassController   |   |          |
|   |  | min-passes       |   |    |  | quality-target   |   |          |
|   |  | quality-target   |<========>| fixed            |   |          |
|   |  | fixed            |  duplex |  | min-passes       |   |          |
|   |  +------------------+   |    |  +------------------+   |          |
|   +------------+------------+    +------------+------------+          |
|                |                                |                      |
|  +======================================================================+
|  ||                                                                    ||
|  ||  L3: ClusterBus  (Redis Pub/Sub, mcp:cluster:*)                    ||
|  ||                                                                    ||
|  ||  18 signal types:                                                  ||
|  ||    llm:request  llm:result  llm:stream-chunk  llm:error            ||
|  ||    cluster:join  cluster:leave  cluster:heartbeat                   ||
|  ||    data:broadcast  data:unicast                                     ||
|  ||    control:pause  control:resume  control:config                    ||
|  ||    ci:build  ci:test  ci:deploy  ci:multicast  ci:result  ci:status||
|  ||                                                                    ||
|  ||  4 send modes: unicast | broadcast | routed | multicast            ||
|  ||  Dedup: seen set (5000+) | Signal history: 500                     ||
|  ||                                                                    ||
|  ||  +------------------+ +---------------+ +-------------------+      ||
|  ||  | SignalFlowCtrl   | | MetaRouter    | | HealthMonitor     |      ||
|  ||  |                  | |               | |                   |      ||
|  ||  | - backpressure   | | - exact match | | - heartbeat send  |      ||
|  ||  | - rate limiting  | | - wildcard    | | - stale detection |      ||
|  ||  | - priority filter| | - regex       | | - auto pruning    |      ||
|  ||  | - queue depth    | | - prefix      | | - online count    |      ||
|  ||  | - buffer/drop    | | - AND/OR      | | - Map handlers    |      ||
|  ||  | - circuit breaker| |               | |   (O(1) unsub)   |      ||
|  ||  | - bloom filter   | |               | |                   |      ||
|  ||  | - HMAC auth      | |               | |                   |      ||
|  ||  +------------------+ +---------------+ +-------------------+      ||
|  ||                                                                    ||
|  ||  +-------------------------+                                       ||
|  ||  | EventBridge             |                                       ||
|  ||  | L3 <-> L1               |                                       ||
|  ||  |                         |                                       ||
|  ||  | hop limit = 5           |                                       ||
|  ||  | anti-echo: source guard |                                       ||
|  ||  |                         |                                       ||
|  ||  | L3->L1:                 |                                       ||
|  ||  |   cluster:join/leave    |                                       ||
|  ||  |   cluster:heartbeat     |                                       ||
|  ||  |                         |                                       ||
|  ||  | L1->L3:                 |                                       ||
|  ||  |   kanban:task:critical  |                                       ||
|  ||  |   cogn:decision:record  |                                       ||
|  ||  +-------------------------+                                       ||
|  +======================================================================+
|                |                                |                      |
|  +======================================================================+
|  ||                                                                    ||
|  ||  L1: GlobalEventBus  (in-process + Redis mcp:events:{type})        ||
|  ||                                                                    ||
|  ||  Singleton EventEmitter with:                                      ||
|  ||    - namespaced events (module:category:action)                    ||
|  ||    - async handlers via queueMicrotask                             ||
|  ||    - max chain depth = 8 (prevents cascading storms)               ||
|  ||    - max listeners = 100 (env: MCP_EVENT_MAX_LISTENERS)            ||
|  ||    - leak detection at 80% threshold                               ||
|  ||    - Redis bridge with retry (max 2 retries, 200ms backoff)        ||
|  ||    - capped history per session (100 events, 1h TTL)               ||
|  ||                                                                    ||
|  ||  CognitionEventBus: thin wrapper, auto-prefixes "cognition:"       ||
|  +======================================================================+
|                |                                                       |
|  +--------------------------------------------------------------------+|
|  |                                                                    ||
|  |  Module Handlers (subscribe to L1 events)                          ||
|  |                                                                    ||
|  |  Cognition (9 handlers)          Kanban (2)       Loop (2)         ||
|  |  +--------------------------+    +-------------+  +-------------+  ||
|  |  | decision:recorded        |    | task:created|  | tool-called |  ||
|  |  |   -> auto confidence     |    |   critical  |  |   frequency |  ||
|  |  |   -> cross-link (Redis)  |    |   alert     |  |   tracking  |  ||
|  |  |                          |    |             |  |             |  ||
|  |  | confidence:low           |    | task:done   |  | loop:done   |  ||
|  |  |   -> intent drift check  |    |   metrics   |  |   failure   |  ||
|  |  |                          |    +-------------+  |   -> error  |  ||
|  |  | error:recorded           |                     |   pattern   |  ||
|  |  |   -> scan recent decisions|                    +-------------+  ||
|  |  |   -> cross-link matches  |                                      ||
|  |  |                          |                                      ||
|  |  | error:matched            |                                      ||
|  |  |   -> log known fix       |                                      ||
|  |  |                          |                                      ||
|  |  | critique:lesson-learned  |                                      ||
|  |  |   -> link to error pats  |                                      ||
|  |  |                          |                                      ||
|  |  | intent:drifted           |                                      ||
|  |  |   -> auto self-critique  |                                      ||
|  |  |                          |                                      ||
|  |  | handoff:created          |                                      ||
|  |  |   -> link mental models  |                                      ||
|  |  |                          |                                      ||
|  |  | model:stale              |                                      ||
|  |  |   -> flag decisions      |                                      ||
|  |  |   -> flag active intents |                                      ||
|  |  |                          |                                      ||
|  |  | confidence:outcome       |                                      ||
|  |  |   -> propagate to        |                                      ||
|  |  |      linked decisions    |                                      ||
|  |  +--------------------------+                                      ||
|  +--------------------------------------------------------------------+|
+------------------------------------------------------------------------+
```

## 2 Independent Redis Paths

Each layer has its own direct Redis connection. Bridges synchronize between layers but each layer also operates independently.

| Layer | Redis Key Pattern | Purpose |
|:------|:------------------|:--------|
| **L3** ClusterBus | `mcp:cluster:*` | Inter-cluster signal routing via Pub/Sub |
| **L1** GlobalEventBus | `mcp:events:{type}` | Cross-session event propagation + history |

## Anti-Amplification Guards

Signals crossing between layers can create feedback loops. Three mechanisms prevent this:

| Guard | Location | Mechanism |
|:------|:---------|:----------|
| **Hop limit** | bridges.ts | `MAX_BRIDGE_HOPS = 5` — signals carry `_bridgeHops` counter, dropped when exceeded |
| **Source prefix** | bridges.ts | EventBridge skips messages with source prefix to prevent echo |
| **Dedup** | bus.ts | ClusterBus uses `seenSet` (5000+) |
| **Chain depth** | global-bus.ts | `MAX_EVENT_CHAIN_DEPTH = 8` — events emitted from handlers increment depth |

## Signal Flow: Complete Cycle

A typical end-to-end flow through both layers:

```
1. Magistrale dispatches prompt to Cluster B                    (L3)
2. llm:request signal travels via Redis Pub/Sub                 (L3)
3. Cluster B receives, PassController executes multi-pass       (L3)
4. llm:result signal sent back to Cluster A                     (L3)
5. EventBridge maps cluster event to L1 event                   (L3->L1)
6. Decision context logged, emits cognition:decision:recorded   (L1)
7. Cognition handler auto-creates confidence record             (L1)
8. CognitionCrossLinker creates bidirectional Redis link        (Redis)
```

## Initialization Sequence

Defined in `src/cluster-bus/init.ts`:

```
1. loadClusterBusConfig()           — read MCP_CLUSTER_* env vars
2. initClusterBus(config)           — connect Redis Pub/Sub publisher + subscriber
3. registerCustomEndpoint()         — add custom LLM endpoints to provider registry
4. registerCluster()                — register this node in cluster mesh
5. addPolicy(defaultLLMPolicy)      — apply SignalFlowController policies
6. addPolicy(defaultControlPolicy)
7. addPolicy(defaultHeartbeatPolicy)
8. addRule(routeToAnyLLM)           — add default MetaRouter rule
9. HealthMonitor.start()            — begin heartbeat + prune cycles
10. connectBridges(bus)             — wire L3 <-> L1
11. onSignal('llm:request', ...)    — register local LLM request handler
```

## Magistrale Aggregation Strategies

| Strategy | Behavior | Use Case |
|:---------|:---------|:---------|
| `first-wins` | Return first response, cancel others | Low-latency, non-critical |
| `best-of-n` | Score all responses, pick highest quality | Code generation, analysis |
| `consensus` | Jaccard similarity scoring, require agreement | Architecture decisions |
| `fallback-chain` | Try clusters in order, stop on first success | High availability |

## Pass Controller Strategies

| Strategy | Behavior |
|:---------|:---------|
| `min-passes` | LLM self-assesses complexity, declares minimum passes (capped to `maxPasses` budget), early-stops on quality |
| `quality-target` | Iterates until quality >= threshold or budget exhausted |
| `fixed` | Skips assessment, executes exactly N passes |

## MetaRouter Match Modes

| Mode | Example | Behavior |
|:-----|:--------|:---------|
| `exact` | `role:worker` | Tag value must match exactly |
| `wildcard` | `role:*` | Any value for the key |
| `prefix` | `tier:pro` | Tag value starts with pattern |
| `regex` | `lang:type.*` | Regex match (max 200 chars, ReDoS-safe) |

Rules support `AND` / `OR` logic, priority ordering, and terminal flag (stop evaluation after match).
