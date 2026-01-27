# KemdiCode MCP Server

## Overview

Model Context Protocol (MCP) server providing **100+ specialized tools** for code analysis, generation, git operations, file management, line/symbol editing, project memory, multi-board kanban with workspaces, recursive tool invocation, session monitoring, and multi-agent coordination.

**Version:** 1.14.0

## Architecture

```
src/
├── index.ts                 # HTTP server, SSE handlers, MCP protocol
├── constants.ts             # CLI flags, error messages, timeouts
├── ai/                      # OpenAI SDK integration
│   ├── client.ts            # OpenAI SDK wrapper (any OpenAI-compatible API)
│   ├── execute.ts           # High-level AI execution with agents
│   ├── agents.ts            # Agent configurations (plan, build, explore)
│   └── file-context.ts      # File attachment handling
├── runtime/                 # Cross-runtime abstraction (Bun/Node.js)
│   ├── index.ts             # Runtime detection (isBun, isNode)
│   ├── http.ts              # HTTP server (Bun.serve / node:http)
│   ├── process.ts           # Process spawning
│   ├── crypto.ts            # Crypto utilities
│   ├── net.ts               # Network utilities
│   └── types.ts             # Unified types
├── context/                 # Multi-agent context sharing
│   ├── agent-monitor.ts     # Redis Pub/Sub for agent coordination
│   ├── storage.ts           # Redis-based context storage (DB 2)
│   ├── integration.ts       # High-level context functions
│   ├── feedback-loop.ts     # Learning from iterations
│   ├── iteration-tracker.ts # Track fix attempts
│   └── types.ts             # TypeScript interfaces
├── kanban/                  # Agent task management
│   ├── kanban-store.ts      # Redis persistence for tasks
│   ├── workspace-store.ts   # Workspace CRUD operations
│   ├── board-store.ts       # Board management
│   ├── membership-store.ts  # Role-based membership
│   ├── migration.ts         # Lazy migration to multi-board
│   ├── types.ts             # Task, Board, Workspace types
│   └── index.ts             # Module exports
├── recursive/               # Recursive tool invocation
│   ├── tool-invoker.ts      # Safe tool execution with limits
│   ├── types.ts             # Invocation request/result types
│   └── index.ts             # Module exports
├── tree-sitter/             # AST-based code analysis
│   ├── parser-manager.ts    # WASM parser lifecycle
│   ├── types.ts             # Language mappings, symbol types
│   └── index.ts             # Module exports
├── session/                 # Session management
│   ├── manager.ts           # Session lifecycle
│   ├── cwd-resolver.ts      # Project path resolution
│   └── types.ts             # Session types
├── tools/
│   ├── registry.ts          # Unified tool interface, Zod schemas
│   ├── index.ts             # Tool registration
│   ├── agents/              # Agent monitoring (9 tools)
│   ├── code/                # Code navigation + symbol editing (9 tools)
│   ├── context/             # Context sharing (4 tools)
│   ├── edit/                # Line-based editing (4 tools)
│   ├── file/                # File operations (5 tools)
│   ├── git/                 # Git operations (5 tools)
│   ├── kanban/              # Kanban: tasks, boards, workspaces (16 tools)
│   ├── memory/              # Project memory (5 tools)
│   ├── project/             # Project management (5 tools)
│   ├── recursive/           # Recursive invocation (3 tools)
│   ├── specialized/         # AI analysis (8 tools)
│   └── system/              # System tools (7 tools)
├── types/                   # Shared type definitions
│   ├── tool-types.ts
│   ├── file-types.ts
│   └── git-types.ts
└── utils/
    ├── commandExecutor.ts   # Process spawning with timeout
    ├── file-utils.ts        # File operations
    ├── edit-utils.ts        # Line editing utilities
    ├── git-utils.ts         # Git command helpers
    ├── process-utils.ts     # Process utilities
    ├── cache.ts             # In-memory caching
    ├── errors.ts            # Error types
    ├── validation.ts        # Input validation
    └── logger.ts            # Logging
```

