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
|  HTTP Server  (:3100, Bun)                                       |
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
|  Tool Registry  (61 tools, 15 categories)                        |
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
|  core-ai (6)     | cognition (8)  | agents (3)    | multi-llm(3)|
|  code (3)        | context (3)    | kanban (4)    | memory (2)  |
|  recursive (4)   | session (1)    | thinking (1)  | knowledge(4)|
|  cluster-bus (8) | mcp-client (3) | system (8)    |             |
+------------------------------------------------------------------+
   |         |         |         |
   v         v         v         v
+------------------------------------------------------------------+
|                                                                  |
|  2-Layer Bus Architecture                                        |
|  See: docs/architecture-2-layer-bus.md                           |
|                                                                  |
|  L3: ClusterBus     — inter-cluster (Redis Pub/Sub)              |
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
|  |   Groq             |  | mcp:events:*    event history     |  |
|  |   DeepSeek         |  | mcp:messages:*  inter-agent msgs  |  |
|  |   Ollama           |  | mcp:channel:*   pub/sub channels  |  |
|  |   OpenRouter       |  |                                    |  |
|  |   Perplexity       |  | Pub/Sub channels:                  |  |
|  |                    |  |   broadcast, inject:<agentId>,     |  |
|  | lazy init          |  |   alerts, thoughts                 |  |
|  | hot-reload         |  +------------------------------------+  |
|  | structured output  |                                          |
|  +--------------------+                                          |
|                                                                  |
|  +--------------------+                                          |
|  | Tree-sitter AST    |                                          |
|  |                    |                                          |
|  | 19 languages       |                                          |
|  | WASM parsers       |                                          |
|  | symbol navigation  |                                          |
|  +--------------------+                                          |
+------------------------------------------------------------------+
```

## Cognition Layer

The cognition layer gives agents persistent self-awareness across sessions.

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

## The Nine Minds

Nine specialized cognitive agents, each a different mode of thinking. Inspired by [Ouroboros](https://github.com/Q00/ouroboros) by Harry Munro. Loaded on-demand via `src/ai/minds.ts`. Each Mind is a system prompt with strict behavioral constraints, accessible as the `agent` parameter in `ask-ai`, `agent-orchestrate`, `multi-prompt`, and `consensus-prompt`.

```
+------------------------------------------------------------------+
|  The Nine Minds (src/ai/minds.ts)                                |
|                                                                  |
|  Interrogative    Classificatory    Crystallizing                 |
|  +-----------+    +-----------+    +---------------+              |
|  | Socratic  |    | Ontologist|    | Seed Architect|              |
|  | questions |    | essence   |    | specs         |              |
|  | only      |    | not       |    | from          |              |
|  |           |    | symptoms  |    | dialogue      |              |
|  +-----------+    +-----------+    +---------------+              |
|                                                                  |
|  Verificatory     Adversarial      Lateral                       |
|  +-----------+    +-----------+    +-----------+                  |
|  | Evaluator |    | Contrarian|    | Hacker    |                  |
|  | 3-stage   |    | steelman |    | constraint|                  |
|  | verify    |    | opposite  |    | breaking  |                  |
|  +-----------+    +-----------+    +-----------+                  |
|                                                                  |
|  Reductive        Evidential       Structural                    |
|  +-----------+    +-----------+    +-----------+                  |
|  | Simplifier|    | Researcher|    | Architect |                  |
|  | remove    |    | evidence  |    | structural|                  |
|  | complexity|    | first     |    | causes    |                  |
|  +-----------+    +-----------+    +-----------+                  |
|                                                                  |
|  Composition Patterns:                                           |
|    Dialectical:  Socratic -> Ontologist -> Seed Architect        |
|    Adversarial:  Architect -> Contrarian -> Evaluator            |
|    Evidence:     Researcher -> Hacker -> Simplifier              |
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
|           |    agent action=register    |                        |
|           |    agent-comm action=alert  |                        |
|           |    agent-comm action=inject |                        |
|           |    task-multi action=push   |                        |
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
|              +---------------------+                             |
+------------------------------------------------------------------+
```
