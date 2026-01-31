# KemdiCode MCP Server

## Session Recovery

After compaction or session start, always run `read-memory --names ["active-session"]` to restore current working context (session ID, workspace, boards, current phase, pending tasks). Update it with `write-memory` whenever the active session changes.

## Overview

Model Context Protocol (MCP) server providing **124 specialized tools** for code analysis, generation, git operations, file management, line/symbol editing, project memory, cognition & self-improvement, multi-board kanban with workspaces, task comments, thinking chains, recursive tool invocation, pipelines, session monitoring, and multi-agent coordination.

**Version:** 1.23.1

## Architecture

```
src/
├── index.ts                 # HTTP server, SSE handlers, MCP protocol
├── constants.ts             # CLI flags, error messages, timeouts
├── ai/                      # Multi-provider LLM integration
│   ├── client.ts            # Completion router (multi-provider + OpenAI SDK fallback)
│   ├── execute.ts           # High-level AI execution with agents
│   ├── agents.ts            # Agent configurations (plan, build, explore)
│   ├── file-context.ts      # File attachment handling
│   ├── model-spec.ts        # Parser for provider:model:thinking syntax
│   └── providers/           # Native LLM provider adapters
│       ├── types.ts         # LLMProvider interface, ProviderId, ThinkingConfig
│       ├── registry.ts      # Provider registry with lazy init
│       ├── openai.provider.ts       # OpenAI SDK (reasoning effort)
│       ├── anthropic.provider.ts    # Anthropic SDK (thinking tokens)
│       ├── gemini.provider.ts       # Google GenAI SDK (thinking budget)
│       ├── openai-compat.provider.ts # Groq, DeepSeek, Ollama, OpenRouter
│       └── index.ts
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
├── cognition/               # AI self-awareness infrastructure
│   ├── types.ts             # Decision, Confidence, MentalModel, Intent, ErrorPattern, etc.
│   ├── decision-store.ts    # Decision journal with outcome tracking
│   ├── confidence-store.ts  # Confidence tracking with calibration profiles
│   ├── mental-model-store.ts # System architecture mental models
│   ├── intent-store.ts      # Goal hierarchy with drift detection
│   ├── error-pattern-store.ts # Cross-session error pattern database
│   ├── self-critique-store.ts # Post-session reflection and lessons
│   ├── handoff-store.ts     # Structured session handoff reports
│   ├── context-budget-manager.ts # Context window budget estimation
│   ├── event-bus.ts         # In-process EventEmitter for cross-tool events
│   ├── cross-linker.ts      # Bidirectional Redis links between records
│   ├── event-handlers.ts    # 9 reactive cross-tool event handlers
│   └── index.ts             # Module exports
├── thinking/                # Thinking chain system
│   ├── types.ts             # ThinkingChain, Thought, THINKING_KEYS
│   ├── thinking-store.ts    # Redis CRUD with forward-only constraint
│   └── index.ts             # Module exports
├── tools/
│   ├── registry.ts          # Unified tool interface, Zod schemas
│   ├── index.ts             # Tool registration
│   ├── agents/              # Agent monitoring (9 tools)
│   ├── code/                # Code navigation + symbol editing (9 tools)
│   ├── cognition/           # AI self-improvement (8 tools)
│   ├── context/             # Context sharing (4 tools)
│   ├── edit/                # Line-based editing (4 tools)
│   ├── file/                # File operations (9 tools)
│   ├── git/                 # Git operations (8 tools)
│   ├── kanban/              # Kanban: tasks, boards, workspaces (21 tools)
│   ├── loci/                # Knowledge graph + resurrection (4 tools)
│   ├── memory/              # Project memory (8 tools)
│   ├── mpc/                 # Multi-party computation (4 tools)
│   ├── multi-llm/           # Multi-provider LLM tools (2 tools)
│   ├── project/             # Project management (5 tools)
│   ├── recursive/           # Recursive invocation (3 tools)
│   ├── rl/                  # Reinforcement learning (2 tools)
│   ├── session/             # Session management (5 tools)
│   ├── specialized/         # AI analysis (8 tools)
│   ├── thinking/            # Thinking chain (1 tool)
│   └── system/              # System tools (10 tools)
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

### Cognition (8 tools)
| Tool | Description |
|------|-------------|
| `decision-journal` | Record decisions with reasoning, alternatives, and outcome tracking |
| `confidence-tracker` | Track confidence levels, flag low-confidence actions for human review |
| `mental-model` | Build persistent mental models with impact-analysis, dependency-chain, invariant-check |
| `intent-tracker` | Goal hierarchy (mission → goal → sub-goal → task) with drift detection |
| `error-pattern` | Cross-session error database with pattern matching and fix lookup |
| `self-critique` | Post-session reflection, lessons learned, check-application for lesson tracking |
| `smart-handoff` | Structured handoff reports with auto-enriched cognition snapshot |
| `context-budget` | Context window budget estimation and prioritization |

### AI Agents (4 tools)
| Tool | Agent | Description |
|------|-------|-------------|
| `ask-ai` | configurable | Direct API calls with all options |
| `plan` | plan | Deep analysis and planning |
| `build` | build | Immediate code execution |
| `brainstorm` | plan | Creative ideation (SCAMPER, Design Thinking) |

### Multi-LLM (2 tools)
| Tool | Description |
|------|-------------|
| `multi-prompt` | Send same prompt to N models in parallel, collect all responses |
| `consensus-prompt` | CEO-and-Board: board models respond, CEO model synthesizes decision |

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

### Project Memory (8 tools)
| Tool | Description |
|------|-------------|
| `write-memory` | Store named memory with tags and TTL |
| `read-memory` | Retrieve memory by name |
| `list-memories` | List all project memories with filters |
| `delete-memory` | Delete a memory entry |
| `edit-memory` | Modify content and tags |
| `checkpoint-save` | Save temporary state snapshot to Redis (7-day TTL) |
| `checkpoint-restore` | Restore a previously saved checkpoint |
| `checkpoint-diff` | Compare current files with saved checkpoint |

### Git Operations (8 tools)
| Tool | Description |
|------|-------------|
| `git-status` | Repository status |
| `git-diff` | Show changes (staged/unstaged) |
| `git-log` | Commit history with filters |
| `git-blame` | Line-by-line history |
| `git-branch` | Branch management |
| `git-add` | Stage files for commit |
| `git-commit` | Create commits |
| `git-stash` | Stash management (push/pop/list/drop/apply/show) |

### File Operations (9 tools)
| Tool | Description |
|------|-------------|
| `file-read` | Read with encoding detection |
| `file-write` | Write with backup |
| `file-search` | Ripgrep search |
| `file-tree` | Directory tree |
| `file-diff` | Compare two files |
| `file-delete` | Delete with security checks and dry-run |
| `file-move` | Move/rename with cross-filesystem support |
| `file-copy` | Copy with overwrite protection |
| `file-backup-restore` | List/restore .bak backups |

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

### Kanban Tasks (10 tools)
| Tool | Description |
|------|-------------|
| `task-create` | Create 1-20 tasks at once (batch) |
| `task-get` | Get full task details by ID |
| `task-list` | List tasks with filters (status, priority, assignee, boardId) |
| `task-update` | Update 1-20 tasks at once (batch) |
| `task-delete` | Delete 1-20 tasks (batch) |
| `task-comment` | Add notes/comments to tasks (batch 1-20, append-only) |
| `task-claim` | Worker claims an available task |
| `task-assign` | Assign 1-20 tasks to agents at once (batch) |
| `task-push-multi` | Push task to N agents (assign/clone/notify) |
| `board-status` | Get board summary and statistics |

### Kanban Workspaces (5 tools)
| Tool | Description |
|------|-------------|
| `workspace-create` | Create workspace for cross-session collaboration |
| `workspace-list` | List available workspaces |
| `workspace-join` | Join session to workspace |
| `workspace-leave` | Leave workspace |
| `workspace-delete` | Delete workspace (with ownership check, cascade option) |

### Kanban Boards (6 tools)
| Tool | Description |
|------|-------------|
| `board-create` | Create new board in session/workspace |
| `board-list` | List boards (session + workspace) |
| `board-share` | Share board with session/workspace |
| `board-members` | Manage board members |
| `board-invite` | Invite agent with role |
| `board-delete` | Delete board (with cascade task deletion option) |

### Orchestration (1 tool)
| Tool | Description |
|------|-------------|
| `pipeline` | Sequential tool execution with `{{stepId.result}}` interpolation (max 10 steps) |

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

### Thinking Chain (1 tool)
| Tool | Description |
|------|-------------|
| `thinking-chain` | Register and manage chains of thought with branching and forward-only constraint (actions: start, think, branch, revise, conclude, get, list) |

## Key Components

### Tool Registry (`tools/registry.ts`)
- Unified `UnifiedTool` interface using Zod schemas
- Automatic JSON Schema generation for MCP protocol
- Centralized validation and execution
- Auto-share results to Redis for context

### Multi-Provider LLM Client (`ai/client.ts` + `ai/providers/`)
- **7 providers**: OpenAI, Anthropic, Google Gemini, Groq, DeepSeek, Ollama, OpenRouter
- **Native SDKs**: Anthropic (`@anthropic-ai/sdk`), Gemini (`@google/genai`), OpenAI (`openai`)
- **OpenAI-compatible**: Groq, DeepSeek, Ollama, OpenRouter via `openai` SDK with custom baseURL
- **Model spec syntax**: `provider:model:thinking` (e.g., `a:claude-sonnet-4-20250514:4k`, `o:o3:high`)
- **Short aliases**: `o`=OpenAI, `a`=Anthropic, `g`=Gemini, `q`=Groq, `d`=DeepSeek, `l`=Ollama, `r`=OpenRouter
- **Thinking tokens**: Unified abstraction for OpenAI reasoning effort, Anthropic thinking budget, Gemini thinking budget
- **Lazy initialization**: Providers init on first use, API keys from env vars
- **Backward compatible**: Models without prefix use existing OpenAI SDK path
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

## Runtime Abstraction Layer

The `src/runtime/` module provides seamless cross-runtime compatibility:

```typescript
// src/runtime/index.ts
export const isBun = typeof Bun !== 'undefined';
export const isNode = !isBun;
export const runtime = isBun ? 'bun' : 'node';
```

### HTTP Server (`runtime/http.ts`)
```typescript
// Unified HTTP server interface
export const httpServer = {
  serve: (options: ServerOptions) => {
    return isBun 
      ? Bun.serve(options)           // Bun native
      : createNodeServer(options);   // node:http
  }
};
```

### Process Spawning (`runtime/process.ts`)
```typescript
// Cross-runtime process execution
export const spawnProcess = (
  command: string[],
  options: SpawnOptions
): Process => {
  return isBun
    ? Bun.spawn(command, options)
    : spawn(command[0], command.slice(1), options);
};
```

This abstraction enables the same codebase to run on both runtimes without modifications.

## File Operations Deep Dive

### Smart File Handling (`file-read.tool.ts`)
```typescript
// Automatic encoding detection
const encoding = detectEncoding(buffer); // utf-8, utf-16, latin1
const content = iconv.decode(buffer, encoding);