## Tool Categories

### AI Agents (4 tools)
| Tool | Agent | Description |
|------|-------|-------------|
| `ask-ai` | configurable | Direct API calls with all options |
| `plan` | plan | Deep analysis and planning |
| `build` | build | Immediate code execution |
| `brainstorm` | plan | Creative ideation (SCAMPER, Design Thinking) |

### Code Analysis (8 tools)
| Tool | Description |
|------|-------------|
| `code-review` | Security/performance/quality review |
| `explain-code` | Code explanation (quick/detailed/deep) |
| `analyze-deps` | Dependency analysis |
| `find-definition` | Find symbol definitions |
| `find-references` | Find all usages |
| `find-symbols` | List symbols in file |
| `semantic-search` | AI-powered semantic search |
| `code-outline` | File structure outline |

### Line-Based Editing (4 tools)
| Tool | Description |
|------|-------------|
| `insert-at-line` | Insert content at specific line number |
| `delete-lines` | Delete range of lines |
| `replace-lines` | Replace range of lines with new content |
| `replace-content` | Find/replace with regex, dry-run support |

### Symbol-Based Editing (3 tools)
| Tool | Description |
|------|-------------|
| `insert-before-symbol` | Insert content before symbol definition |
| `insert-after-symbol` | Insert content after symbol block end |
| `rename-symbol` | Rename symbol across codebase (dry-run) |

### Code Modification (5 tools)
| Tool | Description |
|------|-------------|
| `fix-bug` | Root cause analysis and fixes |
| `refactor` | Code improvement (SOLID, DRY) |
| `auto-fix` | Automatic code fixes (string replace) |
| `auto-fix-agent` | Multi-agent fixing with OpenAI Agents SDK (diff patching) |
| `write-tests` | Test generation |

### Project Memory (5 tools)
| Tool | Description |
|------|-------------|
| `write-memory` | Store named memory with tags and TTL |
| `read-memory` | Retrieve memory by name |
| `list-memories` | List all project memories with filters |
| `delete-memory` | Delete a memory entry |
| `edit-memory` | Modify content and tags |

### Git Operations (5 tools)
| Tool | Description |
|------|-------------|
| `git-status` | Repository status |
| `git-diff` | Show changes (staged/unstaged) |
| `git-log` | Commit history with filters |
| `git-blame` | Line-by-line history |
| `git-branch` | Branch management |

### File Operations (5 tools)
| Tool | Description |
|------|-------------|
| `file-read` | Read with encoding detection |
| `file-write` | Write with backup |
| `file-search` | Ripgrep search |
| `file-tree` | Directory tree |
| `file-diff` | Compare two files |

### Project Management (5 tools)
| Tool | Description |
|------|-------------|
| `project-info` | Package metadata |
| `run-script` | Execute npm/composer scripts |
| `run-tests` | Run test suite |
| `run-lint` | Run ESLint/PHPCS/PHPStan |
| `check-types` | TypeScript/PHPStan types |

### System (7 tools)
| Tool | Description |
|------|-------------|
| `shell-exec` | Safe shell execution |
| `process-list` | Running processes |
| `env-info` | Environment info |
| `memory-usage` | Memory statistics |
| `ai-config` | Manage AI provider settings |
| `ai-models` | List/select AI models from provider |
| `ping` | Health check |

### Kanban Tasks (7 tools)
| Tool | Description |
|------|-------------|
| `task-create` | Create 1-20 tasks at once (batch) |
| `task-list` | List tasks with filters (status, priority, assignee, boardId) |
| `task-update` | Update 1-20 tasks at once (batch) |
| `task-claim` | Worker claims an available task |
| `task-assign` | Assign 1-20 tasks to agents at once (batch) |
| `task-push-multi` | Push task to N agents (assign/clone/notify) |
| `board-status` | Get board summary and statistics |

