# Kanban Sprint Management

End-to-end sprint workflow using KemdiCode MCP Kanban tools (consolidated v4.0+).

## 1. Create a workspace for cross-session collaboration

```json
workspace --action "create" --ownerId "lead-agent" --workspaces '[{"name": "Backend Sprint 3"}]'
```

## 2. Create boards per workstream

```json
board --action "create" --createdBy "lead-agent" --boards '[
  {"name": "API Development", "visibility": "workspace", "workspaceId": "name:Backend Sprint 3"},
  {"name": "Database Migration", "visibility": "workspace", "workspaceId": "name:Backend Sprint 3"}
]'
```

## 3. Batch-create tasks

```json
task --action "create" --createdBy "lead-agent" --tasks '[
  {"title": "Implement JWT auth middleware", "priority": "high", "boardId": "name:API Development", "labels": ["auth", "api"]},
  {"title": "Add rate limiting to /api/v1/*", "priority": "high", "boardId": "name:API Development", "labels": ["security", "api"]},
  {"title": "Create user CRUD endpoints", "priority": "normal", "boardId": "name:API Development", "labels": ["api"]},
  {"title": "Write integration tests for auth", "priority": "normal", "labels": ["testing"]},
  {"title": "Add OpenAPI 3.0 spec", "priority": "low", "labels": ["docs"]}
]'
```

## 4. Assign tasks

```json
task --action "assign" --assignments '[
  {"taskId": "task-1", "assigneeId": "backend-dev"},
  {"taskId": "task-2", "assigneeId": "backend-dev"},
  {"taskId": "task-4", "assigneeId": "qa-engineer"}
]' --supervisorId "tech-lead"
```

## 5. Worker claims next available task

```json
task --action "claim" --agentId "backend-dev"
```

## 6. Update task progress

```json
task --action "update" --agentId "backend-dev" --updates '[
  {"taskId": "task-1", "status": "in_progress"},
  {"taskId": "task-4", "addBlockedBy": ["task-1"]}
]'
```

## 7. Monitor progress

```json
board --action "status"
monitor --view "tasks" --depth "deep"
monitor --view "hierarchy"
```

## 8. Push urgent task to all agents

```json
task-multi --action "push" --mode "clone" --supervisorId "tech-lead" --taskData '{"title": "Fix critical auth bypass", "priority": "critical"}' --targetAgents '[
  {"agentId": "backend-dev"},
  {"agentId": "qa-engineer"}
]'
```

## 9. Complete sprint review

```json
task --action "list" --status "done" --limit 50
task --action "list" --status "in_progress" --limit 50
board --action "status"
```
