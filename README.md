<p align="center">
  <img src="kemdi-code-mcp-logo.png" alt="kemdiCode MCP" width="420" />
</p>

<h3 align="center">Model Context Protocol Server for AI-Powered Development</h3>

<p align="center">
  124 tools &bull; 7 LLM providers &bull; cognition layer &bull; multi-agent orchestration &bull; kanban &bull; project memory
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/kemdicode-mcp"><img src="https://img.shields.io/badge/npm-kemdicode--mcp-CB3837?style=flat-square&logo=npm&logoColor=white" alt="npm" /></a>
  <a href="https://github.com/kemdi-pl/kemdicode-mcp/releases"><img src="https://img.shields.io/badge/version-1.23.1-blue?style=flat-square" alt="Version" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0-green?style=flat-square" alt="License" /></a>
</p>

<p align="center">
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/Bun-%E2%89%A51.0-f9f1e1?style=flat-square&logo=bun&logoColor=f9f1e1&labelColor=14151a" alt="Bun" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-%E2%89%A518-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js" /></a>
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-5.0-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript" /></a>
  <a href="https://redis.io"><img src="https://img.shields.io/badge/Redis-optional-DC382D?style=flat-square&logo=redis&logoColor=white" alt="Redis" /></a>
</p>

---

**kemdiCode MCP** is a [Model Context Protocol](https://modelcontextprotocol.io/) server that gives AI agents and IDE assistants access to **124 specialized tools** for code analysis, generation, git operations, file management, AST-aware editing, project memory, cognition & self-improvement, multi-board kanban, and multi-agent coordination.

<details>
<summary><strong>Table of Contents</strong></summary>

- [What's New in 1.23.1](#whats-new-in-1230)
- [Cognition Layer: How AI Remembers](#cognition-layer-how-ai-remembers)
- [Usage Examples](#usage-examples)
- [What's Next](#whats-next)
- [Highlights](#highlights)
- [Compatibility](#compatibility)
- [Quick Start](#quick-start)
- [IDE Configuration](#ide-configuration)
- [Multi-Provider LLM](#multi-provider-llm)
- [Tool Reference](#tool-reference)
- [Architecture](#architecture)
- [Multi-Agent Orchestration](#multi-agent-orchestration)
- [Multi-Model Consensus](#multi-model-consensus)
- [Kanban Task Management](#kanban-task-management)
- [Recursive Tool Invocation](#recursive-tool-invocation)
- [CLI Reference](#cli-reference)
- [Development](#development)
- [Authors](#authors)
- [License](#license)

</details>

---

## What's New in 1.23.1

### Cognition Layer &mdash; 8 AI Self-Improvement Tools

An AI agent that uses kemdiCode MCP no longer starts from zero after each session. Version 1.23.1 adds 8 interconnected cognition tools that give the agent persistent self-awareness:

| Tool | What it does |
|:-----|:-------------|
| `decision-journal` | Records every architectural choice with reasoning, alternatives considered, and outcome tracking |
| `confidence-tracker` | Tracks how certain the agent is about each action &mdash; flags low-confidence calls for human review |
| `mental-model` | Builds persistent maps of system architecture: components, relationships, invariants, file mappings |
| `intent-tracker` | Maintains a hierarchy of goals (mission &rarr; goal &rarr; sub-goal &rarr; task) and detects when the agent drifts |
| `error-pattern` | Cross-session error database &mdash; when the agent hits an error, it checks if it has seen this before |
| `self-critique` | Post-session reflection: what went well, what went poorly, lessons extracted |
| `smart-handoff` | Structured handoff reports for session transitions &mdash; modeled after medical shift handoffs |
| `context-budget` | Estimates context window usage, prioritizes items by relevance, suggests what to evict |

### Cross-Tool Intelligence

These 8 tools are not siloed. They react to each other through an in-process event bus:

- **Record a decision** &rarr; confidence record is auto-created and cross-linked
- **Low confidence detected** (&lt;50%) &rarr; automatic intent drift check
- **Error recorded** &rarr; recent decisions are scanned and tagged if related
- **Intent drift detected** &rarr; self-critique entry auto-generated
- **Handoff created** &rarr; auto-enriched with full cognition snapshot (active intents, recent decisions, recurring errors, lessons learned, stale models)
- **Mental model marked stale** &rarr; affected decisions and intents flagged
- **Lesson learned** &rarr; cross-linked to matching error patterns

All backed by a `CognitionCrossLinker` that maintains bidirectional Redis links between any two cognition records.

### Enhanced Tool Actions

- `self-critique` &rarr; new `check-application` action: verifies which lessons are actually being applied in recent decisions vs. ignored
- `mental-model` &rarr; 3 new actions: `impact-analysis` (BFS from changed files), `dependency-chain` (forward + backward traversal), `invariant-check` (find at-risk invariants)
- `smart-handoff` &rarr; `create` auto-appends a Cognition Snapshot section with data from all stores

### Previous Releases

<details>
<summary>1.22.0 &mdash; Code Quality Modernization</summary>

- `console` &rarr; `Logger` migration across 14 files (~70 call sites)
- ESLint warnings fixed, version header corrected

</details>

<details>
<summary>1.21.0 &mdash; Thinking Chain</summary>

- `thinking-chain` tool with 7 actions, forward-only constraint, branching, Redis-backed with 7-day TTL

</details>

<details>
<summary>1.20.0 &mdash; 14 New Tools + Task Comments</summary>

- `git-add`, `git-commit`, `git-stash`, `task-get`, `task-delete`, `task-comment`, `board-delete`, `workspace-delete`, `file-delete`, `file-move`, `file-copy`, `file-backup-restore`, `pipeline`, `checkpoint-diff`
- Metadata for all tools, auto-sessionId, board/workspace name lookup

</details>

---

## Cognition Layer: How AI Remembers

When an AI agent works on your project over multiple sessions, the biggest problem is **amnesia**. Each new session starts blank. The cognition layer solves this by writing a continuous stream of structured records to Redis as the agent works:

### What actually happens during a session

```
You: "Refactor the auth module to use JWT"

Agent thinks → records intent (mission: refactor auth, goal: implement JWT)
Agent considers options → records decision (chose RS256, rejected HS256, reasoning: key rotation)
Agent starts coding → confidence tracker logs 0.9 for JWT middleware
Agent hits TS error → error-pattern records it, checks DB, finds matching fix from 3 sessions ago
Agent applies fix → confidence stays high
Agent finishes → self-critique: went well (reused error fix), went poorly (forgot to update tests)
Agent creates handoff → auto-enriched with intent hierarchy, decisions, errors, lessons
```

### What happens when a new session starts

```
New session starts → agent calls smart-handoff:latest

Gets back:
- What the human wanted (intent hierarchy)
- What approach was taken and why (decisions with reasoning)
- What's done, in-progress, blocked (status)
- Known unknowns and warnings
- Lessons from previous sessions (apply these!)
- THE single most important first action

Agent resumes work without asking "where were we?"
```

### Why this matters in practice

**Without cognition tools:** The agent asks you to re-explain the project every session. It makes the same mistakes twice. It forgets why a decision was made and reverses it. It loses track of what's done.

**With cognition tools:** The agent picks up exactly where it left off. It checks its error database before trying fixes. It knows which approaches were rejected and why. It applies lessons from past sessions automatically. When it's unsure, it flags the action for human review instead of guessing.

The data lives in Redis with configurable TTL (default 7 days). Nothing is sent to external services. The agent writes its own memories as it works &mdash; you don't need to configure anything beyond enabling the tools.

---

## Usage Examples

### Using kemdiCode MCP tools from your AI agent prompt

You don't call these tools directly &mdash; your AI agent (Claude Code, Cursor, etc.) invokes them when you describe what you need. Here are real prompts and what happens behind the scenes:

**Code review before committing:**
```
You: "Review the auth module for security issues"
→ Agent calls: code-review --files "@src/auth/**/*.ts" --focus "security"
```

**Fix a bug with AI assistance:**
```
You: "There's a race condition in the queue processor, find and fix it"
→ Agent calls: fix-bug --description "race condition in queue processor" --files "@src/queue/"
```

**Multi-model comparison for architecture decisions:**
```
You: "Ask 3 models whether we should use event sourcing or CRUD for the order service"
→ Agent calls: consensus-prompt \
    --prompt "Event sourcing vs CRUD for an order management service with 10k orders/day" \
    --boardModels '["o:gpt-5","a:claude-sonnet-4-5","g:gemini-3-pro"]' \
    --ceoModel "a:claude-opus-4-5:4k"
```

**Project memory for persistent context:**
```
You: "Remember that we use JWT with RS256 for auth in this project"
→ Agent calls: write-memory --name "auth-strategy" --content "JWT with RS256, keys in /etc/keys/" --tags '["auth","architecture"]'

You: "What was our auth strategy?"
→ Agent calls: read-memory --name "auth-strategy"
```

**Multi-agent task distribution:**
```
You: "Set up 3 agents: backend, frontend, QA. Backend works on the API, frontend on React components"
→ Agent calls: agent-register → task-create → task-push-multi
→ Agents coordinate via shared-thoughts and queue-message
```

---

## What's Next

### Install from npm

```bash
npm install -g kemdicode-mcp
```

Then add to your AI IDE:

```bash
# Claude Code
claude mcp add kemdicode-mcp -- kemdicode-mcp

# Or add to ~/.claude.json / Cursor / KiroCode / RooCode config:
{
  "mcpServers": {
    "kemdicode-mcp": {
      "command": "kemdicode-mcp"
    }
  }
}
```

### Tell the agent what you want &mdash; it picks the right tools

kemdiCode MCP works best when you tell the agent to use it. Add a line to your project's `CLAUDE.md`, `.cursorrules`, or system prompt:

```
You have access to kemdiCode MCP server. Use its tools for:
- Project memory (write-memory, read-memory) to persist decisions across sessions
- Cognition tools (decision-journal, smart-handoff) to track your reasoning
- Kanban (task-create, task-list) for project management
- Code analysis (code-review, find-definition) for deep code understanding
```

### Example: Building a landing page

```
You: "Build a landing page for a SaaS product. Use kemdiCode tools to track progress
     and remember design decisions."

What the agent does:
1. write-memory --name "landing-design" → saves design system choices
2. decision-journal → records "chose Tailwind over CSS modules" with reasoning
3. task-create → creates tasks: hero section, pricing, testimonials, footer
4. code-review → reviews each component for accessibility
5. smart-handoff → creates handoff so next session can continue seamlessly
```

### Example: Building a Flappy Bird clone for Android

```
You: "Build a Flappy Bird clone in Kotlin for Android. Track architecture decisions
     and use the kanban board."

What the agent does:
1. intent-tracker → sets mission "Flappy Bird Android clone"
2. mental-model → maps architecture: GameView, Bird, Pipe, ScoreManager, GameLoop
3. board-create → creates "Flappy Bird Sprint 1"
4. task-create → physics engine, rendering, collision detection, scoring, sounds
5. decision-journal → records "chose Canvas over OpenGL" (simpler for 2D, faster iteration)
6. error-pattern → when bitmap loading fails, records fix for next time
7. self-critique → "physics feels floaty, adjust gravity constant next session"
8. smart-handoff → full briefing for the next session with all context
```

The agent doesn't just write code &mdash; it builds a persistent understanding of your project that survives across sessions, compactions, and context resets.

---

## Highlights

| Capability | Description |
|:-----------|:------------|
| **124 MCP Tools** | Code review, refactoring, testing, git, file management, AST editing, memory, checkpoints, kanban, cognition, pipelines |
| **Cognition Layer** | 8 self-improvement tools: decision journal, confidence tracking, mental models, intent hierarchy, error patterns, self-critique, smart handoff, context budget |
| **Cross-Tool Intelligence** | Event bus + cross-linker: tools react to each other automatically (decision &rarr; confidence, error &rarr; fix lookup, drift &rarr; critique) |
| **7 LLM Providers** | Native SDKs for OpenAI, Anthropic, Gemini + OpenAI-compatible for Groq, DeepSeek, Ollama, OpenRouter |
| **Multi-Agent** | Agents connect via HTTP, share context through Redis Pub/Sub, coordinate via kanban boards |
| **Parallel Multi-Model** | Send one prompt to N models simultaneously; CEO-and-Board consensus pattern |
| **Thinking Tokens** | Unified syntax across providers: `o:gpt-5:high` &bull; `a:claude-sonnet-4-5:4k` &bull; `g:gemini-3-pro:8k` |
| **Tree-sitter AST** | Language-aware navigation and symbol editing for 19 languages |
| **Project Memory** | Persistent per-project key-value store with TTL and tags |
| **Session Resurrection** | `loci-recall` + `smart-handoff` restore full context after compaction |
| **Hot Reload** | Change provider, model, or config at runtime without restart |
| **Cross-Runtime** | Runs on Bun (recommended) or Node.js with automatic detection |

---

## Compatibility

| IDE / Editor | Status | Config location |
|:-------------|:------:|:----------------|
| **Claude Code** | ✅ | `claude mcp add` or `~/.claude.json` |
| **Cursor** | ✅ | Settings &rarr; Features &rarr; MCP |
| **KiroCode** | ✅ | `~/.kirocode/mcp.json` |
| **RooCode** | ✅ | VS Code extension settings |

---

## Quick Start

### Prerequisites

- **Bun** &ge; 1.0 _(recommended)_ or **Node.js** &ge; 18
- **Redis** _(optional &mdash; required only for multi-agent features and cognition layer)_

### Install & Run

```bash
git clone https://github.com/kemdi-pl/kemdicode-mcp.git
cd kemdicode-mcp
bun install && bun run build:bun
bun run start:bun
```

<details>
<summary>Node.js alternative</summary>

```bash
npm install && npm run build && npm run start
```

</details>

---

## IDE Configuration

<details open>
<summary><strong>Claude Code</strong></summary>

```bash
claude mcp add kemdicode-mcp -- bun /path/to/kemdicode-mcp/dist/index.js
```

Or add to `~/.claude.json`:

```json
{
  "mcpServers": {
    "kemdicode-mcp": {
      "command": "bun",
      "args": ["/path/to/kemdicode-mcp/dist/index.js"]
    }
  }
}
```

</details>

<details>
<summary><strong>Cursor</strong></summary>

Settings &rarr; Features &rarr; MCP:

```json
{
  "mcpServers": {
    "kemdicode-mcp": {
      "command": "bun",
      "args": ["/path/to/kemdicode-mcp/dist/index.js", "-m", "gpt-5"]
    }
  }
}
```

</details>

<details>
<summary><strong>KiroCode</strong></summary>

Add to `~/.kirocode/mcp.json`:

```json
{
  "mcpServers": {
    "kemdicode-mcp": {
      "command": "bun",
      "args": [
        "/path/to/kemdicode-mcp/dist/index.js",
        "-m", "claude-sonnet-4-5",
        "--redis-host", "127.0.0.1"
      ]
    }
  }
}
```

</details>

<details>
<summary><strong>RooCode</strong></summary>

Add to VS Code settings (RooCode extension):

```json
{
  "mcpServers": {
    "kemdicode-mcp": {
      "command": "bun",
      "args": [
        "/path/to/kemdicode-mcp/dist/index.js",
        "-m", "claude-sonnet-4-5",
        "--redis-host", "127.0.0.1"
      ]
    }
  }
}
```

</details>

---

## Multi-Provider LLM

kemdiCode MCP ships with **7 built-in providers**. Each can be activated by setting the corresponding API key:

```bash
export OPENAI_API_KEY=sk-...            # OpenAI
export ANTHROPIC_API_KEY=sk-ant-...     # Anthropic
export GEMINI_API_KEY=AI...             # Google Gemini
export GROQ_API_KEY=gsk_...            # Groq
export DEEPSEEK_API_KEY=sk-...          # DeepSeek
export OPENROUTER_API_KEY=sk-or-...     # OpenRouter
# Ollama — no key required (local)
```

### Provider Syntax

Use `provider:model` (or the short alias) anywhere a model is accepted:

```
openai:gpt-5               o:gpt-5              # Latest flagship model
anthropic:claude-sonnet-4-5  a:claude-sonnet-4-5  # Best balance
anthropic:claude-opus-4-5    a:claude-opus-4-5    # Maximum intelligence
gemini:gemini-3-pro          g:gemini-3-pro       # Most intelligent
groq:llama-3.3-70b           q:llama-3.3-70b      # Fast inference
deepseek:deepseek-chat       d:deepseek-chat      # Cost effective
ollama:llama3.3              l:llama3.3           # Local deployment
openrouter:gpt-5             r:gpt-5              # Aggregator access
```

### Thinking / Reasoning Tokens

Append a third segment to enable extended thinking:

| Provider | Syntax | Effect |
|:---------|:-------|:-------|
| OpenAI (reasoning) | `o:gpt-5:high` | Sets `reasoning_effort` to low / medium / high |
| Anthropic | `a:claude-sonnet-4-5:4k` | Allocates 4 096 extended thinking tokens |
| Gemini | `g:gemini-3-pro:8k` | Allocates 8 192 thinking tokens |

---

## Tool Reference

> **124 tools** across 22 categories.

| Category | # | Tools |
|:---------|:-:|:------|
| **Cognition** | 8 | `decision-journal` `confidence-tracker` `mental-model` `intent-tracker` `error-pattern` `self-critique` `smart-handoff` `context-budget` |
| **AI Agents** | 4 | `plan` `build` `brainstorm` `ask-ai` |
| **Multi-LLM** | 2 | `multi-prompt` `consensus-prompt` |
| **Code Analysis** | 8 | `code-review` `explain-code` `find-definition` `find-references` `find-symbols` `semantic-search` `code-outline` `analyze-deps` |
| **Line Editing** | 4 | `insert-at-line` `delete-lines` `replace-lines` `replace-content` |
| **Symbol Editing** | 3 | `insert-before-symbol` `insert-after-symbol` `rename-symbol` |
| **Code Modification** | 5 | `fix-bug` `refactor` `auto-fix` `auto-fix-agent` `write-tests` |
| **Project Memory** | 8 | `write-memory` `read-memory` `list-memories` `edit-memory` `delete-memory` `checkpoint-save` `checkpoint-restore` `checkpoint-diff` |
| **Git** | 8 | `git-status` `git-diff` `git-log` `git-blame` `git-branch` `git-add` `git-commit` `git-stash` |
| **File Operations** | 9 | `file-read` `file-write` `file-search` `file-tree` `file-diff` `file-delete` `file-move` `file-copy` `file-backup-restore` |
| **Project** | 5 | `project-info` `run-script` `run-tests` `run-lint` `check-types` |
| **Kanban &mdash; Tasks** | 10 | `task-create` `task-get` `task-list` `task-update` `task-delete` `task-comment` `task-claim` `task-assign` `task-push-multi` `board-status` |
| **Kanban &mdash; Workspaces** | 5 | `workspace-create` `workspace-list` `workspace-join` `workspace-leave` `workspace-delete` |
| **Kanban &mdash; Boards** | 6 | `board-create` `board-list` `board-share` `board-members` `board-invite` `board-delete` |
| **Recursive** | 3 | `invoke-tool` `invoke-batch` `invocation-log` |
| **Multi-Agent** | 13 | `agent-list` `agent-register` `agent-watch` `agent-alert` `agent-inject` `agent-history` `monitor` `agent-summary` `queue-message` `shared-thoughts` `get-shared-context` `feedback` `batch` |
| **Orchestration** | 1 | `pipeline` |
| **Session** | 5 | `session-list` `session-info` `session-create` `session-switch` `session-delete` |
| **Knowledge Graph** | 4 | `graph-query` `graph-find-path` `loci-recall` `sequence-recommend` |
| **Thinking Chain** | 1 | `thinking-chain` |
| **MPC Security** | 4 | `mpc-split` `mpc-distribute` `mpc-reconstruct` `mpc-status` |
| **RL Learning** | 2 | `rl-reward-stats` `rl-dopamine-log` |
| **System** | 10 | `shell-exec` `process-list` `env-info` `memory-usage` `ai-config` `ai-models` `config` `ping` `help` `timeout-test` |

---

## Architecture

### System Overview

| Layer | Component | Description |
|:------|:----------|:------------|
| **Clients** | Claude Code, Cursor, KiroCode, RooCode | Connect via SSE + JSON-RPC (MCP Protocol) |
| **HTTP Server** | `:3100` (Bun or Node.js) | Routes: `/sse`, `/message`, `/resume`, `/stream` |
| **Session Manager** | Per-client isolation | CWD injection, activity tracking, SSE keep-alive |
| **Tool Registry** | 124 tools, 22 categories | Zod schema validation, auto JSON Schema generation, lazy loading, `tools/list_changed` broadcast |
| **Cognition Layer** | Event bus + cross-linker | In-process EventEmitter, bidirectional Redis links, 9 reactive event handlers |
| **Provider Registry** | 7 LLM providers | Native SDKs + OpenAI-compatible. Lazy init, hot-reload, unified thinking tokens |
| **Tree-sitter AST** | 19 languages | WASM parsers, symbol navigation, rename, insert before/after |
| **Runtime Abstraction** | Bun / Node.js | Auto-detection. Unified HTTP, process spawning, crypto |
| **Redis (DB 2)** | Shared state | `mcp:context:*`, `mcp:agents:*`, `mcp:kanban:*`, `mcp:memory:*`, `mcp:cognition:*` |
| **Redis Pub/Sub** | Real-time messaging | Channels: `broadcast`, `inject:<agentId>`, `alerts`, `thoughts` |

---

## Multi-Agent Orchestration

Register agents, distribute work across kanban boards, and coordinate via Redis Pub/Sub:

```bash
# Register specialized agents
agent-register --agents '[
  {"id":"backend","role":"backend","capabilities":["typescript","postgresql"]},
  {"id":"frontend","role":"frontend","capabilities":["react","tailwind"]},
  {"id":"qa","role":"quality","capabilities":["jest","cypress"]}
]'

# Distribute tasks
task-push-multi --taskIds '["api-1","api-2"]' --agents '["backend"]' --mode assign

# Broadcast a requirement
queue-message --broadcast true --message "Use OpenAPI 3.0 spec" --priority high

# Real-time monitoring
monitor --view hierarchy
```

---

## Multi-Model Consensus

Send one prompt to N models in parallel, then let a CEO model synthesize:

```bash
# CEO-and-Board consensus
consensus-prompt \
  --prompt "Redis vs PostgreSQL for sessions?" \
  --boardModels '["o:gpt-5", "a:claude-sonnet-4-5", "g:gemini-3-pro"]' \
  --ceoModel "a:claude-opus-4-5:4k"
```

All board models run via `Promise.allSettled()` &mdash; individual failures never block the others.

---

## Kanban Task Management

```bash
# Create a workspace
workspace-create --name "Project Alpha"

# Add boards
board-create --name "Backend Sprint 1" --workspaceId <ws-id>

# Batch-create tasks
task-create --tasks '[
  {"title":"Auth API","priority":"high","boardId":"<id>"},
  {"title":"Rate limiter","priority":"medium","boardId":"<id>"}
]'

# Push to agents
task-push-multi --taskIds '["t-1","t-2"]' --agents '["agent-1"]' --mode assign
```

**Features:** workspaces &bull; multiple boards &bull; role-based access &bull; batch ops (1-20 per call) &bull; assign / clone / notify &bull; append-only task comments

---

## Recursive Tool Invocation

Sub-agents can invoke other tools with built-in safety limits (max depth 2, rate-limited):

```bash
invoke-batch --invocations '[
  {"tool":"file-read","args":{"path":"@src/index.ts"}},
  {"tool":"run-tests","args":{}}
]' --mode parallel
```

---

## CLI Reference

```bash
bun dist/index.js [options]
```

| Flag | Default | Description |
|:-----|:-------:|:------------|
| `-m, --model` | &mdash; | Primary AI model |
| `-f, --fallback-model` | &mdash; | Fallback on quota / error |
| `--port` | `3100` | HTTP server port |
| `--host` | `127.0.0.1` | Bind address |
| `--redis-host` | `127.0.0.1` | Redis host |
| `--redis-port` | `6379` | Redis port |
| `--no-context` | &mdash; | Disable Redis context sharing |
| `-v, --verbose` | &mdash; | Full output with decorations |
| `--compact` | &mdash; | Essential fields only |

---

## Development

### Build & Run

| Command | Description |
|:--------|:------------|
| `bun install` | Install all dependencies |
| `bun run build:bun` | Bundle for Bun runtime |
| `bun run start:bun` | Start server on `:3100` |
| `bun run dev:bun` | Watch mode with hot-reload |
| `npm run build` | TypeScript compilation for Node.js |
| `npm run start` | Start with Node.js |

### Quality

| Command | Description |
|:--------|:------------|
| `bun run typecheck` | Type-check without emitting |
| `bun run lint` | ESLint |
| `bun run format` | Prettier |
| `bun run prepare` | All checks (pre-commit) |

### Environment Variables

| Variable | Description |
|:---------|:------------|
| `OPENAI_API_KEY` | OpenAI API key |
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `GEMINI_API_KEY` | Google Gemini API key |
| `GROQ_API_KEY` | Groq API key |
| `DEEPSEEK_API_KEY` | DeepSeek API key |
| `OPENROUTER_API_KEY` | OpenRouter API key |
| `KEMDICODE_SHELL_EXEC_ENABLED` | Enable `shell-exec` tool (default: false) |
| `MPC_MASTER_SECRET` | Master secret for MPC security tools |

---

## Authors

**Dawid Irzyk** &mdash; [dawid@kemdi.pl](mailto:dawid@kemdi.pl)
[Kemdi Sp. z o.o.](https://kemdi.pl)

## License

This project is licensed under the **GNU General Public License v3.0** &mdash; see the [LICENSE](LICENSE) file for details.

<p>
  <a href="LICENSE"><img src="https://img.shields.io/badge/GPL--3.0-Kemdi_Sp._z_o.o.-blue?style=flat-square" alt="GPL-3.0" /></a>
</p>