### Kanban Workspaces (4 tools)
| Tool | Description |
|------|-------------|
| `workspace-create` | Create workspace for cross-session collaboration |
| `workspace-list` | List available workspaces |
| `workspace-join` | Join session to workspace |
| `workspace-leave` | Leave workspace |

### Kanban Boards (5 tools)
| Tool | Description |
|------|-------------|
| `board-create` | Create new board in session/workspace |
| `board-list` | List boards (session + workspace) |
| `board-share` | Share board with session/workspace |
| `board-members` | Manage board members |
| `board-invite` | Invite agent with role |

### Recursive Tool Invocation (3 tools)
| Tool | Description |
|------|-------------|
| `invoke-tool` | Invoke MCP tool from agent context (with safety checks) |
| `invoke-batch` | Batch invoke multiple tools (parallel/sequential) |
| `invocation-log` | View agent's tool invocation history |

### Multi-Agent (13 tools)
| Tool | Description |
|------|-------------|
| `agent-list` | List active agents |
| `agent-register` | Register 1-20 agents at once (batch) |
| `agent-watch` | Real-time Pub/Sub monitoring |
| `agent-alert` | Send alerts to agents |
| `agent-inject` | Inject context/directives |
| `agent-history` | View message history |
| `monitor` | Session monitoring (overview, agents, tasks, hierarchy, activity) |
| `agent-summary` | Update 1-20 agent summaries at once (batch) |
| `queue-message` | Queue messages to 1-20 agents (batch, supports broadcast) |
| `shared-thoughts` | Collective knowledge base |
| `get-shared-context` | Context from other servers |
| `feedback` | Feedback loop tracking |
| `batch` | Parallel tool execution |

## Key Components

### Tool Registry (`tools/registry.ts`)
- Unified `UnifiedTool` interface using Zod schemas
- Automatic JSON Schema generation for MCP protocol
- Centralized validation and execution
- Auto-share results to Redis for context

### OpenAI SDK Client (`ai/client.ts`)
- Official OpenAI SDK for all OpenAI-compatible APIs
- Supports NVIDIA NIM, OpenRouter, Azure, local models (Ollama)
- No hardcoded defaults - fully configurable via `ai-config` tool
- Model discovery via `ai-models` tool (list, search, select)
- Built-in retry and rate limiting (SDK native)
- Hot-reload configuration without restart

### Agent Monitor (`context/agent-monitor.ts`)
- Redis Pub/Sub for real-time messaging
- Agent registration and lifecycle
- Alert broadcasting
- Context/directive injection

## Multi-Agent Architecture

```
┌─────────────────────────────────────────────────────────────┐
│              KemdiCode MCP Server (HTTP :3100)              │
├─────────────────────────────────────────────────────────────┤
│  Clients:                                                   │
│  ├─ Claude Code Agent 1 ──┐                                │
│  ├─ Claude Code Agent 2 ──┼──► OpenAI SDK                  │
│  └─ Cursor Agent ─────────┘         │                      │
│                                     ▼                      │
│                          Any OpenAI-compatible API          │
├─────────────────────────────────────────────────────────────┤
│  Redis (DB 2):                                              │
│  ├─ mcp:context:*        - Shared tool outputs             │
│  ├─ mcp:agents:*         - Agent registry                  │
│  ├─ mcp:messages:*       - Inter-agent messages            │
│  ├─ mcp:kanban:*         - Tasks, boards, workspaces       │
│  └─ mcp:channel:*        - Pub/Sub channels                │
└─────────────────────────────────────────────────────────────┘
```

### Benefits
- **Official OpenAI SDK**: Reliable, tested, with built-in retry/rate limiting
- **No hardcoded defaults**: Fully configurable, transparent package
- **True parallelism**: Multiple agents share context through Redis
- **Cross-session collaboration**: Workspaces for multi-agent projects
- **Real-time coordination**: Pub/Sub messaging

## CLI Options

```bash
bun dist/index.js [options]
```

