<p align="center">
  <img src="kemdi-code-mcp.png" alt="kemdiCode MCP" />
</p>

<h3 align="center">Persistent Cognition, Cluster Bus & Magistrale, Parallel Multi-Agent Orchestration with Live Monitoring for AI Coding Assistants</h3>

<p align="center">
  <a href="https://www.npmjs.com/package/kemdicode-mcp"><img src="https://img.shields.io/badge/npm-kemdicode--mcp-CB3837?style=flat-square&logo=npm&logoColor=white" alt="npm" /></a>
  <a href="https://github.com/kemdi-pl/kemdicode-mcp/releases"><img src="https://img.shields.io/badge/version-4.5.0-blue?style=flat-square" alt="Version" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0-green?style=flat-square" alt="License" /></a>
</p>

<p align="center">
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/Bun-%E2%89%A51.0-f9f1e1?style=flat-square&logo=bun&logoColor=f9f1e1&labelColor=14151a" alt="Bun" /></a>
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript" /></a>
  <a href="https://redis.io"><img src="https://img.shields.io/badge/Redis-7.x-DC382D?style=flat-square&logo=redis&logoColor=white" alt="Redis" /></a>
  <a href="https://modelcontextprotocol.io"><img src="https://img.shields.io/badge/MCP-Protocol-6B4FBB?style=flat-square" alt="MCP" /></a>
  <a href="https://zod.dev"><img src="https://img.shields.io/badge/Zod-4.x-3E67B1?style=flat-square&logo=zod&logoColor=white" alt="Zod" /></a>
</p>

---

