# KemdiCode MCP Server v4.4.0

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
- Next session: `session action=recover` restores everything

### Project Memory

- `memory action=write|read|list|edit|delete` — persist key-value data across sessions
- `checkpoint action=save|restore|diff` — snapshot and restore full project state

### The Nine Minds

Nine specialized cognitive agents, each a different mode of thinking. Use any Mind as the `agent` parameter in `ask-ai`, `agent-orchestrate`, `multi-prompt`, or `consensus-prompt`:

| Mind | Core Question |
|------|---------------|
| `socratic` | "What are you assuming?" — questions only, never builds |
| `ontologist` | "What IS this, really?" — finds essence, not symptoms |
| `seed-architect` | "Is this complete and unambiguous?" — crystallizes specs |
| `evaluator` | "Did we build the right thing?" — 3-stage verification |
| `contrarian` | "What if the opposite were true?" — challenges every assumption |
| `hacker` | "What constraints are actually real?" — unconventional paths |
| `simplifier` | "What's the simplest thing that could work?" — removes complexity |
| `researcher` | "What evidence do we actually have?" — demands evidence |
| `architect` | "If we started over, would we build it this way?" — structural causes |

### Patterns

**Dialectical Progression (Nine Minds):**
1. `mind-chain` composition=dialectical — Socratic → Ontologist → Seed Architect

**Adversarial Review (Nine Minds):**
1. `mind-chain` composition=adversarial — Architect → Contrarian → Evaluator

**Evidence-Based Design (Nine Minds):**
1. `mind-chain` composition=evidence — Researcher → Hacker → Simplifier

**Full Multi-Mind Review:**
1. `mind-chain` composition=full-review — 6 Minds + synthesis

**Custom Mind Chain:**
1. `mind-chain` composition=custom minds=["researcher","architect","simplifier"]

**Error Investigation:**
1. `error-pattern` action=match → `thinking-chain` action=start → action=think → `error-pattern` action=record → `thinking-chain` action=conclude → action=compact

**Architecture Decisions:**
1. `decision-journal` action=record → `mental-model` action=create → `confidence-tracker` action=record → later: `decision-journal` action=update-outcome

**Code Exploration:**
1. `find-definition` → `find-references` → `semantic-search` → `memory` action=write

**Session Continuity:**
1. `intent-tracker` action=set → work → `smart-handoff` → next session: `session` action=recover

**Multi-Agent:**
1. `agent` action=init → `task` action=create → `shared-thoughts` → `agent-comm` action=alert

**Parallel Orchestration with Live Monitoring:**
1. `agent-orchestrate` --parallel [...agents] → monitor via `curl http://localhost:3100/orchestrations` or `monitor --view orchestrations`
2. Each agent gets unique `orchestrationId`, sub-agents reference parent via `parentOrchestrationId`
3. All cognition records carry `orchestrationId` for full traceability

**Kanban Sprint:**
1. `workspace` action=create → `board` action=create → `task` action=create → `task` action=update → `board` action=status

**Knowledge Graph:**
1. `graph-query` action=add-node/add-edge → `graph-find-path` → `loci-recall` → `sequence-recommend`

## Session Recovery

After compaction or session start, run `session action=recover` to restore full context in one call.

## Overview

Model Context Protocol (MCP) server providing **62 tools** across 15 categories: cognition, thinking chains, multi-agent coordination, kanban with workspaces, project memory, cluster bus with LLM magistrale, Lorenz context compaction, recursive tool invocation, code intelligence, session management, knowledge graph, and MCP client capabilities. Features **The Nine Minds** — 9 specialized cognitive agents (socratic, ontologist, seed-architect, evaluator, contrarian, hacker, simplifier, researcher, architect) loaded on-demand for multi-perspective analysis.

**8 LLM providers**: OpenAI, Anthropic, Gemini, Groq, DeepSeek, Ollama, OpenRouter, Perplexity. Provider syntax: `provider:model:thinking` (e.g., `a:claude-sonnet-4-6:4k`, `p:sonar-pro`).

**618 tests** across 33 test files.

## Architecture

