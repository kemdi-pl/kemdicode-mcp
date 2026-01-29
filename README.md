<p align="center">
  <img src="kemdi-code-mcp-logo.png" alt="kemdiCode MCP" width="420" />
</p>

<h3 align="center">Model Context Protocol Server for AI-Powered Development</h3>

<p align="center">
  100+ tools &bull; 7 LLM providers &bull; multi-agent orchestration &bull; kanban &bull; project memory
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/kemdicode-mcp"><img src="https://img.shields.io/badge/npm-kemdicode--mcp-CB3837?style=flat-square&logo=npm&logoColor=white" alt="npm" /></a>
  <a href="https://github.com/kemdi-pl/kemdicode-mcp/releases"><img src="https://img.shields.io/badge/version-1.15.0-blue?style=flat-square" alt="Version" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0-green?style=flat-square" alt="License" /></a>
</p>

<p align="center">
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/Bun-%E2%89%A51.0-f9f1e1?style=flat-square&logo=bun&logoColor=f9f1e1&labelColor=14151a" alt="Bun" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-%E2%89%A518-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js" /></a>
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-5.0-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript" /></a>
  <a href="https://redis.io"><img src="https://img.shields.io/badge/Redis-optional-DC382D?style=flat-square&logo=redis&logoColor=white" alt="Redis" /></a>
</p>

---

