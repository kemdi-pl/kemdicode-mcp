# KemdiCode MCP Server v3.2.0 "Lorenz"

## How to Use kemdiCode MCP

You have access to kemdiCode MCP tools. Use them actively — they don't run automatically.

### Thinking Chains

When solving complex problems (debugging, architecture decisions, multi-step analysis):

1. **Start** a chain: `thinking-chain` action=start with title and first thought
2. **Think** step by step: action=think — add each reasoning step as a new thought with confidence %
3. **Conclude** when done: action=conclude with final answer
4. **Compact** concluded chains: action=compact — runs Lorenz pipeline (Phase Detection → Orbit Compression → CTC Fixed-Point) to prune redundant thoughts

### Cognition Tools

Use these to build persistent self-awareness across sessions:

- **`error-pattern`** — when you encounter a bug, record it (action=record). Before debugging, check for known patterns (action=match). After fixing, update the outcome (action=update)
- **`decision-journal`** — record architectural decisions with options, reasoning, and chosen path. Later, record outcomes to learn from past choices
- **`confidence-tracker`** — track your confidence per domain. Helps calibrate when you're guessing vs. knowing
- **`intent-tracker`** — set the current mission/goals. Detects drift if your work diverges from stated goals
- **`mental-model`** — build and query mental models of system architecture (components, relationships, invariants)
- **`self-critique`** — after completing a task, reflect: what went well, what didn't, lessons learned
- **`context-budget`** — estimate what cognition data is worth keeping. Items with high perturbation impact (Lorenz) are critical anchors — don't evict them

### Smart Handoff

Before ending a session or when context is getting large:
- `smart-handoff` — creates a structured handoff report with full context snapshot
- Next session: `session-recover` restores everything

### Project Memory

- `write-memory` / `read-memory` — persist key-value data across sessions (decisions, config, notes)
- `checkpoint-save` / `checkpoint-restore` — snapshot and restore full project state

### Error Investigation Pattern

When debugging:
1. `error-pattern` action=match — check if this error was seen before
2. `thinking-chain` action=start — begin structured reasoning
3. Add thoughts as you investigate (action=think)
4. `error-pattern` action=record — record the pattern with root cause and fix
5. `thinking-chain` action=conclude — document the solution
6. `thinking-chain` action=compact — prune redundant thoughts via Lorenz

### Architecture Decision Pattern

When making design choices:
1. `decision-journal` action=record — document the decision with options, reasoning, chosen path
2. `mental-model` action=create — build a model of affected components and relationships
3. `confidence-tracker` action=record — log your confidence in the decision
4. Later: `decision-journal` action=update-outcome — record what actually happened

### Code Exploration Pattern

When navigating unfamiliar code:
1. `find-definition` — locate a symbol's definition
2. `find-references` — find all usages
3. `semantic-search` — search by concept, not just text
4. `write-memory` — persist key findings for later sessions

### Session Continuity Pattern

For long-running work across sessions:
1. `intent-tracker` action=set — define current mission and goals
2. Work normally, using cognition tools to record decisions and errors
3. `smart-handoff` — create structured handoff before ending
4. Next session: `session-recover` — restore full context in one call

### Multi-Agent Collaboration Pattern

When coordinating multiple agents:
1. `agent-init` — onboard with role and capabilities
2. `task-create` / `task-push-multi` — create and distribute tasks
3. `shared-thoughts` — share findings between agents
4. `agent-alert` — broadcast important updates
5. `agent-rank` — track agent performance over time

### Kanban Sprint Pattern

For structured project work:
1. `workspace-create` + `board-create` — set up project board
2. `task-create` / `task-push-multi` — add tasks
3. `task-claim` / `task-assign` — assign work
4. `task-update` — move through workflow (todo → in-progress → done)
5. `board-status` — view sprint progress
6. `task-complexity` — estimate task difficulty

### Knowledge Graph Pattern

For building cross-session knowledge:
1. `graph-query` action=add-node/add-edge — build error→solution graphs
2. `graph-find-path` — find paths between problems and solutions
3. `loci-recall` — resurrect relevant knowledge from past sessions
4. `sequence-recommend` — get tool sequence suggestions based on history

## Session Recovery

After compaction or session start, run `session-recover` to restore full context in one call. This orchestrates: active-session memory, latest handoff, loci resurrection, tool availability, agent rankings, and ambient learning insights.

Alternatively: `read-memory --names ["active-session"]` and update with `write-memory` when the active session changes.

## Overview

