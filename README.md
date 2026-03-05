# kemdiCode MCP

<p align="center">
  <img src="kemdi-code-mcp-logo.png" alt="kemdiCode MCP" width="420" />
</p>

<h3 align="center">Model Context Protocol Server for AI-Powered Development</h3>

<p align="center">
  <a href="https://www.npmjs.com/package/kemdicode-mcp"><img src="https://img.shields.io/badge/npm-kemdicode--mcp-CB3837?style=flat-square&logo=npm&logoColor=white" alt="npm" /></a>
  <a href="https://github.com/kemdi-pl/kemdicode-mcp/releases"><img src="https://img.shields.io/badge/version-3.3.0-blue?style=flat-square" alt="Version" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0-green?style=flat-square" alt="License" /></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/Bun-%E2%89%A51.0-f9f1e1?style=flat-square&logo=bun&logoColor=f9f1e1&labelColor=14151a" alt="Bun" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-%E2%89%A518-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js" /></a>
</p>

---

**kemdiCode MCP** is an [MCP](https://modelcontextprotocol.io/) server that gives AI agents **108 tools** for cognition, thinking chains, multi-agent coordination, kanban task management, cluster bus with LLM magistrale, Lorenz-inspired context compaction, and structured output. It connects to Claude Code, Cursor, KiroCode, and RooCode.

### What's New in 3.3

- **Thinking chain compaction** &mdash; `thinking-chain` `compact` action now fully wired: Lorenz pipeline (Phase Detection &rarr; Orbit Compression &rarr; CTC Fixed-Point) runs on concluded chains, returning kept/pruned indices and consistency scores
- **Perturbation impact in context-budget** &mdash; JSD-based perturbation impact integrated as 6th holographic scoring dimension (20% blend) for smarter context window prioritization
- **Stale reference cleanup** &mdash; 15+ source files cleaned of references to 39 tools removed in v3.0 (routing rules, AI tool lists, relatedTools, examples)
- **CLAUDE.md usage patterns** &mdash; 7 documented workflows for agents: error investigation, architecture decisions, code exploration, session continuity, multi-agent collaboration, kanban sprints, knowledge graphs
- **108 tools** (was 107) &mdash; `compact` action added to `thinking-chain`
- **694 unit tests** passing

<details>
<summary>Previous releases</summary>

#### 3.0 &mdash; "Lorenz"

**Lorenz-inspired context compaction** &mdash; Phase Detection (Poincar&eacute; sections), Orbit Compression (Lorenz attractor cycles), Perturbation Impact (JSD-based). **39 redundant tools removed** &mdash; IDE-native capabilities (file ops, git, editing, code review) removed; kemdiCode focuses on cognition, coordination, memory, kanban, cluster bus, and compaction.

#### 2.2

Auto-save session state, thinking chain recovery, sessionId resolution fix.

#### 2.0

Stdio transport, Node 18+ compatibility, multi-agent concurrency safety, 8 security fixes (P0&ndash;P1).

</details>

---

## Quick Start

```bash
npm install -g kemdicode-mcp
```

**Claude Code:**
```bash
claude mcp add kemdicode-mcp -- kemdicode-mcp --stdio
```

**Cursor** (Settings &rarr; Features &rarr; MCP) or **any MCP client:**
```json
{
  "mcpServers": {
    "kemdicode-mcp": {
      "command": "kemdicode-mcp",
      "args": ["--stdio"]
    }
  }
}
```

**HTTP mode** (multi-session, for advanced setups):
```bash
kemdicode-mcp --port 3100
```

<details>
<summary>Redis (recommended)</summary>

Redis is required for full functionality (memory, kanban, cognition, agents, sessions, cluster bus). Without Redis, only code intelligence tools work.

```bash
# macOS
brew install redis && brew services start redis

# Ubuntu/Debian
sudo apt install redis-server && sudo systemctl start redis

# Docker
docker run -d -p 6379:6379 redis
```

</details>

<details>
<summary>Build from source</summary>

```bash
git clone https://github.com/kemdi-pl/kemdicode-mcp.git
cd kemdicode-mcp
bun install && bun run build:bun && bun run start:bun
# Or: npm install && npm run build && npm run start
```

</details>

### Tell the agent what you need

kemdiCode works best when the agent knows about it. Add to your `CLAUDE.md` or `.cursorrules`:

```
You have access to kemdiCode MCP. Use its tools for project memory (write-memory, read-memory),
cognition (decision-journal, smart-handoff), kanban (task-create, task-list), multi-agent
coordination (agent-init, shared-thoughts), and thinking chains (thinking-chain).
```

---

## Features

| Capability | Description |
|:-----------|:------------|
| **108 MCP Tools** | Cognition, thinking chains, kanban, multi-agent, cluster bus, LLM magistrale, memory, pipelines, structured output |
| **Lorenz Context Compaction** | Phase detection (Poincar&eacute; sections), orbit compression (attractor cycles), perturbation impact (JSD-based), Shannon entropy, TF-IDF similarity |
| **Cognition Layer** | 8 tools: decision journal, confidence tracking, mental models, intent hierarchy with TF-IDF drift detection, error patterns, self-critique, smart handoff, context budget |
| **Multi-Agent** | Per-session isolation via AsyncLocalStorage, Redis-backed coordination, agent ranking (bronze&rarr;diamond), distributed locks for concurrent safety |
| **Cluster Bus** | Distributed LLM orchestration: 18 signal types, 4 send modes, magistrale with 4 strategies, multi-pass quality control, CI/CD fan-in aggregation |
| **8 LLM Providers** | OpenAI, Anthropic, Gemini (native SDKs) + Groq, DeepSeek, Ollama, OpenRouter, Perplexity (OpenAI-compatible) |
| **Kanban** | Workspaces, boards, subtasks, dependency cycle detection, role-based access, batch ops, task comments, pagination |
| **Data Flow Bus** | 12 typed channels with Zod schemas, correlation tracking, priority routing, Redis bridge |
| **Project Memory** | Persistent key-value store with TTL and tags; checkpoints for save/restore/diff |
| **Session Recovery** | `session-recover` or `smart-handoff` restores full context after compaction |
| **Structured Output** | `generateObject()` with Zod schemas, JSON repair, retry logic |
| **Hot Reload** | Change provider, model, or config at runtime without restart |

---

## Tool Reference

> **108 tools** across 19 categories.

| Category | # | Tools |
|:---------|:-:|:------|
| **Core AI** | 6 | `ask-ai` `plan` `build` `brainstorm` `batch` `pipeline` |
| **Code Intelligence** | 4 | `find-definition` `find-references` `semantic-search` `write-tests` |
| **Multi-LLM** | 3 | `multi-prompt` `consensus-prompt` `enhance-prompt` |
| **Cognition** | 8 | `decision-journal` `confidence-tracker` `mental-model` `intent-tracker` `error-pattern` `self-critique` `smart-handoff` `context-budget` |
| **Multi-Agent** | 10 | `agent-init` `agent-list` `agent-register` `agent-alert` `agent-inject` `agent-history` `monitor` `agent-summary` `queue-message` `agent-rank` |
| **Context & Learning** | 3 | `shared-thoughts` `get-shared-context` `feedback` |
| **Kanban Tasks** | 13 | `task-create` `task-get` `task-list` `task-update` `task-delete` `task-comment` `task-claim` `task-assign` `task-push-multi` `task-subtask` `board-status` `task-cluster` `task-complexity` |
| **Kanban Workspaces** | 5 | `workspace-create` `workspace-list` `workspace-join` `workspace-leave` `workspace-delete` |
| **Kanban Boards** | 7 | `board-create` `board-list` `board-share` `board-members` `board-invite` `board-delete` `board-workflow` |
| **Project Memory** | 8 | `write-memory` `read-memory` `list-memories` `edit-memory` `delete-memory` `checkpoint-save` `checkpoint-restore` `checkpoint-diff` |
| **Recursive** | 4 | `invoke-tool` `invoke-batch` `invocation-log` `agent-orchestrate` |
| **Session** | 6 | `session-list` `session-info` `session-create` `session-switch` `session-delete` `session-recover` |
| **Thinking** | 1 | `thinking-chain` |
| **Knowledge Graph** | 4 | `graph-query` `graph-find-path` `loci-recall` `sequence-recommend` |
| **Cluster Bus** | 8 | `cluster-bus-status` `cluster-bus-topology` `cluster-bus-send` `cluster-bus-magistrale` `cluster-bus-flow` `cluster-bus-routing` `cluster-bus-inspect` `cluster-bus-file-read` |
| **MPC Security** | 4 | `mpc-split` `mpc-distribute` `mpc-reconstruct` `mpc-status` |
| **RL Learning** | 2 | `rl-reward-stats` `rl-dopamine-log` |
| **MCP Client** | 3 | `client-sampling` `client-elicit` `client-roots` |
| **System** | 8 | `env-info` `memory-usage` `ai-config` `ai-models` `tool-health` `config` `ping` `help` |

---

## LLM Providers

8 providers with unified `provider:model:thinking` syntax:

```
o:gpt-5              a:claude-sonnet-4-5    g:gemini-3-pro
q:llama-3.3-70b      d:deepseek-chat        l:llama3.3
r:gpt-5              p:sonar-pro
```

Thinking tokens: `o:gpt-5:high` &bull; `a:claude-sonnet-4-5:4k` &bull; `g:gemini-3-pro:8k`

```bash
export OPENAI_API_KEY=sk-...          export ANTHROPIC_API_KEY=sk-ant-...
export GEMINI_API_KEY=AI...           export GROQ_API_KEY=gsk_...
export DEEPSEEK_API_KEY=sk-...        export OPENROUTER_API_KEY=sk-or-...
export PERPLEXITY_API_KEY=pplx-...    # Ollama: no key required
```

---

## Architecture

<details>
<summary><strong>3-Layer Bus</strong></summary>

```
+====================================================================+
||  L3: ClusterBus  (Redis Pub/Sub, mcp:cluster:*)                  ||
||  18 signal types | 4 send modes | HMAC auth | bloom filter dedup ||
||  SignalFlowCtrl | MetaRouter | HealthMonitor | FanInAggregator   ||
+====================================================================+
||  L2: DataFlowBus  (in-process + Redis mcp:dataflow:{channel})    ||
||  12 typed channels | Zod schemas | correlation | priority 0-3    ||
+====================================================================+
||  L1: GlobalEventBus  (in-process + Redis mcp:events:{type})      ||
||  namespaced events | async handlers | max chain depth = 8        ||
+====================================================================+
         |
  Module Handlers: cognition (9) | kanban (2) | loop (2)
```

Anti-amplification bridges (L3&harr;L2, L3&harr;L1) with hop limit 5 and source prefix guards.

</details>

<details>
<summary><strong>Lorenz Context Compaction</strong></summary>

Three algorithms inspired by chaos theory and dynamical systems:

**Phase Detection** (`cognition/phase-detector.ts`) &mdash; Poincar&eacute; section analysis. Computes consecutive Jensen-Shannon divergence between thoughts. High-JSD transitions mark phase boundaries (topic switches). Preservation: first/last thought + all boundaries + highest-confidence per segment.

**Orbit Compression** (`cognition/orbit-compressor.ts`) &mdash; Lorenz attractor pattern detection. Builds N&times;N TF-IDF cosine similarity matrix. Greedy search for repeating cycles (length 2&ndash;10, minimum 2 repetitions). Keeps first cycle occurrence, prunes subsequent duplicates.

**Perturbation Impact** (`cognition/ctc-math.ts`) &mdash; JSD(context_full, context_without_item) measures how much each item contributes to the information landscape. Items with high perturbation impact are critical anchors that must survive compaction.

Supporting math: Shannon entropy, Jensen-Shannon divergence, mutual information approximation, information density, TF-IDF cosine similarity, causal DAG analysis, fixed-point detection, gravitational TTL.

</details>

<details>
<summary><strong>Multi-Agent Concurrency Model</strong></summary>

- **Per-session isolation:** Each SSE connection gets a unique session ID, separate MCP Server instance, and independent transport
- **AsyncLocalStorage:** Every tool call runs in a request-scoped context &mdash; zero cross-agent contamination
- **Redis transactions:** Task creation uses pipelines, status changes use MULTI/EXEC, claims use Lua scripts
- **Distributed locks:** `updateTask`, `addTaskNote`, `updateScore`, `promote`, `demote` use per-resource Redis locks (SET NX PX 5s, Lua CAS release, 3 retries with backoff)
- **Agent coordination:** 10 multi-agent tools, Redis Pub/Sub for real-time messaging, shared thoughts, kanban boards

</details>

---

## CLI Reference

```bash
kemdicode-mcp [options]
```

| Flag | Default | Description |
|:-----|:-------:|:------------|
| `--stdio` | &mdash; | Run as stdio transport (subprocess mode for MCP clients) |
| `-m, --model` | &mdash; | Primary AI model |
| `-f, --fallback-model` | &mdash; | Fallback on quota/error |
| `--port` | `3100` | HTTP server port |
| `--host` | `127.0.0.1` | Bind address |
| `--redis-host` | `127.0.0.1` | Redis host |
| `--redis-port` | `6379` | Redis port |
| `--no-context` | &mdash; | Disable Redis context sharing |
| `-v, --verbose` | &mdash; | Verbose output with decorations |
| `--compact` | &mdash; | Essential fields only |

---

## Development

| Command | Description |
|:--------|:------------|
| `bun install && bun run build:bun` | Install + build |
| `bun run start:bun` | Start on `:3100` |
| `bun run dev:bun` | Watch mode |
| `bun run typecheck` | Type-check |
| `bun run lint` | ESLint |
| `npx vitest run` | Run 694 tests |

---

## Documentation

| Document | Description |
|:---------|:------------|
| [Technical Whitepaper (PDF)](docs/whitepaper-kemdicode-mcp-v3.0.pdf) | Lorenz context compaction, architecture, cognition, LLM Magistrale |
| [Architecture Overview](docs/architecture-overview.md) | System layers diagram |
| [3-Layer Bus](docs/architecture-3-layer-bus.md) | L3/L2/L1 bus design |
| [Examples](examples/) | 12 practical guides |

---

## Author

**Dawid Irzyk** &mdash; [dawid@kemdi.pl](mailto:dawid@kemdi.pl) &mdash; [Kemdi Sp. z o.o.](https://kemdi.pl)

## License

[GNU General Public License v3.0](LICENSE)