// Large file streaming support
if (fileSize > 1024 * 1024) {
  return streamLargeFile(filePath, maxSize);
}
```

### Batch Operations (`file-write.tool.ts`)
```typescript
// Atomic batch write - all files or none
const schema = z.object({
  files: z.array(z.object({
    path: z.string(),
    content: z.string(),
    backup: z.boolean().default(true),
  })).max(20), // Batch limit: 20 files
});

// Implementation creates backups before writing
for (const file of files) {
  if (file.backup) await createBackup(file.path);
  await writeFile(file.path, file.content);
}
```

### Symbol-Based Editing (`code/`)
Tree-sitter powered AST manipulation:

```typescript
// Find symbol position in AST
const symbolNode = findSymbolInTree(tree, symbolName);

// Insert before/after with proper indentation
const indent = detectIndentation(sourceFile);
const insertPosition = symbolNode.startPosition;
```

## Dependency Injection Patterns

### Symbol Insertion (`insert-before-symbol.tool.ts`)
```typescript
// Inject import before class definition
insert-before-symbol --symbol "UserService" --content "import { Logger } from './logger';"

// Result:
import { Logger } from './logger';
class UserService {
  // existing code
}
```

### Method Injection (`insert-after-symbol.tool.ts`)
```typescript
// Add dependency after constructor
insert-after-symbol --symbol "constructor" --content "  private logger = new Logger();"