Model Context Protocol (MCP) server providing **108 specialized tools** across 19 categories: cognition & self-improvement, thinking chains, multi-agent coordination, multi-board kanban with workspaces, task clustering & complexity, project memory, cluster bus with LLM magistrale, Lorenz-inspired context compaction, recursive tool invocation, pipelines, session monitoring, structured output, data flow bus, and MCP client capabilities.

**v3.0 removes 39 tools** that duplicate native IDE AI capabilities (file ops, git, line/symbol editing, code review, project management). kemdiCode now focuses on what IDEs *cannot* do natively.

**8 LLM providers**: OpenAI, Anthropic, Gemini, Groq, DeepSeek, Ollama, OpenRouter, Perplexity. Provider syntax: `provider:model:thinking` (e.g., `a:claude-sonnet-4-5:4k`, `p:sonar-pro`).

**694 unit tests** across 29 test files. See `docs/whitepaper-kemdicode-mcp-v3.0.pdf` for the full technical whitepaper.

## Architecture

```
src/
├── index.ts                 # HTTP server, SSE handlers, MCP protocol
├── constants.ts             # CLI flags, error messages, timeouts
├── version.ts               # Central version (reads from package.json)
├── ai/                      # Multi-provider LLM integration
│   ├── client.ts            # Completion router (8 providers + fallback)
│   ├── execute.ts           # High-level AI execution with agents
│   ├── agents.ts            # Agent configurations (plan, build, explore)
│   ├── structured-output.ts # generateObject() with Zod + jsonrepair
│   ├── pricing.ts           # Model cost optimization and routing
│   ├── routing.ts           # Local vs external AI routing strategies
│   ├── model-spec.ts        # Parser for provider:model:thinking syntax
│   └── providers/           # Native LLM provider adapters (8 providers)
├── client/                  # MCP client capabilities bridge
├── cluster-bus/             # Distributed inter-cluster communication
│   ├── bus.ts               # ClusterBus: Redis Pub/Sub signal routing + multicast
│   ├── fan-in-aggregator.ts # CI fan-in result aggregation (all/first/majority/custom)
│   ├── llm-magistrale.ts    # LLM dispatch across clusters (4 strategies)
│   ├── pass-controller.ts   # Self-regulating multi-pass execution
│   ├── signal-flow.ts       # Backpressure, rate limiting, flow control
│   ├── meta-router.ts       # Meta-tag based signal routing + CI routing rules
│   ├── health-monitor.ts    # Heartbeat tracking, stale detection
│   ├── cluster-registry.ts  # Node registration and discovery
│   ├── provider-pool.ts     # LLM provider pool for clusters
│   └── bridges.ts           # DataFlow ↔ ClusterBus bridges
├── cognition/               # AI self-awareness (8 stores + event system + Lorenz compaction)
│   ├── ambient-learner.ts   # Silent knowledge gathering
│   ├── agent-rank-store.ts  # Agent ranking (bronze→diamond)
│   ├── decision-store.ts    # Decision journal with outcome tracking
│   ├── confidence-store.ts  # Confidence tracking with calibration
│   ├── mental-model-store.ts # System architecture mental models
│   ├── intent-store.ts      # Goal hierarchy with drift detection
│   ├── error-pattern-store.ts # Cross-session error database
│   ├── self-critique-store.ts # Post-session reflection
│   ├── handoff-store.ts     # Structured session handoff reports
│   ├── context-budget-manager.ts # Context window estimation
│   ├── cross-linker.ts      # Bidirectional Redis links
│   ├── event-handlers.ts    # Reactive cross-tool handlers
│   ├── ctc-math.ts          # CTC algorithms + perturbation impact
│   ├── phase-detector.ts    # Poincaré section phase detection (v3.0)
│   └── orbit-compressor.ts  # Lorenz attractor orbit compression (v3.0)
├── dataflow/                # Typed message bus (12 channels)
├── events/                  # Global event bus with Redis bridge
│   ├── global-bus.ts        # Singleton EventBus (async, namespaced)
│   ├── redis-bridge.ts      # Cross-session event propagation
│   └── handlers/            # Kanban + loop event handlers
├── kanban/                  # Task management
│   ├── kanban-store.ts      # Redis persistence for tasks
│   ├── cluster-store.ts     # LLM-driven task clustering
│   ├── workspace-store.ts   # Workspace CRUD
│   ├── board-store.ts       # Board management
│   └── membership-store.ts  # Role-based membership
├── recursive/               # Recursive tool invocation
│   ├── tool-invoker.ts      # Safe execution with limits
│   └── agentic-loop.ts      # Autonomous agent loops
├── runtime/                 # Cross-runtime abstraction (Bun/Node.js)
├── session/                 # Session management + auto-recovery
├── tree-sitter/             # AST-based code analysis (19 languages)
├── thinking/                # Thinking chain system
├── loci/                    # Knowledge graph + resurrection
├── mpc/                     # Multi-party computation (Shamir)
├── rl/                      # Reinforcement learning
├── utils/
│   ├── nlp.ts               # Unified NLP: tokenize, TF-IDF, stop words (v3.0)
│   └── ...                  # command executor, file, git, validation, logger
├── tools/
│   ├── registry.ts          # Unified tool interface, Zod schemas, annotations
│   ├── annotations-map.ts   # MCP protocol-level tool hints
│   ├── availability-checker.ts # Tool health + fallback suggestions
│   ├── tool-shared.ts       # executeWithGuard, handleToolError helpers
│   ├── agents/              # Agent monitoring (10 tools)
│   ├── cluster-bus/         # Cluster bus tools (8 tools)
│   ├── code/                # Code intelligence: find-definition, find-references, semantic-search (3 tools)
│   ├── client/              # MCP client capabilities (3 tools)
│   ├── cognition/           # AI self-improvement (8 tools)
│   ├── context/             # Context sharing (3 tools)
│   ├── kanban/              # Tasks, boards, workspaces, clustering (25 tools)
│   ├── loci/                # Knowledge graph + resurrection (4 tools)
│   ├── memory/              # Project memory (8 tools)
│   ├── mpc/                 # Multi-party computation (4 tools)
│   ├── multi-llm/           # Multi-provider LLM tools (3 tools)
│   ├── recursive/           # Recursive invocation + orchestrate (4 tools)
│   ├── rl/                  # Reinforcement learning (2 tools)
│   ├── session/             # Session management + recovery (6 tools)
│   ├── specialized/         # write-tests (1 tool)
│   ├── thinking/            # Thinking chain (1 tool)
│   └── system/              # System tools (8 tools)
├── types/                   # Shared type definitions
└── utils/                   # Helpers (command executor, file, git, validation, logger, NLP)
```