**kemdiCode MCP** is a [Model Context Protocol](https://modelcontextprotocol.io/) server that gives AI agents and IDE assistants access to **100+ specialized tools** for code analysis, generation, git operations, file management, AST-aware editing, project memory, multi-board kanban, and multi-agent coordination.

<details>
<summary><strong>Table of Contents</strong></summary>

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

## Highlights

| Capability | Description |
|:-----------|:------------|
| **100+ MCP Tools** | Code review, refactoring, testing, git, file management, AST editing, memory, kanban |
| **7 LLM Providers** | Native SDKs for OpenAI, Anthropic, Gemini + OpenAI-compatible for Groq, DeepSeek, Ollama, OpenRouter |
| **Multi-Agent** | Agents connect via HTTP, share context through Redis Pub/Sub, coordinate via kanban boards |
| **Parallel Multi-Model** | Send one prompt to N models simultaneously; CEO-and-Board consensus pattern |
| **Thinking Tokens** | Unified syntax across providers: `o:o3:high` &bull; `a:claude-sonnet-4-20250514:4k` &bull; `g:gemini-2.5-flash:8k` |
| **Tree-sitter AST** | Language-aware navigation and symbol editing for 19 languages |
| **Project Memory** | Persistent per-project key-value store with TTL and tags |
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
- **Redis** _(optional &mdash; required only for multi-agent features)_

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
      "args": ["/path/to/kemdicode-mcp/dist/index.js", "-m", "gpt-4o"]
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
        "-m", "gpt-4o",
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
        "-m", "gpt-4o",
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
openai:gpt-4o              o:gpt-4o
anthropic:claude-sonnet-4-20250514    a:claude-sonnet-4-20250514
gemini:gemini-2.5-pro      g:gemini-2.5-pro
groq:llama-3.1-70b         q:llama-3.1-70b
deepseek:deepseek-chat     d:deepseek-chat
ollama:llama3              l:llama3
openrouter:gpt-4o          r:gpt-4o
```

### Thinking / Reasoning Tokens

Append a third segment to enable extended thinking:

| Provider | Syntax | Effect |
|:---------|:-------|:-------|
| OpenAI (o-series) | `o:o3:high` | Sets `reasoning_effort` to low / medium / high |
| Anthropic | `a:claude-sonnet-4-20250514:4k` | Allocates 4 096 thinking tokens |
| Gemini | `g:gemini-2.5-flash:8k` | Allocates 8 192 thinking tokens |

### Runtime Configuration

```bash
# Discover models from a provider
ai-models --action list

# Switch model at runtime
ai-models --action select --model gpt-4o

# Set custom API endpoint (e.g. NVIDIA NIM)
ai-config --action set --apiBaseUrl https://integrate.api.nvidia.com/v1

# Verify connection
ai-config --action test
```

---

## Tool Reference

> **101 tools** across 20 categories.

| Category | # | Tools |
|:---------|:-:|:------|
| **AI Agents** | 4 | `plan` `build` `brainstorm` `ask-ai` |
| **Multi-LLM** | 2 | `multi-prompt` `consensus-prompt` |
| **Code Analysis** | 8 | `code-review` `explain-code` `find-definition` `find-references` `find-symbols` `semantic-search` `code-outline` `analyze-deps` |
| **Line Editing** | 4 | `insert-at-line` `delete-lines` `replace-lines` `replace-content` |
| **Symbol Editing** | 3 | `insert-before-symbol` `insert-after-symbol` `rename-symbol` |
| **Code Modification** | 5 | `fix-bug` `refactor` `auto-fix` `auto-fix-agent` `write-tests` |
| **Project Memory** | 5 | `write-memory` `read-memory` `list-memories` `edit-memory` `delete-memory` |
| **Git** | 5 | `git-status` `git-diff` `git-log` `git-blame` `git-branch` |
| **File Operations** | 5 | `file-read` `file-write` `file-search` `file-tree` `file-diff` |
| **Project** | 5 | `project-info` `run-script` `run-tests` `run-lint` `check-types` |
| **Kanban &mdash; Tasks** | 7 | `task-create` `task-list` `task-update` `task-claim` `task-assign` `task-push-multi` `board-status` |
| **Kanban &mdash; Workspaces** | 4 | `workspace-create` `workspace-list` `workspace-join` `workspace-leave` |
| **Kanban &mdash; Boards** | 5 | `board-create` `board-list` `board-share` `board-members` `board-invite` |
| **Recursive** | 3 | `invoke-tool` `invoke-batch` `invocation-log` |
| **Multi-Agent** | 13 | `agent-list` `agent-register` `agent-watch` `agent-alert` `agent-inject` `agent-history` `monitor` `agent-summary` `queue-message` `shared-thoughts` `get-shared-context` `feedback` `batch` |
| **Session** | 5 | `session-list` `session-info` `session-create` `session-switch` `session-delete` |
| **MPC Security** | 4 | `mpc-split` `mpc-distribute` `mpc-reconstruct` `mpc-status` |
| **RL Learning** | 2 | `rl-reward-stats` `rl-dopamine-log` |
| **Knowledge Graph** | 4 | `graph-query` `graph-find-path` `loci-recall` `sequence-recommend` |
| **System** | 10 | `shell-exec` `process-list` `env-info` `memory-usage` `ai-config` `ai-models` `config` `ping` `help` `timeout-test` |

---

## Architecture

```
                    ┌──────────────────────────────────────┐
                    │       kemdiCode MCP  (HTTP :3100)    │
                    └──────┬──────────────┬────────────────┘
                           │              │
               ┌───────────▼──┐    ┌──────▼────────┐
               │  Claude Code │    │  Cursor / IDE  │
               └───────────┬──┘    └──────┬────────┘
                           │              │
               ┌───────────▼──────────────▼────────┐
               │       Provider Registry            │
               │  OpenAI │ Anthropic │ Gemini │ ... │
               └───────────────────┬───────────────┘
                                   │
               ┌───────────────────▼───────────────┐
               │            Redis (DB 2)            │
               │  context · agents · kanban · pubsub│
               └───────────────────────────────────┘
```

```
src/
├── index.ts               # HTTP server, SSE, MCP protocol
├── ai/
│   ├── client.ts          # Unified completion API
│   ├── model-spec.ts      # provider:model:thinking parser
│   ├── providers/         # OpenAI, Anthropic, Gemini, OpenAI-compat
│   ├── agents.ts          # Agent system prompts (plan, build, explore)
│   └── file-context.ts    # File attachment handling
├── runtime/               # Bun / Node.js abstraction
├── config/                # Typed config with Zod validation
├── context/               # Redis Pub/Sub, agent monitor, feedback loop
├── kanban/                # Tasks, boards, workspaces, membership
├── recursive/             # Safe recursive tool invocation (depth 2)
├── session/               # Session lifecycle
├── tree-sitter/           # WASM-based AST parsing (19 languages)
├── tools/                 # 20 tool categories (100+ tools)
└── utils/                 # Cache, validation, logging, errors
```

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

**Capabilities:**
- Batch registration (1-20 agents per call)
- Priority message queues (critical / high / normal / low)
- Context injection into running agents
- Hierarchical monitoring: Session &rarr; Workspace &rarr; Board &rarr; Task &rarr; Agent
- Shared knowledge base (`shared-thoughts`)

---

## Multi-Model Consensus

Send one prompt to N models in parallel, then let a CEO model synthesize:

```bash
# Compare responses
multi-prompt --prompt "Explain monads in simple terms" \
  --models '["o:gpt-4o", "a:claude-sonnet-4-20250514", "g:gemini-2.5-pro"]'

# CEO-and-Board consensus
consensus-prompt \
  --prompt "Redis vs PostgreSQL for sessions?" \
  --boardModels '["o:gpt-4o", "a:claude-sonnet-4-20250514", "g:gemini-2.5-pro"]' \
  --ceoModel "a:claude-sonnet-4-20250514:4k"
```

All board models run via `Promise.allSettled()` &mdash; individual failures never block the others.

---

## Kanban Task Management

```bash
# Create a workspace
workspace-create --name "Project Alpha"

# Add boards
board-create --name "Backend Sprint 1" --workspaceId <ws-id>
board-create --name "Frontend Bugs"    --workspaceId <ws-id>

# Batch-create tasks
task-create --tasks '[
  {"title":"Auth API","priority":"high","boardId":"<id>"},
  {"title":"Rate limiter","priority":"medium","boardId":"<id>"}
]'

