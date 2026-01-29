# KemdiCode MCP - Usage Patterns

Reusable patterns for integrating KemdiCode MCP into your project workflow.

---

## Pattern 1: Hot Reload Provider Switching

**Problem:** You need to switch AI providers mid-session without restarting anything.

**Solution:** Use `ai-config` with hot reload. Configuration persists to `.kemdicode-mcp.json`.

```
ai-config --action set --provider openrouter --apiKey "sk-or-..." --primaryModel "model-name"
ai-config --action test
```

**When to use:**
- Quota exceeded on primary provider
- Testing same prompt across providers
- Switching to local Ollama for offline work

**See:** [01-hot-reload-config.md](01-hot-reload-config.md)

---

## Pattern 2: Sprint Board Setup

**Problem:** You need structured task tracking for a multi-agent project.

**Solution:** Create workspace + boards + tasks, then assign to agents.

```
workspace-create → board-create → task-create (batch) → agent-register → task-assign (batch)
```

**Flow:**
1. `workspace-create` - cross-session collaboration space
2. `board-create` - one board per workstream (visibility: workspace)
3. `task-create` - batch up to 20 tasks at once with priorities and labels
4. `agent-register` - batch register workers, specialists, supervisors
5. `task-assign` - batch assign tasks to agents
6. `task-claim` - workers self-assign next available task
7. `board-status` / `monitor` - track progress

**When to use:**
- Multi-agent projects with 3+ agents
- Sprint-based development
- Parallel workstream coordination

**See:** [02-kanban-sprint.md](02-kanban-sprint.md)

---

## Pattern 3: Supervisor-Worker Agent Teams

**Problem:** Multiple agents need coordination, shared context, and oversight.

**Solution:** Register agents with roles, use alerts for directives, inject context, monitor via Pub/Sub.

```
agent-register (roles) → agent-alert (broadcast) → agent-inject (context) → agent-watch (monitor)
```

**Roles:**
- `supervisor` - orchestrates, assigns, reviews
- `worker` - executes tasks
- `specialist` - domain expert (QA, security, etc.)
- `coordinator` - cross-team liaison

**Key tools:**
| Tool | Purpose |
|------|---------|
| `agent-alert` | Send directives to one or all agents |
| `agent-inject` | Add context/directive/query to running agent |
| `queue-message` | Async messages for offline agents |
| `shared-thoughts` | Collective knowledge base |
| `monitor` | 5 view modes: overview, agents, tasks, hierarchy, activity |

**See:** [03-multi-agent-coordination.md](03-multi-agent-coordination.md)

---

## Pattern 4: Multi-Model Consensus

**Problem:** Critical decision needs validation from multiple AI perspectives.

**Solution:** Use `consensus-prompt` (CEO-and-Board pattern) or `multi-prompt` (parallel comparison).

```
# Parallel comparison
multi-prompt --models '["o:gpt-4o", "a:claude-sonnet-4-20250514", "g:gemini-2.5-pro"]'

# Board votes + CEO synthesizes
consensus-prompt --boardModels '[...]' --ceoModel "a:claude-sonnet-4-20250514"
```

**Model spec syntax:** `provider:model:thinking`
- `o:o3:high` - OpenAI o3 with high reasoning effort
- `a:claude-sonnet-4-20250514:4k` - Anthropic with 4096 thinking tokens
- `g:gemini-2.5-flash:8k` - Gemini with 8192 thinking budget
- `r:model:free` - OpenRouter free tier

**When to use:**
- Architecture decisions
- Security review consensus
- Choosing between implementation approaches
- Validating AI-generated code

**See:** [04-multi-llm-consensus.md](04-multi-llm-consensus.md)

---

## Pattern 5: Automated Code Quality Pipeline

**Problem:** Ensure code quality before commit with automated analysis.

**Solution:** Chain review, lint, types, and tests in sequence.

```
code-review → auto-fix (dry-run) → auto-fix (apply) → check-types → run-lint → run-tests
```

**Pipeline:**
1. `code-review --focus all --withDeps true` - find issues
2. `auto-fix --dryRun true` - preview fixes
3. `auto-fix --dryRun false` - apply fixes
4. `check-types` - verify TypeScript
5. `run-lint --fix true` - auto-fix lint issues
6. `run-tests --coverage true` - validate

