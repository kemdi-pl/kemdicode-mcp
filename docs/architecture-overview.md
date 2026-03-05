# Architecture Overview

## System Layers

```
+-----------------------------------------------------------------+
|                        MCP Clients                              |
|  Claude Code  |  Cursor  |  KiroCode  |  RooCode               |
+-------+---------------+---------------+----------+--------------+
        |               |               |          |
        +-------+-------+-------+-------+----------+
                |               |
         SSE (events)    JSON-RPC (tools)
                |               |
+-------+-------+-------+-------+----------------------------------+
|                                                                  |
|  HTTP Server  (:3100, Bun or Node.js)                            |
|  Routes: /sse  /message  /resume  /stream  /health               |
|                                                                  |
+--+-----+-----+-----+-----+-----+-----+-----+-----+-----+------+
   |     |     |     |     |     |     |     |     |     |
   v     v     v     v     v     v     v     v     v     v
+------------------------------------------------------------------+
|                                                                  |
|  Session Manager                                                 |
|  Per-client isolation | CWD injection | activity tracking        |
|  SSE keep-alive | auto-sessionId                                 |
|                                                                  |
+--+---------------------------------------------------------------+
   |
   v
+------------------------------------------------------------------+
|                                                                  |
|  Tool Registry  (107 tools, 19 categories)                       |
|  Zod schema validation | auto JSON Schema generation             |
|  tool annotations (readOnly/destructive/openWorld hints)         |
|  lazy loading | tools/list_changed broadcast                     |
|  executeWithGuard() | handleToolError()                          |
|                                                                  |
+--+----+----+----+----+----+----+----+----+----+----+----+-------+
   |    |    |    |    |    |    |    |    |    |    |    |
   v    v    v    v    v    v    v    v    v    v    v    v
+------------------------------------------------------------------+
|  Tool Categories:                                                |
|                                                                  |
|  core-ai (6)     | cognition (8)  | multi-agent(10)| multi-llm(3)|
|  code (4)        | context (3)    | kanban (25)    | memory (8)  |
|  recursive (4)   | session (6)    | thinking (1)   | knowledge(4)|
|  cluster-bus (8) | mpc (4)        | rl (2)         | mcp-client(3)|
|  system (8)      |                |                |             |
+------------------------------------------------------------------+
   |         |         |         |
   v         v         v         v
+------------------------------------------------------------------+
|                                                                  |
|  3-Layer Bus Architecture                                        |
|  See: docs/architecture-3-layer-bus.md                           |
|                                                                  |
|  L3: ClusterBus     — inter-cluster (Redis Pub/Sub)              |
|  L2: DataFlowBus    — inter-module  (12 typed channels)          |
|  L1: GlobalEventBus — in-process    (namespaced events)          |
|                                                                  |
+--+---------------------------------------------------------------+
   |
   v
+------------------------------------------------------------------+
|                                                                  |
|  Shared Infrastructure                                           |
|                                                                  |
|  +--------------------+  +------------------------------------+  |
|  | Provider Registry  |  | Redis (DB 2)                       |  |
|  |                    |  |                                    |  |
|  | 8 LLM providers    |  | mcp:context:*   shared outputs    |  |
|  | native SDKs:       |  | mcp:agents:*    agent registry    |  |
|  |   Anthropic        |  | mcp:kanban:*    tasks/boards      |  |
|  |   Gemini           |  | mcp:memory:*    project memory    |  |
|  |   OpenAI           |  | mcp:cognition:* decisions/models  |  |
|  | OpenAI-compatible: |  | mcp:cluster:*   cluster signals   |  |
|  |   Groq             |  | mcp:dataflow:*  typed messages    |  |
|  |   DeepSeek         |  | mcp:events:*    event history     |  |
|  |   Ollama           |  | mcp:messages:*  inter-agent msgs  |  |
|  |   OpenRouter       |  | mcp:channel:*   pub/sub channels  |  |
|  |   Perplexity       |  |                                    |  |
|  |                    |  | Pub/Sub channels:                  |  |
|  | lazy init          |  |   broadcast, inject:<agentId>,     |  |
|  | hot-reload         |  |   alerts, thoughts                 |  |
|  | structured output  |  +------------------------------------+  |
|  +--------------------+                                          |
|                                                                  |
|  +--------------------+  +------------------------------------+  |
|  | Tree-sitter AST    |  | Runtime Abstraction               |  |
|  |                    |  |                                    |  |
|  | 19 languages       |  | auto-detect Bun / Node.js         |  |
|  | WASM parsers       |  | unified HTTP, process, crypto     |  |
|  | symbol navigation  |  |                                    |  |
|  | rename/insert      |  |                                    |  |
|  +--------------------+  +------------------------------------+  |
+------------------------------------------------------------------+
```

