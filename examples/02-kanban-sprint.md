# Kanban Sprint Management

End-to-end sprint workflow using KemdiCode MCP Kanban tools.

## 1. Create a workspace for cross-session collaboration

```
workspace-create --name "Backend Sprint 3" --ownerSessionId "session-lead" --ownerId "lead-agent"
```

## 2. Create boards per workstream

```
board-create --name "API Development" --sessionId "session-lead" --visibility "workspace" --createdBy "lead-agent"
board-create --name "Database Migration" --sessionId "session-lead" --visibility "workspace" --createdBy "lead-agent"
```

## 3. Batch-create tasks

```json
task-create --sessionId "session-lead" --createdBy "lead-agent" --tasks '[
  {"title": "Implement JWT auth middleware", "priority": "high", "labels": ["auth", "api"]},
  {"title": "Add rate limiting to /api/v1/*", "priority": "high", "labels": ["security", "api"]},
  {"title": "Create user CRUD endpoints", "priority": "normal", "labels": ["api"]},
  {"title": "Write integration tests for auth", "priority": "normal", "labels": ["testing"]},
  {"title": "Add OpenAPI 3.0 spec", "priority": "low", "labels": ["docs"]}
]'
```

## 4. Register agents and assign tasks

```json
agent-register --sessionId "session-lead" --agents '[
  {"name": "Backend Dev", "role": "worker"},
  {"name": "QA Engineer", "role": "specialist"},
  {"name": "Tech Lead", "role": "supervisor"}
]'
```

```json
task-assign --supervisorId "tech-lead" --assignments '[
  {"taskId": "task-1", "assigneeId": "backend-dev"},
  {"taskId": "task-2", "assigneeId": "backend-dev"},
  {"taskId": "task-4", "assigneeId": "qa-engineer"}
]'
```

## 5. Worker claims next available task

```
task-claim --agentId "backend-dev" --sessionId "session-lead"
```

## 6. Update task progress

```json
task-update --agentId "backend-dev" --updates '[
  {"taskId": "task-1", "status": "in_progress"},
  {"taskId": "task-4", "addBlockedBy": ["task-1"]}
]'
```

## 7. Monitor progress

```
board-status --sessionId "session-lead"
monitor --sessionId "session-lead" --view tasks --depth deep
monitor --sessionId "session-lead" --view hierarchy
```

## 8. Push urgent task to all agents

```json
task-push-multi --mode "clone" --supervisorId "tech-lead" --sessionId "session-lead" --taskData '{"title": "Fix critical auth bypass", "priority": "critical"}' --targetAgents '[
  {"agentId": "backend-dev", "sessionId": "session-lead"},
  {"agentId": "qa-engineer", "sessionId": "session-lead"}
]'
```

## 9. Complete sprint review

```
task-list --sessionId "session-lead" --status "done" --limit 50
task-list --sessionId "session-lead" --status "in_progress" --limit 50
board-status --sessionId "session-lead"
```