// Result:
class UserService {
  constructor(private db: Database) {}
  private logger = new Logger();
}
```

### Cross-File Renaming (`rename-symbol.tool.ts`)
```typescript
// Rename across entire codebase with dry-run
rename-symbol --symbol "oldService" --newName "newService" --dry-run true

// Finds all references using Tree-sitter
// Generates preview of changes
// Applies atomically when confirmed
```

## Multi-Board Kanban Architecture

### Data Model
```
Workspace (cross-session)
├── Board "Backend Sprint 1"
│   ├── Task "API Auth" (assigned: agent-1)
│   ├── Task "DB Migration" (assigned: agent-2)
│   └── Task "Tests" (assigned: agent-3)
├── Board "Frontend Bugs"
│   ├── Task "Fix Login" (assigned: agent-4)
│   └── Task "CSS Issue" (assigned: agent-5)
└── Board "Infrastructure"
    └── Task "Deploy" (assigned: agent-6)
```

### Redis Schema
```
mcp:kanban:workspace:<id>     - Workspace metadata
mcp:kanban:board:<id>         - Board metadata
mcp:kanban:task:<id>          - Task data
mcp:kanban:board:<id>:tasks   - Task list per board
mcp:kanban:agent:<id>:tasks   - Task assignments per agent
```

### Task Distribution (`task-push-multi.tool.ts`)
```typescript
// Push to N agents with different modes
interface TaskPushOptions {
  taskIds: string[];
  agents: string[];
  mode: 'assign' | 'clone' | 'notify';
}

