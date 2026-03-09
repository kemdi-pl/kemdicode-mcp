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
workspace action=create → board action=create → task action=create (batch) → agent action=register → task action=assign (batch)
```

**Flow:**
1. `workspace` action=create — cross-session collaboration space
2. `board` action=create — one board per workstream (visibility: workspace)
3. `task` action=create — batch up to 20 tasks at once with priorities and labels
4. `agent` action=register — batch register workers, specialists, supervisors
5. `task` action=assign — batch assign tasks to agents
6. `task` action=claim — workers self-assign next available task
7. `board` action=status / `monitor` — track progress

**See:** [02-kanban-sprint.md](02-kanban-sprint.md)

---

## Pattern 3: Supervisor-Worker Agent Teams

**Problem:** Multiple agents need coordination, shared context, and oversight.

**Solution:** Register agents with roles, use alerts for directives, inject context, monitor via Pub/Sub.

```
agent action=register → agent-comm action=alert → agent-comm action=inject → monitor
```

**Roles:**
- `supervisor` — orchestrates, assigns, reviews
- `worker` — executes tasks
- `specialist` — domain expert (QA, security, etc.)
- `coordinator` — cross-team liaison

**Key tools:**
| Tool | Purpose |
|------|---------|
| `agent-comm` action=alert | Send directives to one or all agents |
| `agent-comm` action=inject | Add context/directive/query to running agent |
| `agent-comm` action=queue | Async messages for offline agents |
| `shared-thoughts` | Collective knowledge base |
| `monitor` | 6 view modes: overview, agents, tasks, hierarchy, activity, orchestrations |

**See:** [03-multi-agent-coordination.md](03-multi-agent-coordination.md)

---

## Pattern 3b: Parallel Agent Orchestration with Live Monitoring

**Problem:** You need multiple agents to analyze the same problem from different angles simultaneously, and need to monitor progress while they run.

**Solution:** Use `agent-orchestrate --parallel` to launch 2-10 agents concurrently. Monitor via HTTP endpoint (MCP blocks during tool calls).

```
# Launch 3 agents in parallel
agent-orchestrate --parallel '[
  {"task": "Review for security issues", "agent": "hacker"},
  {"task": "Review architecture", "agent": "architect"},
  {"task": "Evaluate completeness", "agent": "evaluator"}
]' --enableCognition true

# Monitor from another terminal while they run
curl -s http://localhost:3100/orchestrations | jq
```

**Key features:**
- Each agent gets unique `orchestrationId` (UUID)
- Sub-agents reference parent via `parentOrchestrationId`
- All cognition records carry `orchestrationId` for traceability
- In-memory cache eliminates Redis race conditions on status updates
- `GET /orchestrations/:id` for specific agent status

**When to use:**
- Multi-perspective code review (security + architecture + completeness)
- Parallel debugging from different angles
- Any task benefiting from diverse specialized viewpoints

**See:** [03-multi-agent-coordination.md](03-multi-agent-coordination.md) (sections 9-11)

---

## Pattern 4: Multi-Model Consensus

**Problem:** Critical decision needs validation from multiple AI perspectives.

**Solution:** Use `consensus-prompt` (CEO-and-Board pattern) or `multi-prompt` (parallel comparison).

```
# Parallel comparison
multi-prompt --models '["o:gpt-4.1", "a:claude-sonnet-4-6", "g:gemini-2.5-pro"]'

# Board votes + CEO synthesizes
consensus-prompt --boardModels '[...]' --ceoModel "a:claude-sonnet-4-6"
```

**Model spec syntax:** `provider:model:thinking`
- `o:o3:high` — OpenAI o3 with high reasoning effort
- `a:claude-sonnet-4-6:4k` — Anthropic with 4096 thinking tokens
- `g:gemini-2.5-flash:8k` — Gemini with 8192 thinking budget
- `r:model:free` — OpenRouter free tier

**See:** [04-multi-llm-consensus.md](04-multi-llm-consensus.md)

---

## Pattern 5: Code Intelligence & Error Investigation

**Problem:** Need to understand unfamiliar code, track down bugs, and build knowledge across sessions.

**Solution:** Combine code intelligence tools with cognition tools for structured investigation.

```
find-definition → find-references → semantic-search → error-pattern action=match → thinking-chain → error-pattern action=record
```

**See:** [05-code-analysis-workflow.md](05-code-analysis-workflow.md)

---

## Pattern 6: Persistent Project Memory

**Problem:** Context is lost between sessions. Conventions, decisions, and patterns need to persist.

**Solution:** Use `memory` action=write/read with tags and TTL.

```
memory action=write → memory action=read (at session start) → memory action=edit (append updates)
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

**See:** [07-recursive-tool-invocation.md](07-recursive-tool-invocation.md)

---

## Pattern 8: Knowledge Graph for Error Resolution

**Problem:** Same errors keep occurring. Need to learn from past solutions.

**Solution:** Use the loci/graph system to build error-to-solution knowledge.

```
graph-query → graph-find-path → loci-recall → sequence-recommend
```

**See:** [12-knowledge-graph-loci.md](12-knowledge-graph-loci.md)

---

## Pattern 9: Cross-Session Workspace Collaboration

**Problem:** Multiple Claude Code sessions need to share tasks and context.

**Solution:** Create a workspace, join sessions, share boards.

```
# Session A (lead)
workspace action=create name="Project X"

# Session B (joins)
workspace action=join workspaceId="ws-id"

# Both sessions see the same boards and tasks
```

---

