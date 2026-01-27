<p align="center">
  <img src="src/kemdi-code.png" alt="KemdiCode MCP Server" width="400" />
</p>

<p align="center">
  <a href="https://git.kemdi.pl/Kemdi/kemdicode-mcp/releases"><img src="https://img.shields.io/badge/version-1.14.0-blue?style=flat-square" alt="Version" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0-green?style=flat-square" alt="License" /></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/Bun-%E2%89%A51.0-f9f1e1?style=flat-square&logo=bun&logoColor=f9f1e1&labelColor=14151a" alt="Bun" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-%E2%89%A518-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js" /></a>
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-5.0-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript" /></a>
  <a href="https://redis.io"><img src="https://img.shields.io/badge/Redis-optional-DC382D?style=flat-square&logo=redis&logoColor=white" alt="Redis" /></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/tools-100+-8B5CF6?style=flat-square" alt="100+ Tools" />
  <img src="https://img.shields.io/badge/multi--agent-ready-22c55e?style=flat-square" alt="Multi-Agent" />
  <img src="https://img.shields.io/badge/hot--reload-config-f97316?style=flat-square" alt="Hot Reload" />
</p>

---

A Model Context Protocol (MCP) server providing **100+ specialized tools** for code analysis, generation, git operations, file management, line/symbol editing, project memory, multi-board kanban with workspaces, recursive tool invocation, session monitoring, and multi-agent coordination.

## Features

- **100+ MCP Tools** - Code review, refactoring, testing, git operations, file management, editing, memory, kanban, session monitoring
- **Multi-Board Kanban** - Workspaces for cross-session collaboration, role-based permissions, task distribution to N agents
- **OpenAI SDK** - Official SDK for all OpenAI-compatible APIs (NVIDIA NIM, OpenRouter, Azure, local)
- **Dynamic Model Selection** - Agents can list and select AI models at runtime (`ai-models` tool)
- **Hot-Reload Config** - Change AI provider/model at runtime without restart
- **Multi-Agent Architecture** - Multiple agents connect via HTTP, share context through Redis
- **Recursive Tool Invocation** - Sub-agents can invoke tools (2-level depth)
- **Bun + Node.js Support** - Cross-runtime compatibility with automatic detection
- **Tree-sitter AST** - Language-aware code navigation and symbol editing with support for 19 languages
- **Project Memory** - Persistent key-value storage per project with TTL and tags

## Quick Start

### Requirements

- **Bun** >= 1.0 (recommended) or **Node.js** >= 18
- **Redis** (optional, for multi-agent features)

### Installation

```bash
git clone https://git.kemdi.pl/Kemdi/kemdicode-mcp.git
cd kemdicode-mcp
bun install
bun run build:bun
```

### Running

```bash
bun run start:bun
```

### Configuration

#### Claude Code

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

#### AI Provider Setup

Configure at runtime using `ai-config` and `ai-models` tools:

```bash
# Set NVIDIA NIM as provider
ai-config --action set --apiBaseUrl https://integrate.api.nvidia.com/v1 --apiKey nvapi-xxx

# List available models from provider
ai-models --action list

# Search for specific models (e.g., kimi, llama, deepseek)
ai-models --action search --filter kimi

# Select a model for the session
ai-models --action select --model kimi-k2.5

# Test connection
ai-config --action test
```

## Tool Categories

| Category | Count | Tools |
|:---------|:-----:|:------|
| **AI Agents** | 4 | `plan` `build` `brainstorm` `ask-ai` |
| **Code Analysis** | 8 | `code-review` `explain-code` `find-definition` `find-references` `find-symbols` `semantic-search` `code-outline` `analyze-deps` |
| **Line Editing** | 4 | `insert-at-line` `delete-lines` `replace-lines` `replace-content` |
| **Symbol Editing** | 3 | `insert-before-symbol` `insert-after-symbol` `rename-symbol` |
| **Code Modification** | 5 | `fix-bug` `refactor` `auto-fix` `auto-fix-agent` `write-tests` |
| **Project Memory** | 5 | `write-memory` `read-memory` `list-memories` `edit-memory` `delete-memory` |
| **Git Operations** | 5 | `git-status` `git-diff` `git-log` `git-blame` `git-branch` |
| **File Operations** | 5 | `file-read` `file-write` `file-search` `file-tree` `file-diff` |
| **Project** | 5 | `project-info` `run-script` `run-tests` `run-lint` `check-types` |
| **Kanban Tasks** | 7 | `task-create` `task-list` `task-update` `task-claim` `task-assign` `task-push-multi` `board-status` |
| **Kanban Workspaces** | 4 | `workspace-create` `workspace-list` `workspace-join` `workspace-leave` |
| **Kanban Boards** | 5 | `board-create` `board-list` `board-share` `board-members` `board-invite` |
| **Recursive** | 3 | `invoke-tool` `invoke-batch` `invocation-log` |
| **Multi-Agent** | 13 | `agent-list` `agent-register` `agent-watch` `agent-alert` `agent-inject` `agent-history` `monitor` `agent-summary` `queue-message` `shared-thoughts` `get-shared-context` `feedback` `batch` |
| **Session** | 5 | `session-list` `session-info` `session-create` `session-switch` `session-delete` |
| **MPC Security** | 4 | `mpc-split` `mpc-distribute` `mpc-reconstruct` `mpc-status` |
| **RL Learning** | 2 | `rl-reward-stats` `rl-dopamine-log` |
| **Loci/Graph** | 4 | `graph-query` `graph-find-path` `loci-recall` `sequence-recommend` |
| **System** | 9 | `shell-exec` `process-list` `env-info` `memory-usage` `ai-config` `ai-models` `config` `ping` `help` |
| **Utility** | 1 | `timeout-test` |

## CLI Options

```bash
bun dist/index.js [options]
```

| Option | Default | Description |
|:-------|:-------:|:------------|
| `-m, --model` | - | Primary AI model |
| `-f, --fallback-model` | - | Fallback model for quota errors |
| `--port` | `3100` | HTTP server port |
| `--host` | `127.0.0.1` | HTTP server host |
| `--redis-host` | `127.0.0.1` | Redis host |
| `--redis-port` | `6379` | Redis port |
| `--no-context` | - | Disable Redis context sharing |

## Development

```bash
# Bun (recommended)
bun install         # Install dependencies
bun run build:bun   # Bundle for Bun
bun run start:bun   # Start server
bun run dev:bun     # Hot reload

# Node.js (alternative)
npm install && npm run build && npm run start

# Quality
bun run lint        # ESLint
bun run format      # Prettier
bun run typecheck   # Type checking
bun test            # Tests
```

## License

<p>
  <a href="LICENSE"><img src="https://img.shields.io/badge/GPL--3.0-Kemdi_Sp._z_o.o.-blue?style=flat-square" alt="GPL-3.0 License" /></a>
</p>