// assign - Move task to agent
// clone - Create copies for each agent
// notify - Send notification only
```

## LLM Agent Orchestration

### Registration with Capabilities
```typescript
// Register agents with specific skills
agent-register --agents '[{
  "id": "backend-dev",
  "role": "backend",
  "capabilities": ["typescript", "postgresql", "api-design"],
  "maxConcurrent": 3
}]'
```

### Message Queue System
Priority-based message delivery:

```typescript
// Queue schema
interface QueuedMessage {
  id: string;
  priority: 'critical' | 'high' | 'normal' | 'low';
  content: string;
  attachments?: string[];
  forceContextChange?: boolean;
  ttl?: number;
}

// Redis storage
mcp:queue:<agent-id>:messages - Priority sorted set
```

### Context Injection
```typescript
// Inject directives into running agents
agent-inject --agentId "backend-dev" --context "Use JWT, not sessions"

// Agent receives via Redis Pub/Sub
subscribe(`mcp:channel:inject:${agentId}`, (message) => {
  injectContext(message);
});
```

### Hierarchical Monitoring
```typescript
// 5 different monitoring views
monitor --view overview   // Session summary
monitor --view agents     // Agent status & summaries
monitor --view tasks      // Task distribution
monitor --view hierarchy  // Tree: Session → Workspaces → Boards → Tasks → Agents
monitor --view activity   // Recent actions timeline
```

### Shared Context Flow
```
┌─────────────┐    Redis    ┌─────────────┐
│  Agent A    │◄──────────►│  Agent B    │
│  (Backend)  │  Pub/Sub    │  (Frontend) │
└──────┬──────┘             └──────┬──────┘
       │                           │
       └──────────┬────────────────┘
                  ▼
           shared-thoughts
           get-shared-context
```

## Recursive Tool Invocation

### Safety Controls (`recursive/tool-invoker.ts`)
```typescript
const SAFETY_LIMITS = {
  maxDepth: 2,              // Prevent infinite recursion
  maxCallsPerMinute: 30,    // Rate limiting
  timeoutMs: 30000,         // Per-invocation timeout
};

// Invocation tracking
const invocationStack: InvocationFrame[] = [];

