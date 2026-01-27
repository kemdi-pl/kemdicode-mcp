# KemdiCode MCP Server

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

## Tested IDEs & Editors

KemdiCode MCP is tested and verified to work with:

| IDE/Editor | Status | Configuration |
|------------|--------|---------------|
| **Claude Code** | ✅ Fully Supported | `claude mcp add` or `~/.claude.json` |
| **Cursor** | ✅ Fully Supported | Settings > Features > MCP |
| **KiroCode** | ✅ Fully Supported | `~/.kirocode/mcp.json` |
| **RooCode** | ✅ Fully Supported | VS Code extension settings |

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

#### Cursor

Add to Cursor MCP settings (Settings > Features > MCP):

```json
{
  "mcpServers": {
    "kemdicode-mcp": {
      "command": "bun",
      "args": [
        "/path/to/kemdicode-mcp/dist/index.js",
        "-m", "kimi-k2.5"
      ]
    }
  }
}
```

#### KiroCode

Add to `~/.kirocode/mcp.json`:

```json
{
  "mcpServers": {
    "kemdicode-mcp": {
      "command": "bun",
      "args": [
        "/path/to/kemdicode-mcp/dist/index.js",
        "-m", "kimi-k2.5",
        "--redis-host", "127.0.0.1"
      ]
    }
  }
}
```

#### RooCode

Add to VS Code settings (RooCode extension settings):

```json
{
  "mcpServers": {
    "kemdicode-mcp": {
      "command": "bun",
      "args": [
        "/path/to/kemdicode-mcp/dist/index.js",
        "-m", "kimi-k2.5",
        "--redis-host", "127.0.0.1"
      ]
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

## Key Capabilities

### Cross-Runtime Platform Support

KemdiCode MCP runs on both **Bun** (recommended) and **Node.js** with automatic runtime detection:

```bash
# Bun (faster, recommended)
bun install && bun run build:bun && bun run start:bun

# Node.js (alternative)
npm install && npm run build && npm run start
```

The runtime abstraction layer (`src/runtime/`) provides unified APIs for:
- HTTP server (Bun.serve / node:http)
- Process spawning (Bun.spawn / child_process)
- Crypto utilities
- Network operations

### Advanced File Operations

Smart file handling with automatic encoding detection, backups, and batch processing:

```bash
# Read file with encoding detection
file-read --path @src/index.ts

# Search across codebase with ripgrep
file-search --pattern "class.*Controller" --glob "*.ts"

# Batch write multiple files atomically
file-write --files '[{"path":"@src/utils.ts","content":"export const add = (a,b) => a+b;"}]'

# Compare files with unified diff
file-diff --file1 @src/old.ts --file2 @src/new.ts

# Directory tree with depth control
file-tree --path @src --depth 3
```

### Dependency Injection & Code Modification

Inject dependencies and modify code at symbol level:

```bash
# Insert import statement before a class definition
insert-before-symbol --symbol "UserService" --content "import { Logger } from './logger';"

# Add method after existing symbol
insert-after-symbol --symbol "UserService" --content "  private logger = new Logger();"

# Rename symbol across entire codebase (with dry-run)
rename-symbol --symbol "oldName" --newName "newName" --dry-run true

# Refactor with AI assistance
refactor --files "@src/services/*.ts" --goal "Apply dependency injection pattern"
```

### Multi-Board Kanban System

Advanced task management with workspaces, boards, and role-based access:

```bash
# Create workspace for cross-session collaboration
workspace-create --name "Project Alpha" --description "Main development workspace"

# Create multiple boards within workspace
board-create --name "Backend Sprint 1" --workspaceId <id>
board-create --name "Frontend Bugs" --workspaceId <id>

# Create tasks with board assignment
task-create --tasks '[{"title":"API endpoint","boardId":"<board-id>"}]' --priority high

# Push tasks to N agents simultaneously
task-push-multi --taskIds '["task-1","task-2"]' --agents '["agent-1","agent-2"]' --mode assign

# Check board status
board-status --boardId <board-id>
```

**Key Features:**
- **Workspaces**: Cross-session collaboration containers
- **Multiple Boards**: Organize work by sprints, teams, or priorities
- **Role-Based Access**: owner/admin/member/viewer permissions
- **Batch Operations**: Create/update 1-20 tasks in single call
- **Task Distribution**: Push to N agents with assign/clone/notify modes

### LLM-Controlled Sub-Agent Orchestration

Main LLM can spawn and control multiple sub-agents for parallel task execution:

```bash
# Register multiple sub-agents at once
agent-register --agents '[
  {"id":"agent-1","role":"backend","capabilities":["typescript","database"]},
  {"id":"agent-2","role":"frontend","capabilities":["react","css"]}
]'