```
src/
├── index.ts                 # HTTP server, SSE handlers, MCP protocol
├── constants.ts             # CLI flags, error messages, timeouts
├── version.ts               # Central version (reads from package.json)
├── ai/                      # Multi-provider LLM integration
│   ├── client.ts            # Unified completion router (8 providers)
│   ├── execute.ts           # High-level AI execution with agents
│   ├── agents.ts            # Agent configurations (plan, build, explore) + Nine Minds integration
│   ├── minds.ts             # The Nine Minds: 9 cognitive modes (socratic, ontologist, etc.)
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
│   └── bridges.ts           # ClusterBus ↔ GlobalEventBus bridges
├── cognition/               # AI self-awareness (8 stores + Lorenz compaction)
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
│   ├── phase-detector.ts    # Poincaré section phase detection
│   └── orbit-compressor.ts  # Lorenz attractor orbit compression
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
├── session/                 # Session management + auto-recovery
├── tree-sitter/             # AST-based code analysis (19 languages)
├── thinking/                # Thinking chain system
├── loci/                    # Knowledge graph + resurrection
├── utils/
│   ├── nlp.ts               # Unified NLP: tokenize, TF-IDF, stop words
│   └── ...                  # command executor, file, git, validation, logger
├── tools/
│   ├── registry.ts          # Unified tool interface, Zod schemas, annotations
│   ├── annotations-map.ts   # MCP protocol-level tool hints
│   ├── availability-checker.ts # Tool health + fallback suggestions
│   ├── tool-shared.ts       # executeWithGuard, handleToolError helpers
│   ├── agents/              # Agent management (3 tools)
│   ├── cluster-bus/         # Cluster bus tools (8 tools)
│   ├── code/                # Code intelligence (3 tools)
│   ├── client/              # MCP client capabilities (3 tools)
│   ├── cognition/           # AI self-improvement (8 tools)
│   ├── context/             # Context sharing (3 tools)
│   ├── kanban/              # Tasks, boards, workspaces (4 tools)
│   ├── loci/                # Knowledge graph + resurrection (4 tools)
│   ├── memory/              # Project memory (2 tools)
│   ├── multi-llm/           # Multi-provider LLM tools (4 tools)
│   ├── recursive/           # Recursive invocation + orchestrate (4 tools)
│   ├── session/             # Session management (1 tool)
│   ├── thinking/            # Thinking chain (1 tool)
│   └── system/              # System tools (8 tools)
├── types/                   # Shared type definitions
└── utils/                   # Helpers (command executor, file, git, validation, logger, NLP)
```

## Tool Categories (62 tools)

| Category | # | Tools |
|----------|:-:|-------|
| Core AI | 6 | `ask-ai` `plan` `build` `brainstorm` `batch` `pipeline` |
| Code Intelligence | 3 | `find-definition` `find-references` `semantic-search` |
| Multi-LLM | 4 | `multi-prompt` `consensus-prompt` `enhance-prompt` `mind-chain` |
| Cognition | 8 | `decision-journal` `confidence-tracker` `mental-model` `intent-tracker` `error-pattern` `self-critique` `smart-handoff` `context-budget` |
| Agents | 3 | `agent` `agent-comm` `monitor` |
| Context | 3 | `shared-thoughts` `get-shared-context` `feedback` |
| Kanban | 4 | `task` `task-multi` `board` `workspace` |
| Memory | 2 | `memory` `checkpoint` |
| Recursive | 4 | `invoke-tool` `invoke-batch` `invocation-log` `agent-orchestrate` |
| Session | 1 | `session` |
| Thinking | 1 | `thinking-chain` |
| Knowledge Graph | 4 | `graph-query` `graph-find-path` `loci-recall` `sequence-recommend` |
| Cluster Bus | 8 | `cluster-bus-status` `cluster-bus-topology` `cluster-bus-send` `cluster-bus-magistrale` `cluster-bus-flow` `cluster-bus-routing` `cluster-bus-inspect` `cluster-bus-file-read` |
| MCP Client | 3 | `client-sampling` `client-elicit` `client-roots` |
| System | 8 | `env-info` `memory-usage` `ai-config` `ai-models` `tool-health` `config` `ping` `help` |

## Key Components

### Lorenz Context Compaction
- **Phase Detection** (`cognition/phase-detector.ts`) — Poincare section analysis using JSD to identify topic transitions in thinking chains
- **Orbit Compression** (`cognition/orbit-compressor.ts`) — Lorenz attractor pattern detection. NxN TF-IDF cosine similarity matrix, greedy cycle search
- **Perturbation Impact** (`cognition/ctc-math.ts`) — JSD(full_context, context_without_item) measures each item's contribution
- **Unified NLP** (`utils/nlp.ts`) — tokenize, textToDistribution, TF-IDF cosine similarity