## Pattern 10: Feedback Loop Learning

**Problem:** Track what works and what doesn't across iterations.

**Solution:** Use the feedback system to record attempts, rate suggestions, and learn.

```
feedback --action start --task "Fix authentication timeout bug"
feedback --action iteration
feedback --action complete --result "Fixed by increasing token refresh window"
feedback --action insights
```

---

## Pattern 11: Cluster Bus Signal Routing

**Problem:** Multiple LLM nodes need to communicate with typed signals, routing, and flow control.

**Solution:** Use the Cluster Bus with unicast, broadcast, or meta-tag routed signals.

```
# Unicast to specific cluster
cluster-bus-send --mode "unicast" --targetCluster "node-1" --signalType "llm:request"

# Broadcast to all
cluster-bus-send --mode "broadcast" --signalType "data:broadcast"

# Routed via meta-tags
cluster-bus-send --mode "routed" --signalType "llm:request"
```

**See:** [08-cluster-bus-magistrale.md](08-cluster-bus-magistrale.md)

---

## Pattern 12: Magistrale — Distributed LLM Dispatch

**Problem:** Need high-quality AI output by dispatching to multiple models and aggregating.

**Solution:** Use Magistrale with aggregation strategies and multi-pass quality control.

```
# Best-of-N: dispatch to 3 clusters, pick highest quality
cluster-bus-magistrale --prompt "Design a rate limiter" --strategy "best-of-n"

# Consensus: require agreement between clusters
cluster-bus-magistrale --prompt "Redis vs PostgreSQL for sessions?" --strategy "consensus"

# Fallback-chain: cascade on failure
cluster-bus-magistrale --prompt "Generate tests" --strategy "fallback-chain"
```

**Strategies:** `first-wins` · `best-of-n` · `consensus` · `fallback-chain`

**See:** [08-cluster-bus-magistrale.md](08-cluster-bus-magistrale.md)

---

## Pattern 13: Cognition Cross-Tool Intelligence

**Problem:** AI decisions, confidence, errors, and intents are isolated — they should react to each other.

**Solution:** The cognition layer's event bus creates automatic cross-tool reactions.

```
Reaction chains:
  decision-journal:record → auto-creates confidence-tracker entry
  confidence < 0.5 → triggers intent drift detection
  error-pattern:match → scans recent decisions for root cause
  self-critique:lesson → cross-links to matching error patterns
```

**See:** [10-cognition-deep-dive.md](10-cognition-deep-dive.md)

---

## Pattern 14: Session Recovery After Compaction

**Problem:** Context window compaction loses session state.

**Solution:** Single-call `session action=recover` restores everything.

```
session action=recover
```

Restores: active session memory, latest handoff, knowledge graph (loci), tool availability, agent rankings, ambient learning insights.

**See:** [11-session-recovery.md](11-session-recovery.md)

---

## Pattern 15: Cluster Bus Deep Diagnostics

**Problem:** Need to understand cluster bus health, signal flow, and diagnose routing issues.

**Solution:** Use inspection tools for flow control, routing, and deep inspection.

```
cluster-bus-flow --action "circuit-status"
cluster-bus-routing --action "test-route" --tags '["role:worker"]'
cluster-bus-inspect --action "signal-history" --limit 50
cluster-bus-inspect --action "bridge-stats"
```

**See:** [08-cluster-bus-magistrale.md](08-cluster-bus-magistrale.md)

---

## Pattern 16: Prompt Enhancement

**Problem:** Vague or poorly structured prompts lead to low-quality AI responses.

**Solution:** Use `enhance-prompt` to analyze and rewrite prompts before dispatching to LLM.

```
enhance-prompt --prompt "make the code better" --context "TypeScript REST API with Express"
```

---

## Pattern 17: Nine Minds — Dialectical Progression

**Problem:** Complex decisions benefit from multiple cognitive perspectives before implementation.

**Solution:** Use `mind-chain` for automatic Mind-to-Mind handoff: question → classify → specify.

```
mind-chain --composition dialectical \
  --prompt "We should add a caching layer"
# Runs: Socratic → Ontologist → Seed Architect → Synthesis
```

**See:** [13-nine-minds.md](13-nine-minds.md)

---

## Pattern 18: Nine Minds — Adversarial Review

**Problem:** Proposed architecture needs stress-testing before commitment.

**Solution:** Propose → challenge → verify — each Mind builds on the previous.

```
mind-chain --composition adversarial \
  --prompt "Design the notification system for @src/services/"
# Runs: Architect → Contrarian → Evaluator → Synthesis
```

**See:** [13-nine-minds.md](13-nine-minds.md)

---

## Pattern 19: Nine Minds — Evidence-Based Design

**Problem:** Team is making assumptions without data.

**Solution:** Investigate → find unconventional paths → simplify.

```
mind-chain --composition evidence \
  --prompt "What evidence do we have about API performance? @src/routes/"
# Runs: Researcher → Hacker → Simplifier → Synthesis
```

**See:** [13-nine-minds.md](13-nine-minds.md)

---

## Pattern 20: Nine Minds — Custom Chain

**Problem:** Need specific Mind combinations for a unique problem.

**Solution:** Define a custom Mind sequence with `mind-chain`.

```
mind-chain --composition custom \
  --minds '["socratic", "researcher", "architect", "evaluator"]' \
  --prompt "Should we migrate to GraphQL?" \
  --synthesize true
# Each Mind receives all previous Mind outputs as context
```

**See:** [13-nine-minds.md](13-nine-minds.md)