## Tool Categories (108 tools)

| Category | # | Key tools |
|----------|:-:|-----------|
| Core AI | 6 | `ask-ai` `plan` `build` `brainstorm` `batch` `pipeline` |
| Code Intelligence | 4 | `find-definition` `find-references` `semantic-search` `write-tests` |
| Multi-LLM | 3 | `multi-prompt` `consensus-prompt` `enhance-prompt` |
| Cognition | 8 | `decision-journal` `confidence-tracker` `mental-model` `intent-tracker` `error-pattern` `self-critique` `smart-handoff` `context-budget` |
| Multi-Agent | 10 | `agent-init` `agent-list` `agent-register` `agent-alert` `agent-inject` `agent-history` `monitor` `agent-summary` `queue-message` `agent-rank` |
| Context & Learning | 3 | `shared-thoughts` `get-shared-context` `feedback` |
| Kanban Tasks | 13 | `task-create` `task-get` `task-list` `task-update` `task-delete` `task-comment` `task-claim` `task-assign` `task-push-multi` `task-subtask` `board-status` `task-cluster` `task-complexity` |
| Kanban Workspaces | 5 | `workspace-create` `workspace-list` `workspace-join` `workspace-leave` `workspace-delete` |
| Kanban Boards | 7 | `board-create` `board-list` `board-share` `board-members` `board-invite` `board-delete` `board-workflow` |
| Project Memory | 8 | `write-memory` `read-memory` `list-memories` `edit-memory` `delete-memory` `checkpoint-save` `checkpoint-restore` `checkpoint-diff` |
| Recursive | 4 | `invoke-tool` `invoke-batch` `invocation-log` `agent-orchestrate` |
| Session | 6 | `session-list` `session-info` `session-create` `session-switch` `session-delete` `session-recover` |
| Thinking | 1 | `thinking-chain` |
| Knowledge Graph | 4 | `graph-query` `graph-find-path` `loci-recall` `sequence-recommend` |
| Cluster Bus | 8 | `cluster-bus-status` `cluster-bus-topology` `cluster-bus-send` `cluster-bus-magistrale` `cluster-bus-flow` `cluster-bus-routing` `cluster-bus-inspect` `cluster-bus-file-read` |
| MPC Security | 4 | `mpc-split` `mpc-distribute` `mpc-reconstruct` `mpc-status` |
| RL Learning | 2 | `rl-reward-stats` `rl-dopamine-log` |
| MCP Client | 3 | `client-sampling` `client-elicit` `client-roots` |
| System | 8 | `env-info` `memory-usage` `ai-config` `ai-models` `tool-health` `config` `ping` `help` |

