# 3-Layer Bus Architecture

The kemdiCode MCP server uses a 3-layer bus architecture for inter-module, inter-process, and inter-cluster communication. Each layer has its own Redis path, and bridges connect them with anti-amplification guards.

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
|  ||  12 signal types:                                                  ||
|  ||    llm:request  llm:result  llm:stream-chunk  llm:error            ||
|  ||    cluster:join  cluster:leave  cluster:heartbeat                   ||
|  ||    data:broadcast  data:unicast                                     ||
|  ||    control:pause  control:resume  control:config                    ||
|  ||                                                                    ||
|  ||  3 send modes: unicast | broadcast | routed (meta-tag)             ||
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
|  ||  +-------------------------+ +---------------------------+         ||
|  ||  | EventBridge             | | DataFlowBridge            |         ||
|  ||  | L3 <-> L1               | | L3 <-> L2                 |         ||
|  ||  |                         | |                           |         ||
|  ||  | hop limit = 5           | | hop limit = 5             |         ||
|  ||  | anti-echo: source guard | | anti-echo: prefix guard   |         ||
|  ||  |                         | |                           |         ||
|  ||  | L3->L1:                 | | L3->L2:                   |         ||
|  ||  |   cluster:join/leave    | |   llm:result -> ai:compl  |         ||
|  ||  |   cluster:heartbeat     | |   llm:error -> cogn:error |         ||
|  ||  |                         | |   data:broadcast -> conf  |         ||
|  ||  | L1->L3:                 | |                           |         ||
|  ||  |   kanban:task:critical  | | L2->L3:                   |         ||
|  ||  |   cogn:decision:record  | |   ai:completion -> unicast|         ||
|  ||  +-------------------------+ |   agent:status -> bcast   |         ||
|  ||                              |   system:health -> hbeat  |         ||
|  ||                              +---------------------------+         ||
|  +======================================================================+
|                |                                |                      |
|  +======================================================================+
|  ||                                                                    ||
|  ||  L2: DataFlowBus  (in-process + Redis mcp:dataflow:{channel})      ||
|  ||                                                                    ||
|  ||  12 typed channels with Zod payload schemas:                       ||
|  ||                                                                    ||
|  ||  +----------------+ +-------------------+ +--------------------+   ||
|  ||  | AI             | | Kanban            | | Cognition          |   ||
|  ||  |                | |                   | |                    |   ||
|  ||  | ai:completion  | | kanban:task-change| | cognition:decision |   ||
|  ||  | ai:structured  | | kanban:complexity | | cognition:intent   |   ||
|  ||  | ai:research    | |                   | | cognition:error    |   ||
|  ||  +----------------+ +-------------------+ +--------------------+   ||
|  ||                                                                    ||
|  ||  +----------------+ +-------------------+                          ||
|  ||  | Agent          | | System            |                          ||
|  ||  |                | |                   |                          ||
|  ||  | agent:status   | | system:health     |                          ||
|  ||  | agent:message  | | system:config     |                          ||
|  ||  +----------------+ +-------------------+                          ||
|  ||                                                                    ||
|  ||  DataFlowEnvelope: id, channel, payload, source, target,           ||
|  ||    sessionId, agentId, correlationId, schemaVersion, priority, ttl ||
|  ||                                                                    ||
|  ||  Features: correlation chains | priority 0-3 | TTL enforcement     ||
|  ||            source filter | target filter | history (max 200)       ||
|  ||            dedup via messageIds Set | circular buffer history      ||
|  ||            Map-based subscriptions (O(1) unsub)                    ||
|  ||            idle subscription cleanup (60min TTL)                   ||
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

## 3 Independent Redis Paths

Each layer has its own direct Redis connection. Bridges synchronize between layers but each layer also operates independently.

| Layer | Redis Key Pattern | Purpose |
|:------|:------------------|:--------|
| **L3** ClusterBus | `mcp:cluster:*` | Inter-cluster signal routing via Pub/Sub |
| **L2** DataFlowBus | `mcp:dataflow:{channel}` | Cross-process typed message delivery |
| **L1** GlobalEventBus | `mcp:events:{type}` | Cross-session event propagation + history |

## Anti-Amplification Guards

Signals crossing between layers can create feedback loops. Three mechanisms prevent this:

| Guard | Location | Mechanism |
|:------|:---------|:----------|
| **Hop limit** | bridges.ts | `MAX_BRIDGE_HOPS = 5` — signals carry `_bridgeHops` counter, dropped when exceeded |
| **Source prefix** | bridges.ts | DataFlowBridge skips messages with `source.startsWith("cluster:")` to prevent echo |
| **Dedup** | bus.ts, dataflow/bus.ts | ClusterBus uses `seenSet` (5000+), DataFlowBus uses `messageIds` Set |
| **Chain depth** | global-bus.ts | `MAX_EVENT_CHAIN_DEPTH = 8` — events emitted from handlers increment depth |

## Signal Flow: Complete Cycle

A typical end-to-end flow through all 3 layers:

```
1. Magistrale dispatches prompt to Cluster B                    (L3)
2. llm:request signal travels via Redis Pub/Sub                 (L3)
3. Cluster B receives, PassController executes multi-pass       (L3)
4. llm:result signal sent back to Cluster A                     (L3)
5. DataFlowBridge maps llm:result -> ai:completion              (L3->L2)
6. Cognition module subscribes to ai:completion                 (L2)
7. Decision context logged, emits cognition:decision:recorded   (L1)
8. Cognition handler auto-creates confidence record             (L1)
9. CognitionCrossLinker creates bidirectional Redis link        (Redis)
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
10. connectBridges(bus)             — wire L3 <-> L2 and L3 <-> L1
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