# Queue commands to specific agents
queue-message --agentIds '["agent-1"]' --message "Implement user authentication API" --priority critical

# Broadcast to all agents
queue-message --broadcast true --message "Code freeze in 1 hour" --priority high

# Monitor all agents
monitor --view hierarchy

# Inject context into running agents
agent-inject --agentId agent-1 --context "Use JWT tokens for auth"

# Get shared context from other agents
get-shared-context --scope all --format summary
```

**Orchestration Features:**
- **Batch Registration**: Register 1-20 agents in single call
- **Message Queues**: Priority-based (critical/high/normal/low) messaging
- **Broadcast**: Send to all agents simultaneously
- **Context Injection**: Real-time context updates to running agents
- **Hierarchical Monitoring**: Session → Workspaces → Boards → Tasks → Agents view
- **Shared Thoughts**: Collective knowledge base across all agents

### Recursive Tool Invocation

Sub-agents can invoke tools with safety controls (2-level depth limit):

```bash
# Invoke tool from agent context
invoke-tool --tool "code-review" --args '{"files":"@src/auth.ts"}'

# Batch invoke multiple tools
invoke-batch --invocations '[
  {"tool":"file-read","args":{"path":"@src/index.ts"}},
  {"tool":"code-review","args":{"files":"@src/index.ts"}}
]' --mode parallel

# View invocation history
invocation-log --limit 20
```

## Case Study: Multi-Agent Software Development

**Scenario**: Building a full-stack application with KemdiCode MCP

### Setup Phase
```bash
# 1. Start MCP server and configure AI provider
ai-config --action set --apiBaseUrl https://api.openai.com/v1 --apiKey sk-xxx
ai-models --action select --model gpt-4o

# 2. Create workspace for the project
workspace-create --name "E-Commerce Platform"
```

### Parallel Development
```bash
# 3. Register specialized agents
agent-register --agents '[
  {"id":"backend-dev","role":"backend","capabilities":["typescript","postgresql","api-design"]},
  {"id":"frontend-dev","role":"frontend","capabilities":["react","typescript","tailwind"]},
  {"id":"qa-agent","role":"quality","capabilities":["testing","jest","cypress"]}
]'

# 4. Create kanban boards for each team
board-create --name "Backend API" --workspaceId <ws-id>
board-create --name "Frontend UI" --workspaceId <ws-id>
board-create --name "QA & Testing" --workspaceId <ws-id>

# 5. Distribute tasks to agents
task-push-multi --taskIds '["api-1","api-2","api-3"]' --agents '["backend-dev"]' --mode assign
task-push-multi --taskIds '["ui-1","ui-2"]' --agents '["frontend-dev"]' --mode assign
```

### Real-Time Coordination
```bash
# 6. Monitor progress
monitor --view overview

# 7. Inject shared requirements to all agents
queue-message --broadcast true --message "All APIs must return consistent error format" --priority high

# 8. Backend agent shares context
shared-thoughts --action write --scope code --content "Using Zod for API validation"

# 9. Frontend agent reads shared context
get-shared-context --scope code --format detailed
```

### Quality Assurance
```bash
# 10. QA agent runs automated checks
batch --operations '[
  {"tool":"run-tests","args":{}},
  {"tool":"run-lint","args":{}},
  {"tool":"check-types","args":{}}
]'

# 11. Code review across all files
code-review --files "@src/**/*.ts" --focus security
```

**Results**: 
- 3 agents working in parallel on different components
- Shared context ensures consistency across codebase
- Real-time monitoring and coordination via Redis
- Automatic quality checks integrated into workflow
- Task distribution based on agent capabilities

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

## Authors

- **Dawid Irzyk** - Lead Developer - [dawid@kemdi.pl](mailto:dawid@kemdi.pl)

## License

<p>
  <a href="LICENSE"><img src="https://img.shields.io/badge/GPL--3.0-Kemdi_Sp._z_o.o.-blue?style=flat-square" alt="GPL-3.0 License" /></a>
</p>