## Key Components

### Tool Registry (`tools/registry.ts`)
- Unified `UnifiedTool` interface with Zod schemas and MCP tool annotations
- Tool availability checking with soft/force modes and fallback suggestions
- Shared helpers: `executeWithGuard()`, `executeCognitionTool()`, `validatePathSafe()`
- Auto-share results to Redis for multi-agent context

### Lorenz Context Compaction (v3.0)
- **Phase Detection** (`cognition/phase-detector.ts`) — Poincare section analysis using JSD to identify topic transitions in thinking chains. Phase boundaries carry maximum information.
- **Orbit Compression** (`cognition/orbit-compressor.ts`) — Lorenz attractor pattern detection. NxN TF-IDF cosine similarity matrix, greedy cycle search (length 2-10, min 2 repetitions). Keeps first cycle, prunes duplicates.
- **Perturbation Impact** (`cognition/ctc-math.ts`) — JSD(full_context, context_without_item) measures each item's contribution. High-impact items are causal anchors.
- **Unified NLP** (`utils/nlp.ts`) — tokenize, textToDistribution, TF-IDF cosine similarity, shared stop words.

### LLM Client (`ai/client.ts` + `ai/providers/`)
- 8 providers with native SDKs (Anthropic, Gemini, OpenAI) and OpenAI-compatible adapters
- Model spec: `provider:model:thinking` — short aliases: `o` `a` `g` `q` `d` `l` `r` `p`
- Structured output via `generateObject()` with Zod schemas and `jsonrepair`
- Cost-optimized model selection, 3-layer routing (main/research/fallback)
- Lazy init, hot-reload, unified thinking tokens

### Global Event Bus (`events/`)
- Server-wide namespaced events connecting cognition, kanban, recursive, and session modules
- Redis Pub/Sub bridge for cross-session event propagation
- Reactive handlers: critical task alerts, completion metrics, tool frequency tracking

### Redis Schema (DB 2)
```
mcp:context:*     — Shared tool outputs
mcp:agents:*      — Agent registry + rankings
mcp:messages:*    — Inter-agent messages
mcp:kanban:*      — Tasks, boards, workspaces, clusters
mcp:memory:*      — Project memory
mcp:cognition:*   — Decisions, confidence, models, intents, errors, lessons
mcp:cluster:*     — Cluster bus signals and registry
mcp:dataflow:*    — Typed message channels (12 channels)
mcp:channel:*     — Pub/Sub channels
mcp:events:*      — Event history
```

### 3-Layer Bus Architecture
- **L3: ClusterBus** (`cluster-bus/`) — inter-cluster via Redis Pub/Sub (`mcp:cluster:*`). 18 signal types (incl. 6 CI types), 4 send modes (unicast/broadcast/routed/multicast). SignalFlowController (backpressure, rate limiting, circuit breaker, bloom filter, HMAC auth), MetaRouter (tag-based routing with AND/OR logic, CI routing rules), HealthMonitor (heartbeat, stale pruning), FanInAggregator (all/first/majority/custom).
- **L2: DataFlowBus** (`dataflow/`) — inter-module typed channels (`mcp:dataflow:{channel}`). 12 channels with Zod payloads, correlation tracking, priority 0-3, TTL, O(1) unsubscribe.
- **L1: GlobalEventBus** (`events/`) — in-process events (`mcp:events:{type}`). Namespaced events, async handlers, max chain depth 8, Redis bridge with retry.
- **Bridges** (`cluster-bus/bridges.ts`) — L3↔L2 (DataFlowBridge) and L3↔L1 (EventBridge) with anti-amplification: hop limit 5, source prefix guard, dedup via seen-set.

### LLM Magistrale (`cluster-bus/llm-magistrale.ts`)
- Dispatch prompts across multiple cluster nodes in parallel
- 4 aggregation strategies: `first-wins`, `best-of-n`, `consensus` (Jaccard similarity), `fallback-chain`
- PassController (`cluster-bus/pass-controller.ts`): 3 strategies — `min-passes` (LLM self-assesses), `quality-target` (iterate to threshold), `fixed` (exact N)
- Budget capping: PassController caps `minPasses` to `maxPasses` instead of rejecting