| Option | Default | Description |
|--------|---------|-------------|
| `-m, --model` | - | Primary AI model |
| `-f, --fallback-model` | - | Fallback model for quota errors |
| `--port` | `3100` | HTTP server port |
| `--host` | `127.0.0.1` | HTTP server host |
| `--redis-host` | `127.0.0.1` | Redis host |
| `--redis-port` | `6379` | Redis port |
| `--no-context` | - | Disable Redis context sharing |

## Server Management

### Running the Server

The server runs via nohup with Bun. Use the startup script:

```bash
# Start server (auto-checks if already running)
./start-server.sh

# Manual start with environment
export MPC_MASTER_SECRET="your-secret-here"
nohup bun dist/index.js --port 3100 >> /tmp/kemdicode-mcp.log 2>&1 &

# Check if running
nc -z 127.0.0.1 3100 && echo "Running"

# View logs
tail -f /tmp/kemdicode-mcp.log

# Stop server
pkill -f "bun dist/index.js"
```

### After Code Changes

After modifying the code, rebuild and restart:

```bash
cd /opt/kemdicode-mcp
npm run build
pkill -f "bun dist/index.js"
./start-server.sh
```

## Development

### Commands
```bash
# Bun (recommended)
bun install         # Install dependencies
bun run build:bun   # Bundle for Bun
bun run start:bun   # Start with Bun
bun run dev:bun     # Hot reload with Bun

# Node.js (alternative)
npm install && npm run build && npm run start

# Quality
bun run typecheck   # Type checking only
bun run lint        # ESLint
bun run format      # Prettier
bun run prepare     # All checks (pre-commit)
bun run add-license # Add GPL-3.0 headers
```

### Adding New Tools

1. Create file in appropriate `tools/` subdirectory
2. Define Zod schema with `.describe()` for each field
3. Implement `UnifiedTool` interface
4. Register in `tools/index.ts`

```typescript
import { z } from 'zod';
import { UnifiedTool } from '../registry.js';

const schema = z.object({
  input: z.string().describe('Input parameter'),
  option: z.enum(['a', 'b']).default('a').describe('Option'),
});

export const myTool: UnifiedTool = {
  name: 'my-tool',
  description: 'Tool description for MCP',
  zodSchema: schema,
  execute: async (args, onProgress) => {
    // Implementation
    return 'result';
  },
};
```

## Conventions

- **Prompts**: Always in English for model consistency
- **Agent selection**:
  - `plan` - Deep analysis, reviews, planning
  - `build` - Immediate code changes
- **Error handling**: Descriptive errors, automatic fallback
- **File paths**: Use `@path/file.ts` notation

## Changelog

### 1.14.0 - NPM-Ready Package
- **Removed hardcoded apiBaseUrl**: No longer defaults to OpenRouter URL
- **Improved type safety**: `ReasoningDelta` and `ReasoningMessage` types for reasoning models
- **npm-ready package.json**: Added `exports`, `types`, `sideEffects`, `publishConfig` fields
- **Total Tools**: 101

### 1.13.2 - OpenAI Agents SDK Integration
- **`auto-fix-agent` tool**: Multi-agent code fixing with OpenAI Agents SDK
  - Uses `applyPatchTool` for diff-based file patching
  - `WorkspaceEditor` implementing `Editor` interface
  - Path validation prevents operations outside workspace
  - Auto-backup before modifications
  - Configurable approval workflow for patches
- **Fixed**: `auto-fix` tool now groups edits per file atomically (prevents file corruption)
- **Total Tools**: 101

### 1.13.1 - Batch Operations for Agent & Kanban Tools
- **Batch Agent Tools**: All agent management tools now support 1-20 items per call
  - `agent-register`: Register multiple agents at once, returns all IDs
  - `agent-summary`: Update multiple agent summaries in parallel
  - `queue-message`: Two modes - individual messages array or broadcast to multiple agents
- **Batch Kanban Tools**: Task operations now support 1-20 items per call
  - `task-create`: Create multiple tasks at once
  - `task-update`: Update multiple tasks in parallel
  - `task-assign`: Assign multiple tasks to different agents at once