### LLM Client (`ai/client.ts` + `ai/providers/`)
- 8 providers with native SDKs (Anthropic, Gemini, OpenAI) and OpenAI-compatible adapters
- Model spec: `provider:model:thinking` — short aliases: `o` `a` `g` `q` `d` `l` `r` `p`
- Unified completion path through provider registry, legacy SDK as fallback
- Structured output via `generateObject()` with Zod schemas and `jsonrepair`

### 2-Layer Bus Architecture
- **L3: ClusterBus** (`cluster-bus/`) — inter-cluster via Redis Pub/Sub. 18 signal types, 4 send modes. SignalFlowController, MetaRouter, HealthMonitor, FanInAggregator
- **L1: GlobalEventBus** (`events/`) — in-process events. Namespaced, async handlers, max chain depth 8, Redis bridge
- **Bridges** (`cluster-bus/bridges.ts`) — L3↔L1 with anti-amplification: hop limit 5, source prefix guard

### LLM Magistrale (`cluster-bus/llm-magistrale.ts`)
- 4 aggregation strategies: `first-wins`, `best-of-n`, `consensus`, `fallback-chain`
- PassController: `min-passes`, `quality-target`, `fixed`

### Security
- HMAC authentication for ClusterBus signals
- Bloom filter deduplication
- Prototype pollution protection in Redis JSON parsing
- Client timeout guards (30s)
- Chain depth limit (500) on thinking chains
- ReDoS-safe regex patterns (200 char cap)

### Redis Schema (DB 2)
```
mcp:context:*     — Shared tool outputs
mcp:agents:*      — Agent registry + rankings
mcp:messages:*    — Inter-agent messages
mcp:kanban:*      — Tasks, boards, workspaces
mcp:memory:*      — Project memory
mcp:cognition:*   — Decisions, confidence, models, intents, errors
mcp:cluster:*     — Cluster bus signals and registry
mcp:channel:*     — Pub/Sub channels
mcp:events:*      — Event history
```

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
bun install && bun run build && bun run start            # Build & run
bun run dev                                              # Hot reload
bun run typecheck && bun run lint && bun run format      # Quality checks
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
fuser -k 3100/tcp 2>/dev/null
sleep 2
nohup bun /opt/kemdicode-mcp/dist/index.js --port 3100 >> /tmp/kemdicode-mcp.log 2>&1 &
```

**After code changes** (build + restart):
```bash
cd /opt/kemdicode-mcp && bun run build
fuser -k 3100/tcp 2>/dev/null
sleep 2
nohup bun /opt/kemdicode-mcp/dist/index.js --port 3100 >> /tmp/kemdicode-mcp.log 2>&1 &
```

**Important:** After server restart, the user must reconnect MCP in Claude Code (`/mcp`).

## Conventions

- **Prompts**: Always in English for model consistency
- **Agent selection**: `plan` for analysis/planning, `build` for code changes
- **Error handling**: Descriptive errors, automatic fallback, `handleToolError()` shared helper
- **File paths**: Use `@path/file.ts` notation in tool arguments

## Documentation

```
docs/
├── architecture-overview.md           # System layers, tool registry, providers
├── architecture-2-layer-bus.md        # ClusterBus (L3), GlobalEventBus (L1)
├── README.md                          # Documentation index
├── whitepaper-kemdicode-mcp-v4.0.tex  # Lorenz compaction, distributed cognition

examples/
├── 01-hot-reload-config.md            # Switch AI providers at runtime
├── 02-kanban-sprint.md                # End-to-end sprint workflow
├── 03-multi-agent-coordination.md     # Agent teams with roles
├── 04-multi-llm-consensus.md          # CEO-and-Board pattern
├── 05-code-analysis-workflow.md       # Code intelligence pipeline
├── 06-project-memory.md               # Persistent cross-session memory
├── 07-recursive-tool-invocation.md    # Agent self-service tools
├── 08-cluster-bus-magistrale.md       # Distributed LLM orchestration
├── 10-cognition-deep-dive.md          # 8 cognition tools in depth
├── 11-session-recovery.md             # Session recovery and continuity
├── 12-knowledge-graph-loci.md         # Error-to-solution paths
└── patterns.md                        # Reusable integration patterns
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