### Security Hardening
- Prototype pollution protection in Redis JSON parsing (`events/redis-bridge.ts`)
- HMAC authentication for ClusterBus signals
- Bloom filter deduplication for signal dedup
- Client timeout guards on `client-sampling` and `client-elicit` (30s)
- Chain depth limit (500) on thinking chains
- Promise rejection safety in GlobalEventBus async handlers
- ReDoS-safe regex patterns in MetaRouter (200 char cap)

## CLI Options

```bash
bun dist/index.js [options]
```

| Option | Default | Description |
|--------|---------|-------------|
| `-m, --model` | — | Primary AI model |
| `-f, --fallback-model` | — | Fallback on quota/error |
| `--port` | `3100` | HTTP server port |
| `--host` | `127.0.0.1` | Bind address |
| `--redis-host` | `127.0.0.1` | Redis host |
| `--redis-port` | `6379` | Redis port |
| `--no-context` | — | Disable Redis context sharing |

## Development

```bash
bun install && bun run build:bun && bun run start:bun   # Build & run
bun run dev:bun                                          # Hot reload
bun run typecheck && bun run lint && bun run format      # Quality checks
npm run build && npm run start                           # Node.js alternative
```

### Adding Tools

1. Create file in appropriate `tools/` subdirectory
2. Define Zod schema with `.describe()` for each field
3. Implement `UnifiedTool` interface
4. Register in `tools/index.ts`
5. Add annotation in `tools/annotations-map.ts`

### Server Management

**Start server** (if not running):
```bash
nohup bun /opt/kemdicode-mcp/dist/index.js --port 3100 >> /tmp/kemdicode-mcp.log 2>&1 &
```

**Restart server** (kill + start fresh):
```bash
pgrep -f "bun dist/index.js" | xargs kill -9 2>/dev/null
sleep 2
nohup bun /opt/kemdicode-mcp/dist/index.js --port 3100 >> /tmp/kemdicode-mcp.log 2>&1 &
```

**Health check:**
```bash
curl -s http://127.0.0.1:3100/health
```

**After code changes** (build + restart):
```bash
cd /opt/kemdicode-mcp && npm run build
pgrep -f "bun dist/index.js" | xargs kill -9 2>/dev/null
sleep 2
nohup bun /opt/kemdicode-mcp/dist/index.js --port 3100 >> /tmp/kemdicode-mcp.log 2>&1 &
```

**Important:** After server restart, the user must reconnect MCP in Claude Code (`/mcp`). Always wait 2-3 seconds after start before health check. Logs are in `/tmp/kemdicode-mcp.log`.

## Conventions

- **Prompts**: Always in English for model consistency
- **Agent selection**: `plan` for analysis/planning, `build` for code changes
- **Error handling**: Descriptive errors, automatic fallback, `handleToolError()` shared helper
- **File paths**: Use `@path/file.ts` notation in tool arguments

## Documentation

```
docs/
├── architecture-overview.md           # System layers, tool registry, providers
├── architecture-3-layer-bus.md        # ClusterBus (L3), DataFlowBus (L2), GlobalEventBus (L1)
├── README.md                          # Documentation index
├── whitepaper-kemdicode-mcp-v3.0.pdf  # v3.0 whitepaper (7 pages, Lorenz compaction, 23 equations)

examples/
├── 01-hot-reload-config.md            # Switch AI providers at runtime
├── 02-kanban-sprint.md                # End-to-end sprint workflow
├── 03-multi-agent-coordination.md     # Agent teams with roles
├── 04-multi-llm-consensus.md          # CEO-and-Board pattern
├── 05-code-analysis-workflow.md       # Review, fix, test pipeline
├── 06-project-memory.md               # Persistent cross-session memory
├── 07-recursive-tool-invocation.md    # Agent self-service tools
├── 08-cluster-bus-magistrale.md       # Distributed LLM orchestration
├── 09-dataflow-bus.md                 # 12 typed inter-module channels
├── 10-cognition-deep-dive.md          # 8 cognition tools in depth
├── 11-session-recovery-mpc-rl.md      # Recovery, secrets, learning
├── 12-knowledge-graph-loci.md         # Error-to-solution paths
└── patterns.md                        # 18 reusable integration patterns
```

## Compatibility

| IDE/Editor | Status |
|------------|--------|
| Claude Code | Fully supported (primary) |
| Cursor | Fully supported |
| KiroCode | Fully supported |
| RooCode | Fully supported |

## Author

**Dawid Irzyk** — [dawid@kemdi.pl](mailto:dawid@kemdi.pl) — [Kemdi Sp. z o.o.](https://kemdi.pl)