- **Removed**: `pop-queue` tool (messages consumed via queue-message broadcast)
- **Total Tools**: 100 (was 101)

### 1.13.0 - Session Monitor & Message Queue
- **Session Monitor Tool** (`monitor`): Comprehensive multi-agent monitoring
  - 5 views: `overview`, `agents`, `tasks`, `hierarchy`, `activity`
  - Hierarchical display: Session → Workspaces → Boards → Tasks → Agents
  - Real-time agent status with activity summaries
  - Message queue depth tracking
  - Filters by agent, board, depth
- **Agent Summary Tool** (`agent-summary`): Agents report current activity
  - Progress percentage (0-100%)
  - Current task tracking
  - Last action description
- **Message Queue System**: Supervisor-to-agent communication
  - `queue-message`: Queue messages with priority (critical/high/normal/low)
  - `pop-queue`: Retrieve messages (peek or consume)
  - File attachments support
  - Force context change flag
  - Message expiration (TTL)
- **AgentMonitor Extensions**: New methods in `context/agent-monitor.ts`
  - `updateAgentSummary()`, `getAgentSummary()`, `getSessionSummaries()`
  - `queueMessage()`, `getMessageQueue()`, `popMessage()`, `clearMessageQueue()`
  - `getSessionOverview()`, `getAgentOverview()`
- **New Types**: `AgentSummary`, `QueuedMessage`, `SessionOverview`, `AgentOverview`
- **New Redis Keys**: `AGENT_SUMMARY`, `AGENT_QUEUE`, `CHANNEL_AGENT_SUMMARY`
- **Total Tools**: 101 (was 97)

### 1.12.3 - OpenAI SDK Migration
- **Migrated to official OpenAI SDK**: Replaced custom fetch-based client
  - Built-in retry and rate limiting via SDK
  - Removed `providers.ts` (SDK handles model IDs directly)
  - Removed `rate-limiter.ts` (native SDK feature)
- **No hardcoded defaults**: Package is now fully configurable
  - All URLs and models must be set explicitly via `ai-config`
  - No fallback defaults - transparent behavior
- **BREAKING**: Configuration required before use
  - Set `apiBaseUrl`, `apiKey`, `primaryModel` before calling AI tools
  - Use `ai-models --action list` to discover available models

### 1.12.2 - Critical MPC Security Fixes
- **CRITICAL: Fixed weak key derivation** (`crypto.ts:66-71`)
  - Replaced SHA256 concatenation with HKDF (HMAC-based Key Derivation Function)
  - Proper salt derivation prevents collision attacks
- **CRITICAL: Fixed agent spoofing** (`auth.ts:54-87`)
  - Added HMAC signature verification for agent identity
  - Rate limiting (10 attempts/minute) prevents brute-force attacks
  - New functions: `generateAgentSignature()`, `verifyAgentSignature()`
- **CRITICAL: Removed plaintext secret from output** (`mpc-reconstruct.tool.ts:115`)
  - Secret now returned as base64 in structured JSON (not visible in logs)
  - Added hash prefix for verification
- **HIGH: Fixed JSON.parse validation** (`redis-store.ts:254`)
  - Validates EncryptedData structure before decryption
- **HIGH: Added entropy validation** (`crypto.ts:179`)
  - Rejects weak MPC_MASTER_SECRET (repeated chars, sequential patterns)
- **HIGH: Enforced Redis password in production** (`redis-store.ts:62`)
  - Throws error in production without password (unless MPC_ALLOW_INSECURE_REDIS=true)
- **MEDIUM: Added TTL to key cache**
  - Session keys expire after 30 minutes
  - Automatic cleanup of expired keys

### 1.12.1 - Dynamic Model Selection & MPC Security
- **`ai-models` tool**: Agents can list and select AI models dynamically
  - `ai-models --action list` - List all models from provider
  - `ai-models --action search --filter kimi` - Filter by name
  - `ai-models --action select --model <id>` - Select model for session