**Batch version (parallel):**
```json
batch --operations '[
  {"tool": "check-types", "args": {"checker": "auto", "timeout": 60000, "strict": false}},
  {"tool": "run-lint", "args": {"linter": "auto", "fix": false, "timeout": 60000}},
  {"tool": "run-tests", "args": {"framework": "auto", "coverage": false, "timeout": 120000, "watch": false}}
]' --parallel true --stopOnError false
```

**See:** [05-code-analysis-workflow.md](05-code-analysis-workflow.md)

---

## Pattern 6: Persistent Project Memory

**Problem:** Context is lost between sessions. Conventions, decisions, and patterns need to persist.

**Solution:** Use `write-memory` / `read-memory` with tags and TTL.

```
write-memory → read-memory (at session start) → edit-memory (append updates)
```

**Recommended memories:**
| Name | Content | TTL |
|------|---------|-----|
| `coding-conventions` | Style guide, patterns | 365 days |
| `architecture-decisions` | ADRs, tech choices | 180 days |
| `api-contracts` | Endpoint specs, schemas | 90 days |
| `known-issues` | Bugs, workarounds | 30 days |
| `deploy-checklist` | Pre-deploy steps | 365 days |

**See:** [06-project-memory.md](06-project-memory.md)

---

## Pattern 7: Agent Self-Service Tools

**Problem:** Agent needs to invoke other tools programmatically within a workflow.

**Solution:** Use `invoke-tool` / `invoke-batch` with safety limits (max depth 2, rate limited).

```
invoke-tool (single) or invoke-batch (parallel/sequential)
```

**Safety controls:**
- Max recursion depth: 2
- Max calls per minute: 30
- Per-invocation timeout: 30s
- Dry-run mode available

**Common workflow:**
```
invoke-batch (parallel: read multiple files) → process → invoke-batch (sequential: lint → types → test)
```

**See:** [07-recursive-tool-invocation.md](07-recursive-tool-invocation.md)

---

## Pattern 8: Knowledge Graph for Error Resolution

**Problem:** Same errors keep occurring. Need to learn from past solutions.

**Solution:** Use the loci/graph system to build error-to-solution knowledge.

```
# Query the knowledge graph
graph-query --sessionId "session-1" --type "error" --limit 10 --sortBy "weight" --sortOrder "desc"

# Find path from error to solution
graph-find-path --fromNodeId "error-node-id" --mode "error-to-solution" --maxPaths 5 --maxDepth 5

# Walk memory palace for context recall
loci-recall --sessionId "session-1" --walkAll true

# Get tool sequence recommendations
sequence-recommend --agentId "worker-1" --sessionId "session-1" --showPatterns true --showTransitions true
```

**How it works:**
- Errors and solutions are stored as graph nodes
- Edges connect related errors, solutions, files, and concepts
- `graph-find-path` mode `error-to-solution` traverses from error to fix
- `sequence-recommend` suggests next tool based on learned patterns

---

## Pattern 9: Cross-Session Workspace Collaboration

**Problem:** Multiple Claude Code sessions need to share tasks and context.

**Solution:** Create a workspace, join sessions, share boards.

```
# Session A (lead)
workspace-create --name "Project X" --ownerSessionId "session-a" --ownerId "lead"
board-create --name "Backend" --sessionId "session-a" --visibility "workspace" --createdBy "lead"

# Session B (joins)
workspace-join --workspaceId "ws-id" --sessionId "session-b"
board-list --sessionId "session-b" --includeWorkspaces true

# Both sessions see the same boards and tasks
task-list --sessionId "session-a" --limit 50
```

---

## Pattern 10: Feedback Loop Learning

**Problem:** Track what works and what doesn't across iterations.

**Solution:** Use the feedback system to record attempts, rate suggestions, and learn.

```
# Start tracking a task
feedback --action start --task "Fix authentication timeout bug"

# Record an iteration attempt
feedback --action iteration

# When done, record lessons
feedback --action complete --result "Fixed by increasing token refresh window" --lessons "Check token expiry margins,Always test with slow networks"

# Get insights from history
feedback --action insights

# Check file change history
feedback --action file-history --file "src/auth/middleware.ts"

# Get stats
feedback --action stats
```
