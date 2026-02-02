# KemdiCode MCP Server

## Session Recovery

After compaction or session start, run `session-recover` to restore full context in one call. This orchestrates: active-session memory, latest handoff, loci resurrection, tool availability, agent rankings, and ambient learning insights.

Alternatively: `read-memory --names ["active-session"]` and update with `write-memory` when the active session changes.

## Overview

Model Context Protocol (MCP) server providing **138 specialized tools** across 23 categories: code analysis, generation, git operations, file management, line/symbol editing, project memory, cognition & self-improvement, multi-board kanban with workspaces, task clustering & complexity, thinking chains, recursive tool invocation, pipelines, session monitoring, multi-agent coordination, structured output, data flow bus, cluster bus with LLM magistrale, tool annotations, ambient learning, agent ranking, and MCP client capabilities.

**8 LLM providers**: OpenAI, Anthropic, Gemini, Groq, DeepSeek, Ollama, OpenRouter, Perplexity. Provider syntax: `provider:model:thinking` (e.g., `a:claude-sonnet-4-5:4k`, `p:sonar-pro`).

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
│   ├── bus.ts               # ClusterBus: Redis Pub/Sub signal routing
│   ├── llm-magistrale.ts    # LLM dispatch across clusters (4 strategies)
│   ├── pass-controller.ts   # Self-regulating multi-pass execution
│   ├── signal-flow.ts       # Backpressure, rate limiting, flow control
│   ├── meta-router.ts       # Meta-tag based signal routing
│   ├── health-monitor.ts    # Heartbeat tracking, stale detection
│   ├── cluster-registry.ts  # Node registration and discovery
│   ├── provider-pool.ts     # LLM provider pool for clusters
│   └── bridges.ts           # DataFlow ↔ ClusterBus bridges
├── cognition/               # AI self-awareness (8 stores + event system)
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
│   └── event-handlers.ts    # Reactive cross-tool handlers
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
├── tools/
│   ├── registry.ts          # Unified tool interface, Zod schemas, annotations
│   ├── annotations-map.ts   # MCP protocol-level tool hints
│   ├── availability-checker.ts # Tool health + fallback suggestions
│   ├── tool-shared.ts       # executeWithGuard, handleToolError helpers
│   ├── agents/              # Agent monitoring (10 tools)
│   ├── cluster-bus/         # Cluster bus tools (4 tools)
│   ├── code/                # Code navigation + symbol editing (9 tools)
│   ├── client/              # MCP client capabilities (3 tools)
│   ├── cognition/           # AI self-improvement (8 tools)
│   ├── context/             # Context sharing (4 tools)
│   ├── edit/                # Line-based editing (4 tools)
│   ├── file/                # File operations (9 tools)
│   ├── git/                 # Git operations (8 tools)
│   ├── kanban/              # Tasks, boards, workspaces, clustering (23 tools)
│   ├── loci/                # Knowledge graph + resurrection (4 tools)
│   ├── memory/              # Project memory (8 tools)
│   ├── mpc/                 # Multi-party computation (4 tools)
│   ├── multi-llm/           # Multi-provider LLM tools (2 tools)
│   ├── project/             # Project management (5 tools)
│   ├── recursive/           # Recursive invocation + orchestrate (4 tools)
│   ├── rl/                  # Reinforcement learning (2 tools)
│   ├── session/             # Session management + recovery (6 tools)
│   ├── specialized/         # AI analysis (8 tools)
│   ├── thinking/            # Thinking chain (1 tool)
│   └── system/              # System tools (8 tools)
├── types/                   # Shared type definitions
└── utils/                   # Helpers (command executor, file, git, validation, logger)
```

## Tool Categories (138 tools)

| Category | # | Key tools |
|----------|:-:|-----------|
| Cluster Bus | 4 | `cluster-bus-status` `cluster-bus-topology` `cluster-bus-send` `cluster-bus-magistrale` |
| Cognition | 8 | `decision-journal` `confidence-tracker` `mental-model` `intent-tracker` `error-pattern` `self-critique` `smart-handoff` `context-budget` |
| AI Agents | 4 | `plan` `build` `brainstorm` `ask-ai` |
| Multi-LLM | 2 | `multi-prompt` `consensus-prompt` |
| Code Analysis | 8 | `code-review` `explain-code` `find-definition` `find-references` `find-symbols` `semantic-search` `code-outline` `analyze-deps` |
| Line Editing | 4 | `insert-at-line` `delete-lines` `replace-lines` `replace-content` |
| Symbol Editing | 3 | `insert-before-symbol` `insert-after-symbol` `rename-symbol` |
| Code Modification | 5 | `fix-bug` `refactor` `auto-fix` `auto-fix-agent` `write-tests` |
| Project Memory | 8 | `write-memory` `read-memory` `list-memories` `edit-memory` `delete-memory` `checkpoint-save` `checkpoint-restore` `checkpoint-diff` |
| Git | 8 | `git-status` `git-diff` `git-log` `git-blame` `git-branch` `git-add` `git-commit` `git-stash` |
| File Operations | 9 | `file-read` `file-write` `file-search` `file-tree` `file-diff` `file-delete` `file-move` `file-copy` `file-backup-restore` |
| Project | 5 | `project-info` `run-script` `run-tests` `run-lint` `check-types` |
| Kanban Tasks | 12 | `task-create` `task-get` `task-list` `task-update` `task-delete` `task-comment` `task-claim` `task-assign` `task-push-multi` `board-status` `task-cluster` `task-complexity` |
| Kanban Workspaces | 5 | `workspace-create` `workspace-list` `workspace-join` `workspace-leave` `workspace-delete` |
| Kanban Boards | 6 | `board-create` `board-list` `board-share` `board-members` `board-invite` `board-delete` |
| Recursive | 4 | `invoke-tool` `invoke-batch` `invocation-log` `agent-orchestrate` |
| Multi-Agent | 14 | `agent-list` `agent-register` `agent-watch` `agent-alert` `agent-inject` `agent-history` `monitor` `agent-summary` `agent-rank` `queue-message` `shared-thoughts` `get-shared-context` `feedback` `batch` |
| Orchestration | 1 | `pipeline` |
| Session | 6 | `session-list` `session-info` `session-create` `session-switch` `session-delete` `session-recover` |
| MCP Client | 3 | `client-sampling` `client-elicit` `client-roots` |
| Knowledge Graph | 4 | `graph-query` `graph-find-path` `loci-recall` `sequence-recommend` |
| Thinking | 1 | `thinking-chain` |
| MPC Security | 4 | `mpc-split` `mpc-distribute` `mpc-reconstruct` `mpc-status` |
| RL Learning | 2 | `rl-reward-stats` `rl-dopamine-log` |
| System | 8 | `env-info` `memory-usage` `ai-config` `ai-models` `tool-health` `config` `ping` `help` |

## Key Components

### Tool Registry (`tools/registry.ts`)
- Unified `UnifiedTool` interface with Zod schemas and MCP tool annotations
- Tool availability checking with soft/force modes and fallback suggestions
- Shared helpers: `executeWithGuard()`, `executeCognitionTool()`, `executeGitTool()`, `validatePathSafe()`
- Auto-share results to Redis for multi-agent context

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

## Compatibility

| IDE/Editor | Status |
|------------|--------|
| Claude Code | Fully supported (primary) |
| Cursor | Fully supported |
| KiroCode | Fully supported |
| RooCode | Fully supported |

## Author

**Dawid Irzyk** — [dawid@kemdi.pl](mailto:dawid@kemdi.pl) — [Kemdi Sp. z o.o.](https://kemdi.pl)
