# Multi-Agent Coordination

Orchestrate multiple AI agents working on the same codebase.

## 1. Register a team of specialized agents

```json
agent-register --sessionId "project-alpha" --serverId "kemdicode-mcp" --agents '[
  {"name": "Architect", "role": "supervisor", "model": "gpt-4.1"},
  {"name": "Frontend Dev", "role": "worker", "model": "claude-sonnet-4-6"},
  {"name": "Backend Dev", "role": "worker", "model": "gpt-4.1"},
  {"name": "QA Agent", "role": "specialist", "model": "gemini-2.5-pro"}
]'
```

## 2. Send directive to all agents

```
agent-alert --agentIds "*" --message "All services must use TypeScript strict mode" --source "Architect" --priority "high" --interrupt false
```

## 3. Inject context into a specific agent

```
agent-inject --agentId "frontend-dev" --sessionId "project-alpha" --type "context" --content "The design system uses Tailwind CSS v4 with custom tokens in tokens.css"
```

## 4. Share knowledge between agents

```
shared-thoughts --scope "all" --limit 20 --format "summary" --includeOutput false
```

## 5. Monitor agent activity

```
monitor --sessionId "project-alpha" --view agents --depth deep
monitor --sessionId "project-alpha" --view activity --limit 50
```

## 6. View agent conversation history

```
agent-history --sessionId "project-alpha" --limit 50 --type "all"
```

## 7. Queue messages for offline agents

```json
queue-message (broadcast mode to all agents with content "Deploy freeze at 5 PM")
```

## 8. Session-wide monitoring

```
monitor --sessionId "project-alpha" --view overview --depth shallow
monitor --sessionId "project-alpha" --view agents --depth deep
monitor --sessionId "project-alpha" --view activity --limit 30
```

## 9. Parallel Agent Orchestration

Launch multiple agents simultaneously on the same problem from different perspectives:

```json
agent-orchestrate --parallel '[
  {"task": "Review auth flow for security vulnerabilities", "agent": "hacker"},
  {"task": "Review auth flow for architectural issues", "agent": "architect"},
  {"task": "Evaluate auth flow completeness", "agent": "evaluator"}
]' --sessionId "project-alpha" --enableCognition true
```

Each agent runs independently with its own `orchestrationId`. Results are aggregated via `Promise.allSettled` — if one agent fails, others continue.

## 10. Live Orchestration Monitoring

While agents run (MCP is blocked during tool calls), use HTTP endpoints:

```bash
# List all active orchestrations
curl -s http://localhost:3100/orchestrations | jq

# Sample output:
# {
#   "active": 3,
#   "orchestrations": [
#     {
#       "id": "a1b2c3d4",
#       "agent": "hacker",
#       "status": "running",
#       "iteration": 5,
#       "toolCallsTotal": 12,
#       "lastToolCall": "find-references",
#       "parallelIndex": 0,
#       "parallelTotal": 3
#     },
#     ...
#   ]
# }

# Get specific orchestration
curl -s http://localhost:3100/orchestrations/a1b2c3d4 | jq
```

Or via MCP (when not blocked by another tool call):

```
monitor --view orchestrations
monitor --view orchestrations --orchestrationId "a1b2c3d4"
```

## 11. Orchestration ID Traceability

Every agent loop gets a UUID (`orchestrationId`). Sub-agents reference parent via `parentOrchestrationId`. All cognition records carry this ID:

```
# Find all decisions made during a specific orchestration
decision-journal action=list orchestrationId="a1b2c3d4"

# Find errors encountered during orchestration
error-pattern action=list orchestrationId="a1b2c3d4"

# Trace parent-child orchestration hierarchy
curl -s http://localhost:3100/orchestrations/a1b2c3d4 | jq '.parentOrchestrationId'
```