# Push to agents
task-push-multi --taskIds '["t-1","t-2"]' --agents '["agent-1"]' --mode assign
```

**Features:** workspaces &bull; multiple boards &bull; owner / admin / member / viewer roles &bull; batch create / update (1-20 per call) &bull; assign / clone / notify distribution modes

---

## Recursive Tool Invocation

Sub-agents can invoke other tools with built-in safety limits (max depth 2, rate-limited):

```bash
invoke-tool --tool "code-review" --args '{"files":"@src/auth.ts"}'

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

---

## Development

```bash
bun install            # Install dependencies
bun run build:bun      # Build
bun run start:bun      # Start server
bun run dev:bun        # Watch mode

bun run lint           # ESLint
bun run format         # Prettier
bun run typecheck      # tsc --noEmit
bun test               # Vitest
```

<details>
<summary>Adding a new tool</summary>

1. Create a file in the appropriate `src/tools/` subdirectory.
2. Define a Zod schema with `.describe()` for every field.
3. Implement the `UnifiedTool` interface.
4. Register in `src/tools/index.ts`.

```typescript
import { z } from 'zod';
import type { UnifiedTool } from '../registry.js';

const schema = z.object({
  input: z.string().describe('Input value'),
});

export const myTool: UnifiedTool = {
  name: 'my-tool',
  description: 'What this tool does',
  zodSchema: schema,
  execute: async (args) => {
    const { input } = args as z.infer<typeof schema>;
    return `Result: ${input}`;
  },
};
```

</details>

---

## Authors

**Dawid Irzyk** &mdash; [dawid@kemdi.pl](mailto:dawid@kemdi.pl)
[Kemdi Sp. z o.o.](https://kemdi.pl)

## License

This project is licensed under the **GNU General Public License v3.0** &mdash; see the [LICENSE](LICENSE) file for details.

<p>
  <a href="LICENSE"><img src="https://img.shields.io/badge/GPL--3.0-Kemdi_Sp._z_o.o.-blue?style=flat-square" alt="GPL-3.0" /></a>
</p>