## Cognition Layer

The cognition layer gives agents persistent self-awareness across sessions. See [architecture-3-layer-bus.md](architecture-3-layer-bus.md) for the event flow details.

```
+------------------------------------------------------------------+
|  Cognition Stores (Redis-backed, configurable TTL)               |
|                                                                  |
|  +----------------+  +------------------+  +-----------------+   |
|  | DecisionStore  |  | ConfidenceStore  |  | IntentStore     |   |
|  | question       |  | score (0-1)      |  | mission         |   |
|  | options[]      |  | domain           |  | goals[]         |   |
|  | chosen         |  | calibration      |  | drift detection |   |
|  | reasoning      |  | trends           |  |                 |   |
|  | outcome        |  |                  |  |                 |   |
|  +-------+--------+  +--------+---------+  +--------+--------+   |
|          |                    |                      |            |
|          +--------------------+----------------------+            |
|                               |                                  |
|                    +----------+----------+                       |
|                    | CognitionCrossLinker |                       |
|                    | bidirectional Redis  |                       |
|                    | links between stores |                       |
|                    +----------+----------+                       |
|                               |                                  |
|          +--------------------+----------------------+            |
|          |                    |                      |            |
|  +-------+--------+  +-------+----------+  +--------+--------+  |
|  | ErrorPatternDB |  | SelfCritiqueStore|  | MentalModelStore|  |
|  | cross-session   |  | reflect          |  | components      |  |
|  | match by symptom|  | lessons[]        |  | relationships   |  |
|  | fix suggestions |  | check-application|  | impact analysis |  |
|  +----------------+  +------------------+  | dependency chain|  |
|                                            | invariant check |  |
|  +----------------+  +------------------+  +-----------------+  |
|  | HandoffStore   |  | ContextBudget    |                       |
|  | auto-enriched   |  | token estimation |                       |
|  | full snapshot   |  | trim suggestions |                       |
|  +----------------+  +------------------+                       |
|                                                                  |
|  +------------------+  +------------------+                      |
|  | AmbientLearner   |  | AgentRankStore   |                      |
|  | tool sequences    |  | composite score  |                      |
|  | file relations    |  | bronze -> diamond|                      |
|  | time patterns     |  | decay over time  |                      |
|  +------------------+  +------------------+                      |
+------------------------------------------------------------------+
```

## Multi-Agent Coordination

```
+------------------------------------------------------------------+
|  Session A (lead)              Session B (worker)                 |
|                                                                  |
|  +-------------------+         +-------------------+             |
|  | Supervisor Agent  |         | Worker Agent      |             |
|  | role: supervisor  |         | role: worker      |             |
|  +--------+----------+         +--------+----------+             |
|           |                             |                        |
|           |    agent-register           |                        |
|           |    agent-alert (broadcast)  |                        |
|           |    agent-inject (context)   |                        |
|           |    task-push-multi          |                        |
|           |                             |                        |
|           +-------------+---------------+                        |
|                         |                                        |
|              +----------+----------+                             |
|              | Redis Pub/Sub       |                             |
|              |                     |                             |
|              | broadcast channel   |                             |
|              | inject:<agentId>    |                             |
|              | alerts channel      |                             |
|              | thoughts channel    |                             |
|              +----------+----------+                             |
|                         |                                        |
|              +----------+----------+                             |
|              | Kanban System       |                             |
|              |                     |                             |
|              | Workspaces          |                             |
|              |   -> Boards         |                             |
|              |      -> Tasks       |                             |
|              |         -> Claims   |                             |
|              |         -> Comments |                             |
|              |         -> Clusters |                             |
|              +---------------------+                             |
+------------------------------------------------------------------+
```