**kemdiCode MCP** is a [Model Context Protocol](https://modelcontextprotocol.io/) server that extends AI coding assistants with persistent cognition, multi-agent orchestration, distributed cluster communication, and context compaction. **62 tools** across 15 categories, backed by Redis for cross-session state and 8 LLM providers for embedded AI execution.

**Lorenz-inspired compaction pipeline** — Phase Detection via Poincaré sections, Orbit Compression via attractor cycle deduplication, and CTC perturbation impact scoring — maintains reasoning continuity across context window boundaries.

**Cluster Bus & Magistrale** — two-layer bus (ClusterBus L3 for inter-cluster Redis Pub/Sub, GlobalEventBus L1 for in-process events) with 18 signal types, MetaRouter tag-based routing, anti-amplification bridges, and LLM Magistrale for distributed prompt execution across clusters (4 strategies: first-wins, best-of-n, consensus, fallback-chain).

**[The Nine Minds](#the-nine-minds)** — nine specialized cognitive agents (Socratic, Ontologist, Seed Architect, Evaluator, Contrarian, Hacker, Simplifier, Researcher, Architect), each a different mode of thinking. Inspired by [Ouroboros](https://github.com/Q00/ouroboros) by Harry Munro. Loaded on-demand, never preloaded.

618 tests across 33 test files. Works with Claude Code, Cursor, Windsurf, VS Code, Zed, and any MCP-compatible client.

---

## Installation

```bash
bun install -g kemdicode-mcp
```

<details>
<summary><b>Claude Code</b></summary>

```bash
claude mcp add kemdicode-mcp -- kemdicode-mcp --stdio
```
</details>

<details>
<summary><b>Cursor</b> — <code>~/.cursor/mcp.json</code></summary>

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
</details>

<details>
<summary><b>Windsurf</b> — <code>~/.codeium/windsurf/mcp_config.json</code></summary>

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
</details>

<details>
<summary><b>VS Code (GitHub Copilot)</b> — <code>.vscode/mcp.json</code></summary>

```json
{
  "mcp": {
    "servers": {
      "kemdicode-mcp": {
        "command": "kemdicode-mcp",
        "args": ["--stdio"]
      }
    }
  }
}
```
</details>

<details>
<summary><b>Zed</b> — <code>~/.config/zed/settings.json</code></summary>

```json
{
  "context_servers": {
    "kemdicode-mcp": {
      "command": {
        "path": "kemdicode-mcp",
        "args": ["--stdio"]
      }
    }
  }
}
```
</details>

<details>
<summary><b>KiroCode / RooCode</b> — <code>.kiro/settings/mcp.json</code></summary>

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
</details>

<details>
<summary><b>HTTP Transport</b> (multi-session)</summary>

```bash
kemdicode-mcp --port 3100
```
</details>

<details>
<summary><b>Redis</b> (required for persistence)</summary>

Without Redis, only stateless tools (code intelligence, AI calls) function.

```bash
# Docker (recommended)
docker run -d -p 6379:6379 redis:alpine

# macOS
brew install redis && brew services start redis

# Debian/Ubuntu
sudo apt install redis-server && sudo systemctl start redis
```
</details>

<details>
<summary><b>Build from Source</b></summary>

```bash
git clone https://github.com/kemdi-pl/kemdicode-mcp.git
cd kemdicode-mcp
bun install && bun run build && bun run start
```
</details>

---

## Configuration

### LLM Providers

kemdiCode supports 8 LLM providers with a unified `provider:model:thinking` syntax.

| Alias | Provider | SDK | Auth |
|:-----:|:---------|:----|:-----|
| `o` | OpenAI | Native | `OPENAI_API_KEY` |
| `a` | Anthropic | Native | `ANTHROPIC_API_KEY` |
| `g` | Gemini | Native | `GEMINI_API_KEY` |
| `q` | Groq | OpenAI-compat | `GROQ_API_KEY` |
| `d` | DeepSeek | OpenAI-compat | `DEEPSEEK_API_KEY` |
| `l` | Ollama | OpenAI-compat | (none) |
| `r` | OpenRouter | OpenAI-compat | `OPENROUTER_API_KEY` |
| `p` | Perplexity | OpenAI-compat | `PERPLEXITY_API_KEY` |

Thinking token control:

```
o:o3:high                     # OpenAI reasoning effort (low/medium/high)
a:claude-sonnet-4-6:4k        # Anthropic thinking budget (4096 tokens)
g:gemini-2.5-flash:8k         # Gemini thinking budget (8192 tokens)
```

Custom endpoints (hot-reload at runtime):

```
ai-config --action add-custom --name minimax --baseURL https://api.minimax.io/v1 --apiKey sk-...
# Then use: custom:minimax:MiniMax-M2.5
```

### CLI Flags

```
kemdicode-mcp [options]

  --stdio                 Stdio transport (subprocess mode for MCP clients)
  -m, --model <spec>      Primary AI model (provider:model:thinking)
  -f, --fallback <spec>   Fallback model on quota/error
  --port <n>              HTTP server port (default: 3100)
  --host <addr>           Bind address (default: 127.0.0.1)
  --redis-host <addr>     Redis host (default: 127.0.0.1)
  --redis-port <n>        Redis port (default: 6379)
  --no-context            Disable Redis context sharing
  --compact               Minimal output
```

---

## Tool Reference

62 tools across 15 categories. Consolidated tools use an `action` parameter (e.g., `task action=create|get|list|update|delete`).

| Category | Tools |
|:---------|:------|
| **Core AI** | `ask-ai` `plan` `build` `brainstorm` `batch` `pipeline` |
| **Code Intelligence** | `find-definition` `find-references` `semantic-search` |
| **Multi-LLM** | `multi-prompt` `consensus-prompt` `enhance-prompt` `mind-chain` |
| **Cognition** | `decision-journal` `confidence-tracker` `mental-model` `intent-tracker` `error-pattern` `self-critique` `smart-handoff` `context-budget` |
| **Agents** | `agent` `agent-comm` `monitor` |
| **Context** | `shared-thoughts` `get-shared-context` `feedback` |
| **Kanban** | `task` `task-multi` `board` `workspace` |
| **Memory** | `memory` `checkpoint` |
| **Recursive** | `invoke-tool` `invoke-batch` `invocation-log` `agent-orchestrate` |
| **Session** | `session` |
| **Thinking** | `thinking-chain` |
| **Knowledge Graph** | `graph-query` `graph-find-path` `loci-recall` `sequence-recommend` |
| **Cluster Bus** | `cluster-bus-status` `cluster-bus-topology` `cluster-bus-send` `cluster-bus-magistrale` `cluster-bus-flow` `cluster-bus-routing` `cluster-bus-inspect` `cluster-bus-file-read` |
| **MCP Client** | `client-sampling` `client-elicit` `client-roots` |
| **System** | `env-info` `memory-usage` `ai-config` `ai-models` `tool-health` `config` `ping` `help` |

---

## Architecture

### Event Bus (2-Layer)

```
L3  ClusterBus     Redis Pub/Sub cross-process signaling
                   18 signal types, 4 send modes (unicast/broadcast/routed/multicast)
                   HMAC auth, bloom filter dedup, backpressure, circuit breaker
    ----bridges--> hop limit 5, source prefix guard
L1  GlobalEventBus In-process async events, namespaced, max chain depth 8
                   Redis bridge for cross-session propagation
```

### Lorenz Context Compaction

Three algorithms for maintaining reasoning continuity across compaction boundaries:

1. **Phase Detection** — Poincare section analysis. Consecutive Jensen-Shannon divergence identifies topic transitions. Phase boundaries carry maximum information about the reasoning trajectory.

2. **Orbit Compression** — Lorenz attractor cycle detection. NxN TF-IDF cosine similarity matrix with greedy cycle search (length 2-10, min 2 repetitions). Retains first cycle, prunes duplicates.

3. **Perturbation Impact** — JSD(full_context, context_without_item) quantifies each item's contribution. High-impact items are causal anchors that survive compaction.

### The Nine Minds

Nine specialized cognitive agents, each a different mode of thinking. Inspired by [Ouroboros](https://github.com/Q00/ouroboros) by Harry Munro:

| Mind | Mode | Core Question |
|:-----|:-----|:-------------|
| `socratic` | Interrogative | "What are you assuming?" |
| `ontologist` | Classificatory | "What IS this, really?" |
| `seed-architect` | Crystallizing | "Is this complete and unambiguous?" |
| `evaluator` | Verificatory | "Did we build the right thing?" |
| `contrarian` | Adversarial | "What if the opposite were true?" |
| `hacker` | Lateral | "What constraints are actually real?" |
| `simplifier` | Reductive | "What's the simplest thing that could work?" |
| `researcher` | Evidential | "What evidence do we actually have?" |
| `architect` | Structural | "If we started over, would we build it this way?" |

Use any Mind as the `agent` parameter: `ask-ai --agent socratic --prompt "..."`. Compose them for multi-perspective analysis: Socratic → Ontologist → Seed Architect (dialectical progression).

### Agentic Loop

Autonomous agent execution with sub-agent spawning (max depth 2, global budget 10), file context injection via `@path` syntax, and full orchestration ID traceability.

**Parallel Agents** — Launch 2-10 agents in parallel via `agent-orchestrate --parallel`. Each gets a unique `orchestrationId`, tracked in real-time via Redis and in-memory cache. Results aggregated via `Promise.allSettled`.

**Live Monitoring** — Query orchestration status while agents run (MCP blocks during tool calls, so use HTTP):

```bash
# List all active orchestrations
curl http://localhost:3100/orchestrations

# Get specific orchestration status
curl http://localhost:3100/orchestrations/<id>

# Or via MCP tool (when not blocked)
monitor --view orchestrations
```

**Orchestration ID Traceability** — Every agentic loop gets a UUID. Sub-agents reference parent via `parentOrchestrationId`. All cognition records (decisions, confidence, intents, errors, critiques, handoffs) carry `orchestrationId` for full traceability across nested agent hierarchies.

**Tool Access** — All kemdiCode tools are available to agents by default (read-only, kanban, thinking chains — no shell/file-write). Use `allowedTools` or `blockedTools` to customize per-agent.

### Concurrency Model

- Per-session isolation via `AsyncLocalStorage` (propagates through async chains)
- Redis transactions for task state mutations (MULTI/EXEC, Lua scripts)
- Distributed locks with SET NX PX, Lua CAS release, 3-retry backoff

---

## Real-World Usage

kemdiCode tools work at three levels. Here are practical scenarios a developer encounters daily.

### Level 1: Stateless Tools (no AI agents)

Claude Code (or Cursor, etc.) calls kemdiCode tools directly — no embedded AI, just structured cognition and code intelligence.

**Scenario: "I keep hitting the same Redis timeout bug across projects"**

```
# 1. Check if you've seen this before
error-pattern action=match errorType="redis-timeout"
# → Returns: "Pattern found: connection pool exhaustion under load.
#    Fix: set maxRetriesPerRequest=3, enable enableOfflineQueue=false"

# 2. It's a new variant — record it
error-pattern action=record \
  errorType="redis-timeout" \
  pattern="ETIMEDOUT after 200 concurrent writes in bull queue" \
  fix="Switch from ioredis default to pooled connection with family=6 on k8s"

# 3. Track the decision
decision-journal action=record \
  question="How to handle Redis under Bull queue load?" \
  options='["connection pool","Redis Cluster","separate Redis instance"]' \
  chosen="connection pool" \
  reasoning="Cluster adds ops complexity, separate instance adds cost"
```

**Scenario: "Sprint planning — organize 15 tasks across 3 developers"**

```
# Create workspace + board
workspace action=create name="Q1 Auth Rewrite"
board action=create name="Sprint 12" workspaceId=<ws-id>

# Batch create tasks
task action=create boardId=<board-id> title="Migrate session store to Redis" priority=high labels='["backend"]'
task action=create boardId=<board-id> title="Add PKCE flow to OAuth" priority=high labels='["security"]'
task action=create boardId=<board-id> title="Write E2E tests for login" priority=medium labels='["testing"]'
# ... more tasks

# Assign and track
task action=assign taskId=<id> assignee="alice"
task action=update taskId=<id> status="in-progress"
board action=status boardId=<board-id>
# → Shows kanban: 3 todo, 2 in-progress, 1 done
```

**Scenario: "Navigate unfamiliar codebase after joining a team"**

```
# Find where auth middleware is defined
find-definition --symbol "authMiddleware" --path "@src/"

# Find all places it's used
find-references --symbol "authMiddleware" --path "@src/"

# Search by concept, not just text
semantic-search --query "rate limiting per user" --path "@src/"

# Persist findings for next session
memory action=write name="auth-architecture" \
  content="authMiddleware in src/middleware/auth.ts, used in 14 routes. Rate limiting in src/middleware/rateLimit.ts uses sliding window with Redis MULTI."
```

### Level 2: AI Agents (embedded LLM execution)

kemdiCode calls external LLMs internally to reason, analyze, and generate. Your IDE's AI doesn't do this work — kemdiCode's own agents do.

**Scenario: "Debug why API response time went from 50ms to 3 seconds"**

```
# Start structured reasoning with the plan agent
agent-orchestrate \
  --agent plan \
  --task "Analyze why GET /api/users went from 50ms to 3s. Check @src/routes/users.ts and @src/services/userService.ts for N+1 queries, missing indexes, or unnecessary joins." \
  --sessionId "debug-perf" \
  --maxIterations 10 \
  --enableCognition true

# The agent autonomously:
# 1. Reads the files via find-definition / find-references
# 2. Identifies: userService.getAll() does 3 sequential DB calls
# 3. Records in error-pattern: "N+1 query in user list endpoint"
# 4. Records in decision-journal: "Consolidate to single JOIN query"
# 5. Returns: "Root cause: 3 sequential queries per user (N+1). Fix: replace
#    with single LEFT JOIN on user_roles and user_preferences."
```

**Scenario: "Is our proposed microservice split a good idea?"**

Use `mind-chain` — sequential Mind-to-Mind handoff where each Mind builds on the previous:

```
# One call — 4 Minds analyze in sequence, each seeing previous outputs
mind-chain \
  --composition custom \
  --minds '["architect", "contrarian", "researcher", "simplifier"]' \
  --prompt "Evaluate splitting the monolith at @src/ into auth-service, user-service, and notification-service. We have 3 developers and 45 shared models."

# Or use a predefined composition:
mind-chain --composition adversarial \
  --prompt "Should we split the monolith into microservices? @src/"

# Full review with 6 Minds + synthesis:
mind-chain --composition full-review \
  --prompt "Architecture decision: monolith vs microservices for @src/"
```

The chain runs: Architect proposes → Contrarian challenges → Researcher fact-checks → Simplifier finds the pragmatic path → Synthesis combines all perspectives.

**Scenario: "Get 3 LLMs to review a critical security change"**

```
# Send to GPT-4o, Claude, and Gemini in parallel
multi-prompt \
  --prompt "Review this OAuth implementation for security vulnerabilities: @src/auth/oauth.ts" \
  --models '["o:gpt-4.1", "a:claude-sonnet-4-6", "g:gemini-2.5-pro"]' \
  --agent evaluator

# Or use CEO-and-Board consensus
consensus-prompt \
  --prompt "Is this PKCE implementation correct and secure? @src/auth/pkce.ts" \
  --boardModels '["o:gpt-4.1", "g:gemini-2.5-pro", "d:deepseek-v3"]' \
  --ceoModel "a:claude-sonnet-4-6"
# → Board votes + CEO synthesizes a final verdict with reasoning
```

### Level 3: Cluster Bus & Magistrale (distributed LLM orchestration)

Multiple LLM nodes communicate via Redis Pub/Sub. Use this when you need broader context — dispatching the same question to multiple models with different specializations.

**Scenario: "Design a rate limiter — get the best answer from 3 models"**

```
# Dispatch to all registered clusters, pick the best response
cluster-bus-magistrale \
  --prompt "Design a distributed rate limiter for a REST API with 10K req/s. Must handle multi-region, be Redis-backed, and support per-user and per-IP limits. Include TypeScript implementation." \
  --strategy "best-of-n"

# Magistrale:
# 1. Sends the prompt to Cluster A (GPT-4.1), Cluster B (Claude), Cluster C (Gemini)
# 2. Each cluster runs PassController (multi-pass refinement)
# 3. Scores responses: quality 0.45, detail 0.25, relevance 0.15, latency -0.15
# 4. Returns the highest-scoring implementation
```

**Scenario: "Architecture decision — need consensus, not just one opinion"**

```
# Require agreement between models
cluster-bus-magistrale \
  --prompt "For a real-time collaboration feature (like Google Docs), should we use CRDTs, OT, or a simpler last-write-wins approach? Team has 2 backend devs, deadline is 6 weeks." \
  --strategy "consensus"

# Consensus strategy:
# 1. All clusters generate independent responses
# 2. TF-IDF cosine similarity scoring between responses (threshold 0.3)
# 3. If agreement: returns consensus answer
# 4. If disagreement: returns all positions with similarity scores
```

**Scenario: "Production incident — need fastest possible answer"**

```
# First model to respond wins
cluster-bus-magistrale \
  --prompt "Our PostgreSQL replication lag jumped to 30s. WAL sender is active, network is fine. What should we check first?" \
  --strategy "first-wins"

# Returns in ~1s from whichever model responds fastest
```

**Scenario: "Deep code analysis — let clusters spawn their own agents"**

```
# Each cluster spawns an autonomous agent with tool access
cluster-bus-magistrale \
  --prompt "Find potential race conditions in the authentication module" \
  --strategy "first-wins" \
  --orchestrate true \
  --orchestrateAgent "plan" \
  --orchestrateMaxIterations 8 \
  --orchestrateAllowedTools '["find-definition", "find-references", "semantic-search"]'

# Orchestration:
# 1. Magistrale dispatches to clusters with orchestrate payload
# 2. Each cluster spawns a full agentic loop (not just an LLM call)
# 3. Agent reasons, calls tools (find-definition, semantic-search), iterates
# 4. Returns structured analysis with tool call evidence
```

---

## Development

```bash
bun install                    # Install dependencies
bun run build                  # Compile TypeScript
bun run dev                    # Hot reload
bun run test                   # Run 618 tests
bun run typecheck              # Type check
bun run lint                   # ESLint
bun run format                 # Prettier
```

### Adding Tools

1. Create file in `src/tools/<category>/`
2. Define Zod schema with `.describe()` per field
3. Implement `UnifiedTool` interface
4. Register via `registerLazyTool()` in `src/tools/index.ts`
5. Add annotation in `src/tools/annotations-map.ts`

---

## Documentation

- [Technical Whitepaper (PDF)](docs/whitepaper-kemdicode-mcp-v4.0.pdf) — Lorenz compaction, Nine Minds, Poincare phase detection, orbit compression, 39 references ([LaTeX source](docs/whitepaper-kemdicode-mcp-v4.0.tex))
- [Architecture Overview](docs/architecture-overview.md)
- [Bus Architecture](docs/architecture-2-layer-bus.md)
- [Examples](examples/) — Integration patterns and workflows

---

## License

[GNU General Public License v3.0](LICENSE)

## Author

**Dawid Irzyk** — [dawid@kemdi.pl](mailto:dawid@kemdi.pl) — [Kemdi Sp. z o.o.](https://kemdi.pl)