// Depth check
if (invocationStack.length >= SAFETY_LIMITS.maxDepth) {
  throw new Error('Maximum recursion depth exceeded');
}
```

### Batch Invocation (`invoke-batch.tool.ts`)
```typescript
// Parallel vs Sequential
invoke-batch --mode parallel --invocations '[
  {"tool": "file-read", "args": {"path": "@src/a.ts"}},
  {"tool": "file-read", "args": {"path": "@src/b.ts"}}
]'

// Parallel: Promise.all() - all at once
// Sequential: for...of loop - one by one
```

## Case Study: Distributed Microservices Development

### Architecture
```
┌─────────────────────────────────────────────────────────┐
│                    Main LLM (Orchestrator)               │
└─────────────┬─────────────────────────────┬─────────────┘
              │                             │
    ┌─────────▼─────────┐       ┌───────────▼──────────┐
    │  API Gateway      │       │  Frontend Agent      │
    │  (agent-1)        │       │  (agent-2)           │
    └─────────┬─────────┘       └───────────┬──────────┘
              │                             │
    ┌─────────▼─────────┐       ┌───────────▼──────────┐
    │  Auth Service     │       │  UI Components       │
    │  (agent-3)        │       │  (agent-4)           │
    └───────────────────┘       └──────────────────────┘
```

### Implementation

**Step 1: Setup Infrastructure**
```bash
# Create workspace
workspace-create --name "Microservices Platform"

# Create boards per service
board-create --name "API Gateway" --workspaceId <ws-id>
board-create --name "Auth Service" --workspaceId <ws-id>
board-create --name "Frontend" --workspaceId <ws-id>
```

**Step 2: Register Specialized Agents**
```bash
agent-register --agents '[
  {"id":"api-gateway","role":"backend","capabilities":["nodejs","express","nginx"]},
  {"id":"auth-service","role":"backend","capabilities":["typescript","jwt","oauth"]},
  {"id":"frontend","role":"frontend","capabilities":["react","vite","tailwind"]},
  {"id":"qa","role":"quality","capabilities":["jest","cypress","k6"]}
]'
```

**Step 3: Distribute Tasks**
```bash
# Create tasks for each service
task-create --boardId <gateway-board> --tasks '[
  {"title":"Setup Express server","priority":"high"},
  {"title":"Implement rate limiting","priority":"high"}
]'

task-create --boardId <auth-board> --tasks '[
  {"title":"JWT authentication","priority":"high"},
  {"title":"OAuth integration","priority":"medium"}
]'

# Push to agents
task-push-multi --taskIds '["task-1","task-2"]' --agents '["api-gateway"]' --mode assign
task-push-multi --taskIds '["task-3","task-4"]' --agents '["auth-service"]' --mode assign
```

**Step 4: Monitor & Coordinate**
```bash
# Check overall progress
monitor --view hierarchy

# Inject shared requirement
queue-message --broadcast true --priority critical \
  --message "All services must use OpenAPI 3.0 spec"

# Agents share their API designs
shared-thoughts --action write --scope code \
  --content "Gateway routes: /api/v1/auth, /api/v1/users"
```

**Step 5: Integration Testing**
```bash
# QA agent runs tests
queue-message --agentIds '["qa"]' --message "Run integration tests"

# QA agent invokes tools
invoke-batch --mode sequential --invocations '[
  {"tool":"run-tests","args":{}},
  {"tool":"run-lint","args":{}},
  {"tool":"code-review","args":{"files":"@src/**/*.ts","focus":"security"}}
]'
```

### Results
- **4 agents** working in parallel
- **3 microservices** developed simultaneously
- **Shared context** ensures API consistency
- **Automated QA** pipeline integrated
- **Real-time coordination** via Redis Pub/Sub
- **Role-based permissions** for secure collaboration

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

## Tested Environments

KemdiCode MCP has been tested and verified to work with:

| IDE/Editor | Status | Notes |
|------------|--------|-------|
| **Claude Code** | ✅ Fully Supported | Primary development environment |
| **Cursor** | ✅ Fully Supported | With MCP settings configuration |
| **KiroCode** | ✅ Fully Supported | AI-native IDE with MCP support |
| **RooCode** | ✅ Fully Supported | VS Code extension |

## Authors

- **Dawid Irzyk** - Lead Developer - [dawid@kemdi.pl](mailto:dawid@kemdi.pl)