- **MPC Security Hardening**:
  - Role-based authorization for all MPC operations (`verifyMpcAuthorization`)
  - `MPC_MASTER_SECRET` now required (no random fallback)
  - Shares always encrypted (removed optional plaintext)
  - Redis password warning for production
- **Fixed `ai-config`**: API key now updates via `--action set --apiKey`

### 1.12.0 - Multi-Board Kanban with Workspaces
- **Workspace system**: Cross-session collaboration with `workspace-create`, `workspace-list`, `workspace-join`, `workspace-leave`
- **Multi-board support**: Multiple boards per session with `board-create`, `board-list`, `board-share`, `board-members`, `board-invite`
- **Task push to N agents**: `task-push-multi` for supervisor-driven assignment
- **Role-based permissions**: owner/admin/member/viewer per board
- **Lazy migration**: Backward compatible - existing tasks auto-migrate to default board
- **Fixed recursive invocation**: `invoke-tool` and `invoke-batch` now work (depth 2 limit)

### 1.11.0 - Bun Runtime Support & GPL-3.0 License
- **Bun runtime support**: Full compatibility with Bun 1.0+
- **Runtime abstraction layer**: `src/runtime/` module for cross-runtime compatibility
  - `runtime/index.ts` - Runtime detection (isBun, isNode, runtime)
  - `runtime/http.ts` - Dual-mode HTTP server (Bun.serve / node:http)
  - `runtime/process.ts` - Process spawning (Bun.spawn / child_process)
  - `runtime/crypto.ts` - Crypto utilities
  - `runtime/net.ts` - Network utilities
- **Native AI client**: Direct API calls, hot-reload configuration
- **GPL-3.0 license headers**: All source files have license headers
- **New build scripts**: `build:bun`, `start:bun`, `dev:bun`
- **ai-config tool**: Manage AI provider settings at runtime

### 1.10.0 - Agent Kanban, Recursive Tools & Tree-sitter
- **Agent Kanban system**: `task-create`, `task-list`, `task-update`, `task-claim`, `task-assign`, `board-status`
- **Recursive tool invocation**: `invoke-tool`, `invoke-batch`, `invocation-log` with safety controls
- **Tree-sitter integration**: WASM-based AST parsing for 19 languages
- Rate limiting and depth control for recursive operations (max depth: 5, 30 calls/min)
- Redis-based task persistence with priority scoring
- Task dependencies (blockedBy/blocks) for workflow management

### 1.9.0 - Serena-like Editing & Memory Tools
- **Line-based editing**: `insert-at-line`, `delete-lines`, `replace-lines`, `replace-content`
- **Symbol-based editing**: `insert-before-symbol`, `insert-after-symbol`, `rename-symbol`
- **Project memory**: `write-memory`, `read-memory`, `list-memories`, `delete-memory`, `edit-memory`
- New `edit-utils.ts` for shared line manipulation functions
- Language auto-detection for symbol tools (TS, PHP, Python, Go, Rust)
- Block end detection (braces for TS/PHP/Go/Rust, indent for Python)
- Redis-based memory with TTL and tag support

### 1.8.2 - Multi-Agent Knowledge Sharing
- `shared-thoughts` tool for collective knowledge base
- Session ID displayed at startup
- Scope filtering (all, kemdicode, analysis, code)
- Multiple output formats (summary, timeline, detailed)

### 1.8.1 - Code Quality
- ESLint + Prettier integration
- Type safety improvements (`unknown` vs `any`)

### 1.8.0 - Multi-Agent Architecture
- `batch` tool for parallel execution
- Graceful shutdown

### 1.7.0 - HTTP Transport
- HTTP mode as default
- Per-request progress isolation
- `/health` endpoint
- Session management

### 1.6.0 - Agent Monitoring
- `agent-*` tools for coordination
- Redis Pub/Sub messaging
- Real-time alerts and context injection

### 1.5.0 - 1.3.0
- Bug fixes and updates
- Redis context sharing
- Initial public release
